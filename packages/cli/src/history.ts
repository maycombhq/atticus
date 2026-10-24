import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Document, isMap, parse, parseDocument } from "yaml";
import { Api, changesDirOf, ensureLocalIgnore, orgPackDirOf, redactText } from "@maycombhq/core";

/**
 * The prompt and response history (ADR 0110): what a person types to their assistant in a
 * metarepo and what it answered, one record per line in `.atticus/history/<yyyy-mm>.jsonl`. The
 * folder is local to this machine (`.atticus/.gitignore`), so the history is never committed.
 * A record's text is data, never instructions: nothing here reads it as anything but text.
 */

export type HistoryRecord = Api.HistoryRecord;
export type HistoryTurn = Api.HistoryTurn;

/** The folder of the history files. */
export const historyDirOf = (root: string) => join(root, ".atticus", "history");
const ME = (root: string) => join(root, ".atticus", "me.yaml");

/** An id `history add` writes; nothing else is looked up as a record. */
export const HISTORY_ID = /^h-\d{14}-[0-9a-f]{6}$/;

/** Text cut at 64 KB on a whole character, with its size in bytes as given. */
export function cutText(
  text: string,
  max = Api.HISTORY_TEXT_MAX_BYTES,
): { text: string; size: number; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= max) return { text, size: bytes.length, truncated: false };
  // A character cut in two decodes as U+FFFD: drop it.
  const cut = bytes.subarray(0, max).toString("utf8").replace(/�+$/, "");
  return { text: cut, size: bytes.length, truncated: true };
}

/** The local log's secret patterns (ADR 0050) over the text: what matches is masked, and said. */
export function maskSecrets(text: string): { text: string; masked: boolean } {
  // The log's opaque-key pattern looks ahead along a run of key characters from every place in
  // it, so a very long run (a pasted blob) takes time by the square of its length. A run that
  // long is judged here by the same rule (digits, upper and lower case) and kept out of the way.
  const kept: string[] = [];
  let long = false;
  const shielded = text.replace(/[A-Za-z0-9+_-]{257,}={0,2}/g, (run) => {
    if (/\d/.test(run) && /[A-Z]/.test(run) && /[a-z]/.test(run)) {
      long = true;
      return "***";
    }
    kept.push(run);
    // Private-use characters around its place: nothing a person types, and no secret pattern's.
    return `${kept.length - 1}`;
  });
  // Only the secret patterns: a home folder or a user name in a prompt is the person's own words.
  const red = redactText(shielded, { home: "", user: "" });
  const out = red.replace(/(\d+)/g, (_, i: string) => kept[Number(i)]!);
  return { text: out, masked: long || red !== shielded };
}

/** The changes of the metarepo: the folders under openspec/changes with a change.yaml. */
export async function changeIds(root: string): Promise<string[]> {
  const dir = changesDirOf(root);
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter(
      (e) =>
        e.isDirectory() && e.name !== "archive" && existsSync(join(dir, e.name, "change.yaml")),
    )
    .map((e) => e.name)
    .sort();
}

/** The change of the metarepo's branch `change/<id>`, read from .git without running git. */
export async function branchChange(root: string): Promise<string | undefined> {
  let git = join(root, ".git");
  const asFile = await readFile(git, "utf8").catch(() => undefined);
  // A worktree or a submodule: .git is a file naming the real folder.
  const m = asFile !== undefined ? /^gitdir:\s*(.+)$/m.exec(asFile) : null;
  if (m) git = resolve(root, m[1]!.trim());
  const head = await readFile(join(git, "HEAD"), "utf8").catch(() => "");
  const b = /^ref: refs\/heads\/change\/([a-z0-9][a-z0-9-]*)\s*$/m.exec(head);
  return b?.[1];
}

/** Whether recording is on: off when runtime.yaml or this machine's me.yaml says record: false. */
export async function recordingOf(root: string): Promise<Api.HistoryRecording> {
  const said = async (file: string) => {
    const text = await readFile(file, "utf8").catch(() => undefined);
    if (!text) return undefined;
    try {
      const y = parse(text) as { history?: { record?: unknown } } | null;
      return y?.history?.record;
    } catch {
      return undefined;
    }
  };
  if ((await said(join(orgPackDirOf(root), "runtime.yaml"))) === false)
    return { on: false, offBy: "org-pack" };
  if ((await said(ME(root))) === false) return { on: false, offBy: "local" };
  return { on: true };
}

