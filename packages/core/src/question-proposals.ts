import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { proposalsDirOf, proposalsRelOf } from "./metarepo.js";
import { checkoutDirOf } from "./repo-reads.js";
import { answerQuestion, QuestionError, quotedIn, readQuestion } from "./questions.js";
import { IsoDateTime } from "./schema/common.js";
import { QuestionId, QuestionScopeLevel, type Question } from "./schema/question.js";

/**
 * The assistant proposes, a person confirms (ADR 0144, Q5). The `/atticus-propose` step reads the
 * code and config behind each open question and writes a proposed answer beside it, in
 * `proposals/questions/<id>.yaml` (under `.atticus/` in a repo adopted in place), with the lines
 * it rests on. It never answers: the question file is untouched until a person accepts.
 *
 * Every citation is checked here, deterministically, before a proposal is shown: the file is in
 * the question's repo (its checkout, or the metarepo when the repo has none, as for a change's
 * own question), the line is there, and the quoted words are on it (spacing, curly quotes and case
 * aside, as `quotedIn`). A proposal that fails is never shown as a proposal, only as its problems.
 * `acceptProposal` checks it again and records the answer as the person's (`answerQuestion`).
 *
 * * The proposals folder holds drafts for a person to review, not a contract: the
 * question file's format is unchanged.
 */

export const QUESTION_PROPOSAL_SCHEMA_VERSION = 1 as const;

/** A line the proposal rests on. */
export const ProposalCite = z.strictObject({
  /** The repo the file is in; the question's own when left out. */
  repo: z.string().trim().min(1).optional(),
  file: z.string().trim().min(1),
  line: z.number().int().min(1),
  /** The words on that line the proposal rests on. */
  quote: z.string().trim().min(1),
});
export type ProposalCite = z.infer<typeof ProposalCite>;

export const QuestionProposal = z.strictObject({
  schemaVersion: z.literal(QUESTION_PROPOSAL_SCHEMA_VERSION),
  /** One of the question's options, counting from 1, or an answer in words. */
  answer: z
    .strictObject({
      option: z.number().int().min(1).optional(),
      text: z.string().trim().min(1).optional(),
    })
    .refine((a) => (a.option === undefined) !== (a.text === undefined), {
      message: "a proposed answer is one option or words, not both or neither",
    }),
  /** Why, in two or three sentences, from what the cited lines say. */
  why: z.string().trim().min(1),
  cites: z.array(ProposalCite).min(1),
  /** The assistant that proposed it. */
  by: z.string().trim().min(1),
  at: IsoDateTime,
});
export type QuestionProposal = z.infer<typeof QuestionProposal>;

/** Where a question's proposal lives, relative to the root. */
export const proposalRelOf = (root: string, id: string) =>
  `${proposalsRelOf(root)}/questions/${id}.yaml`;

const proposalsQuestionsDir = (root: string) => join(proposalsDirOf(root), "questions");

/** A proposal as read and checked. `ok` only when it read and every check passed. */
export interface CheckedProposal {
  id: string;
  /** Relative to the root. */
  file: string;
  proposal?: QuestionProposal;
  ok: boolean;
  /** Its question is answered, retired or gone: nothing to propose. */
  stale?: true;
  problems: string[];
}

const isFile = (p: string) =>
  stat(p).then(
    (s) => s.isFile(),
    () => false,
  );
const isDir = (p: string) =>
  stat(p).then(
    (s) => s.isDirectory(),
    () => false,
  );

/** A cited path as it is within its repo; undefined for one that leaves it. */
function inRepo(file: string): string | undefined {
  const p = file.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!p || p.startsWith("/") || /^[A-Za-z]:/.test(p) || p.split("/").includes(".."))
    return undefined;
  return p;
}

