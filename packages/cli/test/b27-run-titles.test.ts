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
import { parseHelp, titleSlotsOf, titleWordsByHelp } from "../src/command-catalog.js";
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
  "pat@",
  "pat%40",
  "pat＠",
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
  "quarterly",
  "correct-horse",
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
    ["map forge-ledger --by pat@bank.example", "atticus map forge-ledger --by"],
    ["map forge-ledger --by pat%40bank.example", "atticus map forge-ledger --by"],
    ["map forge-ledger --by pat＠bank.example", "atticus map forge-ledger --by"],
    ["map forge-ledger --by @bao.ops", "atticus map forge-ledger --by @bao.ops"],
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
    // A flag the command line doesn't declare: its name is `--…` too (it may be the secret).
    ["map forge-ledger --note --pass hunter2", "atticus map forge-ledger … --note --…"],
    ["map forge-ledger --pass hunter2", "atticus map forge-ledger … --…"],
    ["map forge-ledger -p hunter2", "atticus map forge-ledger …"],
    ["map forge-ledger --pass=hunter2 hunter3", "atticus map forge-ledger … --…"],
    ["map forge-ledger --correct-horse-battery-staple", "atticus map forge-ledger --…"],
    ["map forge-ledger --json --hunter2 --swordfish", "atticus map forge-ledger --json --…"],
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
    ["map forge-ledger --hunter2pass", "atticus map forge-ledger --…"],
    ["map --by=@bao forge-ledger", "atticus map forge-ledger --by @bao"],
    // A path or a URL in an argument's place is never shown, nor a file's name.
    ["repo add dev.azure.com/forge/_git/ledger", "atticus repo add …"],
    ["intake add docs/quarterly-notes.pdf", "atticus intake add …"],
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

  it("never shows a word in a place the help quotes (free text), whatever its name", () => {
    const slots = titleSlotsOf(HELP_TEXT);
    // `alias "<name>" <id>` and `feature name <id> "<name>"`: the quoted name is typed text.
    expect(HELP_TEXT).toMatch(/atticus alias "<name>"/);
    expect(HELP_TEXT).toMatch(/atticus feature name <[a-z-]+> "<name>"/);
    expect(titleWordsByHelp(["alias", "swordfish", "forge-ledger"], slots)).toEqual([
      "alias",
      "…",
      "forge-ledger",
    ]);
    expect(titleWordsByHelp(["feature", "name", "f-1", "letmein"], slots)).toEqual([
      "feature",
      "name",
      "f-1",
      "…",
    ]);
    expect(titleOf("alias swordfish forge-ledger").title).toBe("atticus alias … forge-ledger");
    // Every quoted argument of the help, in every command.
    for (const c of parseHelp(HELP_TEXT)) {
      // An argument's, not an option's value (`--reason "<why>"`).
      const quoted = [...c.usage.matchAll(/"<([a-z][a-z|-]*?)(\.\.\.)?>"/g)].filter(
        (m) => !/--[a-z-]+ ?$/.test(c.usage.slice(0, m.index)),
      ).length;
      if (!quoted) continue;
      const placed = slots.get(c.words.join(" "))!;
      const shown = placed.filter((p) => p.id).length;
      expect(shown, c.usage).toBeLessThanOrEqual(placed.length - quoted);
    }
  });

  it("keeps a work item's reference only for a tracker C1 names", () => {
    for (const ref of ["ado:1234", "jira:4711", "jira:PAY-12"])
      expect(titleOf(`knowledge verify ${ref}`).title, ref).toBe(`atticus knowledge verify ${ref}`);
    for (const pin of ["pin:1234", "pass:1234", "otp:123456", "code:42"])
      expect(titleOf(`knowledge verify ${pin}`).title, pin).toBe("atticus knowledge verify …");
  });

  it("titles a title's words as they are: titleWordsByHelp twice is once, over the whole help", () => {
    const slots = titleSlotsOf(HELP_TEXT);
    let n = 0;
    for (const c of parseHelp(HELP_TEXT)) {
      const typed = [
        ...c.words,
        ...c.args.map((a, i) => (a.choices ? a.choices[0]! : i % 2 ? "Free Text" : "forge-x")),
        "extra",
      ];
      const once = titleWordsByHelp(typed, slots);
      expect(titleWordsByHelp(once, slots), typed.join(" ")).toEqual(once);
      // And as a run's title, then titled again as the migration does.
      const title = runTitle(once, []);
      expect(runTitle(titleWordsByHelp(title.command, slots), []).title).toBe(title.title);
      n++;
    }
    expect(n).toBeGreaterThan(100);
  });

  it("gives `join shared refresh <team>` and `estate shared refresh <team>` the same places", () => {
    for (const sub of ["refresh forge-team", "import ../theirs --team forge-team", "list"]) {
      const a = titleOf(`join shared ${sub}`).title;
      expect(titleOf(`estate shared ${sub}`).title, sub).toBe(a);
    }
    expect(titleOf("join shared refresh forge-team").title).toBe(
      "atticus estate shared refresh forge-team",
    );
    const slots = titleSlotsOf(HELP_TEXT);
    expect(slots.get("estate shared refresh")).toEqual(slots.get("join shared refresh"));
    expect(slots.get("estate shared import")).toEqual(slots.get("join shared import"));
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
  const keptAt = async (
    r: string,
    recs: ReturnType<typeof beta26>[],
    log = "atticus: a line\n",
  ) => {
    await mkdir(runningDirOf(r), { recursive: true });
    await mkdir(runLogsDirOf(r), { recursive: true });
    for (const rec of recs) {
      await writeFile(join(runningDirOf(r), `${rec.runId}.json`), JSON.stringify(rec));
      await writeFile(join(runLogsDirOf(r), `${rec.runId}.log`), log);
    }
  };

  it("titles the runs beta.26 kept again on beta.27's first command, and the Console serves those", async () => {
    const r = await metarepo();
    const running = runningDirOf(r);
    const old = [
      beta26("20261101-100000-4242-ab12", ["secret", "set", "ATTICUS_MODEL_KEY", KEY]),
      beta26("20261101-100100-4242-cd34", ["map", "forge-ledger", "hunter2"], ["json"]),
      beta26("20261101-100200-4242-ef56", ["intake", "add", "docs/quarterly-notes.pdf"]),
      beta26("20261101-100300-4242-0a1b", ["verify", "forge-ledger"], ["write"]),
      beta26(
        "20261101-100400-4242-1c2d",
        ["map", "forge-ledger"],
        ["correct-horse-battery-staple"],
      ),
    ];
    // beta.26 printed a mistyped key back into a `secret` run's log.
    await keptAt(r, old, `atticus: ${KEY} isn't a variable's name\n`);
    // Any command at the metarepo, recorded or not, run by the command line.
    await main(["next", "--root", r], io().io, { record: true });
    const byId = new Map(readTerminalRuns(r).map((t) => [t.runId, t]));
    // A run of `secret`: gone, its record and its log.
    expect(byId.has(old[0]!.runId)).toBe(false);
    expect(await readdir(running)).not.toContain(`${old[0]!.runId}.json`);
    expect(await readdir(runLogsDirOf(r))).not.toContain(`${old[0]!.runId}.log`);
    expect(byId.get(old[1]!.runId)?.title).toBe("atticus map forge-ledger … --json");
    expect(byId.get(old[2]!.runId)?.title).toBe("atticus intake add …");
    expect(byId.get(old[3]!.runId)?.title).toBe("atticus verify forge-ledger --write");
    expect(byId.get(old[4]!.runId)).toMatchObject({
      title: "atticus map forge-ledger --…",
      flags: [],
    });
    expect(byId.get(old[1]!.runId)).toMatchObject({ state: "failed", exitCode: 2, lines: 1 });
    expect((await readdir(running)).includes(RETITLED_MARK)).toBe(true);
    const raw = await allOf(running);
    for (const s of [KEY, "hunter2", "quarterly", "secret set", "correct-horse"])
      expect(raw, s).not.toContain(s);
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
      expect(body).toContain("atticus verify forge-ledger --write");
      for (const x of [KEY, "hunter2", "quarterly", "secret set", "correct-horse"])
        expect(body, x).not.toContain(x);
    } finally {
      await s.close();
    }
  });

  it("leaves the runs alone when the run log is off, and in a job the app's server runs", async () => {
    const r = await metarepo();
    const old = [beta26("20261101-100100-4242-cd34", ["map", "forge-ledger", "hunter2"])];
    await keptAt(r, old);
    // The app's server runs a command in itself: main without `record`.
    await main(["next", "--root", r], io().io);
    expect(await readdir(runningDirOf(r))).not.toContain(RETITLED_MARK);
    const was = process.env.ATTICUS_RUN_LOG;
    process.env.ATTICUS_RUN_LOG = "off";
    try {
      await main(["next", "--root", r], io().io, { record: true });
    } finally {
      if (was === undefined) delete process.env.ATTICUS_RUN_LOG;
      else process.env.ATTICUS_RUN_LOG = was;
    }
    expect(await readdir(runningDirOf(r))).not.toContain(RETITLED_MARK);
    expect(readTerminalRuns(r)[0]?.title).toBe("atticus map forge-ledger hunter2");
  });
});
