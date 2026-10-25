import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { HandoffRuntime, MockRuntime, type AiRequest } from "@maycombhq/ai";
import { KNOWLEDGE_SCAN_OUTPUT, knowledgeScanRoom, readSnapshot } from "@maycombhq/knowledge";
import { sourcesSync } from "../src/knowledge-commands.js";
import { knowledgeScan } from "../src/knowledge-scan-commands.js";
import { handoffDone } from "../src/workspace-commands.js";
import { main } from "../src/main.js";

/** ADR 0106: a knowledge scan in batches that fit one prompt of the model (--batch-tokens). */
describe("atticus knowledge scan --batch-tokens", () => {
  it("takes the room for pages in one prompt, a whole number of 500 or more", async () => {
    const root = await mkdtemp(`${tmpdir()}/atticus-batch-`);
    const err: string[] = [];
    const run = (n: string) =>
      main(
        ["knowledge", "scan", "--batch-tokens", n, "--root", root],
        { out: () => undefined, err: (l) => err.push(l) },
        { quiet: true },
      );
    expect(await run("10")).toBe(2);
    expect(err[0]).toBe(
      "--batch-tokens is a whole number of 500 or more: the room for pages in one prompt.",
    );
    expect(await run("lots")).toBe(2);
  });
});

// A docs-folder scan without --batch-tokens left 76 of 103 pages out of its prompt and said
// nothing. Every page is read now, in batches that fit the reader's prompt, or named.
const HERE = dirname(fileURLToPath(import.meta.url));
const WIKI = join(HERE, "../../../bench/knowledge/forge-wiki").split("\\").join("/");
const NOW = new Date("2026-10-21T09:00:00Z");

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const reports: Record<string, unknown>[] = [];
  return {
    io: {
      out: (l: string) => out.push(l),
      err: (l: string) => err.push(l),
      report: (d: Record<string, unknown>) => reports.push(d),
    },
    out,
    err,
    reports,
  };
}

/** The Forge wiki synced, with the knowledge reader's budget room for about `pages` tokens of pages. */
async function wikiWithReader(pageTokens: number): Promise<string> {
  const top = await mkdtemp(join(tmpdir(), "atticus-kscan-batches-"));
  const root = join(top, "metarepo");
  await mkdir(join(root, "org-pack"), { recursive: true });
  await writeFile(
    join(root, "org-pack", "sources.yaml"),
    `schemaVersion: 2\nwikis:\n  - { id: forge-wiki, type: markdown-folder, location: ${JSON.stringify(WIKI)} }\n`,
  );
  await sourcesSync(root, capture().io, { now: "2026-10-21T09:00:00Z" });
  // What the reader's budget must be for that room beside the instructions.
  const snap = (await readSnapshot(root, "forge-wiki"))!;
  const B = 100_000;
  const fixed =
    B -
    knowledgeScanRoom([snap], {
      agents: [],
      runtime: { budgets: { defaultTokens: B, perAgent: {} } },
    } as unknown as Parameters<typeof knowledgeScanRoom>[1]);
  await writeFile(
    join(root, "org-pack", "runtime.yaml"),
    `schemaVersion: 1\nassistants: { allowed: [claude-code], default: claude-code }\nbudgets: { defaultTokens: 150000, perAgent: { knowledge-reader: ${fixed + pageTokens} } }\n`,
  );
  return root;
}

const hashes = async (root: string) =>
  Object.keys(
    (
      parse(await readFile(join(root, "knowledge", "scan.yaml"), "utf8")) as {
        snapshots: { hashes: Record<string, string> }[];
      }
    ).snapshots[0]!.hashes,
  );

