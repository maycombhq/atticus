import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { parseFacts } from "./facts.js";
import { changesDirOf, factsDirOf, factsFileOf } from "./metarepo.js";
import { callsOfQuestion, isLinkQuestion } from "./repo-reads.js";
import { HOSTS_STEP } from "./host-questions.js";
import { listQuestions } from "./questions.js";
import type { Fact } from "./schema/facts.js";
import type { Question } from "./schema/question.js";

/**
 * Ask first what a change needs (ADR 0140, Q3). The questions a change in flight rests on come
 * first: its own (filed under its id) and those the newest critic round of each of its gates
 * cites (the change-links-known findings, P4). Then by how many calls each answer joins: a
 * targets question's calls (a group's every call, Q1), a hosts question's every call to its
 * host. A question that joins no call (a survey's, a stage's) comes after the link questions.
 * Files only: the changes, their review rounds and the facts.
 */

/** The states a change is no longer in flight in. */
const LANDED = new Set(["released", "archived", "post-release-review"]);
const QUESTION_FILE = /(?:^|\/)questions\/(q-[0-9a-f]{12})\.yaml$/;
/** The finding states a person hasn't set aside (dismissed, waived, applied). */
const LIVE = new Set(["open", "asked"]);

const text = (p: string) => readFile(p, "utf8").catch(() => undefined);
const dirs = (p: string) =>
  readdir(p, { withFileTypes: true }).then(
    (d) => d.filter((x) => x.isDirectory()).map((x) => x.name),
    () => [] as string[],
  );

/** The changes in flight: their ids, sorted. */
export async function changesInFlight(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const id of (await dirs(changesDirOf(root))).sort()) {
    const raw = await text(join(changesDirOf(root), id, "change.yaml"));
    if (raw === undefined) continue;
    let state: unknown;
    try {
      state = (parse(raw) as { state?: unknown } | null)?.state;
    } catch {
      continue;
    }
    if (typeof state === "string" && !LANDED.has(state)) out.push(id);
  }
  return out;
}

/** The question files a finding file cites as evidence, when a person hasn't set the finding aside. */
function citedQuestions(raw: string): string[] {
  let f: { state?: unknown; evidence?: unknown } | null;
  try {
    f = parse(raw) as typeof f;
  } catch {
    return [];
  }
  if (typeof f?.state === "string" && !LIVE.has(f.state)) return [];
  if (!Array.isArray(f?.evidence)) return [];
  return f.evidence.flatMap((e) => {
    const p = (e as { path?: unknown } | null)?.path;
    const m = typeof p === "string" ? QUESTION_FILE.exec(p) : null;
    return m ? [m[1]!] : [];
  });
}

/**
 * The questions each change in flight rests on, by question id: the changes, sorted. A change's
 * own questions are found by `questionWeights` (their repo is the change's id); this reads the
 * question files the newest round of each of its gates cites.
 */
export async function questionsInFlight(root: string): Promise<Map<string, string[]>> {
  const out = new Map<string, Set<string>>();
  const add = (q: string, c: string) => out.set(q, (out.get(q) ?? new Set()).add(c));
  for (const id of await changesInFlight(root)) {
    // A change's own questions rest on it whether or not a round cites them.
    for (const q of await ownQuestions(root, id)) add(q, id);
    const review = join(changesDirOf(root), id, "review");
    for (const gate of await dirs(review)) {
      const rounds = (await dirs(join(review, gate)))
        .filter((r) => /^\d+$/.test(r))
        .map(Number)
        .sort((a, b) => a - b);
      const last = rounds.at(-1);
      if (last === undefined) continue;
      const dir = join(review, gate, String(last));
      const files = await readdir(dir).catch(() => [] as string[]);
      for (const f of files.filter((x) => /\.ya?ml$/.test(x)).sort()) {
        const raw = await text(join(dir, f));
        if (raw !== undefined) for (const q of citedQuestions(raw)) add(q, id);
      }
    }
  }
  return new Map([...out].map(([q, cs]) => [q, [...cs].sort()]));
}

/** The question files filed under a change's id (its stages' questions). */
async function ownQuestions(root: string, change: string): Promise<string[]> {
  return (await listQuestions(root, { repo: change })).questions.map((q) => q.id);
}

/** Why a question is where it is in the list. */
export interface QuestionWeight {
  /** The changes in flight that rest on it, sorted; empty when none. */
  restsOn: string[];
  /** How many calls its answer joins; 0 for a question that isn't about a link. */
  joins: number;
}

/** Every repo's facts, read once; only the repos asked for unless a hosts question needs all. */
async function factsOf(root: string, repos: Set<string>, all: boolean) {
  const out = new Map<string, Fact[]>();
  const names = await readdir(factsDirOf(root)).catch(() => [] as string[]);
  for (const n of names) {
    const of = factsFileOf(n);
    if (!of?.facts || (!all && !repos.has(of.repo))) continue;
    const raw = await text(join(factsDirOf(root), n));
    const parsed = raw?.trim() ? parseFacts(raw) : undefined;
    if (parsed?.ok) out.set(of.repo, parsed.facts);
  }
  return out;
}

/** The weight of each question (see `QuestionWeight`), by id. */
export async function questionWeights(
  root: string,
  questions: readonly Question[],
): Promise<Map<string, QuestionWeight>> {
  const inFlight = await questionsInFlight(root);
  const links = questions.filter(isLinkQuestion);
  const facts = links.length
    ? await factsOf(
        root,
        new Set(links.map((q) => q.repo)),
        links.some((q) => q.askedBy.step === HOSTS_STEP),
      )
    : new Map<string, Fact[]>();
  const out = new Map<string, QuestionWeight>();
  for (const q of questions) {
    let joins = 0;
    if (isLinkQuestion(q)) {
      const calls = callsOfQuestion(q, facts).length;
      // No facts to count from: a targets question cites one line per call; a host is one at least.
      joins = calls || (q.askedBy.step === HOSTS_STEP ? 1 : new Set(q.evidence).size);
    }
    out.set(q.id, { restsOn: inFlight.get(q.id) ?? [], joins });
  }
  return out;
}

/**
 * The questions in the order to ask them: what a change in flight rests on first, then the
 * answers that join the most calls; otherwise as they came (oldest first, from listQuestions).
 */
export function orderQuestions<Q extends Pick<Question, "id">>(
  questions: readonly Q[],
  weights: ReadonlyMap<string, QuestionWeight>,
): Q[] {
  const w = (q: Q) => weights.get(q.id) ?? { restsOn: [], joins: 0 };
  return questions
    .map((q, i) => ({ q, i }))
    .sort(
      (a, b) =>
        Number(w(b.q).restsOn.length > 0) - Number(w(a.q).restsOn.length > 0) ||
        w(b.q).joins - w(a.q).joins ||
        a.i - b.i,
    )
    .map((x) => x.q);
}
