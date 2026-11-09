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
  writeFileAtomic,
  writeQuestion,
} from "@maycombhq/core";
import { PlannerError } from "../errors.js";
import { readStageLoop, writeStageLoop } from "./loop.js";
import { rerunOf } from "./waiting.js";
import type { Stage } from "./schema.js";

/**
 * ADR 0188: a stage is one conversation. The app shows each stage of a change as one thread (the
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
    `# The proposal's thread (ADR 0188): the replies a person wrote to its drafter. Atticus writes this file.\n${toCanonicalYaml(ProposalThread.parse(t), ["schemaVersion", "change"])}`,
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

/** The replies on file for a stage, oldest first. */
export async function threadReplies(
  root: string,
  change: string,
  stage: ThreadStage,
): Promise<ThreadReply[]> {
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
  const out: ThreadReply[] = [];
  for (const id of ids) {
    const q = await readQuestion(root, id).catch(() => undefined);
    if (!q || !isReply(q, stage) || !q.answer?.text) continue;
    out.push({
      question: q.id,
      text: q.answer.text,
      by: answerByWords(q.answer.by),
      at: q.answer.at,
      read: read.includes(q.id),
    });
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/** The proposal's replies a draft read (draftChange calls it once the draft is written). */
export async function markProposalRepliesRead(root: string, change: string): Promise<void> {
  const t = await readProposalThread(root, change);
  const unread = t.replies.filter((r) => !t.read.includes(r));
  if (!unread.length) return;
  await writeProposalThread(root, { ...t, read: [...t.read, ...unread].sort() });
}

/**
 * Write a person's reply to the stage's assistant, as a question they answered, and list it where
 * the stage's next run reads it. A loop stage must have run (its loop file is there): otherwise
 * nothing would read the reply.
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
  const before = (await threadReplies(root, o.change, o.stage)).length;
  const loopFile =
    o.stage === "proposal" ? PROPOSAL_THREAD : (await readStageLoop(dir, o.change, o.stage)).file;
  if (o.stage !== "proposal" && !(await readStageLoop(dir, o.change, o.stage)).present)
    throw new PlannerError(
      "refused",
      `The ${o.stage} stage of ${o.change} hasn't run yet, so nothing would read a reply: start it first.`,
    );
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
  if (o.stage === "proposal") {
    const t = await readProposalThread(root, o.change);
    await writeProposalThread(root, { ...t, replies: [...new Set([...t.replies, q.id])].sort() });
  } else {
    const { loop } = await readStageLoop(dir, o.change, o.stage);
    loop.questions = [...new Set([...loop.questions, q.id])].sort();
    await writeStageLoop(dir, loop);
  }
  return {
    question: q,
    files: [`${questionsRelOf(root)}/${q.id}.yaml`, `${rel}/${loopFile}`],
  };
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
  const { loop, file } = await readStageLoop(dir, o.change, o.stage);
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
  await writeStageLoop(dir, loop);
  return {
    question: had ?? q,
    files: [`${questionsRelOf(root)}/${q.id}.yaml`, `${rel}/${file}`],
  };
}
