import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import type { AcpSessionResult } from "@maycombhq/ai";
import { forgetHeld, fsHooks } from "@maycombhq/core";
import { buildPhases } from "@maycombhq/scanner";
import type { AcpStep, AcpStepRunner } from "../src/copilot-acp-steps.js";
import { mapAllCommand, type MapAllPlan } from "../src/map-all.js";
import { readPlanProgress } from "../src/map-parts.js";
import { writeFactsHooks } from "../src/map-render-commands.js";

/**
 * Beta.28.5, the owner's field report: "a single repo's map has been running for 2 hours", on an
 * estate of 40 repos. One map of one repo applies it once per part, and then the estate join
 * applies every repo with facts; each apply builds the estate's catalog, or takes the last build
 * when its inputs are the same. The counts are exact here, so they can't creep back:
 *
 * - how many applies (`verify <repo> --write`) a read in parts runs, and how many of them ran
 *   the build's passes (a part given again applied the same facts twice in a row; a write that
 *   raised a question made the next build run every pass);
 * - the join says where it is, goes on past a repo whose file another program holds, and stops
 *   between two repos when asked.
 *
 * The sessions are stand-ins in this process (no Copilot server, no network). Invented Forge.
 */

const VERIFY = join(__dirname, "..", "..", "verify", "test", "fixtures");
const LIMIT = 100_000;

const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
afterEach(() => {
  delete writeFactsHooks.onWrite;
  buildPhases.on = undefined;
  for (const k of Object.keys(fsHooks)) delete (fsHooks as Record<string, unknown>)[k];
  forgetHeld();
});

const write = (root: string, path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};

const gitIn =
  (dir: string) =>
  (...args: string[]) =>
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

const factsText = (commit: string) =>
  readFileSync(join(VERIFY, "forge-ledger.facts.jsonl"), "utf8").replaceAll(
    '"commit":"0123abc"',
    `"commit":"${commit}"`,
  );

/**
 * The Forge ledger, read in parts, and (with `notify`) the notifier read before: its clone, its
 * facts and its reviewed lines on file, so the estate join has two repos to apply.
 */
function estate(o: { notify?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "atticus-map-loop-"));
  temps.push(root);
  cpSync(join(VERIFY, "metarepo", "org-pack"), join(root, "org-pack"), { recursive: true });
  write(
    root,
    "org-pack/runtime.yaml",
    stringify({
      schemaVersion: 3,
      assistants: { allowed: ["copilot"], default: "copilot" },
      modes: { allowed: ["hand-off", "copilot-acp"], default: "copilot-acp" },
      copilotAcp: { command: "copilot --acp", maxTurns: 100 },
    }),
  );
  const dir = join(root, "workspace", "forge-ledger");
  cpSync(join(VERIFY, "repo"), dir, { recursive: true });
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
  const head = git("rev-parse", "HEAD");
  if (o.notify) {
    // The notifier: the ledger's code and facts under its own names, so no record is shared.
    const other = join(root, "workspace", "forge-notify");
    const renamed = (t: string) => t.replaceAll("ledger", "notify").replaceAll("Ledger", "Notify");
    const copy = (from: string, to: string) => {
      for (const e of readdirSync(from, { withFileTypes: true })) {
        const target = join(to, renamed(e.name));
        if (e.isDirectory()) copy(join(from, e.name), target);
        else write(to, renamed(e.name), renamed(readFileSync(join(from, e.name), "utf8")));
      }
    };
    copy(join(VERIFY, "repo"), other);
    const g = gitIn(other);
    g("init", "-q");
    g("add", "-A");
    g("commit", "-q", "-m", "one");
    write(root, "facts/forge-notify.jsonl", renamed(factsText(g("rev-parse", "HEAD"))));
  }
  return { root, head };
}

type Session = (s: AcpStep) => Promise<Partial<AcpSessionResult> | void> | void;

function sessions(scripts: Session[]) {
  const seen: AcpStep[] = [];
  const runner: AcpStepRunner = async (s) => {
    seen.push(s);
    const play = scripts[seen.length - 1];
    if (!play) throw new Error(`no session ${seen.length} in this script`);
    const r = (await play(s)) ?? {};
    return {
      stopReason: "end_turn",
      assistant: { name: "stand-in" },
      text: "",
      toolCalls: [],
      refused: [],
      agentToolCalls: 0,
      runId: `run-${seen.length}`,
      ...r,
    };
  };
  return { runner, seen };
}

const planOf = async (root: string) => {
  const out: string[] = [];
  await mapAllCommand(
    root,
    { dryRun: true, json: true, maxTokens: LIMIT, mode: "copilot-acp", repos: ["forge-ledger"] },
    { out: (l) => out.push(l), err: (l) => out.push(l) },
    { acp: async () => Promise.reject(new Error("no session in a dry run")) },
  );
  return (JSON.parse(out.join("\n")) as MapAllPlan).items[0]!;
};

