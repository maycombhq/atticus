import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { VerifyReport } from "@maycombhq/verify";
import { writeAudit } from "../src/audit-commands.js";
import { changeList } from "../src/change-commands.js";
import { writeVerifyFiles } from "../src/facts-files.js";
import { appendLines } from "../src/file-lock.js";
import { addHistory, historyDirOf } from "../src/history.js";

/**
 * Review round 46 (storage): the files the app server and a CLI command write at the same time
 * (a repo's corrections), the files a reader may open while `atticus verify --write` writes
 * them, a history file whose last line has no newline, and a change.yaml cut short.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE = pathToFileURL(join(HERE, "../../core/dist/index.js")).href;
const temp = () => mkdtemp(join(tmpdir(), "atticus-r46-"));

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
};

/**
 * Another process rewriting the file as `atticus decide` does (read, drop a line, write), again
 * and again until `stop` is there. Resolves `ready` once it is rewriting, and `exit` with its code.
 */
function rewriter(file: string, stop: string) {
  const script = `
    const { withSharedFileLock, writeFileAtomic } = await import(${JSON.stringify(CORE)});
    const { readFile } = await import("node:fs/promises");
    const { existsSync } = await import("node:fs");
    const f = ${JSON.stringify(file)};
    for (let i = 0; !existsSync(${JSON.stringify(stop)}); i++) {
      await withSharedFileLock(f, async () => {
        const t = await readFile(f, "utf8").catch(() => "");
        const lines = t.split("\\n").filter(Boolean).filter((l) => !l.includes('"undo-me"'));
        await writeFileAtomic(f, lines.length ? lines.join("\\n") + "\\n" : "");
      });
      if (i === 0) process.stdout.write("ready\\n");
    }
  `;
  const p = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const ready = new Promise<void>((resolve, reject) => {
    p.stdout.on("data", () => resolve());
    p.on("error", reject);
    p.on("exit", () => reject(new Error("the other process ended before it started")));
  });
  const exit = new Promise<number>((resolve, reject) => {
    p.on("error", reject);
    p.on("exit", (code) => resolve(code ?? 1));
  });
  return { ready, exit };
}

describe("a repo's corrections, written by two processes at once", () => {
  it("keeps every line the app appends while a CLI command rewrites the file", async () => {
    const dir = await temp();
    const file = join(dir, "forge-payments.corrections.jsonl");
    await writeFile(file, '{"undo-me":true}\n');
    const N = 300;
    const stop = join(dir, "stop");
    const other = rewriter(file, stop);
    await other.ready;
    for (let i = 0; i < N; i++) await appendLines(file, [JSON.stringify({ fact: `call:${i}` })]);
    await writeFile(stop, "");
    expect(await other.exit).toBe(0);
    const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
    expect(lines.filter((l) => l.includes('"fact"'))).toHaveLength(N);
  }, 60_000);
});

describe("atticus verify --write and the audit write whole files", () => {
  const report = {
    accepted: [],
    rejected: [
      {
        code: "line",
        message: "the cited line doesn't hold it",
        fact: { kind: "entry", id: "entry.get.x" },
      },
    ],
    coverage: { ratio: 1, read: [], reviewed: [], unknown: [], excluded: [], notReached: [] },
    redacted: 0,
    quotesDropped: 0,
    carried: [],
    corrections: { applied: [], stale: [] },
    entriesNoFlowFollows: [],
    reviewed: [],
    reviewedProblems: [],
    reviewedDropped: [],
    authUncited: [],
    methodUnseen: [],
    skipped: [],
    reviewedHolds: [],
    specOpsUncovered: [],
    frameworkGaps: [],
  } as unknown as VerifyReport;

  // A rename puts a new file in place (a new inode); writing in place keeps the old one, and a
  // reader meanwhile sees it empty or cut short.
  const ino = async (f: string) => (await stat(f)).ino;

  it("writes the facts, rejected and verify files beside, then in place by rename", async () => {
    const root = await temp();
    const dir = join(root, "facts");
    await mkdir(dir, { recursive: true });
    const files = [
      "forge-payments.jsonl",
      "forge-payments.rejected.jsonl",
      "forge-payments.verify.yaml",
    ];
    for (const f of files) await writeFile(join(dir, f), "old\n");
    const before = await Promise.all(files.map((f) => ino(join(dir, f))));
    await writeVerifyFiles(root, "forge-payments", report, "c3c0006");
    const after = await Promise.all(files.map((f) => ino(join(dir, f))));
    files.forEach((f, i) => expect(after[i], f).not.toBe(before[i]));
    expect(await readFile(join(dir, "forge-payments.rejected.jsonl"), "utf8")).toContain('"line"');
  });

  it("writes the audit file by rename too", async () => {
    const root = await temp();
    await mkdir(join(root, "facts"), { recursive: true });
    const f = join(root, "facts", "forge-payments.audit.yaml");
    await writeFile(f, "old\n");
    const before = await ino(f);
    await writeAudit(root, "forge-payments", {
      schema: 1,
      repo: "forge-payments",
      draws: [],
      items: [],
    });
    expect(await ino(f)).not.toBe(before);
    expect(await readFile(f, "utf8")).toContain("repo: forge-payments");
  });
});

describe("a history file whose last line has no newline", () => {
  it("gets the next record on a line of its own", async () => {
    const root = await temp();
    await mkdir(join(root, "org-pack"), { recursive: true });
    const now = new Date("2026-11-08T10:00:00.000Z");
    const dir = historyDirOf(root);
    await mkdir(dir, { recursive: true });
    const file = join(dir, "2026-11.jsonl");
    const first = JSON.stringify({ id: "h-1", note: "saved by an editor without a newline" });
    await writeFile(file, first);
    await addHistory(root, {
      surface: "cli",
      kind: "prompt",
      text: "Which repos call forge-ledger?",
      now,
      random: () => "abcdef",
    });
    const lines = (await readFile(file, "utf8")).split("\n");
    expect(lines[0]).toBe(first);
    expect(JSON.parse(lines[1]!)).toMatchObject({ id: "h-20261108100000-abcdef" });
  });
});

describe("a change.yaml cut short", () => {
  it("is skipped by atticus change list, which names it, and lists the rest", async () => {
    const root = await temp();
    await mkdir(join(root, "org-pack"), { recursive: true });
    const bad = join(root, "openspec", "changes", "forge-add-refunds");
    await mkdir(bad, { recursive: true });
    await writeFile(join(bad, "change.yaml"), "id: forge-add-refunds\ntitle: [Add refu");
    const c = capture();
    expect(await changeList(root, {}, c.io)).toBe(0);
    expect(c.err.join("\n")).toMatch(/forge-add-refunds[\\/]change\.yaml/);
    expect(c.out).toContain("No changes yet. Start one with atticus change new.");
  });
});
