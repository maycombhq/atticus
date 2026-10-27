import { existsSync } from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parse } from "yaml";
import {
  acquireLock,
  catalogDirOf,
  factsDirOf,
  isAdopted,
  listQuestions,
  loadOrgPack,
  LockHeldError,
  mapDirOf,
  mapRelOf,
  orgPackDirOf,
  parseFacts,
  parseRecord,
  questionsRelOf,
  raiseQuestions,
  readRepoSpec,
  removeFlow,
  SPEC_HEADER_SCHEMA_VERSION,
  specFileHash,
  specRelOf,
  flowFiles,
  writeFileAtomic,
  writeFlow,
  writeSpecHeader,
  type Fact,
  type FactsJoinResult,
  type Question,
} from "@maycombhq/core";
import {
  catalogWithFacts,
  diffCatalogs,
  diffIsEmpty,
  estateFacts,
  isPrototypeRepo,
  prototypeLeftOut,
  readCatalog,
  targetQuestionDrafts,
  targetsFromAnswers,
  TARGETS_STEP,
  writeCatalog,
  type CatalogDiff,
} from "@maycombhq/scanner";
import {
  codeLinkerFor,
  frameworkFacts,
  frameworkGaps,
  renderMap,
  trustOf,
  type RenderMapInput,
} from "@maycombhq/verify";
import { baseClonePath, loadRepos } from "@maycombhq/workspace";
import type { Output } from "./commands.js";
import { askHosts } from "./host-questions.js";
import { diffLines } from "./scan-commands.js";

/**
 * The map (ADR 0124, A3b): a repo's verified facts written into the catalog everything
 * downstream reads (`atticus verify <repo> --write`), and the map a developer reviews in a PR
 * rendered from that catalog (`atticus map render <repo>`, which --write runs too).
 */

/** The spec template a flow projected from facts is written against (core projectFacts). */
const FACTS_TEMPLATE = "facts@1";

const posix = (p: string) => p.split(sep).join("/");

export interface WriteFactsResult {
  written: { written: number; unchanged: number; removed: number };
  flows: string[];
  questions: string[];
  map: string[];
  /** Every record the write added, changed or removed, and the counts by kind. */
  changes: CatalogDiff & { byKind: Record<string, KindCount> };
}

/** How many records of a kind a write added, changed (fields or only evidence) and removed. */
export interface KindCount {
  added: number;
  changed: number;
  removed: number;
}