const reviewed = (globs: readonly string[]) =>
  globs.map((g) => `${JSON.stringify({ path: g, why: "read; nothing to record" })}\n`).join("");

/** The applies a run did, by repo, and how many of their builds ran the passes. */
function counting() {
  const applies: string[] = [];
  writeFactsHooks.onWrite = (repo) => applies.push(repo);
  let built = 0;
  let kept = 0;
  let last = "";
  buildPhases.on = (p) => {
    // A build that is the last build ends at its lookup; one that ran ends with its files.
    if (p === "build: cache key and lookup") kept++;
    if (p === "build: files and build.json") {
      built++;
      kept--;
    }
    last = p;
  };
  void last;
  return {
    applies,
    /** Builds that ran their passes (the last build was of other inputs). */
    built: () => built,
    /** Builds that were the last build, kept whole. */
    kept: () => kept,
  };
}

async function run(
  root: string,
  runner: AcpStepRunner,
  o: { maxParts?: number; signal?: AbortSignal } = {},
) {
  const out: string[] = [];
  const progress: string[] = [];
  const code = await mapAllCommand(
    root,
    {
      maxTokens: LIMIT,
      mode: "copilot-acp",
      repos: ["forge-ledger"],
      ...(o.maxParts ? { maxParts: o.maxParts } : {}),
    },
    {
      out: (l) => out.push(l),
      err: (l) => out.push(`ERR ${l}`),
      progress: (l) => progress.push(l),
    },
    {
      acp: runner,
      assistantFiles: async () => ({ results: [] }),
      ...(o.signal ? { signal: o.signal } : {}),
    },
  );
  return { code, text: out.join("\n"), progress };
}

/**
 * A read whose every session accounts for the part it is given (the next one of the read plan
 * not read yet): the first writes the facts, each its part's reviewed lines.
 */
function wholeRead(root: string, head: string, parts: MapAllPlan["items"][0]["parts"]) {
  let first = true;
  const session: Session = async () => {
    if (first) writeFileSync(join(root, "facts", "forge-ledger.jsonl"), factsText(head));
    first = false;
    const next = (await readPlanProgress(root, "forge-ledger"))?.next?.part ?? 1;
    appendFileSync(
      join(root, "facts", "forge-ledger.reviewed.jsonl"),
      reviewed(parts.find((p) => p.part === next)!.paths),
    );
  };
  return sessions(parts.map(() => session));
}

describe("how many applies and builds one repo's map runs (beta.28.5)", () => {
  it("a read in parts applies the repo once per part and once in the join; only the first builds", async () => {
    const { root, head } = estate();
    const item = await planOf(root);
    expect(item.total).toBeGreaterThan(2);
    const s = wholeRead(root, head, item.parts);
    const n = counting();
    const r = await run(root, s.runner);
    expect(r.code, r.text).toBe(0);
    // Six parts; one needs no session (the facts of the first cite all its files).
    expect(item.total).toBe(6);
    expect(s.seen).toHaveLength(5);
    expect(r.text).toContain("Joining the estate: atticus verify --all --write.");
    // One apply after each session (a Stop after any part leaves that part in the catalog) and
    // one in the join. It was seven: the part that needs no session applied the repo again to
    // find that out, straight after the apply of the part before it.
    expect(n.applies).toEqual(Array.from({ length: 5 + 1 }, () => "forge-ledger"));
    // The passes ran for the first part, whose facts are new, and for the last, whose read is
    // complete (the snapshot says so); every other apply took the last build.
    expect({ built: n.built(), kept: n.kept() }).toEqual({ built: 2, kept: 4 });
    // Each apply is said with its count for the repo, so a loop reads as a loop.
    expect(r.progress.filter((l) => l.startsWith("Applying "))).toEqual([
      "Applying forge-ledger (atticus verify forge-ledger --write)…",
      "Applying forge-ledger (atticus verify forge-ledger --write), the 2nd time in this run…",
      "Applying forge-ledger (atticus verify forge-ledger --write), the 3rd time in this run…",
      "Applying forge-ledger (atticus verify forge-ledger --write), the 4th time in this run…",
      "Applying forge-ledger (atticus verify forge-ledger --write), the 5th time in this run…",
    ]);
  }, 120_000);

  it("a part given again applies what the first session left once, not twice in a row", async () => {
    const { root, head } = estate();
    const item = await planOf(root);
    const [p1] = item.parts;
    const s = sessions([
      // The facts, and none of the part's other files accounted for.
      () => writeFileSync(join(root, "facts", "forge-ledger.jsonl"), factsText(head)),
      // The new session, given what is left.
      () => appendFileSync(join(root, "facts", "forge-ledger.reviewed.jsonl"), reviewed(p1!.paths)),
    ]);
    const n = counting();
    const r = await run(root, s.runner, { maxParts: 2 });
    expect(r.text).toContain("one more try in a NEW session with only what is left");
    expect(r.text).toContain("Stopped at the cap (--max-parts 2): 2 sessions run.");
    // After the first session and after the second: it was three, the first one's twice.
    expect(n.applies).toEqual(["forge-ledger", "forge-ledger"]);
    expect(n.built()).toBe(1);
  }, 120_000);
});

