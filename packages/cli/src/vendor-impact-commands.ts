import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { inputsDirOf, readFlow, specFlowFiles, type Fact, type FactEnd } from "@maycombhq/core";
import {
  readVendorSpec,
  slug,
  vendorImpact,
  type ImpactFlow,
  type IntakeDocument,
  type VendorChange,
  type VendorImpact,
} from "@maycombhq/intake";
import { estateFacts, estateRepos, joinReposOf } from "@maycombhq/scanner";
import type { Output } from "./commands.js";
import { intakeContext } from "./intake-commands.js";

/**
 * atticus intake impact <spec> (ADR 0130): compare a vendor's spec with its other version in
 * inputs/ and say, for each change, what in the estate it reaches: the external gateway's
 * forwarding calls, the service calls through them, and on up. The words a person reads are here,
 * in one place, so the command, the change it starts and the attached impact say the same thing.
 */

export const IMPACT_WORDS = {
  usage: "Name the vendor spec: atticus intake impact <spec> [--json]",
  noSuchSpec: (spec: string) =>
    `There is no ${spec} in inputs/. atticus intake list shows what is there.`,
  notASpec: (path: string) =>
    `${path} isn't an OpenAPI 3 or Swagger 2 spec, so it has no operations to compare.`,
  noOtherVersion: (path: string) =>
    `${path} has no other version beside it in inputs/, so there is nothing to compare. Add each version of a vendor's spec beside the last (atticus intake add), never over it.`,
  noSystem: (path: string) =>
    `${path} isn't linked to a system yet, so its operations belong to nobody. atticus triage asks which system it is.`,
  header: (name: string, older: Version, newer: Version) =>
    `${name}: ${older.path}${older.version ? ` (${older.version})` : ""} → ${newer.path}${newer.version ? ` (${newer.version})` : ""}`,
  counts: (all: number, breaking: number) =>
    all === 0
      ? "The two versions publish the same operations, fields and auth."
      : `${all} change${all === 1 ? "" : "s"}: ${breaking} breaking, ${all - breaking} additive.`,
  severity: { breaking: "Breaking", additive: "Additive" } as const,
  reachesNothing: "Nothing in the estate reaches it.",
  gap: (message: string, where: string) =>
    `Forwarded, but not in the older version either: ${message} (${where}).`,
  ask: (question: string) => `Asked: ${question}`,
  affected: (repos: string[], flows: string[]) =>
    `Affected: ${repos.join(", ")}${flows.length ? `; flows ${flows.join(", ")}` : ""}.`,
  nothingAffected: "Nothing in the estate reaches these changes.",
  start: (spec: string) =>
    `Start a change with this as its footprint: atticus change new "<title>" --type <type> --impact ${spec}`,
  docTitle: (name: string, version: string) =>
    `# What ${name} ${version} changes, and what in the estate it reaches`,
  started: (name: string, version: string, i: VendorImpact, attached: string) =>
    `Its footprint is what ${name} ${version} reaches: ${i.repos.length} repo${i.repos.length === 1 ? "" : "s"}, ${i.flows.length} flow${i.flows.length === 1 ? "" : "s"}, ${i.interfaces.length} Interface${i.interfaces.length === 1 ? "" : "s"}. The impact is attached as ${attached}.`,
};

interface Version {
  path: string;
  version?: string;
}

export interface LoadedImpact {
  /** The vendor system's name, as the org pack writes it. */
  name: string;
  diff: VendorChange[];
  impact: VendorImpact;
  /** What the estate's facts left out, said once. */
  notes: string[];
  /** Every repo's facts, to name a fact a hit points at. */
  facts: Map<string, Fact>;
}

const posix = (p: string) => p.split(sep).join("/");
const SPECS = new Set(["openapi", "swagger"]);

