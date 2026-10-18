import { mkdir, readFile, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { createAdapters, type WorkTracker } from "@maycombhq/adapters";
import type { AiRuntime } from "@maycombhq/ai";
import {
  applyCurated,
  loadOrgPack,
  migrateCatalog,
  recordPath,
  SCHEMA_VERSION,
  serializeRecord,
  type CatalogRecord,
  type OrgPack,
  type RecordOf,
  orgPackDirOf,
} from "@maycombhq/core";
import {
  FeatureError,
  featureFlows,
  featureLinkDecision,
  featureMergeDecision,
  featureNameDecision,
  featureSplitDecisions,
  featuresForScan,
  featureTagDecision,
  featureToSpec,
  FlowGraph,
  nameFeatures,
  parseFinishedNamingRun,
  parseExternalRef,
  suggestFeatureLinks,
  workItemsFromTracker,
  writeNameProposals,
  type CuratedDecision,
  type WorkItemLike,
} from "@maycombhq/features";
import { readWorkItemExports } from "@maycombhq/intake";
import { featureCoverage } from "@maycombhq/knowledge";
import { readCatalog } from "@maycombhq/scanner";
import type { Output } from "./commands.js";
import { table } from "./index-commands.js";

/**
 * atticus feature …: features found in code (ADR 0031). Every command sees the features as
 * the next scan will: detection over the generated catalog, AI name proposals, then people's
 * curated decisions. Answers are written as CuratedDecision files under catalog/curated (the
 * same path as atticus triage decide); a person runs the command, so it is the approval.
 * Exit codes: 0 ok, 1 problems (or, for suggest-links, something to confirm), 2 usage.
 */

type Capability = RecordOf<"Capability">;

interface Loaded {
  op: OrgPack;
  catalogDir: string;
  catalogRel: string;
  records: CatalogRecord[];
  features: Capability[];
  decisions: CatalogRecord[];
}

async function load(root: string, io: Output): Promise<Loaded> {
  const op = await loadOrgPack(join(orgPackDirOf(root)));
  for (const p of op.problems)
    io.err(`org-pack/${p.file}: ${p.path ? `${p.path}: ` : ""}${p.message}`);
  const catalogRel = op.sources.layout.catalog;
  const catalogDir = join(root, catalogRel);
  const generated = await readCatalog(join(catalogDir, "generated"));
  const curated = await readCatalog(join(catalogDir, "curated"));
  for (const p of [...generated.problems, ...curated.problems])
    io.err(`catalog ${p.file}: ${p.message}`);
  const base = generated.records.filter((r) => r.kind !== "Capability");
  const found = await featuresForScan({
    records: base,
    decisions: curated.records,
    proposalsDir: join(catalogDir, "proposals"),
  });
  for (const p of found.problems) io.err(`${p.decision}: ${p.message}`);
  const featureDecisions = curated.records.filter(
    (d) => d.kind === "CuratedDecision" && d.target.startsWith("feature."),
  );
  const applied = applyCurated(found.features, featureDecisions);
  for (const p of applied.problems) io.err(`${p.decision}: ${p.message}`);
  const features = applied.records.filter((r): r is Capability => r.kind === "Capability");
  return {
    op,
    catalogDir,
    catalogRel,
    records: [...base, ...features],
    features,
    decisions: curated.records,
  };
}

const featureId = (id: string) => (id.startsWith("feature.") ? id : `feature.${id}`);

function find(l: Loaded, id: string, io: Output): Capability | undefined {
  const f = l.features.find((x) => x.id === featureId(id));
  if (!f) io.err(`There is no feature ${featureId(id)}. List them with: atticus feature list`);
  return f;
}

async function writeDecisions(l: Loaded, root: string, ds: CuratedDecision[]): Promise<string[]> {
  const out: string[] = [];
  for (const d of ds) {
    const rel = `${l.catalogRel}/curated/${recordPath(d)}`;
    const full = join(root, ...rel.split("/"));
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, serializeRecord(d), "utf8");
    out.push(rel);
  }
  return out;
}