describe("the estate join after a map (beta.28.5)", () => {
  // ADR 0210 part 8: the join is verify --all --write's own run; its per-repo loop here, as
  // ATTICUS_APPLY_ONE_BUILD=0 runs it (the one build's Stop is apply-all-stop.test.ts's).
  beforeAll(() => {
    process.env.ATTICUS_APPLY_ONE_BUILD = "0";
  });
  afterAll(() => {
    delete process.env.ATTICUS_APPLY_ONE_BUILD;
  });
  it("says each repo as it starts, with the time left once one has finished", async () => {
    const { root, head } = estate({ notify: true });
    const item = await planOf(root);
    const s = wholeRead(root, head, item.parts);
    const n = counting();
    const r = await run(root, s.runner);
    expect(r.code, r.text).toBe(0);
    expect(r.progress.filter((l) => l.startsWith("Repo "))).toEqual([
      "Repo 1 of 2: forge-ledger…",
      expect.stringMatching(
        /^Repo 2 of 2: forge-notify… \(1 done in \d+ s; .+ left at this rate\)$/,
      ),
    ]);
    expect(n.applies.slice(s.seen.length)).toEqual(["forge-ledger", "forge-notify"]);
    expect(r.text).toContain("Verified 2 repos: 2 passed.");
  }, 120_000);

  it("goes on past a repo whose file another program holds, and lists it with its command", async () => {
    const { root, head } = estate({ notify: true });
    const item = await planOf(root);
    const s = wholeRead(root, head, item.parts);
    // Windows, simulated: the ledger's report is held from the join on (the parts are read first).
    let joining = false;
    fsHooks.platform = "win32";
    fsHooks.sleep = async () => undefined;
    fsHooks.say = () => undefined;
    fsHooks.rename = async (from, to) => {
      if (joining && to.endsWith("forge-ledger.verify.yaml"))
        throw Object.assign(
          new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`),
          {
            code: "EPERM",
          },
        );
      const { rename } = await import("node:fs/promises");
      await rename(from, to);
    };
    const n = counting();
    const out: string[] = [];
    const code = await mapAllCommand(
      root,
      { maxTokens: LIMIT, mode: "copilot-acp", repos: ["forge-ledger"] },
      {
        out: (l) => {
          if (l.startsWith("Joining the estate")) joining = true;
          out.push(l);
        },
        err: (l) => out.push(`ERR ${l}`),
      },
      { acp: s.runner, assistantFiles: async () => ({ results: [] }) },
    );
    const text = out.join("\n");
    expect(code, text).toBe(1);
    const file = join(root, "facts", "forge-ledger.verify.yaml");
    expect(text).toContain(
      `forge-ledger: not applied: ${file} is open in another program (an editor, an assistant's session or a virus scan) or can't be written, and it stayed so for 45 s. Nothing was lost: the file is as it was. Close it there, then run the command again. Run it once that is put right: atticus verify forge-ledger --write`,
    );
    // The notifier is applied all the same.
    expect(n.applies.slice(s.seen.length)).toEqual(["forge-notify"]);
    expect(text).toContain("Verified 2 repos: 1 passed, 1 with something to fix (forge-ledger).");
    expect(text).toContain("ERR Repo 2 of 2: forge-notify…");
    expect(text).not.toMatch(/EPERM|\.tmp/);
  }, 120_000);

  it("stops between two repos when asked, the repo it was on applied whole, and says which are not", async () => {
    const { root, head } = estate({ notify: true });
    const item = await planOf(root);
    const s = wholeRead(root, head, item.parts);
    const stop = new AbortController();
    const n = counting();
    // Ctrl+C while the join applies its first repo.
    let joined = 0;
    writeFactsHooks.onWrite = (repo) => {
      n.applies.push(repo);
      if (n.applies.length > s.seen.length && ++joined === 1) stop.abort();
    };
    const r = await run(root, s.runner, { signal: stop.signal });
    expect(n.applies.slice(s.seen.length)).toEqual(["forge-ledger"]);
    expect(r.text).toContain(
      // verify --all --write hears Stop before the write begins: neither repo is applied.
      "Stopped after 0 of 2 repos. Not applied: forge-ledger, forge-notify.",
    );
    expect(r.text).not.toContain("Verified 2 repos");
  }, 120_000);

  // The review of beta.28.5: only a file system's error is a repo not applied; a bug is thrown.
  it("an error that is no file system's ends the run, as before: it is never said as a repo not applied", async () => {
    const { root, head } = estate({ notify: true });
    const item = await planOf(root);
    const s = wholeRead(root, head, item.parts);
    let applies = 0;
    writeFactsHooks.onWrite = () => {
      if (++applies > s.seen.length) throw new TypeError("x is not a function");
    };
    await expect(run(root, s.runner)).rejects.toThrow("x is not a function");
  }, 120_000);
});
