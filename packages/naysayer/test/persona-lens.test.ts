import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HandoffRuntime, MockRuntime, type AiRequest } from "@maycombhq/ai";
import {
  changeStore,
  checkFindings,
  loadChangeContext,
  phaseFindingGates,
  phaseGates,
} from "@maycombhq/changes";
import {
  completeLensRun,
  gateStatus,
  lastReviewed,
  personaLenses,
  readRound,
  readRoundMeta,
  roundsOf,
  runCritic,
  sinceReview,
  waitingLenses,
} from "../src/index.js";
import { CHANGE, NOW, forgeChangeRoot } from "./helpers.js";

/**
 * ADR 0203 C: a persona's naysayer as a lens of the critic. One naysayer of the Forge org pack
 * whose frontmatter says `gates: [plan]` runs at the plan gate after the four questions, through
 * the same code; its finding is a risk with lens persona and its name, and never holds the gate.
 * With no `gates` it never runs. A mock model; no network.
 */

const NAYSAYER = "ledger-architect-naysayer";
const naysayer = (gates?: string) => `---
name: ${NAYSAYER}
description: Asks what the "Ledger architect" section got wrong or left out.
role: architect
owns: Ledger architect
${gates ? `gates: ${gates}\n` : ""}---

You are the ledger architect's naysayer. Ask who else reads the account's daily limit, and what
happens to a transfer that is refused half way through the velocity check.
`;

/** The design's line a persona's finding quotes. */
const QUOTED = "ledger-api sums today's outgoing entries for the account inside the transfer";

async function root(gates?: string) {
  const r = await forgeChangeRoot();
  await writeFile(join(r, "org-pack/agents", `${NAYSAYER}.md`), naysayer(gates));
  return r;
}

/** Every lens finds nothing but the naysayer, which asks one question with its quote. */
function model(asked: string[]) {
  return new MockRuntime(
    (req: AiRequest) => {
      asked.push(req.agent.id);
      if (req.agent.id !== NAYSAYER) return "findings: []\n";
      return [
        "findings:",
        `  - rule: persona.${NAYSAYER}`,
        "    kind: issue",
        "    artifact: design.md",
        "    locator: { line: 5 }",
        "    summary: Nothing says who else reads the daily limit.",
        "    why: Another reader would see a limit the transfer already passed.",
        "    fix: Name every reader of account.daily_limit.",
        "    evidence:",
        `      - { path: design.md, line: 5, quote: "${QUOTED}" }`,
        "",
      ].join("\n");
    },
    { now: () => new Date(NOW) },
  );
}