/** Run a decision command: FeatureError is a usage problem (exit 2). */
async function decide(
  root: string,
  io: Output,
  make: (l: Loaded) => CuratedDecision[] | undefined,
  said: (files: string[]) => string,
): Promise<number> {
  const l = await load(root, io);
  let ds: CuratedDecision[] | undefined;
  try {
    ds = make(l);
  } catch (e) {
    if (e instanceof FeatureError) {
      io.err(e.message);
      return 2;
    }
    throw e;
  }
  if (!ds) return 1;
  const files = await writeDecisions(l, root, ds);
  io.out(
    `Wrote ${files.join(" and ")}: ${said(files)}. Commit ${files.length > 1 ? "them" : "it"} so every scan keeps ${files.length > 1 ? "them" : "it"}.`,
  );
  return 0;
}

const by = (o: { by?: string }) => o.by ?? userInfo().username;

/** atticus feature list [--json]: every feature, how it was named, and what no feature covers. */
export async function featureList(
  root: string,
  o: { json?: boolean },
  io: Output,
): Promise<number> {
  const l = await load(root, io);
  if (l.records.length === 0) {
    io.err("The catalog is empty: run atticus scan first.");
    return 2;
  }
  const cov = featureCoverage(l.records);
  if (o.json) {
    io.out(JSON.stringify({ features: l.features, coverage: cov }, null, 2));
    return 0;
  }
  if (l.features.length === 0) io.out("No features found yet.");
  else
    for (const line of table(
      ["ID", "NAME", "NAMED BY", "OWNER", "ENTRY POINTS", "LINKS"],
      l.features.map((f) => [
        f.id,
        f.name,
        f.namedBy,
        f.owner ?? "-",
        String(f.entryPoints.length),
        String(f.externalRefs.length),
      ]),
    ))
      io.out(line);
  const n = l.features.length;
  io.out(
    `${n} feature${n === 1 ? "" : "s"}: ${cov.confirmed.length} confirmed, ${cov.detectedOnly.length} detected only.${cov.unknown.length ? ` No feature covers ${cov.unknown.join(", ")}.` : ""}`,
  );
  return 0;
}

/** atticus feature show <id> [--json]: one feature, what it starts at and spans, and its loose ends. */
export async function featureShow(
  root: string,
  id: string,
  o: { json?: boolean },
  io: Output,
): Promise<number> {
  const l = await load(root, io);
  const f = find(l, id, io);
  if (!f) return 1;
  const flows = featureFlows(l.records).find((x) => x.feature.id === f.id);
  const looseEnds = flows?.looseEnds ?? [];
  if (o.json) {
    io.out(JSON.stringify({ feature: f, system: flows?.system, looseEnds }, null, 2));
    return 0;
  }
  const g = new FlowGraph(l.records);
  const what = (x: string) => {
    const e = g.endpoints.get(x);
    if (e) return `${e.method ? `${e.method} ` : ""}${e.pathOrTopic} on ${e.component}`;
    const i = g.interfaces.get(x);
    if (i)
      return i.sync === "async"
        ? `event ${i.normalizedPath} from ${i.from} to ${i.to}`
        : `call from ${i.from}: ${i.method ?? ""} ${i.normalizedPath}`.trim();
    const s = g.settings.get(x);
    if (s) return `schedule ${s.valueOrRef} on ${s.component}`;
    return g.components.has(x) ? `batch job ${x}` : x;
  };
  io.out(`${f.name} (${f.id})`);
  io.out(`  named by: ${f.namedBy}, ${f.confidence}`);
  io.out(`  owner: ${f.owner ?? "-"}`);
  io.out(`  tags: ${f.tags.length ? f.tags.join(", ") : "-"}`);
  io.out(
    `  links: ${f.externalRefs.length ? f.externalRefs.map((r) => `${r.system}:${r.id}`).join(", ") : "-"}`,
  );
  if (f.description) io.out(`  ${f.description}`);
  io.out("Entry points:");
  for (const line of table(
    ["", ""],
    f.entryPoints.map((e) => [e, what(e)]),
  ).slice(1))
    io.out(`  ${line}`);
  io.out("Spans:");
  const byKind = new Map<string, string[]>();
  for (const r of f.records) {
    const kind = g.records.get(r)?.kind ?? "Unknown";
    byKind.set(kind, [...(byKind.get(kind) ?? []), r]);
  }
  for (const kind of [...byKind.keys()].sort())
    io.out(`  ${kind}: ${byKind.get(kind)!.join(", ")}`);
  if (looseEnds.length) {
    io.out("Loose ends:");
    for (const e of looseEnds) io.out(`  ${e.text}`);
  }
  return 0;
}

