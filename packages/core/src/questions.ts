import { createHash } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { writeFileAtomic } from "./fs.js";
import { addManifestHost, hostOfQuestion, HOSTS_NONE, HOSTS_STEP } from "./host-questions.js";
import { fileJudgments, judgmentKey, makeJudgment, type JudgmentStore } from "./judgments.js";
import { isAdopted, questionsDirOf, questionsRelOf } from "./metarepo.js";
import {
  Question,
  QUESTION_SCHEMA_VERSION,
  QuestionId,
  type QuestionDraft,
  type QuestionScopeLevel,
  type QuestionState,
} from "./schema/question.js";

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
    state: "open",
    rerun: by.rerun,
  });
}

const fileOf = (root: string, id: string) => join(questionsDirOf(root), `${id}.yaml`);

async function write(root: string, q: Question): Promise<void> {
  await mkdir(questionsDirOf(root), { recursive: true });
  await writeFileAtomic(
    fileOf(root, q.id),
    `# A question from ${q.askedBy.command} (ADR 0078). Answer it with atticus questions answer ${q.id}, or in the app.\n${stringify(Question.parse(q))}`,
  );
}

/** Read one question, or undefined when there is no such file. Throws on a file that isn't valid. */
export async function readQuestion(root: string, id: string): Promise<Question | undefined> {
  if (!QuestionId.safeParse(id).success) return undefined;
  let text: string;
  try {
    text = await readFile(fileOf(root, id), "utf8");
  } catch {
    return undefined;
  }
  return Question.parse(parse(text));
}

export interface QuestionList {
  questions: Question[];
  /** Files in questions/ that aren't a valid question, with why. */
  problems: { file: string; message: string }[];
}

