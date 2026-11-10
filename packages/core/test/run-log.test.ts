import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readTerminalRunLines,
  readTerminalRuns,
  recordedCommand,
  runningDirOf,
  runLogsDirOf,
  runTitle,
  startedByOf,
  startTerminalRun,
  tailTerminalRunLines,
  TERMINAL_RUN_ID,
} from "../src/run-log.js";

/**
 * ADR 0187: a command run in a terminal (or by an editor, or a Copilot session) keeps what it
 * prints in .atticus/logs/runs/<runId>.log, redacted, and a small record of itself in
 * .atticus/logs/running/<runId>.json, so the app's Console can show it wherever it was started.
 */

const fresh = async () => {
  const root = await mkdtemp(join(tmpdir(), "atticus-run-log-"));
  mkdirSync(join(root, "org-pack"));
  return root;
};
const at = (s: string) => () => new Date(s);
const HOME = { home: "/home/tom", user: "tom" };

describe("which commands keep a run log", () => {
  it("keeps the long ones and never the quick, read-only ones", () => {
    expect(recordedCommand(["map", "forge-ledger"], [])).toBe(true);
    expect(recordedCommand(["map"], ["all"])).toBe(true);
    expect(recordedCommand(["verify", "forge-ledger"], ["write"])).toBe(true);
    expect(recordedCommand(["scan"], [])).toBe(true);
    expect(recordedCommand(["scan", "survey", "forge-ledger"], ["handoff"])).toBe(true);
    expect(recordedCommand(["workspace", "sync"], [])).toBe(true);
    expect(recordedCommand(["task", "run", "c1", "t1"], [])).toBe(true);
    expect(recordedCommand(["task", "run-ready", "c1"], [])).toBe(true);
    expect(recordedCommand(["knowledge", "scan"], [])).toBe(true);
    expect(recordedCommand(["upgrade"], [])).toBe(true);
    expect(recordedCommand(["handoff", "done", "run-1"], [])).toBe(true);
    // Quick or read-only: no file.
    expect(recordedCommand(["help", "map"], [])).toBe(false);
    expect(recordedCommand(["map"], ["help"])).toBe(false);
    expect(recordedCommand(["upgrade"], ["check"])).toBe(false);
    expect(recordedCommand(["scan"], ["dry-run"])).toBe(false);
    expect(recordedCommand(["verify", "audit"], [])).toBe(false);
    expect(recordedCommand(["map", "render", "forge-ledger"], [])).toBe(false);
    expect(recordedCommand(["knowledge", "list"], ["json"])).toBe(false);
    expect(recordedCommand(["runs"], ["json"])).toBe(false);
    expect(recordedCommand(["next"], [])).toBe(false);
    expect(recordedCommand(["ui"], [])).toBe(false);
    expect(recordedCommand([], ["version"])).toBe(false);
  });

  it("titles a run with its command words, ids and flag names, never a value", () => {
    expect(runTitle(["map", "forge-ledger"], ["handoff"])).toEqual({
      command: ["map", "forge-ledger"],
      title: "atticus map forge-ledger --handoff",
    });
    // A word that isn't an id (a path, a URL, a sentence, a secret-looking string) is left out.
    const t = runTitle(
      [
        "map",
        "C:\\Users\\tom\\x",
        "https://u:p@host/x",
        "two words",
        "Ab3Cd4Ef5Gh6Ij7Kl8Mn9Op0Qr1St2Uv3",
      ],
      ["max-tokens"],
    );
    expect(t.title).toBe("atticus map … … … … --max-tokens");
    expect(t.command).toEqual(["map", "…", "…", "…", "…"]);
  });

  it("says who started it from the environment", () => {
    expect(startedByOf({})).toBe("terminal");
    expect(startedByOf({ TERM_PROGRAM: "vscode" })).toBe("vscode");
    expect(startedByOf({ TERMINAL_EMULATOR: "JetBrains-JediTerm" })).toBe("intellij");
    expect(startedByOf({ ATTICUS_STARTED_BY: "intellij" })).toBe("intellij");
    expect(startedByOf({ ATTICUS_STARTED_BY: "vscode", TERM_PROGRAM: "x" })).toBe("vscode");
    expect(startedByOf({ ATTICUS_STARTED_BY: "nonsense" })).toBe("terminal");
    expect(startedByOf({ ATTICUS_ACP_SESSION: "1", TERM_PROGRAM: "vscode" })).toBe("copilot");
  });
});

