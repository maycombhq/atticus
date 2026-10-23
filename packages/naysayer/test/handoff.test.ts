import { cp, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { HandoffRuntime, MockRuntime, ReplayRuntime, type Run } from "@maycombhq/ai";
import {
  BUILT_IN_CHECKS,
  CriticError,
  act,
  completeLensRun,
  gateStatus,
  lensRunOf,
  readRound,
  runCritic,
  waitingLenses,
  type CriticResult,
  type LensRun,
} from "../src/index.js";
import { CHANGE, FORGE_CHANGE, NOW, changeDir, forgeChangeRoot } from "./helpers.js";

/**
 * The critic's AI lenses in hand-off mode (the main mode at a client site): the round is
 * written with the layer-1 findings and each lens waiting, `completeLensRun` (what
 * `atticus handoff done` calls) reads a lens's answer into that round with the same parser and
 * the same evidence bounds as a model run's, and the round's status follows.
 */

const LATER = "2026-10-21T10:00:00Z";
const RECORDINGS = join(FORGE_CHANGE, "recordings");
const RED_TEAM = join(dirname(fileURLToPath(import.meta.url)), "../../ai/test/fixtures/red-team");

const handoff = (root: string) =>
  new HandoffRuntime({ root, validate: async () => [], now: () => new Date(NOW) });
const replay = () => ReplayRuntime.fromDir(RECORDINGS, { now: () => new Date(NOW) });
const lensRuns = (r: CriticResult) => r.lenses.filter((l) => l.state !== "skipped");

/** What the recording for this lens's prompt says (the answer a good assistant would give). */
async function recorded(l: LensRun): Promise<string> {
  const file = join(RECORDINGS, l.agent, `${l.promptSha256}.json`);
  return (JSON.parse(await readFile(file, "utf8")) as { output: string }).output;
}

/** The assistant writes its answer where the prompt said, then `handoff done`. */
async function answer(root: string, rt: HandoffRuntime, l: LensRun, text?: string): Promise<Run> {
  await writeFile(
    join(root, ".runs", CHANGE, l.runId!, `findings-${l.lens}.yaml`),
    text ?? (await recorded(l)),
  );
  return rt.done(l.runId!);
}

const shape = (fs: Awaited<ReturnType<typeof readRound>>["findings"]) =>
  fs
    .map((s) => ({
      id: s.finding.id,
      rule: s.finding.rule,
      kind: s.finding.kind,
      severity: s.finding.severity,
      layer: s.finding.layer,
      artifact: s.finding.artifact,
      line: s.finding.locator.line,
      state: s.finding.state,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

const roundMeta = async (root: string, round = 1) =>
  parse(await readFile(join(changeDir(root), `review/plan/${round}/meta/round.yaml`), "utf8")) as {
    lenses: { lens: string; state: string; runId?: string; reason?: string }[];
    findings: { id: string; layer: string }[];
    discarded: { lens: string; reason: string }[];
    rules: { ran: string[] };
  };

describe("the critic in hand-off mode", () => {
  it("writes the round with the layer-1 findings and each AI lens waiting, not failed", async () => {
    const root = await forgeChangeRoot();
    const r = await runCritic(root, CHANGE, { now: NOW, runtime: handoff(root) });
    const runs = lensRuns(r);
    expect(runs.map((l) => l.lens)).toEqual([
      "business",
      "architecture",
      "story",
      "ux",
      "delivery",
    ]);
    for (const l of runs) {
      expect(l.state, l.lens).toBe("waiting");
      expect(l.runId).toMatch(/^run-\d+-\d+$/);
      expect(l.reason).toBe(
        `handed to your assistant; finish with atticus handoff done ${l.runId}`,
      );
    }
    expect(r.lenses.filter((l) => l.state === "failed")).toEqual([]);
    expect(new Set(runs.map((l) => l.runId)).size).toBe(runs.length);

    // Layer 1 is the round's findings so far: exactly what the critic finds without AI.
    const plain = await runCritic(await forgeChangeRoot(), CHANGE, { now: NOW });
    expect(r.findings.every((f) => f.layer !== "ai")).toBe(true);
    expect(r.findings.map((f) => f.finding.id).sort()).toEqual(
      plain.findings.map((f) => f.finding.id).sort(),
    );

    // The gate is not open while an assistant still has a lens, whatever layer 1 found.
    expect(r.status.mayProceed).toBe(false);
    expect(r.status.waiting.map((w) => w.lens)).toEqual(runs.map((l) => l.lens));
    expect(r.status.reasons.join("\n")).toContain(
      `The business lens is still with your assistant: run atticus handoff done ${runs[0]!.runId}.`,
    );

    // The round on disk says the same, and lists the runs.
    const meta = await roundMeta(root);
    expect(meta.lenses.filter((l) => l.state === "waiting").map((l) => l.runId)).toEqual(
      runs.map((l) => l.runId),
    );
    expect(await waitingLenses(root, CHANGE, "plan")).toEqual(
      runs.map((l) => ({ lens: l.lens, runId: l.runId, round: 1 })),
    );
    const prompt = await readFile(
      join(root, ".runs", CHANGE, runs[0]!.runId!, "prompt.md"),
      "utf8",
    );
    // The answer goes to a file in the run's own folder: nothing stale from an earlier round can
    // be taken for this round's answer, and the change folder keeps only the round.
    expect(prompt).toContain("# business-critic: write findings-business.yaml for change");
    expect(prompt).toContain(
      `Write the result to .runs/${CHANGE}/${runs[0]!.runId}/findings-business.yaml.`,
    );
  });

  it("reads a lens's answer into the round, and the round ends as a replay run's would", async () => {
    const root = await forgeChangeRoot();
    const rt = handoff(root);
    const r = await runCritic(root, CHANGE, { now: NOW, runtime: rt });
    const runs = lensRuns(r);
    const layer1 = shape((await readRound(root, CHANGE, "plan", 1)).findings);

    const done: Awaited<ReturnType<typeof completeLensRun>>[] = [];
    for (const [i, l] of runs.entries()) {
      const run = await answer(root, rt, l);
      expect(run.state).toBe("validated");
      const c = await completeLensRun(root, run, { now: LATER });
      done.push(c);
      expect(c).toMatchObject({ change: CHANGE, gate: "plan", round: 1 });
      expect(c.lens).toMatchObject({ lens: l.lens, state: "ran", runId: l.runId });
      expect(c.waiting.map((w) => w.lens)).toEqual(runs.slice(i + 1).map((x) => x.lens));
      // The gate stays closed until every lens is in.
      expect(c.status.mayProceed).toBe(false);
      expect(c.status.waiting.length).toBe(runs.length - i - 1);
    }
    // The AI findings are new files in round 1, dated when they were read in.
    const added = done.flatMap((c) => c.findings);
    expect(added.length).toBeGreaterThan(5);
    expect(added.every((f) => f.layer === "ai" && f.finding.createdAt === LATER)).toBe(true);
    expect(added.every((f) => f.finding.round === 1 && f.path.startsWith("review/plan/1/"))).toBe(
      true,
    );

    const meta = await roundMeta(root);

    // Same round as the replay run over the same recordings.
    const baseline = await forgeChangeRoot();
    await runCritic(baseline, CHANGE, { now: NOW, runtime: await replay() });
    const got = shape((await readRound(root, CHANGE, "plan", 1)).findings);
    expect(got).toEqual(shape((await readRound(baseline, CHANGE, "plan", 1)).findings));
    expect(got.length).toBe(layer1.length + added.length);
    expect(meta.findings.filter((f) => f.layer === "ai").length).toBe(added.length);

    // Status is recomputed: nothing waits, and the blocking findings now close the gate.
    const s = await gateStatus(root, CHANGE, "plan");
    expect(s.waiting).toEqual([]);
    expect(s.mayProceed).toBe(false);
    expect(s.open.blocking).toBeGreaterThan(0);
    expect(s.reasons.some((x) => x.includes("still with your assistant"))).toBe(false);
    const sb = await gateStatus(baseline, CHANGE, "plan");
    expect(s.open).toEqual(sb.open);
    expect(s.total).toEqual(sb.total);

    expect(meta.lenses.filter((l) => l.runId).map((l) => l.state)).toEqual(runs.map(() => "ran"));
    expect(meta.findings.length).toBe(got.length);
    expect(await waitingLenses(root, CHANGE, "plan")).toEqual([]);
    // A run summary for each lens, finished.
    const summary = parse(
      await readFile(join(changeDir(root), "review/plan/1/meta/runs/business-critic.yaml"), "utf8"),
    ) as { state: string; runtime: string };
    expect(summary).toMatchObject({ state: "validated", runtime: "hand-off" });
    // And a second critic run is round 2, as always.
    expect((await runCritic(root, CHANGE, { now: LATER })).round).toBe(2);
  });

  it("holds an AI finding to the evidence a model run's must have: a quote that isn't on the line, or a rule it wasn't asked to apply, is discarded", async () => {
    const root = await forgeChangeRoot();
    const rt = handoff(root);
    const r = await runCritic(root, CHANGE, { now: NOW, runtime: rt });
    const l = lensRuns(r).find((x) => x.lens === "architecture")!;
    const rule = l.rules[0]!;
    const artifact = l.artifacts[0]!;
    const text = [
      "findings:",
      `  - { rule: ${rule}, artifact: ${artifact}, summary: Made up., why: x, evidence: [{ path: ${artifact}, line: 1, quote: "this sentence is nowhere in the file" }] }`,
      `  - { rule: not-a-rule, artifact: ${artifact}, summary: Wrong rule., why: x, evidence: [{ path: ${artifact}, line: 1 }] }`,
      `  - { rule: ${rule}, artifact: nowhere.md, summary: Wrong file., why: x, evidence: [{ path: nowhere.md, line: 1 }] }`,
      "",
    ].join("\n");
    const run = await answer(root, rt, l, text);
    const c = await completeLensRun(root, run, { now: LATER });
    expect(c.lens.state).toBe("ran");
    expect(c.findings).toEqual([]);
    expect(c.discarded.map((d) => d.reason)).toEqual([
      "none of its evidence is in the files it was given",
      "it names rule not-a-rule, which this lens wasn't asked to apply",
      "it is about nowhere.md, which this lens wasn't given",
    ]);
    const meta = await roundMeta(root);
    expect(meta.discarded.map((d) => d.lens)).toEqual([
      "architecture",
      "architecture",
      "architecture",
    ]);
    expect(meta.lenses.find((x) => x.lens === "architecture")!.state).toBe("ran");
    expect(meta.findings.filter((f) => f.layer === "ai")).toEqual([]);
  });

  it("keeps a quarantined artifact out of what the lens may cite, and its gap finding and item stay", async () => {
    const root = await forgeChangeRoot();
    await cp(join(RED_TEAM, "markdown/wiki-hidden-comment.md"), join(changeDir(root), "brief.md"));
    const noLayer1 = {
      ...BUILT_IN_CHECKS.find((c) => c.id === "no-embedded-instructions")!,
      run: () => ({ hits: [], subjects: [] }),
    };
    const rt = handoff(root);
    const r = await runCritic(root, CHANGE, { now: NOW, runtime: rt, checks: [noLayer1] });
    expect(
      r.findings.filter((f) => f.finding.rule === "defences-quarantine").length,
    ).toBeGreaterThan(0);
    const l = lensRuns(r).find((x) => x.artifacts.includes("brief.md"))!;
    const text = `findings:\n  - { rule: brief-questions-answered, artifact: brief.md, summary: Open question., why: x, evidence: [{ path: brief.md, line: 8 }] }\n`;
    const run = await answer(root, rt, l, text);
    const c = await completeLensRun(root, run, { now: LATER });
    expect(c.findings).toEqual([]);
    expect(c.discarded.map((d) => d.reason)).toEqual([
      "it is about brief.md, which this lens wasn't given",
    ]);
    expect(c.lens.reason).toMatch(/quarantined by the defences, for a person to review: brief\.md/);
    expect(
      (await readRound(root, CHANGE, "plan", 1)).findings.filter(
        (f) => f.finding.rule === "defences-quarantine",
      ).length,
    ).toBeGreaterThan(0);
    expect(await readdir(join(changeDir(root), "review/defences"))).toEqual(["plan-1.json"]);
  });

  it("marks a lens failed when its run did not validate, and the others still complete", async () => {
    const root = await forgeChangeRoot();
    const rt = handoff(root);
    const r = await runCritic(root, CHANGE, { now: NOW, runtime: rt });
    const [first, second] = lensRuns(r);
    const failedRun = await rt.done(first!.runId!);
    expect(failedRun.state).toBe("failed");
    const c = await completeLensRun(root, failedRun, { now: LATER });
    expect(c.lens).toMatchObject({
      lens: first!.lens,
      state: "failed",
      reason: "findings-business.yaml was not written",
    });
    expect(c.findings).toEqual([]);
    expect(c.waiting.length).toBe(lensRuns(r).length - 1);
    const ok = await completeLensRun(root, await answer(root, rt, second!), { now: LATER });
    expect(ok.lens.state).toBe("ran");
    expect((await roundMeta(root)).lenses.find((l) => l.lens === first!.lens)!.state).toBe(
      "failed",
    );
  });

  it("reads an empty answer or a refusal as a lens that failed, never a clean review, and the gate stays closed", async () => {
    const root = await forgeChangeRoot();
    const rt = handoff(root);
    const r = await runCritic(root, CHANGE, { now: NOW, runtime: rt });
    const runs = lensRuns(r);
    const [empty, refusal] = runs;
    const a = await completeLensRun(root, await answer(root, rt, empty!, ""), { now: LATER });
    expect(a.lens).toMatchObject({ state: "failed" });
    expect(a.lens.reason).toContain("has no findings list");
    const b = await completeLensRun(
      root,
      await answer(root, rt, refusal!, "I'm sorry, but I can't help with that."),
      { now: LATER },
    );
    expect(b.lens.state).toBe("failed");
    for (const l of runs.slice(2))
      await completeLensRun(root, await answer(root, rt, l, "findings: []\n"), { now: LATER });
    const meta = await roundMeta(root);
    expect(meta.lenses.filter((l) => l.state === "failed").map((l) => l.lens)).toEqual([
      empty!.lens,
      refusal!.lens,
    ]);
    // Nothing is waiting, and nothing open blocks, but two lenses never reviewed.
    const s = await gateStatus(root, CHANGE, "plan");
    expect(s.waiting).toEqual([]);
    expect(s.mayProceed).toBe(false);
    expect(s.reasons.join("\n")).toContain(
      `The ${empty!.lens} lens on the plan gate (round 1) didn't review`,
    );
  });

  it("records a model's empty answer as a lens that failed, not one that ran", async () => {
    const root = await forgeChangeRoot();
    const r = await runCritic(root, CHANGE, {
      now: NOW,
      runtime: new MockRuntime(() => "", { now: () => new Date(NOW) }),
    });
    const runs = lensRuns(r);
    expect(runs.length).toBeGreaterThan(0);
    for (const l of runs) {
      expect(l.state, l.lens).toBe("failed");
      expect(l.reason).toContain("has no findings list");
    }
    expect(r.status.mayProceed).toBe(false);
  });

  it("carries a person's earlier decision on an AI finding into the next round, and an old answer is not taken for the new one", async () => {
    const root = await forgeChangeRoot();
    const rt = handoff(root);
    const r1 = await runCritic(root, CHANGE, { now: NOW, runtime: rt });
    for (const l of lensRuns(r1))
      await completeLensRun(root, await answer(root, rt, l), { now: LATER });
    const aiIds = new Set(
      (await roundMeta(root)).findings.filter((f) => f.layer === "ai").map((f) => f.id),
    );
    const ai = (await readRound(root, CHANGE, "plan", 1)).findings.find(
      (f) => aiIds.has(f.finding.id) && f.finding.kind === "issue",
    )!;
    await act(root, CHANGE, ai.finding.id, "not-relevant", {
      by: "dana",
      reason: "Not for us.",
      now: LATER,
    });

    const r2 = await runCritic(root, CHANGE, { now: LATER, runtime: rt });
    expect(r2.round).toBe(2);
    const again = lensRuns(r2).find((l) => l.lens === ai.finding.lens)!;
    // Round 1's answer is not round 2's: this run has no file yet.
    expect(await readdir(join(root, ".runs", CHANGE, again.runId!))).not.toContain(
      `findings-${again.lens}.yaml`,
    );
    const run2 = await answer(root, rt, again, await recordedAny(again));
    const c = await completeLensRun(root, run2, { now: LATER });
    expect(c.round).toBe(2);
    const carried = c.findings.find((f) => f.finding.id === ai.finding.id);
    expect(carried).toMatchObject({ carried: true });
    expect(carried!.finding).toMatchObject({ state: "dismissed" });
  });

  it("refuses a run that is not a waiting lens of a round, and one already read in", async () => {
    const root = await forgeChangeRoot();
    const rt = handoff(root);
    const r = await runCritic(root, CHANGE, { now: NOW, runtime: rt });
    const l = lensRuns(r)[0]!;
    const run = await answer(root, rt, l);
    await completeLensRun(root, run, { now: LATER });
    await expect(completeLensRun(root, run, { now: LATER })).rejects.toThrow(
      /The business lens of round 1 at the plan gate has already been read in/,
    );
    const other = { ...run, runId: "run-20261020090000-0099" };
    await expect(completeLensRun(root, other, { now: LATER })).rejects.toBeInstanceOf(CriticError);
    await expect(completeLensRun(root, other, { now: LATER })).rejects.toThrow(
      /No critic round of add-transfer-limit is waiting for run run-20261020090000-0099/,
    );
    const notALens = { ...run, request: { ...run.request, outputPath: "stories.md" } };
    await expect(completeLensRun(root, notALens, { now: LATER })).rejects.toThrow(
      /isn't a critic lens review/,
    );
  });

  it("knows a lens review's output path", () => {
    const run = (outputPath: string, outputIn?: "run" | "change") => ({ outputPath, outputIn });
    expect(lensRunOf(run("findings-architecture.yaml", "run"))).toBe("architecture");
    expect(lensRunOf(run("findings-code-and-test.yaml", "run"))).toBe("code-and-test");
    expect(lensRunOf(run("findings-nothing.yaml", "run"))).toBeUndefined();
    expect(lensRunOf(run("findings-architecture.yaml"))).toBeUndefined();
    expect(lensRunOf(run("tasks/1.2/review-code-and-test.yaml"))).toBeUndefined();
    expect(lensRunOf(run("stories.md"))).toBeUndefined();
  });

  it("keeps a stage's draft from the lenses while an artifact fails layer 1 (ADR 0115)", async () => {
    const root = await forgeChangeRoot();
    await writeFile(join(changeDir(root), "feature.md"), "# Feature\n\nA draft placement.\n");
    const r = await runCritic(root, CHANGE, {
      now: NOW,
      runtime: handoff(root),
      review: {
        stage: "feature",
        files: ["feature.md", "../outside.md"],
        sources: [
          {
            id: "estate-index",
            kind: "catalog",
            origin: "atticus",
            text: "flow x",
            classification: "internal",
          },
        ],
      },
    });
    // The fixture's artifacts have blocking layer-1 findings: fix those first.
    expect(r.failedLayer1.length).toBeGreaterThan(0);
    for (const l of lensRuns(r)) expect(l.artifacts).not.toContain("feature.md");
    const prompt = await readFile(
      join(root, ".runs", CHANGE, lensRuns(r)[0]!.runId!, "prompt.md"),
      "utf8",
    );
    expect(prompt).not.toContain("Review the draft against the estate and the brief");
  });
});

/** A lens's only recording, for a round whose prompt differs from the recorded one. */
async function recordedAny(l: LensRun): Promise<string> {
  const dir = join(RECORDINGS, l.agent);
  const [file] = await readdir(dir);
  return (JSON.parse(await readFile(join(dir, file!), "utf8")) as { output: string }).output;
}
