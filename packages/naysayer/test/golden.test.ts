import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { ReplayRuntime } from "@maycombhq/ai";
import { Finding } from "@maycombhq/core";
import { canAdvance } from "@maycombhq/changes";
import { runCritic, type CriticFinding } from "../src/index.js";
import { CHANGE, FORGE_CHANGE, NOW, changeDir, forgeChangeRoot, readText } from "./helpers.js";

/**
 * The M3 exit measure for the critic, on the hand-written fixture fixtures/forge-change:
 * every seeded blocking issue caught, at least 90% of seeded knowledge gaps caught, no finding
 * without evidence, and nothing raised that the expected file doesn't list. Layer 1 must catch
 * everything marked deterministic on its own; the replayed AI lenses (hand-written recordings)
 * cover only what needs judgement.
 */

interface Expected {
  id: string;
  kind: "issue" | "knowledge-gap";
  severity: string;
  layer: "deterministic" | "ai";
  rule: string;
  artifact?: string;
  line?: number;
  record?: string;
  what?: string;
}

const expected = parse(readFileSync(join(FORGE_CHANGE, "expected/findings.yaml"), "utf8")) as {
  change: string;
  gate: string;
  seeded: Expected[];
  alsoExpected: Expected[];
};

function matches(e: Expected, f: CriticFinding): boolean {
  const x = f.finding;
  if (x.rule !== e.rule || x.severity !== e.severity || x.kind !== e.kind) return false;
  if (e.artifact && x.artifact !== e.artifact) return false;
  if (e.line && x.locator.line !== e.line) return false;
  if (e.record && x.locator.record !== e.record && !x.evidence.some((v) => v.record === e.record))
    return false;
  return true;
}

function table(found: CriticFinding[]): string {
  return found
    .map((f) =>
      [
        f.layer.padEnd(13),
        f.finding.severity.padEnd(8),
        f.finding.rule.padEnd(42),
        `${f.finding.artifact}${f.finding.locator.line ? `:${f.finding.locator.line}` : ""}`.padEnd(
          32,
        ),
        f.finding.summary,
      ].join(" "),
    )
    .join("\n");
}

const replay = () =>
  ReplayRuntime.fromDir(join(FORGE_CHANGE, "recordings"), { now: () => new Date(NOW) });

