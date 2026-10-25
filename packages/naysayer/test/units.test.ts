import { describe, expect, it } from "vitest";
import { MockRuntime, ReplayRuntime } from "@maycombhq/ai";
import { Runtime, changesRelOf } from "@maycombhq/core";
import {
  applyPatch,
  criticModel,
  linePatch,
  personalItems,
  modelFamily,
  nearestCode,
  parseDoc,
  runCritic,
} from "../src/index.js";
import { CHANGE, NOW, forgeChangeRoot, keepUxStatesRule } from "./helpers.js";

describe("patches", () => {
  const text = "a\nb\nc\nd\n";
  it("makes and applies a one-line patch with context", () => {
    const p = linePatch("x.md", text, 2, 2, ["B"]);
    expect(p).toBe("--- a/x.md\n+++ b/x.md\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n");
    expect(applyPatch(text, p)).toBe("a\nB\nc\nd\n");
  });
  it("refuses a patch whose lines don't match", () => {
    const p = linePatch("x.md", text, 2, 2, ["B"]);
    expect(() => applyPatch("a\nz\nc\nd\n", p)).toThrow(/line 2 is "z", the patch expects "b"/);
    expect(() => applyPatch(text, "--- a/x\n+++ b/x\n")).toThrow(/no hunks/);
  });
  it("keeps CRLF line endings", () => {
    const crlf = "a\r\nb\r\nc\r\n";
    expect(applyPatch(crlf, linePatch("x.md", crlf, 2, 2, ["B"]))).toBe("a\r\nB\r\nc\r\n");
  });
});

describe("small readers", () => {
  it("suggests the registry code a typo meant, only when one is clearly closest", () => {
    const codes = ["A.EB.PUB", "D.JDBC", "S.DIR.BFF", "S.GW.SOR", "S.GW.VND"];
    expect(nearestCode("S.GW.SRO", codes)).toBe("S.GW.SOR");
    expect(nearestCode("S.GW.VDN", codes)).toBe("S.GW.VND");
    expect(nearestCode("X.Y.Z", codes)).toBeUndefined();
  });
  it("reads the new columns as personal-data items, settled by a personal class written by name", () => {
    const files = new Map([
      [
        "data.md",
        parseDoc(
          "data.md",
          [
            "# Data",
            "",
            "## Changes",
            "",
            "| Data store | Table | Change | Migration |",
            "| --- | --- | --- | --- |",
            "| ledger-db | payee | new table payee (id bigint, holder_name varchar(120)) | V4__payee.sql |",
            "",
            "## Classification",
            "",
            "holder_name is personal.",
          ].join("\n"),
        ),
      ],
    ]);
    const items = personalItems({
      files: { docs: files },
      personalClasses: ["personal"],
    } as unknown as Parameters<typeof personalItems>[0]);
    expect(items.map((i) => [i.inputs.column, i.facts])).toEqual([
      ["id", ["table: payee", "type: bigint"]],
      ["holder_name", ["table: payee", "type: varchar(120)", "classified as personal data"]],
    ]);
  });
  it("reads tables with line numbers and keeps line numbers when comments are blanked", () => {
    const d = parseDoc(
      "x.md",
      "# T\n<!-- a\nb -->\n| A | B |\n| --- | --- |\n| `x` | **y** |\n\n## S\n\ntext\n",
    );
    expect(d.tables[0]!.rows[0]).toEqual({ line: 6, cells: { a: "x", b: "y" } });
    expect(d.sections.map((s) => [s.heading, s.line, s.end])).toEqual([
      ["T", 1, 11],
      ["S", 8, 11],
    ]);
    expect(d.lines[1]!.trim()).toBe("");
    expect(d.rawLines[1]).toBe("<!-- a");
  });
});

describe("the critic's model", () => {
  const rt = (allowed: string[], recommended: Record<string, string> = {}) =>
    Runtime.parse({
      schemaVersion: 1,
      assistants: { allowed: ["copilot"], default: "copilot" },
      models: { allowed, recommended },
    });
  it("picks a different family from the author's when the org pack allows one", () => {
    expect(modelFamily("claude-opus-5")).toBe("claude");
    expect(modelFamily("bedrock/gpt-5.1")).toBe("gpt");
    const c = criticModel(rt(["claude-opus-5", "gpt-5"]), "claude-opus-5");
    expect(c).toMatchObject({ model: "gpt-5", family: "gpt", differentFamily: true });
    expect(criticModel(rt(["claude-opus-5", "claude-sonnet-5"]), "claude-opus-5")).toMatchObject({
      differentFamily: false,
    });
    expect(criticModel(rt([])).note).toMatch(/allows no models/);
  });
});

