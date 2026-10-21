import { createHash } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { writeFileAtomic } from "./fs.js";
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
          (!o.step || q.askedBy.step === o.step),
      )
      .sort((a, b) => a.askedBy.at.localeCompare(b.askedBy.at) || a.id.localeCompare(b.id)),
    problems,
  };
}

/**
 * Write the questions a step raised. One already on file (open, answered or retired) is left
 * as it is and returned in `known`: an answered question is not asked again.
 */
export async function raiseQuestions(
  root: string,
  drafts: QuestionDraft[],
  by: AskedBy,
): Promise<{ raised: Question[]; known: Question[] }> {
  const raised: Question[] = [];
  const known: Question[] = [];
  for (const d of drafts) {
    const q = questionFromDraft(d, by);
    const existing = await readQuestion(root, q.id).catch(() => undefined);
    if (existing) {
      if (!known.some((k) => k.id === existing.id)) known.push(existing);
      continue;
    }
    if (raised.some((r) => r.id === q.id)) continue;
    await write(root, q);
    raised.push(q);
  }
  return { raised, known };
}

/**
 * The skill file of a repo type, relative to the root, where a repo-type answer goes.
 * TODO(lead, repo types): repo types (plan Phase 2a, I10) are being added in parallel; point
 * this at the type's skill once `repo-types/<id>/` lands. Plan section 5 puts the skills in the
 * existing process/skills/<id>/SKILL.md format, so that is the path used until then.
 */
export function repoTypeSkillRel(root: string, type: string): string {
  return `${isAdopted(root) ? ".atticus/org-pack" : "org-pack"}/process/skills/${type}/SKILL.md`;
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
): Promise<{ question: Question; skill?: { path: string; written: boolean } }> {
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
  const skill = level === "repo-type" ? repoTypeSkillRel(root, scopeId) : undefined;
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
  await write(root, answered);
  if (!skill) return { question: answered };
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