/** The counts of a catalog diff by record kind, kinds sorted. */
export function countByKind(d: CatalogDiff): Record<string, KindCount> {
  const out: Record<string, KindCount> = {};
  const of = (k: string) => (out[k] ??= { added: 0, changed: 0, removed: 0 });
  for (const r of d.added) of(r.kind).added++;
  for (const r of [...d.changed, ...d.evidenceOnly]) of(r.kind).changed++;
  for (const r of d.removed) of(r.kind).removed++;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** "Column +4, Endpoint +1 ~1, Interface -1": a write's records in one line. */
export function kindLine(byKind: Record<string, KindCount>): string {
  const parts = Object.entries(byKind).map(([kind, c]) =>
    [
      kind,
      c.added ? `+${c.added}` : "",
      c.changed ? `~${c.changed}` : "",
      c.removed ? `-${c.removed}` : "",
    ]
      .filter(Boolean)
      .join(" "),
  );
  return parts.join(", ");
}

/**
 * Write a repo's kept facts into the catalog: replace what came from the repo, keep every other
 * repo's records, run the scan's merge and curated passes, write the flows to specs/<repo>/, ask
 * about calls nothing joins, and render the map. One write at a time per metarepo (the scan's
 * lock), so a scan and a write never interleave.
 */
export async function writeFactsIntoCatalog(
  root: string,
  repo: string,
  facts: readonly Fact[],
  /** verbose: list every record changed and flow written, not only the counts. */
  o: { dir: string; command: string; now?: Date; verbose?: boolean },
  io: Output,
): Promise<WriteFactsResult | undefined> {
  let lock: Awaited<ReturnType<typeof acquireLock>>;
  try {
    lock = await acquireLock(root, "scan", o.command);
  } catch (e) {
    if (e instanceof LockHeldError) {
      io.err(e.message);
      return undefined;
    }
    throw e;
  }
  try {
    const op = await loadOrgPack(orgPackDirOf(root));
    const generated = join(catalogDirOf(root), "generated");
    const existing = await readCatalog(generated, { cacheRoot: root });
    // ADR 0133: a prototype's facts are kept and compared with the estate, never written into
    // the catalog, its specs or its map, and nothing is asked about its calls.
    if (isPrototypeRepo(op, repo)) {
      for (const n of prototypeLeftOut({ repo, facts, existing: [], op, decisions: [] }).notes)
        io.out(n);
      const none = diffCatalogs(existing.records, existing.records);
      return {
        written: { written: 0, unchanged: 0, removed: 0 },
        flows: [],
        questions: [],
        map: [],
        changes: { ...none, byKind: {} },
      };
    }
    const curated = await readCatalog(join(catalogDirOf(root), "curated"), { cacheRoot: root });
    const rerun = `atticus verify ${repo} --write`;
    const answered = (await listQuestions(root, { repo, step: TARGETS_STEP })).questions;
    // The estate join (ADR 0124, C-join): the other repos' verified facts, so this repo's calls
    // join the entries that serve them and their calls into this repo are joined again.
    const estate = await estateFacts(root, op, repo);
    const result = catalogWithFacts({
      repo,
      facts,
      existing: existing.records,
      op,
      decisions: curated.records,
      targets: targetsFromAnswers(repo, facts, answered),
      estate: estate.repos,
      estateTargets: estate.targets,
    });
    for (const i of result.invalid)
      io.err(
        `A merged record isn't valid C1 (a bug): ${i.issues.map((x) => `${x.path}: ${x.message}`).join("; ")}`,
      );
    const diff = diffCatalogs(existing.records, result.records);
    const written = await writeCatalog(generated, result.records);

    // Flows go to specs/<repo>/ (ADR 0079); those an earlier write made and the facts no longer
    // have are removed. A drafted flow (another template) is left alone.
    // A flow the facts project into an invalid Flow (a call-out that names no call: the verifier
    // keeps the fact, since its line holds) is left out and said, never a crash after the
    // catalog is written.
    const flows = result.flows.filter((f) => {
      const p = parseRecord(f);
      if (p.ok) return true;
      io.err(
        `The flow ${f.id} isn't written to ${specRelOf(root, repo)}/: ${p.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}. Have your assistant fix its flow fact (each call-out step's ref names the call it makes), then run ${rerun}.`,
      );
      return false;
    });
    const spec = await readRepoSpec(root, repo, { cacheRoot: root });
    const ids = new Set(flows.map((f) => f.id));
    for (const f of spec.flows)
      if (f.template === FACTS_TEMPLATE && !ids.has(f.id)) await removeFlow(root, repo, f.id);
    const flowPaths: string[] = [];
    for (const f of flows) flowPaths.push(await writeFlow(root, repo, f));
    const files: Record<string, string> = {};
    for (const f of flows)
      for (const p of flowFiles(f)) {
        const text = await readFile(join(o.dir, ...p.split("/")), "utf8").catch(() => undefined);
        if (text !== undefined) files[p] = specFileHash(text);
      }
    const commit = facts.map((f) => f.commit).sort()[0];
    const kept = spec.flows.filter((f) => f.template !== FACTS_TEMPLATE).map((f) => f.id);
    const header = spec.header;
    await writeSpecHeader(root, {
      schemaVersion: SPEC_HEADER_SCHEMA_VERSION,
      repo,
      template: header?.template ?? FACTS_TEMPLATE,
      templateReviewed: header?.templateReviewed ?? false,
      ...(commit ? { commit } : {}),
      ...(header?.drafted ? { drafted: header.drafted } : {}),
      flows: [...new Set([...kept, ...ids])].sort(),
      files: Object.fromEntries(
        Object.entries({ ...(header?.files ?? {}), ...files }).sort(([a], [b]) => (a < b ? -1 : 1)),
      ),
      questions: header?.questions ?? [],
    });

    // Calls nothing joins: a host no repo lists (ADR 0088), or no target and no host (ADR 0078).
    const at = (o.now ?? new Date()).toISOString();
    const hosts = await askHosts(root, result.records, { command: o.command, rerun, now: o.now });
    const loose = new Set(result.unresolved.map((u) => u.factId));
    // A call whose target names nothing in the estate that two or more entries serve is asked
    // too (the join fallback, ADR 0124 addendum C-join).
    const ambiguous = new Set(
      (result.join?.asks ?? [])
        .filter((a) => a.reason === "ambiguous" && a.call.repo === repo)
        .map((a) => a.call.fact),
    );
    const named = new Set(facts.filter((f) => f.kind === "call" && f.to).map((f) => f.id));
    const raised: Question[] = [...hosts.raised];
    const lines = [...hosts.lines];
    for (const t of targetQuestionDrafts(facts, result.records, op, result.join?.asks)) {
      if (!(loose.has(t.factId) || ambiguous.has(t.factId))) continue;
      if (answered.some((q) => q.id === t.id)) continue;
      const r = await raiseQuestions(root, [t.draft], {
        step: TARGETS_STEP,
        repo,
        command: o.command,
        rerun,
        at,
      });
      for (const q of r.raised) {
        raised.push(q);
        lines.push(
          named.has(t.factId)
            ? `A call names a target the estate doesn't have, and more than one entry serves it: asked ${q.id}: ${q.question} Answer it: atticus questions answer ${q.id} --option <n>, then ${rerun}.`
            : `A call names no target: asked ${q.id}: ${q.question} Answer it: atticus questions answer ${q.id} --option <n>, then ${rerun}.`,
        );
      }
    }

    // A few lines: counts by kind and the flows folder; every record and flow with --verbose
    // (or --json), so a first write of hundreds of records stays readable.
    const byKind = countByKind(diff);
    io.out(
      `Wrote the catalog for ${repo}: ${written.written} files written, ${written.removed} removed, ${written.unchanged} unchanged.`,
    );
    io.out(diffIsEmpty(diff) ? "  No catalog changes." : `  Records: ${kindLine(byKind)}.`);
    if (o.verbose) for (const l of diffLines(diff).slice(1)) io.out(`    ${l}`);
    const specsRel = specRelOf(root, repo);
    io.out(`  Flows: ${flowPaths.length} in ${specsRel}/.`);
    if (o.verbose) for (const p of flowPaths) io.out(`    ${p}`);
    else if (!diffIsEmpty(diff) || flowPaths.length)
      io.out(`  atticus verify ${repo} --write --verbose lists each record and flow.`);
    for (const p of result.curated.problems)
      io.out(`Curated decision ${p.decision} no longer applies: ${p.message}`);
    for (const p of result.projectionIssues) io.out(`  ${p.code}: ${p.message}`);
    for (const l of joinLines(repo, result.join, estate.notes, { verbose: o.verbose === true }))
      io.out(l);
    for (const l of lines) io.out(l);
    const map = await renderRepoMap(root, repo, io);
    return {
      written,
      flows: flowPaths,
      questions: raised.map((q) => q.id),
      map: map ?? [],
      changes: { ...diff, byKind },
    };
  } finally {
    await lock.release();
  }
}

/** What the estate join did for a repo's write, in a few lines. */
export function joinLines(
  repo: string,
  join: FactsJoinResult | undefined,
  notes: readonly string[] = [],
  o: { verbose?: boolean } = {},
): string[] {
  if (!join) return [...notes];
  const out = [...notes];
  const mine = join.joins.filter((j) => j.call.repo === repo && j.call.repo !== j.entry.repo);
  const into = join.joins.filter((j) => j.entry.repo === repo && j.call.repo !== repo);
  if (mine.length || into.length)
    out.push(
      `Joined across repos: ${mine.length} of ${repo}'s calls to the entries that serve them, ${into.length} calls of other repos into ${repo}, each citing both ends.`,
    );
  // The join fallback (ADR 0124 addendum C-join): nobody named the callee, so it is inferred.
  const guessed = join.joins.filter((j) => j.call.repo === repo && j.inferred);
  if (guessed.length) {
    const own = guessed.filter((j) => j.inferred!.within === "repo").length;
    const where = [
      own ? `${own} in ${repo} itself` : "",
      guessed.length - own
        ? `${guessed.length - own} in another repo${guessed.length - own === 1 ? "" : "s"}`
        : "",
    ]
      .filter(Boolean)
      .join(", ");
    out.push(
      `Joined by method and path, inferred: ${guessed.length} of ${repo}'s calls name no target the estate has, so each joined the one entry that serves it (${where}).`,
    );
    if (o.verbose)
      for (const j of guessed) {
        const what = j.method ? `${j.method} ${j.path}` : j.path;
        const named = j.inferred!.named ? ` (named ${j.inferred!.named})` : "";
        const there = j.entry.repo === repo ? "" : ` (${j.entry.repo})`;
        out.push(`  ${j.call.at} ${what}${named} → ${j.entry.component}${there}`);
      }
  }
  for (const m of join.misses) out.push(`Not joined: ${m.message} (${m.call.at}).`);
  for (const g of join.gaps.slice(0, 10)) out.push(`Field gap: ${g.message}.`);
  return out;
}

/** The repo's map files, written under map/<repo>/; the paths written, or undefined when nothing was there to render. */
async function renderRepoMap(
  root: string,
  repo: string,
  io: Output,
): Promise<string[] | undefined> {
  const records = (await readCatalog(join(catalogDirOf(root), "generated"), { cacheRoot: root }))
    .records;
  const spec = await readRepoSpec(root, repo, { cacheRoot: root });
  const ofRepo = records.some((r) => r.kind === "Component" && r.repo === repo);
  if (!ofRepo && spec.flows.length === 0) {
    io.err(
      `Nothing of ${repo} is in the catalog yet. Have your assistant read it (/atticus map), then run atticus verify ${repo} --write.`,
    );
    return undefined;
  }
  let trust;
  const report = join(factsDirOf(root), `${repo}.verify.yaml`);
  if (existsSync(report)) {
    try {
      trust = trustOf(parse(await readFile(report, "utf8")));
    } catch {
      trust = undefined;
    }
  }
  const open = (await listQuestions(root, { state: "open", repo })).questions;
  const manifest = (await loadRepos(root).catch(() => [])).find((r) => r.id === repo);
  const adopted = isAdopted(root);
  const url =
    manifest?.url && manifest.url !== "." && !manifest.url.startsWith("./")
      ? manifest.url
      : undefined;
  const codeLink = codeLinkerFor(
    url ? { url } : { dir: adopted ? "" : posix(relative(root, baseClonePath(root, repo))) },
  );
  const rel = `${mapRelOf(root)}/${repo}`;
  const files = renderMap({
    repo,
    records,
    flows: spec.flows,
    ...(trust ? { trust } : {}),
    // What a person says the repo is (ADR 0128), above the trust line.
    ...(manifest?.description
      ? {
          about: {
            text: manifest.description.text,
            trust: manifest.description.trust,
            ...(manifest.description.by ? { by: manifest.description.by } : {}),
          },
        }
      : {}),
    // What the repo is built on (ADR 0124 addendum A-framework): read from the facts, since no
    // catalog record holds a framework.
    ...builtOnOf(await factsOf(root, repo)),
    questions: open.map((q) => ({ id: q.id, question: q.question, evidence: q.evidence })),
    paths: { map: rel, questions: questionsRelOf(root), specs: specRelOf(root, repo) },
    codeLink,
  });
  // The folder is rendered whole: a page nothing renders any more goes.
  const dir = join(mapDirOf(root), repo);
  for (const old of await listFiles(dir))
    if (!(old in files)) await rm(join(dir, ...old.split("/")), { force: true });
  for (const [path, text] of Object.entries(files)) {
    const full = join(dir, ...path.split("/"));
    const now = await readFile(full, "utf8").catch(() => undefined);
    if (now !== text) await writeFileAtomic(full, text);
  }
  const paths = Object.keys(files).map((p) => `${rel}/${p}`);
  io.out(`Map: ${rel}/map.md (${Object.keys(files).length} files; review them in the PR).`);
  return paths;
}

/** The repo's kept facts, for what the map says it is built on. None when there are none. */
async function factsOf(root: string, repo: string): Promise<Fact[]> {
  const text = await readFile(join(factsDirOf(root), `${repo}.jsonl`), "utf8").catch(
    () => undefined,
  );
  if (text === undefined) return [];
  const p = parseFacts(text);
  return p.ok ? p.facts : [];
}

/**
 * What the map says a repo is built on (ADR 0124 addendum A-framework): each framework fact as a
 * line with its version and the build file's line, and the frameworks whose patterns the facts
 * show none of. Nothing when the facts name no framework.
 */
export function builtOnOf(facts: readonly Fact[]): Pick<RenderMapInput, "frameworks"> {
  const built = frameworkFacts(facts).map((f) => ({
    name: f.name,
    ...(f.version ? { version: f.version } : {}),
    ...(f.component ? { component: f.component } : {}),
    cite: { path: f.cite.file, line: f.cite.line, commit: f.commit },
  }));
  if (!built.length) return {};
  const gaps = frameworkGaps(facts).map((g) => ({ framework: g.framework, question: g.question }));
  return { frameworks: { built, ...(gaps.length ? { gaps } : {}) } };
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string, prefix: string) => {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries)
      if (e.isDirectory()) await walk(join(d, e.name), `${prefix}${e.name}/`);
      else out.push(`${prefix}${e.name}`);
  };
  await walk(dir, "");
  return out.sort();
}

/**
 * atticus map render <repo>: render the repo's map from the catalog, its specs, the verifier's
 * report and the open questions, under map/<repo>/ (.atticus/map/<repo>/ when adopted). The
 * same catalog gives the same bytes. Run after a curated decision or an answer changed the
 * catalog without new facts; `atticus verify <repo> --write` renders it too.
 */
export async function mapRenderCommand(
  root: string,
  repo: string,
  o: { json?: boolean },
  io: Output,
): Promise<number> {
  const quiet: Output = o.json ? { ...io, out: () => undefined } : io;
  const written = await renderRepoMap(root, repo, quiet);
  if (!written) return 2;
  if (o.json) io.out(JSON.stringify({ repo, files: written }, null, 2));
  return 0;
}
