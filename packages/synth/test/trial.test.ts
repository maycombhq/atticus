import { readFile, readdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deserializeRecord, listQuestions, readRepoSpec, specRepos } from "@maycombhq/core";
import { writeTrialEstate, type TrialEstate } from "../src/trial.js";

/**
 * The trial estate (trial.ts): a metarepo in the shape a real trial had, for the command-line
 * perf budgets. Everything in it is invented Forge, and every record, flow, question and
 * knowledge item it writes is valid where Atticus reads it.
 */

let top: string;
let estate: TrialEstate;

beforeAll(async () => {
  top = await mkdtemp(join(tmpdir(), "atticus-trial-"));
  estate = await writeTrialEstate(join(top, "metarepo"), { repos: 8, flows: 24, facts: 40 });
}, 120_000);
afterAll(async () => {
  await rm(top, { recursive: true, force: true });
});

const files = async (dir: string): Promise<string[]> => {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true }))
    if (e.isFile()) out.push(join(e.parentPath, e.name));
  return out;
};

describe("the trial estate", () => {
  it("writes a metarepo whose counts it reports", async () => {
    expect(estate.counts).toEqual({
      repos: 8,
      records: expect.any(Number),
      flows: 24,
      facts: 40,
      knowledge: 120,
      questions: 18,
      stories: 3,
      tasks: 14,
    });
    expect((await stat(join(estate.root, "org-pack", "pack.yaml"))).isFile()).toBe(true);
    expect((await stat(join(estate.root, "openspec", "config.yaml"))).isFile()).toBe(true);
  });

  it("writes a catalog of valid records, one file per record", async () => {
    const paths = await files(join(estate.root, "catalog", "generated"));
    expect(paths.length).toBe(estate.counts.records);
    for (const p of paths) {
      const r = deserializeRecord(await readFile(p, "utf8"));
      expect(r.ok, `${p}: ${r.ok ? "" : JSON.stringify(r.issues)}`).toBe(true);
    }
  });

  it("writes every flow where a repo's spec is read from, with nothing that doesn't read", async () => {
    let flows = 0;
    for (const repo of await specRepos(estate.root)) {
      const spec = await readRepoSpec(estate.root, repo);
      expect(spec.problems).toEqual([]);
      expect(spec.header?.repo).toBe(repo);
      flows += spec.flows.length;
    }
    expect(flows).toBe(estate.counts.flows);
  });

  it("writes the facts as JSONL, one line per fact", async () => {
    let facts = 0;
    for (const f of await readdir(join(estate.root, "facts"))) {
      const lines = (await readFile(join(estate.root, "facts", f), "utf8")).trim().split("\n");
      for (const l of lines) expect(() => JSON.parse(l) as unknown).not.toThrow();
      facts += lines.length;
    }
    expect(facts).toBe(estate.counts.facts);
  });

  it("writes open questions that read as questions", async () => {
    const q = await listQuestions(estate.root, { state: "open" });
    expect(q.problems).toEqual([]);
    expect(q.questions.length).toBe(estate.counts.questions);
  });

  it("names nothing but the invented Forge estate and its invented vendor", async () => {
    const text = (await files(join(estate.root, "catalog"))).join(" ");
    expect(text).toMatch(/forge-/);
    const manifest = await readFile(
      join(estate.root, "org-pack", "profiles", "forge", "repos.manifest.yaml"),
      "utf8",
    );
    expect(manifest).toContain("git.example.com");
  });
});
