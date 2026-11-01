import { existsSync } from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parse, stringify } from "yaml";
import {
  acquireLock,
  catalogDirOf,
  factsDirOf,
  factsRelOf,
  isAdopted,
  isGuessedJoin,
  listQuestions,
  loadOrgPack,
  LockHeldError,
  mapDirOf,
  mapRelOf,
  orgPackDirOf,
  parseFacts,
  parseRecord,
  questionId,
  questionsRelOf,
  raiseQuestions,
  readRepoSpec,
  retireQuestion,
  removeFlow,
  SPEC_HEADER_SCHEMA_VERSION,
  specFileHash,
  specRelOf,
  flowFiles,
  writeFileAtomic,
  writeFlow,
  writeSpecHeader,
  type CatalogRecord,
  type Fact,
  type FactsJoinResult,
  type ExposureFinding,
  type JoinHow,
  type Question,
} from "@maycombhq/core";
import {
  catalogWithFacts,
  diffCatalogs,
  diffIsEmpty,
  estateFacts,
  isPrototypeRepo,
  prototypeLeftOut,
  groupedTargetDrafts,
  readCatalog,
  splitTargetGroups,
  staleTargetQuestions,
  targetQuestionFor,
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
import {
  linkEvidenceAbout,
  linkEvidenceLines,
  loadLinkEvidence,
  writeRepoContracts,
} from "./link-evidence-files.js";
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
  /** J2: the links between components the write made, unmade or changed, and the join's counts. */
  links: LinkChanges;
}

/** J2: one Interface of a write, with its confidence and how its callee was found. */
export interface LinkLine {
  id: string;
  from: string;
  to: string;
  method?: string;
  path: string;
  confidence: string;
  /** How the join found the callee (left out for a link no join of this write made). */
  how?: JoinHow;
  /** The Interface's flags, `joined-by-path` and `joined-by-label` among them. */
  flags?: string[];
  /** Under changed: the confidence and flags it had before. */
  was?: { confidence: string; flags?: string[] };
}

/**
 * J2: what a write did to the links (catalog Interfaces), for review in the pull request: the
 * repo's calls joined (of them inferred), asked, left to a system outside the estate, and not
 * joined; and each Interface added, removed, or changed in confidence or flags.
 */
export interface LinkChanges {
  calls: { joined: number; inferred: number; asked: number; outside: number; missed: number };
  added: LinkLine[];
  removed: LinkLine[];
  changed: LinkLine[];
}

const HOW_WORDS: Record<JoinHow, string> = {
  answer: "a person's answer",
  named: "name",
  repo: "the repo's name",
  host: "host",
  path: "path",
  topic: "topic",
};

/** J2: the links a write added, removed or changed, from the catalog before and after it. */
export function linkChanges(
  repo: string,
  join: FactsJoinResult | undefined,
  before: readonly CatalogRecord[],
  after: readonly CatalogRecord[],
): LinkChanges {
  const mine = <T extends { call: { repo: string } }>(xs: readonly T[] | undefined) =>
    (xs ?? []).filter((x) => x.call.repo === repo);
  const joined = mine(join?.joins);
  const how = new Map((join?.joins ?? []).map((j) => [j.interface, j.how] as const));
  const ifaces = (rs: readonly CatalogRecord[]) =>
    new Map(
      rs
        .filter((r): r is Extract<CatalogRecord, { kind: "Interface" }> => r.kind === "Interface")
        .map((r) => [r.id, r] as const),
    );
  const was = ifaces(before);
  const now = ifaces(after);
  // A call the join asks about that a link already starts from (a host a person answered,
  // which the merge joins) is no longer asked.
  const linked = new Set(
    [...now.values()].flatMap((r) =>
      r.evidence.filter((e) => e.side !== "callee").map((e) => `${e.repo}|${e.path}:${e.line}`),
    ),
  );
  const line = (r: Extract<CatalogRecord, { kind: "Interface" }>, found: boolean): LinkLine => {
    const h = found ? how.get(r.id) : undefined;
    return {
      id: r.id,
      from: r.from,
      to: r.to,
      ...(r.method ? { method: r.method } : {}),
      path: r.normalizedPath,
      confidence: r.confidence,
      ...(h ? { how: h } : {}),
      ...(r.flags?.length ? { flags: [...r.flags] } : {}),
    };
  };
  const byId = (a: LinkLine, b: LinkLine) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const flagsOf = (r: { flags?: string[] | undefined }) => [...(r.flags ?? [])].sort().join(",");
  const changed: LinkLine[] = [];
  for (const [id, r] of now) {
    const old = was.get(id);
    if (!old || (old.confidence === r.confidence && flagsOf(old) === flagsOf(r))) continue;
    changed.push({
      ...line(r, true),
      was: {
        confidence: old.confidence,
        ...(old.flags?.length ? { flags: [...old.flags] } : {}),
      },
    });
  }
  return {
    calls: {
      joined: joined.length,
      inferred: joined.filter(isGuessedJoin).length,
      asked: mine(join?.asks).filter((a) => !linked.has(`${a.call.repo}|${a.call.at}`)).length,
      outside: mine(join?.outside).length,
      missed: mine(join?.misses).length,
    },
    added: [...now.values()]
      .filter((r) => !was.has(r.id))
      .map((r) => line(r, true))
      .sort(byId),
    removed: [...was.values()]
      .filter((r) => !now.has(r.id))
      .map((r) => line(r, false))
      .sort(byId),
    changed: changed.sort(byId),
  };
}

