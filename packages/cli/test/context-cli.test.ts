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
    expect(j.tools.map((t) => t.name)).toEqual([
      "search",
      "show",
      "walk",
      "show_code",
      "grep",
      "files",
      "outline",
    ]);
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
      /Tools offered: search, show, walk, show_code, grep, files, outline; the model called them 2 times\./,
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

  // ADR 0118: the model searches the code; a hit is a pointer show_code may show in that run.
  it("greps, lists and outlines the clones, and shows a hit's lines in the run that found it", async () => {
    const root = await metarepo();
    const vault = join(root, "workspace/forge-vault");
    await cp(join(FIX, "code-search/repos/forge-vault"), vault, { recursive: true });
    await mkdir(join(vault, "generated"), { recursive: true });
    await writeFile(join(vault, "generated/Stub.java"), '@ForgeServiceBase("/stub")\n');
    const APP = "src/main/java/forge/vault/VaultApplication.java";
    const grep = await run(root, "context", "grep", "@ForgeServiceBase", "--repo", "forge-vault");
    expect(grep.code, grep.err).toBe(0);
    expect(grep.out).toContain(`forge-vault:${APP}:7: @ForgeServiceBase("/vault-api")`);
    expect(grep.out).not.toContain("generated/");
    const re = await run(root, "context", "grep", "@vault\\w+\\(", "--regex", "--ignore-case");
    expect(re.out).toMatch(
      /forge-vault:src\/main\/java\/forge\/vault\/web\/SecretController\.java:15:/,
    );
    const files = await run(root, "context", "files", "*.java", "--repo", "forge-vault");
    expect(files.out.split("\n").filter((l) => l.startsWith("forge-vault:"))).toEqual([
      `forge-vault:${APP}`,
      "forge-vault:src/main/java/forge/vault/web/SecretController.java",
    ]);
    // The outline comes from the syntax tree the readers parse.
    const outline = await run(root, "context", "outline", "forge-vault", APP);
    expect(outline.out.split("\n").slice(2)).toEqual([
      "6: @SpringBootApplication",
      '7: @ForgeServiceBase("/vault-api")',
      "8: class VaultApplication",
      "9:   method main",
    ]);
    expect((await run(root, "context", "outline", "forge-vault")).code).toBe(2);
    expect((await run(root, "context", "grep")).code).toBe(2);
    // A person's show_code by line shows only a cited line; in the run whose grep found it, the hit.
    const at = ["--repo", "forge-vault", "--path", APP, "--line", "7"];
    expect((await run(root, "context", "code", ...at)).code).toBe(2);
    const call = (tool: string, input: object, round: string) =>
      run(
        root,
        "context",
        "call",
        tool,
        "--input",
        JSON.stringify(input),
        "--run",
        RUN,
        "--round",
        round,
        "--json",
      );
    const hit = await call("grep", { pattern: "ForgeServiceBase(", repo: "forge-vault" }, "1");
    expect((JSON.parse(hit.out) as { output: string }).output).toContain(`${APP}:7:`);
    const shown = JSON.parse(
      (await call("show_code", { repo: "forge-vault", path: APP, line: 7, context: 1 }, "2")).out,
    ) as { output: string; error?: boolean };
    expect(shown.error).toBeUndefined();
    expect(shown.output).toMatch(
      /A search hit at forge-vault\/src\/main\/java\/forge\/vault\/VaultApplication.java:7:/,
    );
    const other = JSON.parse(
      (await call("show_code", { repo: "forge-vault", path: APP, line: 3 }, "2")).out,
    ) as { error?: boolean };
    expect(other.error).toBe(true);
    // Model runs shows each search the model made.
    const runs = await run(root, "runs", "show", RUN);
    expect(runs.out).toMatch(
      /Round 1: grep \{"pattern":"ForgeServiceBase\(","repo":"forge-vault"\}/,
    );
  });
});