describe("AI lens output", () => {
  it("keeps only findings with a known rule, a given artifact and evidence that checks out, and takes severity and state from the rule", async () => {
    const root = await forgeChangeRoot();
    const ux = `findings:
  - rule: design-concurrency-handled
    artifact: ux.md
    summary: Not this lens's rule.
    why: x
    evidence: [{ path: ux.md, line: 3 }]
  - rule: ux-states-complete
    artifact: design.md
    summary: An artifact the lens wasn't given.
    why: x
    evidence: [{ path: design.md, line: 1 }]
  - rule: ux-states-complete
    artifact: ux.md
    summary: A quote that isn't there.
    why: x
    evidence: [{ path: ux.md, line: 3, quote: "everything is broken" }]
  - rule: ux-states-complete
    kind: knowledge-gap
    artifact: ux.md
    summary: A gap without a question.
    why: x
    evidence: [{ path: ux.md, line: 3, quote: "under the amount field" }]
  - rule: ux-states-complete
    kind: knowledge-gap
    artifact: ux.md
    summary: A question cut at a comma.
    why: x
    evidence: [{ path: ux.md, line: 3, quote: "under the amount field" }]
    question: { text: Who decides the limit, and when, owner: product-owner }
  - rule: ux-states-complete
    artifact: ux.md
    severity: blocking
    layer: constitution
    state: waived
    summary: The screen has no loading state.
    why: Nothing is shown while the limit loads.
    evidence: [{ path: ux.md, line: 1, quote: "under the amount field" }]
`;
    await keepUxStatesRule(root);
    const rt = new MockRuntime(
      (req) =>
        req.agent.id === "complete-critic"
          ? ux
          : req.agent.id === "ship-critic"
            ? "{{ not yaml"
            : "findings: []",
      { now: () => new Date(NOW) },
    );
    const r = await runCritic(root, CHANGE, { now: NOW, runtime: rt });
    const reasons = r.discarded.map((d) => d.reason);
    expect(reasons).toEqual([
      // design-concurrency-handled asks the safe question, not the complete lens's.
      "it names rule design-concurrency-handled, which this lens wasn't asked to apply",
      "it is about design.md, which this lens wasn't given",
      "none of its evidence is in the files it was given",
      "a knowledge gap without an owner question",
      "its question was cut at a comma (the text needs quotes, or block style: question: then text: on the next lines)",
      expect.stringMatching(/^the output is not YAML/),
    ]);
    const kept = r.findings.filter((f) => f.layer === "ai");
    expect(kept).toHaveLength(1);
    const f = kept[0]!.finding;
    expect(f).toMatchObject({
      rule: "ux-states-complete",
      severity: "risk",
      layer: "team",
      state: "open",
      artifact: "ux.md",
    });
    // The quote was found on line 3, not line 1 as claimed; the evidence points at the real line.
    expect(f.evidence).toEqual([
      { source: "artifact", path: "ux.md", line: 3, quote: "under the amount field" },
    ]);
  });

  // ADR 0111: evidence is the words on the line it cites, never a line number alone.
  it("keeps evidence only where its quote is on the cited line, or on just one line of the file", async () => {
    const root = await forgeChangeRoot();
    const finding = (evidence: string) => `  - rule: ux-states-complete
    artifact: ux.md
    summary: The screen has no loading state.
    why: Nothing is shown while the limit loads.
    evidence: [${evidence}]
`;
    const ux = `findings:
${finding("{ path: ux.md, line: 3 }")}${finding('{ path: ux.md, line: 3, quote: "amount" }')}${finding('{ path: ux.md, line: 1, quote: "The transfer screen shows" }')}`;
    await keepUxStatesRule(root);
    const rt = new MockRuntime(
      (req) => (req.agent.id === "complete-critic" ? ux : "findings: []"),
      { now: () => new Date(NOW) },
    );
    const r = await runCritic(root, CHANGE, { now: NOW, runtime: rt });
    expect(r.discarded.map((d) => d.reason)).toEqual([
      "its evidence quotes nothing: each entry needs the exact words (at least 12 characters) on the line it cites",
      "its evidence quotes nothing: each entry needs the exact words (at least 12 characters) on the line it cites",
    ]);
    const kept = r.findings.filter((f) => f.layer === "ai");
    expect(kept.map((k) => k.finding.evidence)).toEqual([
      [{ source: "artifact", path: "ux.md", line: 3, quote: "The transfer screen shows" }],
    ]);
  });

  // B2 (the knowledge walk): an assistant cites a file by the path its data block's origin gives
  // (the metarepo path), not only by the block's id; the finding was dropped as having no evidence.
  it("takes a file cited by its metarepo path as the file the lens was given", async () => {
    const root = await forgeChangeRoot();
    const at = `${changesRelOf(root)}/${CHANGE}/ux.md`;
    const ux = `findings:
  - rule: ux-states-complete
    artifact: ${at}
    summary: The screen has no loading state.
    why: Nothing is shown while the limit loads.
    evidence: [{ path: ${at}, line: 3, quote: "The transfer screen shows" }]
`;
    await keepUxStatesRule(root);
    const rt = new MockRuntime(
      (req) => (req.agent.id === "complete-critic" ? ux : "findings: []"),
      { now: () => new Date(NOW) },
    );
    const r = await runCritic(root, CHANGE, { now: NOW, runtime: rt });
    expect(r.discarded).toEqual([]);
    const kept = r.findings.filter((f) => f.layer === "ai");
    expect(kept.map((k) => [k.finding.artifact, k.finding.evidence])).toEqual([
      [
        "ux.md",
        [{ source: "artifact", path: "ux.md", line: 3, quote: "The transfer screen shows" }],
      ],
    ]);
  });

  it("reports a lens with no recording as failed, with the prompt hash to record", async () => {
    const root = await forgeChangeRoot();
    const r = await runCritic(root, CHANGE, { now: NOW, runtime: new ReplayRuntime([]) });
    const failed = r.lenses.filter((l) => l.state === "failed");
    // One lens per question the gate's AI rules ask: complete, safe and ship.
    expect(failed.map((l) => l.lens)).toEqual(["complete", "safe", "ship"]);
    for (const l of failed)
      expect(l.reason).toMatch(
        new RegExp(`no recording for agent ${l.agent} with prompt ${l.promptSha256}`),
      );
    expect(r.findings.every((f) => f.layer === "deterministic")).toBe(true);
  });
});