/** How many links a write lists before pointing to the verify report (as verify's SHOWN). */
const LINKS_SHOWN = 5;

/** J2: the links of a write in a few lines; every one with verbose, else the first few. */
export function linkLines(l: LinkChanges, report: string, o: { verbose?: boolean } = {}): string[] {
  const c = l.calls;
  const calls = `${c.joined} call${c.joined === 1 ? "" : "s"} joined${c.inferred ? ` (${c.inferred} inferred)` : ""}, ${c.asked} asked, ${c.outside} outside the estate, ${c.missed} not joined`;
  const counts = [
    l.added.length ? `+${l.added.length}` : "",
    l.removed.length ? `-${l.removed.length}` : "",
    l.changed.length ? `~${l.changed.length}` : "",
  ].filter(Boolean);
  if (!counts.length) return [`  Links: ${calls}; no Interface added or removed.`];
  const out = [`  Links: ${calls}; Interfaces ${counts.join(" ")} (all under links in ${report}).`];
  const text = (sign: string, x: LinkLine) => {
    const what = [x.method, x.path].filter(Boolean).join(" ");
    const conf = x.was ? `${x.confidence}, was ${x.was.confidence}` : x.confidence;
    const flags = x.flags?.join(", ");
    const found = x.how
      ? `found by ${HOW_WORDS[x.how]}${flags ? `: ${flags}` : ""}`
      : (flags ?? "");
    return `    ${sign} ${x.from} → ${x.to} ${what} (${conf}${found ? `; ${found}` : ""})`;
  };
  const all = [
    ...l.added.map((x) => text("+", x)),
    ...l.removed.map((x) => text("-", x)),
    ...l.changed.map((x) => text("~", x)),
  ];
  const shown = o.verbose ? all : all.slice(0, LINKS_SHOWN);
  out.push(...shown);
  if (shown.length < all.length)
    out.push(`    ... and ${all.length - shown.length} more (links in ${report})`);
  return out;
}

/**
 * J2: the write's links, put in the repo's verify report (`<repo>.verify.yaml`) under `links`,
 * so the pull request shows what the write did to the links. A report that isn't there or
 * doesn't read is left alone.
 */
