import { createHash } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { FileChangedError, writeFileAtomic, writeFileIfUnchanged } from "./fs.js";
import {
  addManifestHost,
  addOutsideSystem,
  addProfileSystem,
  hostOfQuestion,
  joinHostOfQuestion,
  outsideSystemOfJoinHost,
  HOSTS_NONE,
  HOSTS_STEP,
  ignoredAnswer,
  ignoreOption,
  ignoreText,
  IGNORE_REASON_MAX,
  JOIN_IGNORE_LABEL,
  JOIN_STEPS,
  namesKnownTarget,
  outsideBoundaryOf,
  wordsNameNothing,
  PICKER_LABELS,
  TARGETS_SPLIT_LABEL,
  TARGETS_STEP_ID,
} from "./host-questions.js";
import { fileJudgments, judgmentKey, makeJudgment, type JudgmentStore } from "./judgments.js";
import { isAdopted, questionsDirOf, questionsRelOf } from "./metarepo.js";
import { roleOfAsks, roleOfQuestion, roleOfStep } from "./question-roles.js";
import { keptParse } from "./kept-files.js";
import { mapAtOnce } from "./record-cache.js";
import { questionAiProblem } from "./ai-decisions.js";
import { hostMatches } from "./schema/workspace.js";
import {
  AnswerMatch,
  isPathMatch,
  Question,
  QUESTION_SCHEMA_VERSION,
  QuestionId,
  answerByWords,
  isAiBy,
  type AiBy,
  type AppliedRule,
  type QuestionDraft,
  type QuestionRole,
  type QuestionScopeLevel,
  type QuestionState,
} from "./schema/question.js";
import { cmpText } from "./identity.js";

/**
 * Questions as files (ADR 0078): raise, list, read and answer questions/<id>.yaml. The CLI
 * (atticus questions) and the local API (/api/questions) both call these, so the app and the
 * terminal write the same file.
 */

/** A refusal in words a person reads; `code` says which. */
export class QuestionError extends Error {
  constructor(
    readonly code: "not-found" | "bad-answer" | "retired",
    message: string,
  ) {
    super(message);
  }
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s?.!]+$/, "");

/**
 * The stable id of a question: a fingerprint of the step that asks, the repo, the question
 * (spacing and case aside) and the evidence (in any order). The same question asked again by a
 * rerun has the same id, so it is never asked twice.
 */
