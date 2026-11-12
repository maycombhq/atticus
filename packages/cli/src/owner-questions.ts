import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { parseArgs } from "node:util";
import { parse } from "yaml";
import {
  answerQuestion,
  catalogDirOf,
  type CatalogRecord,
  changesDirOf,
  Finding,
  listQuestions,
  loadOrgPack,
  type ManualStep,
  QuestionError,
  questionsRelOf,
  readTeams,
  type Question,
  orgPackDirOf,
  orgPackRelOf,
  parseRecord,
  recordPath,
  serializeRecord,
  stateDirOf,
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
  /**
   * Beta.27 review of the fix: its Send made a manual step still open (approval ref
   * `owner-ask:<id>`): asked, waiting for a person to send it.
   */
  asked?: { step: string; at: string };
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

async function gapsOf(
  root: string,
  now: Date,
): Promise<{ gaps?: KnowledgeGap[]; records: CatalogRecord[] }> {
  const records = await catalogRecords(root);
  if (records.length === 0) return { records };
  const orgPack = await loadOrgPack(orgPackDirOf(root));
  return { gaps: knowledgeGaps({ records, orgPack, now: stamp(now) }), records };
}

async function gaps(root: string, now: Date): Promise<KnowledgeGap[] | undefined> {
  return (await gapsOf(root, now)).gaps;
}

const fileOf = (root: string, id: string) =>
  join(catalogDirOf(root), "curated", ...recordPath({ kind: "OwnerQuestion", id }).split("/"));

/**
 * Review of the fix, round 2 (beta.27): when an unanswered question's own record says it was sent,
 * its newest manual evidence (each send puts one first). A record that came with the metarepo
 * (another person's send, merged) says it as one this machine wrote does.
 */
export function sentOnRecord(r: CatalogRecord | undefined): string | undefined {
  if (!r || r.kind !== "OwnerQuestion" || r.questionState === "answered") return undefined;
  let newest: { at: string; t: number } | undefined;
  for (const e of r.evidence) {
    if (e.source !== "manual" || !e.scannedAt) continue;
    const t = Date.parse(e.scannedAt);
    if (!Number.isNaN(t) && (!newest || t > newest.t)) newest = { at: e.scannedAt, t };
  }
  return newest?.at;
}

/** The question's own curated record, when there is one that reads. */
async function curatedRecord(root: string, id: string): Promise<CatalogRecord | undefined> {
  const text = await readFile(fileOf(root, id), "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  try {
    const p = parseRecord(parse(text));
    return p.ok ? p.record : undefined;
  } catch {
    return undefined;
  }
}

/** When the question's own record says it was sent (the send route asks before a live send). */
export async function recordedSendAt(root: string, id: string): Promise<string | undefined> {
  return sentOnRecord(await curatedRecord(root, id));
}

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

/** The approval ref a send of an owner question carries (and its manual step keeps). */
export const ownerAskRef = (id: string) => `owner-ask:${id}`;

/**
 * Beta.27 review of the fix: the owner questions whose Send made a manual step still open (Home ›
 * Manual steps), by question id, the newest step each. The steps are files in the metarepo, so a
 * reload and another person's machine say Asked as this one does. Nothing when they don't read.
 */
async function openAskSteps(root: string): Promise<Map<string, { step: string; at: string }>> {
  const out = new Map<string, { step: string; at: string }>();
  const { fileStepStore } = await import("@maycombhq/adapters");
  const open = await fileStepStore(root)
    .list({ action: "send-notification", state: "open" })
    .catch(() => []);
  for (const s of open) {
    const ref = s.approval?.ref;
    if (ref?.startsWith(ownerAskRef(""))) {
      out.set(ref.slice(ownerAskRef("").length), { step: s.id, at: s.createdAt });
    }
  }
  return out;
}

/**
 * Beta.27 review of the fix: a manual step that sent an owner question, marked done by a person,
 * is a send on record (`recordOwnerSend`, as a live send writes), so every machine says Sent and
 * overdue can come. Other steps, and a skipped one, write nothing. Returns the record's path.
 */
export async function recordStepSend(
  root: string,
  s: ManualStep,
  now?: Date,
): Promise<string | undefined> {
  const ref = s.approval?.ref;
  if (s.state !== "done" || s.action !== "send-notification" || !s.recorded) return undefined;
  if (!ref?.startsWith(ownerAskRef(""))) return undefined;
  const channel = s.inputs?.["channel"];
  return recordOwnerSend(root, ref.slice(ownerAskRef("").length), {
    by: s.recorded.by,
    at: s.recorded.at,
    to: typeof channel === "string" ? channel : "",
    ...(now ? { now } : {}),
  });
}

/** Every owner question the knowledge gaps raise now, answered or not, in the gaps' order. */
export async function ownerQuestions(
  root: string,
  o: { now?: Date } = {},
): Promise<OwnerQuestionList> {
  const { gaps: found, records } = await gapsOf(root, o.now ?? new Date());
  const asked = await askedGapItems(root);
  if (!found && !asked.length) return { empty: true, open: 0, questions: [] };
  // Beta.27 review: a team by its name ("Ledger team"), never only its id ("team-ledger").
  const teams = (
    await readTeams(root).catch(() => ({ teams: [] as { id: string; name: string }[] }))
  ).teams;
  // Review of the fix: a question the gaps raise is said sent only once it was (a send on file).
  // Round 2: on file is the question's own record, which every machine reads once it is merged;
  // this machine's note in .index only stands in before then (a record reverted, say).
  const onRecord = new Map<string, string>();
  for (const r of records) {
    const at = sentOnRecord(r);
    if (at) onRecord.set(r.id, at);
  }
  const sends = await readOwnerAsks(root);
  const steps = await openAskSteps(root);
  const questions = [...asked, ...(found ?? []).map((g) => itemOf(root, g))].map((q) => {
    const name = teams.find((t) => t.id === q.owner)?.name;
    const sentAt = q.sentAt ?? onRecord.get(q.id) ?? sends[q.id]?.at;
    const step = steps.get(q.id);
    return {
      ...q,
      ...(name && name !== q.owner ? { ownerName: name } : {}),
      ...(sentAt ? { sentAt } : {}),
      ...(step ? { asked: step } : {}),
    };
  });
  return {
    empty: false,
    open: questions.filter((q) => q.state !== "answered").length,
    questions,
  };
}

/**
 * Review of the fix (beta.27): the owner questions this machine sent through the notify adapter,
 * by id, with when, kept in .index, which Git ignores. Round 2: only a hint now; a send is on
 * file in the question's own record (`recordOwnerSend`), which every machine reads.
 */
const asksFile = (root: string) => join(stateDirOf(root), ".index", "owner-asks.json");

async function readOwnerAsks(root: string): Promise<Record<string, { at: string; to?: string }>> {
  try {
    const j = JSON.parse(await readFile(asksFile(root), "utf8")) as unknown;
    return j && typeof j === "object" ? (j as Record<string, { at: string; to?: string }>) : {};
  } catch {
    return {};
  }
}

/** Notes that an owner question was sent to its owner (the send route, once the adapter took it). */
export async function recordOwnerAsk(
  root: string,
  id: string,
  sent: { at: string; to: string },
): Promise<void> {
  const all = await readOwnerAsks(root);
  all[id] = sent;
  await mkdir(dirname(asksFile(root)), { recursive: true });
  await writeFileAtomic(asksFile(root), JSON.stringify(all, null, 2) + "\n");
}

/**
 * Review of the fix, round 2 (beta.27): a send is on file where every machine reads it, the
 * question's own record `catalog/curated/ownerquestion/<id>.yaml`, written as an answer is:
 * `questionState: sent` (overdue and answered stay as they are) and manual evidence first, naming
 * who sent it and when. A "sent" kept per machine let a second person send it again. The record
 * goes for review with the owner answers' Propose. A critic gap's question (on file in the
 * questions) has no such record: only this machine's note is kept for it. Returns the record's
 * metarepo-relative path, when one was written.
 */
export async function recordOwnerSend(
  root: string,
  id: string,
  sent: { by: string; at: string; to: string; now?: Date },
): Promise<string | undefined> {
  await recordOwnerAsk(root, id, { at: sent.at, to: sent.to }).catch(() => undefined);
  const { gaps: found, records } = await gapsOf(root, sent.now ?? new Date());
  const g = found?.find((x) => x.question.id === id);
  if (!g) return undefined;
  const prior = records.find((r) => r.kind === "OwnerQuestion" && r.id === id);
  // Earlier sends stay on file after the new one, each once.
  const scanned = new Set(g.question.evidence.map((e) => JSON.stringify(e)));
  const before = (prior?.evidence ?? []).filter(
    (e) => e.source === "manual" && !scanned.has(JSON.stringify(e)),
  );
  const p = parseRecord({
    ...g.question,
    confidence: "asserted",
    questionState: g.question.questionState,
    evidence: [
      { source: "manual", by: sent.by, scannedAt: sent.at },
      ...before,
      ...g.question.evidence,
    ],
  });
  if (!p.ok)
    throw new OwnerQuestionError(
      `The send can't be recorded: ${JSON.stringify(p.issues)}`,
      "invalid",
    );
  const full = fileOf(root, id);
  await mkdir(dirname(full), { recursive: true });
  await writeFileAtomic(full, serializeRecord(p.record));
  return rel(root, full);
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
