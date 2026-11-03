import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { MockRuntime, type AiRuntime } from "@maycombhq/ai";
import { rulesNow } from "@maycombhq/assistant-files";
import {
  mapAllCommand,
  readMapAllState,
  type Clock,
  type MapAllDeps,
  type MapAllPlan,
} from "../src/map-all.js";
import { mapCommand } from "../src/map-commands.js";
import { readPlanProgress } from "../src/map-parts.js";
import { main } from "../src/main.js";
import { verifyCommand } from "../src/verify-commands.js";

/**
 * ADR 0161: `atticus map --all`, the whole estate in one command. The plan and its order over the
 * invented bank-shaped Forge estate (fixtures/link-estate); the Copilot loop driven by a fake clock
 * and a test that writes the facts the way Copilot would (nothing really waits); a read that stops
 * halfway, given again for only what is left; the state file a second run resumes from; and model
 * mode on the mock runtime. Files only, no network.
 */

const FIXTURES = join(__dirname, "..", "..", "..", "fixtures");
const LINK = join(FIXTURES, "link-estate");
const VERIFY = join(__dirname, "..", "..", "verify", "test", "fixtures");
const SHA = (c: string) => c.repeat(40).slice(0, 40);
const LJ = "src/main/java/forge/ledger";
const LIMIT = 100_000;

