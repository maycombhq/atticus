import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { budgetRuntime, MockRuntime, type AiRequest } from "@maycombhq/ai";
import { acquireLock, withRunIo } from "@maycombhq/core";
import { mapCommand } from "../src/map-commands.js";
import { main } from "../src/main.js";
import { runPreflight } from "../src/run-preflight.js";

/**
 * ADR 0210 part 5 at the command line: the read says its plan before its first prompt, keeps to
 * runtime.yaml's budget, and checks its result can be written. Mock runtimes only (rule 5).
 */
const fixtures = join(__dirname, "..", "..", "verify", "test", "fixtures");
const REPO = "forge-ledger";
const COMMIT = "0123abc";
const NOW = () => new Date("2026-11-24T12:00:00.000Z");

function adoptedRepo(runtimeYaml?: string): string {
  const root = mkdtempSync(join(tmpdir(), "atticus-budget-"));
  cpSync(join(fixtures, "repo"), root, { recursive: true });
  mkdirSync(join(root, ".atticus", "org-pack"), { recursive: true });
  if (runtimeYaml) writeFileSync(join(root, ".atticus", "org-pack", "runtime.yaml"), runtimeYaml);
  return root;
}
const lines = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
};
function read(root: string, limits: { per: "run"; sessions: number }[], maxTokens: number) {
  const prompts: AiRequest[] = [];
  const runtime = budgetRuntime(new MockRuntime((r) => (prompts.push(r), ""), { now: NOW }), {
    root,
    limits,
    now: NOW,
  });
  const o = lines();
  const code = withRunIo({ say: o.io.err }, () =>
    mapCommand(root, REPO, { commit: COMMIT, maxTokens }, o.io, { runtime, now: NOW }),
  );
  return { code, prompts, o };
}

describe("a read's budget (ADR 0210 part 5)", () => {
  it("says the sessions and tokens it plans before its first prompt, and sends that many", async () => {
    const root = adoptedRepo();
    const r = read(root, [], 9000);
    await r.code;
    const plan = r.o.err.find((l) => l.startsWith("Budget: "));
    const m =
      /^Budget: The read of forge-ledger plans (\d+) sessions? and about [\d,]+ tokens; no limit is set/.exec(
        plan ?? "",
      );
    expect(m, r.o.err.join("\n")).not.toBeNull();
    // Every batch is a session: a read with no fact rejected has no fix round.
    expect(r.prompts.length).toBe(Number(m![1]));
    expect(r.prompts.length).toBeGreaterThan(1);
    // A larger limit packs the same files into fewer sessions: as few as it allows.
    const big = read(adoptedRepo(), [], 200_000);
    await big.code;
    expect(big.prompts.length).toBe(1);
    expect(big.o.err.find((l) => l.startsWith("Budget: "))).toMatch(/plans 1 session and/);
  });

  it("unattended, a read past the budget stops before its first prompt, with a non-zero exit", async () => {
    const r = read(adoptedRepo(), [{ per: "run", sessions: 1 }], 9000);
    expect(await r.code).toBe(2);
    expect(r.prompts).toEqual([]);
    expect(r.o.err.at(-1)).toMatch(
      /^This run would pass 1 session a run: 0 used and \d+ planned\. Nothing was sent\. Confirm it at a terminal, run it with --yes/,
    );
  });

  it("refuses before any prompt while another write holds the metarepo's lock", async () => {
    const root = adoptedRepo();
    expect(await runPreflight(root)).toBeUndefined();
    const lock = await acquireLock(root, "scan", "catalog build");
    try {
      expect(await runPreflight(root)).toMatch(/^Another catalog build is running \(process \d+/);
    } finally {
      await lock.release();
    }
  });

  it("in CI, the command prints the same line and stops with the budget's words", async () => {
    const root = adoptedRepo(
      [
        "schemaVersion: 5",
        "assistants: { allowed: [copilot], default: copilot }",
        "modes: { allowed: [hand-off, model], default: model }",
        "adapters: { model: { type: mock, settings: { model: mock-model } } }",
        "budgets: { limits: [{ per: run, sessions: 1 }] }",
        "",
      ].join("\n"),
    );
    const was = process.env.CI;
    process.env.CI = "true";
    try {
      const o = lines();
      const code = await main(
        [
          "map",
          REPO,
          "--commit",
          COMMIT,
          "--mode",
          "model",
          "--max-tokens",
          "9000",
          "--root",
          root,
        ],
        { ...o.io, ask: async () => "y" },
      );
      expect(code, o.err.join("\n")).toBe(2);
      expect(
        o.err.some((l) => /^Budget: The read of forge-ledger plans \d+ sessions/.test(l)),
      ).toBe(true);
      expect(o.err.at(-1)).toMatch(/^This run would pass 1 session a run: .* Nothing was sent\./);
    } finally {
      if (was === undefined) delete process.env.CI;
      else process.env.CI = was;
    }
  });
});
