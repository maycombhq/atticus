import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readTerminalRunLines,
  RETITLE_MAX_BYTES,
  RETITLED_MARK,
  retitleTerminalRuns,
  readTerminalRuns,
  recordedCommand,
  runningDirOf,
  runLogsDirOf,
  runTitle,
  startAppRun,
  startedByOf,
  startTerminalRun,
  tailTerminalRunLines,
  TERMINAL_RUN_ID,
  TITLE_VALUE_FLAGS,
  TITLE_VALUE_MAX,
  titleValue,
  titleWord,
  WORK_ITEM_SYSTEMS,
} from "../src/run-log.js";
import { ExternalRef } from "../src/schema/kinds.js";
import { hasTokenPrefix, TOKEN_PREFIXES } from "../src/cite.js";

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
const HOME = { home: "/home/kit", user: "kit" };

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
    // Beta.26 review: every command that writes, run anywhere, is in the Console.
    expect(recordedCommand(["change", "new", "c1"], ["type"])).toBe(true);
    expect(recordedCommand(["change", "feature", "c1"], [])).toBe(true);
    expect(recordedCommand(["change", "architecture", "c1"], ["handoff"])).toBe(true);
    expect(recordedCommand(["change", "attach", "c1"], [])).toBe(true);
    expect(recordedCommand(["initiative", "new"], ["journey"])).toBe(true);
    expect(recordedCommand(["initiative", "commit", "i1"], [])).toBe(true);
    expect(recordedCommand(["questions", "answer", "q1"], ["option"])).toBe(true);
    expect(recordedCommand(["questions", "owner", "q1"], ["text"])).toBe(true);
    expect(recordedCommand(["questions", "propose"], [])).toBe(true);
    expect(recordedCommand(["critic", "c1"], ["gate"])).toBe(true);
    expect(recordedCommand(["finding", "c1", "f1", "waive"], [])).toBe(true);
    expect(recordedCommand(["plan", "stories", "c1"], [])).toBe(true);
    expect(recordedCommand(["needs", "done", "c1", "n1"], [])).toBe(true);
    expect(recordedCommand(["knowledge", "verify", "k1"], [])).toBe(true);
    expect(recordedCommand(["repo", "add"], [])).toBe(true);
    expect(recordedCommand(["baseline"], [])).toBe(true);
    expect(recordedCommand(["triage", "decide", "t1", "2"], [])).toBe(true);
    expect(recordedCommand(["workspace", "prune"], [])).toBe(true);
    expect(recordedCommand(["task", "c1", "t1"], [])).toBe(true);
    expect(recordedCommand(["spec", "draft", "forge-ledger"], [])).toBe(true);
    // Quick or read-only: no file.
    expect(recordedCommand(["change", "status", "c1"], [])).toBe(false);
    expect(recordedCommand(["change", "list"], ["json"])).toBe(false);
    expect(recordedCommand(["questions"], [])).toBe(false);
    expect(recordedCommand(["questions", "list"], ["json"])).toBe(false);
    expect(recordedCommand(["questions", "show", "q1"], [])).toBe(false);
    expect(recordedCommand(["initiative", "status", "i1"], [])).toBe(false);
    expect(recordedCommand(["critic", "stats"], [])).toBe(false);
    expect(recordedCommand(["task", "context", "c1", "t1"], [])).toBe(false);
    expect(recordedCommand(["feature", "list"], [])).toBe(false);
    // A prompt recorded by a hook, every time a person writes one: never a Console entry.
    expect(recordedCommand(["history", "add"], ["surface", "kind"])).toBe(false);
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
        "C:\\Users\\kit\\x",
        "https://u:p@host/x",
        "two words",
        "Ab3Cd4Ef5Gh6Ij7Kl8Mn9Op0Qr1St2Uv3",
      ],
      ["max-tokens"],
    );
    // Beta.27 re-review: words dropped one after another read as one `…`.
    expect(t.title).toBe("atticus map … --max-tokens");
    expect(t.command).toEqual(["map", "…"]);
  });

  it("beta.27: keeps a flag's value that is an id, a name or a date, so the title reads as typed", () => {
    // Beta.26 dropped every value: "atticus initiative plan transfer-limits-rollout --target --by".
    expect(
      runTitle(["initiative", "plan", "transfer-limits-rollout"], ["target", "by"], {
        target: "2027-03-31",
        by: "@bao",
      }).title,
    ).toBe("atticus initiative plan transfer-limits-rollout --target 2027-03-31 --by @bao");
    expect(
      runTitle(["map"], ["repos", "handoff"], { repos: "forge-ledger,forge-teller" }).title,
    ).toBe("atticus map --repos forge-ledger,forge-teller --handoff");
    // A boolean flag has no value; --root's folder is still left out.
    expect(runTitle(["map"], ["root", "all"], { root: "/work/forge" }).title).toBe(
      "atticus map --all",
    );
  });

  it("beta.27: drops a value that looks secret, by its flag's name or its own shape", () => {
    const t = (flag: string, value: string) => runTitle(["sync"], [flag], { [flag]: value }).title;
    // By the flag's name, whatever the value.
    expect(t("token", "forge")).toBe("atticus sync --token");
    expect(t("api-key", "abc")).toBe("atticus sync --api-key");
    expect(t("client-secret", "x1")).toBe("atticus sync --client-secret");
    expect(t("password", "hunter2")).toBe("atticus sync --password");
    // By the value's shape: a token, a random string, a URL with a password, a path, words.
    expect(t("with", "ghp_abcdefghijklmnopqrstuvwxyz0123")).toBe("atticus sync --with");
    expect(t("with", "q7Xf3Kd9Lm2Np8Rs4Tv6")).toBe("atticus sync --with");
    expect(t("with", "Ab3Cd4Ef5Gh6Ij7Kl8Mn9Op0Qr1St2Uv3")).toBe("atticus sync --with");
    expect(t("with", "https://u:p@host/x")).toBe("atticus sync --with");
    expect(t("with", "C:\\Users\\kit\\x")).toBe("atticus sync --with");
    expect(t("with", "two words")).toBe("atticus sync --with");
    expect(t("with", "0f1e2d3c4b5a69788796a5b4c3d2e1f0")).toBe("atticus sync --with");
  });

  it("beta.27 review: keeps a value only for a flag on the allow-list, never an unknown one's", () => {
    const t = (flag: string, value: string) =>
      runTitle(
        ["map", "forge-ledger"],
        [flag],
        { [flag]: value },
        { home: "/home/bao", user: "bao" },
      ).title;
    // The reviewer's command line: every value was in the title.
    expect(
      runTitle(
        ["map", "forge-ledger"],
        ["pass", "client-key", "by", "from", "pw"],
        {
          pass: "hunter2",
          "client-key": "abc",
          by: "bao@northwind.example",
          // Made as the test runs: no token-shaped text in the source (push protection).
          from: `oauth2:${["glpat", "Forge".repeat(4)].join("-")}@git.northwind.example:org/repo.git`,
          pw: "Tr0ub4dor",
        },
        { home: "/home/bao", user: "bao" },
      ).title,
    ).toBe("atticus map forge-ledger --pass --client-key --by --from --pw");
    // Flags off the list keep their name only, whatever the value.
    for (const flag of [
      "pass",
      "pw",
      "pat",
      "passphrase",
      "key",
      "client-key",
      "bearer",
      "jwt",
      "with",
      "value",
      "note",
      "answer",
      "text",
      "header",
      "host",
      "url",
      "users",
      "file",
      "from",
      "max-tokens",
      "confirm",
    ])
      expect(t(flag, "forge-ledger"), flag).toBe(`atticus map forge-ledger --${flag}`);
    expect(TITLE_VALUE_FLAGS.has("by")).toBe(true);
    expect(TITLE_VALUE_FLAGS.has("pass")).toBe(false);
  });

  it("beta.27 review: drops an allowed flag's value shaped like a secret or a person's address", () => {
    const t = (flag: string, value: string) =>
      titleValue(flag, value, { home: "/home/bao", user: "bao" });
    // A person: a handle is kept, an email never.
    expect(t("by", "@bao")).toBe("@bao");
    expect(t("by", "bao.nguyen")).toBe("bao.nguyen");
    expect(t("by", "bao@northwind.example")).toBeUndefined();
    expect(t("by", "@bao@northwind.example")).toBeUndefined();
    expect(t("owner", "team-ledger@northwind.example")).toBeUndefined();
    // Credentials in a place: a scheme, a user and password before a host, with or without one.
    expect(t("repo", "https://git.northwind.example/forge")).toBeUndefined();
    expect(t("repo", "svc:hunter2@git.northwind.example")).toBeUndefined();
    expect(t("repo", "postgres:hunter2@db")).toBeUndefined();
    // Beta.27 re-review: no value with a `:` (a host's path too), whatever follows it.
    expect(t("repo", "git.northwind.example:org/repo.git")).toBeUndefined();
    // Token shapes, short or long.
    for (const v of [
      "glpat-abcdefghij1234567890",
      "glpat-x",
      "ghp_short",
      "ghp_1234567890abcdefghijklmnopqrstuvwxyz",
      "github_pat_11AAAA",
      "sk_live_abc123",
      "sk-proj-abcdefghijklmnopqrstuvwxyz012345",
      "sk-ant-api03-abcDEF123",
      "npm_abcdefghijklmnopqrstuvwxyz0123456789",
      "xoxb-123456789012-abcdef",
      "AKIAIOSFODNN7EXAMPLE",
      "AIzaSyA1234567890abcdefghijklmnopqrstu",
      "hf_abcdefghijklmnopqrstuvwxyz01234567",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      "0123456789abcdef",
      "0123456789abcdef0123",
      "q7Xf3Kd9Lm2Np8Rs4Tv6",
      "4111111111111111",
      "123-45-6789",
      "dXNlcjpwYXNzd29yZA==",
      "forge-ledger,ghp_short",
    ])
      expect(t("change", v), v).toBeUndefined();
    // This machine's home folder or user name in a path.
    expect(t("repos", "home/bao/forge")).toBeUndefined();
    // Ids, names, dates and lists of them stay, cut when long.
    expect(t("target", "2027-03-31")).toBe("2027-03-31");
    expect(t("repos", "forge-ledger,forge-teller")).toBe("forge-ledger,forge-teller");
    expect(t("lens", "security")).toBe("security");
    expect(t("pr", "42")).toBe("42");
    const long = Array.from({ length: 8 }, (_, i) => `forge-repo-${i}`).join(",");
    expect(t("repos", long)).toBe(`${long.slice(0, TITLE_VALUE_MAX)}…`);
  });

  it("beta.27 review: never keeps a value of a flag it doesn't know, whatever the value (fuzz)", () => {
    // A seeded generator, so a failure can be run again.
    let seed = 27;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const pick = (al: string, n: number) =>
      Array.from({ length: n }, () => al[Math.floor(next() * al.length)]).join("");
    const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const shapes = [
      () => `glpat-${pick(A + "-_", 20)}`,
      () => `npm_${pick(A, 36)}`,
      () => `sk_live_${pick(A, 24)}`,
      () => pick("0123456789abcdef", 16),
      () => pick("abcdefghijklmnopqrstuvwxyz0123456789", 20),
      () => pick(A + "!@#", 12),
      () => pick(A, 10),
      () => pick(A, 6),
      () => `svc:${pick(A, 16)}@git.northwind.example`,
      () => `${pick("abcdefghij", 6)}@northwind.example`,
      () => "forge-ledger",
    ];
    const flags = ["pass", "pw", "secret-ish", "client-key", "with", "x", "token2", "k"];
    for (let i = 0; i < 2000; i++) {
      const flag = flags[i % flags.length]!;
      const value = shapes[i % shapes.length]!();
      const { title } = runTitle(["sync"], [flag], { [flag]: value });
      expect(title, `${flag}=${value}`).toBe(`atticus sync --${flag}`);
    }
    // Secret-shaped tokens are dropped from an allowed flag too.
    for (let i = 0; i < 500; i++) {
      const v = [
        `glpat-${pick(A, 20)}`,
        `npm_${pick(A, 36)}`,
        `sk_live_${pick(A, 24)}`,
        pick("0123456789abcdef", 16),
        `svc:${pick(A, 16)}@git.northwind.example`,
      ][i % 5]!;
      expect(titleValue("change", v), v).toBeUndefined();
    }
  });

  it("leaves where it ran out of a title: --root and --metarepo say a folder, not what ran", () => {
    expect(runTitle(["index", "rebuild"], ["root"]).title).toBe("atticus index rebuild");
    expect(runTitle(["map", "forge-ledger"], ["metarepo", "handoff", "root"]).title).toBe(
      "atticus map forge-ledger --handoff",
    );
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
    rec.line("Reading forge-ledger at /home/kit/work/forge");
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
    expect(text).not.toContain("/home/kit");
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

/**
 * Beta.27 re-review: the reviewer's adversarial command lines (scratch adv.mjs), as tests. Every
 * token-shaped string is made as the test runs (push protection rejects them as literals).
 */
const tok = (...parts: string[]) => parts.join("");
/** A seeded generator, so a failure can be run again. */
const seeded = (seed: number) => () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const BASE62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

describe("beta.27 re-review: a run's title shows no secret, however it was typed", () => {
  it("never keeps `secret` (a quick command: its key goes to stdin, never a title)", () => {
    expect(recordedCommand(["secret", "set", "ATTICUS_MODEL_KEY"], [])).toBe(false);
    expect(recordedCommand(["secret", "forget", "ATTICUS_MODEL_KEY"], [])).toBe(false);
    expect(recordedCommand(["secret", "check", "ATTICUS_MODEL_KEY"], [])).toBe(false);
  });

  it("drops a positional word shaped as a key, a token, a password or a number", () => {
    const words = [
      "Zx9Kq2Lm8Pw4Rt6Yv1Bn3Cd5Fg7Hj0",
      "AbCdEfGhIjKlMnOpQrStUvWx",
      "abcdefghijklmnopqrstuvwxyzabcdef",
      "Summer2026",
      "summer2026",
      "Summer2026!",
      "0123456789abcdef0123456789abcdef",
      tok("gh", "p_", "16C7e42F292c6912E7710c838347Ae178B4a"),
      tok("gl", "pat-", "x".repeat(20)),
      tok("AK", "IA", "IOSFODNN7EXAMPLE"),
      tok("xo", "xb-", "123456789012-abcdefABCDEF"),
      tok("sk", "-ant-", "abc"),
      tok("sq0", "atp-", "AbCdEf123456"),
      tok("SG", ".abc.def"),
      tok("SK", "1234567890"),
      tok("da", "pi", "1234567890abcdef"),
      tok("wJalrXUtnFEMI", "/K7MDENG/", "bPxRfiCY", "EXAMPLEKEY"),
      "4111111111111111",
      "4111-1111-1111-1111",
      "123-45-6789",
      "user:pw",
      "pat@bank.example",
      "a,b",
      "${API_KEY}",
    ];
    for (const w of words) {
      expect(titleWord(w), w).toBeUndefined();
      const { title, command } = runTitle(["map", w], []);
      expect(title, w).toBe("atticus map …");
      expect(command, w).toEqual(["map", "…"]);
    }
  });

  it("keeps an id: a repo, a change, a task's label, a question, a run, a date, a version", () => {
    for (const w of [
      "forge-ledger",
      "add-transfer-limit",
      "fix-limits-2027-q1",
      "c1",
      "t1",
      "1.2",
      "1.2.3",
      "v0.27.0",
      "1.0.0-beta.27",
      "q-0123456789ab",
      "run-20261109101530-ab12cd",
      "run-20261109101530-0003",
      "20261109-101530-4242-ab12",
      "2027-03-31",
      "ado:1234",
      "jira:4711",
      "jira:PAY-12",
      "link:forge-teller:ledger-post",
      "ATTICUS_MODEL_KEY",
      "forge/ledger",
      "Ledger",
      "@bao",
    ])
      expect(titleWord(w), w).toBe(w);
    expect(titleWord("link:forge-teller:Zx9Kq2Lm8Pw4Rt6")).toBeUndefined();
  });

  it("knows a work item's reference by a tracker C1 names, never any word and a number", () => {
    expect([...WORK_ITEM_SYSTEMS].every((s) => ExternalRef.shape.system.options.includes(s))).toBe(
      true,
    );
    for (const w of ["pin:1234", "pass:1234", "otp:123456", "code:42", "ado:12345678", "ADO:12"])
      expect(titleWord(w), w).toBeUndefined();
  });

  it("shows a flag the command line doesn't declare (given as `…`) as one `--…`, last", () => {
    expect(runTitle(["map", "forge-ledger"], ["…", "json", "…"]).title).toBe(
      "atticus map forge-ledger --json --…",
    );
    expect(runTitle(["map"], ["json"]).title).toBe("atticus map --json");
  });

  it("drops an allowed flag's value that isn't an id, deterministically", () => {
    const t = (flag: string, value: string) => titleValue(flag, value);
    for (const v of [
      "Zx9Kq2Lm8Pw4Rt6Yv1Bn3Cd5Fg7Hj0",
      "AbCdEfGhIjKlMnOpQrStUvWx",
      "abcdefghijklmnopqrstuvwxyzabcdef",
      "Summer2026",
      "Summer2026!",
      "pat@bank.example",
      "pat%40bank.example",
      "pat＠bank.example",
      tok("sk", "-ant-abc"),
      "azure/https:x",
      "user:pw",
      tok("AC", "1234567890abcdef", "1234567890abcdef"),
      "4111111111111111",
      "4111-1111-1111-1111",
      "4111 1111 1111 1111",
      tok("SG", ".abc.def"),
      tok("xo", "xb-123-456-abc"),
      tok("sq0", "atp-AbCdEf123456"),
      tok("sq0", "csp-AbCdEf123456"),
      tok("SK", "1234567890"),
      "AccountKey/abc+def/ghij",
      tok("Account", "Key=abc"),
      tok("wJalrXUtnFEMI", "/K7MDENG/", "bPxRfiCY", "EXAMPLEKEY"),
      tok("da", "pi1234567890abcdef"),
      "ATTICUS_KEY:Zx9Kq2Lm",
      "a,Zx9Kq2Lm8Pw4Rt6Yv1Bn3Cd5Fg7Hj0",
      "123-45-6789",
      tok("ey", "JhbGciOi"),
      "role=a,b",
      "${API_KEY}",
      "env:API_KEY",
      tok("rk", "_live_x"),
      tok("pk", "_test_x"),
      tok("wh", "sec_x"),
      tok("Bea", "rer abc"),
      "--pass",
      "a".repeat(60),
    ])
      expect(t("target", v), v).toBeUndefined();
    expect(t("by", "@bao.ops")).toBe("@bao.ops");
    expect(t("release", "2027-03-31")).toBe("2027-03-31");
    expect(t("repos", "forge-ledger,forge-teller")).toBe("forge-ledger,forge-teller");
    expect(t("model", "sonnet-4-5")).toBe("sonnet-4-5");
    expect(
      runTitle(["map", "forge-ledger"], ["system"], { system: "Zx9Kq2Lm8Pw4Rt6Yv1Bn3Cd5Fg7Hj0" })
        .title,
    ).toBe("atticus map forge-ledger --system");
  });

  it("drops every random base62 string of 16 to 31 characters, as a word or a value (fuzz)", () => {
    const next = seeded(2027);
    for (let n = 16; n <= 31; n++)
      for (let i = 0; i < 400; i++) {
        const s = Array.from({ length: n }, () => BASE62[Math.floor(next() * 62)]).join("");
        expect(titleWord(s), s).toBeUndefined();
        expect(titleValue("target", s), s).toBeUndefined();
        expect(runTitle(["map", s], []).command, s).toEqual(["map", "…"]);
      }
  });

  it("has one list of token prefixes, core's, that every check reads", () => {
    expect(TOKEN_PREFIXES.length).toBeGreaterThan(10);
    for (const w of [
      tok("gh", "p_x"),
      tok("github", "_pat_x"),
      tok("gl", "pat-x"),
      tok("np", "m_x"),
      tok("sk", "-x"),
      tok("rk", "_x"),
      tok("pk", "_x"),
      tok("wh", "sec_x"),
      tok("xo", "xp-x"),
      tok("AK", "IA", "ABCD"),
      tok("AI", "za"),
      tok("ey", "J"),
      tok("SG", ".x"),
      tok("sq0", "atp-x"),
      tok("sq0", "csp-x"),
      tok("SK", "0123abcd"),
      tok("Account", "Key=x"),
      tok("Bea", "rer x"),
    ])
      expect(hasTokenPrefix(w), w).toBe(true);
    for (const w of ["forge-ledger", "task-run", "risk-limits", "Ledger", "ask"])
      expect(hasTokenPrefix(w), w).toBe(false);
  });
});

describe("beta.27 re-review: the runs beta.26 kept are titled again once", () => {
  const record = (runId: string, command: string[], flags: string[] = []) => ({
    schemaVersion: 1,
    runId,
    pid: 4242,
    host: "abc",
    title: ["atticus", ...command, ...flags.map((f) => `--${f}`)].join(" "),
    command,
    flags,
    startedBy: "terminal",
    startedAt: "2026-11-01T10:00:00.000Z",
    state: "done",
    finishedAt: "2026-11-01T10:00:01.000Z",
    exitCode: 2,
    lines: 1,
    dropped: 0,
  });
  const key = "Zx9Kq2Lm8Pw4Rt6Yv1Bn3Cd5Fg7Hj0";
  const keep = (root: string, recs: ReturnType<typeof record>[], log = "a line\n") => {
    mkdirSync(runningDirOf(root), { recursive: true });
    mkdirSync(runLogsDirOf(root), { recursive: true });
    for (const r of recs) {
      writeFileSync(join(runningDirOf(root), `${r.runId}.json`), JSON.stringify(r));
      writeFileSync(join(runLogsDirOf(root), `${r.runId}.log`), log);
    }
  };
  const read = (root: string, id: string) =>
    JSON.parse(readFileSync(join(runningDirOf(root), `${id}.json`), "utf8")) as Record<
      string,
      unknown
    >;
  // The command line's rule: here, at most the command and one argument (a test's own).
  const short = (r: { command: string[]; flags: string[] }) =>
    runTitle(r.command.slice(0, 2), r.flags);

  it("writes each title and its words again by the new rules, and nothing else of it", async () => {
    const root = await fresh();
    const long = record("20261101-100000-4242-ab12", ["map", "forge-ledger", key]);
    const fine = record("20261101-100100-4242-cd34", ["map", "forge-ledger"], ["handoff"]);
    keep(root, [long, fine]);
    expect(retitleTerminalRuns(root, short)).toBe(1);
    const after = read(root, long.runId);
    expect(after.title).toBe("atticus map forge-ledger");
    expect(JSON.stringify(after)).not.toContain(key);
    // Everything else of the record as it was; its log untouched.
    const { title: _t, command: _c, ...rest } = after;
    const { title: _t0, command: _c0, ...was } = long;
    expect(rest).toEqual(was);
    expect(read(root, fine.runId)).toEqual(fine);
    expect(readFileSync(join(runLogsDirOf(root), `${long.runId}.log`), "utf8")).toBe("a line\n");
    // Once: the mark says it was done, so a record written after it is left alone.
    expect(existsSync(join(runningDirOf(root), RETITLED_MARK))).toBe(true);
    writeFileSync(join(runningDirOf(root), `${long.runId}.json`), JSON.stringify(long));
    expect(retitleTerminalRuns(root, (r) => runTitle([], r.flags))).toBe(0);
    expect(read(root, long.runId).title).toBe(long.title);
  });

  it("removes a run of `secret`, its record and its log (beta.26 printed a mistyped key there)", async () => {
    const root = await fresh();
    const set = record("20261101-100000-4242-ab12", ["secret", "set", "ATTICUS_MODEL_KEY", key]);
    const check = record("20261101-100100-4242-cd34", ["secret", "check", "ATTICUS_MODEL_KEY"]);
    const fine = record("20261101-100200-4242-ef56", ["map", "forge-ledger"]);
    keep(root, [set, check, fine], `atticus: ${key} isn't a variable's name\n`);
    expect(retitleTerminalRuns(root, short)).toBe(2);
    expect(readdirSync(runningDirOf(root)).sort()).toEqual([
      ".retitled-beta27",
      `${fine.runId}.json`,
    ]);
    expect(readdirSync(runLogsDirOf(root))).toEqual([`${fine.runId}.log`]);
    expect(readTerminalRuns(root, { alive: () => false }).map((r) => r.title)).toEqual([
      "atticus map forge-ledger",
    ]);
  });

  it("gives the flag names the command line's rule gives", async () => {
    const root = await fresh();
    const odd = record("20261101-100000-4242-ab12", ["map", "forge-ledger"], ["json", "hunter2"]);
    keep(root, [odd]);
    const n = retitleTerminalRuns(root, (r) => {
      const flags = r.flags.map((f) => (f === "json" ? f : "…"));
      return { ...runTitle(r.command, flags), flags: flags.filter((f) => f !== "…") };
    });
    expect(n).toBe(1);
    expect(read(root, odd.runId)).toMatchObject({
      title: "atticus map forge-ledger --json --…",
      flags: ["json"],
    });
  });

  it("does nothing where no run was kept, and never throws on a record it can't read", async () => {
    const root = await fresh();
    expect(retitleTerminalRuns(root, (r) => runTitle(r.command, r.flags))).toBe(0);
    mkdirSync(runningDirOf(root), { recursive: true });
    writeFileSync(join(runningDirOf(root), "20261101-100000-4242-ab12.json"), "{not json");
    writeFileSync(join(runningDirOf(root), "20261101-100001-4242-ab13.json"), "null");
    writeFileSync(join(runningDirOf(root), "20261101-100002-4242-ab14.json"), "[1]");
    expect(retitleTerminalRuns(root, (r) => runTitle(r.command, r.flags))).toBe(0);
    expect(readdirSync(runningDirOf(root)).sort()).toEqual([
      ".retitled-beta27",
      "20261101-100000-4242-ab12.json",
      "20261101-100001-4242-ab13.json",
      "20261101-100002-4242-ab14.json",
    ]);
  });

  it("writes the mark when nothing changed", async () => {
    const root = await fresh();
    const fine = record("20261101-100000-4242-ab12", ["map", "forge-ledger"]);
    keep(root, [fine]);
    expect(retitleTerminalRuns(root, short)).toBe(0);
    expect(read(root, fine.runId)).toEqual(fine);
    expect(existsSync(join(runningDirOf(root), RETITLED_MARK))).toBe(true);
  });

  it("leaves a live run to its process and tries again later; a run killed under beta.26 is titled again", async () => {
    const root = await fresh();
    // Started minutes ago on another machine: its process can't be looked for, so it is live.
    const live = {
      ...record("20261101-100000-4242-ab12", ["map", "forge-ledger", key]),
      state: "running",
      startedAt: new Date(Date.now() - 60_000).toISOString(),
    };
    // Ctrl-C under beta.26 days ago: still "running" in its record, its process long gone.
    const killed = {
      ...record("20261101-100100-4242-cd34", ["map", "forge-ledger", key]),
      state: "running",
    };
    keep(root, [live, killed]);
    expect(retitleTerminalRuns(root, short)).toBe(1);
    expect(read(root, live.runId)).toEqual(live);
    expect(read(root, killed.runId).title).toBe("atticus map forge-ledger");
    expect(JSON.stringify(read(root, killed.runId))).not.toContain(key);
    // The live one waits: no mark, so the next command looks at it again.
    expect(existsSync(join(runningDirOf(root), RETITLED_MARK))).toBe(false);
    writeFileSync(
      join(runningDirOf(root), `${live.runId}.json`),
      JSON.stringify({ ...live, state: "done" }),
    );
    expect(retitleTerminalRuns(root, short)).toBe(1);
    expect(read(root, live.runId).title).toBe("atticus map forge-ledger");
    expect(existsSync(join(runningDirOf(root), RETITLED_MARK))).toBe(true);
  });

  it("tries a `secret` run's removal again when it failed, and writes no mark until it is gone", async () => {
    const root = await fresh();
    const set = record("20261101-100000-4242-ab12", ["secret", "set", "ATTICUS_MODEL_KEY", key]);
    keep(root, [set]);
    // Something in the log's place that can't be removed as a file (as a file held open on
    // Windows can't): the record stays, and so does the chance to remove it.
    const log = join(runLogsDirOf(root), `${set.runId}.log`);
    rmSync(log);
    mkdirSync(log);
    writeFileSync(join(log, "held"), key);
    expect(retitleTerminalRuns(root, short)).toBe(0);
    expect(existsSync(join(runningDirOf(root), `${set.runId}.json`))).toBe(true);
    expect(existsSync(join(runningDirOf(root), RETITLED_MARK))).toBe(false);
    rmSync(log, { recursive: true });
    writeFileSync(log, `atticus: ${key} isn't a variable's name\n`);
    expect(retitleTerminalRuns(root, short)).toBe(1);
    expect(existsSync(join(runningDirOf(root), `${set.runId}.json`))).toBe(false);
    expect(existsSync(log)).toBe(false);
    expect(existsSync(join(runningDirOf(root), RETITLED_MARK))).toBe(true);
  });

  it("reads only a small regular file: never a link, a FIFO, a folder or a big file", async () => {
    const root = await fresh();
    const dir = runningDirOf(root);
    keep(root, []);
    // Outside the metarepo, linked to from inside it: never read nor written through.
    const outside = join(await mkdtemp(join(tmpdir(), "atticus-run-log-out-")), "theirs.json");
    const theirs = JSON.stringify(
      record("20261101-100000-4242-ab12", ["map", "forge-ledger", key]),
    );
    writeFileSync(outside, theirs);
    const linked = join(dir, "20261101-100000-4242-ab12.json");
    let links = true;
    try {
      symlinkSync(outside, linked);
    } catch {
      links = false; // Windows without the right to make links
    }
    // A FIFO (it would block every command), where the platform has them.
    const fifo = join(dir, "20261101-100001-4242-ab13.json");
    let fifos = false;
    if (process.platform !== "win32")
      try {
        execFileSync("mkfifo", [fifo]);
        fifos = true;
      } catch {
        // no mkfifo here
      }
    mkdirSync(join(dir, "20261101-100002-4242-ab14.json"));
    const big = record("20261101-100003-4242-ab15", ["map", "forge-ledger", key]);
    writeFileSync(
      join(dir, `${big.runId}.json`),
      JSON.stringify({ ...big, pad: "x".repeat(RETITLE_MAX_BYTES) }),
    );
    const started = Date.now();
    expect(retitleTerminalRuns(root, short)).toBe(0);
    expect(Date.now() - started).toBeLessThan(5000);
    if (links) {
      expect(lstatSync(linked).isSymbolicLink()).toBe(true);
      expect(readFileSync(outside, "utf8")).toBe(theirs);
    }
    if (fifos) expect(lstatSync(fifo).isFIFO()).toBe(true);
    expect(readFileSync(join(dir, `${big.runId}.json`), "utf8")).toContain(key);
    expect(existsSync(join(dir, RETITLED_MARK))).toBe(true);
  });

  it("never writes the mark through a link left at its name", async () => {
    const root = await fresh();
    keep(root, [record("20261101-100000-4242-ab12", ["map", "forge-ledger"])]);
    const outside = join(await mkdtemp(join(tmpdir(), "atticus-run-log-out-")), "mark");
    try {
      symlinkSync(outside, join(runningDirOf(root), RETITLED_MARK));
    } catch {
      return; // Windows without the right to make links
    }
    // A link there (dangling) is a mark: nothing is done, nothing is made outside.
    expect(retitleTerminalRuns(root, short)).toBe(0);
    expect(existsSync(outside)).toBe(false);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "leaves a metarepo it can't write alone, and tries no more in this process",
    async () => {
      const root = await fresh();
      const long = record("20261101-100000-4242-ab12", ["map", "forge-ledger", key]);
      keep(root, [long]);
      chmodSync(runningDirOf(root), 0o555);
      try {
        let calls = 0;
        const counted = (r: { command: string[]; flags: string[] }) => {
          calls++;
          return short(r);
        };
        expect(retitleTerminalRuns(root, counted)).toBe(0);
        expect(retitleTerminalRuns(root, counted)).toBe(0);
        // Not read at all: nothing there could be written.
        expect(calls).toBe(0);
        expect(read(root, long.runId)).toEqual(long);
      } finally {
        chmodSync(runningDirOf(root), 0o755);
      }
    },
  );
});

/**
 * Beta.27 review: the app's jobs were in memory only, so a restart of the app lost them from the
 * Console, Runs and Problems. Each is kept in the run log as a command run is, `app` as where it
 * started, with its job and the app's own title; one still running when the app closed says so.
 */
describe("a job the app started, in the run log", () => {
  it("records its title, job, lines and end, and is never retitled", async () => {
    const root = await fresh();
    const rec = startAppRun(root, {
      title: "Sync forge-ledger, forge-portal",
      job: { id: "job-3", kind: "sync" },
      now: at("2026-11-11T10:00:00.000Z"),
      redact: HOME,
    })!;
    rec.line("forge-ledger: cloned into /home/tom/work/forge");
    rec.end(0);
    const [r] = readTerminalRuns(root, { alive: () => true });
    expect(r).toMatchObject({
      title: "Sync forge-ledger, forge-portal",
      startedBy: "app",
      job: { id: "job-3", kind: "sync" },
      state: "done",
      command: [],
    });
    expect(readTerminalRunLines(root, rec.runId)!.lines[0]).not.toContain("/home/tom");
    expect(retitleTerminalRuns(root, () => ({ command: ["x"], title: "atticus x" }))).toBe(0);
    expect(readTerminalRuns(root, { alive: () => true })[0]!.title).toBe(
      "Sync forge-ledger, forge-portal",
    );
  });

  it("one running when the app closed says so; one whose app crashed reads as stale", async () => {
    const root = await fresh();
    const closed = startAppRun(root, { title: "Scan", job: { id: "job-1", kind: "scan" } })!;
    closed.end(143, "app-closed");
    const crashed = startAppRun(root, { title: "Sync", job: { id: "job-2", kind: "sync" } })!;
    const runs = readTerminalRuns(root, { alive: () => false });
    const byId = new Map(runs.map((r) => [r.runId, r]));
    expect(byId.get(closed.runId)).toMatchObject({ state: "cancelled", appClosed: true });
    expect(byId.get(crashed.runId)).toMatchObject({ state: "running", stale: true });
  });

  it("several jobs started in one second each get their own record", async () => {
    const root = await fresh();
    const now = at("2026-11-11T10:00:00.000Z");
    const ids = new Set<string>();
    for (let i = 0; i < 20; i++)
      ids.add(
        startAppRun(root, { title: `Job ${i}`, job: { id: `job-${i}`, kind: "work" }, now })!.runId,
      );
    expect(ids.size).toBe(20);
  });
});
