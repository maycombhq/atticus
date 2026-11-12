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
  joinFlagsOf,
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
  reopenQuestion,
  TOPICS_STEP_ID,
  retireQuestion,
  removeFlow,
  SPEC_HEADER_SCHEMA_VERSION,
  specFileHash,
  specRelOf,
  flowFiles,
  HOSTS_STEP,
  hostOfQuestion,
  writeFileAtomic,
  writeFlow,
  writeSpecHeader,
  type CatalogRecord,
  type ContractsFileT,
  type Fact,
  type PersonPair,
  type FactJoin,
  type FactsJoinResult,
  type ExposureFinding,
  type JoinHow,
  type Question,
  ContractsFile,
  sharedJoinAbout,
  type SharedJoinResult,
} from "@maycombhq/core";
import {
  answeredQuestionOfCall,
  answerReconfirmed,
  answerRuleOffers,
  buildAndWrite,
  buildCatalog,
  buildLines,
  diffCatalogs,
  factsSnapshotWrites,
  forgetKeptReads,
  loadBuildInputs,
  withSlotWrites,
  diffIsEmpty,
  estateFacts,
  estateRepos,
  isPrototypeRepo,
  prototypeLeftOut,
  groupedTargetDrafts,
  isJoinHostQuestion,
  isTokenHost,
  joinHostQuestionDrafts,
  staleJoinHostQuestions,
  readCatalog,
  ruledTargets,
  splitTargetGroups,
  staleTargetQuestions,
  staleTopicQuestions,
  targetQuestionFor,
  TARGETS_STEP,
  topicQuestionDrafts,
  sourcesRelOf,
  type BuildAndWrite,
  type CatalogDiff,
} from "@maycombhq/scanner";
import { readNotSettled, repoOfTarget } from "./answer-reopen.js";
import {
  codeLinkerFor,
  frameworkFacts,
  frameworkGaps,
  renderMap,
  trustOf,
  type RenderMapInput,
} from "@maycombhq/verify";
import { baseClonePath, isInPlace, loadRepos } from "@maycombhq/workspace";
import type { Output } from "./commands.js";
import { askHosts } from "./host-questions.js";
import { termsWrite } from "./term-lines.js";
import { checkoutOf } from "./facts-files.js";
import { buildPlanOf, pageChanged } from "./build-report.js";
import {
  linkEvidenceAbout,
  linkEvidenceLines,
  repoContractsOf,
  writeRepoContracts,
} from "./link-evidence-files.js";
import { diffLines } from "./scan-commands.js";
import { writeRepoSpecs } from "./contract-check-files.js";

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
  /**
   * ADR 0195 (CS1): the facts snapshot this write took, `catalog/sources/facts/<repo>.jsonl` and
   * its meta, and whether either changed. Left out for a prototype, which is never in the catalog.
   */
  snapshot?: { path: string; status: "written" | "unchanged"; facts: number; commit: string };
  /** ADR 0195 point 4: each record the build removed, with what explains it. */
  removed?: {
    kind: string;
    id: string;
    repos: string[];
    explainedBy: string[];
    reasons: string[];
  }[];
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
  /**
   * The link is verified by another call to it (ADR 0135, section 5), while this repo's own
   * call was found by a guess (`how`, with `guesses` its flags): said as such, never as a
   * verified link found by path.
   */
  byOther?: true;
  /** With `byOther`: the guesses this repo's own call rests on. */
  guesses?: string[];
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
  "base-path": "the proxy's base path",
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
  // The joins of each Interface: this repo's calls first, and of them one nobody guessed first,
  // so a shared link says how its cited join was made (ADR 0135, section 5).
  const joinsOf = new Map<string, FactJoin[]>();
  for (const j of [...joined, ...(join?.joins ?? []).filter((x) => !joined.includes(x))])
    joinsOf.set(j.interface, [...(joinsOf.get(j.interface) ?? []), j]);
  const howOf = (r: { id: string; confidence: string }) => {
    const all = joinsOf.get(r.id) ?? [];
    const own = all.filter((j) => joined.includes(j));
    const best = own.find((j) => !isGuessedJoin(j)) ?? own[0] ?? all[0];
    if (!best) return undefined;
    // Verified, yet every call of this repo to it was a guess: another call verified it.
    const byOther = r.confidence === "verified" && own.length > 0 && isGuessedJoin(best);
    return { how: best.how, ...(byOther ? { byOther, guesses: joinFlagsOf(best) } : {}) };
  };
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
    const h = found ? howOf(r) : undefined;
    return {
      id: r.id,
      from: r.from,
      to: r.to,
      ...(r.method ? { method: r.method } : {}),
      path: r.normalizedPath,
      confidence: r.confidence,
      ...(h ? { how: h.how } : {}),
      ...(r.flags?.length ? { flags: [...r.flags] } : {}),
      ...(h?.byOther ? { byOther: true as const, guesses: h.guesses } : {}),
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
    if (x.byOther && x.how) {
      // ADR 0135, section 5: verified by another call; this repo's own one is a guess.
      const g = x.guesses?.join(", ");
      const was = x.was ? `, was ${x.was.confidence}` : "";
      return `    ${sign} ${x.from} → ${x.to} ${what} (${x.confidence} by another call${was}; this one by ${HOW_WORDS[x.how]}${g ? `: ${g}` : ""})`;
    }
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
  /** ADR 0160: this repo's calls joined to another team's shared map, and those it has no entry for. */
  shared?: SharedReport,
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
    shared: _s,
    ...rest
  } = report as { exposure?: unknown; contracts?: unknown; traffic?: unknown; shared?: unknown };
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
      ...(shared && (shared.joined.length || shared.unmatched.length || shared.asked.length)
        ? { shared }
        : {}),
    }),
  );
}