export function questionId(o: {
  step: string;
  repo: string;
  question: string;
  evidence: string[];
}): string {
  const key = [o.step, o.repo, norm(o.question), ...[...o.evidence].sort()].join("\n");
  return `q-${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
}

/** The step a critic knowledge gap's owner question is asked by (ninth UX walk). */
export const ASKED_GAP_STEP = "critic-ask";

/**
 * Ninth UX walk: the id of the owner question a person's Ask raises for a critic knowledge gap.
 * It is a fingerprint of the change and the gap's own fingerprint (its rule, artifact, record and
 * summary), so the same gap carried to a later round or gate finds the same question.
 */
export function askedGapQuestionId(
  change: string,
  f: { rule: string; artifact: string; locator: { record?: string | undefined }; summary: string },
): string {
  const key = [ASKED_GAP_STEP, change, f.rule, f.artifact, f.locator.record ?? "", f.summary].join(
    "\n",
  );
  return `q-${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
}

/** Who asked: the step, the repo, the command as typed, the command that reads the answer. */
export interface AskedBy {
  step: string;
  repo: string;
  command: string;
  rerun: string;
  run?: string;
  at: string;
}

/** An open question from what an AI step raised. */
export function questionFromDraft(d: QuestionDraft, by: AskedBy): Question {
  // ADR 0191: by what it asks, when the draft tags it; else the raising stage's role.
  const stage = roleOfStep(by.step, by.rerun);
  const role = d.role ?? (d.asks ? roleOfAsks(d.asks, stage) : stage);
  return Question.parse({
    schemaVersion: QUESTION_SCHEMA_VERSION,
    id: questionId({ step: by.step, repo: by.repo, question: d.question, evidence: d.evidence }),
    askedBy: {
      step: by.step,
      command: by.command,
      ...(by.run ? { run: by.run } : {}),
      at: by.at,
    },
    repo: by.repo,
    question: d.question,
    options: d.options,
    evidence: d.evidence,
    scope:
      d.scope === "repo-type"
        ? { level: "repo-type", id: d.repoType! }
        : { level: "repo", id: by.repo },
    // ADR 0181 part 4: the role that owns it, the question's own or its stage's.
    ...(role ? { role } : {}),
    ...(d.asks ? { asks: d.asks } : {}),
    state: "open",
    rerun: by.rerun,
  });
}

/**
 * ADR 0191: a person re-routes a question to another role (a business question the architect was
 * given goes to the product owner). `role` becomes the new one and `routed` says from which, by
 * whom and when; what it asks follows the role unless the AI tagged it. Open or answered alike:
 * the answer, if any, stays. Written only if the file is as it was read.
 */
export async function routeQuestion(
  root: string,
  id: string,
  o: { role: QuestionRole; by: string; at: string },
): Promise<Question> {
  const read = await readQuestionText(root, id);
  if (!read) throw new QuestionError("not-found", `There is no question ${id}.`);
  const q = read.q;
  if (q.state === "retired")
    throw new QuestionError("retired", `Question ${id} is retired; there is no one to ask.`);
  const from = roleOfQuestion(q);
  if (from === o.role) return q;
  const next = Question.parse({
    ...q,
    role: o.role,
    routed: { ...(from ? { from } : {}), by: o.by.replace(/^@/, ""), at: o.at },
  });
  await write(root, next, read);
  return next;
}

const fileOf = (root: string, id: string) => join(questionsDirOf(root), `${id}.yaml`);

/**
 * The text of a question's file, exactly as Atticus writes it: the same question always gives the
 * same text (beta.25: a caller can tell its own write from another writer's).
 */
export function questionFileText(q: Question): string {
  return `# A question from ${q.askedBy.command} (ADR 0078). Answer it with atticus questions answer ${q.id}, or in the app.\n${stringify(Question.parse(q))}`;
}

/**
 * Write a question's file, and return the text written. With `before` (the text it was read as),
 * only when the file still holds that text: a change made meanwhile (a person's answer in the
 * app, another command) is never overwritten, and FileChangedError says so instead (round 46).
 */
async function write(root: string, q: Question, before?: { text: string }): Promise<string> {
  await mkdir(questionsDirOf(root), { recursive: true });
  const text = questionFileText(q);
  if (before) await writeFileIfUnchanged(fileOf(root, q.id), before.text, text);
  else await writeFileAtomic(fileOf(root, q.id), text);
  return text;
}

/** A question and the text it was read from, for a write back that checks nothing changed. */
async function readQuestionText(
  root: string,
  id: string,
): Promise<{ q: Question; text: string } | undefined> {
  if (!QuestionId.safeParse(id).success) return undefined;
  let text: string;
  try {
    text = await readFile(fileOf(root, id), "utf8");
  } catch {
    return undefined;
  }
  const data: unknown = parse(text);
  const newer = newerQuestion(data);
  if (newer) throw new Error(`${questionsRelOf(root)}/${id}.yaml was ${newer}`);
  return { q: Question.parse(data), text };
}

/**
 * Round 49: what to say of a question file at a version above this Atticus's, rather than the
 * schema's raw issues; undefined for any other file.
 */
function newerQuestion(data: unknown): string | undefined {
  const v = (data as { schemaVersion?: unknown } | null)?.schemaVersion;
  return typeof v === "number" && Number.isInteger(v) && v > QUESTION_SCHEMA_VERSION
    ? `written by a newer Atticus (question version ${v}); install it to read this question`
    : undefined;
}

/**
 * Write a question as it is (a person's comment on a critic finding, ADR 0124 addendum D-app,
 * is a question they answered as they asked it). Every other writer goes through
 * `raiseQuestions` and `answerQuestion`.
 */
export async function writeQuestion(root: string, q: Question): Promise<void> {
  await write(root, q);
}

/** Read one question, or undefined when there is no such file. Throws on a file that isn't valid. */
export async function readQuestion(root: string, id: string): Promise<Question | undefined> {
  return (await readQuestionText(root, id))?.q;
}

export interface QuestionList {
  questions: Question[];
  /** Files in questions/ that aren't a valid question, with why. */
  problems: { file: string; message: string }[];
}

type QuestionRead = { question: Question } | { error: string };

/** One question file's text, read as a question or as why it isn't one. */
function questionOfText(text: string): QuestionRead {
  const data: unknown = parse(text);
  const newer = newerQuestion(data);
  if (newer) return { error: newer };
  const r = Question.safeParse(data);
  if (!r.success)
    return {
      error: r.error.issues.map((i) => `${i.path.join(".") || "(top)"}: ${i.message}`).join("; "),
    };
  return { question: r.data };
}

/** Every question, oldest first; with `state`, only those in it. */
export async function listQuestions(
  root: string,
  o: { state?: QuestionState; repo?: string; step?: string } = {},
): Promise<QuestionList> {
  const rel = questionsRelOf(root);
  // Once: each call checks whether the metarepo is adopted, a stat.
  const qdir = questionsDirOf(root);
  let names: string[];
  try {
    names = (await readdir(qdir)).filter((n) => n.endsWith(".yaml")).sort();
  } catch {
    return { questions: [], problems: [] };
  }
  const questions: Question[] = [];
  const problems: QuestionList["problems"] = [];
  // beta.23: each file's parse is kept until it changes; the app reads every question on most
  // pages, and reading them all again each time made Home slow on a large estate.
  const read = await mapAtOnce(names, (n) =>
    keptParse(join(qdir, n), "question", questionOfText, { copy: true }).then(
      (r) => ({ n, r }),
      (e: unknown) => ({
        n,
        r: { error: (e as Error).message.split("\n")[0]! } as QuestionRead,
      }),
    ),
  );
  for (const { n, r } of read) {
    // Gone since the folder was listed: as if it was never there.
    if (!r) continue;
    if ("question" in r) questions.push(r.question);
    else problems.push({ file: `${rel}/${n}`, message: r.error });
  }
  return {
    questions: questions
      .filter(
        (q) =>
          (!o.state || q.state === o.state) &&
          (!o.repo || q.repo === o.repo) &&
          (!o.step || askedByStep(q, o.step)),
      )
      .sort((a, b) => cmpText(a.askedBy.at, b.askedBy.at) || cmpText(a.id, b.id)),
    problems,
  };
}

/** Whether a step is one that asked the question, or one that waits on it (ADR 0089). */
export const askedByStep = (q: Question, step: string): boolean =>
  q.askedBy.step === step || (q.alsoAskedBy ?? []).some((a) => a.step === step);

/** The kind of judgment that says whether a new question is one already on file (ADR 0117). */
export const SAME_QUESTION = "same-question";
/** Bumped when what the same-question judgment is asked changes, so old verdicts aren't read. */
const SAME_QUESTION_VERSION = 1;

export type SameVerdict = "same" | "narrower" | "different" | "unsure";
export const SAME_VERDICTS: readonly SameVerdict[] = ["same", "narrower", "different", "unsure"];

/**
 * The ids, fields, paths and numbers a question names, as written: a word with a capital inside
 * it (renamedAt), an underscore (renamed_at), a dot or slash between letters
 * (nadiengine-db.chat, /api/charts), a hyphen between letters and digits (forge-legacy) or a
 * digit (1000, 5xx). Folded only in case and underscores, so renamedAt and renamed_at are one
 * field. Format parsing, not meaning: it is what the veto compares.
 */
export function namedIdentifiers(text: string, repo = ""): Set<string> {
  const out = new Set<string>();
  const skip = repo.toLowerCase();
  for (const raw of text.split(/[\s,;:()"'`?!]+/)) {
    const w = raw.replace(/^[.-]+/, "").replace(/[.-]+$/, "");
    if (w.length < 2) continue;
    const id =
      /[a-z][A-Z]/.test(w) ||
      /\w_\w/.test(w) ||
      /\w[./]\w/.test(w) ||
      /^\/\w/.test(w) ||
      /[a-z0-9]-[a-z0-9]/i.test(w) ||
      /\d/.test(w);
    if (!id) continue;
    const folded = w.toLowerCase().replace(/_/g, "");
    if (folded !== skip.replace(/_/g, "")) out.add(folded);
  }
  return out;
}

/**
 * The veto that runs before any judgment (ADR 0117): two questions that each name an id, field,
 * path or number the other doesn't are about different things, so they are never the same
 * question, whatever a model says. renamedAt and renamedBy of one table are two columns; a
 * classification answered for one is never read for the other.
 */
export function differentThings(
  a: { question: string },
  b: { question: string },
  repo = "",
): string | undefined {
  const ia = namedIdentifiers(a.question, repo);
  const ib = namedIdentifiers(b.question, repo);
  const onlyA = [...ia].filter((x) => !ib.has(x));
  const onlyB = [...ib].filter((x) => !ia.has(x));
  return onlyA.length && onlyB.length
    ? `they name different things: ${onlyA.join(", ")} and ${onlyB.join(", ")}`
    : undefined;
}

/** What a same-question judgment is about, as hashed into its key. */
export function sameQuestionInputs(
  repo: string,
  d: { question: string; evidence: readonly string[] },
  existing: Pick<Question, "id" | "question" | "evidence">,
): Record<string, unknown> {
  return {
    v: SAME_QUESTION_VERSION,
    repo,
    new: { question: d.question.trim(), evidence: [...d.evidence].sort() },
    existing: {
      id: existing.id,
      question: existing.question.trim(),
      evidence: [...existing.evidence].sort(),
    },
  };
}

/** A pair the checks couldn't settle, for a judge. */
export interface QuestionPair {
  /** The judgment's key: judgmentKey(SAME_QUESTION, inputs). */
  key: string;
  inputs: Record<string, unknown>;
  repo: string;
  draft: QuestionDraft;
  existing: Question;
}

/**
 * Judges the pairs in one go (a model through the AI runtime, @maycombhq/ai's
 * questionJudge): each judgment it settles is kept in the store under its pair's key, and its
 * verdict comes back. A pair left out (the model was unsure, or the run waits in a hand-off) is
 * raised as a question, listed as related.
 */
export type QuestionJudge = (pairs: QuestionPair[]) => Promise<Map<string, SameVerdict>>;

/**
 * The kind of judgment that says whether a person's answer on file already decides a new
 * question (ADR 0117 addendum, 2026-10-24): yes, and the question isn't asked again; no, and it
 * is weighed as any other question. Asked of an answered question with its answer, which the
 * same-question judgment never sees.
 */
export const ANSWERED_BY = "answered-by";
/** Bumped when what the answered-by judgment is asked changes, so old verdicts aren't read. */
const ANSWERED_BY_VERSION = 1;
export type AnsweredVerdict = "yes" | "no" | "unsure";

/** What an answered-by judgment is about, as hashed into its key: the answer is part of it. */
export function answeredByInputs(
  repo: string,
  d: { question: string; evidence: readonly string[] },
  answered: Question,
): Record<string, unknown> {
  return {
    v: ANSWERED_BY_VERSION,
    repo,
    new: { question: d.question.trim(), evidence: [...d.evidence].sort() },
    answered: {
      id: answered.id,
      question: answered.question.trim(),
      answer: (answerWords(answered) ?? "").trim(),
    },
  };
}

/**
 * The veto of the answered-by judgment, a fact: the ids, fields, paths and numbers the new
 * question names that neither the answered question nor its answer names. A person answered
 * about those things, not these, so the answer is never read for it (ADR 0117 §4).
 */
export function namedBeyondAnswer(
  d: { question: string },
  answered: { question: string; answer: string },
  repo = "",
): string[] {
  const known = new Set([
    ...namedIdentifiers(answered.question, repo),
    ...namedIdentifiers(answered.answer, repo),
  ]);
  return [...namedIdentifiers(d.question, repo)].filter((n) => !known.has(n));
}

/** A new question and an answered one the checks couldn't settle, for a judge. */
export interface AnsweredPair {
  /** The judgment's key: judgmentKey(ANSWERED_BY, inputs). */
  key: string;
  inputs: Record<string, unknown>;
  repo: string;
  draft: QuestionDraft;
  answered: Question;
  /** The answer in words. */
  answer: string;
}

/** Judges answered-by pairs in one go (@maycombhq/ai's answerJudge); a pair left out is open. */
export type AnswerJudge = (pairs: AnsweredPair[]) => Promise<Map<string, AnsweredVerdict>>;

export interface RaiseOptions {
  /** Judge pairs the checks and the step's own reading leave open. None: they are raised. */
  judge?: QuestionJudge;
  /**
   * Judge whether an answer on file decides a new question, for the pairs the step's own
   * reading (`sameAs: answered`) and a stored judgment leave open. None: they stay open.
   */
  answerJudge?: AnswerJudge;
  /**
   * Hold back a question an answered one may already decide, where nothing settled it (no
   * reading, no judgment, no judge, or the judge unsure): it isn't written, and comes back in
   * `held` with the answered questions, so the step can hand it back to its drafter instead of
   * asking the person again. Called once per such question; true holds it.
   */
  hold?: (q: Question, answered: Question[]) => boolean;
  /** Where judgments are kept; default the metarepo's judgments/. */
  judgments?: JudgmentStore;
  /**
   * Beta.12: an open, unanswered question on file by the draft's id, that this step asked, gets
   * the draft's options and words in place (the same id, its history kept), so what a step
   * offers now (ranked suggestions, their reasons, a repo read since) reaches a question asked
   * before. Returned in `refreshed` (and `known`). An answered or retired question is never
   * touched.
   */
  refresh?: boolean;
}

/** Whether a question on file would change if it took a draft's options and words (beta.12). */
function refreshedFrom(existing: Question, d: QuestionDraft, step: string): Question | undefined {
  if (existing.state !== "open" || existing.answer || existing.askedBy.step !== step)
    return undefined;
  const same =
    existing.question === d.question &&
    JSON.stringify(existing.options) === JSON.stringify(d.options);
  if (same) return undefined;
  return Question.parse({ ...existing, question: d.question, options: d.options });
}

/** A question held back: the one it would have been, and the answered ones that may decide it. */
export interface HeldQuestion {
  question: Question;
  draft: QuestionDraft;
  answered: Question[];
}

const evidenceFile = (e: string) => e.slice(0, e.lastIndexOf(":"));

/** Fold what a word-for-word check forgives: whitespace runs, curly quotes and case. */
const fold = (s: string) =>
  s
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/** Whether `quote` is word for word in `text` (whitespace, curly quotes and case aside). */
export const quotedIn = (text: string, quote: string) =>
  fold(quote).length > 0 && fold(text).includes(fold(quote));

/** Words that say nothing of what a question is about. */
const PLAIN = new Set(
  (
    "a an the and or but nor of in on at to for from by with as is are was were be been being it " +
    "its this that these those there here which who whom what when where why how all any each " +
    "some no not only than then so too very can will would should could may might must shall do " +
    "does did has have had having i we you he she they them our your his her their us me my " +
    "also into onto about over under more most other such one two own same just still yet " +
    "if else out up down off again ever never always kind kinds sort way ways thing things " +
    "get gets got make makes made say says said use uses used want wants need needs count " +
    "question questions answer answers draft drafts problem problems " +
    // The words a stage's own question is framed in (loop.ts): "Three drafts in a row had this
    // problem: ... What should the target flows say?"
    "three row came back after fixed had placement target flow flows story stories small " +
    "change plan feature"
  ).split(" "),
);

/** A word folded for comparing what two questions are about: lower case, its plural and endings off. */
const stem = (w: string) =>
  w
    .toLowerCase()
    .replace(/'s$/, "")
    .replace(/(?<=..)(ies)$/, "y")
    .replace(/(?<=...)(ing|ed|es|s)$/, "")
    .replace(/([b-df-hj-np-tv-z])\1$/, "$1");

/** The words of substance a question says, folded (stem): what it is about. */
function substance(text: string): Set<string> {
  return new Set(
    (text.match(/\p{L}+/gu) ?? [])
      .filter((w) => !PLAIN.has(w.toLowerCase()))
      .map(stem)
      .filter((w) => w.length >= 3),
  );
}

/**
 * Whether two questions are about the same target (ADR 0117 addendum, 2026-10-25), as far as
 * facts tell: they name an id in common, or cite a file in common and share at least two words
 * of substance. Whether they ask the same thing about it is the judgment's; this keeps an answer
 * from being weighed for a question about something else.
 */
export function sameTarget(
  a: { question: string; evidence: readonly string[] },
  b: { question: string; evidence: readonly string[] },
  repo = "",
): boolean {
  const ia = namedIdentifiers(a.question, repo);
  if ([...namedIdentifiers(b.question, repo)].some((x) => ia.has(x))) return true;
  const files = new Set(a.evidence.map(evidenceFile));
  if (!b.evidence.some((e) => files.has(evidenceFile(e)))) return false;
  const wa = substance(a.question);
  return [...substance(b.question)].filter((w) => wa.has(w)).length >= 2;
}

/**
 * The questions on file a new one is weighed against: the same repo, not retired, asked by
 * another step (or answered, by this one), citing a file in common or naming an id in common.
 * Cheap and wide; the veto and the judgment decide.
 */
function candidatesFor(repo: string, d: QuestionDraft, step: string, others: Question[]) {
  const files = new Set(d.evidence.map(evidenceFile));
  const ids = namedIdentifiers(d.question, repo);
  return others.filter(
    (x) =>
      x.state !== "retired" &&
      (x.askedBy.step !== step || x.state === "answered") &&
      (x.id === d.sameAs?.id ||
        x.evidence.some((e) => files.has(evidenceFile(e))) ||
        [...namedIdentifiers(x.question, repo)].some((i) => ids.has(i))),
  );
}

/**
 * Write the questions a step raised (ADR 0078, 0089, 0117). One already on file by its id is
 * left as it is and returned in `known` (with `refresh`, an open one this step asked takes the
 * draft's options and words first). Otherwise it is weighed against the questions on file
 * for the same repo:
 * 1. the veto: the two name different ids, fields or numbers, so they differ;
 * 2. the step's own reading (`sameAs`), when the id is a candidate and its words are in it;
 * 3. a judgment already in judgments/same-question/;
 * 4. the judge, when one is given.
 * Same: the step is added to the earlier question's `alsoAskedBy` and reads its answer (it is
 * returned in `reused` and `known`), except an answered question the new one names more ids
 * than: that is narrower, so a person sees it. Narrower or unsure: the question is raised with
 * the earlier one under `related`. `of` is the question each draft became, in order.
 */
export async function raiseQuestions(
  root: string,
  drafts: QuestionDraft[],
  by: AskedBy,
  o: RaiseOptions = {},
): Promise<{
  raised: Question[];
  known: Question[];
  reused: Question[];
  of: (Question | undefined)[];
  /** Questions held back for the step's drafter (`hold`); not written. */
  held: HeldQuestion[];
  /** The answered questions whose answer decides a draft, by the draft's index (ADR 0117 addendum). */
  decidedBy: Map<number, Question>;
  /** With `refresh`: open questions on file that took the draft's options and words. */
  refreshed: Question[];
}> {
  const store = o.judgments ?? fileJudgments(root);
  const raised: Question[] = [];
  const known: Question[] = [];
  const refreshed: Question[] = [];
  const reused: Question[] = [];
  const held: HeldQuestion[] = [];
  const decidedBy = new Map<number, Question>();
  const of: (Question | undefined)[] = drafts.map(() => undefined);
  let others: Question[] | undefined;
  const plans: {
    i: number;
    d: QuestionDraft;
    q: Question;
    cands: Question[];
    answered: Question[];
  }[] = [];
  for (const [i, d] of drafts.entries()) {
    const q = questionFromDraft(d, by);
    const read = await readQuestionText(root, q.id).catch(() => undefined);
    if (read) {
      let onFile = read.q;
      let next = o.refresh ? refreshedFrom(onFile, d, by.step) : undefined;
      if (next) {
        try {
          await write(root, next, read);
          refreshed.push(next);
        } catch (e) {
          if (!(e instanceof FileChangedError)) throw e;
          // Round 46: changed meanwhile (a person answered it): it stays as it is on file now.
          next = undefined;
          onFile = (await readQuestion(root, q.id).catch(() => undefined)) ?? onFile;
        }
      }
      const existing = next ?? onFile;
      if (!known.some((k) => k.id === existing.id)) known.push(existing);
      of[i] = existing;
      continue;
    }
    others ??= (await listQuestions(root, { repo: by.repo })).questions;
    const cands = candidatesFor(by.repo, d, by.step, others).filter(
      (x) => !differentThings(d, x, by.repo),
    );
    // The answered questions whose answer may decide it: those about the same target (ADR 0117
    // addendum, 2026-10-25), the one it names as its own (sameAs), or one naming an id it names,
    // or citing a file it cites and sharing words of substance with it. A draft re-asking its
    // own answered question cites other lines, so a line in common isn't needed; but every
    // question the step asked is not a candidate (a live run held a question back as a possible
    // repeat of every answered question of the change). The veto: it names something neither
    // the question nor its answer names.
    const answered = others.filter(
      (x) =>
        x.state === "answered" &&
        (x.id === d.sameAs?.id || sameTarget(d, x, by.repo)) &&
        namedBeyondAnswer(d, { question: x.question, answer: answerWords(x) ?? "" }, by.repo)
          .length === 0,
    );
    plans.push({ i, d, q, cands, answered });
  }

  // Does an answer on file decide it? Stored, the step's own reading, or the judge's.
  const decides = new Map<string, AnsweredVerdict>();
  const open: AnsweredPair[] = [];
  for (const p of plans)
    for (const x of p.answered) {
      const inputs = answeredByInputs(by.repo, p.d, x);
      const key = judgmentKey(ANSWERED_BY, inputs);
      if (decides.has(key) || open.some((y) => y.key === key)) continue;
      const stored = await store.get(ANSWERED_BY, key);
      if (stored && typeof stored.verdict === "string") {
        decides.set(key, stored.verdict as AnsweredVerdict);
        continue;
      }
      const answer = answerWords(x) ?? "";
      const said =
        p.d.sameAs?.id === x.id && p.d.sameAs.verdict === "answered" ? p.d.sameAs : undefined;
      // The prompt gives the option's meaning too (answerText): a quote of it is the answer's.
      if (said && (quotedIn(answer, said.quote) || quotedIn(answerText(x) ?? "", said.quote))) {
        const j = await store.put(
          makeJudgment({
            kind: ANSWERED_BY,
            inputs,
            verdict: "yes",
            quotes: [{ of: "answer", text: said.quote }],
            confirmedBy: { by: "ai", run: by.run ?? by.command },
            at: by.at,
          }),
        );
        decides.set(key, j.verdict as AnsweredVerdict);
        continue;
      }
      open.push({ key, inputs, repo: by.repo, draft: p.d, answered: x, answer });
    }
  if (open.length && o.answerJudge)
    for (const [k, v] of await o.answerJudge(open)) if (!decides.has(k)) decides.set(k, v);
  const answeredFor = (p: (typeof plans)[number]) =>
    p.answered.find(
      (x) => decides.get(judgmentKey(ANSWERED_BY, answeredByInputs(by.repo, p.d, x))) === "yes",
    );
  const unsettled = (p: (typeof plans)[number]) =>
    p.answered.filter((x) => {
      const v = decides.get(judgmentKey(ANSWERED_BY, answeredByInputs(by.repo, p.d, x)));
      return v !== "yes" && v !== "no";
    });

  // What each pair is: stored, the step's own reading, or the judge's.
  const verdicts = new Map<string, SameVerdict>();
  const pending: QuestionPair[] = [];
  // A question an answer already decides needs no same-question judgment.
  for (const p of plans.filter((y) => !answeredFor(y)))
    for (const x of p.cands) {
      const inputs = sameQuestionInputs(by.repo, p.d, x);
      const key = judgmentKey(SAME_QUESTION, inputs);
      if (verdicts.has(key) || pending.some((y) => y.key === key)) continue;
      const stored = await store.get(SAME_QUESTION, key);
      if (stored && typeof stored.verdict === "string") {
        verdicts.set(key, stored.verdict as SameVerdict);
        continue;
      }
      const said = p.d.sameAs?.id === x.id ? p.d.sameAs : undefined;
      if (said && quotedIn(x.question, said.quote)) {
        const j = await store.put(
          makeJudgment({
            kind: SAME_QUESTION,
            inputs,
            verdict: said.verdict,
            quotes: [{ of: "existing", text: said.quote }],
            confirmedBy: { by: "ai", run: by.run ?? by.command },
            at: by.at,
          }),
        );
        verdicts.set(key, j.verdict as SameVerdict);
        continue;
      }
      pending.push({ key, inputs, repo: by.repo, draft: p.d, existing: x });
    }
  if (pending.length && o.judge)
    for (const [k, v] of await o.judge(pending)) if (!verdicts.has(k)) verdicts.set(k, v);

  for (const p of plans) {
    const dup = raised.find((r) => r.id === p.q.id);
    if (dup) {
      of[p.i] = dup;
      continue;
    }
    // A person's answer on file decides it: the step reads that answer, nobody is asked again.
    const decided = answeredFor(p);
    let same: Question | undefined = decided;
    if (decided) decidedBy.set(p.i, decided);
    const related: NonNullable<Question["related"]> = [];
    for (const x of decided ? [] : p.cands) {
      const key = judgmentKey(SAME_QUESTION, sameQuestionInputs(by.repo, p.d, x));
      const v = verdicts.get(key) ?? "unsure";
      if (v === "different") continue;
      const judgment = verdicts.has(key) ? { judgment: key } : {};
      // An answered question is read for another only when the new one names nothing it
      // doesn't: a person answered that question, not one about more things.
      const namesMore =
        x.state === "answered" &&
        [...namedIdentifiers(p.d.question, by.repo)].some(
          (n) => !namedIdentifiers(x.question, by.repo).has(n),
        );
      if (v === "same" && !namesMore) {
        same = x;
        break;
      }
      if (!related.some((r) => r.id === x.id))
        related.push({ id: x.id, verdict: v === "unsure" ? "unsure" : "narrower", ...judgment });
    }
    if (same) {
      // Review round 48: the step is added to the question as it is on file now (a person may
      // have answered it since the list was read), and written only if it is still that text.
      const read = await readQuestionText(root, same.id).catch(() => undefined);
      let kept = read?.q ?? same;
      if (read && !askedByStep(read.q, by.step)) {
        const next = Question.parse({
          ...read.q,
          alsoAskedBy: [
            ...(read.q.alsoAskedBy ?? []),
            {
              step: by.step,
              command: by.command,
              ...(by.run ? { run: by.run } : {}),
              at: by.at,
              rerun: by.rerun,
            },
          ],
        });
        try {
          await write(root, next, read);
          kept = next;
        } catch (e) {
          if (!(e instanceof FileChangedError)) throw e;
          // Changed meanwhile: it stays as it is on file now, without this step on it.
          kept = (await readQuestion(root, same.id).catch(() => undefined)) ?? kept;
        }
      }
      if (kept !== same) others = (others ?? []).map((x) => (x.id === kept.id ? kept : x));
      if (!reused.some((k) => k.id === kept.id)) reused.push(kept);
      if (!known.some((k) => k.id === kept.id)) known.push(kept);
      of[p.i] = kept;
      continue;
    }
    const q = related.length ? Question.parse({ ...p.q, related }) : p.q;
    // An answered question that may decide it and that nothing settled: the step may hand it
    // back to its drafter, with the answer, rather than ask the person what they already said.
    const maybe = unsettled(p);
    if (maybe.length && o.hold?.(q, maybe)) {
      held.push({ question: q, draft: p.d, answered: maybe });
      continue;
    }
    await write(root, q);
    raised.push(q);
    of[p.i] = q;
  }
  return { raised, known, reused, of, held, decidedBy, refreshed };
}

/** Whether a question file's text is at an older question version (one migrateQuestions rewrites). */
function olderQuestionText(text: string): boolean {
  let data: unknown;
  try {
    data = parse(text);
  } catch {
    return false;
  }
  return olderVersion((data as { schemaVersion?: unknown } | null)?.schemaVersion);
}

/** Whether a question file's version is one before this Atticus's (1 to 5; 6 is current). */
const olderVersion = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 1 && v < QUESTION_SCHEMA_VERSION;

/**
 * Rewrite questions/<id>.yaml files written at an older question schema version (1, ADR 0078;
 * 2, ADR 0117; 3, ADR 0153; 4, ADR 0162; 5, ADR 0181) at the current one (6, ADR 0191): only the
 * version changes, since what each version adds is optional. Returns the files, relative to the root; with dryRun, the files it
 * would rewrite.
 */
export async function migrateQuestions(
  root: string,
  o: {
    dryRun?: boolean;
    /** Round 49: the files left as they are, with why (a file not named by its question's id). */
    problems?: { file: string; message: string }[];
  } = {},
): Promise<string[]> {
  const rel = questionsRelOf(root);
  const qdir = questionsDirOf(root);
  const out: string[] = [];
  let names: string[];
  try {
    names = (await readdir(qdir)).filter((n) => n.endsWith(".yaml")).sort();
  } catch {
    return out;
  }
  for (const n of names) {
    const file = join(qdir, n);
    // beta.23: a file already at the current version, by its kept reading, isn't read again
    // (the app's upgrade check and doctor ask this of every question on each look).
    if (!(await keptParse(file, "question-older", olderQuestionText).catch(() => true))) continue;
    // Round 49: written back to the file it was read from, only while it still holds what was
    // read (an answer landing meanwhile is read again, never lost); a few tries, then left.
    for (let attempt = 0; attempt < 3; attempt++) {
      let text: string;
      let data: unknown;
      try {
        text = await readFile(file, "utf8");
        data = parse(text);
      } catch {
        break;
      }
      const v = (data as { schemaVersion?: unknown } | null)?.schemaVersion;
      // ADR 0181: version 4 files too; ADR 0191 review: and version 5 ones, rewritten at the
      // current version (the number only: what each version adds is optional).
      if (!olderVersion(v)) break;
      const q = Question.safeParse(data);
      if (!q.success) break;
      // Round 49: a copy (`q-… copy.yaml`) or a renamed file isn't the question's own file:
      // writing it under its id would overwrite the live question, or leave a duplicate.
      if (n !== `${q.data.id}.yaml`) {
        o.problems?.push({
          file: `${rel}/${n}`,
          message: `it holds ${q.data.id}, whose file is ${rel}/${q.data.id}.yaml: left at question version ${String(v)}. Remove the copy, or rename it to ${q.data.id}.yaml if it is the only one.`,
        });
        break;
      }
      if (!o.dryRun) {
        try {
          await write(root, q.data, { text });
        } catch (e) {
          if (e instanceof FileChangedError) continue;
          throw e;
        }
      }
      out.push(`${rel}/${n}`);
      break;
    }
  }
  return out;
}

/** What a step says of a question it reused: who asked it first, and that it waits on it. */
export const reusedLine = (q: Question): string =>
  `${q.id} was already asked by ${q.askedBy.command}: "${q.question.trim()}" This step ${q.state === "answered" ? "reads its answer" : "waits on the same answer"} instead of asking again.`;

/**
 * The skill file of a repo type, relative to the root, where a repo-type answer goes: the
 * first skill the type lists (repo-types/<id>/type.yaml, ADR 0077), else process/skills/<id>/.
 */
export async function repoTypeSkillRel(root: string, type: string): Promise<string> {
  const pack = isAdopted(root) ? ".atticus/org-pack" : "org-pack";
  const listed = await readFile(join(root, pack, "repo-types", type, "type.yaml"), "utf8")
    .then((t) => (parse(t) as { skills?: unknown })?.skills)
    .catch(() => undefined);
  const first = Array.isArray(listed) && typeof listed[0] === "string" ? listed[0] : undefined;
  return `${pack}/${first ?? `process/skills/${type}/SKILL.md`}`;
}

/** The answer in words: the option's label or the person's own text. */
/**
 * Retire an open question (ADR 0117 addendum, V0): it is no longer asked and nothing reads an
 * answer to it. It says why, and which questions ask it now. An answered question keeps its
 * answer and is never retired here.
 */
export async function retireQuestion(
  root: string,
  id: string,
  o: { why: string; replacedBy?: string[]; at: string },
): Promise<Question> {
  const read = await readQuestionText(root, id);
  if (!read) throw new QuestionError("not-found", `There is no question ${id}.`);
  const q = read.q;
  if (q.state !== "open")
    throw new QuestionError(
      "retired",
      `Question ${id} is ${q.state}; only an open one is retired.`,
    );
  const next = Question.parse({
    ...q,
    state: "retired",
    retired: {
      at: o.at,
      why: o.why,
      ...(o.replacedBy?.length ? { replacedBy: o.replacedBy } : {}),
    },
  });
  await write(root, next, read);
  return next;
}

/**
 * ADR 0162 (F8): open an answered targets question again, because the code read since disagrees
 * with its answer (the repo it named has no route that serves the call). The answer it had is
 * kept under `reopened` with why, so the person sees what they said and what the code says.
 */
export async function reopenQuestion(
  root: string,
  id: string,
  o: { why: string; at: string },
): Promise<Question> {
  const read = await readQuestionText(root, id);
  if (!read) throw new QuestionError("not-found", `There is no question ${id}.`);
  const q = read.q;
  if (q.state !== "answered" || !q.answer)
    throw new QuestionError(
      "retired",
      `Question ${id} is ${q.state}; only an answered one reopens.`,
    );
  const { answer, ...rest } = q;
  const next = Question.parse({
    ...rest,
    state: "open",
    reopened: { at: o.at, why: o.why, answer },
  });
  await write(root, next, read);
  return next;
}

export function answerWords(q: Question): string | undefined {
  const a = q.answer;
  if (!a) return undefined;
  return a.text ?? q.options[(a.option ?? 0) - 1]?.label;
}

const sentence = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

/**
 * An answer as a step's next prompt gives it (B-run2-fixes 8): the option picked with what it
 * means and what it changes, or the person's own words. `answerWords` (the label alone) stays what
 * judgments are keyed by, so their stored verdicts hold.
 */
export function answerText(q: Question): string | undefined {
  const a = q.answer;
  if (!a) return undefined;
  if (a.text !== undefined) return a.text;
  const o = q.options[(a.option ?? 0) - 1];
  return o
    ? `${sentence(o.label)} It means: ${sentence(o.means)} It changes: ${sentence(o.changes)}`
    : undefined;
}

/** Put (or replace) the answer's line under "## Answers" in a skill file's text. */
export function withSkillAnswer(body: string, q: Question): string {
  const a = q.answer!;
  const marker = `question ${q.id})`;
  const line = `- ${q.question.trim()} ${sentence(answerWords(q)!)} (${answerByWords(a.by)}, ${a.at.slice(0, 10)}, ${marker}`;
  const lines = body.split(/\r?\n/).filter((l) => !l.includes(marker));
  let h = lines.findIndex((l) => /^##\s+Answers\s*$/.test(l));
  if (h < 0) {
    while (lines.length && lines.at(-1) === "") lines.pop();
    lines.push("", "## Answers");
    h = lines.length - 1;
  }
  // The Answers section runs to the next heading; its entries keep their order, the new one last.
  let end = lines.findIndex((l, i) => i > h && /^#{1,2}\s/.test(l));
  if (end < 0) end = lines.length;
  const entries = lines.slice(h + 1, end).filter((l) => l.trim() !== "");
  return [...lines.slice(0, h + 1), "", ...entries, line, "", ...lines.slice(end)].join("\n");
}

export interface AnswerInput {
  /** The option picked, counting from 1. */
  option?: number;
  /** Or the person's own words. */
  text?: string;
  /** The scope the person confirms; default the one proposed. */
  scope?: QuestionScopeLevel;
  /** The repo type, when the person widens a repo question to its type. */
  repoType?: string;
  /**
   * ADR 0153 (Q2): the rule the answer covers, for a target or hosts question: a host pattern
   * (`*.payments.forge.internal`) or a path prefix (`/forge/limits/**`).
   */
  match?: string;
  /** ADR 0153 (Q5): the assistant's proposal this answer accepts (acceptProposal sets it). */
  proposal?: NonNullable<Question["answer"]>["proposal"];
  /**
   * Review item 14: a file change the answer brings (a system written into the profile, ADR
   * 0162), made only once the answer is checked and just before it is written. When it throws,
   * nothing is answered (a `bad-answer` with its first line).
   */
  beforeWrite?: () => Promise<void>;
  /**
   * The person (their Git user); or, ADR 0181, the AI with its runtime and run, for a decision
   * Atticus applies from an AI run (only an option on file, of a targets question, at the repo).
   */
  by: string | AiBy;
  at: string;
  /** ADR 0181: the batch applying it (by AI, or by a person's rule). */
  batch?: string;
  /** ADR 0181: a person's rule applies it, from their correction. */
  rule?: AppliedRule;
  /**
   * Beta.24 review: Ignore, for a question about where calls go: they aren't real calls (CI/CD, a
   * test, a template), so the join leaves them. In place of option and text; the reason, when
   * given, is the answer's words (`Ignore: <reason>`), else the Ignore option is picked (added to
   * the question's options when it was asked before Ignore was offered).
   */
  ignore?: { reason?: string };
  /**
   * Beta.24 review: the id of the system `beforeWrite` adds to the profile, which the answer's
   * words name, so they aren't refused as naming nothing.
   */
  adds?: string;
  /**
   * Beta.25 (pre-merge review): told of each file the answer writes, its question file and its
   * skill file, with the exact text written, as soon as it is written: before the answer returns,
   * and whether or not a later write of it fails. A caller that puts back what it wrote (Map ›
   * Trust's fix of a box) tells its own text from a change someone made just after.
   */
  wrote?: (file: string, text: string) => void | Promise<void>;
}

/**
 * Whether a host a hosts question asks about (`localhost:9966`, `limits.payments.forge.internal`)
 * is one a rule's host pattern covers, as the manifest matches hosts.
 */
export function hostRuleCovers(pattern: string, asked: string): boolean {
  const [name, port] = asked.split(/:(?=\d+$)/);
  return hostMatches(pattern, name!, port ? Number(port) : undefined);
}

/** Ignore's option, or words that start `Ignore:` (beta.24 review). */
const isIgnoreWords = (label: string) => label.trim().toLowerCase().startsWith("ignore:");

/** Why a rule can't ride on this answer, or undefined when it can. */
function ruleProblem(q: Question, match: string, label: string | undefined): string | undefined {
  if (!AnswerMatch.safeParse(match).success)
    return `${match} isn't a rule Atticus reads: give a host pattern (*.payments.forge.internal), a path prefix (/forge/limits/**), or /** for every path of the repo.`;
  if (q.askedBy.step === TARGETS_STEP_ID) {
    if (label === TARGETS_SPLIT_LABEL)
      return `"${TARGETS_SPLIT_LABEL}" says the calls go to more than one place, so no rule rides on it: pick where the calls go.`;
    return undefined;
  }
  if (q.askedBy.step !== HOSTS_STEP)
    return "Only a question about where calls go (a target or a host) takes a rule: answer it without --match.";
  const host = hostOfQuestion(q);
  if (!label || label === HOSTS_NONE || isIgnoreWords(label) || outsideBoundaryOf(label))
    return "A rule on a host question names the repo that answers: pick a repo, or answer without --match.";
  if (!isPathMatch(match) && host && !hostRuleCovers(match, host))
    return `${match} doesn't cover ${host}, the host this question asks about: give a pattern that does.`;
  return undefined;
}

/**
 * Record a person's answer in the question's file. A repo-type answer also goes, as a line
 * under "## Answers", in the type's skill file when that file is there; the path is kept in
 * the answer either way.
 */
export async function answerQuestion(
  root: string,
  id: string,
  a: AnswerInput,
): Promise<{
  question: Question;
  skill?: { path: string; written: boolean };
  /** For a hosts question answered with a repo (ADR 0088): the host written to the manifest. */
  hosts?: { repo: string; host: string; manifest: string; added: boolean; basePath?: string };
  /**
   * ADR 0153 (Q2): the other open hosts questions the answer's host pattern covers, retired as
   * answered by it.
   */
  covered?: string[];
  /**
   * For a hosts question answered with an outside system (O1): the system written to the
   * profile, with the host as its alias.
   */
  system?: {
    id: string;
    host: string;
    boundary: "internal" | "vendor";
    profile: string;
    added: boolean;
  };
}> {
  const read = await readQuestionText(root, id);
  if (!read) throw new QuestionError("not-found", `There is no question ${id}.`);
  let q = read.q;
  if (q.state === "retired")
    throw new QuestionError("retired", `Question ${id} is retired; nothing reads its answer.`);
  // Beta.24 review: Ignore, for a question about where calls go, as an option or its words.
  if (a.ignore) {
    if (!JOIN_STEPS.has(q.askedBy.step))
      throw new QuestionError(
        "bad-answer",
        "Ignore is for a question about where calls go (a host, a target or a topic): answer this one with an option or your own words.",
      );
    if (a.option !== undefined || a.text?.trim())
      throw new QuestionError("bad-answer", "Give Ignore alone, not with an option or words.");
    if (isAiBy(a.by))
      throw new QuestionError(
        "bad-answer",
        "The AI doesn't ignore calls: a person says they aren't real.",
      );
    const reason = a.ignore.reason?.trim();
    if (reason) a = { ...a, text: ignoreText(reason) };
    else {
      let at = q.options.findIndex((o) => o.label === JOIN_IGNORE_LABEL);
      if (at < 0) {
        q = { ...q, options: [...q.options, ignoreOption()] };
        at = q.options.length - 1;
      }
      a = { ...a, option: at + 1 };
    }
  }
  const text = a.text?.trim() || undefined;
  if ((a.option === undefined) === (text === undefined))
    throw new QuestionError("bad-answer", "Give an option or your own words, one of the two.");
  // Beta.25: an Ignore's reason, given with Ignore or as words (`Ignore: <reason>`), is as long
  // as the API takes, from any caller.
  const ignoreWhy =
    text && JOIN_STEPS.has(q.askedBy.step)
      ? ignoredAnswer({ options: q.options, answer: { text, by: a.by } })?.reason
      : undefined;
  if (ignoreWhy && ignoreWhy.length > IGNORE_REASON_MAX)
    throw new QuestionError(
      "bad-answer",
      `An Ignore's reason is at most ${IGNORE_REASON_MAX} characters (this is ${ignoreWhy.length}): say it in fewer words.`,
    );
  if (
    a.option !== undefined &&
    (!Number.isInteger(a.option) || a.option < 1 || a.option > q.options.length)
  )
    throw new QuestionError(
      "bad-answer",
      q.options.length
        ? `There is no option ${a.option}: pick 1 to ${q.options.length}.`
        : `There is no option ${a.option}: this question has no options, so answer in your own words.`,
    );
  // ADR 0162 (F8): "Another repo…" opens the picker; it names nothing, so it isn't an answer.
  const pickerLabel = a.option !== undefined ? q.options[a.option - 1]?.label : undefined;
  if (pickerLabel && PICKER_LABELS.has(pickerLabel))
    throw new QuestionError(
      "bad-answer",
      `"${pickerLabel}" opens the list of every repo, system and team: name the one you mean with --target <id> (atticus questions answer ${q.id} --target <id>), or in your own words.`,
    );
  // ADR 0181: the AI decides only an open option question about a target on file, at its repo,
  // never with a rule, and never over a person's answer.
  if (isAiBy(a.by)) {
    const why = questionAiProblem(q, a.option);
    if (why) throw new QuestionError("bad-answer", `The AI doesn't decide ${id}: ${why}`);
    if ((a.scope && a.scope !== "repo") || a.repoType || a.match || a.rule)
      throw new QuestionError(
        "bad-answer",
        `The AI doesn't decide ${id} wider than its repo, or by a rule: a person does.`,
      );
  }
  // Beta.24 review: words that name nothing are never made into a system: a question about
  // where calls go takes words that name a repo, component or system, or Ignore's.
  if (
    text &&
    JOIN_STEPS.has(q.askedBy.step) &&
    text !== a.adds &&
    !ignoredAnswer({ options: q.options, answer: { text, by: a.by } }) &&
    !(await namesKnownTarget(root, text))
  )
    throw new QuestionError("bad-answer", wordsNameNothing(text));
  const level = a.scope ?? q.scope.level;
  let scopeId: string;
  if (level === "repo") scopeId = q.repo;
  else {
    const t = a.repoType ?? (q.scope.level === "repo-type" ? q.scope.id : undefined);
    if (!t)
      throw new QuestionError(
        "bad-answer",
        "Say which repo type the answer is for, or keep it to this repo.",
      );
    scopeId = t;
  }
  const match = a.match?.trim() || undefined;
  const picked = a.option !== undefined ? q.options[a.option - 1]?.label : text;
  if (match) {
    const why = ruleProblem(q, match, picked);
    if (why) throw new QuestionError("bad-answer", why);
  }
  const skill = level === "repo-type" ? await repoTypeSkillRel(root, scopeId) : undefined;
  const answered = Question.parse({
    ...q,
    state: "answered",
    answer: {
      ...(a.option !== undefined ? { option: a.option } : { text }),
      by: a.by,
      at: a.at,
      scope: { level, id: scopeId },
      ...(skill ? { skill } : {}),
      ...(match ? { match } : {}),
      ...(a.proposal ? { proposal: a.proposal } : {}),
      ...(a.batch ? { batch: a.batch } : {}),
      ...(a.rule ? { rule: a.rule } : {}),
    },
  });
  if (a.beforeWrite)
    try {
      await a.beforeWrite();
    } catch (e) {
      if (e instanceof FileChangedError) throw e;
      throw new QuestionError("bad-answer", (e as Error).message.split("\n")[0]!);
    }
  // A hosts question answered with a repo: the host goes under that repo's hosts first, so a
  // manifest that refuses it leaves the question open.
  const label = a.option !== undefined ? q.options[a.option - 1]?.label : undefined;
  const host = q.askedBy.step === HOSTS_STEP ? hostOfQuestion(q) : undefined;
  let hosts:
    { repo: string; host: string; manifest: string; added: boolean; basePath?: string } | undefined;
  let system:
    | { id: string; host: string; boundary: "internal" | "vendor"; profile: string; added: boolean }
    | undefined;
  const boundary = outsideBoundaryOf(label);
  // Beta.24 review: a targets question the join raised for a host nothing resolves (a gateway's
  // token target URL) answered with a new outside system: the system goes into the profile, named
  // by the host, and the calls the question cites go to it (targetsFromAnswers names them).
  const joinHost = q.askedBy.step === TARGETS_STEP_ID ? joinHostOfQuestion(q) : undefined;
  if (joinHost && label && boundary) {
    try {
      const s = outsideSystemOfJoinHost(joinHost);
      const r = await addProfileSystem(root, q.repo, { ...s, boundary });
      system = { id: r.id, host: joinHost, boundary, profile: r.profile, added: r.added };
    } catch (e) {
      if (e instanceof FileChangedError) throw e;
      throw new QuestionError("bad-answer", (e as Error).message.split("\n")[0]!);
    }
  } else if (host && label && boundary) {
    try {
      system = { host, boundary, ...(await addOutsideSystem(root, q.repo, host, boundary)) };
    } catch (e) {
      if (e instanceof FileChangedError) throw e;
      throw new QuestionError("bad-answer", (e as Error).message.split("\n")[0]!);
    }
  } else if (host && label && label !== HOSTS_NONE && label !== JOIN_IGNORE_LABEL) {
    // ADR 0153 (Q2): a host pattern goes under hosts in place of the host; a path prefix is the
    // repo's basePath on the host. Either way the manifest's own matching answers every call.
    const listed = match && !isPathMatch(match) ? match : host;
    // `/**` is every path: no basePath to record, only the host.
    const basePath =
      match && isPathMatch(match) && match !== "/**" ? match.replace(/\/\*\*$/, "") : undefined;
    try {
      hosts = {
        repo: label,
        host: listed,
        ...(await addManifestHost(root, label, listed, basePath ? { basePath } : {})),
        ...(basePath ? { basePath } : {}),
      };
    } catch (e) {
      if (e instanceof FileChangedError) throw e;
      throw new QuestionError("bad-answer", (e as Error).message.split("\n")[0]!);
    }
  }
  // Round 46: only over the file as it was read, so the AI's batch never overwrites a person's
  // answer given meanwhile (FileChangedError, 409 in the app).
  const fileText = await write(root, answered, read);
  await a.wrote?.(fileOf(root, answered.id), fileText);
  // ADR 0153 (Q2): the other open hosts questions the pattern covers are answered by it now.
  const covered: string[] = [];
  if (hosts && match && !isPathMatch(match))
    for (const x of (await listQuestions(root, { state: "open", step: HOSTS_STEP })).questions) {
      const h = hostOfQuestion(x);
      if (x.id === q.id || !h || !hostRuleCovers(match, h)) continue;
      await retireQuestion(root, x.id, {
        why: `${q.id} answered it by rule: ${hosts.repo} lists ${match} under hosts in ${hosts.manifest}`,
        replacedBy: [q.id],
        at: a.at,
      });
      covered.push(x.id);
    }
  const extra = {
    ...(hosts ? { hosts } : {}),
    ...(system ? { system } : {}),
    ...(covered.length ? { covered } : {}),
  };
  if (!skill) return { question: answered, ...extra };
  const file = join(root, ...skill.split("/"));
  let body: string | undefined;
  try {
    body = await readFile(file, "utf8");
  } catch {
    // TODO(lead, repo types): no skill file for this type yet; the path is in the answer.
    return { question: answered, ...extra, skill: { path: skill, written: false } };
  }
  // The question is answered already: an edit of the skill file meanwhile is read again once,
  // and the answer's line goes in that (it replaces its own line by its marker).
  try {
    const text = withSkillAnswer(body, answered);
    await writeFileIfUnchanged(file, body, text);
    await a.wrote?.(file, text);
  } catch (e) {
    if (!(e instanceof FileChangedError)) throw e;
    // Gone, or changed again: the answer stands; the skill file says it next time.
    const now = await readFile(file, "utf8").catch(() => undefined);
    if (now === undefined)
      return { question: answered, ...extra, skill: { path: skill, written: false } };
    try {
      const text = withSkillAnswer(now, answered);
      await writeFileIfUnchanged(file, now, text);
      await a.wrote?.(file, text);
    } catch (again) {
      if (again instanceof FileChangedError)
        return { question: answered, ...extra, skill: { path: skill, written: false } };
      throw again;
    }
  }
  return { question: answered, ...extra, skill: { path: skill, written: true } };
}
