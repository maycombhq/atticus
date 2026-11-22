import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { main } from "../src/main.js";

/**
 * The owner's decision of 2026-11-22 (ADR 0115 and ADR 0203, addenda of that day): in a coding
 * assistant's terminal `atticus finding <change> <id> waive` is refused even with --by, the rule
 * the app has (it offers no Accept, and refuses one, where an assistant would be recorded). --by
 * names who is recorded; it can't make an assistant's terminal a person's. The words lead with
 * what to do. Before, --by skipped the check, so an assistant could accept a stage's finding or
 * waive a critic's in a person's name.
 */

const MARKS = ["ATTICUS_ASSISTANT", "CLAUDECODE", "GEMINI_CLI", "CURSOR_AGENT"];
const made: string[] = [];
afterAll(async () => {
  await Promise.all(made.map((d) => rm(d, { recursive: true, force: true })));
});

async function run(argv: string[], env: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "atticus-finding-assistant-"));
  made.push(root);
  const out: string[] = [];
  const err: string[] = [];
  const kept = Object.fromEntries(MARKS.map((k) => [k, process.env[k]]));
  for (const k of MARKS) delete process.env[k];
  Object.assign(process.env, env);
  try {
    const code = await main([...argv, "--root", root], {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
    return { code, said: [...out, ...err].join("\n"), left: await readdir(root) };
  } finally {
    for (const k of MARKS)
      if (kept[k] === undefined) delete process.env[k];
      else process.env[k] = kept[k];
  }
}

const WAIVE = ["finding", "raise-limit", "stage-feature-1", "waive", "--reason", "known"];

describe("atticus finding … waive in a coding assistant's terminal", () => {
  it.each([
    [{ CLAUDECODE: "1" }, "CLAUDECODE is set"],
    [{ GEMINI_CLI: "1" }, "GEMINI_CLI is set"],
    [{ CURSOR_AGENT: "1" }, "CURSOR_AGENT is set"],
    [{ ATTICUS_ASSISTANT: "copilot" }, "ATTICUS_ASSISTANT is set"],
  ])("is refused even with --by (%o)", async (env, because) => {
    const r = await run([...WAIVE, "--by", "pat"], env);
    expect(r.code).toBe(1);
    expect(r.said).toBe(
      `Accept or waive it in a terminal of your own, or in the app: this terminal is a coding assistant's (${because}), and only a person accepts or waives a finding. --by names who is recorded; it doesn't make this terminal a person's. Nothing was written.`,
    );
    expect(r.left).toEqual([]);
  });

  it("goes on to the finding in a person's own terminal, with --by or without", async () => {
    for (const by of [["--by", "pat"], []]) {
      const r = await run([...WAIVE, ...by], {});
      expect(r.said).not.toContain("coding assistant's");
      expect(r.said).not.toContain("Recorded as");
    }
  });

  it("keeps what an assistant's own decision does with no --by: recorded as the assistant", async () => {
    const r = await run(WAIVE, { CLAUDECODE: "1" });
    expect(r.said).toContain("Recorded as claude-code: CLAUDECODE is set.");
    expect(r.said).not.toContain("--by names who is recorded");
  });
});