/** The document a person named: its inputs/ path, a path on disk, its id or its file name. */
function findDocument(
  root: string,
  docs: IntakeDocument[],
  spec: string,
): IntakeDocument | undefined {
  const kept = docs.filter((d) => d.id);
  // A path typed from where the person stands, when it is a file there.
  if (!isAbsolute(spec) && spec.includes("/") && existsSync(resolve(spec))) spec = resolve(spec);
  const rel = isAbsolute(spec) ? `inputs/${posix(relative(inputsDirOf(root), spec))}` : posix(spec);
  return (
    kept.find((d) => d.path === rel) ??
    kept.find((d) => d.path === `inputs/${rel}`) ??
    kept.find((d) => d.id === spec) ??
    (() => {
      const named = kept.filter((d) => d.path.split("/").pop() === rel);
      return named.length === 1 ? named[0] : undefined;
    })()
  );
}

/** The impact of a vendor spec against its other version, or what is in the way, in words. */
export async function loadVendorImpact(
  root: string,
  spec: string,
  io: Output,
): Promise<LoadedImpact | { error: string }> {
  const { op, inputs } = await intakeContext(root, io);
  const doc = findDocument(root, inputs.documents, spec);
  if (!doc) return { error: IMPACT_WORDS.noSuchSpec(spec) };
  if (!SPECS.has(doc.classification)) return { error: IMPACT_WORDS.notASpec(doc.path) };
  const byId = new Map(inputs.documents.filter((d) => d.id).map((d) => [d.id!, d]));
  const older = doc.supersededBy
    ? doc
    : inputs.documents.find((d) => d.supersededBy === doc.id && SPECS.has(d.classification));
  const newer = doc.supersededBy ? byId.get(doc.supersededBy) : doc;
  if (!older || !newer || !SPECS.has(newer.classification))
    return { error: IMPACT_WORDS.noOtherVersion(doc.path) };
  const systemId = newer.systems[0] ?? older.systems[0];
  const system = op.profiles
    .flatMap((p) => p.profile?.systems ?? [])
    .find((s) => s.id === systemId);
  if (!systemId || !system) return { error: IMPACT_WORDS.noSystem(newer.path) };

  const inputsDir = inputsDirOf(root);
  const read = async (d: IntakeDocument) =>
    readVendorSpec(
      d.path,
      await readFile(join(inputsDir, ...d.path.split("/").slice(1)), "utf8"),
      systemId,
    );
  const [olderSpec, newerSpec] = [await read(older), await read(newer)];
  if (!olderSpec) return { error: IMPACT_WORDS.notASpec(older.path) };
  if (!newerSpec) return { error: IMPACT_WORDS.notASpec(newer.path) };

  const estate = await estateFacts(root, op, "");
  const repos = joinReposOf(op, estate.repos);
  const flows: ImpactFlow[] = [];
  for (const [id, f] of await specFlowFiles(root).catch(
    () => new Map<string, { repo: string; file: string }>(),
  )) {
    const flow = await readFlow(root, f.repo, id).catch(() => undefined);
    if (!flow) continue;
    flows.push({
      id,
      repo: f.repo,
      ...(flow.trigger.ref ? { trigger: flow.trigger.ref } : {}),
      refs: flow.steps.flatMap((s) => s.refs ?? []),
    });
  }
  const systemOfRepo = Object.fromEntries(
    estateRepos(op).flatMap((r) => (r.system ? [[r.id, r.system] as const] : [])),
  );
  const { diff, impact } = vendorImpact({
    vendor: { system: systemId, names: [system.name, ...system.aliases] },
    older: { id: older.id!, spec: olderSpec },
    newer: { id: newer.id!, spec: newerSpec },
    repos,
    targets: estate.targets,
    flows,
    systemOfRepo,
  });
  const facts = new Map<string, Fact>();
  for (const r of estate.repos) for (const f of r.facts) facts.set(`${r.repo}\u0000${f.id}`, f);
  return { name: system.name, diff, impact, notes: estate.notes, facts };
}

const where = (e: FactEnd) => `${e.repo} ${e.at}`;

