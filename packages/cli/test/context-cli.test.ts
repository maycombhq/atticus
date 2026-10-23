import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { main } from "../src/main.js";

/**
 * ADR 0107 addendum: the context tools as commands. A person (or the MCP server) shows a record,
 * walks its links and shows the code a fact cites; the VS Code extension runs each tool call
 * Copilot's model makes as atticus context call, kept in the waiting run's record.
 */

const FIX = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
const RUN = "run-20261023090000-0001";

async function metarepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-context-cli-"));
  for (const r of parse(readFileSync(join(FIX, "specs/catalog.yaml"), "utf8")) as unknown[]) {
    const p = parseRecord(r);
    if (!p.ok) throw new Error("bad fixture record");
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  await cp(join(FIX, "stages/specs"), join(root, "specs"), { recursive: true });
  await cp(join(FIX, "specs/repos/forge-orders"), join(root, "workspace/forge-orders"), {
    recursive: true,
  });
  // A run waiting for the person's assistant (the hand-off runtime writes this).
  const dir = join(root, ".runs", "add-fraud-check", RUN);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "prompt.md"), "Place the change.\n");
  await writeFile(
    join(dir, "run.json"),
    JSON.stringify({
      runId: RUN,
      request: {
        change: "add-fraud-check",
        agent: { id: "feature-placer" },
        outputPath: "feature-answer.yaml",
        outputIn: "run",
      },
      runtime: "hand-off",
      state: "waiting",
      attempt: 1,
      startedAt: "2026-10-23T09:00:00Z",
      errors: [],
    }),
  );
  return root;
}

async function run(root: string, ...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main([...args, "--root", root], {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("atticus context (ADR 0107 addendum)", { timeout: 120_000 }, () => {
  it("shows a record, walks its links and shows the code a fact cites", async () => {
    const root = await metarepo();
    const show = await run(root, "context", "show", "forge-orders.place-order");
    expect(show.code).toBe(0);
    expect(show.out).toMatch(/^Flow forge-orders.place-order/);
    const walk = await run(root, "context", "walk", "forge-orders.place-order", "--hops", "1");
    expect(walk.out).toMatch(/^Links from forge-orders.place-order, 1 hop:/);
    const code = await run(root, "context", "code", "forge-orders.place-order#1", "--around", "1");
    expect(code.code).toBe(0);
    expect(code.out).toMatch(/OrderController.java:4:\n\s*3 {2}.*\n>\s*4 {2}/);
    const none = await run(root, "context", "show", "quillfeather-risk");
    expect(none.code).toBe(2);
    expect(none.err).toMatch(/nothing called quillfeather-risk/);
  });

  it("lists the tools with their schemas and caps", async () => {
    const root = await metarepo();
    const r = await run(root, "context", "tools", "--json");
    const j = JSON.parse(r.out) as {
      tools: { name: string; inputSchema: object }[];
      limits: { rounds: number; tokens: number };
    };
    expect(j.tools.map((t) => t.name)).toEqual(["search", "show", "walk", "show_code"]);
    expect(j.limits.rounds).toBeGreaterThan(0);
  });

  it("runs one call a model made and keeps it in the run's record, which Model runs shows", async () => {
    const root = await metarepo();
    const r = await run(
      root,
      "context",
      "call",
      "show",
      "--input",
      '{"id":"forge-orders.place-order"}',
      "--run",
      RUN,
      "--round",
      "1",
      "--json",
    );
    expect(r.code, r.err).toBe(0);
    const j = JSON.parse(r.out) as { output: string; tokens: number; error?: boolean };
    expect(j.output).toMatch(/^<atticus-data id="tool-show" kind="tool" origin="tool:show">/);
    expect(j.error).toBeUndefined();
    const refused = await run(
      root,
      "context",
      "call",
      "show_code",
      "--input",
      '{"id":"nope"}',
      "--run",
      RUN,
      "--round",
      "2",
      "--json",
    );
    expect((JSON.parse(refused.out) as { error?: boolean }).error).toBe(true);
    const kept = JSON.parse(
      await readFile(join(root, ".runs/add-fraud-check", RUN, "run.json"), "utf8"),
    ) as { state: string; tools: { offered: string[]; calls: { round: number; name: string }[] } };
    expect(kept.state).toBe("waiting");
    expect(kept.tools.calls.map((c) => [c.round, c.name])).toEqual([
      [1, "show"],
      [2, "show_code"],
    ]);
    const shown = await run(root, "runs", "show", RUN);
    expect(shown.out).toMatch(
      /Tools offered: search, show, walk, show_code; the model called them 2 times\./,
    );
    expect(shown.out).toMatch(/Round 2: show_code \{"id":"nope"\} \(refused\)/);
    const list = await run(root, "runs");
    expect(list.out).toMatch(/2 tool calls/);
    // Input that isn't a JSON object, and a run that isn't there, are refused.
    expect((await run(root, "context", "call", "show", "--input", "[1]")).code).toBe(2);
    expect(
      (await run(root, "context", "call", "show", "--input", "{}", "--run", "run-1-1")).code,
    ).toBe(2);
  });
});
