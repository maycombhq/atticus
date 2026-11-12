import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readTerminalRuns,
  recordedCommand,
  RETITLED_MARK,
  runLogsDirOf,
  runningDirOf,
  runTitle,
} from "@maycombhq/core";
import { startServer } from "@maycombhq/server";
import { titleSlotsOf, titleWordsByHelp } from "../src/command-catalog.js";
import { HELP_TEXT, main, titleInputsOf } from "../src/main.js";
import { aliasArgv } from "../src/top-commands.js";
import { uiActivityRoutes } from "../src/ui-api-activity.js";

/**
 * Beta.27 re-review: a run's title (ADR 0187) shows only the words a command declares, each an
 * id's strict shape and no secret's. The reviewer's adversarial command lines (adv.mjs), each as
 * the command line reads it, and end to end at an invented Forge metarepo. Every token-shaped
 * string is made as the test runs (push protection rejects them as literals). No network.
 */

const tok = (...parts: string[]) => parts.join("");
const KEY = "Zx9Kq2Lm8Pw4Rt6Yv1Bn3Cd5Fg7Hj0";

/** The title the command line gives a command line, as main and recorderFor read it. */
const titleOf = (line: string | string[]) => {
  const given = typeof line === "string" ? line.split(" ") : line;
  const argv = aliasArgv(
    given,
    given.flatMap((a, i) => (a.startsWith("-") ? [] : [i])),
  );
  const flags = [
    ...new Set(argv.filter((a) => a.startsWith("--")).map((a) => a.slice(2).split("=")[0]!)),
  ];
  const t = titleInputsOf(argv, flags);
  return {
    title: runTitle(t.positionals, t.flags, t.values).title,
    recorded: recordedCommand(t.positionals, flags),
  };
};

/** What no title may show, whichever command line it came from. */
const SECRETS = [
  KEY,
  "Zx9Kq2Lm",
  "AbCdEfGh",
  "abcdefghijklmnopqrstuvwxyz",
  "Summer2026",
  "hunter2",
  "hunter3",
  "tom@",
  "tom%40",
  "tom＠",
  tok("sk", "-ant"),
  "https:",
  "user:pw",
  "AC1234567890",
  "4111",
  tok("SG", ".abc"),
  tok("xo", "xb-"),
  tok("sq0", "atp"),
  tok("SK", "1234567890"),
  "AccountKey",
  "wJalrXUtnFEMI",
  tok("da", "pi1234"),
  "ATTICUS_KEY",
  "123-45-6789",
  tok("ey", "JhbGci"),
  "role=",
  "API_KEY",
  "password",
  "salary",
  "dev.azure.com",
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
];