/** `atticus history on|off`: this machine's setting, in .atticus/me.yaml, the rest of it kept. */
export async function setLocalRecording(root: string, on: boolean): Promise<void> {
  const file = ME(root);
  const text = await readFile(file, "utf8").catch(() => "");
  let doc: Document = parseDocument(text);
  if (!isMap(doc.contents)) doc = new Document({});
  doc.setIn(["history", "record"], on);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, doc.toString(), "utf8");
  await ensureLocalIgnore(root);
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const stamp = (d: Date) =>
  `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;

export interface HistoryInput {
  surface: Api.HistorySurface;
  kind: Api.HistoryKind;
  text: string;
  session?: string;
  command?: string;
  /** The change the surface says the turn is about (a step it ran on that change). */
  change?: string;
  now?: Date;
  /** Six hex digits for the id; random by default. */
  random?: () => string;
}

/**
 * Append one record, unless recording is off. Its change is only ever an explicit one: the one
 * the surface passes (when it is one of the metarepo's changes), else the branch change/<id>,
 * else none. What the text is about is never guessed from its words (a short id such as "fix"
 * would tag unrelated prompts). Its command is the one given, else a prompt's leading /word.
 */
export async function addHistory(
  root: string,
  i: HistoryInput,
): Promise<
  { record: HistoryRecord; off?: undefined } | { record?: undefined; off: Api.HistoryRecording }
> {
  const recording = await recordingOf(root);
  if (!recording.on) return { off: recording };
  const now = i.now ?? new Date();
  const masked = maskSecrets(i.text);
  const original = Buffer.byteLength(i.text, "utf8");
  const cut = cutText(masked.text);
  const given = i.change?.trim();
  const change =
    (given && (await changeIds(root)).includes(given) ? given : undefined) ??
    (await branchChange(root));
  const command =
    i.command?.trim() ||
    (i.kind === "prompt" ? /^\s*(\/[a-z][a-z0-9-]*)(?=\s|$)/.exec(i.text)?.[1] : undefined);
  const record: HistoryRecord = {
    id: `h-${stamp(now)}-${i.random ? i.random() : randomBytes(3).toString("hex")}`,
    at: now.toISOString(),
    surface: i.surface,
    session: i.session?.trim() || `${i.surface}-${stamp(now).slice(0, 8)}`,
    kind: i.kind,
    text: cut.text,
    size: original,
    ...(cut.truncated ? { truncated: true } : {}),
    ...(masked.masked ? { masked: true } : {}),
    ...(change ? { change } : {}),
    ...(command ? { command } : {}),
  };
  const dir = historyDirOf(root);
  const file = join(dir, `${record.at.slice(0, 7)}.jsonl`);
  // The same reply twice in a row, with no prompt between, is one reply told twice (a hook that
  // read the transcript before its newest message was written): it is kept once.
  if (record.kind === "response") {
    const last = (await readLines(file)).filter(
      (r) => r.session === record.session && r.surface === record.surface,
    );
    const prev = last.at(-1);
    if (prev?.kind === "response" && prev.text === record.text) return { record: prev };
  }
  await mkdir(dir, { recursive: true });
  await ensureLocalIgnore(root);
  await appendFile(file, JSON.stringify(record) + "\n", "utf8");
  return { record };
}

/** The records of one file, in the order written; a line that isn't a record is skipped. */
async function readLines(file: string): Promise<HistoryRecord[]> {
  const text = await readFile(file, "utf8").catch(() => "");
  const out: HistoryRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      continue;
    }
    const r = Api.HistoryRecord.safeParse(v);
    if (r.success) out.push(r.data);
  }
  return out;
}

/** Every record, oldest first; a line that isn't a record is skipped. */
export async function readHistory(root: string): Promise<HistoryRecord[]> {
  const dir = historyDirOf(root);
  const files = (await readdir(dir).catch(() => []))
    .filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f))
    .sort();
  const out: HistoryRecord[] = [];
  for (const f of files) out.push(...(await readLines(join(dir, f))));
  return out.sort((a, b) => (a.at === b.at ? a.id.localeCompare(b.id) : a.at < b.at ? -1 : 1));
}

/**
 * The turns: in each session, in time order, a prompt starts a turn and the next response before
 * another prompt joins it; a response with no prompt before it is a turn of its own. Newest first.
 */
export function pairTurns(records: readonly HistoryRecord[]): HistoryTurn[] {
  const sorted = [...records].sort((a, b) =>
    a.at === b.at ? a.id.localeCompare(b.id) : a.at < b.at ? -1 : 1,
  );
  const open = new Map<string, HistoryTurn>();
  const turns: HistoryTurn[] = [];
  for (const r of sorted) {
    const key = `${r.surface}\u0000${r.session}`;
    if (r.kind === "prompt") {
      const t: HistoryTurn = {
        session: r.session,
        surface: r.surface,
        at: r.at,
        ...(r.change ? { change: r.change } : {}),
        prompt: r,
      };
      turns.push(t);
      open.set(key, t);
      continue;
    }
    const t = open.get(key);
    if (t && !t.response) {
      t.response = r;
      if (!t.change && r.change) t.change = r.change;
      open.delete(key);
    } else
      turns.push({
        session: r.session,
        surface: r.surface,
        at: r.at,
        ...(r.change ? { change: r.change } : {}),
        response: r,
      });
  }
  return turns.reverse();
}

export interface HistoryFilter {
  change?: string;
  session?: string;
  /** Words that must all be in the turn's text, command, change, session or surface. */
  filter?: string;
  limit?: number;
}

/** The turns that match every filter given. */
export function filterTurns(turns: readonly HistoryTurn[], o: HistoryFilter): HistoryTurn[] {
  const words = (o.filter ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  return turns.filter((t) => {
    if (o.change && t.change !== o.change) return false;
    if (o.session && t.session !== o.session) return false;
    if (!words.length) return true;
    const hay = [
      t.prompt?.text,
      t.response?.text,
      t.prompt?.command,
      t.change,
      t.session,
      t.surface,
    ]
      .filter(Boolean)
      .join("\n")
      .toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** What `atticus history` and GET /api/history give: the matching turns, newest first. */
export async function listHistory(root: string, o: HistoryFilter = {}): Promise<Api.HistoryList> {
  const matched = filterTurns(pairTurns(await readHistory(root)), o);
  return {
    turns: o.limit ? matched.slice(0, o.limit) : matched,
    total: matched.length,
    recording: await recordingOf(root),
  };
}

/** One record and its pair: the prompt a response answered, or the response that followed. */
export async function historyEntry(
  root: string,
  id: string,
): Promise<Api.HistoryEntry | undefined> {
  if (!HISTORY_ID.test(id)) return undefined;
  const records = await readHistory(root);
  const record = records.find((r) => r.id === id);
  if (!record) return undefined;
  const turn = pairTurns(records).find((t) => t.prompt?.id === id || t.response?.id === id);
  const pair = record.kind === "prompt" ? turn?.response : turn?.prompt;
  return { record, ...(pair ? { pair } : {}) };
}
