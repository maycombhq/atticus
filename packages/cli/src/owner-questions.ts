import { mkdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { parseArgs } from "node:util";
import {
  catalogDirOf,
  loadOrgPack,
  orgPackDirOf,
  orgPackRelOf,
  parseRecord,
  recordPath,
  serializeRecord,
  writeFileAtomic,
} from "@maycombhq/core";
import { knowledgeGaps, type KnowledgeGap } from "@maycombhq/knowledge";
import { gitUser } from "@maycombhq/workspace";
import type { Output } from "./commands.js";
import { catalogRecords } from "./site-commands.js";

/**
 * The knowledge gaps' owner questions (ADR 0021), answered (UX review, 2026-11-08). An answer is
 * a person's words, so it is written where a person's catalog decisions live and every scan keeps
 * them: `catalog/curated/ownerquestion/<id>.yaml`, the question's own record with the answer,
 * `questionState: answered` and manual evidence naming who. `knowledgeGaps` reads it back as the
 * question's answer. The gap itself stays until the fact is in the catalog: an answer alone never
 * closes it. The app's Questions page writes the same file through `answerOwnerQuestion`.
 */

export class OwnerQuestionError extends Error {
  constructor(
    message: string,
    readonly code: "invalid" | "not-found",
  ) {
    super(message);
  }
}

export interface OwnerQuestionItem {
  id: string;
  system: string;
  owner: string;
  question: string;
  neededFact: string;
  channel: string;
  state: "sent" | "answered" | "overdue";
  answer?: string;
  /** The role that takes it when nobody owns the system. */
  routeTo?: string;
  /** The org-pack files and fields that hold the fact, when a person writes it there. */
  fill?: { file: string; field: string; what: string }[];
  /** The catalog records it is about. */
  records: string[];
  /** Where an answer is written, relative to the metarepo. */
  file: string;
}

export interface OwnerQuestionList {
  /** The catalog has no records yet: nothing to ask. */
  empty: boolean;
  /** Questions not answered yet. */
  open: number;
  questions: OwnerQuestionItem[];
}

const rel = (root: string, p: string) => relative(root, p).split("\\").join("/");
const stamp = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

async function gaps(root: string, now: Date): Promise<KnowledgeGap[] | undefined> {
  const records = await catalogRecords(root);
  if (records.length === 0) return undefined;
  const orgPack = await loadOrgPack(orgPackDirOf(root));
  return knowledgeGaps({ records, orgPack, now: stamp(now) });
}

const fileOf = (root: string, id: string) =>
  join(catalogDirOf(root), "curated", ...recordPath({ kind: "OwnerQuestion", id }).split("/"));

function itemOf(root: string, g: KnowledgeGap): OwnerQuestionItem {
  const q = g.question;
  return {
    id: q.id,
    system: q.system,
    owner: q.owner,
    question: q.question,
    neededFact: q.neededFact,
    channel: q.channel,
    state: q.questionState,
    ...(q.answer ? { answer: q.answer } : {}),
    ...(g.routeTo ? { routeTo: g.routeTo } : {}),
    ...(g.fill?.length ? { fill: g.fill } : {}),
    records: g.records,
    file: rel(root, fileOf(root, q.id)),
  };
}

/** Every owner question the knowledge gaps raise now, answered or not, in the gaps' order. */
export async function ownerQuestions(
  root: string,
  o: { now?: Date } = {},
): Promise<OwnerQuestionList> {
  const found = await gaps(root, o.now ?? new Date());
  if (!found) return { empty: true, open: 0, questions: [] };
  const questions = found.map((g) => itemOf(root, g));
  return {
    empty: false,
    open: questions.filter((q) => q.state !== "answered").length,
    questions,
  };
}

/** Records a person's answer to one owner question, as `atticus questions owner` does. */
export async function answerOwnerQuestion(
  root: string,
  id: string,
  answer: string,
  o: { by: string; now?: Date },
): Promise<{ file: string; question: OwnerQuestionItem }> {
  const words = answer.trim();
  if (!words)
    throw new OwnerQuestionError("The answer is empty: say what the owner said.", "invalid");
  if (!o.by.trim()) throw new OwnerQuestionError("Say who answered (--by).", "invalid");
  const now = o.now ?? new Date();
  const found = (await gaps(root, now)) ?? [];
  const g = found.find((x) => x.question.id === id);
  if (!g)
    throw new OwnerQuestionError(
      `There is no owner question ${id} now: atticus questions lists the open ones.`,
      "not-found",
    );
  const p = parseRecord({
    ...g.question,
    confidence: "asserted",
    questionState: "answered",
    answer: words,
    evidence: [
      { source: "manual", by: o.by.trim(), scannedAt: stamp(now) },
      ...g.question.evidence,
    ],
  });
  if (!p.ok)
    throw new OwnerQuestionError(
      `The answer can't be recorded: ${JSON.stringify(p.issues)}`,
      "invalid",
    );
  const full = fileOf(root, id);
  await mkdir(dirname(full), { recursive: true });
  await writeFileAtomic(full, serializeRecord(p.record));
  const question = itemOf(root, {
    ...g,
    question: { ...g.question, questionState: "answered", answer: words },
  });
  return { file: question.file, question };
}

/** atticus questions owner <id> --text "..." [--by who] [--json] */
export async function ownerQuestionCommand(
  root: string,
  argv: string[],
  io: Output,
  deps: { now?: Date } = {},
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      root: { type: "string" },
      text: { type: "string" },
      by: { type: "string" },
      json: { type: "boolean" },
    },
  });
  const id = positionals[2];
  const text = typeof values.text === "string" ? values.text : undefined;
  if (!id || text === undefined) {
    io.err('Usage: atticus questions owner <id> --text "..." [--by who] [--json]');
    return 2;
  }
  const by = (typeof values.by === "string" && values.by.trim()) || (await gitUser(root)).handle;
  try {
    const r = await answerOwnerQuestion(root, id, text, {
      by,
      ...(deps.now ? { now: deps.now } : {}),
    });
    if (values.json === true) io.out(JSON.stringify(r, null, 2));
    else {
      io.out(`Wrote ${r.file}: ${by}'s answer to ${id}. Every scan keeps it.`);
      io.out(
        r.question.fill?.length
          ? `The gap closes once the fact is in the catalog: write it in ${r.question.fill.map((f) => `${orgPackRelOf(root)}/${f.file}: ${f.field}`).join("; ")}.`
          : `The gap closes once the fact is in the catalog: ${r.question.neededFact}.`,
      );
      io.out(
        "Then propose it for review (the app's Propose for review, or commit it in a pull request).",
      );
    }
    return 0;
  } catch (e) {
    if (e instanceof OwnerQuestionError) {
      io.err(e.message);
      return e.code === "invalid" ? 2 : 1;
    }
    throw e;
  }
}
