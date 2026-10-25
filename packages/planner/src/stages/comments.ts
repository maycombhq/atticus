import { join } from "node:path";
import {
  changesDirOf,
  changesRelOf,
  QUESTION_SCHEMA_VERSION,
  Question,
  questionId,
  questionsRelOf,
  readQuestion,
  writeQuestion,
} from "@maycombhq/core";
import { PlannerError } from "../errors.js";
import { readStageLoop, rerunOf, writeStageLoop } from "./loop.js";
import type { Stage } from "./schema.js";

/**
 * A person's comment on a critic finding, from a stage tab in the app (ADR 0124 addendum D-app,
 * B10). It is recorded the way a person's answers already are (ADR 0078): a question about the
 * finding, answered with the person's words as they ask it, in `questions/<id>.yaml`, and listed
 * in the stage's loop file (`stage/<stage>.yaml`, ADR 0087). The stage's next run reads it as it
 * reads every answered question of the stage: a draft is made again, and the drafter gets the
 * comment in its hand-backs data block, as a person's answer to follow. Nothing here links the
 * comment to the loop's findings, so a comment never unblocks a finding by itself: the critic
 * still checks the next draft.
 */

/** What a comment's question records as the command that asked it. */
export const COMMENT_COMMAND = "atticus ui: a comment on a critic finding";

export interface CommentedFinding {
  id: string;
  rule: string;
  summary: string;
  artifact: string;
  line?: number;
  /** The finding's file, from the metarepo's root (`openspec/changes/<c>/review/<gate>/<n>/<id>.yaml`). */
  file: string;
}

export interface StageCommentRecord {
  question: string;
  text: string;
  by: string;
  at: string;
  /** A draft of the stage has read it. */
  read: boolean;
  /** The finding's file it is about. */
  about: string;
}

const isComment = (q: Question, stage: Stage) =>
  q.askedBy.step === `change-${stage}` && q.askedBy.command === COMMENT_COMMAND;

/** The finding file a comment's question is about: its evidence, less the line. */
const aboutOf = (q: Question) => q.evidence[0]!.replace(/:\d+$/, "");

/** The comments on file for a stage, and the ids of the stage's other questions. */
export async function stageComments(
  root: string,
  change: string,
  stage: Stage,
): Promise<{ comments: StageCommentRecord[]; others: string[]; present: boolean }> {
  const dir = join(changesDirOf(root), change);
  const { loop, present } = await readStageLoop(dir, change, stage);
  const comments: StageCommentRecord[] = [];
  const others: string[] = [];
  for (const id of loop.questions) {
    const q = await readQuestion(root, id).catch(() => undefined);
    if (!q) continue;
    if (isComment(q, stage) && q.answer?.text)
      comments.push({
        question: q.id,
        text: q.answer.text,
        by: q.answer.by,
        at: q.answer.at,
        read: loop.read.includes(q.id),
        about: aboutOf(q),
      });
    else others.push(q.id);
  }
  comments.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return { comments, others, present };
}

/**
 * Write a person's comment on a finding as a question they answered, and list it in the stage's
 * loop file. The stage must have run (its loop file is there): otherwise nothing would read it.
 */
export async function commentOnFinding(
  root: string,
  o: {
    change: string;
    stage: Stage;
    finding: CommentedFinding;
    text: string;
    by: string;
    at: string;
  },
): Promise<{ question: Question; files: string[] }> {
  const text = o.text.trim();
  if (!text) throw new PlannerError("invalid", "Write the comment first.");
  const dir = join(changesDirOf(root), o.change);
  const { loop, present, file } = await readStageLoop(dir, o.change, o.stage);
  if (!present)
    throw new PlannerError(
      "refused",
      `The ${o.stage} stage of ${o.change} hasn't run yet, so nothing would read a comment: run ${rerunOf(o.stage, o.change)} first.`,
    );
  const f = o.finding;
  const before = (await stageComments(root, o.change, o.stage)).comments.filter(
    (c) => c.about === f.file,
  ).length;
  const where = `${f.artifact}${f.line ? `:${f.line}` : ""}`;
  // Each comment is its own question, so a second comment is read as new by the next run.
  const question = `${before ? `Comment ${before + 1} on` : "A comment on"} the critic's finding ${f.id} (${f.rule}) at ${where}: "${f.summary}" What does the person say the next draft should do about it?`;
  const evidence = [`${f.file}:1`];
  const step = `change-${o.stage}`;
  const q = Question.parse({
    schemaVersion: QUESTION_SCHEMA_VERSION,
    id: questionId({ step, repo: o.change, question, evidence }),
    askedBy: { step, command: COMMENT_COMMAND, at: o.at },
    repo: o.change,
    question,
    options: [],
    evidence,
    scope: { level: "repo", id: o.change },
    state: "answered",
    rerun: rerunOf(o.stage, o.change),
    answer: { text, by: o.by, at: o.at, scope: { level: "repo", id: o.change } },
  });
  await writeQuestion(root, q);
  loop.questions = [...new Set([...loop.questions, q.id])].sort();
  await writeStageLoop(dir, loop);
  return {
    question: q,
    files: [`${questionsRelOf(root)}/${q.id}.yaml`, `${changesRelOf(root)}/${o.change}/${file}`],
  };
}