describe("a terminal run's files", () => {
  it("records the run, its redacted lines and how it ended, with Windows-safe names", async () => {
    const root = await fresh();
    const rec = startTerminalRun(root, {
      positionals: ["map", "forge-ledger"],
      flags: ["handoff"],
      env: { TERM_PROGRAM: "vscode" },
      now: at("2026-11-09T10:15:30.000Z"),
      pid: 4242,
      redact: HOME,
    })!;
    expect(rec).toBeDefined();
    expect(rec.runId).toMatch(TERMINAL_RUN_ID);
    expect(rec.runId).not.toContain(":");
    rec.line("Reading forge-ledger at /home/tom/work/forge");
    rec.line("token=abc123secret and https://me:hunter2@git.example/x.git");
    rec.line("\u001b[32mgreen\u001b[0m\r\ntwo\nlines");
    const [r] = readTerminalRuns(root, { alive: () => true });
    expect(r).toMatchObject({
      runId: rec.runId,
      title: "atticus map forge-ledger --handoff",
      command: ["map", "forge-ledger"],
      flags: ["handoff"],
      startedBy: "vscode",
      state: "running",
      startedAt: "2026-11-09T10:15:30.000Z",
      pid: 4242,
    });
    const text = readFileSync(join(runLogsDirOf(root), `${rec.runId}.log`), "utf8");
    expect(text).not.toContain("/home/tom");
    expect(text).not.toContain("abc123secret");
    expect(text).not.toContain("hunter2");
    expect(text).toContain("~/work/forge");
    expect(readTerminalRunLines(root, rec.runId)).toMatchObject({
      from: 0,
      total: 5,
      lines: [
        "Reading forge-ledger at ~/work/forge",
        "token=*** and https://***@git.example/x.git",
        "green",
        "two",
        "lines",
      ],
    });
    rec.end(0);
    const [ended] = readTerminalRuns(root, { alive: () => true });
    expect(ended).toMatchObject({ state: "done", exitCode: 0, lines: 5 });
    expect(ended!.finishedAt).toBeDefined();
    // From a line on.
    expect(readTerminalRunLines(root, rec.runId, 3)).toMatchObject({
      from: 3,
      lines: ["two", "lines"],
    });
    // The folder is this machine's own: never committed.
    expect(readFileSync(join(root, ".atticus", ".gitignore"), "utf8")).toContain("logs/");
  });

  it("says a failed or a stopped run ended so", async () => {
    const root = await fresh();
    const a = startTerminalRun(root, { positionals: ["verify", "x"], flags: [], pid: 1 })!;
    a.end(1);
    const b = startTerminalRun(root, { positionals: ["map"], flags: ["all"], pid: 2 })!;
    b.end(130);
    const c = startTerminalRun(root, { positionals: ["scan"], flags: [], pid: 3 })!;
    c.end(1, "crash");
    const by = new Map(readTerminalRuns(root, { alive: () => true }).map((r) => [r.runId, r]));
    expect(by.get(a.runId)).toMatchObject({ state: "failed", exitCode: 1 });
    expect(by.get(b.runId)).toMatchObject({ state: "cancelled", exitCode: 130 });
    expect(by.get(c.runId)).toMatchObject({ state: "failed", exitCode: 1 });
    // Ending twice keeps the first end.
    a.end(0);
    expect(
      readTerminalRuns(root, { alive: () => true }).find((r) => r.runId === a.runId),
    ).toMatchObject({ state: "failed" });
  });

  it("calls a run whose process is gone on this machine one that ended without saying", async () => {
    const root = await fresh();
    const r = startTerminalRun(root, { positionals: ["map", "forge-ledger"], flags: [], pid: 99 })!;
    expect(readTerminalRuns(root, { alive: () => true })[0]!.stale).toBeUndefined();
    const [gone] = readTerminalRuns(root, { alive: (pid) => pid !== 99 });
    expect(gone).toMatchObject({ runId: r.runId, state: "running", stale: true });
  });

  it("keeps the last runs only, and a bounded log of each", async () => {
    const root = await fresh();
    let n = 0;
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const r = startTerminalRun(root, {
        positionals: ["scan"],
        flags: [],
        pid: 10 + i,
        keep: 5,
        now: () => new Date(Date.UTC(2026, 10, 9, 10, 0, n++)),
      })!;
      r.end(0);
      ids.push(r.runId);
    }
    const kept = readTerminalRuns(root, { alive: () => false }).map((r) => r.runId);
    expect(kept).toEqual(ids.slice(-5).reverse());
    expect(readdirSync(runningDirOf(root)).length).toBe(5);
    expect(readdirSync(runLogsDirOf(root)).length).toBe(5);

    const big = startTerminalRun(root, {
      positionals: ["map"],
      flags: ["all"],
      pid: 1,
      maxBytes: 2000,
    })!;
    for (let i = 0; i < 400; i++) big.line(`line ${i} ${"x".repeat(20)}`);
    big.end(0);
    const size = readFileSync(join(runLogsDirOf(root), `${big.runId}.log`)).length;
    expect(size).toBeLessThanOrEqual(2000);
    const l = readTerminalRunLines(root, big.runId)!;
    expect(l.total).toBe(400);
    expect(l.from).toBeGreaterThan(0);
    expect(l.lines.at(-1)).toContain("line 399");
    expect(l.lines[0]).toContain(`line ${l.from} `);
  });

  it("never fails the command when the folder can't be written, and reads nothing odd", async () => {
    const root = await fresh();
    // .atticus is a file: nothing can be made under it.
    writeFileSync(join(root, ".atticus"), "x");
    expect(startTerminalRun(root, { positionals: ["scan"], flags: [], pid: 1 })).toBeUndefined();
    const other = await fresh();
    mkdirSync(runningDirOf(other), { recursive: true });
    writeFileSync(join(runningDirOf(other), "not-a-run.json"), "{}");
    writeFileSync(join(runningDirOf(other), "20261109-101530-1-abcd.json"), "not json");
    expect(readTerminalRuns(other)).toEqual([]);
    expect(readTerminalRunLines(other, "../../etc/passwd")).toBeUndefined();
    expect(existsSync(runLogsDirOf(other))).toBe(false);
  });
});