/** The problems of one proposal against its question and the files it cites; none: it holds. */
export async function checkProposal(
  root: string,
  q: Question,
  p: QuestionProposal,
): Promise<string[]> {
  const problems: string[] = [];
  const option = p.answer.option;
  if (option !== undefined && option > q.options.length)
    problems.push(
      q.options.length
        ? `There is no option ${option}: pick 1 to ${q.options.length}.`
        : `There is no option ${option}: this question has no options, so propose an answer in words.`,
    );
  const lines = new Map<string, string[]>();
  for (const c of p.cites) {
    const repo = c.repo ?? q.repo;
    const rel = inRepo(c.file);
    if (!rel) {
      problems.push(`${c.file} leaves the repo: cite a file in it.`);
      continue;
    }
    const checkout = checkoutDirOf(root, repo);
    // A change's own question (or a repo with no checkout here) cites the metarepo's files.
    const base = (await isDir(checkout)) ? checkout : root;
    const path = join(base, ...rel.split("/"));
    if (!(await isFile(path))) {
      problems.push(`${rel} isn't in ${repo}.`);
      continue;
    }
    const key = `${repo}\u0000${rel}`;
    if (!lines.has(key))
      lines.set(key, (await readFile(path, "utf8")).replace(/\r\n/g, "\n").split("\n"));
    const text = lines.get(key)!;
    const count = text.at(-1) === "" ? text.length - 1 : text.length;
    if (c.line > count) {
      problems.push(
        `${rel} has ${count} line${count === 1 ? "" : "s"}, so there is no line ${c.line}.`,
      );
      continue;
    }
    if (!quotedIn(text[c.line - 1]!, c.quote))
      problems.push(`${rel}:${c.line} doesn't say "${c.quote}".`);
  }
  return problems;
}

/** Every proposal on file, each read and checked against its question; by question id. */
export async function checkedProposals(root: string): Promise<CheckedProposal[]> {
  const names = (await readdir(proposalsQuestionsDir(root)).catch(() => [] as string[]))
    .filter((n) => n.endsWith(".yaml"))
    .sort();
  const out: CheckedProposal[] = [];
  for (const n of names) {
    const id = n.slice(0, -".yaml".length);
    const file = proposalRelOf(root, id);
    if (!QuestionId.safeParse(id).success) {
      out.push({ id, file, ok: false, problems: [`${n} isn't named for a question id (q-…).`] });
      continue;
    }
    out.push(await checkOne(root, id));
  }
  return out;
}

async function checkOne(root: string, id: string): Promise<CheckedProposal> {
  const file = proposalRelOf(root, id);
  const raw = await readFile(join(proposalsQuestionsDir(root), `${id}.yaml`), "utf8").catch(
    () => undefined,
  );
  if (raw === undefined) return { id, file, ok: false, problems: [] };
  let data: unknown;
  try {
    data = parse(raw);
  } catch (e) {
    return {
      id,
      file,
      ok: false,
      problems: [`It doesn't read: ${(e as Error).message.split("\n")[0]}`],
    };
  }
  const r = QuestionProposal.safeParse(data);
  if (!r.success)
    return {
      id,
      file,
      ok: false,
      problems: r.error.issues.map((i) => `${i.path.join(".") || "(top)"}: ${i.message}`),
    };
  const q = await readQuestion(root, id).catch(() => undefined);
  if (!q || q.state !== "open")
    return {
      id,
      file,
      proposal: r.data,
      ok: false,
      stale: true,
      problems: [
        q
          ? `${id} is ${q.state}, so there is nothing to propose: remove ${file}.`
          : `There is no question ${id}: remove ${file}.`,
      ],
    };
  const problems = await checkProposal(root, q, r.data);
  return { id, file, proposal: r.data, ok: problems.length === 0, problems };
}

/** One question's proposal, checked; undefined when there is none. */
export async function proposalOf(root: string, id: string): Promise<CheckedProposal | undefined> {
  const got = await checkOne(root, id);
  return got.proposal || got.problems.length ? got : undefined;
}

/**
 * A person accepts the proposal: checked again, then written as their answer, by them, at the
 * scope they confirm (the question's own by default). Refused when there is none or it fails.
 */
export async function acceptProposal(
  root: string,
  id: string,
  a: { by: string; at: string; scope?: QuestionScopeLevel; repoType?: string },
): ReturnType<typeof answerQuestion> {
  const p = await proposalOf(root, id);
  if (!p?.proposal)
    throw new QuestionError(
      "not-found",
      `${id} has no proposed answer: /atticus-propose writes one to ${proposalRelOf(root, id)}.`,
    );
  if (!p.ok)
    throw new QuestionError(
      "bad-answer",
      `The proposed answer to ${id} doesn't check, so it can't be accepted: ${p.problems.join(" ")}`,
    );
  return answerQuestion(root, id, {
    ...(p.proposal.answer.option !== undefined
      ? { option: p.proposal.answer.option }
      : { text: p.proposal.answer.text! }),
    ...(a.scope ? { scope: a.scope } : {}),
    ...(a.repoType ? { repoType: a.repoType } : {}),
    by: a.by,
    at: a.at,
  });
}