async function writeLinksIntoReport(
  root: string,
  repo: string,
  links: LinkChanges,
  /** J1 (ADR 0143): the exposure findings about this repo, put beside the links; none, none. */
  exposure: readonly ExposureFinding[] = [],
  /** ADR 0151: what the contract files and traffic say of this repo's links. */
  evidence?: ReturnType<typeof linkEvidenceAbout>,
): Promise<void> {
  const file = join(factsDirOf(root), `${repo}.verify.yaml`);
  const text = await readFile(file, "utf8").catch(() => undefined);
  if (text === undefined) return;
  let report: unknown;
  try {
    report = parse(text);
  } catch {
    return;
  }
  if (!report || typeof report !== "object" || Array.isArray(report)) return;
  const {
    exposure: _old,
    contracts: _c,
    traffic: _t,
    ...rest
  } = report as { exposure?: unknown; contracts?: unknown; traffic?: unknown };
  const c = evidence?.contracts;
  const t = evidence?.traffic;
  await writeFileAtomic(
    file,
    stringify({
      ...rest,
      links,
      ...(exposure.length
        ? {
            exposure: exposure.map((x) => ({
              reason: x.reason,
              fact: x.exposure.fact,
              at: x.exposure.at,
              message: x.message,
            })),
          }
        : {}),
      ...(c && (c.confirmed.length || c.findings.length) ? { contracts: c } : {}),
      ...(t && (t.seen.length || t.findings.length || t.unknownApps.length) ? { traffic: t } : {}),
    }),
  );
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
        links: {
          calls: { joined: 0, inferred: 0, asked: 0, outside: 0, missed: 0 },
          added: [],
          removed: [],
          changed: [],
        },
      };
    }
    const curated = await readCatalog(join(catalogDirOf(root), "curated"), { cacheRoot: root });
    const rerun = `atticus verify ${repo} --write`;
    const answered = (await listQuestions(root, { repo, step: TARGETS_STEP })).questions;
    const targets = targetsFromAnswers(repo, facts, answered);
    // The estate join (ADR 0124, C-join): the other repos' verified facts, so this repo's calls
    // join the entries that serve them and their calls into this repo are joined again.
    const estate = await estateFacts(root, op, repo);
    // ADR 0151: this repo's contract files, read at the facts' commit and kept beside its facts,
    // then every repo's, and the traffic aggregates people imported.
    await writeRepoContracts(root, repo, o.dir, facts);
    const evidence = await loadLinkEvidence(root);
    for (const p of evidence.problems) io.err(p);
    const result = catalogWithFacts({
      repo,
      facts,
      existing: existing.records,
      op,
      decisions: curated.records,
      targets,
      estate: estate.repos,
      estateTargets: estate.targets,
      linkEvidence: { contracts: evidence.contracts, traffic: evidence.traffic },
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
    // Q1: the calls that go the same way (the repo, the target named or host or base, the path
    // prefix) are asked once; a call a person's answer already names isn't asked again.
    const asked = new Set(
      [...loose, ...ambiguous].filter(
        (id) =>
          targets[id] === undefined &&
          !answered.some((q) => q.state === "answered" && q.id === targetId(facts, repo, id)),
      ),
    );
    const drafted = groupedTargetDrafts(facts, result.records, op, result.join?.asks, {
      ask: asked,
      split: splitTargetGroups(answered),
    });
    for (const t of drafted) {
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
          t.factIds.length > 1
            ? `${t.factIds.length} calls go the same way and name no target the estate has: asked once, ${q.id}: ${q.question} One answer names the target of all of them. Answer it: atticus questions answer ${q.id} --option <n>, then ${rerun}.`
            : named.has(t.factId)
              ? `A call names a target the estate doesn't have, and more than one entry serves it: asked ${q.id}: ${q.question} Answer it: atticus questions answer ${q.id} --option <n>, then ${rerun}.`
              : `A call names no target: asked ${q.id}: ${q.question} Answer it: atticus questions answer ${q.id} --option <n>, then ${rerun}.`,
        );
      }
    }
    // J6: an open question the code now answers (the call names its target, or the manifest's
    // hosts and base paths join it) retires, saying how; one asked another way now (Q1) names
    // the question that asks it. An answered question is never retired.
    for (const s of staleTargetQuestions({
      repo,
      facts,
      open: answered.filter((q) => q.state === "open"),
      drafted,
      asked,
      ...(result.join ? { join: result.join } : {}),
    })) {
      await retireQuestion(root, s.id, {
        why: s.why,
        at,
        ...(s.replacedBy ? { replacedBy: s.replacedBy } : {}),
      });
      lines.push(`Retired ${s.id}: ${s.why}.`);
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
    // J2: the links the write made or unmade, with confidence and how each was found.
    const links = linkChanges(repo, result.join, existing.records, result.records);
    for (const l of linkLines(links, `${factsRelOf(root)}/${repo}.verify.yaml`, {
      verbose: o.verbose === true,
    }))
      io.out(l);
    const about = result.linkEvidence
      ? linkEvidenceAbout(repo, result.linkEvidence, result.join)
      : undefined;
    if (about)
      for (const l of linkEvidenceLines(about, `${factsRelOf(root)}/${repo}.verify.yaml`, {
        verbose: o.verbose === true,
      }))
        io.out(l);
    await writeLinksIntoReport(root, repo, links, result.join?.exposure, about);
    for (const l of lines) io.out(l);
    const map = await renderRepoMap(root, repo, io);
    return {
      written,
      flows: flowPaths,
      questions: raised.map((q) => q.id),
      map: map ?? [],
      changes: { ...diff, byKind },
      links,
    };
  } finally {
    await lock.release();
  }
}

/** The id of a call's own target question (ADR 0078), as it was always asked. */
function targetId(facts: readonly Fact[], repo: string, id: string): string | undefined {
  const f = facts.find((x) => x.id === id);
  const q = f ? targetQuestionFor(f) : undefined;
  return q ? questionId({ step: TARGETS_STEP, repo, ...q }) : undefined;
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
  // J1 (ADR 0143): where an exposure fact and the manifest disagree, or it names nothing.
  for (const x of join.exposure ?? []) out.push(`Exposure: ${x.message}.`);
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
