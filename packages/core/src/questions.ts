import { createHash } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { writeFileAtomic } from "./fs.js";
import { addManifestHost, hostOfQuestion, HOSTS_NONE, HOSTS_STEP } from "./host-questions.js";
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

const STOP = new Set(
  "a an and are as at be by can do does for from has have in is it its of on or should so that the this these those to was were what when where which who why will with would".split(
    " ",
  ),
);

/** A question's content words: lower case, without small words and the repo's own id. */
const contentWords = (s: string, repo: string) =>
  new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9_./-]+/)
      .map((w) => w.replace(/^[./-]+|[./-]+$/g, ""))
      .filter((w) => w.length > 1 && !STOP.has(w) && w !== repo.toLowerCase()),
  );

/**
 * What a question asks about, without its asides: the words before ", or", with brackets and
 * a clause between commas left out ("Is X, the old project, still used, or ..." is "Is X still
 * used").
 */
const kernel = (s: string) =>
  s
    .replace(/\([^)]*\)/g, " ")
    .split(/,\s+or\s+|\s+or\s+/i)[0]!
    .replace(/,[^,]*,/, " ");

const jaccard = (a: Set<string>, b: Set<string>) => {
  if (a.size === 0 || b.size === 0) return 0;
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n / (a.size + b.size - n);
};

/**
 * Whether two questions about one repo ask the same thing (ADR 0089): they cite a line in
 * common, or their words are near-identical (what each asks about, asides left out, shares at
 * least three quarters of its words, or the whole questions share seven in ten).
 */
export function sameQuestion(
  a: { repo: string; question: string; evidence: readonly string[] },
  b: { repo: string; question: string; evidence: readonly string[] },
): boolean {
  if (a.repo !== b.repo) return false;
  if (a.evidence.some((e) => b.evidence.includes(e))) return true;
  const ka = contentWords(kernel(a.question), a.repo);
  const kb = contentWords(kernel(b.question), b.repo);
  if (Math.min(ka.size, kb.size) >= 3 && jaccard(ka, kb) >= 0.75) return true;
  return jaccard(contentWords(a.question, a.repo), contentWords(b.question, b.repo)) >= 0.7;
}

/**
 * Write the questions a step raised. One already on file (open, answered or retired) is left
 * as it is and returned in `known`: an answered question is not asked again. A question
 * another step already asked about the same repo, open or answered, with a line in common or
 * near-identical words, is reused (ADR 0089): the step is added to its `alsoAskedBy`, so it
 * reads the same answer, and the question is returned in `reused` (and in `known`).
 */
export async function raiseQuestions(
  root: string,
  drafts: QuestionDraft[],
  by: AskedBy,
): Promise<{ raised: Question[]; known: Question[]; reused: Question[] }> {
  const raised: Question[] = [];
  const known: Question[] = [];
  const reused: Question[] = [];
  let others: Question[] | undefined;
  for (const d of drafts) {
    const q = questionFromDraft(d, by);
    const existing = await readQuestion(root, q.id).catch(() => undefined);
    if (existing) {
      if (!known.some((k) => k.id === existing.id)) known.push(existing);
      continue;
    }
    if (raised.some((r) => r.id === q.id)) continue;
    others ??= (await listQuestions(root, { repo: by.repo })).questions;
    const same = others.find(
      (x) =>
        x.state !== "retired" &&
        x.askedBy.step !== by.step &&
        sameQuestion({ repo: by.repo, question: d.question, evidence: d.evidence }, x),
    );
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
        others = others.map((x) => (x.id === kept.id ? kept : x));
      }
      if (!reused.some((k) => k.id === kept.id)) reused.push(kept);
      if (!known.some((k) => k.id === kept.id)) known.push(kept);
      continue;
    }
    await write(root, q);
    raised.push(q);
  }
  return { raised, known, reused };
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