/** ADR 0160: what a write's calls met in other teams' shared maps, for the verify report. */
export interface SharedReport {
  joined: {
    call: string;
    at: string;
    team: string;
    commit: string;
    repo: string;
    entry: string;
    entryAt: string;
  }[];
  unmatched: { call: string; at: string; team: string; commit: string; message: string }[];
  asked: { call: string; at: string; team: string; question: string }[];
}

export function sharedReport(
  r: SharedJoinResult,
  maps: readonly { team: string; commit: string }[],
): SharedReport {
  const commit = (team: string) => maps.find((m) => m.team === team)?.commit ?? "";
  return {
    joined: r.matches.map((m) => ({
      call: m.call.fact,
      at: m.call.at,
      team: m.team,
      commit: commit(m.team),
      repo: m.entry.repo,
      entry: m.entry.fact,
      entryAt: m.entry.at,
    })),
    unmatched: r.gaps.map((g) => ({
      call: g.call.fact,
      at: g.call.at,
      team: g.team,
      commit: commit(g.team),
      message: g.message,
    })),
    asked: r.asks.map((a) => ({
      call: a.call.fact,
      at: a.call.at,
      team: a.team,
      question: a.question,
    })),
  };
}

/** What a write's calls met in other teams' shared maps, in a few lines (ADR 0160). */
export function sharedLines(repo: string, s: SharedReport, verbose: boolean): string[] {
  const out: string[] = [];
  const teams = [...new Set([...s.joined, ...s.unmatched, ...s.asked].map((x) => x.team))].sort();
  for (const team of teams) {
    const j = s.joined.filter((x) => x.team === team);
    const u = s.unmatched.filter((x) => x.team === team);
    const a = s.asked.filter((x) => x.team === team);
    const c = (j[0] ?? u[0])?.commit.slice(0, 7);
    out.push(
      `Shared map: ${j.length} of ${repo}'s calls joined to ${team}'s map${c ? ` (their commit ${c})` : ""}, each citing their entry; ${u.length} it has no entry for${a.length ? `; ${a.length} two of its entries answer` : ""}. Their entries are theirs: a wrong one is theirs to correct.`,
    );
    for (const x of verbose ? j : []) out.push(`  ${x.at} → ${x.repo} ${x.entryAt} (${x.entry})`);
    for (const x of verbose ? u : u.slice(0, 5)) out.push(`  ${x.at}: ${x.message}`);
    for (const x of a) out.push(`  ${x.at}: ${x.question}`);
  }
  return out;
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
/**
 * The catalog a repo's verified facts make, with the estate join, and what it changes against the
 * catalog on disk: computed in memory, nothing written. `writeFactsIntoCatalog` writes it, and
 * the app's preview of the next `atticus verify <repo> --write` (C4, ADR 0149) shows it, so both
 * say the same thing.
 */
export async function projectFactsIntoCatalog(
  root: string,
  repo: string,
  facts: readonly Fact[],
  given: {
    op?: Awaited<ReturnType<typeof loadOrgPack>>;
    existing?: readonly CatalogRecord[];
    /**
     * This repo's contract files as its checkout has them (`repoContractsOf`), in place of its
     * companion on disk: the write refreshes the companion first, so a preview passes them to
     * read what the write will.
     */
    contracts?: ContractsFileT;
    /** False for a preview: no read cache is kept, so nothing at all is written. */
    cache?: boolean;
    /** G1 (ADR 0174): pairings not written yet, a preview's, added to those on file. */
    extraPairs?: Readonly<Record<string, PersonPair>>;
    /** The commit verify checked the facts at (the snapshot's). */
    commit?: string;
  } = {},
) {
  const op = given.op ?? (await loadOrgPack(orgPackDirOf(root)));
  const cacheOpts = given.cache === false ? {} : { cacheRoot: root };
  const existing =
    given.existing ?? (await readCatalog(join(catalogDirOf(root), "generated"), cacheOpts)).records;
  const everyTarget = (await listQuestions(root, { step: TARGETS_STEP })).questions;
  const answered = everyTarget.filter((q) => q.repo === repo);
  const repoType = estateRepos(op).find((r) => r.id === repo)?.type;
  const targetsOpts = repoType ? { repoType } : {};
  const ruled = ruledTargets(repo, facts, everyTarget, targetsOpts);
  // The other repos' facts as the assistant's files hold them: for the questions' suggestions.
  const estate = await estateFacts(root, op, repo);
  // ADR 0195 (CS2): the build with this repo's facts snapshot in place of its slot, every other
  // repo from its own slot (facts or readers), nothing read from the catalog it replaces. The
  // contract files ride in the snapshot's meta (ADR 0151); a preview passes the checkout's.
  const contracts =
    given.contracts ??
    ((await readContractsCompanion(root, repo)) as ContractsFileT | undefined) ??
    null;
  const snap = factsSnapshotWrites(root, repo, facts, {
    commit: given.commit ?? snapshotCommitOf(facts),
    contracts: contracts && contracts.entries.length ? contracts : null,
  });
  const inputs = await loadBuildInputs(root, { op });
  const build = await buildCatalog({
    ...inputs,
    slots: await withSlotWrites(root, inputs.slots, snap),
    ...(given.extraPairs ? { extraPairs: new Map([[repo, given.extraPairs]]) } : {}),
  });
  const mine = build.facts.get(repo);
  const result = {
    records: build.records,
    flows: mine?.flows ?? [],
    unresolved: mine?.unresolved ?? [],
    curated: build.curated,
    projectionIssues: mine?.projectionIssues ?? [],
    invalid: build.invalid,
    notes: build.notes,
    ...(mine ? { join: mine.join } : {}),
    ...(build.linkEvidence ? { linkEvidence: build.linkEvidence } : {}),
    ...(build.shared ? { shared: sharedJoinAbout(build.shared, repo) } : {}),
    ...(build.terms ? { terms: build.terms } : {}),
    ...(mine?.answerMisses.length ? { answerMisses: mine.answerMisses } : {}),
  };
  const targets = mine?.targets ?? {};
  const diff = diffCatalogs([...existing], result.records);
  const links = linkChanges(repo, result.join, existing, result.records);
  return {
    op,
    existing,
    answered,
    everyTarget,
    targets,
    ruled,
    estate,
    result,
    diff,
    links,
    build,
    snap,
    evidenceProblems: build.problems.filter((p) => p.source === "build").map((p) => p.message),
    sharedMaps: inputs.shared.maps,
  };
}

/** The commit a snapshot is of when verify didn't say: the facts' own, when they agree. */
function snapshotCommitOf(facts: readonly Fact[]): string {
  const commits = [...new Set(facts.map((f) => f.commit))];
  return commits.length === 1 ? commits[0]! : "unknown";
}

/** A repo's contract companion on file (`facts/<repo>.contracts.yaml`), when it reads. */
async function readContractsCompanion(root: string, repo: string) {
  const text = await readFile(join(factsDirOf(root), `${repo}.contracts.yaml`), "utf8").catch(
    () => undefined,
  );
  if (text === undefined) return undefined;
  try {
    const p = ContractsFile.safeParse(parse(text));
    return p.success ? p.data : undefined;
  } catch {
    return undefined;
  }
}

export async function writeFactsIntoCatalog(
  root: string,
  repo: string,
  facts: readonly Fact[],
  /** verbose: list every record changed and flow written, not only the counts. */
  o: {
    dir: string;
    command: string;
    now?: Date;
    verbose?: boolean;
    /** The commit verify checked the facts at (the snapshot's commit); default the facts' own. */
    commit?: string;
    /** `--allow-removals <count>` and `--discard-edits <count>` (ADR 0195 point 4). */
    allowRemovals?: number;
    discardEdits?: number;
    /** Told the refused build, when a guard refused it (the app's and --json's report). */
    onRefused?: (r: BuildAndWrite) => void;
    /**
     * The app's confirm (no flag takes it): the plan of the refusal the counts confirm, worked
     * out again under the lock; another list writes nothing (the review of beta.27).
     */
    plan?: string;
  },
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
    // The write builds: its inputs as the files hold them now, never the app's kept copies (CS3).
    forgetKeptReads();
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
    const rerun = `atticus verify ${repo} --write`;
    // ADR 0151: this repo's contract files, read at the facts' commit; kept beside its facts and
    // in the snapshot's meta, written only once the build passes its guards.
    const contracts = await repoContractsOf(root, repo, o.dir, facts, (n) => io.err(n));
    const snapshotCommit = o.commit ?? snapshotCommitOf(facts);
    const {
      answered,
      everyTarget,
      targets,
      ruled,
      estate,
      result,
      diff,
      links,
      evidenceProblems,
      sharedMaps,
      build,
      snap,
    } = await projectFactsIntoCatalog(root, repo, facts, {
      op,
      existing: existing.records,
      contracts,
      commit: snapshotCommit,
    });
    for (const p of evidenceProblems) io.err(p);
    for (const i of result.invalid)
      io.err(
        `A merged record isn't valid C1 (a bug): ${i.issues.map((x) => `${x.path}: ${x.message}`).join("; ")}`,
      );
    // ADR 0195 (CS2): the facts snapshot, then the build from every slot, its guards, and only
    // then the write: a refused build writes nothing, the snapshot and the companions included.
    const built = await buildAndWrite(root, {
      command: rerun,
      build,
      slots: snap,
      ...(o.allowRemovals !== undefined ? { allowRemovals: o.allowRemovals } : {}),
      ...(o.discardEdits !== undefined ? { discardEdits: o.discardEdits } : {}),
      ...(o.plan !== undefined
        ? { expect: (listed: BuildAndWrite["guard"]) => buildPlanOf(listed) === o.plan }
        : {}),
    });
    // The app's confirm of a list that changed meanwhile: nothing written, and what the build
    // lists now (its own plan with it) for the page to show.
    if (built.changed) io.err(pageChanged("what the build would remove or discard"));
    if (built.guard.refused || built.changed) {
      if (built.guard.refused) for (const l of buildLines(root, built)) io.err(l);
      if (built.guard.refused) o.onRefused?.(built);
      return undefined;
    }
    // ADR 0151, 0164: the contract companion and this repo's specs, kept beside its facts.
    await writeRepoContracts(root, repo, o.dir, facts, (n) => io.err(n));
    await writeRepoSpecs(root, repo, o.dir, facts, (n) => io.err(n));
    const w = built.write!;
    const snapshot = {
      path: `${sourcesRelOf(root)}/facts/${repo}.jsonl`,
      status: w.slots.some((x) => x.startsWith(`${sourcesRelOf(root)}/facts/${repo}.`))
        ? ("written" as const)
        : ("unchanged" as const),
      facts: facts.length,
      commit: snapshotCommit,
    };
    const written = { written: w.written, unchanged: w.unchanged, removed: w.removed };
    // ADR 0195 point 4: the removals the build wrote, each with what explains it, are said.
    for (const l of buildLines(root, built)
      .filter((l) => !l.startsWith("slots: "))
      .slice(1))
      if (o.verbose || w.removals.length) io.out(l);

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
    // Beta.27: a gateway's forwarding call to a token target URL (one only its `<URL>` line
    // writes too) is asked in the join's words below (read the repo again), never on its own.
    const tokenAsked = new Set(
      (result.join?.asks ?? [])
        .filter(
          (a) =>
            a.reason === "unknown-host" && a.call.repo === repo && !!a.host && isTokenHost(a.host),
        )
        .map((a) => a.call.fact),
    );
    const asked = new Set(
      [...loose, ...ambiguous].filter(
        (id) =>
          !tokenAsked.has(id) &&
          targets[id] === undefined &&
          !answered.some((q) => q.state === "answered" && q.id === targetId(facts, repo, id)),
      ),
    );
    const drafted = groupedTargetDrafts(facts, result.records, op, result.join?.asks, {
      ask: asked,
      split: splitTargetGroups(answered),
      // ADR 0162 (F8): the suggestions read the estate's facts and the earlier answers.
      estate: estate.repos,
      questions: everyTarget,
    });
    const refreshed: Question[] = [];
    for (const t of drafted) {
      // Beta.12: a question asked before, still open, takes today's options (the ranked
      // suggestions, why each is suggested, the repos read since) in place: the same id.
      const r = await raiseQuestions(
        root,
        [t.draft],
        { step: TARGETS_STEP, repo, command: o.command, rerun, at },
        { refresh: true },
      );
      refreshed.push(...r.refreshed);
      for (const q of r.raised) {
        raised.push(q);
        lines.push(
          t.factIds.length > 1
            ? `${t.factIds.length} calls go the same way and name no target the estate has: asked once, ${q.id}: ${q.question} One answer names the target of all of them. Answer it: atticus questions answer ${q.id} --option <n>, then ${rerun}.`
            : named.has(t.factId)
              ? `A call names a target the estate doesn't have, and more than one entry serves it: asked ${q.id}: ${q.question} Answer it: atticus questions answer ${q.id} --option <n>, then ${rerun}.`
              : ambiguous.has(t.factId)
                ? `More than one entry of the estate could answer a call: asked ${q.id}: ${q.question} Answer it: atticus questions answer ${q.id} --option <n>, then ${rerun}.`
                : `A call names no target: asked ${q.id}: ${q.question} Answer it: atticus questions answer ${q.id} --option <n>, then ${rerun}.`,
        );
      }
    }
    // Beta.24 review: the join's questions about a host nothing resolves, raised as files so the
    // app shows them (they were only counted): a gateway's token target URL as a targets question
    // in the join's words (read the repo again, or name the target); any other host as a hosts
    // question, when none asks about it yet. A call asked another way already isn't asked again.
    const hostsNow = (await listQuestions(root, { step: HOSTS_STEP })).questions;
    const hostDrafts = joinHostQuestionDrafts({
      repo,
      facts,
      asks: result.join?.asks ?? [],
      records: result.records,
      repos: await loadRepos(root).catch(() => []),
      skip: new Set([...drafted.flatMap((t) => t.factIds), ...Object.keys(targets)]),
      hostsAsked: new Set(hostsNow.flatMap((q) => hostOfQuestion(q) ?? [])),
    });
    const joinHostAsked: { id: string; host: string }[] = [];
    for (const d of hostDrafts) {
      const r = await raiseQuestions(
        root,
        [d.draft],
        { step: d.step, repo, command: o.command, rerun, at },
        { refresh: d.step === TARGETS_STEP },
      );
      refreshed.push(...r.refreshed);
      const q = r.of[0];
      if (q) joinHostAsked.push({ id: q.id, host: d.host });
      for (const x of r.raised) {
        raised.push(x);
        lines.push(
          d.step === TARGETS_STEP
            ? `${d.factIds.length === 1 ? "A call goes" : `${d.factIds.length} calls go`} to ${d.host}, a token no fact sets: asked ${x.id}: ${x.question} Answer it: atticus questions answer ${x.id} --option <n>, then ${rerun}.`
            : `Calls to ${d.host} join no repo: no repo lists it under hosts. Asked ${x.id}: ${x.question} Answer it: atticus questions answer ${x.id} --option <n> (1 is ${x.options[0]!.label}), then ${rerun}.`,
        );
      }
    }
    for (const s of staleJoinHostQuestions({
      repo,
      open: everyTarget.filter((q) => q.state === "open" && isJoinHostQuestion(q)),
      drafted: joinHostAsked,
      ...(result.join ? { join: result.join } : {}),
      // Beta.25: a hosts question the join raised retires too once it no longer asks it.
      hostsOpen: (await listQuestions(root, { step: HOSTS_STEP, state: "open", repo })).questions,
      stillAsked: new Set([...hosts.raised, ...hosts.reasked, ...hosts.open].map((q) => q.id)),
    })) {
      await retireQuestion(root, s.id, {
        why: s.why,
        at,
        ...(s.replacedBy ? { replacedBy: s.replacedBy } : {}),
      });
      lines.push(`Retired ${s.id}: ${s.why}.`);
    }
    if (refreshed.length)
      lines.push(
        `Refreshed ${refreshed.length === 1 ? "1 open question" : `${refreshed.length} open questions`} asked before (${refreshed.map((q) => q.id).join(", ")}): the same id, with today's options, ranked by the estate as read now, each saying why it is suggested.`,
      );
    // ADR 0162 (F8): a topic or queue no estate repo serves the other side of, that no system
    // of the profile names: who owns it (a system or a team, from the picker).
    const topicDrafts = topicQuestionDrafts(repo, result.records);
    for (const t of topicDrafts) {
      const r = await raiseQuestions(root, [t.draft], {
        step: TOPICS_STEP_ID,
        repo,
        command: o.command,
        rerun,
        at,
      });
      for (const q of r.raised) {
        raised.push(q);
        lines.push(
          `No repo of the estate serves the other side of ${t.topic}: asked ${q.id}: ${q.question} If another team or a vendor owns it, name them: atticus questions answer ${q.id} --target <system or team id> (it goes under the system's topics in the profile, for review), then ${rerun}.`,
        );
      }
    }
    // Round 49: an open topic question whose topic is no longer a loose end (the other side is
    // read and joined, or the profile names its owner) retires the same way, saying why.
    for (const s of staleTopicQuestions({
      repo,
      open: (await listQuestions(root, { step: TOPICS_STEP_ID, state: "open", repo })).questions,
      drafted: topicDrafts,
    })) {
      await retireQuestion(root, s.id, {
        why: s.why,
        at,
        ...(s.replacedBy ? { replacedBy: s.replacedBy } : {}),
      });
      lines.push(`Retired ${s.id}: ${s.why}.`);
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
      ruled,
      ...(result.join ? { join: result.join } : {}),
    })) {
      await retireQuestion(root, s.id, {
        why: s.why,
        at,
        ...(s.replacedBy ? { replacedBy: s.replacedBy } : {}),
      });
      lines.push(`Retired ${s.id}: ${s.why}.`);
    }
    // ADR 0162 (F8): an answer the code read since disagrees with (the repo it names is read,
    // and no route of it serves the call) opens its question again, saying why.
    const reopened = new Set<string>();
    const unsettled = new Map<string, string | undefined>();
    for (const m of result.answerMisses ?? []) {
      const callerFacts =
        m.call.repo === repo ? facts : estate.repos.find((x) => x.repo === m.call.repo)?.facts;
      const q = callerFacts
        ? answeredQuestionOfCall(m.call.repo, callerFacts, everyTarget, m.call.fact)
        : undefined;
      if (!q || reopened.has(q.id)) continue;
      // Review item 2: the person gave the same answer again after it reopened: their word holds.
      if (answerReconfirmed(q)) continue;
      // Review item 9: only a read of the repo named that is whole and fresh disagrees.
      const named = repoOfTarget(op, m.target);
      if (!unsettled.has(named)) unsettled.set(named, await readNotSettled(root, named));
      const notYet = unsettled.get(named);
      if (notYet) {
        lines.push(
          `${m.target} is read, but ${notYet}: ${q.id}'s answer is checked against it once the read is whole and fresh.`,
        );
        continue;
      }
      reopened.add(q.id);
      const why = `${m.target} is read now, and no route of it serves the call: ${m.message} (${m.call.at})`;
      await reopenQuestion(root, q.id, { why, at });
      lines.push(
        `Asked again ${q.id}: ${why}. Answer it again: atticus questions answer ${q.id} --option <n> | --target <id>, then atticus verify ${m.call.repo} --write.`,
      );
    }
    // ADR 0162 (F8): the same answer in several repos offers to become one rule.
    const typeOf = new Map(estateRepos(op).map((r) => [r.id, r.type] as const));
    for (const offer of answerRuleOffers({
      repos: [{ repo, facts }, ...estate.repos].map((r) => ({
        ...r,
        ...(typeOf.get(r.repo) ? { type: typeOf.get(r.repo)! } : {}),
      })),
      questions: everyTarget.filter((q) => !reopened.has(q.id)),
    }))
      if (offer.repos.includes(repo)) lines.push(offer.line);

    // ADR 0163: the organisation's terms: access against calls, possible links, a question per
    // unknown term, and what the accepted call-security rules find.
    const termed = await termsWrite(root, repo, {
      op,
      terms: result.terms,
      repos: [{ repo, facts }, ...estate.repos],
      join: result.join,
      command: o.command,
      rerun,
      at,
      dirOf: (r) => (r === repo ? Promise.resolve(o.dir) : checkoutOf(root, r)),
    });
    raised.push(...termed.raised);
    lines.push(...termed.lines);

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
    io.out(
      `  Facts snapshot: ${snapshot.path} ${snapshot.status} (${snapshot.facts} ${snapshot.facts === 1 ? "fact" : "facts"} at ${snapshot.commit.slice(0, 7)}).`,
    );
    for (const p of result.curated.problems)
      io.out(`Curated decision ${p.decision} no longer applies: ${p.message}`);
    for (const p of result.projectionIssues) io.out(`  ${p.code}: ${p.message}`);
    for (const l of joinLines(repo, result.join, estate.notes, { verbose: o.verbose === true }))
      io.out(l);
    // J2: the links the write made or unmade, with confidence and how each was found.
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
    const sharedAbout = result.shared ? sharedReport(result.shared, sharedMaps) : undefined;
    if (sharedAbout) for (const l of sharedLines(repo, sharedAbout, o.verbose === true)) io.out(l);
    await writeLinksIntoReport(root, repo, links, result.join?.exposure, about, sharedAbout);
    for (const l of lines) io.out(l);
    const map = await renderRepoMap(root, repo, io);
    return {
      written,
      flows: flowPaths,
      questions: raised.map((q) => q.id),
      map: map ?? [],
      changes: { ...diff, byKind },
      links,
      snapshot,
      // ADR 0195 point 4: what the build removed, each with what explains it.
      removed: w.removals.map((x) => ({
        kind: x.kind,
        id: x.id,
        repos: x.repos,
        explainedBy: x.explainedBy,
        reasons: x.reasons,
      })),
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
  const url = manifest?.url && !isInPlace(manifest.url) ? manifest.url : undefined;
  const codeLink = codeLinkerFor(
    url ? { url } : { dir: adopted ? "" : posix(relative(root, baseClonePath(root, repo))) },
  );
  const rel = `${mapRelOf(root)}/${repo}`;
  const kept = await factsOf(root, repo);
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
    ...builtOnOf(kept),
    // ADR 0163: the organisation's terms it writes, read from the facts as the frameworks are.
    ...termsOfFacts(kept),
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

/** The term facts as the map lists them (ADR 0163); nothing when the facts hold none. */
export function termsOfFacts(facts: readonly Fact[]): Pick<RenderMapInput, "terms"> {
  const terms = facts.flatMap((f) =>
    f.kind === "term"
      ? [
          {
            term: f.term,
            value: f.value,
            role: f.role,
            cite: { path: f.cite.file, line: f.cite.line, commit: f.commit },
            ...(f.meaning
              ? { meaning: { path: f.meaning.file, line: f.meaning.line, commit: f.commit } }
              : {}),
          },
        ]
      : [],
  );
  return terms.length ? { terms } : {};
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
