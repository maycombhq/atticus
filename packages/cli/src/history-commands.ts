import { Api } from "@maycombhq/core";
import type { Output } from "./commands.js";
import {
  addHistory,
  historyEntry,
  listHistory,
  setLocalRecording,
  type HistoryRecord,
  type HistoryTurn,
} from "./history.js";

/**
 * `atticus history` (ADR 0110): the prompts a person sent their assistant in this metarepo and
 * the responses they got, kept on this machine. `history add` reads the text from stdin (the
 * Claude Code plugin's hooks and the VS Code extension call it); `history` and `history show`
 * read; `history on|off` is this machine's setting. A record's text is printed as text, never run.
 */

const when = (iso: string) => iso.replace("T", " ").slice(0, 16);
const KB = Api.HISTORY_TEXT_MAX_BYTES / 1024;

/** The first line of a text, short, with … when there is more. */
function firstLine(text: string, max = 120): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const first = (lines[0] ?? "").trim();
  const cut = first.length > max ? `${first.slice(0, max - 1)}…` : first;
  return lines.length > 1 && cut === first ? `${cut} …` : cut;
}

export function recordingLine(r: Api.HistoryRecording): string {
  if (r.on)
    return "Recording is on: prompts and responses in this metarepo are kept in .atticus/history/, on this machine only.";
  return r.offBy === "org-pack"
    ? "Recording is off (runtime.yaml history.record is false)."
    : "Recording is off on this machine (atticus history on turns it back on).";
}

const offWhy = (r: Api.HistoryRecording) =>
  r.offBy === "org-pack" ? "runtime.yaml history.record is false" : "atticus history off";

export async function historyAddCli(
  root: string,
  o: { surface?: string; kind?: string; session?: string; command?: string; change?: string },
  readText: () => Promise<string>,
  io: Output,
): Promise<number> {
  const surface = Api.HistorySurface.safeParse(o.surface);
  if (!surface.success) {
    io.err(`--surface is claude-code, vscode or cli${o.surface ? `, not ${o.surface}` : ""}.`);
    return 2;
  }
  const kind = Api.HistoryKind.safeParse(o.kind);
  if (!kind.success) {
    io.err(`--kind is prompt or response${o.kind ? `, not ${o.kind}` : ""}.`);
    return 2;
  }
  const text = await readText();
  if (!text.trim()) {
    io.out("Nothing to record: the text is empty.");
    return 0;
  }
  const r = await addHistory(root, {
    surface: surface.data,
    kind: kind.data,
    text,
    ...(o.session ? { session: o.session } : {}),
    ...(o.command ? { command: o.command } : {}),
    ...(o.change ? { change: o.change } : {}),
  });
  if (r.off) {
    io.out(`Recording is off (${offWhy(r.off)}); nothing was recorded.`);
    return 0;
  }
  const notes = [
    ...(r.record.truncated ? [`cut at ${KB} KB`] : []),
    ...(r.record.masked ? ["parts that looked like a secret were masked"] : []),
  ];
  io.out(
    `Recorded ${r.record.id} (${r.record.kind}, ${r.record.size} bytes${notes.length ? `; ${notes.join("; ")}` : ""}).`,
  );
  return 0;
}

export async function historyOnOffCli(root: string, on: boolean, io: Output): Promise<number> {
  await setLocalRecording(root, on);
  io.out(
    on
      ? "Recording is on on this machine (.atticus/me.yaml). runtime.yaml can still turn it off for everyone."
      : "Recording is off on this machine (.atticus/me.yaml): nothing more is kept. What was recorded stays in .atticus/history/.",
  );
  return 0;
}

export async function historyCli(
  root: string,
  o: { change?: string; session?: string; filter?: string; limit?: number; json?: boolean },
  io: Output,
): Promise<number> {
  const list = await listHistory(root, {
    ...(o.change ? { change: o.change } : {}),
    ...(o.session ? { session: o.session } : {}),
    ...(o.filter ? { filter: o.filter } : {}),
    limit: o.limit ?? 50,
  });
  if (o.json) {
    io.out(JSON.stringify(list, null, 2));
    return 0;
  }
  io.out(recordingLine(list.recording));
  if (!list.turns.length) {
    io.out(
      o.change || o.session || o.filter
        ? "No prompts match."
        : "No prompts yet. Claude Code's (with the Atticus plugin) and @atticus's in VS Code are recorded here; Copilot's other chats can't be.",
    );
    return 0;
  }
  // By session, the session with the newest turn first; in each, newest first.
  const sessions = new Map<string, HistoryTurn[]>();
  for (const t of list.turns) {
    const k = `${t.surface}\u0000${t.session}`;
    sessions.set(k, [...(sessions.get(k) ?? []), t]);
  }
  const indent = " ".repeat(20);
  for (const turns of sessions.values()) {
    io.out("");
    io.out(`Session ${turns[0]!.session} (${turns[0]!.surface})`);
    for (const t of turns) {
      const tag = t.change ? `  [${t.change}]` : "";
      if (t.prompt)
        io.out(`  ${when(t.at)}  you: ${firstLine(t.prompt.text)}${tag}  ${t.prompt.id}`);
      if (t.response)
        io.out(
          `${t.prompt ? indent : `  ${when(t.at)}  `}reply: ${firstLine(t.response.text)}${t.prompt ? "" : tag}  ${t.response.id}`,
        );
      else io.out(`${indent}no response yet`);
    }
  }
  if (list.total > list.turns.length)
    io.out(`\n${list.total - list.turns.length} older turns not shown (--limit n shows more).`);
  return 0;
}

function printRecord(r: HistoryRecord, io: Output) {
  for (const l of r.text.replace(/\s+$/, "").split(/\r?\n/)) io.out(`  ${l}`);
}

export async function historyShowCli(
  root: string,
  id: string,
  o: { json?: boolean },
  io: Output,
): Promise<number> {
  const e = await historyEntry(root, id);
  if (!e) {
    io.err(`There is no record ${id}. atticus history lists them.`);
    return 2;
  }
  if (o.json) {
    io.out(JSON.stringify(e, null, 2));
    return 0;
  }
  const r = e.record;
  io.out(
    [
      `${r.id}: ${r.kind}`,
      r.surface,
      `session ${r.session}`,
      when(r.at),
      ...(r.change ? [`change ${r.change}`] : []),
      ...(r.command ? [r.command] : []),
      `${r.size} bytes`,
    ].join(", "),
  );
  if (r.truncated) io.out(`Cut at ${KB} KB: the text was ${r.size} bytes.`);
  if (r.masked) io.out("Parts that looked like a secret were masked (***) before it was kept.");
  printRecord(r, io);
  if (e.pair) {
    io.out(r.kind === "response" ? `In answer to ${e.pair.id}:` : `Answered by ${e.pair.id}:`);
    printRecord(e.pair, io);
  } else if (r.kind === "prompt") io.out("No response yet.");
  return 0;
}