describe("atticus knowledge scan reads every page, in batches that fit", () => {
  it("reads batch after batch with a runtime that answers at once, each page once", async () => {
    const root = await wikiWithReader(2200);
    const sent: string[][] = [];
    const runtime = new MockRuntime((r: AiRequest) => {
      expect(r.pack.manifest.dropped).toEqual([]);
      sent.push(r.pack.manifest.sources.filter((s) => !s.trusted).map((s) => s.origin));
      return "items: []\n";
    });
    const c = capture();
    expect(await knowledgeScan(root, {}, { runtime, now: NOW }, c.io)).toBe(0);
    expect(sent.length).toBeGreaterThan(1);
    expect(sent.flat().sort()).toEqual((await hashes(root)).map((p) => `forge-wiki/${p}`).sort());
    expect(sent.flat()).toHaveLength(17);
    expect(c.out[0]).toBe(
      `Read 17 pages of forge-wiki in ${sent.length} batches, each within the reader's prompt (snapshot 2026-10-21).`,
    );
    expect(c.out.join("\n")).not.toMatch(/left to read/);
    expect(c.reports).toEqual([]);
  });

  it("hands one batch a run, says what waits, and the next run hands the next", async () => {
    const root = await wikiWithReader(2200);
    const runtime = new HandoffRuntime({ root, validate: async () => [], now: () => NOW });
    const c = capture();
    expect(await knowledgeScan(root, {}, { runtime, now: NOW }, c.io)).toBe(0);
    const text = c.out.join("\n");
    const waiting =
      /This batch holds (\d+) pages, as many as fit the reader's prompt; (\d+) pages wait for the next \(forge-wiki\/[^)]*\)\. After this one, run atticus knowledge scan again\./.exec(
        text,
      )!;
    expect(waiting).not.toBeNull();
    const [inBatch, rest] = [Number(waiting[1]), Number(waiting[2])];
    expect(inBatch + rest).toBe(17);
    expect(c.out.at(-1)).toMatch(/^Handed the knowledge scan to your assistant \(run run-/);
    const runId = /run (run-[0-9a-z-]+)/.exec(text)![1]!;
    await writeFile(
      join(root, ".runs", "knowledge-scan", runId, KNOWLEDGE_SCAN_OUTPUT),
      "items: []\n",
    );
    expect(await handoffDone(root, runId, capture().io)).toBe(0);
    const resumed = capture();
    expect(await knowledgeScan(root, { resume: runId }, { runtime, now: NOW }, resumed.io)).toBe(0);
    expect(resumed.out[0]).toBe(`Read ${inBatch} pages of forge-wiki (snapshot 2026-10-21).`);
    expect(resumed.out.join("\n")).toMatch(
      new RegExp(
        `${rest} pages left to read: run atticus knowledge scan again for the next batch \\(forge-wiki/`,
      ),
    );
    expect(resumed.reports).toEqual([{ pagesLeft: rest }]);
    expect(await hashes(root)).toHaveLength(inBatch);
    // The next run hands the pages that wait, not the ones read.
    const next = capture();
    expect(await knowledgeScan(root, {}, { runtime, now: NOW }, next.io)).toBe(0);
    expect(next.out.at(-1)).toMatch(/^Handed the knowledge scan to your assistant \(run run-/);
  });

  it("names a page too big for the reader's prompt, and reads every other page", async () => {
    // Room for about 740 tokens of pages: integration-patterns.md takes about 754.
    const root = await wikiWithReader(-260);
    const sent: string[] = [];
    const runtime = new MockRuntime((r: AiRequest) => {
      sent.push(...r.pack.manifest.sources.filter((s) => !s.trusted).map((s) => s.origin));
      return "items: []\n";
    });
    const c = capture();
    expect(await knowledgeScan(root, {}, { runtime, now: NOW }, c.io)).toBe(0);
    expect(c.out.join("\n")).toMatch(
      /1 page didn't fit the reader's prompt on its own and isn't read: forge-wiki\/integration-patterns\.md \(over the \d+-token budget\)\. Give the knowledge reader more room \(budgets\.perAgent\.knowledge-reader in org-pack\/runtime\.yaml\), or use a model with a bigger limit/,
    );
    expect(sent).toHaveLength(16);
    expect(sent).not.toContain("forge-wiki/integration-patterns.md");
    // Not recorded as read: the next scan tries it again. Nor a page for a batch tool to wait on.
    expect(await hashes(root)).not.toContain("integration-patterns.md");
    expect(c.reports).toEqual([]);
  });
});
