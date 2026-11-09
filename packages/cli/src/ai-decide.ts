import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  aiPause,
  AnswerMatch,
  answerByWords,
  answerQuestion,
  auditPrecision,
  batchRelOf,
  callsOfQuestion,
  catalogDirOf,
  checkedProposals,
  FileChangedError,
  correctionLine,
  decideOf,
  deriveMatch,
  FactCorrection,
  factsDirOf,
  factsRelOf,
  HOSTS_NONE,
  isAiBy,
  JOINED_BY_AI,
  JOINED_BY_ANSWER,
  JOINED_BY_PERSON,
  linkCandidates,
  linksFor,
  listBatches,
  listQuestions,
  loadOrgPack,
  matchCovers,
  newBatchId,
  orgPackDirOf,
  pairingBar,
  parseAuditFile,
  parseCorrections,
  parseFacts,
  proposalRelOf,
  Question,
  questionAiProblem,
  questionBar,
  QuestionError,
  questionsRelOf,
  readBatch,
  readQuestion,
  RULE_AFTER_CORRECTIONS,
  ruleKindOf,
  TARGETS_STEP_ID,
  writeBatch,
  withSharedFileLock,
  writeFileAtomic,
  writeQuestion,
  AI_LINE_BY,
  type AiBy,
  type AiRuntime,
  type Api,
  type AuditItemT,
  type AuditTally,
  type BatchItemT,
  type DecideNow,
  type DecideSettings,
  type DecisionBatchT,
  type Fact,
  type FactOf,
  type RuleKind,
  type RuleSubject,
} from "@maycombhq/core";
import { checkoutOf } from "./facts-files.js";
import { safeMessage } from "./file-lock.js";

/**
 * ADR 0181: AI decides first, as itself; a person corrects one, and the correction spreads.
 *
 * - After a Copilot session Atticus ran (Match with Copilot, `questions propose`), Atticus (never
 *   the session) applies each decision that passes the citation check and meets a bar
 *   (`pairingBar`, `questionBar`), when runtime.yaml's `decide` says auto and the sample audit
 *   hasn't paused it. Each application is one batch, recorded under `decisions/`.
 * - A person's correction of an AI item is theirs; "Apply to similar" derives a rule and
 *   re-checks every AI decision and open item it covers (`correctDecision`).
 * - Every batch is one Undo away (`undoBatch`).
 * - What the AI decided, the counts split three ways, the batches and the pause (`decisionsView`).
 *
 * Inside a Copilot session (ATTICUS_ACP_SESSION) nothing here applies or corrects anything: a
 * session acts as no one (ADR 0171, round 32).
 */

export class DecideError extends Error {
  constructor(
    readonly code: "bad" | "not-found" | "conflict" | "refused",
    message: string,
  ) {
    super(message);
  }
}

/** A Copilot session Atticus started: it never applies, corrects or undoes a decision. */
export const inAcpSession = (env: NodeJS.ProcessEnv = process.env) => !!env.ATTICUS_ACP_SESSION;

const AI_RUNTIME: AiRuntime = "copilot-acp";

// ------------------------------------------------------------------ files

async function factsOf(root: string, repo: string): Promise<Fact[]> {
  const text = await readFile(join(factsDirOf(root), `${repo}.jsonl`), "utf8").catch(() => "");
  if (!text.trim()) return [];
  const r = parseFacts(text);
  return r.ok ? r.facts : [];
}

const correctionsFile = (root: string, repo: string) =>
  join(factsDirOf(root), `${repo}.corrections.jsonl`);
const correctionsRel = (root: string, repo: string) =>
  `${factsRelOf(root)}/${repo}.corrections.jsonl`;

async function correctionsOf(root: string, repo: string) {
  const text = await readFile(correctionsFile(root, repo), "utf8").catch(() => "");
  return parseCorrections(text).corrections;
}

/** The repos with a corrections file. */
async function correctedRepos(root: string): Promise<string[]> {
  return (await readdir(factsDirOf(root)).catch(() => [] as string[]))
    .filter((n) => n.endsWith(".corrections.jsonl"))
    .map((n) => n.slice(0, -".corrections.jsonl".length))
    .sort();
}

/**
 * Take lines away and add lines in one write of a repo's corrections file, in its own line
 * endings, one write at a time (the same lock Connect and Undo take). Round 46: the lock holds
 * across processes, so a line the app server appends while this command rewrites isn't lost.
 */
async function rewriteCorrections(
  root: string,
  repo: string,
  o: {
    remove?: readonly string[];
    add?: readonly string[];
    /**
     * Round 45: the lines to add, chosen under the lock from the file as it is now (a person's
     * line written meanwhile is seen); replaces `add` when given.
     */
    pick?: (now: FactCorrection[]) => string[] | Promise<string[]>;
  },
): Promise<{ removed: number; added: number; picked?: string[] }> {
  const file = correctionsFile(root, repo);
  return withSharedFileLock(file, async () => {
    const text = await readFile(file, "utf8").catch(() => "");
    const eol = /\r\n/.test(text) ? "\r\n" : "\n";
    const lines = text.split(/\r?\n/).filter((l, i, all) => l !== "" || i < all.length - 1);
    let removed = 0;
    const gone = new Set((o.remove ?? []).map((l) => l.trim()));
    const kept = lines.filter((l) => {
      if (l.trim() && gone.has(l.trim())) {
        gone.delete(l.trim());
        removed++;
        return false;
      }
      return true;
    });
    const have = new Set(kept.map((l) => l.trim()));
    const wanted = o.pick ? await o.pick(parseCorrections(text).corrections) : (o.add ?? []);
    const add = wanted.filter((l) => !have.has(l.trim()));
    const out = [...kept.filter((l) => l.trim() !== ""), ...add];
    if (!removed && !add.length) return { removed: 0, added: 0, ...(o.pick ? { picked: [] } : {}) };
    await writeFileAtomic(file, out.length ? out.join(eol) + eol : "");
    return { removed, added: add.length, ...(o.pick ? { picked: add } : {}) };
  });
}

/** A call's fact as `linksFor` meets it, from a corrections line. */
const callLikeOf = (c: FactCorrection) => ({
  kind: "call",
  id: c.fact,
  cite: { file: c.target.file, line: c.target.line, value: c.target.value },
});

/** The AI pairings that stand: the newest line for their call is the AI's. */
function standingAi(corrections: readonly FactCorrection[]): FactCorrection[] {
  return corrections.filter((c) => c.ai && linksFor(callLikeOf(c), corrections)[0] === c);
}

/** What a rule is matched against for a call: its topic, its path, else nothing a rule names. */
function subjectOfCall(f: FactOf<"call">): RuleSubject | undefined {
  if (f.callType === "event-topic" || f.callType === "mq-queue") return { topic: f.path };
  if (f.path?.startsWith("/")) return { path: f.path };
  return undefined;
}

/**
 * Whether a rule covers a call: a path prefix or host as ADR 0153's rules do, a topic by its
 * pattern. Review round 48: strictly, as core's `matchCovers` reads a rule: only the rule's own
 * placeholders match any one segment, so a call whose path starts with one (`/{base}/accounts`)
 * is in no folder a rule names.
 */
async function coversCall(match: string, f: FactOf<"call">, facts: readonly Fact[]) {
  const s = subjectOfCall(f);
  if (s?.topic) return matchCovers(match, s);
  const { ruleCoversCall } = await import("@maycombhq/scanner");
  return ruleCoversCall(match, f, facts, { strict: true });
}