describe("a persona's naysayer with gates runs as a lens", () => {
  it("runs at its gate after the four questions; its finding is a risk with lens persona and its name", async () => {
    const r = await root("[plan]");
    const design = await readFile(join(r, "openspec/changes", CHANGE, "design.md"), "utf8");
    expect(design.split("\n")[4]).toContain(QUOTED);
    const asked: string[] = [];
    const out = await runCritic(r, CHANGE, { now: NOW, runtime: model(asked), gate: "plan" });
    // After the four questions, once.
    expect(asked.at(-1)).toBe(NAYSAYER);
    expect(asked.filter((a) => a === NAYSAYER)).toHaveLength(1);
    const lens = out.lenses.find((l) => l.agent === NAYSAYER)!;
    expect(lens).toMatchObject({ state: "ran", persona: NAYSAYER, rules: [`persona.${NAYSAYER}`] });
    const round = (await roundsOf(r, CHANGE, "plan")).at(-1)!;
    const found = (await readRound(r, CHANGE, "plan", round)).findings
      .map((s) => s.finding)
      .filter((f) => f.rule === `persona.${NAYSAYER}`);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      lens: "persona",
      persona: NAYSAYER,
      severity: "risk",
      layer: "org",
      waivable: false,
      summary: "Nothing says who else reads the daily limit.",
    });
    // The round records the lens by the persona's name.
    const meta = await readFile(
      join(r, "openspec/changes", CHANGE, "review/plan", String(round), "meta/round.yaml"),
      "utf8",
    );
    expect(meta).toContain(`lens: ${NAYSAYER}`);
    // A risk never holds the gate: what blocks is the other rules' findings, and only those.
    const all = (await readRound(r, CHANGE, "plan", round)).findings.map((s) => s.finding);
    const s = await gateStatus(r, CHANGE, "plan");
    expect(s.open.blocking).toBe(
      all.filter((f) => f.severity === "blocking" && f.lens !== "persona").length,
    );
  });

  it("with no gates it never runs, and a gate gates.yaml lacks is said in the round's notes", async () => {
    const quiet: string[] = [];
    await runCritic(await root(), CHANGE, { now: NOW, runtime: model(quiet), gate: "plan" });
    expect(quiet).not.toContain(NAYSAYER);

    const elsewhere: string[] = [];
    const r = await root("[plan, nowhere]");
    const out = await runCritic(r, CHANGE, {
      now: NOW,
      runtime: model(elsewhere),
      gate: "design",
    });
    expect(elsewhere).not.toContain(NAYSAYER);
    expect(out.problems).toContain(
      `${NAYSAYER} gives gate nowhere, which gates.yaml doesn't have, so it never runs there.`,
    );
  });

  it("reads only the org pack's own naysayers, never another team's imported agents", async () => {
    const r = await root("[plan]");
    const all = await personaLenses(r, 1000);
    expect(all.map((p) => [p.name, p.gates, p.owns])).toEqual([
      [NAYSAYER, ["plan"], "Ledger architect"],
    ]);
    expect(all[0]!.rule).toMatchObject({
      id: `persona.${NAYSAYER}`,
      severity: "risk",
      layer: "org",
      persona: NAYSAYER,
    });
    expect(all[0]!.agent.id).toBe(NAYSAYER);
  });
});

/** The naysayer's answer, as its assistant writes it. */
const ASKED = [
  "findings:",
  `  - rule: persona.${NAYSAYER}`,
  "    kind: issue",
  "    artifact: design.md",
  "    locator: { line: 5 }",
  "    summary: Nothing says who else reads the daily limit.",
  "    why: Another reader would see a limit the transfer already passed.",
  "    fix: Name every reader of account.daily_limit.",
  "    evidence:",
  `      - { path: design.md, line: 5, quote: "${QUOTED}" }`,
  "",
].join("\n");

describe("a persona lens never holds a gate (ADR 0203 C, the owner's decision of 2026-11-21)", () => {
  it("handed to the assistant and not answered, it holds nothing: the gate, the lifecycle and the stage don't wait", async () => {
    const r = await root("[plan]");
    const rt = new HandoffRuntime({ root: r, validate: async () => [], now: () => new Date(NOW) });
    const out = await runCritic(r, CHANGE, { now: NOW, runtime: rt, gate: "plan" });
    const persona = out.lenses.find((l) => l.persona === NAYSAYER)!;
    expect(persona).toMatchObject({ state: "waiting" });
    // Answer the four questions; leave the persona with the assistant.
    for (const l of out.lenses.filter((x) => x.state === "waiting" && !x.persona)) {
      await writeFile(
        join(r, ".runs", CHANGE, l.runId!, `findings-${l.lens}.yaml`),
        "findings: []\n",
      );
      await completeLensRun(r, await rt.done(l.runId!), { now: NOW });
    }
    const s = await gateStatus(r, CHANGE, "plan");
    expect(s.waiting).toEqual([]);
    expect(s.reasons.join("\n")).not.toContain(NAYSAYER);
    const change = await changeStore(r).read(CHANGE);
    expect((await checkFindings(r, change, ["plan"])).map((x) => x.code)).not.toContain(
      "lens-waiting",
    );
    // What a stage waits on: none.
    expect(await waitingLenses(r, CHANGE, "plan")).toEqual([]);
    // It is still on file, so its answer can be read in when it comes.
    const meta = await readRoundMeta(r, CHANGE, "plan", 1);
    expect(meta?.lenses.find((l) => l.runId === persona.runId)).toMatchObject({
      lens: NAYSAYER,
      state: "waiting",
      persona: NAYSAYER,
    });
  });

  it("an answer that comes after the gate moved on is read into the newest round, never dropped", async () => {
    const r = await root("[plan]");
    const rt = new HandoffRuntime({ root: r, validate: async () => [], now: () => new Date(NOW) });
    const first = await runCritic(r, CHANGE, { now: NOW, runtime: rt, gate: "plan" });
    const persona = first.lenses.find((l) => l.persona === NAYSAYER)!;
    // A new round runs at the gate before the persona's assistant answers.
    const asked: string[] = [];
    const quiet = new MockRuntime(
      (q: AiRequest) => {
        asked.push(q.agent.id);
        return "findings: []\n";
      },
      { now: () => new Date(NOW) },
    );
    await runCritic(r, CHANGE, { now: "2026-10-21T09:00:00Z", runtime: quiet, gate: "plan" });
    expect((await roundsOf(r, CHANGE, "plan")).at(-1)).toBe(2);
    // The late answer.
    await writeFile(join(r, ".runs", CHANGE, persona.runId!, `findings-${NAYSAYER}.yaml`), ASKED);
    const done = await completeLensRun(r, await rt.done(persona.runId!), {
      now: "2026-10-21T10:00:00Z",
    });
    expect(done.findings.map((f) => f.finding.rule)).toEqual([`persona.${NAYSAYER}`]);
    // In the gate's newest round, where every reader looks.
    const newest = (await readRound(r, CHANGE, "plan", 2)).findings.map((x) => x.finding);
    expect(newest.filter((f) => f.lens === "persona")).toEqual([
      expect.objectContaining({
        persona: NAYSAYER,
        severity: "risk",
        round: 2,
        summary: "Nothing says who else reads the daily limit.",
      }),
    ]);
    expect(
      (await gateStatus(r, CHANGE, "plan")).findings.some((x) => x.finding.lens === "persona"),
    ).toBe(true);
  });
});

