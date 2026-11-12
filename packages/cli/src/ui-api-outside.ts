import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  catalogDirOf,
  factIdPart,
  hostMatches,
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
  estateRepos,
  estateFacts,
  hostAliases,
  joinReposOf,
  outsideProfileSystems,
  readCatalog,
} from "@maycombhq/scanner";
import type { Router, ServerContext } from "@maycombhq/server";
import { intakeContext } from "./intake-commands.js";
import { contractCheckOf, estateJoinOnFile, stampOf } from "./contract-check-files.js";

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

/**
 * Beta.27: an alias of an outside system that is a host an estate repo answers on, said plainly:
 * the calls to that host are the repo's (its routes), never the system's.
 */
export const OUTSIDE_ALIAS_CLASH = (name: string, host: string, repo: string): string =>
  `${host} is one of ${name}'s aliases in the profile, but ${repo} answers on it (repos.manifest.yaml lists it), so calls to it go to ${repo}, not to ${name}. If ${repo} is the gateway in front of ${name}, take ${host} out of ${name}'s aliases.`;

/**
 * Beta.27: a host the vendor's spec serves on (its `servers`) that repos.manifest.yaml lists under
 * an estate repo's hosts: the calls to it are that repo's, which is most likely a mistake.
 */
export const OUTSIDE_SPEC_HOST_CLASH = (
  name: string,
  host: string,
  repo: string,
  spec: string,
): string =>
  `${host} is a server in ${name}'s spec (${spec}), but repos.manifest.yaml lists it under ${repo}'s hosts, so calls to it go to ${repo}, not to ${name}. If ${repo} doesn't answer on ${host}, take it out of ${repo}'s hosts in repos.manifest.yaml.`;

export async function outsideView(root: string): Promise<View> {
  const quiet = { out: () => undefined, err: () => undefined };
  const { op, records, inputs } = await intakeContext(root, quiet);
  const systems = outsideProfileSystems(op);
  // The stamp before the files are read: a write landing meanwhile can't save an old join new.
  const stamp = await stampOf(root);
  const estate = await estateFacts(root, op, "");
  const facts = new Map<string, Fact>();
  for (const r of estate.repos) for (const f of r.facts) facts.set(`${r.repo}\u0000${f.id}`, f);
  // The join the contract check keeps on disk, under the same stamp (one join for both pages).
  const joined = await estateJoinOnFile(root, op, estate, stamp);
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
        // Beta.27: a service's call the join lands on a gateway's route reaches the system
        // through it (listed behind the route), never as a direct call.
        joined: joined.joins,
      })
    : { matches: [], gaps: [], asks: [] };
  // Every operation each call reaches (a wildcard route reaches several), by repo and fact.
  const reaches = new Map<string, string[]>();
  for (const m of matched.matches) {
    const k = `${m.vendor}\u0000${m.call.repo}\u0000${m.call.fact}`;
    reaches.set(k, [...new Set([...(reaches.get(k) ?? []), m.operation])].sort());
  }
  const opsOf = (vendor: string, e: FactEnd) => {
    const ops = reaches.get(`${vendor}\u0000${e.repo}\u0000${e.fact}`) ?? [];
    return { operation: ops[0]!, ...(ops.length > 1 ? { operations: ops } : {}) };
  };
  // Beta.27: a host alias of an outside system that an estate repo answers on (the gateway's own
  // host, added to a vendor's aliases): its calls are that repo's, said plainly on the page.
  const manifests = estateRepos(op);
  const clashes = (hosts: readonly string[]) =>
    hosts.flatMap((h) =>
      manifests
        .filter((m) =>
          [...(m.hosts ?? []), ...(m.modules ?? []).flatMap((x) => x.hosts ?? [])].some((p) =>
            hostMatches(p, h),
          ),
        )
        .map((m) => ({ host: h, repo: m.id })),
    );

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
    // A call with several matches (a wildcard route) is one caller reaching each of them.
    const once = new Set<string>();
    for (const m of matched.matches.filter((x) => x.vendor === s.id)) {
      const k = `${m.call.repo}\u0000${m.call.fact}`;
      if (once.has(k)) continue;
      once.add(k);
      const ops = opsOf(s.id, m.call);
      add({ ...callOf(m.call), ...ops }, "spec");
      if (m.direct || !m.route) continue;
      const route = m.route;
      for (const j of joined.joins)
        if (j.entry.repo === route.repo && j.entry.fact === route.fact)
          add({ ...callOf(j.call), ...ops, through: { repo: route.repo, at: route.at } }, "spec");
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
    // The profile's host aliases, then the hosts its spec serves on that no alias names.
    const aliasHosts = hostAliases(s.aliases);
    const notes = [
      ...clashes(aliasHosts).map((c) => OUTSIDE_ALIAS_CLASH(s.name, c.host, c.repo)),
      ...(spec
        ? clashes(spec.hosts.filter((h) => !aliasHosts.some((a) => hostMatches(a, h)))).map((c) =>
            OUTSIDE_SPEC_HOST_CLASH(s.name, c.host, c.repo, spec.path),
          )
        : []),
    ];
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
                calls: list.filter((c) => c.operation === o.id || !!c.operations?.includes(o.id))
                  .length,
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
      ...(notes.length ? { notes } : {}),
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