/**
 * Review round 48: the calls of a repo whose target a person's answer names (the call's own
 * targets question, its group's, or an answer's rule, as the join reads them, "None of these"
 * too), by call fact id. The AI pairs none of them and no spread reaches them: a person's word
 * stands over the AI's, and the join ranks the person's answer above an AI pairing.
 */
async function answeredByPerson(
  root: string,
  repo: string,
  facts: readonly Fact[],
): Promise<Set<string>> {
  const questions = (await listQuestions(root, { step: TARGETS_STEP_ID })).questions;
  const people = questions.filter(
    (q) => q.state === "answered" && !!q.answer && !isAiBy(q.answer.by),
  );
  if (!people.length) return new Set();
  const { estateRepos, targetsFromAnswers, TARGETS_SPLIT } = await import("@maycombhq/scanner");
  // The calls a person's answered question asks about (its lines), unless the answer was "Not all
  // to one place" (each call is then still to pair)...
  const byRepo = new Map([[repo, facts]]);
  const out = new Set(
    people
      .filter(
        (q) => q.repo === repo && q.options[(q.answer!.option ?? 0) - 1]?.label !== TARGETS_SPLIT,
      )
      .flatMap((q) => callsOfQuestion(q, byRepo).map((c) => c.id)),
  );
  // ...and those the join reads a person's answer for (a group's, a rule's).
  const op = await loadOrgPack(orgPackDirOf(root));
  const repoType = estateRepos(op).find((r) => r.id === repo)?.type;
  const ai: Record<string, { runtime: string; run: string }> = {};
  const named = targetsFromAnswers(repo, facts, questions, {
    ...(repoType ? { repoType } : {}),
    ai,
  });
  for (const id of Object.keys(named)) if (!ai[id]) out.add(id);
  return out;
}

// ------------------------------------------------------------------ whether the AI decides now

/** Every repo's sample audit items of the AI kind (ADR 0148 extended, ADR 0181). */
async function aiAuditItems(root: string): Promise<AuditItemT[]> {
  const out: AuditItemT[] = [];
  for (const n of (await readdir(factsDirOf(root)).catch(() => [] as string[])).sort()) {
    if (!n.endsWith(".audit.yaml")) continue;
    const r = parseAuditFile(await readFile(join(factsDirOf(root), n), "utf8").catch(() => ""));
    if (r.ok) out.push(...r.file.items.filter((i) => i.kind === "ai"));
  }
  return out;
}

/**
 * runtime.yaml's decide and whether the AI decides now: an answer about an AI decision counts
 * whatever became of the decision since (a wrong one a person then corrected was still wrong).
 */
export async function decideState(root: string): Promise<{
  configured: DecideSettings;
  now: DecideNow;
  precision: AuditTally;
  decideIn: AiRuntime[];
}> {
  const op = await loadOrgPack(orgPackDirOf(root));
  const configured = decideOf(op.runtime);
  const precision = auditPrecision(await aiAuditItems(root)).ai;
  return {
    configured,
    now: aiPause(configured, precision),
    precision,
    decideIn: decideIn(op.runtime),
  };
}

/**
 * Ninth UX walk: the runs whose answers the AI decides from here, as runtime.yaml allows them: a
 * Copilot session Atticus starts (copilot-acp allowed, with Copilot), and a hand-off run marked
 * done (hand-off allowed). AI off: none.
 */
export function decideIn(rt: {
  ai: string;
  modes: { allowed: readonly string[] };
  assistants: { allowed: readonly string[] };
}): AiRuntime[] {
  if (rt.ai === "off") return [];
  const out: AiRuntime[] = [];
  if (rt.modes.allowed.includes("copilot-acp") && rt.assistants.allowed.includes("copilot"))
    out.push("copilot-acp");
  if (rt.modes.allowed.includes("hand-off")) out.push("hand-off");
  return out;
}

/** Why a run of this runtime decides nothing here, or undefined when it may. */
const notHere = (runtime: AiRuntime, state: { decideIn: AiRuntime[] }) =>
  runtime === "hand-off" && !state.decideIn.includes("hand-off")
    ? "runtime.yaml doesn't allow hand-off here (modes.allowed): a person confirms it"
    : undefined;

// ------------------------------------------------------------------ the citation check of a pairing

/**
 * Every line the AI named (`path:line`) is in the checkout of one of the two repos and is there,
 * with something on it; at least one line is named. The problem in words, or undefined.
 */
