import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import {
  applyCurated,
  catalogDirOf,
  deserializeRecord,
  loadOrgPack,
  orgPackDirOf,
  recordPath,
  serializeRecord,
  type CatalogRecord,
  type OrgPack,
} from "@maycombhq/core";
import { toRunSummary, type AiRuntime, type Run } from "@maycombhq/ai";
import { syncSources, type KnowledgePage } from "@maycombhq/knowledge";
import {
  applyGlossary,
  buildGlossary,
  type GlossaryBuild,
  type GlossaryTermRecord,
} from "./build.js";
import {
  parseDefinerOutput,
  proposeDefinitions,
  readDefinitionProposals,
  undefinedCodeTerms,
  writeDefinitionProposals,
  type ProposeResult,
} from "./proposals.js";

/**
 * Reading and writing the glossary in a metarepo. The terms are generated records
 * (`catalog/generated/glossaryterm/`), rebuilt from the wiki pages, the catalog and the
 * curated decisions; `glossaryForScan` gives a scan the same records so every scan keeps
 * them. Files only: wiki pages come through the read-only knowledge sources.
 */

/**
 * Every record file under a catalog folder. A copy of the scanner's reader, so the scanner can
 * depend on this package to build the glossary in every scan.
 */
export async function readRecords(
  dir: string,
): Promise<{ records: CatalogRecord[]; problems: { file: string; message: string }[] }> {
  const records: CatalogRecord[] = [];
  const problems: { file: string; message: string }[] = [];
  async function walk(d: string) {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (/\.ya?ml$/.test(e.name)) {
        const r = deserializeRecord(await readFile(full, "utf8"));
        if (r.ok) records.push(r.record);
        else
          problems.push({
            file: relative(dir, full).split(sep).join("/"),
            message: r.issues.map((i) => `${i.path}: ${i.message}`).join("; "),
          });
      }
    }
  }
  await walk(dir);
  return { records, problems };
}

export interface GlossaryForScanInput {
  root: string;
  orgPack: OrgPack;
  /** The merged catalog, before curated decisions. */
  records: readonly CatalogRecord[];
  /** Curated decisions. */
  decisions: readonly CatalogRecord[];
  /** catalog/proposals. */
  proposalsDir: string;
  /** Pages already read; default: read the org pack's wiki sources. */
  pages?: readonly KnowledgePage[];
  /** The org-pack folder wiki locations are relative to; default the root's. */
  orgPackDir?: string;
}

export interface GlossaryForScanResult {
  build: GlossaryBuild;
  /** The catalog with terms added and columns linked, ready for curated decisions. */
  records: CatalogRecord[];
  problems: string[];
}

/** The glossary for a scan: call it after merge and features, before curated decisions. */
export async function glossaryForScan(i: GlossaryForScanInput): Promise<GlossaryForScanResult> {
  const problems: string[] = [];
  let pages = i.pages;
  if (!pages) {
    const s = await syncSources({
      root: i.root,
      orgPack: i.orgPack,
      orgPackDir: i.orgPackDir ?? orgPackDirOf(i.root),
      records: [...i.records],
    });
    pages = s.pages;
    for (const p of s.problems) problems.push(`${p.source}: ${p.message}`);
  }
  const prop = await readDefinitionProposals(i.proposalsDir);
  for (const p of prop.problems) problems.push(`proposals/${p.file}: ${p.message}`);
  const build = buildGlossary({
    pages,
    records: i.records,
    decisions: i.decisions,
    proposals: prop.proposals,
  });
  problems.push(...build.problems);
  return { build, records: applyGlossary(i.records, build), problems };
}

export interface LoadedGlossary {
  orgPack: OrgPack;
  catalogDir: string;
  /** Generated catalog without glossary terms (what the glossary is built from). */
  base: CatalogRecord[];
  decisions: CatalogRecord[];
  pages: KnowledgePage[];
  build: GlossaryBuild;
  /** The catalog after the glossary and the glossary's curated decisions. */
  records: CatalogRecord[];
  terms: GlossaryTermRecord[];
  problems: string[];
}

const isGlossaryDecision = (d: CatalogRecord, columns: Set<string>) =>
  d.kind === "CuratedDecision" &&
  (d.target.startsWith("term.") ||
    (columns.has(d.target) &&
      d.action === "assert" &&
      typeof d.value === "object" &&
      d.value !== null &&
      "glossaryTerm" in d.value));