const temps: string[] = [];
const temp = (name: string) => {
  const d = mkdtempSync(join(tmpdir(), `atticus-map-all-${name}-`));
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

const write = (root: string, path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};

const io = () => {
  const out: string[] = [];
  return {
    out,
    text: () => out.join("\n"),
    io: { out: (l: string) => out.push(l), err: (l: string) => out.push(`ERR ${l}`) },
  };
};

/** A clock that never waits: each sleep moves time on and lets the test act, as Copilot would. */
function fakeClock(onTick: (minutes: number) => Promise<void> | void = () => {}): Clock & {
  minutes: () => number;
} {
  let t = Date.parse("2026-11-01T09:00:00Z");
  const start = t;
  return {
    now: () => t,
    minutes: () => (t - start) / 60_000,
    sleep: async (ms) => {
      t += ms;
      await onTick((t - start) / 60_000);
    },
  };
}

/** Lines a person types, handed out once the clock reaches their minute. */
function typed(clock: { minutes: () => number }, lines: { at: number; line: string }[]) {
  const left = [...lines];
  return {
    take: () => {
      const i = left.findIndex((l) => clock.minutes() >= l.at);
      return i < 0 ? undefined : left.splice(i, 1)[0]!.line;
    },
  };
}

const deps = (clock: Clock, more: Partial<MapAllDeps> = {}): MapAllDeps & { copied: string[] } => {
  const copied: string[] = [];
  return {
    copied,
    clock,
    clipboard: async (t) => {
      copied.push(t);
      return true;
    },
    pollMs: 60_000,
    remindMs: 10 * 60_000,
    backoffMs: 1000,
    ...more,
  };
};

// ---------------------------------------------------------------- the bank-shaped estate

const LINK_REPOS = [
  "forge-portal-bff",
  "forge-proxy-accounts-v1",
  "forge-proxy-payments-v1",
  "forge-proxy-northwind-v1",
  "forge-accounts",
  "forge-payments",
  "forge-cards",
  "forge-notifications",
  "forge-starter",
  "forge-deploy-config",
];

/** The link estate as a metarepo, every repo cloned at SHA("a"), `read` read at that commit. */
function linkEstate(read: string[] = [], o: { prototype?: boolean } = {}) {
  const root = temp("link");
  cpSync(join(LINK, "org-pack"), join(root, "org-pack"), { recursive: true });
  for (const id of LINK_REPOS) {
    cpSync(join(LINK, "repos", id), join(root, "workspace", id), { recursive: true });
    write(root, `workspace/${id}/.git/HEAD`, `${SHA("a")}\n`);
  }
  if (o.prototype) {
    appendFileSync(
      join(root, "org-pack/profiles/forge/repos.manifest.yaml"),
      "  - id: forge-portal-next\n    url: https://git.forge.example/portal/forge-portal-next.git\n    type: prototype\n    owner: team-portal\n    component: portal-next\n    system: portal\n",
    );
    write(root, "workspace/forge-portal-next/src/app.ts", "export const app = 1;\n");
    write(root, "workspace/forge-portal-next/.git/HEAD", `${SHA("a")}\n`);
  }
  mkdirSync(join(root, "facts"), { recursive: true });
  for (const id of read)
    writeFileSync(
      join(root, "facts", `${id}.jsonl`),
      readFileSync(join(LINK, "facts", `${id}.jsonl`), "utf8").replace(
        /"commit":"[0-9a-f]+"/g,
        `"commit":"${SHA("a")}"`,
      ),
    );
  return root;
}

const dryRun = async (root: string, more: Parameters<typeof mapAllCommand>[1] = {}) => {
  const o = io();
  const code = await mapAllCommand(
    root,
    { dryRun: true, json: true, maxTokens: LIMIT, mode: "copilot", ...more },
    o.io,
  );
  expect(code, o.text()).toBe(0);
  return JSON.parse(o.text()) as MapAllPlan;
};

describe("atticus map --all: the plan (ADR 0161)", () => {
  it("plans every repo in the onboarding queue's order, the prototypes last, and prints it whole", async () => {
    const root = linkEstate([], { prototype: true });
    const plan = await dryRun(root);
    expect(plan.items.map((i) => i.repo)).toEqual([
      "forge-proxy-accounts-v1",
      "forge-proxy-payments-v1",
      "forge-proxy-northwind-v1",
      "forge-deploy-config",
      "forge-portal-bff",
      "forge-accounts",
      "forge-payments",
      "forge-cards",
      "forge-notifications",
      "forge-starter",
      // Read, never joined (ADR 0133), so after the estate.
      "forge-portal-next",
    ]);
    expect(plan.items.at(-1)).toMatchObject({ prototype: true, kind: "read" });
    for (const i of plan.items) {
      expect(i.kind).toBe("read");
      expect(i.parts.length).toBeGreaterThan(0);
      expect(i.tokens).toBeGreaterThan(0);
    }
    expect(plan.limit).toBe(LIMIT);
    // The words: every repo, its parts and tokens, and the join at the end.
    const o = io();
    await mapAllCommand(root, { dryRun: true, maxTokens: LIMIT, mode: "copilot" }, o.io);
    expect(o.out[0]).toBe(
      "The estate at 100,000 tokens a prompt (--max-tokens), read by Copilot Chat in agent mode: you paste one line per part:",
    );
    expect(o.text()).toMatch(
      / {2}1\. forge-proxy-accounts-v1: read, not read yet; 1 part, about [\d,]+ tokens\./,
    );
    expect(o.text()).toContain("forge-portal-next (prototype: read, never joined)");
    expect(o.out.at(-1)).toMatch(
      /^In all: 11 repos, 11 parts to read, about [\d,]+ tokens \(estimated from the source, not metered\)\. Then atticus verify --all --write joins the estate once\.$/,
    );
    // A dry run starts nothing: no state file.
    expect(existsSync(join(root, ".atticus", "map-all", "state.json"))).toBe(false);
  });

  it("skips a repo whose read is complete and fresh, and limits to --repos", async () => {
    const read = LINK_REPOS.filter((r) => r !== "forge-cards" && r !== "forge-starter");
    const root = linkEstate(read);
    // Read under the rules there are now (ADR 0167): a read before them is topped up instead.
    for (const id of read)
      write(
        root,
        `facts/${id}.read-plan.yaml`,
        stringify({
          schemaVersion: 2,
          repo: id,
          commit: SHA("a"),
          session: 45000,
          plannedAt: "2026-10-30T10:00:00Z",
          parts: [],
          rules: rulesNow(),
        }),
      );
    const plan = await dryRun(root);
    expect(plan.items.map((i) => i.repo)).toEqual(["forge-cards", "forge-starter"]);
    expect(plan.skipped).toContainEqual({ repo: "forge-accounts", why: "read and fresh" });
    const only = await dryRun(root, { repos: ["forge-starter", "forge-accounts"] });
    expect(only.items.map((i) => i.repo)).toEqual(["forge-starter"]);
    expect(only.skipped).toEqual([{ repo: "forge-accounts", why: "read and fresh" }]);
    const o = io();
    expect(
      await mapAllCommand(root, { dryRun: true, maxTokens: LIMIT, repos: ["forge-nowhere"] }, o.io),
    ).toBe(2);
    expect(o.out[0]).toMatch(/No repo forge-nowhere in the manifests/);
  });

  it("runs from the command line: atticus map --all --dry-run --max-tokens n", async () => {
    const root = linkEstate();
    const out: string[] = [];
    const code = await main(
      ["map", "--all", "--dry-run", "--mode", "hand-off", "--max-tokens", "100000", "--root", root],
      { out: (l) => out.push(l), err: (l) => out.push(`ERR ${l}`) },
      { quiet: true },
    );
    expect(code, out.join("\n")).toBe(0);
    expect(out[0]).toMatch(/^The estate at 100,000 tokens a prompt \(--max-tokens\)/);
  });

  it("refuses to start with no known limit, rather than plan parts that overflow the reader", async () => {
    const root = linkEstate();
    const o = io();
    expect(await mapAllCommand(root, { dryRun: true }, o.io)).toBe(2);
    expect(o.out).toEqual([
      "ERR Atticus doesn't know your model's limit, and a part planned too big overflows the reader: pass --max-tokens <n> (the context window of the model Copilot Chat uses, in tokens), or set maxInput under adapters.model in runtime.yaml.",
    ]);
  });

  it("with --gaps, plans the second pass for every read repo only", async () => {
    const root = linkEstate(["forge-accounts", "forge-cards"]);
    const plan = await dryRun(root, { gaps: true });
    expect(plan.items.map((i) => [i.repo, i.kind])).toEqual([
      ["forge-accounts", "gaps"],
      ["forge-cards", "gaps"],
    ]);
    expect(plan.skipped).toContainEqual({
      repo: "forge-starter",
      why: "not read yet: the gaps pass follows a read",
    });
  });
});

// ---------------------------------------------------------------- the stale estate (real git, local)

function gitIn(dir: string) {
  return (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "init.defaultBranch=main",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd: dir, encoding: "utf8" },
    ).trim();
}