async function pairingCitesProblem(
  root: string,
  repos: readonly string[],
  lines: readonly string[],
): Promise<string | undefined> {
  if (!lines.length) return "it names no line it rests on";
  const dirs: string[] = [];
  for (const r of repos) {
    const d = await checkoutOf(root, r).catch(() => undefined);
    if (d) dirs.push(d);
  }
  if (!dirs.length) return "no checkout of either repo is here to check its lines";
  for (const l of lines) {
    const m = /^(.+):(\d+)$/.exec(l);
    if (!m) return `${l} isn't a path:line`;
    const rel = m[1]!.replace(/\\/g, "/").replace(/^\.\//, "");
    if (isAbsolute(rel) || rel.split("/").includes("..")) return `${l} leaves the repo`;
    let found = false;
    for (const d of dirs) {
      const file = resolve(d, rel);
      const back = relative(d, file);
      if (!back || back.startsWith("..") || isAbsolute(back)) continue;
      const ok = await stat(file).then(
        (s) => s.isFile(),
        () => false,
      );
      if (!ok) continue;
      const text = (await readFile(file, "utf8").catch(() => "")).split(/\r?\n/);
      if ((text[Number(m[2]) - 1] ?? "").trim()) found = true;
    }
    if (!found) return `${l} isn't a line with words on it in either checkout`;
  }
  return undefined;
}

// ------------------------------------------------------------------ a person's rules on file

interface LinkRule {
  match: string;
  /** The repo the rule's calls go to, or "none". */
  answer: string;
  batch: string;
}

/** The rules people spread from their corrections of a repo's pairings, newest first. */
async function linkRulesOf(root: string, repo: string): Promise<LinkRule[]> {
  return (await listBatches(root)).batches
    .filter(
      (b) =>
        b.kind === "rule" &&
        !b.undone &&
        !!b.correction?.rule &&
        b.correction.item.startsWith(`link:${repo}:`),
    )
    .map((b) => ({ match: b.correction!.rule!.match, answer: b.correction!.answer, batch: b.id }));
}

// ------------------------------------------------------------------ AI decides: pairings

export type DecidedLinks = NonNullable<Api.MatchLinksViewT["decided"]>;

/**
 * After a Match with Copilot that Atticus ran (ADR 0178 part 2, `run` its run), apply each
 * proposal that passes the citation check and meets a bar, as the AI's: a `link` line by Atticus
 * flagged with the run (`ai`), in one batch. Only a pairing with a repo's entry: an outside
 * system's stays a proposal. Undefined when deciding is off (runtime.yaml propose) or in a session.
 */
export async function decideLinks(
  root: string,
  o: {
    view: Api.LinkCandidatesViewT;
    proposals: readonly Api.MatchProposalT[];
    facts: readonly Fact[];
    run: string;
    /** Ninth UX walk: the run's runtime: a Copilot session (default) or a hand-off run. */
    runtime?: AiRuntime;
    now?: Date;
    env?: NodeJS.ProcessEnv;
  },
): Promise<DecidedLinks | undefined> {
  if (inAcpSession(o.env) || !o.proposals.length) return undefined;
  const state = await decideState(root);
  if (state.configured.links === "propose") return undefined;
  const runtime = o.runtime ?? AI_RUNTIME;
  const kept: DecidedLinks["kept"] = [];
  const off = notHere(runtime, state);
  if (off) {
    for (const p of o.proposals) kept.push({ call: p.call, api: p.api, why: off });
    return { mode: "propose", applied: [], kept };
  }
  const paused = state.now.paused?.why;
  if (state.now.links === "propose") {
    for (const p of o.proposals)
      kept.push({ call: p.call, api: p.api, why: "deciding is paused: a person confirms it" });
    return { mode: "propose", applied: [], kept, ...(paused ? { paused } : {}) };
  }
  const to = o.view.to.repo;
  if (!to) {
    for (const p of o.proposals)
      kept.push({
        call: p.call,
        api: p.api,
        why: "the AI pairs only with a repo's entry: a pairing with an outside system is a person's",
      });
    return { mode: "auto", applied: [], kept };
  }
  const at = (o.now ?? new Date()).toISOString();
  const batch = newBatchId(o.now ?? new Date());
  const rules = await linkRulesOf(root, o.view.from);
  const applied: DecidedLinks["applied"] = [];
  const lines: string[] = [];
  const items: BatchItemT[] = [];
  const calls = new Map<string, FactOf<"call">>();
  for (const p of o.proposals) {
    const call = o.view.calls.find((c) => c.fact === p.call && c.status !== "paired");
    const f = o.facts.find((x): x is FactOf<"call"> => x.id === p.call && x.kind === "call");
    const api = o.view.apis.find((a) => a.id === p.api && a.kind !== "operation");
    if (!call || !f || !api) {
      kept.push({ call: p.call, api: p.api, why: "the call or the API isn't on record as loose" });
      continue;
    }
    let ruleAgrees = false;
    let against: LinkRule | undefined;
    for (const r of rules)
      if (await coversCall(r.match, f, o.facts)) {
        if (r.answer === to) ruleAgrees = true;
        else against = r;
        break;
      }
    if (against) {
      kept.push({
        call: p.call,
        api: p.api,
        why: `a person's rule (${against.match}) says these calls go to ${against.answer}`,
      });
      continue;
    }
    const cites = await pairingCitesProblem(root, [o.view.from, to], p.lines);
    if (cites) {
      kept.push({ call: p.call, api: p.api, why: `the citation check fails: ${cites}` });
      continue;
    }
    const bar = pairingBar(call, p.api, { ruleAgrees });
    if (!bar) {
      kept.push({
        call: p.call,
        api: p.api,
        why: "the shapes don't rank that API first and no person's rule says so: a person confirms it",
      });
      continue;
    }
    const line = correctionLine(
      FactCorrection.parse({
        schemaVersion: 2,
        fact: f.id,
        target: { kind: "call", file: f.cite.file, line: f.cite.line, value: f.cite.value },
        action: "link",
        link: {
          repo: to,
          entry: api.id,
          ...(api.method ? { method: api.method } : {}),
          path: api.path,
        },
        by: AI_LINE_BY,
        at,
        ai: { runtime, run: o.run, bar },
        batch,
      }),
    );
    lines.push(line);
    items.push({ kind: "link", repo: o.view.from, fact: f.id, line });
    applied.push({ call: p.call, api: p.api, bar });
    calls.set(line, f);
  }
  if (!lines.length) return { mode: "auto", applied, kept };
  // Round 45: a person's word stands over the AI's, whenever it was written. Under the file's
  // lock, a call with any line of a person's (a pairing, or "none") since the view was read, or
  // before it, gets no AI line: the person's stays the newest. Round 48: nor does a call whose
  // targets question a person answered (its own, its group's or a rule's; "None of these" too).
  const answered = new Set<string>();
  const r = await rewriteCorrections(root, o.view.from, {
    pick: async (now) => {
      const byPerson = await answeredByPerson(root, o.view.from, o.facts);
      return lines.filter((l) => {
        const f = calls.get(l)!;
        if (linksFor(f, now).some((c) => !c.ai)) return false;
        if (byPerson.has(f.id)) {
          answered.add(l);
          return false;
        }
        return true;
      });
    },
  });
  const written = new Set(r.picked ?? []);
  for (let i = applied.length - 1; i >= 0; i--) {
    if (written.has(lines[i]!)) continue;
    kept.push({
      call: applied[i]!.call,
      api: applied[i]!.api,
      why: answered.has(lines[i]!)
        ? "a person answered where this call goes (its targets question): their word stands"
        : "a person has said where this call goes: their word stands",
    });
    applied.splice(i, 1);
    items.splice(i, 1);
  }
  if (!applied.length) return { mode: "auto", applied, kept };
  await writeBatch(root, {
    schema: 1,
    id: batch,
    kind: "ai",
    at,
    by: { kind: "ai", runtime, run: o.run },
    applied: items,
    reverted: [],
  });
  return { mode: "auto", batch, applied, kept };
}

// ------------------------------------------------------------------ AI decides: answers

export interface DecidedAnswers {
  mode: "auto" | "propose";
  batch?: string;
  applied: { id: string; option: number; bar: string }[];
  kept: { id: string; why: string }[];
  paused?: string;
}

/** A proposal file's contents, to tell which ones a session wrote. */
export async function proposalsSnapshot(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const p of await checkedProposals(root)) {
    const text = await readFile(join(root, ...p.file.split("/")), "utf8").catch(() => undefined);
    if (text !== undefined) out.set(p.id, text);
  }
  return out;
}

/** The labels a person's targets rules give a question's calls: all agree, some disagree, or none. */
async function targetRuleVerdict(
  root: string,
  q: Question,
  label: string,
  questions: readonly Question[],
): Promise<"agrees" | "against" | undefined> {
  const facts = await factsOf(root, q.repo);
  const calls = callsOfQuestion(q, new Map([[q.repo, facts]]));
  if (!calls.length) return undefined;
  const op = await loadOrgPack(orgPackDirOf(root));
  const { estateRepos, ruledTargets } = await import("@maycombhq/scanner");
  const repoType = estateRepos(op).find((r) => r.id === q.repo)?.type;
  // Round 48: strictly, as a correction's spread reads a rule.
  const ruled = ruledTargets(q.repo, facts, questions, {
    ...(repoType ? { repoType } : {}),
    strict: true,
  });
  const labels = calls.map((c) => ruled.get(c.id)?.label);
  if (labels.some((l) => l !== undefined && l !== label)) return "against";
  return labels.every((l) => l === label) ? "agrees" : undefined;
}

/**
 * Review round 48: why a person's word on the link side stands over an AI answer to this targets
 * question, or undefined. A call of the question with a person's pairing or "none" (any `link` or
 * `unlink` line not the AI's), or one a person's link rule (a correction spread) covers naming
 * another box or none: the AI's answer would join it otherwise, so it stays a proposal.
 */
async function personLinkVerdict(
  root: string,
  q: Question,
  label: string,
): Promise<string | undefined> {
  const facts = await factsOf(root, q.repo);
  const calls = callsOfQuestion(q, new Map([[q.repo, facts]]));
  if (!calls.length) return undefined;
  const corrections = await correctionsOf(root, q.repo);
  if (calls.some((c) => linksFor(c, corrections).some((l) => !l.ai)))
    return "a person said where its call goes on the canvas (a pairing or none): their word stands";
  const rules = await linkRulesOf(root, q.repo);
  for (const c of calls)
    for (const r of rules)
      if (await coversCall(r.match, c, facts)) {
        if (r.answer !== label)
          return `a person's rule (${r.match}) says these calls go to ${r.answer}`;
        break;
      }
  return undefined;
}

