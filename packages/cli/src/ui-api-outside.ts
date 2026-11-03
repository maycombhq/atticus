import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  catalogDirOf,
  factIdPart,
  inputsDirOf,
  joinConventions,
  joinSharedMaps,
  joinVendorOperations,
  listQuestions,
  readSharedMaps,
  type Api,
  type CatalogRecord,
  type Fact,
  type FactEnd,
  type JoinVendor,
} from "@maycombhq/core";
import { readVendorSpec, type VendorSpec } from "@maycombhq/intake";
import {
  componentRenames,
  estateFacts,
  hostAliases,
  joinReposOf,
  outsideProfileSystems,
  readCatalog,
} from "@maycombhq/scanner";
import type { Router, ServerContext } from "@maycombhq/server";
import { intakeContext } from "./intake-commands.js";
import { contractCheckOf, estateJoinOnFile } from "./contract-check-files.js";

/**
 * The outside systems (plan item O4, ADR 0149): one view per system no estate repo belongs to
 * (`outsideProfileSystems`: every vendor, and every other team's system). For each: who calls it,
 * from the catalog's Interfaces to it and the estate join's `outside` list, with the services
 * behind a gateway's forwarding call; the operations its newest intaken spec in inputs/ publishes
 * (ADR 0130, 0142 O2), each with how many calls reach it, from `joinVendorOperations`; the calls
 * that match nothing in that spec; and its open questions. A system with no spec says how to add
 * one. The map another team shares for it (ADR 0160, O3): their entries, each with the calls that
 * reach it, and the calls it has no entry for. Files only: no git, no network, nothing written.
 */

type View = Api.OutsideViewT;
type System = Api.OutsideSystemViewT;
type Call = Api.OutsideCallViewT;
type Iface = Extract<CatalogRecord, { kind: "Interface" }>;

const SPECS = new Set(["openapi", "swagger"]);
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The words a person reads for adding a spec: the commands, in order. */
export const OUTSIDE_ADD_SPEC = (id: string): string[] => [
  `atticus intake add <the ${id} spec file>`,
  "atticus intake list",
  "atticus triage",
];

