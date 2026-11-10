import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import {
  answerByWords,
  changesDirOf,
  changesRelOf,
  QUESTION_SCHEMA_VERSION,
  Question,
  questionId,
  questionsRelOf,
  readQuestion,
  toCanonicalYaml,
  withSharedFileLock,
  writeFileAtomic,
  writeQuestion,
} from "@maycombhq/core";
import { PlannerError } from "../errors.js";
import { readStageLoop, updateStageLoop } from "./loop.js";
import { rerunOf } from "./waiting.js";
import type { Stage } from "./schema.js";

/**
 * ADR 0189: a stage is one conversation. The app shows each stage of a change as one thread (the
 * prompt, the assistant's answer, the checks and the critic, the questions, and the person's
 * replies), assembled from the files that already hold them. Here are the two things the thread
 * adds, each written the way Atticus already keeps a person's words:
 *
 * - a reply ("Tell the assistant…") is a question the person answered as they asked it (ADR
 *   0078), as a comment on a finding is (comments.ts): listed in the stage's loop file, so the
 *   stage's next run reads it as a person's answer and hands it to the drafter. The proposal
 *   step has no loop file: its replies are listed in `stage/proposal-thread.yaml`, and the
 *   drafter reads them as data;
 * - a question the assistant raised whose evidence was no line (the loop keeps it in `dropped`)
 *   is kept anyway by a person, citing the nearest line of the file it named, or none.
 */

export const THREAD_STAGES = ["proposal", "feature", "architecture", "stories", "small"] as const;
export type ThreadStage = (typeof THREAD_STAGES)[number];

/** What a reply's question records as the command that asked it. */
export const REPLY_COMMAND = "atticus ui: a reply in the stage's thread";

/** The proposal step's own list of replies (it has no loop file). */
export const PROPOSAL_THREAD = "stage/proposal-thread.yaml";

const ProposalThread = z.strictObject({
  schemaVersion: z.literal(1),
  change: z.string(),
  replies: z.array(z.string()).default([]),
  /** The replies a draft has read, by question id. */
  read: z.array(z.string()).default([]),
});
type ProposalThread = z.infer<typeof ProposalThread>;

const stepOf = (stage: ThreadStage) => (stage === "proposal" ? "change-draft" : `change-${stage}`);

/** The command that runs the stage again, which reads the replies. */
export const threadRerun = (stage: ThreadStage, change: string) =>
  stage === "proposal" ? `atticus change draft ${change}` : rerunOf(stage, change);

async function readProposalThread(root: string, change: string): Promise<ProposalThread> {
  const text = await readFile(join(changesDirOf(root), change, PROPOSAL_THREAD), "utf8").catch(
    () => undefined,
  );
  if (text !== undefined) {
    const r = ProposalThread.safeParse(parse(text));
    if (r.success) return r.data;
  }
  return { schemaVersion: 1, change, replies: [], read: [] };
}

async function writeProposalThread(root: string, t: ProposalThread): Promise<void> {
  await writeFileAtomic(
    join(changesDirOf(root), t.change, PROPOSAL_THREAD),
    `# The proposal's thread (ADR 0189): the replies a person wrote to its drafter. Atticus writes this file.\n${toCanonicalYaml(ProposalThread.parse(t), ["schemaVersion", "change"])}`,
  );
}

export interface ThreadReply {
  question: string;
  text: string;
  by: string;
  at: string;
  /** A draft of the stage has read it. */
  read: boolean;
}

const isReply = (q: Question, stage: ThreadStage) =>
  q.askedBy.step === stepOf(stage) && q.askedBy.command === REPLY_COMMAND;

/** The reply questions listed for a stage, with whether a draft read each. */
async function replyQuestions(
  root: string,
  change: string,
  stage: ThreadStage,
): Promise<{ q: Question; read: boolean }[]> {
  let ids: string[];
  let read: string[];
  if (stage === "proposal") {
    const t = await readProposalThread(root, change);
    ids = t.replies;
    read = t.read;
  } else {
    const { loop } = await readStageLoop(join(changesDirOf(root), change), change, stage);
    ids = loop.questions;
    read = loop.read;
  }
  const out: { q: Question; read: boolean }[] = [];
  for (const id of ids) {
    const q = await readQuestion(root, id).catch(() => undefined);
    if (!q || !isReply(q, stage) || !q.answer?.text) continue;
    out.push({ q, read: read.includes(q.id) });
  }
  return out;
}