/** The Forge ledger and notifier metarepo, the ledger cloned with git and read at its first commit. */
function ledgerEstate(o: { move?: boolean; big?: boolean; units?: boolean } = {}) {
  const root = temp("ledger");
  cpSync(join(VERIFY, "metarepo", "org-pack"), join(root, "org-pack"), { recursive: true });
  const dir = join(root, "workspace", "forge-ledger");
  cpSync(join(VERIFY, "repo"), dir, { recursive: true });
  if (o.units) {
    // ADR 0170: read in 4 parts at 60,000 tokens, the last with a service, a validation and an
    // sql folder beside three files named alone, as a big service's last part is.
    const body = (pkg: string, n: string, k: number) =>
      `package ${pkg};\n\npublic class ${n} {\n${Array.from({ length: k }, (_, i) => `  private final int value${i} = ${i};`).join("\n")}\n}\n`;
    for (let c = 0; c < 4; c++)
      write(
        dir,
        `${LJ}/service/LedgerService${c}.java`,
        body("forge.ledger.service", `LedgerService${c}`, 300),
      );
    for (let c = 0; c < 3; c++)
      write(
        dir,
        `${LJ}/validation/AmountCheck${c}.java`,
        body("forge.ledger.validation", `AmountCheck${c}`, 200),
      );
    for (let c = 0; c < 3; c++)
      write(
        dir,
        `src/main/resources/sql/q${c}.sql`,
        `${Array.from({ length: 200 }, (_, i) => `select ${i} from t${i};`).join("\n")}\n`,
      );
    for (const m of ["accounts", "payments", "reports"])
      for (let c = 0; c < 6; c++)
        write(
          dir,
          `${m}/src/main/java/forge/${m}/Part${c}.java`,
          body(`forge.${m}`, `Part${c}`, 400),
        );
  }
  if (o.big)
    for (const m of ["accounts", "payments", "reports", "statements"])
      for (let c = 0; c < 10; c++)
        write(
          dir,
          `${m}/src/main/java/forge/${m}/Part${c}.java`,
          `package forge.${m};\n\npublic class Part${c} {\n${Array.from({ length: 400 }, (_, i) => `  private final int value${i} = ${i}; // ${m}`).join("\n")}\n}\n`,
        );
  const git = gitIn(dir);
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "one");
  const one = git("rev-parse", "HEAD");
  if (o.move) {
    const p = join(dir, "src/main/java/forge/ledger/AccountController.java");
    writeFileSync(p, `// moved on\n${readFileSync(p, "utf8")}`);
    git("commit", "-q", "-am", "two");
  }
  return { root, dir, one, head: git("rev-parse", "HEAD") };
}

const ledgerFacts = (root: string, commit: string) =>
  write(
    root,
    "facts/forge-ledger.jsonl",
    readFileSync(join(VERIFY, "forge-ledger.facts.jsonl"), "utf8").replaceAll(
      '"commit":"0123abc"',
      `"commit":"${commit}"`,
    ),
  );

describe("atticus map --all --stale (ADR 0161, P5)", () => {
  it("re-reads only the repos whose clone moved past their facts", async () => {
    const { root, one } = ledgerEstate({ move: true });
    ledgerFacts(root, one);
    const plan = await dryRun(root, { stale: true });
    expect(plan.items.map((i) => [i.repo, i.kind])).toEqual([["forge-ledger", "reread"]]);
    expect(plan.items[0]!.why).toMatch(/^its clone moved past its facts: \d+ facts? to read again/);
    // The notifier has no clone: said, not read.
    expect(plan.skipped).toEqual([
      { repo: "forge-notify", why: "no clone to read: atticus workspace sync clones it" },
    ]);
  });
});

// ---------------------------------------------------------------- the Copilot loop

/** Reviewed lines for every file under these globs: what a reader writes for files with no fact. */
function review(root: string, dir: string, globs: readonly string[]) {
  const lines = globs.map((g) => JSON.stringify({ path: g, why: "read; nothing to record" }));
  appendFileSync(join(root, "facts", "forge-ledger.reviewed.jsonl"), `${lines.join("\n")}\n`);
  void dir;
}

/** What the reader runs at the end of a session: atticus verify <repo>, no write. */
const readerVerifies = (root: string, commit: string) =>
  verifyCommand(root, "forge-ledger", { commit, json: true }, { out: () => {}, err: () => {} });