/** Build the glossary from the metarepo's files, with curated decisions applied. */
export async function loadGlossary(root: string): Promise<LoadedGlossary> {
  const orgPack = await loadOrgPack(orgPackDirOf(root));
  const problems = orgPack.problems.map(
    (p) => `org-pack/${p.file}: ${p.path ? `${p.path}: ` : ""}${p.message}`,
  );
  const catalogDir = catalogDirOf(root);
  const generated = await readRecords(join(catalogDir, "generated"));
  const curated = await readRecords(join(catalogDir, "curated"));
  for (const p of [...generated.problems, ...curated.problems])
    problems.push(`catalog ${p.file}: ${p.message}`);
  const base = generated.records.filter((r) => r.kind !== "GlossaryTerm");
  const s = await syncSources({ root, orgPack, orgPackDir: orgPackDirOf(root), records: base });
  for (const p of s.problems) problems.push(`${p.source}: ${p.message}`);
  const g = await glossaryForScan({
    root,
    orgPack,
    records: base,
    decisions: curated.records,
    proposalsDir: join(catalogDir, "proposals"),
    pages: s.pages,
  });
  problems.push(...g.problems);
  const columns = new Set(base.filter((r) => r.kind === "Column").map((r) => r.id));
  const mine = curated.records.filter((d) => isGlossaryDecision(d, columns));
  const applied = applyCurated(g.records, mine);
  for (const p of applied.problems) problems.push(`${p.decision}: ${p.message}`);
  return {
    orgPack,
    catalogDir,
    base,
    decisions: curated.records,
    pages: s.pages,
    build: g.build,
    records: applied.records,
    terms: applied.records.filter((r): r is GlossaryTermRecord => r.kind === "GlossaryTerm"),
    problems,
  };
}

export interface ScanGlossaryResult extends LoadedGlossary {
  /** Files written under catalog/generated, relative to it. */
  written: string[];
  removed: string[];
  propose?: ProposeResult;
}

/**
 * Rebuild the glossary and write it into catalog/generated: one file per term (stale term
 * files removed), and the columns whose `glossaryTerm` changed. With a runtime, first asks the
 * glossary definer for definitions of code-only terms and saves them as proposals.
 */
export async function scanGlossary(
  root: string,
  o: { runtime?: AiRuntime; now?: Date } = {},
): Promise<ScanGlossaryResult> {
  let g = await loadGlossary(root);
  let propose: ProposeResult | undefined;
  if (o.runtime) {
    const todo = undefinedCodeTerms(g.build.entries);
    propose = await proposeDefinitions(todo, o.runtime, {
      orgPack: g.orgPack,
      ...(o.now ? { now: o.now } : {}),
    });
    if (propose.proposals.length) {
      await writeDefinitionProposals(join(g.catalogDir, "proposals"), propose.proposals);
      g = await loadGlossary(root);
    }
  }
  const generated = join(g.catalogDir, "generated");
  const written: string[] = [];
  const removed: string[] = [];
  const want = new Map(g.terms.map((t) => [recordPath(t), serializeRecord(t)]));
  const termDir = join(generated, "glossaryterm");
  for (const f of (await readdir(termDir).catch(() => [] as string[])).sort()) {
    const rel = `glossaryterm/${f}`;
    if (!want.has(rel)) {
      await rm(join(termDir, f), { force: true });
      removed.push(rel);
    }
  }
  const before = new Map(g.base.map((r) => [`${r.kind}/${r.id}`, r]));
  const put = async (rel: string, text: string) => {
    const full = join(generated, ...rel.split("/"));
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, text, "utf8");
    written.push(rel);
  };
  for (const [rel, text] of want) {
    const cur = await readFile(join(generated, ...rel.split("/")), "utf8").catch(() => undefined);
    if (cur !== text) await put(rel, text);
  }
  const termIds = new Set(g.terms.map((t) => t.id));
  for (const r of g.records) {
    if (r.kind !== "Column") continue;
    const old = before.get(`Column/${r.id}`);
    if (!old || old.kind !== "Column") continue;
    // A link to a term that no longer exists is dropped; a new or changed link is written.
    const next =
      r.glossaryTerm && termIds.has(r.glossaryTerm) ? r : { ...r, glossaryTerm: undefined };
    if ((old.glossaryTerm ?? "") === (next.glossaryTerm ?? "")) continue;
    const { glossaryTerm, ...rest } = next;
    await put(recordPath(r), serializeRecord(glossaryTerm ? next : (rest as CatalogRecord)));
  }
  return { ...g, written: written.sort(), removed, ...(propose ? { propose } : {}) };
}

/**
 * The end of `glossary scan` in hand-off mode: `atticus handoff done` validated the assistant's
 * answer, so read it against today's code-only terms (those the definer was sent), save the
 * definitions as proposals and rebuild the glossary, as a model run's answer would have been.
 */
export async function completeGlossaryDefinitions(
  root: string,
  run: Pick<Run, "runId" | "output" | "request"> & Partial<Run>,
  o: { now?: Date } = {},
): Promise<ScanGlossaryResult & { propose: ProposeResult }> {
  const g = await loadGlossary(root);
  const at = (o.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
  const sent = new Set(run.request.pack.manifest.sources.map((s) => s.id));
  const todo = undefinedCodeTerms(g.build.entries).filter((e) => sent.has(e.id));
  const parsed = parseDefinerOutput(run.output ?? "", todo, {
    agent: run.request.agent.id,
    at,
    runId: run.runId,
  });
  if (parsed.proposals.length)
    await writeDefinitionProposals(join(g.catalogDir, "proposals"), parsed.proposals);
  const propose: ProposeResult = {
    ...parsed,
    ...(run.state ? { run: toRunSummary(run as Run) } : {}),
    promptSha256: run.request.pack.manifest.promptSha256,
  };
  const scanned = await scanGlossary(root);
  return { ...scanned, propose };
}