/** The replies on file for a stage, oldest first. */
export async function threadReplies(
  root: string,
  change: string,
  stage: ThreadStage,
): Promise<ThreadReply[]> {
  const out: ThreadReply[] = (await replyQuestions(root, change, stage)).map(({ q, read }) => ({
    question: q.id,
    text: q.answer!.text!,
    by: answerByWords(q.answer!.by),
    at: q.answer!.at,
    read,
  }));
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/** The proposal thread's file, whose lock its writers take. */
const proposalThreadFile = (root: string, change: string) =>
  join(changesDirOf(root), change, PROPOSAL_THREAD);

/**
 * The proposal's replies a draft read (draftChange calls it once the draft is written): only
 * those its prompt carried, so one sent while the draft ran or its hand-off waited stays unread
 * for the next draft (review of beta.23).
 */
export async function markProposalRepliesRead(
  root: string,
  change: string,
  carried: readonly string[],
): Promise<void> {
  await withSharedFileLock(proposalThreadFile(root, change), async () => {
    const t = await readProposalThread(root, change);
    const unread = t.replies.filter((r) => carried.includes(r) && !t.read.includes(r));
    if (!unread.length) return;
    await writeProposalThread(root, { ...t, read: [...t.read, ...unread].sort() });
  });
}

/** A reply sent again this soon, by the same person in the same words and still unread, is the same reply. */
export const REPLY_AGAIN_MS = 5000;

/**
 * Write a person's reply to the stage's assistant, as a question they answered, and list it where
 * the stage's next run reads it. A loop stage must have run (its loop file is there): otherwise
 * nothing would read the reply. The list is changed holding its file's lock, the lock the stage's
 * run takes to write it, so neither loses what the other wrote. The same words from the same
 * person within a few seconds, still unread, are a double submit: the reply on file is returned.
 */
export async function replyInStage(
  root: string,
  o: { change: string; stage: ThreadStage; text: string; by: string; at: string },
): Promise<{ question: Question; files: string[] }> {
  const text = o.text.trim();
  if (!text) throw new PlannerError("invalid", "Write what to tell the assistant first.");
  const dir = join(changesDirOf(root), o.change);
  const rel = `${changesRelOf(root)}/${o.change}`;
  const step = stepOf(o.stage);
  const staged = o.stage === "proposal" ? undefined : await readStageLoop(dir, o.change, o.stage);
  if (staged && !staged.present)
    throw new PlannerError(
      "refused",
      `The ${o.stage} stage of ${o.change} hasn't run yet, so nothing would read a reply: start it first.`,
    );
  const loopFile = staged ? staged.file : PROPOSAL_THREAD;
  const files = (id: string) => [`${questionsRelOf(root)}/${id}.yaml`, `${rel}/${loopFile}`];
  /** The reply on file this one sends again, or the new reply written. */
  const write = async (): Promise<{ q: Question; fresh: boolean }> => {
    const on = await replyQuestions(root, o.change, o.stage);
    const again = on.find(
      ({ q, read }) =>
        !read &&
        q.answer!.text === text &&
        q.answer!.by === o.by &&
        Math.abs(Date.parse(o.at) - Date.parse(q.answer!.at)) <= REPLY_AGAIN_MS,
    );
    if (again) return { q: again.q, fresh: false };
    const before = on.length;
    const question = `${before ? `Reply ${before + 1} in` : "A reply in"} the ${o.stage} stage's thread of ${o.change}: what does the person tell the assistant?`;
    const evidence = [`${rel}/${o.stage === "proposal" ? "brief.md" : loopFile}:1`];
    const q = Question.parse({
      schemaVersion: QUESTION_SCHEMA_VERSION,
      id: questionId({ step, repo: o.change, question: `${question}\n${o.at}`, evidence }),
      askedBy: { step, command: REPLY_COMMAND, at: o.at },
      repo: o.change,
      question,
      options: [],
      evidence,
      scope: { level: "repo", id: o.change },
      state: "answered",
      rerun: threadRerun(o.stage, o.change),
      answer: { text, by: o.by, at: o.at, scope: { level: "repo", id: o.change } },
    });
    await writeQuestion(root, q);
    return { q, fresh: true };
  };
  if (o.stage === "proposal") {
    const q = await withSharedFileLock(proposalThreadFile(root, o.change), async () => {
      const r = await write();
      if (r.fresh) {
        const t = await readProposalThread(root, o.change);
        await writeProposalThread(root, {
          ...t,
          replies: [...new Set([...t.replies, r.q.id])].sort(),
        });
      }
      return r.q;
    });
    return { question: q, files: files(q.id) };
  }
  const q = await updateStageLoop(dir, o.change, o.stage, async (loop) => {
    const r = await write();
    loop.questions = [...new Set([...loop.questions, r.q.id])].sort();
    return r.q;
  });
  return { question: q, files: files(q.id) };
}

/**
 * Keep a question the assistant raised that couldn't be kept (its evidence was no line): a person
 * keeps it anyway, citing the nearest line of the file it named, or, with none, the stage's loop
 * file. It is raised as the stage's own question, open, and leaves the dropped list.
 */
export async function keepDroppedQuestion(
  root: string,
  o: { change: string; stage: Stage; key: string; by: string; at: string },
): Promise<{ question: Question; files: string[] }> {
  const dir = join(changesDirOf(root), o.change);
  const rel = `${changesRelOf(root)}/${o.change}`;
  // Read, changed and written holding the loop file's lock, the lock the stage's run takes to
  // write it: a run under way neither drops the question nor brings it back to the dropped list.
  return updateStageLoop(dir, o.change, o.stage, async (loop, file) => {
    const d = (loop.dropped ?? []).find((x) => x.key === o.key);
    if (!d)
      throw new PlannerError(
        "refused",
        `The ${o.stage} stage of ${o.change} has no question it couldn't keep with the key ${o.key}.`,
      );
    const step = `change-${o.stage}`;
    const evidence = [d.nearest ?? `${rel}/${file}:1`];
    const q = Question.parse({
      schemaVersion: QUESTION_SCHEMA_VERSION,
      id: questionId({ step, repo: o.change, question: d.question, evidence }),
      askedBy: { step, command: rerunOf(o.stage, o.change), at: o.at },
      repo: o.change,
      question: d.question,
      options: [],
      evidence,
      scope: { level: "repo", id: o.change },
      state: "open",
      rerun: rerunOf(o.stage, o.change),
    });
    const had = await readQuestion(root, q.id).catch(() => undefined);
    if (!had) await writeQuestion(root, q);
    loop.questions = [...new Set([...loop.questions, q.id])].sort();
    loop.dropped = (loop.dropped ?? []).filter((x) => x.key !== o.key);
    if (!loop.dropped.length) delete loop.dropped;
    return {
      question: had ?? q,
      files: [`${questionsRelOf(root)}/${q.id}.yaml`, `${rel}/${file}`],
    };
  });
}