describe("atticus map --all under Copilot: one line per part, waited for (ADR 0161)", () => {
  it("prints each part's block, copies its line, waits for the facts, verifies and moves on; q stops and a second run resumes", async () => {
    const { root, dir, head } = ledgerEstate({ big: true });
    const plan = await dryRun(root);
    const ledger = plan.items.find((i) => i.repo === "forge-ledger")!;
    expect(ledger.total).toBeGreaterThan(1);
    const part1 = ledger.parts[0]!;
    // Copilot reads part 1 at minute 3: reviewed lines for its folders, then its own verify.
    const clock = fakeClock(async (m) => {
      if (m === 3) {
        mkdirSync(join(root, "facts"), { recursive: true });
        ledgerFacts(root, head);
        review(root, dir, part1.paths);
        await readerVerifies(root, head);
      }
    });
    const d = deps(clock, { input: typed(clock, [{ at: 6, line: "q" }]) });
    const o = io();
    expect(await mapAllCommand(root, { maxTokens: LIMIT, mode: "copilot" }, o.io, d)).toBe(0);
    const text = o.text();
    expect(text).toContain(`===== forge-ledger, part 1 of ${ledger.total} (repo 1 of 1) =====`);
    expect(text).toContain("In a NEW Copilot Chat (agent mode), run: /atticus-map forge-ledger");
    expect(text).toContain(`That chat reads part 1: ${part1.paths.join(", ")}`);
    expect(d.copied[0]).toBe("/atticus-map forge-ledger");
    expect(text).toContain("The line is on your clipboard.");
    // Part 1 verified with what verify --write runs, then part 2's block, then q.
    expect(text).toMatch(/forge-ledger: \d+ facts kept, 0 rejected; coverage \d+%/);
    expect(text).toContain(`===== forge-ledger, part 2 of ${ledger.total} (repo 1 of 1) =====`);
    expect(text).toContain(
      "Stopped. Where the estate stands is saved: atticus map --all carries on from here.",
    );
    expect(text).toMatch(
      new RegExp(
        `forge-ledger part 2 of ${ledger.total}: incomplete; atticus map --all --repos forge-ledger`,
      ),
    );
    expect((await readPlanProgress(root, "forge-ledger"))!.parts[0]!.state).toBe("done");
    const st = await readMapAllState(root);
    expect(st?.repos["forge-ledger"]?.parts["1"]?.state).toBe("done");
    // Resume: the facts on disk say part 1 is read, so the next run starts at part 2.
    const again = await dryRun(root);
    expect(again.items[0]!.parts[0]!.part).toBe(2);
    // A state file cut short (a killed terminal) is no state: the facts still say where it stands.
    writeFileSync(
      join(root, ".atticus", "map-all", "state.json"),
      '{"schemaVersion": 1, "repos": {',
    );
    expect(await readMapAllState(root)).toBeUndefined();
    expect((await dryRun(root)).items[0]!.parts[0]!.part).toBe(2);
  });

  it("counts the parts the same in the summary and in each part's header when a later part is read already", async () => {
    const { root, dir } = ledgerEstate({ big: true });
    const whole = (await dryRun(root)).items[0]!;
    expect(whole.total).toBeGreaterThan(2);
    // The last part is accounted for already (an earlier session read it): one fewer to read.
    mkdirSync(join(root, "facts"), { recursive: true });
    review(root, dir, whole.parts.at(-1)!.paths);
    const plan = await dryRun(root);
    const item = plan.items[0]!;
    const left = item.parts.length;
    expect(left).toBe(whole.total - 1);
    const clock = fakeClock();
    const d = deps(clock, { input: typed(clock, [{ at: 1, line: "q" }]) });
    const o = io();
    expect(await mapAllCommand(root, { maxTokens: LIMIT, mode: "copilot" }, o.io, d)).toBe(0);
    const text = o.text();
    // The summary says how many are left and of how many, and the header counts the same way.
    expect(text).toContain(
      `In all: 1 repo, ${left} parts to read (of ${whole.total} planned; 1 is read already)`,
    );
    expect(text).toContain(
      `===== forge-ledger, part 1 of ${whole.total}, 1 of the ${left} to read (repo 1 of 1) =====`,
    );
  });

  it("Ctrl+C stops cleanly after the step under way, saving where it stands", async () => {
    const { root } = ledgerEstate();
    const ac = new AbortController();
    const clock = fakeClock((m) => {
      if (m === 2) ac.abort();
    });
    const o = io();
    expect(
      await mapAllCommand(
        root,
        { maxTokens: LIMIT, mode: "copilot" },
        o.io,
        deps(clock, { signal: ac.signal }),
      ),
    ).toBe(0);
    expect(o.text()).toContain(
      "Stopped. Where the estate stands is saved: atticus map --all carries on from here.",
    );
    expect((await readMapAllState(root))?.repos["forge-ledger"]?.parts["1"]?.state).toBe(
      "incomplete",
    );
    // Local, never committed: the state folder is in .atticus/.gitignore.
    expect(readFileSync(join(root, ".atticus", ".gitignore"), "utf8")).toContain("map-all/");
  });

  it("reminds every ten minutes while it waits, and s skips a part, listed with its command", async () => {
    const { root } = ledgerEstate();
    const clock = fakeClock();
    const d = deps(clock, { input: typed(clock, [{ at: 21, line: "s" }]) });
    const o = io();
    await mapAllCommand(root, { maxTokens: LIMIT, mode: "copilot" }, o.io, d);
    const text = o.text();
    expect(text.match(/Still waiting on forge-ledger one session/g)).toHaveLength(2);
    expect(text).toContain("Skipped forge-ledger one session.");
    expect(text).toMatch(
      /forge-ledger: skipped; atticus map --all --repos forge-ledger \(or \/atticus-map forge-ledger in a new chat\)/,
    );
    expect(text).toContain(
      "Next: atticus questions list --mine (answer what the code couldn't settle), then atticus estate fresh.",
    );
  });

  it("a read that stops halfway: r verifies what it wrote and gives only what is left", async () => {
    const { root, dir, head } = ledgerEstate({ big: true });
    const plan = await dryRun(root, { maxTokens: 300_000 });
    const part1 = plan.items[0]!.parts[0]!;
    expect(part1.paths.length).toBeGreaterThan(1);
    const [done, ...left] = part1.paths;
    // Copilot writes the first folder of part 1, then dies: nothing more ever changes.
    const clock = fakeClock((m) => {
      if (m === 2) {
        mkdirSync(join(root, "facts"), { recursive: true });
        ledgerFacts(root, head);
        review(root, dir, [done!]);
      }
    });
    const d = deps(clock, {
      input: typed(clock, [
        { at: 20, line: "r" },
        { at: 22, line: "q" },
      ]),
    });
    const o = io();
    await mapAllCommand(root, { maxTokens: 300_000, mode: "copilot", idleMinutes: 30 }, o.io, d);
    const text = o.text();
    // r: what it wrote is verified (kept), and the line is the rest of the part only.
    expect(text).toMatch(/forge-ledger: \d+ facts kept, 0 rejected/);
    expect(text).toContain("given again (1)");
    expect(d.copied.at(-1)).toBe("/atticus-map forge-ledger --part 1 --gaps");
    const prompt = readFileSync(join(root, "facts", "forge-ledger.gaps.md"), "utf8");
    expect(prompt).toContain("# The rest of part 1 of forge-ledger");
    // Only files of the part, none of the folder it finished; what the facts cite is left out too.
    const listed = [...prompt.matchAll(/^- `([^`#]+)(?:#L\d+-L\d+)?` \(about/gm)].map((x) => x[1]!);
    expect(listed.length).toBeGreaterThan(0);
    const dirOf = (g: string) => g.replace(/\/?\*\*?$/, "");
    for (const f of listed) {
      expect(f.startsWith(`${dirOf(done!)}/`)).toBe(false);
      // ADR 0169: a part names an entry point or a reached model class by its own path too.
      expect(left.some((g) => g === f || dirOf(g) === "" || f.startsWith(`${dirOf(g)}/`))).toBe(
        true,
      );
    }
    // The part isn't done: only what the facts account for is.
    expect((await readPlanProgress(root, "forge-ledger"))!.parts[0]!.state).not.toBe("done");
    expect((await readMapAllState(root))?.repos["forge-ledger"]?.parts["1"]?.retries).toBe(1);
  });

  it("after three tries suggests a smaller limit, which plans the repo in smaller parts", async () => {
    const { root } = ledgerEstate({ big: true });
    const clock = fakeClock();
    const d = deps(clock, {
      input: typed(clock, [
        { at: 1, line: "r" },
        { at: 2, line: "r" },
        { at: 3, line: "r" },
        { at: 4, line: "q" },
      ]),
    });
    const o = io();
    await mapAllCommand(root, { maxTokens: LIMIT, mode: "copilot" }, o.io, d);
    const before = (await dryRun(root)).items[0]!.total;
    expect(o.text()).toContain(
      `forge-ledger part 1 of ${before} has been given again 3 times: a smaller limit plans it in smaller parts, each a shorter chat. Stop (q), then atticus map --all --repos forge-ledger --max-tokens 50000.`,
    );
    // The smaller limit re-plans the read plan for a smaller session.
    await dryRun(root, { maxTokens: 50_000 });
    expect(readFileSync(join(root, "facts", "forge-ledger.read-plan.yaml"), "utf8")).toContain(
      "session: 22500",
    );
  });
});

// ---------------------------------------------------------------- ADR 0170: done as verify counts it

describe("atticus map --all: a part is done when verify's coverage leaves nothing under it (ADR 0170)", () => {
  const L = 60_000;
  /** The units estate with parts 1 to 3 read already, so part 4 is the one the run waits on. */
  async function lastPartLeft() {
    const e = ledgerEstate({ units: true });
    const whole = (await dryRun(e.root, { maxTokens: L })).items[0]!;
    expect(whole.total).toBe(4);
    const last = whole.parts.at(-1)!;
    expect(last.paths).toEqual(
      expect.arrayContaining([
        `${LJ}/service/**`,
        `${LJ}/validation/**`,
        "src/main/resources/sql/**",
      ]),
    );
    ledgerFacts(e.root, e.head);
    review(
      e.root,
      e.dir,
      whole.parts.slice(0, -1).flatMap((p) => p.paths),
    );
    const plan = await dryRun(e.root, { maxTokens: L });
    expect(plan.items[0]!.parts.map((p) => p.part)).toEqual([4]);
    return { ...e, last };
  }
  /** What Copilot does at the end of part 4: reviewed lines, a broad glob, then verify --write itself. */
  const copilotReadsPart4 = async (root: string, head: string, last: { paths: string[] }) => {
    const alone = last.paths.filter((p) => !p.includes("*"));
    const lines = [
      {
        path: "src/main/resources/**",
        why: "migrations and queries; their tables are store facts already",
      },
      { path: `${LJ}/service/*.java`, why: "wiring only; nothing served, called or stored" },
      ...alone.map((path) => ({ path, why: "read; nothing to record" })),
    ];
    appendFileSync(
      join(root, "facts", "forge-ledger.reviewed.jsonl"),
      `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
    );
    const c: string[] = [];
    await verifyCommand(
      root,
      "forge-ledger",
      { commit: head, write: true },
      { out: (l) => c.push(l), err: (l) => c.push(l) },
    );
    return c.join("\n");
  };

  it("the user's case: verify says nothing is left (validation's model classes not reached), so the part is done without a keypress", async () => {
    const { root, head, last } = await lastPartLeft();
    const clock = fakeClock(async (m) => {
      if (m === 2) {
        // A gaps pass or a re-estimate recorded the validation classes as not reached after the
        // parts were planned: verify counts them apart, and no fact cites one.
        const p = join(root, "facts", "forge-ledger.read-plan.yaml");
        const files = [0, 1, 2].map((c) => `${LJ}/validation/AmountCheck${c}.java`);
        appendFileSync(
          p,
          `notReached:\n  why: model classes no entry point, call or field fact reaches\n  files:\n${files.map((f) => `    - ${f}`).join("\n")}\n  tokens: 3000\n`,
        );
      }
      if (m === 3) {
        const said = await copilotReadsPart4(root, head, last);
        expect(said).toMatch(
          /0 rejected; coverage \d+% \(\d+ read, \d+ reviewed with nothing to record, 0 unknown/,
        );
      }
    });
    const d = deps(clock);
    const o = io();
    expect(await mapAllCommand(root, { maxTokens: L, mode: "copilot" }, o.io, d)).toBe(0);
    const text = o.text();
    expect(text).toContain(
      "===== forge-ledger, part 4 of 4, 1 of the 1 to read (repo 1 of 1) =====",
    );
    expect(text).not.toContain("Still waiting");
    expect(text).not.toContain("given again");
    expect(text).toMatch(
      /forge-ledger: \d+ facts kept, 0 rejected; coverage \d+% \(0 files no fact cites yet\)/,
    );
    expect(text).toContain("Joining the estate: atticus verify --all --write.");
    expect(text).toMatch(/Done: 1 repo read, 1 part;/);
    expect(d.copied).toEqual(["/atticus-map forge-ledger"]);
    expect(clock.minutes()).toBeLessThan(10);
    expect((await readPlanProgress(root, "forge-ledger"))!.parts[3]!.state).toBe("done");
  });

  it("says exactly what is still not covered under the part, and r gives only those files", async () => {
    const { root, head, last } = await lastPartLeft();
    const clock = fakeClock(async (m) => {
      if (m === 3) await copilotReadsPart4(root, head, last);
    });
    const d = deps(clock, {
      input: typed(clock, [
        { at: 5, line: "r" },
        { at: 6, line: "q" },
      ]),
    });
    const o = io();
    await mapAllCommand(root, { maxTokens: L, mode: "copilot" }, o.io, d);
    const text = o.text();
    expect(text).toContain(
      `Still not covered in forge-ledger part 4 of 4: ${LJ}/validation/** (3 files: AmountCheck0.java, AmountCheck1.java, AmountCheck2.java). r + Enter gives a NEW chat only what is left of the part: these files, and any line verify lists as skipped under it (/atticus-map forge-ledger --part 4 --gaps); s + Enter skips the part; q + Enter stops.`,
    );
    expect(text).not.toContain("Still waiting");
    expect(d.copied.at(-1)).toBe("/atticus-map forge-ledger --part 4 --gaps");
    const prompt = readFileSync(join(root, "facts", "forge-ledger.gaps.md"), "utf8");
    const listed = [...prompt.matchAll(/^- `([^`#]+)(?:#L\d+-L\d+)?` \(about/gm)].map((x) => x[1]!);
    expect(listed.sort()).toEqual([0, 1, 2].map((c) => `${LJ}/validation/AmountCheck${c}.java`));
  });

  it("stops waiting at the idle limit, says so once and how to carry on, instead of waiting forever", async () => {
    const { root } = ledgerEstate();
    const clock = fakeClock();
    const o = io();
    expect(
      await mapAllCommand(
        root,
        { maxTokens: LIMIT, mode: "copilot", idleMinutes: 25 },
        o.io,
        deps(clock),
      ),
    ).toBe(0);
    const text = o.text();
    expect(text.match(/Still waiting on forge-ledger one session/g)).toHaveLength(2);
    expect(text.match(/Stopped waiting/g)).toHaveLength(1);
    expect(text).toContain(
      "Stopped waiting on forge-ledger one session: nothing was written for 25 minutes (--idle 25). Where the estate stands is saved: atticus map --all --max-tokens 100000 --idle 25 carries on from here (it verifies what was written and gives the line again for what's left).",
    );
    expect(clock.minutes()).toBe(25);
    expect(text).toMatch(/forge-ledger: incomplete; atticus map --all --repos forge-ledger/);
    expect((await readMapAllState(root))?.repos["forge-ledger"]?.parts["1"]?.state).toBe(
      "incomplete",
    );
    // Thirty minutes when --idle isn't given.
    const c2 = fakeClock();
    const o2 = io();
    await mapAllCommand(root, { maxTokens: LIMIT, mode: "copilot" }, o2.io, deps(c2));
    expect(c2.minutes()).toBe(30);
  });
});

describe("atticus map --all --force: the named repos read whole again (ADR 0170)", () => {
  const fresh = (root: string, head: string) => {
    ledgerFacts(root, head);
    write(
      root,
      "facts/forge-ledger.read-plan.yaml",
      stringify({
        schemaVersion: 2,
        repo: "forge-ledger",
        commit: head,
        session: 45000,
        plannedAt: "2026-10-30T10:00:00Z",
        parts: [],
        rules: rulesNow(),
      }),
    );
  };

  it("plans a read and fresh repo whole again, keeps its facts as already kept, and waits on it", async () => {
    const { root, dir, head } = ledgerEstate();
    fresh(root, head);
    expect((await dryRun(root)).skipped).toContainEqual({
      repo: "forge-ledger",
      why: "read and fresh",
    });
    const plan = await dryRun(root, { force: true, repos: ["forge-ledger"] });
    expect(plan.items.map((i) => [i.repo, i.kind, i.force])).toEqual([
      ["forge-ledger", "read", true],
    ]);
    expect(plan.items[0]!.why).toBe(
      "--force: read whole again, the facts on file kept as already kept",
    );
    const clock = fakeClock(async (m) => {
      // Only verify ran at minute 2 (nothing new written): not done. A reviewed line and verify at 4: done.
      if (m === 2) await readerVerifies(root, head);
      if (m === 4) {
        review(root, dir, ["README.md"]);
        await readerVerifies(root, head);
      }
    });
    const d = deps(clock);
    const o = io();
    await mapAllCommand(
      root,
      { maxTokens: LIMIT, mode: "copilot", force: true, repos: ["forge-ledger"] },
      o.io,
      d,
    );
    const text = o.text();
    expect(d.copied).toEqual(["/atticus-map forge-ledger"]);
    expect(text).toContain(
      "The facts on file stay, as already kept: the chat names one by its id and doesn't write it again (one whose line changed it rewrites under the same id).",
    );
    expect(text).toMatch(/Done: 1 repo read, 1 part;/);
    expect(clock.minutes()).toBe(4);
  });

  it("gives each part by number in a repo read in parts, and a second run carries on from the part it stopped in", async () => {
    const { root, dir, head } = ledgerEstate({ big: true });
    const whole = (await dryRun(root)).items[0]!;
    ledgerFacts(root, head);
    review(
      root,
      dir,
      whole.parts.flatMap((p) => p.paths),
    );
    await readerVerifies(root, head);
    const plan = await dryRun(root, { force: true });
    expect(plan.items[0]!.parts.map((p) => p.part)).toEqual(whole.parts.map((p) => p.part));
    const clock = fakeClock(async (m) => {
      if (m === 3) {
        review(root, dir, whole.parts[0]!.paths);
        await readerVerifies(root, head);
      }
    });
    const d = deps(clock, { input: typed(clock, [{ at: 5, line: "q" }]) });
    const o = io();
    await mapAllCommand(root, { maxTokens: LIMIT, mode: "copilot", force: true }, o.io, d);
    expect(d.copied).toEqual([
      "/atticus-map forge-ledger --part 1",
      "/atticus-map forge-ledger --part 2",
    ]);
    // The estimate a forced part's chat runs names that part, whatever the facts say of it.
    const e = io();
    expect(
      await mapCommand(
        root,
        "forge-ledger",
        { estimate: true, commit: head, maxTokens: LIMIT, part: 2 },
        e.io,
      ),
    ).toBe(0);
    expect(e.text()).toContain(
      `This session reads part 2 of ${whole.total} (--part 2): ${whole.parts[1]!.paths.join(", ")}. The facts on file stay, as already kept: name one by its id and don't write it again.`,
    );
    const again = await dryRun(root, { force: true });
    expect(again.items[0]!.parts[0]!.part).toBe(2);
  });

  it("doesn't go with --stale or --gaps", async () => {
    const { root } = ledgerEstate();
    const o = io();
    expect(await mapAllCommand(root, { maxTokens: LIMIT, force: true, gaps: true }, o.io)).toBe(2);
    expect(o.out[0]).toBe(
      "ERR --force reads the repos whole again; it doesn't go with --stale or --gaps.",
    );
  });
});

describe("atticus map <repo> under Copilot runs the same waiting loop (ADR 0170)", () => {
  const cli = async (args: string[]) => {
    const out: string[] = [];
    const code = await main(
      args,
      { out: (l) => out.push(l), err: (l) => out.push(`ERR ${l}`) },
      { quiet: true },
    );
    return { code, text: out.join("\n"), out };
  };

  it("plans and waits on the one repo when runtime.yaml's assistant is Copilot (the default)", async () => {
    const { root } = ledgerEstate();
    const r = await cli([
      "map",
      "forge-ledger",
      "--dry-run",
      "--max-tokens",
      "100000",
      "--root",
      root,
    ]);
    expect(r.code, r.text).toBe(0);
    expect(r.out[0]).toBe(
      "The estate at 100,000 tokens a prompt (--max-tokens), read by Copilot Chat in agent mode: you paste one line per part:",
    );
    expect(r.text).toMatch(/ {2}1\. forge-ledger: read, not read yet; 1 part/);
    expect(r.text).not.toContain("forge-notify");
    // --force too: the repo read whole again, in the same loop.
    ledgerFacts(root, SHA("a"));
    const f = await cli([
      "map",
      "forge-ledger",
      "--force",
      "--dry-run",
      "--max-tokens",
      "100000",
      "--root",
      root,
    ]);
    expect(f.text).toMatch(/1\. forge-ledger: read, --force: read whole/);
  });

  it("says plainly, when the batch hand-off is taken, what to run if the person uses Copilot", async () => {
    const { root, head } = ledgerEstate();
    write(
      root,
      "org-pack/runtime.yaml",
      "schemaVersion: 2\nassistants: { allowed: [claude-code], default: claude-code }\n",
    );
    const r = await cli([
      "map",
      "forge-ledger",
      "--commit",
      head,
      "--max-tokens",
      "100000",
      "--root",
      root,
    ]);
    expect(r.code, r.text).toBe(0);
    expect(r.out[0]).toBe(
      "runtime.yaml says Claude Code; if you use Copilot, run atticus map --all --repos forge-ledger (it waits and copies each line).",
    );
    expect(r.text).toMatch(/Handed batch 1 of \d+ to your assistant/);
  });
});

describe("atticus map --all --gaps (ADR 0161, R2)", () => {
  it("plans each read repo's gaps, gives /atticus-map <repo> --gaps, and moves on once its facts are verified", async () => {
    const { root, dir, head } = ledgerEstate();
    ledgerFacts(root, head);
    await readerVerifies(root, head);
    const clock = fakeClock(async (m) => {
      if (m === 2) {
        // The second pass: the files the first read left, reviewed, then verified.
        const v = readFileSync(join(root, "facts", "forge-ledger.verify.yaml"), "utf8");
        const unknown = [...v.matchAll(/^ {4}- (\S+)$/gm)].map((x) => x[1]!);
        review(root, dir, unknown.length ? unknown : ["**"]);
        await readerVerifies(root, head);
      }
    });
    const d = deps(clock);
    const o = io();
    await mapAllCommand(root, { maxTokens: LIMIT, mode: "copilot", gaps: true }, o.io, d);
    const text = o.text();
    expect(d.copied).toEqual(["/atticus-map forge-ledger --gaps"]);
    expect(text).toContain("===== forge-ledger, the gaps pass (repo 1 of 1) =====");
    expect(text).toContain("Joining the estate: atticus verify --all --write.");
    expect(text).toMatch(
      /Done: 1 repo read, 1 part; 0 facts rejected; links \+\d+ -\d+; \d+ questions? open\./,
    );
    expect((await readMapAllState(root))?.repos["forge-ledger"]?.done).toBe(true);
    // Done at this commit: the next --gaps run skips it.
    expect((await dryRun(root, { gaps: true })).skipped).toContainEqual({
      repo: "forge-ledger",
      why: "its gaps pass is done at this commit",
    });
  });
});

// ---------------------------------------------------------------- model mode

/** A runtime whose first `failures` runs throw, as a provider timing out does. */
function flaky(inner: AiRuntime, failures: number): AiRuntime & { calls: number } {
  const r = {
    calls: 0,
    kind: inner.kind,
    prepare: (q: Parameters<AiRuntime["prepare"]>[0]) => inner.prepare(q),
    run: async (id: string) => {
      r.calls++;
      if (r.calls <= failures) throw new Error("the provider timed out");
      return inner.run(id);
    },
    result: (id: string) => inner.result(id),
  };
  return r;
}

describe("atticus map --all in model mode: unattended (ADR 0161)", () => {
  const NOW = () => new Date("2026-11-01T09:00:00.000Z");

  it("reads every repo on the model with no one waiting, then joins the estate", async () => {
    const { root } = ledgerEstate();
    const clock = fakeClock();
    const runtime = new MockRuntime(() => "", { now: NOW });
    const o = io();
    expect(
      await mapAllCommand(
        root,
        { maxTokens: LIMIT, mode: "model" },
        o.io,
        deps(clock, { runtime }),
      ),
    ).toBe(0);
    const text = o.text();
    expect(text).toMatch(
      /===== forge-ledger \(repo 1 of 1\): reading on the model, \d+ prompts? =====/,
    );
    expect(text).not.toContain("Copilot");
    expect(text).toMatch(/Done: 1 repo read, 1 part \(\d+ prompts?\)/);
  });

  it("retries a provider error with backoff, carrying on from the part that failed", async () => {
    const { root } = ledgerEstate();
    const clock = fakeClock();
    const runtime = flaky(new MockRuntime(() => "", { now: NOW }), 2);
    const o = io();
    await mapAllCommand(root, { maxTokens: LIMIT, mode: "model" }, o.io, deps(clock, { runtime }));
    const text = o.text();
    expect(text).toContain(
      "forge-ledger: the model's read stopped (the provider timed out); trying what is left again in 1s (try 2 of 3).",
    );
    expect(text).toContain("trying what is left again in 2s (try 3 of 3).");
    expect(text).toMatch(/Done: 1 repo read/);
  });

  it("after three failures moves on and lists the part as failed, with its command", async () => {
    const { root } = ledgerEstate();
    const clock = fakeClock();
    const runtime = flaky(new MockRuntime(() => "", { now: NOW }), 99);
    const o = io();
    await mapAllCommand(root, { maxTokens: LIMIT, mode: "model" }, o.io, deps(clock, { runtime }));
    const text = o.text();
    expect(text).toContain(
      "forge-ledger: the model's read failed 3 times (the provider timed out); moving on.",
    );
    expect(text).toContain("  forge-ledger: failed; atticus map --all --repos forge-ledger");
  });

  it("stops at --max-parts, and the next run carries on", async () => {
    const { root } = ledgerEstate({ big: true });
    const clock = fakeClock();
    const runtime = new MockRuntime(() => "", { now: NOW });
    const o = io();
    await mapAllCommand(
      root,
      { maxTokens: LIMIT, mode: "model", maxParts: 1 },
      o.io,
      deps(clock, { runtime }),
    );
    expect(o.text()).toMatch(/reading on the model, [2-9]\d* prompts/);
    expect(o.text()).toContain(
      "Stopped at the cap (--max-parts 1): 1 prompt run. atticus map --all carries on from here.",
    );
    const p = io();
    await mapAllCommand(root, { maxTokens: LIMIT, mode: "model" }, p.io, deps(clock, { runtime }));
    expect(p.text()).toMatch(/Done: 1 repo read/);
  });

  it("refuses the gaps pass on the model: it is a session for an assistant that opens files", async () => {
    const { root } = ledgerEstate();
    const o = io();
    expect(
      await mapAllCommand(root, { maxTokens: LIMIT, mode: "model", gaps: true }, o.io, {
        runtime: new MockRuntime(() => ""),
      }),
    ).toBe(2);
  });
});

describe("the clipboard (ADR 0161)", () => {
  it("uses clip on Windows, pbcopy on macOS, wl-copy under Wayland, else xclip", async () => {
    const { clipboardTools } = await import("../src/clipboard.js");
    expect(clipboardTools("win32", {})).toEqual([{ file: "clip", args: [] }]);
    expect(clipboardTools("darwin", {})).toEqual([{ file: "pbcopy", args: [] }]);
    expect(clipboardTools("linux", { WAYLAND_DISPLAY: "wayland-0" }).map((t) => t.file)).toEqual([
      "wl-copy",
      "xclip",
    ]);
    expect(clipboardTools("linux", {})).toEqual([
      { file: "xclip", args: ["-selection", "clipboard"] },
    ]);
  });
});