/** atticus feature name <id> <name> [--description] [--owner] [--by]: confirm or correct a feature. */
export async function featureName(
  root: string,
  id: string,
  name: string,
  o: { by?: string; description?: string; owner?: string },
  io: Output,
): Promise<number> {
  return decide(
    root,
    io,
    (l) => {
      const f = find(l, id, io);
      return f
        ? [
            featureNameDecision(f, {
              name,
              by: by(o),
              ...(o.description ? { description: o.description } : {}),
              ...(o.owner ? { owner: o.owner } : {}),
            }),
          ]
        : undefined;
    },
    () => `${featureId(id)} is "${name.trim()}"`,
  );
}

/** atticus feature tag <id> <tags...> [--by]: set a feature's tags (the full list). */
export async function featureTag(
  root: string,
  id: string,
  tags: string[],
  o: { by?: string },
  io: Output,
): Promise<number> {
  let set: string[] = [];
  return decide(
    root,
    io,
    (l) => {
      const f = find(l, id, io);
      if (!f) return undefined;
      const d = featureTagDecision(f, tags, { by: by(o) });
      set = (d.value as { tags: string[] }).tags;
      return [d];
    },
    () => `${featureId(id)} is tagged ${set.length ? set.join(", ") : "with nothing"}`,
  );
}

/** atticus feature merge <into> <from...> [--by]: fold features into one. */
export async function featureMerge(
  root: string,
  into: string,
  from: string[],
  o: { by?: string },
  io: Output,
): Promise<number> {
  return decide(
    root,
    io,
    (l) => {
      const target = find(l, into, io);
      const others = from.map((x) => find(l, x, io));
      if (!target || others.some((x) => !x)) return undefined;
      return [featureMergeDecision(target, others as Capability[], { by: by(o) })];
    },
    () =>
      `${from.map(featureId).join(", ")} ${from.length === 1 ? "is" : "are"} now part of ${featureId(into)}`,
  );
}

/** atticus feature split <id> <entry-points...> [--name] [--into] [--by]: move entry points to a new feature. */
export async function featureSplit(
  root: string,
  id: string,
  entryPoints: string[],
  o: { by?: string; name?: string; into?: string },
  io: Output,
): Promise<number> {
  let into = "";
  return decide(
    root,
    io,
    (l) => {
      const f = find(l, id, io);
      if (!f) return undefined;
      const ds = featureSplitDecisions(f, entryPoints, {
        by: by(o),
        records: l.records,
        ...(o.name ? { name: o.name } : {}),
        ...(o.into ? { into: featureId(o.into) } : {}),
      });
      into = ds[0].target;
      if (l.features.some((x) => x.id === into))
        throw new FeatureError(
          `${into} already exists; merge into it instead, or pick another name.`,
        );
      return ds;
    },
    () => `${entryPoints.join(", ")} now ${entryPoints.length === 1 ? "starts" : "start"} ${into}`,
  );
}

/** atticus feature link <id> <ref> [--title] [--by]: link a work item, wiki page or spec. */
export async function featureLink(
  root: string,
  id: string,
  ref: string,
  o: { by?: string; title?: string },
  io: Output,
): Promise<number> {
  let label = "";
  return decide(
    root,
    io,
    (l) => {
      const f = find(l, id, io);
      if (!f) return undefined;
      const r = parseExternalRef(ref, o.title);
      label = `${r.system} ${r.id}`;
      return [featureLinkDecision(f, r, { by: by(o) })];
    },
    () => `${featureId(id)} is linked to ${label}`,
  );
}

