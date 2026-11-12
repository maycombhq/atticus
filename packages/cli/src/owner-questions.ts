import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { parseArgs } from "node:util";
import { parse } from "yaml";
import {
  answerQuestion,
  catalogDirOf,
  changesDirOf,
  Finding,
  listQuestions,
  loadOrgPack,
  QuestionError,
  questionsRelOf,
  readTeams,
  type Question,
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
  /** Beta.27 review: the owner's display name (teams.yaml), when the owner is a team named there. */
  ownerName?: string;
  /** Beta.27 review: when it was asked, when that is on file (a question a person's Ask raised). */
  sentAt?: string;
  /** The role that takes it when nobody owns the system. */
  routeTo?: string;
  /** The org-pack files and fields that hold the fact, when a person writes it there. */
  fill?: { file: string; field: string; what: string }[];
  /** The catalog records it is about. */
  records: string[];
  /** Where an answer is written, relative to the metarepo. */
  file: string;
  /**
   * Ninth UX walk: a critic knowledge gap a person asked of its owner (Ask on the finding): the
   * change, gate and finding. Its answer is the person's answer to the question on file, and
   * closes the gap at the gate.
   */
  finding?: { change: string; gate: string; id: string };
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

/** The summary of the gap an asked question is about, read from its finding file. */
async function gapSummary(root: string, f: NonNullable<Question["finding"]>): Promise<string> {
  const path = join(
    changesDirOf(root),
    f.change,
    "review",
    f.gate,
    String(f.round),
    `${f.id}.yaml`,
  );
  const text = await readFile(path, "utf8").catch(() => undefined);
  const r = text === undefined ? undefined : Finding.safeParse(parse(text));
  return r?.success ? r.data.summary : `Knowledge gap ${f.id} at the ${f.gate} gate.`;
}

/**
 * Ninth UX walk: the owner questions a person's Ask raised for critic knowledge gaps (questions on
 * file with `finding`), open first; a retired one is left out.
 */
async function askedGapItems(root: string): Promise<OwnerQuestionItem[]> {
  const { questions } = await listQuestions(root).catch(() => ({ questions: [] as Question[] }));
  const out: OwnerQuestionItem[] = [];
  for (const q of questions) {
    if (!q.finding || q.state === "retired") continue;
    out.push({
      id: q.id,
      system: q.finding.change,
      owner: q.askedOf ?? "its owner",
      question: q.question,
      neededFact: await gapSummary(root, q.finding),
      channel: "Atticus",
      state: q.state === "answered" ? "answered" : "sent",
      ...(q.askedBy?.at ? { sentAt: q.askedBy.at } : {}),
      ...(q.answer?.text ? { answer: q.answer.text } : {}),
      records: [],
      file: `${questionsRelOf(root)}/${q.id}.yaml`,
      finding: { change: q.finding.change, gate: q.finding.gate, id: q.finding.id },
    });
  }
  return out.sort((a, b) => Number(a.state === "answered") - Number(b.state === "answered"));
}

/** Every owner question the knowledge gaps raise now, answered or not, in the gaps' order. */
export async function ownerQuestions(
  root: string,
  o: { now?: Date } = {},
): Promise<OwnerQuestionList> {
  const found = await gaps(root, o.now ?? new Date());
  const asked = await askedGapItems(root);
  if (!found && !asked.length) return { empty: true, open: 0, questions: [] };
  // Beta.27 review: a team by its name ("Ledger team"), never only its id ("team-ledger").
  const teams = (
    await readTeams(root).catch(() => ({ teams: [] as { id: string; name: string }[] }))
  ).teams;
  const questions = [...asked, ...(found ?? []).map((g) => itemOf(root, g))].map((q) => {
    const name = teams.find((t) => t.id === q.owner)?.name;
    return name && name !== q.owner ? { ...q, ownerName: name } : q;
  });
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
  // Ninth UX walk: a critic gap's owner question is a question on file: the person's answer is
  // written to it, and closes the gap at the gate.
  const onFile = (await askedGapItems(root)).find((x) => x.id === id);
  if (onFile) {
    try {
      await answerQuestion(root, id, { text: words, by: o.by.trim(), at: stamp(now) });
    } catch (e) {
      if (e instanceof QuestionError) throw new OwnerQuestionError(e.message, "invalid");
      throw e;
    }
    const question = (await askedGapItems(root)).find((x) => x.id === id)!;
    return { file: question.file, question };
  }
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
    else if (r.question.finding)
      // Ninth UX walk: a critic gap's owner question: the answer closes the gap at its gate.
      io.out(
        `Wrote ${r.file}: ${by}'s answer to ${id}. Knowledge gap ${r.question.finding.id} is closed at the ${r.question.finding.gate} gate; the next draft of ${r.question.finding.change} reads the answer.`,
      );
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
