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
function ledgerEstate(o: { move?: boolean; big?: boolean } = {}) {
  const root = temp("ledger");
  cpSync(join(VERIFY, "metarepo", "org-pack"), join(root, "org-pack"), { recursive: true });
  const dir = join(root, "workspace", "forge-ledger");
  cpSync(join(VERIFY, "repo"), dir, { recursive: true });
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

  it("a read that stops halfway: says Copilot seems to have stopped, and r verifies what it wrote and gives only what is left", async () => {
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
    await mapAllCommand(root, { maxTokens: 300_000, mode: "copilot", idleMinutes: 15 }, o.io, d);
    const text = o.text();
    expect(text).toContain(
      "Copilot seems to have stopped on forge-ledger part 1. r + Enter: verify what it wrote and give the prompt again for what's left, in a NEW chat; s: skip; q: stop.",
    );
    // Said once per still stretch, at 15 minutes idle (minute 17), not before.
    expect(text.match(/Copilot seems to have stopped/g)).toHaveLength(1);
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
      expect(left.some((g) => dirOf(g) === "" || f.startsWith(`${dirOf(g)}/`))).toBe(true);
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