/**
 * atticus feature suggest-links [--json]: work items that look like what built each feature,
 * from the work tracker (read only) and the work-item exports in inputs/ (ADR 0032). Each is a
 * triage item; confirm one with atticus feature link. Exit 1 when there is something to
 * confirm, 0 when not.
 */
export async function featureSuggestLinks(
  root: string,
  o: { json?: boolean; workTracker?: WorkTracker },
  io: Output,
): Promise<number> {
  const l = await load(root, io);
  const items: WorkItemLike[] = [];
  let tracker = o.workTracker;
  if (!tracker && l.op.runtime.adapters.workTracker) {
    try {
      tracker = createAdapters(l.op.runtime).workTracker;
    } catch (e) {
      io.err(
        `The work tracker can't be reached (${(e as Error).message}); using the work-item exports in inputs/ instead.`,
      );
    }
  }
  if (tracker) {
    try {
      items.push(...(await workItemsFromTracker(tracker)));
    } catch (e) {
      io.err(
        `The work tracker can't be reached (${(e as Error).message}); using the work-item exports in inputs/ instead.`,
      );
    }
  }
  const exported = await readWorkItemExports({ root });
  for (const p of exported.problems) io.err(`${p.path}: ${p.message}`);
  const seen = new Set(items.map((i) => `${i.system ?? "ado"}|${i.id}`));
  for (const i of exported.items) if (!seen.has(`${i.system}|${i.id}`)) items.push(i);
  const suggestions = suggestFeatureLinks({
    features: l.features,
    items,
    records: l.records,
    decisions: l.decisions,
  });
  if (o.json) {
    io.out(JSON.stringify({ items: suggestions }, null, 2));
    return suggestions.length ? 1 : 0;
  }
  if (!suggestions.length) {
    io.out(
      items.length
        ? "No links to suggest."
        : "No work items to compare: the tracker gave none and inputs/ has no work-item export.",
    );
    return 0;
  }
  io.out(`${suggestions.length} link${suggestions.length === 1 ? "" : "s"} to confirm.`);
  for (const s of suggestions) {
    const ref = (
      s.options[0]!.decision.value as { externalRefs: { system: string; id: string }[] }
    ).externalRefs.at(-1)!;
    io.out("");
    io.out(s.id);
    io.out(`  ${s.summary}`);
    io.out(`  at ${s.source.path}${s.source.line ? `:${s.source.line}` : ""}`);
    io.out(`  → atticus feature link ${s.records[0]} ${ref.system}:${ref.id}`);
  }
  return 1;
}

/** atticus feature spec <id>: draft openspec/specs/<capability>/spec.md from a confirmed feature. */
export async function featureSpec(root: string, id: string, io: Output): Promise<number> {
  const l = await load(root, io);
  const f = find(l, id, io);
  if (!f) return 1;
  let draft;
  try {
    draft = featureToSpec(f, l.records);
  } catch (e) {
    if (e instanceof FeatureError) {
      io.err(e.message);
      return 1;
    }
    throw e;
  }
  const rel = draft.path.replace(/^openspec\//, `${l.op.sources.layout.openspec}/`);
  const full = join(root, ...rel.split("/"));
  if (
    await readFile(full).then(
      () => true,
      () => false,
    )
  ) {
    io.err(`${rel} already exists; Atticus never overwrites a spec.`);
    return 1;
  }
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, draft.text, { encoding: "utf8", flag: "wx" });
  io.out(
    `Wrote ${rel}, a draft from ${f.id}: check its requirements, then commit it in a pull request.`,
  );
  return 0;
}

/**
 * atticus feature suggest-names: ask the feature-namer agent (outside any scan) for names of
 * the features no person has named, and write its proposals to catalog/proposals. They stay
 * inferred until a person confirms one with atticus feature name.
 */