describe("a long run among many (review of ADR 0187)", () => {
  it("never prunes a run still running, whose process is alive", async () => {
    const root = await fresh();
    let t = Date.parse("2026-11-09T10:00:00Z");
    const now = () => new Date(t);
    const long = startTerminalRun(root, {
      positionals: ["map"],
      flags: ["all"],
      pid: 1111,
      now,
      alive: (pid) => pid === 1111,
    })!;
    long.line("step 1 of 40");
    for (let i = 0; i < 12; i++) {
      t += 1000;
      const r = startTerminalRun(root, {
        positionals: ["verify"],
        flags: [],
        pid: 2000 + i,
        now,
        keep: 5,
        alive: (pid) => pid === 1111,
      })!;
      r.end(0);
    }
    const runs = readTerminalRuns(root, { alive: (pid) => pid === 1111, now });
    expect(runs.some((r) => r.runId === long.runId && !r.stale)).toBe(true);
    // The finished ones are still pruned to the newest.
    expect(runs.filter((r) => r.state === "done").length).toBe(4);
    long.line("step 2 of 40");
    expect(readTerminalRunLines(root, long.runId)!.lines).toEqual(["step 1 of 40", "step 2 of 40"]);
    // One whose process is gone is pruned as before.
    t += 1000;
    startTerminalRun(root, {
      positionals: ["scan"],
      flags: [],
      pid: 3000,
      now,
      keep: 5,
      alive: () => false,
    })!.end(0);
    expect(
      readTerminalRuns(root, { alive: () => true, now }).some((r) => r.runId === long.runId),
    ).toBe(false);
  });

  it("calls a reused process id's run ended: its process started at another time", async () => {
    const root = await fresh();
    // Its own process: the record keeps when it started where the system says so cheaply.
    startTerminalRun(root, { positionals: ["map"], flags: ["all"], procStart: () => "4242" })!;
    expect(
      readTerminalRuns(root, { alive: () => true, startOf: () => "4242" })[0]!.stale,
    ).toBeUndefined();
    expect(readTerminalRuns(root, { alive: () => true, startOf: () => "9999" })[0]).toMatchObject({
      state: "running",
      stale: true,
    });
    // Where the system can't say, the process being there is enough.
    expect(
      readTerminalRuns(root, { alive: () => true, startOf: () => undefined })[0]!.stale,
    ).toBeUndefined();
  });

  it("beats while it runs, and a run silent for over five minutes ended without saying", async () => {
    const root = await fresh();
    const rec = startTerminalRun(root, {
      positionals: ["map"],
      flags: ["all"],
      pid: 5151,
      heartbeatMs: 20,
      procStart: () => undefined,
    })!;
    const beatOf = () =>
      (
        JSON.parse(readFileSync(join(runningDirOf(root), `${rec.runId}.json`), "utf8")) as {
          beatAt?: string;
        }
      ).beatAt;
    const first = beatOf();
    expect(first).toBeDefined();
    await new Promise((r) => setTimeout(r, 120));
    expect(beatOf()).not.toBe(first);
    const o = { alive: () => true, startOf: () => undefined };
    expect(
      readTerminalRuns(root, { ...o, now: () => new Date(Date.now() + 60_000) })[0]!.stale,
    ).toBeUndefined();
    expect(
      readTerminalRuns(root, { ...o, now: () => new Date(Date.now() + 6 * 60_000) })[0],
    ).toMatchObject({
      stale: true,
    });
    rec.end(0);
    const after = beatOf();
    await new Promise((r) => setTimeout(r, 80));
    // Ended: no more beats.
    expect(beatOf()).toBe(after);
  });
});