describe("beta.27 re-review: the reviewer's command lines give titles with no secret", () => {
  const lines: [string, string][] = [
    [`map forge-ledger --target ${KEY}`, "atticus map forge-ledger --target"],
    ["map forge-ledger --target AbCdEfGhIjKlMnOpQrStUvWx", "atticus map forge-ledger --target"],
    [
      "map forge-ledger --target abcdefghijklmnopqrstuvwxyzabcdef",
      "atticus map forge-ledger --target",
    ],
    ["map forge-ledger --target Summer2026", "atticus map forge-ledger --target"],
    ["map forge-ledger --target Summer2026!", "atticus map forge-ledger --target"],
    ["map forge-ledger --by tom@bank.example", "atticus map forge-ledger --by"],
    ["map forge-ledger --by tom%40bank.example", "atticus map forge-ledger --by"],
    ["map forge-ledger --by tom＠bank.example", "atticus map forge-ledger --by"],
    ["map forge-ledger --by @tom.george", "atticus map forge-ledger --by @tom.george"],
    [`map forge-ledger --model ${tok("sk", "-ant-abc")}`, "atticus map forge-ledger --model"],
    ["map forge-ledger --model azure/https:x", "atticus map forge-ledger --model"],
    ["map forge-ledger --base user:pw", "atticus map forge-ledger --base"],
    [
      `map forge-ledger --pr ${tok("AC", "1234567890abcdef", "1234567890abcdef")}`,
      "atticus map forge-ledger --pr",
    ],
    ["map forge-ledger --pr 4111111111111111", "atticus map forge-ledger --pr"],
    ["map forge-ledger --pr 4111-1111-1111-1111", "atticus map forge-ledger --pr"],
    [`map forge-ledger --repo ${tok("SG", ".abc.def")}`, "atticus map forge-ledger --repo"],
    [`map forge-ledger --repo ${tok("xo", "xb-123-456-abc")}`, "atticus map forge-ledger --repo"],
    [
      `map forge-ledger --repo ${tok("sq0", "atp-AbCdEf123456")}`,
      "atticus map forge-ledger --repo",
    ],
    [`map forge-ledger --repo ${tok("SK", "1234567890")}`, "atticus map forge-ledger --repo"],
    ["map forge-ledger --repo AccountKey/abc+def/ghij", "atticus map forge-ledger --repo"],
    [
      `map forge-ledger --repo ${tok("wJalrXUtnFEMI", "/K7MDENG/", "bPxRfiCY", "EXAMPLEKEY")}`,
      "atticus map forge-ledger --repo",
    ],
    [
      `map forge-ledger --repo ${tok("da", "pi1234567890abcdef")}`,
      "atticus map forge-ledger --repo",
    ],
    ["map forge-ledger --repo ATTICUS_KEY:Zx9Kq2Lm", "atticus map forge-ledger --repo"],
    [`map forge-ledger --repo a,${KEY}`, "atticus map forge-ledger --repo"],
    ["map forge-ledger --target=Zx9Kq2Lm8Pw4Rt6", "atticus map forge-ledger --target"],
    // A known flag that took the next flag as its value: the word after is that flag's.
    ["map forge-ledger --note --pass hunter2", "atticus map forge-ledger … --note --pass"],
    ["map forge-ledger --pass hunter2", "atticus map forge-ledger … --pass"],
    ["map forge-ledger -p hunter2", "atticus map forge-ledger …"],
    ["map forge-ledger --pass=hunter2 hunter3", "atticus map forge-ledger … --pass"],
    // A word after a switch, past map's one argument: never shown.
    ["map forge-ledger --json hunter2", "atticus map forge-ledger … --json"],
    // Nothing after `--`, flags included.
    ["map forge-ledger -- --password hunter2", "atticus map forge-ledger …"],
    ["map forge-ledger --target 123-45-6789", "atticus map forge-ledger --target"],
    ["map forge-ledger --release 2027-03-31", "atticus map forge-ledger --release 2027-03-31"],
    [
      "map forge-ledger --repos forge-ledger,forge-teller",
      "atticus map forge-ledger --repos forge-ledger,forge-teller",
    ],
    [`map forge-ledger --target ${tok("ey", "JhbGciOi")}`, "atticus map forge-ledger --target"],
    ["map forge-ledger --owner role=a,b", "atticus map forge-ledger --owner"],
    [`map forge-ledger --system x --system ${KEY}`, "atticus map forge-ledger --system"],
    [`map forge-ledger --scope ${"a".repeat(60)}`, "atticus map forge-ledger --scope"],
    ["map forge-ledger --target ${API_KEY}", "atticus map forge-ledger --target"],
    ["map forge-ledger --target env:API_KEY", "atticus map forge-ledger --target"],
    ["map forge-ledger --hunter2pass", "atticus map forge-ledger --hunter2pass"],
    ["map --by=@bao forge-ledger", "atticus map forge-ledger --by @bao"],
    // A path or a URL in an argument's place is never shown, nor a file's name.
    ["repo add dev.azure.com/forge/_git/ledger", "atticus repo add …"],
    ["intake add docs/salary-tom-george.pdf", "atticus intake add …"],
    // `--ignore` is a switch the command line declares (it was help-only): the id before it stays.
    [
      "questions answer --ignore q-0123456789ab",
      "atticus questions answer q-0123456789ab --ignore",
    ],
  ];
  for (const [line, want] of lines)
    it(line.replaceAll(KEY, "<key>"), () => {
      const got = titleOf(line);
      expect(got.title).toBe(want);
      expect(got.recorded).toBe(true);
      for (const s of SECRETS.filter((x) => !want.includes(x))) expect(got.title).not.toContain(s);
    });

  it("keeps no run of `secret`, whatever follows it", () => {
    for (const line of [
      `secret set ATTICUS_MODEL_KEY ${KEY}`,
      "secret set ATTICUS_MODEL_KEY Summer2026",
      `secret set ATTICUS_MODEL_KEY ${tok("gh", "p_16C7e42F292c6912E7710c838347Ae178B4a")}`,
      `secret set ATTICUS_MODEL_KEY ${tok("gl", "pat-", "x".repeat(20))}`,
      "secret set ATTICUS_MODEL_KEY 0123456789abcdef0123456789abcdef",
      `secret set ATTICUS_MODEL_KEY ${tok("AK", "IA", "IOSFODNN7EXAMPLE")}`,
      `secret set ATTICUS_MODEL_KEY ${tok("xo", "xb-123456789012-abcdefABCDEF")}`,
      `secret set ${KEY}`,
    ])
      expect(titleOf(line).recorded).toBe(false);
  });

  it("shows a word only in the places the help declares for an id", () => {
    const slots = titleSlotsOf(HELP_TEXT);
    const w = (...words: string[]) => titleWordsByHelp(words, slots);
    expect(w("task", "run", "c1", "t1", "extra")).toEqual(["task", "run", "c1", "t1", "…"]);
    expect(w("finding", "c1", "f1", "waive")).toEqual(["finding", "c1", "f1", "waive"]);
    expect(w("ci", "snippet", "gitlab")).toEqual(["ci", "snippet", "gitlab"]);
    expect(w("ci", "snippet", "hunter2")).toEqual(["ci", "snippet", "…"]);
    expect(w("change", "new", "Summer")).toEqual(["change", "new", "…"]);
    expect(w("questions", "answer", "q-0123456789ab")).toEqual([
      "questions",
      "answer",
      "q-0123456789ab",
    ]);
    expect(w("feature", "tag", "f1", "a", "b")).toEqual(["feature", "tag", "f1", "a", "b"]);
    expect(w("handoff", "done", "run-20261109101530-ab12cd")).toEqual([
      "handoff",
      "done",
      "run-20261109101530-ab12cd",
    ]);
    // A command the help doesn't know shows its first word only.
    expect(w("frobnicate", "forge-ledger", "hunter2")).toEqual(["frobnicate", "…"]);
  });
});