/** Every question, oldest first; with `state`, only those in it. */
export async function listQuestions(
  root: string,
  o: { state?: QuestionState; repo?: string; step?: string } = {},
): Promise<QuestionList> {
  const rel = questionsRelOf(root);
  let names: string[];
  try {
    names = (await readdir(questionsDirOf(root))).filter((n) => n.endsWith(".yaml")).sort();
  } catch {
    return { questions: [], problems: [] };
  }
  const questions: Question[] = [];
  const problems: QuestionList["problems"] = [];
  for (const n of names) {
    try {
      const r = Question.safeParse(parse(await readFile(join(questionsDirOf(root), n), "utf8")));
      if (!r.success)
        problems.push({
          file: `${rel}/${n}`,
          message: r.error.issues
            .map((i) => `${i.path.join(".") || "(top)"}: ${i.message}`)
            .join("; "),
        });
      else questions.push(r.data);
    } catch (e) {
      problems.push({ file: `${rel}/${n}`, message: (e as Error).message.split("\n")[0]! });
    }
  }
  return {
    questions: questions
      .filter(
        (q) =>
          (!o.state || q.state === o.state) &&
          (!o.repo || q.repo === o.repo) &&
          (!o.step || askedByStep(q, o.step)),
      )
      .sort((a, b) => a.askedBy.at.localeCompare(b.askedBy.at) || a.id.localeCompare(b.id)),
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

export interface RaiseOptions {
  /** Judge pairs the checks and the step's own reading leave open. None: they are raised. */
  judge?: QuestionJudge;
  /** Where judgments are kept; default the metarepo's judgments/. */
  judgments?: JudgmentStore;
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
 * left as it is and returned in `known`. Otherwise it is weighed against the questions on file
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
}> {
  const store = o.judgments ?? fileJudgments(root);
  const raised: Question[] = [];
  const known: Question[] = [];
  const reused: Question[] = [];
  const of: (Question | undefined)[] = drafts.map(() => undefined);
  let others: Question[] | undefined;
  const plans: { i: number; d: QuestionDraft; q: Question; cands: Question[] }[] = [];
  for (const [i, d] of drafts.entries()) {
    const q = questionFromDraft(d, by);
    const existing = await readQuestion(root, q.id).catch(() => undefined);
    if (existing) {
      if (!known.some((k) => k.id === existing.id)) known.push(existing);
      of[i] = existing;
      continue;
    }
    others ??= (await listQuestions(root, { repo: by.repo })).questions;
    const cands = candidatesFor(by.repo, d, by.step, others).filter(
      (x) => !differentThings(d, x, by.repo),
    );
    plans.push({ i, d, q, cands });
  }

  // What each pair is: stored, the step's own reading, or the judge's.
  const verdicts = new Map<string, SameVerdict>();
  const pending: QuestionPair[] = [];
  for (const p of plans)
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
    let same: Question | undefined;
    const related: NonNullable<Question["related"]> = [];
    for (const x of p.cands) {
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
      let kept = same;
      if (!askedByStep(same, by.step)) {
        kept = Question.parse({
          ...same,
          alsoAskedBy: [
            ...(same.alsoAskedBy ?? []),
            {
              step: by.step,
              command: by.command,
              ...(by.run ? { run: by.run } : {}),
              at: by.at,
              rerun: by.rerun,
            },
          ],
        });
        await write(root, kept);
        others = (others ?? []).map((x) => (x.id === kept.id ? kept : x));
      }
      if (!reused.some((k) => k.id === kept.id)) reused.push(kept);
      if (!known.some((k) => k.id === kept.id)) known.push(kept);
      of[p.i] = kept;
      continue;
    }
    const q = related.length ? Question.parse({ ...p.q, related }) : p.q;
    await write(root, q);
    raised.push(q);
    of[p.i] = q;
  }
  return { raised, known, reused, of };
}

/**
 * Rewrite questions/<id>.yaml files written at question schema version 1 at version 2 (ADR
 * 0117): only the version changes, since what version 2 adds is optional. Returns the files,
 * relative to the root; with dryRun, the files it would rewrite.
 */
export async function migrateQuestions(
  root: string,
  o: { dryRun?: boolean } = {},
): Promise<string[]> {
  const rel = questionsRelOf(root);
  const out: string[] = [];
  let names: string[];
  try {
    names = (await readdir(questionsDirOf(root))).filter((n) => n.endsWith(".yaml")).sort();
  } catch {
    return out;
  }
  for (const n of names) {
    let data: unknown;
    try {
      data = parse(await readFile(join(questionsDirOf(root), n), "utf8"));
    } catch {
      continue;
    }
    if ((data as { schemaVersion?: unknown } | null)?.schemaVersion !== 1) continue;
    const q = Question.safeParse(data);
    if (!q.success) continue;
    if (!o.dryRun) await write(root, q.data);
    out.push(`${rel}/${n}`);
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
export function answerWords(q: Question): string | undefined {
  const a = q.answer;
  if (!a) return undefined;
  return a.text ?? q.options[(a.option ?? 0) - 1]?.label;
}

const sentence = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

/** Put (or replace) the answer's line under "## Answers" in a skill file's text. */
export function withSkillAnswer(body: string, q: Question): string {
  const a = q.answer!;
  const marker = `question ${q.id})`;
  const line = `- ${q.question.trim()} ${sentence(answerWords(q)!)} (${a.by}, ${a.at.slice(0, 10)}, ${marker}`;
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
  by: string;
  at: string;
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
  hosts?: { repo: string; host: string; manifest: string; added: boolean };
}> {
  const q = await readQuestion(root, id);
  if (!q) throw new QuestionError("not-found", `There is no question ${id}.`);
  if (q.state === "retired")
    throw new QuestionError("retired", `Question ${id} is retired; nothing reads its answer.`);
  const text = a.text?.trim() || undefined;
  if ((a.option === undefined) === (text === undefined))
    throw new QuestionError("bad-answer", "Give an option or your own words, one of the two.");
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
    },
  });
  // A hosts question answered with a repo: the host goes under that repo's hosts first, so a
  // manifest that refuses it leaves the question open.
  const label = a.option !== undefined ? q.options[a.option - 1]?.label : undefined;
  const host = q.askedBy.step === HOSTS_STEP ? hostOfQuestion(q) : undefined;
  let hosts: { repo: string; host: string; manifest: string; added: boolean } | undefined;
  if (host && label && label !== HOSTS_NONE) {
    try {
      hosts = { repo: label, host, ...(await addManifestHost(root, label, host)) };
    } catch (e) {
      throw new QuestionError("bad-answer", (e as Error).message.split("\n")[0]!);
    }
  }
  await write(root, answered);
  if (!skill) return { question: answered, ...(hosts ? { hosts } : {}) };
  const file = join(root, ...skill.split("/"));
  let body: string | undefined;
  try {
    body = await readFile(file, "utf8");
  } catch {
    // TODO(lead, repo types): no skill file for this type yet; the path is in the answer.
    return { question: answered, skill: { path: skill, written: false } };
  }
  await writeFileAtomic(file, withSkillAnswer(body, answered));
  return { question: answered, skill: { path: skill, written: true } };
}