/** The impact as lines a person reads; the same lines go into the change's attached impact. */
export function impactLines(l: LoadedImpact): string[] {
  const { impact, diff } = l;
  const out: string[] = [];
  out.push(IMPACT_WORDS.header(l.name, impact.older, impact.newer));
  out.push(IMPACT_WORDS.counts(diff.length, diff.filter((c) => c.severity === "breaking").length));
  const byId = new Map(diff.map((c) => [c.id, c]));
  for (const c of impact.changes) {
    const d = byId.get(c.id)!;
    out.push("");
    out.push(`${IMPACT_WORDS.severity[c.severity]}: ${c.says}`);
    const cites = [
      ...(d.before ? [`was ${d.before.cite}`] : []),
      ...(d.after ? [`now ${d.after.cite}`] : []),
    ];
    if (cites.length) out.push(`  ${cites.join(", ")}`);
    if (!c.forwards.length) out.push(`  ${IMPACT_WORDS.reachesNothing}`);
    for (const f of c.forwards) {
      const call = l.facts.get(`${f.call.repo}\u0000${f.call.fact}`);
      const what =
        call?.kind === "call"
          ? [call.method?.toUpperCase(), call.path].filter(Boolean).join(" ")
          : f.call.fact;
      const to = f.tie ? `to ${l.name} through ${f.tie.at}` : `to ${l.name}`;
      out.push(`  forwarded by ${f.call.component}: ${what}, ${where(f.call)} (${to})`);
      for (const s of f.callers) {
        const field = s.field
          ? s.field.uses === "sends" || s.field.uses === "reads"
            ? `, ${s.field.uses} ${d.field}${s.field.at ? ` (${s.field.at})` : ""}`
            : `, ${s.field.uses === "does-not-send" ? "doesn't send" : "doesn't read"} ${d.field}`
          : "";
        const via = s.via?.length ? `, through ${s.via.join(" → ")}` : "";
        out.push(`    called by ${s.call.component}: ${where(s.call)}${field}${via}`);
        if (s.under) out.push(`      under ${where(s.under)}`);
        for (const u of s.upstream) {
          const uvia = u.via?.length ? `, through ${u.via.join(" → ")}` : "";
          out.push(
            `      ← ${u.call.component}: ${where(u.call)}${uvia}${u.under ? `, under ${where(u.under)}` : ""}`,
          );
        }
      }
    }
  }
  if (impact.gaps.length || impact.asks.length) out.push("");
  for (const g of impact.gaps) out.push(IMPACT_WORDS.gap(g.message, where(g.call)));
  for (const a of impact.asks) out.push(IMPACT_WORDS.ask(a.question));
  out.push("");
  out.push(
    impact.repos.length
      ? IMPACT_WORDS.affected(
          impact.repos,
          impact.flows.map((f) => f.id),
        )
      : IMPACT_WORDS.nothingAffected,
  );
  return out;
}

/**
 * atticus intake impact <spec> [--json]: exit 0 when no breaking change reaches the estate, 1 when
 * one does (or the spec can't be compared), 2 when no spec is named.
 */
export async function intakeImpact(
  root: string,
  spec: string,
  o: { json?: boolean },
  io: Output,
): Promise<number> {
  if (!spec) {
    io.err(IMPACT_WORDS.usage);
    return 2;
  }
  const l = await loadVendorImpact(root, spec, io);
  if ("error" in l) {
    io.err(l.error);
    return 1;
  }
  for (const n of l.notes) io.err(n);
  const reaches = l.impact.changes.some((c) => c.severity === "breaking" && c.forwards.length > 0);
  if (o.json) {
    io.out(JSON.stringify({ diff: l.diff, impact: l.impact }, null, 2));
    return reaches ? 1 : 0;
  }
  for (const line of impactLines(l)) io.out(line);
  if (l.impact.repos.length) io.out(IMPACT_WORDS.start(l.impact.newer.path));
  return reaches ? 1 : 0;
}

/** The attached impact's file name and text, for a change started from it. */
export function impactDocument(l: LoadedImpact): { name: string; text: string } {
  const version = l.impact.newer.version ?? l.impact.newer.id;
  return {
    name: `${slug(`${l.name} ${version}`)}-impact.md`,
    text: [IMPACT_WORDS.docTitle(l.name, version), "", ...impactLines(l), ""].join("\n"),
  };
}