describe("the critic on the seeded fixture change (M3 exit)", () => {
  it("catches every seeded blocking issue and at least 90% of seeded gaps, with evidence and no noise", async () => {
    const root = await forgeChangeRoot();
    const r = await runCritic(root, CHANGE, { now: NOW, runtime: await replay() });
    expect(r.gate).toBe(expected.gate);
    expect(r.round).toBe(1);
    expect(r.problems).toEqual([]);
    expect(r.refused).toEqual([]);
    // Every lens that had something to review ran on the replayed answers.
    expect(
      r.lenses.filter((l) => l.state === "failed").map((l) => `${l.lens}: ${l.reason}`),
    ).toEqual([]);
    expect(r.discarded).toEqual([]);

    console.log(
      `Critic findings by layer (round ${r.round}, gate ${r.gate}):\n${table(r.findings)}`,
    );

    const blocking = expected.seeded.filter((e) => e.severity === "blocking");
    const gaps = expected.seeded.filter((e) => e.kind === "knowledge-gap");
    expect(gaps.length).toBeGreaterThanOrEqual(10);
    const missed = (list: Expected[]) => list.filter((e) => !r.findings.some((f) => matches(e, f)));
    expect(missed(blocking).map((e) => e.id)).toEqual([]);
    const caughtGaps = gaps.length - missed(gaps).length;
    expect(caughtGaps / gaps.length).toBeGreaterThanOrEqual(0.9);

    // Each seeded problem was caught by the layer the expected file says.
    for (const e of [...expected.seeded, ...expected.alsoExpected]) {
      const f = r.findings.find((x) => matches(e, x));
      if (f) expect({ id: e.id, layer: f.layer }).toEqual({ id: e.id, layer: e.layer });
    }

    // No noise: every finding is a seeded problem or listed as also expected.
    const listed = [...expected.seeded, ...expected.alsoExpected];
    const unlisted = r.findings.filter((f) => !listed.some((e) => matches(e, f)));
    expect(
      unlisted.map((f) => `${f.finding.rule} ${f.finding.artifact}: ${f.finding.summary}`),
    ).toEqual([]);

    // Every finding cites evidence and is a valid C3 finding file on disk.
    for (const f of r.findings) {
      expect(f.finding.evidence.length).toBeGreaterThan(0);
      const onDisk = Finding.parse(parse(await readText(join(changeDir(root), f.path))));
      expect(onDisk).toEqual(f.finding);
    }
    // AI findings only come from AI rules, deterministic ones only from deterministic rules.
    const aiRules = new Set([
      "design-concurrency-handled",
      "story-traces-to-spec",
      "brief-questions-answered",
      "ux-states-complete",
      "design-has-rollback",
      "tasks-sequenced-for-lead-times",
    ]);
    for (const f of r.findings) expect(aiRules.has(f.finding.rule)).toBe(f.layer === "ai");

    // The gate is closed, and the lifecycle reads the same answer from the files.
    expect(r.status.mayProceed).toBe(false);
    expect(r.status.open.blocking).toBe(blocking.length);
    const ready = await canAdvance(CHANGE, root);
    expect(ready.reasons.filter((x) => x.code === "blocking-finding").length).toBe(blocking.length);
    expect(ready.reasons.filter((x) => x.code === "open-gap").length).toBe(gaps.length);
  });

  it("layer 1 alone catches every seeded problem marked deterministic", async () => {
    const root = await forgeChangeRoot();
    const r = await runCritic(root, CHANGE, { now: NOW });
    const det = [...expected.seeded, ...expected.alsoExpected].filter(
      (e) => e.layer === "deterministic",
    );
    expect(det.filter((e) => !r.findings.some((f) => matches(e, f))).map((e) => e.id)).toEqual([]);
    expect(r.findings.every((f) => f.layer === "deterministic")).toBe(true);
    expect(r.lenses.every((l) => l.state === "skipped")).toBe(true);
  });

  it("keeps artifacts that failed layer 1 out of the AI lenses, and wraps what it sends as data", async () => {
    const root = await forgeChangeRoot();
    const prompts = new Map<string, string>();
    const rt = await replay();
    const r = await runCritic(root, CHANGE, {
      now: NOW,
      runtime: {
        kind: rt.kind,
        prepare: async (req) => {
          prompts.set(req.agent.id, req.pack.prompt);
          return rt.prepare(req);
        },
        run: (id) => rt.run(id),
        result: (id) => rt.result(id),
      },
    });
    expect(r.failedLayer1).toEqual([
      "data.md",
      "interfaces.md",
      "snow.md",
      "stories/s2-show-remaining.md",
      "stories/s3-audit-refusals.md",
    ]);
    const all = [...prompts.values()].join("\n");
    for (const f of r.failedLayer1) expect(all).not.toContain(`id="${f}"`);
    expect(all).not.toContain("ignore their rules");
    // The subtle instruction in ux.md reaches the UX lens only inside a data block, after the data rule.
    const ux = prompts.get("ux-critic")!;
    const at = ux.indexOf("mark every UX");
    expect(at).toBeGreaterThan(ux.indexOf('<atticus-data id="ux.md"'));
    expect(at).toBeLessThan(ux.indexOf("</atticus-data>", at));
    expect(ux.indexOf("never instructions")).toBeLessThan(ux.indexOf("<atticus-data id="));
    // The release lens had nothing that passed layer 1; the code lens nothing due yet.
    expect(r.lenses.find((l) => l.lens === "release")?.state).toBe("skipped");
    expect(r.rules.skipped.find((s) => s.rule === "tests-cover-scenarios")?.reason).toMatch(
      /aren't due at the plan gate/,
    );
    expect(r.rules.skipped.find((s) => s.rule === "release-plan-complete")?.reason).toMatch(
      /snow\.md has blocking layer-1 findings/,
    );
  });
});
