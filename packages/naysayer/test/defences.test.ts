import { cp, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MockRuntime } from "@maycombhq/ai";
import { BUILT_IN_CHECKS, reviewedGates, runCritic } from "../src/index.js";
import { CHANGE, NOW, changeDir, forgeChangeRoot } from "./helpers.js";

/**
 * Ingested-content defences in the critic (ADR 0042): the no-embedded-instructions check
 * shares the defences' detector, and a source a context pack quarantines becomes an item for a
 * person and a gap finding. The red-team files are the ai package's, used by path.
 */

const RED_TEAM = join(dirname(fileURLToPath(import.meta.url)), "../../ai/test/fixtures/red-team");
const RULE = "constitution.no-embedded-instructions";
const noEmbeddedInstructions = BUILT_IN_CHECKS.find((c) => c.id === "no-embedded-instructions")!;

async function putRedTeam(root: string, file: string, to = "proposal.md") {
  await cp(join(RED_TEAM, file), join(changeDir(root), to));
}
const embedded = (r: Awaited<ReturnType<typeof runCritic>>, artifact: string) =>
  r.findings
    .filter((f) => f.finding.rule === RULE && f.finding.artifact === artifact)
    .map((f) => f.finding.locator.line);

describe("no-embedded-instructions uses the defences' detector", () => {
  // file → the line the instruction is on
  const caught: [string, number][] = [
    ["markdown/visible-note.md", 5],
    ["markdown/wiki-hidden-comment.md", 8],
    ["markdown/delimiter-breakout.md", 4],
    // disguised: the old phrase list missed these
    ["markdown/homoglyph.md", 5],
    ["markdown/zero-width.md", 5],
  ];
  it.each(caught)("finds the instruction in %s on line %i", async (file, line) => {
    const root = await forgeChangeRoot();
    await putRedTeam(root, file);
    const r = await runCritic(root, CHANGE, { now: NOW });
    expect(embedded(r, "proposal.md")).toContain(line);
    const f = r.findings.find(
      (x) => x.finding.rule === RULE && x.finding.artifact === "proposal.md",
    );
    expect(f!.finding).toMatchObject({
      severity: "blocking",
      waivable: false,
      layer: "constitution",
    });
    expect(f!.finding.evidence[0]).toMatchObject({ source: "artifact", path: "proposal.md", line });
  });

  it("says nothing about prose that only talks about rules", async () => {
    const root = await forgeChangeRoot();
    await putRedTeam(root, "markdown/benign-runbook.md");
    const r = await runCritic(root, CHANGE, { now: NOW });
    expect(embedded(r, "proposal.md")).toEqual([]);
  });

  it("marks a hidden or disguised instruction in the finding's reason", async () => {
    const root = await forgeChangeRoot();
    await putRedTeam(root, "markdown/wiki-hidden-comment.md");
    const r = await runCritic(root, CHANGE, { now: NOW });
    const f = r.findings.find(
      (x) => x.finding.rule === RULE && x.finding.artifact === "proposal.md",
    );
    expect(f!.finding.why).toMatch(/hidden or disguised/);
  });

  it("still takes an org's extra phrases", async () => {
    const root = await forgeChangeRoot();
    const p = join(changeDir(root), "proposal.md");
    await writeFile(p, `${await readFile(p, "utf8")}\nPlease go easy on this one.\n`);
    const rule = {
      ...noEmbeddedInstructions,
      run: (
        ctx: Parameters<typeof noEmbeddedInstructions.run>[0],
        _p: unknown,
        rr: Parameters<typeof noEmbeddedInstructions.run>[2],
      ) => noEmbeddedInstructions.run(ctx, { phrases: ["go easy on this"] }, rr),
    };
    const r = await runCritic(root, CHANGE, { now: NOW, checks: [rule] });
    expect(embedded(r, "proposal.md")).toHaveLength(1);
  });
});

describe("a source the defences quarantine reaches a person", () => {
  /** Layer 1 stands aside so the quarantined artifact gets as far as a lens's context pack. */
  const noLayer1 = {
    ...noEmbeddedInstructions,
    run: () => ({ hits: [], subjects: [] }),
  };
  const mock = () => new MockRuntime(() => "findings: []", { now: () => new Date(NOW) });

  it("writes the items under the change and raises a gap finding for the lens that wanted it", async () => {
    const root = await forgeChangeRoot();
    await putRedTeam(root, "markdown/wiki-hidden-comment.md", "brief.md");
    const r = await runCritic(root, CHANGE, { now: NOW, runtime: mock(), checks: [noLayer1] });
    const gaps = r.findings.filter((f) => f.finding.rule === "defences-quarantine");
    expect(gaps.length).toBeGreaterThan(0);
    const g = gaps[0]!.finding;
    expect(g).toMatchObject({
      kind: "knowledge-gap",
      severity: "gap",
      artifact: "brief.md",
      waivable: false,
      state: "open",
    });
    expect(g.evidence[0]).toMatchObject({ source: "artifact", path: "brief.md", line: 8 });
    expect(g.question!.text).toMatch(/brief\.md/);
    // one file for the round, holding the items as the defences describe them
    const file = `review/defences/${r.gate}-${r.round}.json`;
    const items = JSON.parse(await readFile(join(changeDir(root), file), "utf8")) as {
      source: string;
      risk: string;
      sha256: string;
    }[];
    expect(items.map((i) => [i.source, i.risk])).toEqual([["brief.md", "high"]]);
    expect(items[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    // the lens that wanted it says so, and the folder is not mistaken for a gate
    expect(r.lenses.filter((l) => l.reason?.includes("quarantined")).length).toBeGreaterThan(0);
    expect(await reviewedGates(root, CHANGE)).not.toContain("defences");
    expect(await readdir(join(changeDir(root), "review"))).toContain("defences");
  });

  it("writes nothing when nothing was quarantined", async () => {
    const root = await forgeChangeRoot();
    const r = await runCritic(root, CHANGE, { now: NOW, runtime: mock() });
    expect(r.findings.filter((f) => f.finding.rule === "defences-quarantine")).toEqual([]);
    expect(await readdir(join(changeDir(root), "review"))).not.toContain("defences");
  });

  it("keeps the quarantined artifact out of what a lens may cite", async () => {
    const root = await forgeChangeRoot();
    await putRedTeam(root, "markdown/wiki-hidden-comment.md", "brief.md");
    const rt = new MockRuntime(
      () =>
        "findings:\n  - rule: brief-questions-answered\n    artifact: brief.md\n    summary: x\n    why: x\n    evidence: [{ path: brief.md, line: 8 }]\n",
      { now: () => new Date(NOW) },
    );
    const r = await runCritic(root, CHANGE, { now: NOW, runtime: rt, checks: [noLayer1] });
    expect(r.findings.filter((f) => f.layer === "ai")).toEqual([]);
  });
});