describe("a redraft carries a persona's finding only while its lens runs (ADR 0203 C)", () => {
  it("drops it once the persona's naysayer no longer runs at the gate, and carries it while it does", async () => {
    const r = await root("[plan]");
    await runCritic(r, CHANGE, { now: NOW, runtime: model([]), gate: "plan" });
    const last = (await lastReviewed(r, CHANGE, "plan", 2))!;
    expect(last.round).toBe(1);
    const scope = (personas: string[]) =>
      sinceReview(r, {
        change: CHANGE,
        gate: "plan",
        round: 2,
        now: "2026-10-21T09:00:00Z",
        texts: last.texts,
        questions: ["true", "complete", "safe", "ship"],
        personas,
      });
    const carried = async (personas: string[]) =>
      ((await scope(personas))?.carry ?? []).filter((f) => f.lens === "persona");
    expect((await carried([NAYSAYER])).map((f) => f.persona)).toEqual([NAYSAYER]);
    expect(await carried([])).toEqual([]);
    expect(await carried(["another-naysayer"])).toEqual([]);
  });
});

describe("the stages' gate names are kept for them (ADR 0203 A.1)", () => {
  it("refuses a gates.yaml gate named stage-<x>", async () => {
    const r = await forgeChangeRoot();
    const file = join(r, "org-pack/gates.yaml");
    const text = await readFile(file, "utf8");
    await writeFile(
      file,
      text.replace(
        "gates:\n",
        "gates:\n  - id: stage-architecture\n    phase: design\n    approvers: [architect]\n",
      ),
    );
    await expect(runCritic(r, CHANGE, { now: NOW, gate: "stage-architecture" })).rejects.toThrow(
      "Gate stage-architecture in gates.yaml has a name Atticus keeps for a stage's own findings (stage-<stage>, ADR 0203): rename it in org-pack/gates.yaml.",
    );
    // Said when the org pack is read, and no phase reads that gate's findings as its own.
    const ctx = await loadChangeContext(r);
    expect(ctx.problems).toContain(
      "org-pack/gates.yaml: stage-architecture.id: stage-architecture is a name Atticus keeps for a stage's own findings (stage-<stage>, ADR 0203): rename the gate.",
    );
    expect(phaseGates(ctx, "design")).not.toContain("stage-architecture");
    expect(phaseFindingGates(ctx, "design")).not.toContain("stage-architecture");
  });
});