export async function featureSuggestNames(
  root: string,
  o: { runtime: AiRuntime; json?: boolean },
  io: Output,
): Promise<number> {
  const l = await load(root, io);
  const res = await nameFeatures(l.features, l.records, o.runtime, { orgPack: l.op });
  const written = await writeNameProposals(join(l.catalogDir, "proposals"), res.proposals);
  if (o.json) {
    io.out(JSON.stringify({ ...res, written }, null, 2));
  } else {
    res.proposals.forEach((p, i) =>
      io.out(
        `Wrote ${l.catalogRel}/proposals/${written[i]}: ${p.feature} could be called "${p.name}".`,
      ),
    );
    for (const d of res.discarded)
      io.err(`Discarded${d.feature ? ` ${d.feature}` : ""}: ${d.reason}`);
    for (const r of res.runs.filter((x) => x.state === "failed"))
      io.err(`The ${r.agent} run failed: ${r.reason ?? "no reason given"}`);
    for (const r of res.runs.filter((x) => x.state === "waiting"))
      io.out(
        `Handed the names of ${r.features.length} feature${r.features.length === 1 ? "" : "s"} to your assistant. When it is done, run: atticus handoff done ${r.runId}`,
      );
    const n = res.proposals.length;
    io.out(
      `${n} proposal${n === 1 ? "" : "s"} from ${res.runs[0]?.agent ?? "feature-namer"}; confirm one with: atticus feature name <feature> <name>`,
    );
  }
  return res.runs.some((r) => r.state === "failed") ? 1 : 0;
}

/**
 * The end of `feature suggest-names` in hand-off mode: `atticus handoff done` validated the
 * assistant's answer, so read it against today's features and write the proposals, as a
 * model run's answer would have been.
 */
export async function completeFeatureNaming(
  root: string,
  run: Parameters<typeof parseFinishedNamingRun>[0],
  io: Output,
  o: { now?: Date } = {},
): Promise<number> {
  const l = await load(root, io);
  const at = (o.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
  const res = parseFinishedNamingRun(run, l.features, at);
  const written = await writeNameProposals(join(l.catalogDir, "proposals"), res.proposals);
  res.proposals.forEach((p, i) =>
    io.out(
      `Wrote ${l.catalogRel}/proposals/${written[i]}: ${p.feature} could be called "${p.name}".`,
    ),
  );
  for (const d of res.discarded)
    io.err(`Discarded${d.feature ? ` ${d.feature}` : ""}: ${d.reason}`);
  const n = res.proposals.length;
  io.out(
    `${n} proposal${n === 1 ? "" : "s"} from ${run.request.agent.id}; confirm one with: atticus feature name <feature> <name>`,
  );
  return 0;
}

/**
 * atticus catalog migrate [--dry-run]: rewrite catalog files written at an older schema
 * version at the current one (ADR 0031: version 1 → 2 changes only schemaVersion). Exit 1
 * when a file couldn't be read as a record (it is left alone).
 */
export async function catalogMigrate(
  root: string,
  io: Output,
  o: { dryRun?: boolean } = {},
): Promise<number> {
  const op = await loadOrgPack(join(orgPackDirOf(root)));
  const rel = op.sources.layout.catalog;
  const res = await migrateCatalog(join(root, rel), o);
  for (const f of res.migrated) io.out(`  ${rel}/${f}`);
  for (const p of res.problems) io.err(`${rel}/${p.file}: ${p.message}`);
  if (!res.migrated.length && !res.problems.length)
    io.out(`Every catalog file is already at schema version ${SCHEMA_VERSION}.`);
  else if (res.migrated.length)
    io.out(
      `${o.dryRun ? "Would migrate" : "Migrated"} ${res.migrated.length} file${res.migrated.length === 1 ? "" : "s"} to catalog schema version ${SCHEMA_VERSION}; ${res.current.length} already current.${o.dryRun ? "" : " Commit the change."}`,
    );
  return res.problems.length ? 1 : 0;
}