const metarepo = async () => {
  const root = await mkdtemp(join(tmpdir(), "atticus-b27-titles-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  return root;
};
const io = () => {
  const out: string[] = [];
  return { out, io: { out: (l: string) => out.push(l), err: (l: string) => out.push(l) } };
};
const allOf = async (dir: string) =>
  (await Promise.all((await readdir(dir)).map((f) => readFile(join(dir, f), "utf8")))).join("\n");

describe("beta.27 re-review: end to end at a metarepo", () => {
  it("keeps no run of `secret set` with a key after the name, and says nothing of it", async () => {
    const r = await metarepo();
    const o = io();
    const code = await main(["secret", "set", "ATTICUS_MODEL_KEY", KEY, "--root", r], o.io, {
      record: true,
    });
    expect(code).toBe(2);
    expect(o.out.join("\n")).not.toContain(KEY);
    expect(readTerminalRuns(r)).toEqual([]);
  });

  it("records the reviewer's command lines with titles that show no secret", async () => {
    const r = await metarepo();
    for (const line of [
      "map forge-ledger --note --pass hunter2",
      "map forge-ledger --json hunter2",
      "map forge-ledger -- --password hunter2",
      `map forge-ledger --target ${KEY}`,
      "map forge-ledger --target Summer2026",
    ])
      await main([...line.split(" "), "--root", r], io().io, { record: true });
    const titles = readTerminalRuns(r).map((t) => t.title);
    expect(titles).toHaveLength(5);
    const raw = `${await allOf(runningDirOf(r))}\n${await allOf(runLogsDirOf(r))}`;
    for (const s of ["hunter2", KEY, "Summer2026", "--password"]) expect(raw, s).not.toContain(s);
  });

  it("titles the runs beta.26 kept again on beta.27's first command, and the Console serves those", async () => {
    const r = await metarepo();
    const running = runningDirOf(r);
    await mkdir(running, { recursive: true });
    await mkdir(runLogsDirOf(r), { recursive: true });
    // As beta.26 wrote them: every word that looked like an id, a key typed after the name too.
    const beta26 = (runId: string, command: string[], flags: string[] = []) => ({
      schemaVersion: 1,
      runId,
      pid: 999999,
      host: "elsewhere",
      title: ["atticus", ...command, ...flags.map((f) => `--${f}`)].join(" "),
      command,
      flags,
      startedBy: "terminal",
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      state: "failed",
      finishedAt: new Date(Date.now() - 59_000).toISOString(),
      exitCode: 2,
      lines: 1,
      dropped: 0,
    });
    const old = [
      beta26("20261101-100000-4242-ab12", ["secret", "set", "ATTICUS_MODEL_KEY", KEY]),
      beta26("20261101-100100-4242-cd34", ["map", "forge-ledger", "hunter2"], ["json"]),
      beta26("20261101-100200-4242-ef56", ["intake", "add", "docs/salary-tom-george.pdf"]),
      beta26("20261101-100300-4242-0a1b", ["verify", "forge-ledger"], ["write"]),
    ];
    for (const rec of old) {
      await writeFile(join(running, `${rec.runId}.json`), JSON.stringify(rec));
      await writeFile(join(runLogsDirOf(r), `${rec.runId}.log`), "atticus: a line\n");
    }
    // Any command at the metarepo, recorded or not.
    await main(["next", "--root", r], io().io);
    const byId = new Map(readTerminalRuns(r).map((t) => [t.runId, t]));
    expect(byId.get(old[0]!.runId)?.title).toBe("atticus secret set ATTICUS_MODEL_KEY …");
    expect(byId.get(old[1]!.runId)?.title).toBe("atticus map forge-ledger … --json");
    expect(byId.get(old[2]!.runId)?.title).toBe("atticus intake add …");
    expect(byId.get(old[3]!.runId)?.title).toBe("atticus verify forge-ledger --write");
    expect(byId.get(old[0]!.runId)).toMatchObject({ state: "failed", exitCode: 2, lines: 1 });
    expect(await readFile(join(runLogsDirOf(r), `${old[0]!.runId}.log`), "utf8")).toBe(
      "atticus: a line\n",
    );
    expect((await readdir(running)).includes(RETITLED_MARK)).toBe(true);
    const raw = await allOf(running);
    for (const s of [KEY, "hunter2", "salary"]) expect(raw, s).not.toContain(s);
    const s = await startServer({
      root: r,
      port: 0,
      user: "pat",
      watch: false,
      extend: (x, ctx) => uiActivityRoutes(x, ctx, { alive: () => false, tickMs: 50 }),
    });
    try {
      const got = await fetch(`${s.url}/api/activity`, { headers: { "X-Atticus-Token": s.token } });
      const body = JSON.stringify(await got.json());
      expect(body).toContain("atticus secret set ATTICUS_MODEL_KEY …");
      for (const x of [KEY, "hunter2", "salary"]) expect(body, x).not.toContain(x);
    } finally {
      await s.close();
    }
  });
});
