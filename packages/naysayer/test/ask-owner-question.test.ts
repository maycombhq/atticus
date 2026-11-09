import { describe, expect, it } from "vitest";
import { answerQuestion, askedGapQuestionId, readQuestion } from "@maycombhq/core";
import { act, gateStatus, runCritic } from "../src/index.js";
import { CHANGE, NOW, forgeChangeRoot } from "./helpers.js";

const LATER = "2026-10-21T10:00:00Z";
const GAP = "gap-slo-known-ledger";

/**
 * Ninth UX walk: Ask on a knowledge gap raised no question anybody could answer, and the gate then
 * passed with the gap unanswered. Ask now writes an owner question for the team it is asked of,
 * linked to the gap; the gate waits for its answer, and a person's answer closes the gap there.
 */
describe("Ask on a knowledge gap", () => {
  it("raises an owner question for the team, and the gate waits for its answer", async () => {
    const root = await forgeChangeRoot();
    await runCritic(root, CHANGE, { now: NOW, gate: "design" });
    const asked = await act(root, CHANGE, GAP, "ask", { by: "ari", now: NOW });
    const team = asked.finding.resolution!.askedOf!;
    expect(asked.question).toBe(askedGapQuestionId(CHANGE, asked.finding));
    expect(asked.message).toContain(asked.question);
    expect(asked.message).not.toMatch(/stops blocking/);
    const q = (await readQuestion(root, asked.question!))!;
    expect(q).toMatchObject({
      state: "open",
      repo: CHANGE,
      askedOf: team,
      finding: { change: CHANGE, gate: "design", round: 1, id: GAP },
      question: asked.finding.question!.text,
    });
    expect(q.evidence[0]).toMatch(new RegExp(`^openspec/changes/${CHANGE}/.+:\\d+$`));

    const waiting = await gateStatus(root, CHANGE, "design");
    expect(waiting.reasons.filter((r) => r.includes(GAP))).toEqual([
      expect.stringContaining(`asked of ${team}`),
    ]);

    // Carried to a later gate, the gap finds the same question, and waits there too.
    await runCritic(root, CHANGE, { now: LATER, gate: "plan" });
    expect((await gateStatus(root, CHANGE, "plan")).reasons.some((r) => r.includes(GAP))).toBe(
      true,
    );

    await answerQuestion(root, asked.question!, {
      text: "99.9% over 30 days",
      by: "tia",
      at: LATER,
    });
    expect((await gateStatus(root, CHANGE, "design")).reasons.some((r) => r.includes(GAP))).toBe(
      false,
    );
    expect((await gateStatus(root, CHANGE, "plan")).reasons.some((r) => r.includes(GAP))).toBe(
      false,
    );
  });
});