describe("tailing a run's log from where it was read", () => {
  it("reads only what was added, at most a cap at a time, and goes on from there", async () => {
    const root = await fresh();
    const rec = startTerminalRun(root, { positionals: ["map"], flags: [], pid: 7 })!;
    rec.line("first");
    const a = tailTerminalRunLines(root, rec.runId, undefined, 3)!;
    expect(a).toMatchObject({ from: 0, lines: ["first"], more: false });
    for (let i = 0; i < 7; i++) rec.line(`line ${i}`);
    rec.line("FINAL SUMMARY");
    const b = tailTerminalRunLines(root, rec.runId, a.at, 3)!;
    expect(b).toMatchObject({ from: 1, lines: ["line 0", "line 1", "line 2"], more: true });
    const c = tailTerminalRunLines(root, rec.runId, b.at, 3)!;
    const d = tailTerminalRunLines(root, rec.runId, c.at, 3)!;
    expect([...c.lines, ...d.lines]).toEqual([
      "line 3",
      "line 4",
      "line 5",
      "line 6",
      "FINAL SUMMARY",
    ]);
    expect(d).toMatchObject({ from: 7, more: false });
    expect(d.at.line).toBe(9);
    // Nothing new: nothing read.
    expect(tailTerminalRunLines(root, rec.runId, d.at, 3)).toMatchObject({
      from: 9,
      lines: [],
      more: false,
    });
  });

  it("starts again from the lines kept when the log was cut", async () => {
    const root = await fresh();
    const rec = startTerminalRun(root, { positionals: ["map"], flags: [], pid: 8, maxBytes: 400 })!;
    rec.line("a");
    const a = tailTerminalRunLines(root, rec.runId, undefined)!;
    for (let i = 0; i < 60; i++) rec.line(`line ${i} ${"x".repeat(10)}`);
    const b = tailTerminalRunLines(root, rec.runId, a.at)!;
    // Lines 1.. were partly dropped: it answers from the first one kept.
    expect(b.from).toBeGreaterThan(1);
    expect(b.lines[0]).toContain(`line ${b.from - 1} `);
    expect(b.lines.at(-1)).toContain("line 59 ");
    expect(b.at.line).toBe(61);
  });
});