/**
 * After `questions propose` ran in a Copilot session Atticus started (`run`), apply each checked
 * proposal (ADR 0144: its citations checked) to an option question the AI may decide that meets a
 * bar, as the AI's answer (`by: { kind: ai, runtime, run }`), in one batch; its proposal file goes
 * (the answer keeps its lines). `ids`: only the proposals the session wrote. Undefined when off.
 */
export async function decideAnswers(
  root: string,
  o: {
    run: string;
    /** Ninth UX walk: the run's runtime: a Copilot session (default) or a hand-off run. */
    runtime?: AiRuntime;
    ids?: ReadonlySet<string>;
    now?: Date;
    env?: NodeJS.ProcessEnv;
  },
): Promise<DecidedAnswers | undefined> {
  if (inAcpSession(o.env)) return undefined;
  const state = await decideState(root);
  if (state.configured.questions === "propose") return undefined;
  const runtime = o.runtime ?? AI_RUNTIME;
  const proposals = (await checkedProposals(root)).filter(
    (p) => p.ok && p.proposal && (!o.ids || o.ids.has(p.id)),
  );
  const kept: DecidedAnswers["kept"] = [];
  const off = notHere(runtime, state);
  if (off) {
    for (const p of proposals) kept.push({ id: p.id, why: off });
    return { mode: "propose", applied: [], kept };
  }
  if (state.now.questions === "propose") {
    for (const p of proposals)
      kept.push({ id: p.id, why: "deciding is paused: a person confirms it" });
    return {
      mode: "propose",
      applied: [],
      kept,
      ...(state.now.paused ? { paused: state.now.paused.why } : {}),
    };
  }
  const at = (o.now ?? new Date()).toISOString();
  const batch = newBatchId(o.now ?? new Date());
  const everyTarget = (await listQuestions(root, { step: TARGETS_STEP_ID })).questions;
  const applied: DecidedAnswers["applied"] = [];
  const items: BatchItemT[] = [];
  for (const p of proposals) {
    const q = await readQuestion(root, p.id).catch(() => undefined);
    const option = p.proposal!.answer.option;
    if (!q) continue;
    const problem = questionAiProblem(q, option);
    if (problem) {
      kept.push({ id: p.id, why: problem });
      continue;
    }
    const label = q.options[option! - 1]!.label;
    const { TARGETS_NO_EVIDENCE } = await import("@maycombhq/scanner");
    const shapesFirst = option === 1 && !q.options[0]!.means.includes(TARGETS_NO_EVIDENCE);
    const rule = await targetRuleVerdict(root, q, label, everyTarget);
    if (rule === "against") {
      kept.push({ id: p.id, why: "a person's rule covers its calls and says otherwise" });
      continue;
    }
    const declined = await personLinkVerdict(root, q, label);
    if (declined) {
      kept.push({ id: p.id, why: declined });
      continue;
    }
    const bar = questionBar(q, option!, { shapesFirst, ruleAgrees: rule === "agrees" });
    if (!bar) {
      kept.push({
        id: p.id,
        why: "the shapes don't list that option first and no person's rule says so: a person confirms it",
      });
      continue;
    }
    const by: AiBy = { kind: "ai", runtime, run: o.run, bar };
    // Round 48: the proposal as it was, kept on the batch so Undo puts it back.
    const proposalFile = join(root, ...proposalRelOf(root, q.id).split("/"));
    const proposalText = await readFile(proposalFile, "utf8").catch(() => undefined);
    try {
      await answerQuestion(root, q.id, {
        option: option!,
        by,
        at,
        batch,
        proposal: { by: p.proposal!.by, at: p.proposal!.at, cites: p.proposal!.cites },
      });
    } catch (e) {
      if (e instanceof QuestionError) {
        kept.push({ id: p.id, why: e.message });
        continue;
      }
      // Round 46: a person answered (or edited) it while the batch worked: theirs stands.
      if (e instanceof FileChangedError) {
        kept.push({ id: p.id, why: "a person changed it meanwhile: theirs stands" });
        continue;
      }
      throw e;
    }
    // Atticus took the proposal up: its lines are in the answer now.
    await rm(proposalFile, { force: true });
    items.push({
      kind: "question",
      id: q.id,
      ...(proposalText?.trim() && proposalText.length <= 65536 ? { proposal: proposalText } : {}),
    });
    applied.push({ id: q.id, option: option!, bar });
  }
  if (items.length)
    await writeBatch(root, {
      schema: 1,
      id: batch,
      kind: "ai",
      at,
      by: { kind: "ai", runtime, run: o.run },
      applied: items,
      reverted: [],
    });
  return { mode: "auto", ...(items.length ? { batch } : {}), applied, kept };
}

// ------------------------------------------------------------------ the view

/** The AI's decisions that stand, the counts three ways, the batches and the pause (GET /api/decisions). */
export async function decisionsView(root: string): Promise<Api.DecisionsViewT> {
  const state = await decideState(root);
  const linkItems: Api.AiDecisionItemT[] = [];
  // Ninth UX walk: the pairings that stand in the corrections now (the newest line per call), the
  // AI's and people's, beside the map's counts as last applied (which Apply brings up to them).
  const lines = { byAi: 0, byPerson: 0 };
  for (const repo of await correctedRepos(root)) {
    const all = await correctionsOf(root, repo);
    for (const c of all)
      if (c.action === "link" && c.link && linksFor(callLikeOf(c), all)[0] === c) {
        if (c.ai) lines.byAi++;
        else lines.byPerson++;
      }
    for (const c of standingAi(all)) {
      linkItems.push({
        kind: "link",
        item: `link:${repo}:${c.fact}`,
        repo,
        what: `${repo}'s call ${c.target.value} (${c.target.file}:${c.target.line}) → ${[c.link!.method, c.link!.path].filter(Boolean).join(" ")} on ${c.link!.repo}`,
        decided: c.link!.entry ?? `${c.link!.method ?? ""} ${c.link!.path}`.trim(),
        call: { fact: c.fact, file: c.target.file, line: c.target.line, value: c.target.value },
        to: {
          repo: c.link!.repo!,
          ...(c.link!.entry ? { entry: c.link!.entry } : {}),
          ...(c.link!.method ? { method: c.link!.method } : {}),
          path: c.link!.path,
        },
        runtime: c.ai!.runtime,
        run: c.ai!.run,
        ...(c.ai!.bar ? { bar: c.ai!.bar } : {}),
        ...(c.batch ? { batch: c.batch } : {}),
        at: c.at,
        cites: [`${repo} ${c.target.file}:${c.target.line}`],
      });
    }
  }
  const qs = (await listQuestions(root)).questions;
  const questionItems: Api.AiDecisionItemT[] = [];
  // Ninth UX walk: a retired question is counted as retired, not as settled "from code".
  const qCounts = { fromCode: 0, byPerson: 0, byAi: 0, open: 0, retired: 0 };
  for (const q of qs) {
    if (q.state === "open") qCounts.open++;
    else if (q.state === "retired") qCounts.retired++;
    else if (q.answer && isAiBy(q.answer.by)) {
      qCounts.byAi++;
      const option = q.answer.option ?? 0;
      questionItems.push({
        kind: "question",
        item: q.id,
        repo: q.repo,
        what: `${q.question.trim()} AI: ${q.options[option - 1]?.label ?? ""}`,
        decided: q.options[option - 1]?.label ?? "",
        question: { text: q.question, option, options: q.options.map((x) => x.label) },
        runtime: q.answer.by.runtime,
        run: q.answer.by.run,
        ...(q.answer.by.bar ? { bar: q.answer.by.bar } : {}),
        ...(q.answer.batch ? { batch: q.answer.batch } : {}),
        at: q.answer.at,
        cites: (q.answer.proposal?.cites ?? []).map(
          (c) => `${c.repo ?? q.repo} ${c.file}:${c.line}`,
        ),
      });
    } else qCounts.byPerson++;
  }
  // Links as the catalog has them, by how each was joined (C1 flags): the map as last written.
  const linkCounts = { fromCode: 0, byPerson: 0, byAi: 0 };
  const { readCatalog } = await import("@maycombhq/scanner");
  // beta.23: with the metarepo's record cache, as every other read here (no parse of every file).
  const cat = await readCatalog(join(catalogDirOf(root), "generated"), { cacheRoot: root }).catch(
    () => undefined,
  );
  for (const r of cat?.records ?? []) {
    if (r.kind !== "Interface") continue;
    const flags = (r as { flags?: string[] }).flags ?? [];
    if (flags.includes(JOINED_BY_AI)) linkCounts.byAi++;
    else if (flags.includes(JOINED_BY_PERSON) || flags.includes(JOINED_BY_ANSWER))
      linkCounts.byPerson++;
    else linkCounts.fromCode++;
  }
  const { batches, problems } = await listBatches(root);
  return {
    decide: {
      configured: state.configured,
      now: { links: state.now.links, questions: state.now.questions },
      ...(state.now.paused ? { paused: state.now.paused } : {}),
      precision: state.precision,
      decideIn: state.decideIn,
    },
    links: { counts: linkCounts, items: linkItems, lines },
    questions: { counts: qCounts, items: questionItems },
    batches: batches.map((b) => batchView(root, b)),
    problems,
  };
}