export async function outsideView(root: string): Promise<View> {
  const quiet = { out: () => undefined, err: () => undefined };
  const { op, records, inputs } = await intakeContext(root, quiet);
  const systems = outsideProfileSystems(op);
  const estate = await estateFacts(root, op, "");
  const facts = new Map<string, Fact>();
  for (const r of estate.repos) for (const f of r.facts) facts.set(`${r.repo}\u0000${f.id}`, f);
  // The join the contract check keeps on disk, under the same stamp (one join for both pages).
  const joined = await estateJoinOnFile(root, op, estate);
  const repos = joinReposOf(op, estate.repos, componentRenames(estate.repos, op));
  // ADR 0160 (O3): the maps other teams share, and the calls left to their systems joined to them.
  const { maps: sharedMaps } = await readSharedMaps(root);
  const sharedJoin = sharedMaps.length
    ? joinSharedMaps({ outside: joined.outside ?? [], repos, maps: sharedMaps, systems })
    : { matches: [], gaps: [], asks: [] };

  // Each system's newest spec (the one no later version supersedes), as the prototype reads it.
  const specs = new Map<string, VendorSpec>();
  for (const d of inputs.documents) {
    if (!d.id || d.supersededBy || !SPECS.has(d.classification)) continue;
    const system = systems.find((s) => s.id === d.systems[0]);
    if (!system || specs.has(system.id)) continue;
    const body = await readFile(join(inputsDirOf(root), ...d.path.split("/").slice(1)), "utf8");
    const spec = readVendorSpec(d.path, body, system.id);
    if (spec) specs.set(system.id, spec);
  }
  // Every call to an outside system with a spec, matched to its operations. Direct calls are
  // matched for every system here (`internal`), not only a gateway's: who calls it is the point.
  const vendors: JoinVendor[] = systems.flatMap((s) => {
    const spec = specs.get(s.id);
    if (!spec) return [];
    return [
      {
        system: s.id,
        boundary: "internal" as const,
        names: [s.name, ...s.aliases],
        hosts: [...new Set([...spec.hosts, ...hostAliases(s.aliases)])],
        operations: spec.operations.map((o) => ({
          id: o.id,
          method: o.method,
          path: o.path,
          fullPath: o.fullPath,
          cite: o.cite,
        })),
      },
    ];
  });
  const matched = vendors.length
    ? joinVendorOperations({
        repos,
        vendors,
        targets: estate.targets,
        ...joinConventions(op),
      })
    : { matches: [], gaps: [], asks: [] };

  // ADR 0164: the calls to each system checked against its newest spec, and what it brought.
  const contracts = await contractCheckOf(root).catch(() => undefined);

  const catalog = records.length
    ? records
    : (await readCatalog(join(catalogDirOf(root), "generated"), { cacheRoot: root })).records;
  const ifaces = catalog.filter((r): r is Iface => r.kind === "Interface");
  const componentsOf = (id: string) =>
    new Set([
      id,
      ...catalog
        .filter((r) => r.kind === "Component" && (r as { system?: string }).system === id)
        .map((r) => r.id),
    ]);
  const open = await listQuestions(root, { state: "open" }).then(
    (l) => l.questions,
    () => [],
  );

  const callOf = (e: FactEnd): Omit<Call, "seen"> => {
    const f = facts.get(`${e.repo}\u0000${e.fact}`);
    const x = f?.kind === "call" ? f : undefined;
    return {
      repo: e.repo,
      ...(e.component ? { component: e.component } : {}),
      fact: e.fact,
      at: e.at,
      ...(x?.method ? { method: x.method.toUpperCase() } : {}),
      ...(x?.path ? { path: x.path } : {}),
    };
  };
  const contractsOf = (id: string): Pick<System, "contracts"> => {
    const findings = contracts?.result.findings.filter((f) => f.system === id) ?? [];
    const fresh = contracts?.newBySystem.get(id);
    if (!findings.length && !fresh) return {};
    return {
      contracts: { findings, ...(fresh ? { new: fresh.map((f) => f.id) } : {}) },
    };
  };
  const out: System[] = systems.map((s) => {
    const names = new Set([s.id, s.name, ...s.aliases].map(factIdPart));
    const comps = componentsOf(s.id);
    const callers = new Map<string, Call>();
    const add = (c: Omit<Call, "seen">, seen: Call["seen"][number]) => {
      const k = `${c.repo}|${c.at}`;
      const had = callers.get(k);
      if (had) {
        if (!had.seen.includes(seen)) had.seen = [...had.seen, seen].sort();
        Object.assign(had, { ...c, ...had, seen: had.seen });
      } else callers.set(k, { ...c, seen: [seen] });
    };
    for (const o of joined.outside ?? [])
      if (names.has(factIdPart(o.target))) add(callOf(o.call), "join");
    for (const r of ifaces) {
      if (!comps.has(r.to)) continue;
      for (const e of r.evidence as {
        repo?: string;
        path?: string;
        line?: number;
        side?: string;
        source?: string;
      }[])
        // The call's own line: its config lines (a base URL) say where, not who calls.
        if (
          e.side !== "callee" &&
          e.source !== "config" &&
          e.repo &&
          e.path &&
          e.line !== undefined
        )
          add(
            {
              repo: e.repo,
              component: r.from,
              at: `${e.path}:${e.line}`,
              ...(r.method ? { method: r.method } : {}),
              path: r.normalizedPath,
              interface: r.id,
            },
            "interface",
          );
    }
    // The operation each call reaches; and behind a gateway's forwarding call, who calls its route.
    for (const g of [...matched.gaps, ...matched.asks].filter((x) => x.vendor === s.id))
      add(callOf(g.call), "spec");
    for (const m of matched.matches.filter((x) => x.vendor === s.id)) {
      add({ ...callOf(m.call), operation: m.operation }, "spec");
      if (m.direct || !m.route) continue;
      const route = m.route;
      for (const j of joined.joins)
        if (j.entry.repo === route.repo && j.entry.fact === route.fact)
          add(
            {
              ...callOf(j.call),
              operation: m.operation,
              through: { repo: route.repo, at: route.at },
            },
            "spec",
          );
    }
    for (const m of sharedJoin.matches.filter((x) => x.system === s.id))
      add(
        {
          ...callOf(m.call),
          entry: { team: m.team, repo: m.entry.repo, fact: m.entry.fact, at: m.entry.at },
        },
        "shared",
      );
    for (const g of sharedJoin.gaps.filter((x) => x.system === s.id)) add(callOf(g.call), "shared");
    const list = [...callers.values()].sort((a, b) => cmp(a.repo, b.repo) || cmp(a.at, b.at));
    const spec = specs.get(s.id);
    const map = sharedMaps.find((m) => m.system === s.id);
    const lines = new Set(list.map((c) => `${c.repo}|${c.at}`));
    const named = [s.id, s.name, ...s.aliases].map((n) => n.toLowerCase());
    const questions = open
      .filter(
        (q) =>
          named.some((n) => q.question.toLowerCase().includes(n)) ||
          q.options.some((o) => named.some((n) => o.label.toLowerCase().includes(n))) ||
          q.evidence.some((e) => lines.has(`${q.repo}|${e}`)),
      )
      .map((q) => ({ id: q.id, repo: q.repo, question: q.question }))
      .sort((a, b) => cmp(a.id, b.id));
    return {
      id: s.id,
      name: s.name,
      boundary: s.boundary,
      ...(s.owner ? { owner: s.owner } : {}),
      aliases: [...s.aliases],
      callers: list,
      ...(spec
        ? {
            spec: {
              path: spec.path,
              ...(spec.title ? { title: spec.title } : {}),
              ...(spec.version ? { version: spec.version } : {}),
              operations: spec.operations.map((o) => ({
                id: o.id,
                method: o.method,
                path: o.fullPath,
                cite: o.cite,
                calls: list.filter((c) => c.operation === o.id).length,
              })),
            },
          }
        : {}),
      unmatched: matched.gaps
        .filter((g) => g.vendor === s.id)
        .map((g) => ({ ...callOf(g.call), seen: ["spec" as const], message: g.message })),
      ambiguous: matched.asks
        .filter((a) => a.vendor === s.id)
        .map((a) => ({ ...callOf(a.call), seen: ["spec" as const], candidates: a.candidates })),
      questions,
      ...(spec ? {} : { addSpec: OUTSIDE_ADD_SPEC(s.id) }),
      ...contractsOf(s.id),
      ...(map
        ? {
            shared: {
              team: map.team,
              name: map.name,
              commit: map.commit,
              importedAt: map.file.importedAt,
              entries: map.repos
                .flatMap((r) =>
                  r.facts.flatMap((f) =>
                    f.kind === "entry"
                      ? [
                          {
                            repo: r.repo,
                            component: factIdPart(f.component ?? r.component ?? r.repo),
                            fact: f.id,
                            ...(f.method ? { method: f.method.toUpperCase() } : {}),
                            path: f.path,
                            at: `${f.cite.file}:${f.cite.line}`,
                            ...(f.commit ? { commit: f.commit } : {}),
                            calls: list.filter(
                              (c) => c.entry?.repo === r.repo && c.entry.fact === f.id,
                            ).length,
                          },
                        ]
                      : [],
                  ),
                )
                .sort((a, b) => cmp(a.repo, b.repo) || cmp(a.at, b.at)),
              unmatched: sharedJoin.gaps
                .filter((g) => g.system === s.id)
                .map((g) => ({ ...callOf(g.call), seen: ["shared" as const], message: g.message })),
            },
          }
        : {}),
    };
  });
  return { systems: out, notes: estate.notes };
}

export function uiOutsideRoutes(r: Router, ctx: ServerContext): Router {
  return r.add("GET", "/api/outside", async () => ({
    status: 200,
    body: await outsideView(ctx.root),
  }));
}
