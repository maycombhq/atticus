import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import type { AcpExec } from "@maycombhq/ai";
import { acpStepRunner, expandSlashLine, UNATTENDED } from "../src/copilot-acp-steps.js";
import { mapAllCommand, preparedLine, readMapAllState, type MapAllPlan } from "../src/map-all.js";
import { readPlanProgress } from "../src/map-parts.js";
import { main } from "../src/main.js";

/**
 * ADR 0171: `atticus map --all` drives GitHub Copilot unattended through the Copilot language
 * server's Agent Client Protocol mode (copilot-acp): each part in one NEW session, its prompt the
 * /atticus-map steps a person would otherwise paste, verified as the waiting loop verifies it
 * (ADR 0170), a part not accounted for given once more in a new session with only what is left.
 * The server is a stand-in (fixtures/copilot-acp/mock-agent.mjs), a real child process speaking the
 * protocol; the atticus commands it runs run in this process. No network.
 */

const FIXTURES = join(__dirname, "..", "..", "..", "fixtures");
const MOCK = join(FIXTURES, "copilot-acp", "mock-agent.mjs");
const VERIFY = join(__dirname, "..", "..", "verify", "test", "fixtures");
const LIMIT = 100_000;

const temps: string[] = [];
const temp = (name: string) => {
  const d = mkdtempSync(join(tmpdir(), `atticus-acp-${name}-`));
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

/** The Forge ledger in parts, its runtime.yaml letting Atticus drive Copilot (version 3). */
function ledgerEstate() {
  const root = temp("ledger");
  cpSync(join(VERIFY, "metarepo", "org-pack"), join(root, "org-pack"), { recursive: true });
  write(
    root,
    "org-pack/runtime.yaml",
    stringify({
      schemaVersion: 3,
      assistants: { allowed: ["copilot"], default: "copilot" },
      modes: { allowed: ["hand-off", "copilot-acp"], default: "copilot-acp" },
      copilotAcp: { command: `"${process.execPath}" "${MOCK}"`, maxTurns: 100 },
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
  return { root, head: git("rev-parse", "HEAD") };
}

const factsText = (commit: string) =>
  readFileSync(join(VERIFY, "forge-ledger.facts.jsonl"), "utf8").replaceAll(
    '"commit":"0123abc"',
    `"commit":"${commit}"`,
  );

const reviewed = (globs: readonly string[]) =>
  globs.map((g) => `${JSON.stringify({ path: g, why: "read; nothing to record" })}\n`).join("");

/** The script the stand-in plays, and its log. */
function scripted(root: string, script: unknown) {
  const file = join(root, ".acp-script.json");
  writeFileSync(file, JSON.stringify(script));
  const log = join(root, ".acp-log.jsonl");
  return {
    env: { MOCK_ACP_SCRIPT: file, MOCK_ACP_LOG: log },
    log: () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l) as Record<string, unknown>)
        : [],
  };
}

/** `atticus <argv>` for the session, in this process, in the metarepo. */
const inProcess: AcpExec = async (argv, o) => {
  const out: string[] = [];
  const code = await main([...argv, "--root", o.cwd], {
    out: (l) => out.push(l),
    err: (l) => out.push(l),
  });
  return { exitCode: code, output: `${out.join("\n")}\n` };
};

const dryRun = async (root: string) => {
  const o = io();
  const code = await mapAllCommand(
    root,
    { dryRun: true, json: true, maxTokens: LIMIT, mode: "copilot-acp" },
    o.io,
    { acp: async () => Promise.reject(new Error("no session in a dry run")) },
  );
  expect(code, o.text()).toBe(0);
  return JSON.parse(o.text()) as MapAllPlan;
};

describe("atticus map --all under copilot-acp: Copilot driven unattended (ADR 0171)", () => {
  it("reads two parts, each in a new session; a part not accounted for gets one more session with only what is left", async () => {
    const { root, head } = ledgerEstate();
    const plan = await dryRun(root);
    expect(plan.mode).toBe("copilot-acp");
    const ledger = plan.items[0]!;
    expect(ledger.total).toBeGreaterThan(2);
    const [p1, p2] = ledger.parts as [
      MapAllPlan["items"][0]["parts"][0],
      MapAllPlan["items"][0]["parts"][0],
    ];
    const m = scripted(root, {
      sessions: [
        // Part 1: the facts, reviewed lines for its folders, and its own verify.
        {
          steps: [
            { run: "atticus", args: ["assistant-files", "--check"] },
            { read: "workspace/forge-ledger/src/main/java/forge/ledger/AccountController.java" },
            { write: "facts/forge-ledger.jsonl", content: factsText(head) },
            { append: "facts/forge-ledger.reviewed.jsonl", content: reviewed(p1.paths) },
            { run: "atticus", args: ["verify", "forge-ledger"] },
            { say: "Part 1 read; verify passed." },
          ],
        },
        // Part 2, first session: it stops having written nothing (its context ran out).
        { steps: [{ say: "I ran out of room." }, { stop: "max_tokens" }] },
        // Part 2 again, a new session with only what is left.
        {
          steps: [
            { append: "facts/forge-ledger.reviewed.jsonl", content: reviewed(p2.paths) },
            { run: "atticus verify forge-ledger" },
            { say: "The rest of part 2 read." },
          ],
        },
      ],
    });
    const runner = await acpStepRunner(root, { exec: inProcess, env: m.env });
    const o = io();
    const code = await mapAllCommand(
      root,
      { maxTokens: LIMIT, mode: "copilot-acp", maxParts: 3 },
      o.io,
      { acp: runner },
    );
    const text = o.text();
    expect(code, text).toBe(0);
    expect(text).toContain(
      "The estate at 100,000 tokens a prompt (--max-tokens), read by GitHub Copilot through its Agent Client Protocol, unattended: one new session per part:",
    );
    expect(text).toContain(`===== forge-ledger, part 1 of ${ledger.total} (repo 1 of 1) =====`);
    expect(text).toContain("In a NEW Copilot session (copilot-acp): /atticus-map forge-ledger");
    // Progress lines from the session, short.
    expect(text).toContain("  Copilot: Part 1 read; verify passed.");
    expect(text).toMatch(/ {2}atticus verify forge-ledger/);
    // Verified as verify --write runs, and on to part 2.
    expect(text).toMatch(/forge-ledger: \d+ facts kept, 0 rejected; coverage \d+%/);
    expect(text).toContain(`===== forge-ledger, part 2 of ${ledger.total} (repo 1 of 1) =====`);
    expect(text).toContain(
      `forge-ledger part 2 of ${ledger.total} isn't accounted for yet: one more try in a NEW session with only what is left (${preparedLine("forge-ledger", "facts/forge-ledger.gaps.md")}).`,
    );
    expect(text).toContain(`Stopped at the cap (--max-parts 3): 3 sessions run.`);
    const progress = await readPlanProgress(root, "forge-ledger");
    expect(progress!.parts[0]!.state).toBe("done");
    expect(progress!.parts[1]!.state).toBe("done");
    const st = await readMapAllState(root);
    expect(st?.repos["forge-ledger"]?.parts["2"]).toMatchObject({ state: "done", retries: 1 });
    // Three sessions, each a new server: never one session for two parts.
    const log = m.log();
    expect(log.filter((e) => e.event === "session").map((e) => e.n)).toEqual([1, 2, 3]);
    expect(log.filter((e) => e.event === "initialize")).toHaveLength(3);
    const prompts = log.filter((e) => e.event === "prompt").map((e) => String(e.text));
    // The prompt is the /atticus-map steps a person would paste, said to be unattended first.
    expect(prompts[0]!.startsWith(UNATTENDED)).toBe(true);
    expect(prompts[0]).toContain("atticus map forge-ledger --estimate");
    // beta.17: the retry reads the prompt Atticus wrote; it runs no atticus map itself.
    expect(prompts[2]).toContain(preparedLine("forge-ledger", "facts/forge-ledger.gaps.md"));
    // The atticus commands ran; nothing else could.
    const runs = log.filter((e) => e.event === "run");
    expect(runs.every((r) => r.ok === true)).toBe(true);
    // Each session is recorded as a run: its prompt, transcript, model and the server's version.
    const runsDir = join(root, ".runs", "map-forge-ledger");
    const ids = readdirSync(runsDir).filter((d) => d.startsWith("run-"));
    expect(ids).toHaveLength(3);
    for (const id of ids) {
      const run = JSON.parse(readFileSync(join(runsDir, id, "run.json"), "utf8"));
      expect(run).toMatchObject({
        runtime: "copilot-acp",
        model: "gpt-mock",
        assistant: { name: "mock-copilot", version: "0.0.1" },
        stepClass: "read",
      });
      expect(existsSync(join(runsDir, id, "transcript.jsonl"))).toBe(true);
      expect(existsSync(join(runsDir, id, "prompt.md"))).toBe(true);
    }
  });

  it("stops the run when Copilot isn't signed in, printing what the server said", async () => {
    const { root } = ledgerEstate();
    const m = scripted(root, { signedOut: "Not signed in to GitHub Copilot", sessions: [] });
    const runner = await acpStepRunner(root, { exec: inProcess, env: m.env });
    const o = io();
    const code = await mapAllCommand(root, { maxTokens: LIMIT, mode: "copilot-acp" }, o.io, {
      acp: runner,
    });
    expect(code).toBe(1);
    expect(o.text()).toContain("Not signed in to GitHub Copilot");
    expect(o.text()).toContain("https://github.com/login/device and enter WXYZ-0000");
    expect(o.text()).toContain("Atticus never enters or keeps your credentials");
    expect((await readMapAllState(root))?.repos["forge-ledger"]?.parts["1"]?.state).toBe(
      "incomplete",
    );
  });

  it("Ctrl+C cancels the session under way and stops cleanly, to resume later", async () => {
    const { root } = ledgerEstate();
    const m = scripted(root, {
      sessions: [{ steps: [{ tool: "Reading" }, { sleep: 3000 }, { tool: "More" }] }],
    });
    const runner = await acpStepRunner(root, { exec: inProcess, env: m.env });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 600);
    const o = io();
    expect(
      await mapAllCommand(root, { maxTokens: LIMIT, mode: "copilot-acp" }, o.io, {
        acp: runner,
        signal: ac.signal,
      }),
    ).toBe(0);
    expect(o.text()).toContain("Stopping the session: stopped (Ctrl+C).");
    expect(o.text()).toContain(
      "Stopped. Where the estate stands is saved: atticus map --all carries on from here.",
    );
    expect(m.log().some((e) => e.event === "cancel")).toBe(true);
    expect((await readMapAllState(root))?.repos["forge-ledger"]?.parts["1"]?.state).toBe(
      "incomplete",
    );
  });

  it("runs from the command line, and refuses the mode where runtime.yaml doesn't allow it", async () => {
    const { root } = ledgerEstate();
    const o = io();
    const code = await main(
      [
        "map",
        "--all",
        "--mode",
        "copilot-acp",
        "--dry-run",
        "--max-tokens",
        "100000",
        "--root",
        root,
      ],
      o.io,
    );
    expect(code, o.text()).toBe(0);
    expect(o.text()).toContain("read by GitHub Copilot through its Agent Client Protocol");
    write(
      root,
      "org-pack/runtime.yaml",
      "schemaVersion: 2\nassistants: { allowed: [copilot], default: copilot }\n",
    );
    const no = io();
    expect(
      await main(
        ["map", "--all", "--mode", "copilot-acp", "--max-tokens", "100000", "--root", root],
        no.io,
      ),
    ).toBe(2);
    expect(no.text()).toContain("runtime.yaml doesn't allow copilot-acp here");
  });
});

describe("the line's text (ADR 0171)", () => {
  it("is the metarepo's Copilot prompt file with the arguments put in, else the built-in command", async () => {
    const root = temp("lines");
    const built = await expandSlashLine(root, "/atticus-map forge-ledger --part 2");
    expect(built).toContain("atticus map forge-ledger --part 2 --estimate");
    expect(built).not.toContain("{{ARGS}}");
    write(
      root,
      ".github/prompts/atticus-map.prompt.md",
      "---\ndescription: x\nagent: agent\n---\n\nRead ${input:args} the org's way.\n",
    );
    expect(await expandSlashLine(root, "/atticus-map forge-ledger")).toBe(
      "Read forge-ledger the org's way.",
    );
    expect(await expandSlashLine(root, "plain words")).toBe("plain words");
  });
});

describe("atticus questions propose under copilot-acp (ADR 0171)", () => {
  it("runs /atticus-propose in a new session that may write only proposals/questions/, then checks them", async () => {
    const { root } = ledgerEstate();
    const m = scripted(root, {
      sessions: [
        {
          steps: [
            { run: "atticus", args: ["questions", "list", "--state", "open", "--json"] },
            { write: "proposals/questions/q-0001.yaml", content: "schemaVersion: 1\n" },
            // Never a question file, and never an answer: a person accepts.
            { write: "questions/q-0001.yaml", content: "state: answered\n" },
            { run: "atticus", args: ["questions", "answer", "q-0001", "--accept-proposal"] },
          ],
        },
      ],
    });
    const runner = await acpStepRunner(root, { exec: inProcess, env: m.env });
    const { questionsProposeCommand } = await import("../src/copilot-acp-steps.js");
    const o = io();
    let checked = 0;
    await questionsProposeCommand(root, { mode: "copilot-acp", runner }, o.io, async () => {
      checked++;
      return 0;
    });
    expect(checked).toBe(1);
    expect(o.text()).toContain("Proposing answers in a new Copilot session: /atticus-propose");
    expect(existsSync(join(root, "proposals/questions/q-0001.yaml"))).toBe(true);
    expect(existsSync(join(root, "questions/q-0001.yaml"))).toBe(false);
    const runs = m.log().filter((e) => e.event === "run");
    expect(runs.map((r) => r.ok)).toEqual([true, false]);
    const prompt = String(m.log().find((e) => e.event === "prompt")!.text);
    expect(prompt).toContain("proposals/questions/<question id>.yaml");
    // Without the mode, the line to paste.
    const plain = io();
    await questionsProposeCommand(
      root,
      { mode: "hand-off", id: "q-0001" },
      plain.io,
      async () => 0,
    );
    expect(plain.out[0]).toBe("In a NEW Copilot Chat (agent mode), run: /atticus-propose q-0001");
  });
});