function batchView(root: string, b: DecisionBatchT): Api.DecisionBatchViewT {
  return {
    id: b.id,
    kind: b.kind,
    at: b.at,
    by: answerByWords(b.by),
    ...(isAiBy(b.by) ? { run: b.by.run } : b.correction?.run ? { run: b.correction.run } : {}),
    applied: b.applied.length,
    reverted: b.reverted.length,
    ...(b.correction
      ? {
          correction: {
            item: b.correction.item,
            answer: b.correction.answer,
            ...(b.correction.rule
              ? {
                  rule: {
                    kind: b.correction.rule.kind,
                    match: b.correction.rule.match,
                    from: b.correction.rule.from,
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(b.undone ? { undone: b.undone } : {}),
    file: batchRelOf(root, b.id),
  };
}

// ------------------------------------------------------------------ a person corrects one

interface Planned {
  view: Api.SpreadItemViewT;
  write: () => Promise<void>;
  applied?: BatchItemT;
  reverted?: BatchItemT;
}

const counted = (spread: readonly Api.SpreadItemViewT[]) => ({
  applied: spread.filter((s) => s.change === "applied").length,
  confirmed: spread.filter((s) => s.change === "confirmed").length,
  replaced: spread.filter((s) => s.change === "replaced").length,
  reverted: spread.filter((s) => s.change === "reverted").length,
});

/** How many corrections of the same shape are on record (not undone), this one with them. */
async function shapeCount(root: string, shape: string): Promise<number> {
  return (
    (await listBatches(root)).batches.filter(
      (b) => b.kind === "rule" && !b.undone && b.correction?.shape === shape,
    ).length + 1
  );
}

/**
 * A person corrects one AI decision (ADR 0181, part 2): the right option, the right API, or none,
 * recorded as theirs. With `similar` (on by default), a rule derived from the correction (or the
 * one given) re-checks every AI decision and open item of the same repo it covers: each is
 * applied as the person's rule (recorded with the correction it came from), and an AI decision
 * the rule can't decide is opened again. One batch; with `preview`, nothing is written.
 */
export async function correctDecision(
  root: string,
  req: Api.CorrectDecisionRequestT,
  o: { by: string; now?: Date; env?: NodeJS.ProcessEnv },
): Promise<Api.CorrectDecisionResultT> {
  if (inAcpSession(o.env))
    throw new DecideError(
      "refused",
      "A correction is a person's: a Copilot session acts as no one (ADR 0171, round 32).",
    );
  return req.item.startsWith("link:") ? correctLink(root, req, o) : correctQuestion(root, req, o);
}

async function correctQuestion(
  root: string,
  req: Api.CorrectDecisionRequestT,
  o: { by: string; now?: Date },
): Promise<Api.CorrectDecisionResultT> {
  const q = await readQuestion(root, req.item).catch(() => undefined);
  if (!q) throw new DecideError("not-found", `There is no question ${req.item}.`);
  if (!q.answer || !isAiBy(q.answer.by))
    throw new DecideError(
      "conflict",
      `${q.id} isn't an AI decision: answer it as usual (atticus questions answer ${q.id}).`,
    );
  const aiBy = q.answer.by;
  const option = req.none
    ? q.options.findIndex((x) => x.label === HOSTS_NONE) + 1
    : (req.option ?? 0);
  if (!option || option > q.options.length)
    throw new DecideError(
      "bad",
      req.none
        ? `${q.id} has no "None of these" option: pick one of its ${q.options.length} options.`
        : `Pick one of ${q.id}'s ${q.options.length} options (from 1), or none.`,
    );
  const label = q.options[option - 1]!.label;
  const aiLabel = q.options[(q.answer.option ?? 0) - 1]?.label ?? "";
  const facts = await factsOf(root, q.repo);
  const byRepo = new Map([[q.repo, facts]]);
  const calls = callsOfQuestion(q, byRepo);
  const everyTarget = (await listQuestions(root, { step: TARGETS_STEP_ID })).questions;
  const similar = req.similar !== false;
  let rule: Api.CorrectDecisionResultT["rule"];
  let noRule: string | undefined;
  if (similar) {
    if (req.match) {
      if (!AnswerMatch.safeParse(req.match).success || ruleKindOf(req.match) === "topic")
        throw new DecideError(
          "bad",
          `${req.match} isn't a rule a targets answer takes: a path prefix (/forge/limits/**) or a host pattern (*.payments.forge.internal).`,
        );
      rule = { kind: ruleKindOf(req.match), match: req.match, derived: false };
    } else {
      const subject = calls.map((c) => subjectOfCall(c)).find((s) => s?.path);
      // The siblings: the other questions of the repo the AI answered the same way.
      const siblings = everyTarget
        .filter(
          (x) =>
            x.id !== q.id &&
            x.repo === q.repo &&
            x.state === "answered" &&
            x.answer &&
            isAiBy(x.answer.by) &&
            x.options[(x.answer.option ?? 0) - 1]?.label === aiLabel,
        )
        .flatMap((x) => callsOfQuestion(x, byRepo))
        .map((c) => subjectOfCall(c))
        .filter((s): s is RuleSubject => !!s?.path);
      if (!subject) noRule = "its calls have no path a rule can name: give one with match";
      else {
        const d = deriveMatch(subject, siblings);
        if (d.match === "/**")
          noRule =
            "the calls share no path narrower than every path: give a rule with match, or correct it alone";
        else if (!AnswerMatch.safeParse(d.match).success)
          noRule = `${d.match} isn't a rule a targets answer takes: give one with match`;
        else rule = { ...d, derived: true };
      }
    }
  }
  const at = (o.now ?? new Date()).toISOString();
  const batch = newBatchId(o.now ?? new Date());
  const plans: Planned[] = [];
  if (rule) {
    for (const x of everyTarget) {
      if (x.id === q.id || x.repo !== q.repo || x.scope.level !== "repo") continue;
      const ai = x.state === "answered" && x.answer && isAiBy(x.answer.by);
      if (x.state !== "open" && !ai) continue;
      const xc = callsOfQuestion(x, byRepo);
      if (!xc.length) continue;
      let all = true;
      for (const c of xc) if (!(await coversCall(rule.match, c, facts))) all = false;
      if (!all) continue;
      const idx = x.options.findIndex((y) => y.label === label);
      const was = ai ? x.options[(x.answer!.option ?? 0) - 1]?.label : undefined;
      const what = x.question.trim();
      if (idx >= 0) {
        const change = !ai ? "applied" : was === label ? "confirmed" : "replaced";
        plans.push({
          view: {
            item: x.id,
            repo: x.repo,
            what,
            ...(was ? { was } : {}),
            now: label,
            change,
          },
          applied: { kind: "question", id: x.id, ...(x.answer ? { before: x.answer } : {}) },
          write: async () => {
            await answerQuestion(root, x.id, {
              option: idx + 1,
              by: o.by,
              at,
              batch,
              rule: { from: q.id, match: rule.match },
            });
          },
        });
      } else if (ai)
        plans.push({
          view: { item: x.id, repo: x.repo, what, ...(was ? { was } : {}), change: "reverted" },
          reverted: { kind: "question", id: x.id, before: x.answer! },
          write: async () => {
            const { answer: _a, ...rest } = x;
            await writeQuestion(root, Question.parse({ ...rest, state: "open" }));
          },
        });
    }
  }
  const spread = plans.map((p) => p.view);
  const op = await loadOrgPack(orgPackDirOf(root));
  const { estateRepos } = await import("@maycombhq/scanner");
  const repoType = estateRepos(op).find((r) => r.id === q.repo)?.type;
  const shape = `question:${repoType ?? q.repo}:${rule?.match ?? calls[0]?.path ?? q.id}`;
  const n = await shapeCount(root, shape);
  const files = [`${questionsRelOf(root)}/`, ...(req.preview ? [] : [batchRelOf(root, batch)])];
  const result: Api.CorrectDecisionResultT = {
    written: !req.preview,
    ...(req.preview ? {} : { batch }),
    item: q.id,
    answer: label,
    ...(rule ? { rule } : {}),
    ...(similar && !rule && noRule ? { noRule } : {}),
    spread,
    counts: counted(spread),
    ...(n >= RULE_AFTER_CORRECTIONS && repoType
      ? {
          makeRule: {
            corrections: n,
            shape,
            repo: q.repo,
            command: `atticus rules draft --repo ${q.repo} --about "calls under ${rule?.match ?? calls[0]?.path ?? "these paths"} go to ${label}"`,
          },
        }
      : {}),
    files: [...new Set(files)],
    verify: [`atticus verify ${q.repo} --write`],
    commit: `git add ${questionsRelOf(root)}/ ${batchRelOf(root, batch).replace(/\/[^/]+$/, "/")}\ngit commit -m "${safeMessage(`${q.repo}: an AI answer corrected${rule ? `, and spread by ${rule.match}` : ""}`)}"`,
  };
  if (req.preview) return result;
  const before = q.answer;
  try {
    await answerQuestion(root, q.id, {
      option,
      by: o.by,
      at,
      batch,
      ...(rule ? { match: rule.match } : {}),
    });
  } catch (e) {
    if (e instanceof QuestionError) throw new DecideError("bad", e.message);
    throw e;
  }
  for (const p of plans) await p.write();
  await writeBatch(root, {
    schema: 1,
    id: batch,
    kind: "rule",
    at,
    by: o.by,
    correction: {
      item: q.id,
      answer: label,
      ...(rule ? { rule: { from: q.id, match: rule.match, kind: rule.kind } } : {}),
      run: aiBy.run,
      shape,
    },
    applied: [
      { kind: "question", id: q.id, before },
      ...plans.flatMap((p) => (p.applied ? [p.applied] : [])),
    ],
    reverted: plans.flatMap((p) => (p.reverted ? [p.reverted] : [])),
  });
  return result;
}

/** `link:<repo>:<call fact id>`. */
function parseLinkItem(item: string): { repo: string; fact: string } {
  const m = /^link:([A-Za-z0-9._-]{1,200}):(.+)$/.exec(item);
  if (!m)
    throw new DecideError("bad", `${item} isn't link:<repo>:<call fact id> or a question id.`);
  return { repo: m[1]!, fact: m[2]! };
}

async function correctLink(
  root: string,
  req: Api.CorrectDecisionRequestT,
  o: { by: string; now?: Date },
): Promise<Api.CorrectDecisionResultT> {
  const { repo, fact } = parseLinkItem(req.item);
  const facts = await factsOf(root, repo);
  const f = facts.find((x): x is FactOf<"call"> => x.id === fact && x.kind === "call");
  if (!f) throw new DecideError("not-found", `${repo} has no call ${fact} on record.`);
  const corrections = await correctionsOf(root, repo);
  const standing = linksFor(f, corrections)[0];
  if (!standing?.ai || !standing.link?.repo)
    throw new DecideError(
      "conflict",
      `${repo}'s call ${fact} isn't paired by AI: correct it on the canvas (Connect to…) as usual.`,
    );
  const aiRepo = standing.link.repo;
  const none = req.none === true;
  if (!none && (!req.api || !req.repo))
    throw new DecideError("bad", "Say the right API and its repo ({ api, repo }), or none.");
  const target = none ? undefined : req.repo!;
  let entry: FactOf<"entry"> | undefined;
  if (target) {
    entry = (await factsOf(root, target)).find(
      (x): x is FactOf<"entry"> => x.id === req.api && x.kind === "entry",
    );
    if (!entry) throw new DecideError("not-found", `${target} has no API ${req.api} on record.`);
  }
  const answer = target ?? "none";
  const similar = req.similar !== false;
  let rule: Api.CorrectDecisionResultT["rule"];
  let noRule: string | undefined;
  const standingAll = standingAi(corrections);
  if (similar) {
    if (req.match)
      rule = { kind: ruleKindOf(req.match, subjectOfCall(f)), match: req.match, derived: false };
    else {
      const subject = subjectOfCall(f);
      const siblings = standingAll
        .filter((c) => c !== standing && c.link?.repo === aiRepo)
        .map((c) => facts.find((x): x is FactOf<"call"> => x.id === c.fact && x.kind === "call"))
        .flatMap((x) => (x ? [subjectOfCall(x)] : []))
        .filter((s): s is RuleSubject => !!s);
      if (!subject)
        noRule = "the call's path is a name, not a path a rule can name: give one with match";
      else {
        const d = deriveMatch(subject, siblings);
        if (d.match === "/**")
          noRule =
            "the calls share no path narrower than every path: give a rule with match, or correct it alone";
        else rule = { ...d, derived: true };
      }
    }
  }
  const at = (o.now ?? new Date()).toISOString();
  const batch = newBatchId(o.now ?? new Date());
  const lineFor = (
    c: FactOf<"call">,
    api?: { id: string; method?: string; path: string },
    own?: boolean,
  ) =>
    correctionLine(
      FactCorrection.parse({
        schemaVersion: 2,
        fact: c.id,
        target: { kind: "call", file: c.cite.file, line: c.cite.line, value: c.cite.value },
        action: api ? "link" : "unlink",
        ...(api
          ? {
              link: {
                repo: target,
                entry: api.id,
                ...(api.method ? { method: api.method.toUpperCase() } : {}),
                path: api.path,
              },
            }
          : {}),
        by: o.by,
        at,
        batch,
        ...(own && rule ? { match: rule.match } : {}),
        ...(!own && rule ? { rule: { from: req.item, match: rule.match } } : {}),
      }),
    );
  const ownLine = lineFor(
    f,
    entry
      ? { id: entry.id, ...(entry.method ? { method: entry.method } : {}), path: entry.path }
      : undefined,
    true,
  );
  // The spread: every other call of the repo the rule covers that the AI paired, or that is loose.
  const spread: Api.SpreadItemViewT[] = [];
  const add: string[] = [ownLine];
  const remove: string[] = [];
  const appliedItems: BatchItemT[] = [{ kind: "link", repo, fact: f.id, line: ownLine }];
  const revertedItems: BatchItemT[] = [];
  if (rule) {
    const { candidatesOf, settingsOf } = await import("./ui-api-links.js");
    const box = { repo: target ?? aiRepo };
    const cands =
      box.repo !== repo ? await candidatesOf(root, repo, box).catch(() => undefined) : undefined;
    const loose = new Set(
      (cands?.view.calls ?? []).filter((c) => c.status !== "paired").map((c) => c.fact),
    );
    const apis = (cands?.view.apis ?? []).filter((a) => a.kind !== "operation");
    const settings = settingsOf(facts);
    const bestOf = (c: FactOf<"call">) => {
      if (!target || !apis.length) return undefined;
      const s = linkCandidates({
        from: repo,
        facts: [c],
        join: { joins: [], asks: [], misses: [], outside: [], left: [] },
        apis,
        pairs: {},
        to: { repo: target },
        settings,
      }).calls[0]?.suggestion?.api;
      return s ? apis.find((a) => a.id === s) : undefined;
    };
    const words = (c: FactOf<"call">) =>
      `${repo}'s call ${[c.method?.toUpperCase(), c.path].filter(Boolean).join(" ")} (${c.cite.file}:${c.cite.line})`;
    // Round 48: a call whose targets question a person answered is theirs too.
    const byPerson = await answeredByPerson(root, repo, facts);
    for (const c of facts) {
      if (c.kind !== "call" || c.id === f.id) continue;
      if (!(await coversCall(rule.match, c, facts))) continue;
      const st = linksFor(c, corrections)[0];
      if (st && !st.ai) continue; // a person's word stands
      if (byPerson.has(c.id)) continue; // a person answered where it goes
      const item = `link:${repo}:${c.id}`;
      const was = st?.ai
        ? `${st.link!.repo} ${[st.link!.method, st.link!.path].filter(Boolean).join(" ")}`
        : undefined;
      if (!st && !loose.has(c.id)) continue; // joined from the code: not the AI's, not open
      if (!target) {
        const l = lineFor(c);
        add.push(l);
        appliedItems.push({ kind: "link", repo, fact: c.id, line: l });
        spread.push({
          item,
          repo,
          what: words(c),
          ...(was ? { was } : {}),
          now: "none",
          change: st ? "replaced" : "applied",
        });
        continue;
      }
      const same = st?.ai && st.link?.repo === target;
      const api = same
        ? {
            id: st!.link!.entry ?? "",
            ...(st!.link!.method ? { method: st!.link!.method } : {}),
            path: st!.link!.path,
          }
        : bestOf(c);
      if (api && api.id) {
        const l = lineFor(c, api);
        add.push(l);
        appliedItems.push({ kind: "link", repo, fact: c.id, line: l });
        spread.push({
          item,
          repo,
          what: words(c),
          ...(was ? { was } : {}),
          now: `${target} ${[api.method, api.path].filter(Boolean).join(" ")}`,
          change: !st ? "applied" : same ? "confirmed" : "replaced",
        });
      } else if (st?.ai) {
        const l = correctionLine(st);
        remove.push(l);
        revertedItems.push({ kind: "link", repo, fact: c.id, line: l });
        spread.push({ item, repo, what: words(c), ...(was ? { was } : {}), change: "reverted" });
      }
    }
  }
  const op = await loadOrgPack(orgPackDirOf(root));
  const { estateRepos } = await import("@maycombhq/scanner");
  const repoType = estateRepos(op).find((r) => r.id === repo)?.type;
  const shape = `link:${repoType ?? repo}:${rule?.match ?? f.path}`;
  const n = await shapeCount(root, shape);
  const rel = correctionsRel(root, repo);
  const result: Api.CorrectDecisionResultT = {
    written: !req.preview,
    ...(req.preview ? {} : { batch }),
    item: req.item,
    answer: entry
      ? `${target} ${[entry.method?.toUpperCase(), entry.path].filter(Boolean).join(" ")}`
      : "none",
    ...(rule ? { rule } : {}),
    ...(similar && !rule && noRule ? { noRule } : {}),
    spread,
    counts: counted(spread),
    ...(n >= RULE_AFTER_CORRECTIONS && repoType && entry
      ? { makeRule: { corrections: n, shape, repo, line: ownLine } }
      : {}),
    files: [rel, ...(req.preview ? [] : [batchRelOf(root, batch)])],
    verify: [`atticus verify ${repo} --write`],
    commit: `git add ${rel} ${batchRelOf(root, batch).replace(/\/[^/]+$/, "/")}\ngit commit -m "${safeMessage(`${repo}: an AI pairing corrected${rule ? `, and spread by ${rule.match}` : ""}`)}"`,
  };
  if (req.preview) return result;
  await rewriteCorrections(root, repo, { remove, add });
  await writeBatch(root, {
    schema: 1,
    id: batch,
    kind: "rule",
    at,
    by: o.by,
    correction: {
      item: req.item,
      answer,
      ...(rule ? { rule: { from: req.item, match: rule.match, kind: rule.kind as RuleKind } } : {}),
      run: standing.ai.run,
      shape,
    },
    applied: appliedItems,
    reverted: revertedItems,
  });
  return result;
}

// ------------------------------------------------------------------ Undo

/**
 * Undo a batch (ADR 0181): take away exactly the lines it appended and the answers it wrote (each
 * only while it is still as the batch left it), and put back the AI lines and answers it took
 * away. What changed since is left as it is and said. The record says who undid it and when.
 */
/** Whether any line or answer the batch applied is still as the batch left it. */
async function batchStands(root: string, b: DecisionBatchT): Promise<boolean> {
  for (const i of b.applied) {
    if (i.kind === "question") {
      const q = await readQuestion(root, i.id).catch(() => undefined);
      if (q?.answer?.batch === b.id) return true;
    } else {
      const text = await readFile(correctionsFile(root, i.repo), "utf8").catch(() => "");
      if (text.split(/\r?\n/).some((l) => l.trim() === i.line.trim())) return true;
    }
  }
  return false;
}

/**
 * Review round 48: Undo of an AI answer puts its proposal back at proposals/questions/<id>.yaml:
 * the file's text as the batch kept it, else (a batch from before) rebuilt from the answer's
 * option and the proposal's lines the answer kept. Never over a proposal on file now. The folder,
 * relative to the root, when one was written.
 */
async function restoreProposal(
  root: string,
  q: Question,
  text: string | undefined,
): Promise<string | undefined> {
  const rel = proposalRelOf(root, q.id);
  const file = join(root, ...rel.split("/"));
  if (
    await stat(file).then(
      () => true,
      () => false,
    )
  )
    return undefined;
  let out = text;
  const p = q.answer?.proposal;
  if (!out && p && q.answer?.option && p.cites.length) {
    const { stringify } = await import("yaml");
    out = stringify({
      schemaVersion: 1,
      answer: { option: q.answer.option },
      why: `Put back on Undo of the AI's answer: ${p.by} proposed it, citing the lines below.`,
      cites: p.cites,
      by: p.by,
      at: p.at,
    });
  }
  if (!out) return undefined;
  await mkdir(dirname(file), { recursive: true });
  await writeFileAtomic(file, out);
  return rel.replace(/[^/]+$/, "");
}

export async function undoBatch(
  root: string,
  id: string,
  o: { by: string; now?: Date; env?: NodeJS.ProcessEnv },
): Promise<Api.UndoBatchResultT> {
  if (inAcpSession(o.env))
    throw new DecideError("refused", "Undo is a person's: a Copilot session acts as no one.");
  const b = await readBatch(root, id);
  if (!b) throw new DecideError("not-found", `There is no batch ${id}.`);
  if (b.undone)
    throw new DecideError(
      "conflict",
      `${id} was undone by ${b.undone.by} on ${b.undone.at.slice(0, 10)}.`,
    );
  let removed = 0;
  let restored = 0;
  const skipped: string[] = [];
  const files = new Set<string>();
  const repos = new Set<string>();
  // Lines, per repo, in one write each.
  const byRepo = new Map<string, { remove: string[]; add: string[] }>();
  const of = (r: string) => {
    const x = byRepo.get(r) ?? { remove: [], add: [] };
    byRepo.set(r, x);
    return x;
  };
  // Final review: what was another batch's comes back only while that batch stands; an undone
  // batch's answer or line is never put back (it would stand as the AI's with no Undo left).
  const undoneBatches = new Map<string, boolean>();
  const isUndone = async (batch: string | undefined) => {
    if (!batch || batch === b.id) return false;
    if (!undoneBatches.has(batch))
      undoneBatches.set(batch, !!(await readBatch(root, batch).catch(() => undefined))?.undone);
    return undoneBatches.get(batch)!;
  };
  const batchOfLine = (line: string) => {
    try {
      return (JSON.parse(line) as { batch?: string }).batch;
    } catch {
      return undefined;
    }
  };
  // Nothing of the batch stands any more: say so, and leave it to be undone later.
  const stands = await batchStands(root, b);
  if (!stands)
    throw new DecideError(
      "conflict",
      `Nothing of ${id} stands now: each of its lines and answers was changed since, so there is nothing to undo.`,
    );
  for (const i of b.applied) if (i.kind === "link") of(i.repo).remove.push(i.line);
  for (const i of b.reverted)
    if (i.kind === "link") {
      if (await isUndone(batchOfLine(i.line))) {
        skipped.push(`a line of an undone batch in ${correctionsRel(root, i.repo)}: not put back`);
        continue;
      }
      of(i.repo).add.push(i.line);
    }
  for (const [repo, x] of byRepo) {
    const r = await rewriteCorrections(root, repo, x);
    removed += r.removed;
    restored += r.added;
    if (r.removed < x.remove.length)
      skipped.push(
        `${x.remove.length - r.removed} of its lines in ${correctionsRel(root, repo)} were gone already`,
      );
    files.add(correctionsRel(root, repo));
    repos.add(repo);
  }
  // Answers: put back what each had, while it is still the batch's.
  for (const i of [...b.applied].reverse()) {
    if (i.kind !== "question") continue;
    const q = await readQuestion(root, i.id).catch(() => undefined);
    if (!q || q.answer?.batch !== b.id) {
      skipped.push(`${i.id} was answered again since: left as it is`);
      continue;
    }
    // Round 48: an AI answer taken up from a proposal gives the proposal back (never over a newer one).
    if (b.kind === "ai" && isAiBy(q.answer.by)) {
      const restoredProposal = await restoreProposal(root, q, i.proposal);
      if (restoredProposal) files.add(restoredProposal);
    }
    const { answer: _a, ...rest } = q;
    const before = i.before && !(await isUndone(i.before.batch)) ? i.before : undefined;
    if (i.before && !before)
      skipped.push(`${i.id}: its earlier answer was an undone batch's, so it is open`);
    await writeQuestion(
      root,
      Question.parse(
        before ? { ...rest, state: "answered", answer: before } : { ...rest, state: "open" },
      ),
    );
    removed++;
    repos.add(q.repo);
  }
  for (const i of b.reverted) {
    if (i.kind !== "question" || !i.before) continue;
    const q = await readQuestion(root, i.id).catch(() => undefined);
    if (!q || q.state !== "open") {
      skipped.push(`${i.id} was answered since: the AI's answer isn't put back`);
      continue;
    }
    if (await isUndone(i.before.batch)) {
      skipped.push(`${i.id}: the AI's answer was an undone batch's, so it stays open`);
      continue;
    }
    await writeQuestion(root, Question.parse({ ...q, state: "answered", answer: i.before }));
    restored++;
    repos.add(q.repo);
  }
  if (b.applied.some((i) => i.kind === "question") || b.reverted.some((i) => i.kind === "question"))
    files.add(`${questionsRelOf(root)}/`);
  const at = (o.now ?? new Date()).toISOString();
  const file = await writeBatch(root, { ...b, undone: { by: o.by, at } });
  files.add(file);
  return {
    batch: b.id,
    removed,
    restored,
    skipped,
    files: [...files],
    verify: [...repos].sort().map((r) => `atticus verify ${r} --write`),
    commit: `git add ${[...files].join(" ")}\ngit commit -m "${safeMessage(`Undo ${b.id}`)}"`,
  };
}

// ------------------------------------------------------------------ the sample audit's AI kind

/**
 * The AI's decisions that stand for a repo, as audit items (ADR 0148 extended to the AI kind):
 * its pairings (`ai:link:<call fact id>`) and its answers (`ai:question:<id>`), each with the
 * lines it rests on and what it decided, so an answer stops counting once that changes.
 */
export async function aiAuditCandidates(root: string, repo: string): Promise<AuditItemT[]> {
  const out: AuditItemT[] = [];
  for (const c of standingAi(await correctionsOf(root, repo)))
    out.push({
      id: `ai:link:${c.fact}`,
      kind: "ai",
      of: "link",
      claim: `AI paired ${c.target.value} with ${[c.link!.method, c.link!.path].filter(Boolean).join(" ")} on ${c.link!.repo}`,
      cites: [`${repo} ${c.target.file}:${c.target.line}`],
      fact: c.fact,
      to: c.link!.repo!,
      decided: c.link!.entry ?? c.link!.path,
      run: c.ai!.run,
    });
  for (const q of (await listQuestions(root, { state: "answered" })).questions) {
    if (q.repo !== repo || !q.answer || !isAiBy(q.answer.by)) continue;
    const label = q.options[(q.answer.option ?? 0) - 1]?.label ?? "";
    const cites = (q.answer.proposal?.cites ?? []).map(
      (c) => `${c.repo ?? q.repo} ${c.file}:${c.line}`,
    );
    out.push({
      id: `ai:question:${q.id}`,
      kind: "ai",
      of: "question",
      claim: `AI answered "${q.question.trim()}" with ${label}`,
      cites: cites.length ? cites : q.evidence.map((e) => `${q.repo} ${e}`),
      decided: label,
      run: q.answer.by.run,
    });
  }
  return out;
}
