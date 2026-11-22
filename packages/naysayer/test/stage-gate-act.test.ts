import { describe, expect, it } from "vitest";
import { Finding } from "@maycombhq/core";
import {
  act,
  CriticError,
  readRound,
  roundsOf,
  stageGateOf,
  writeGateRound,
} from "../src/index.js";
import { CHANGE, NOW, forgeChangeRoot } from "./helpers.js";

/**
 * ADR 0203 A (the second whole-release review of beta.30): a stage's own finding, on the gate
 * `stage-<stage>`, is settled only by fixing the draft or by a person accepting it (`waive`). A
 * dismissal, a fix marked applied or an Ask closed the finding's file but not the stage: the
 * stage reads only acceptances (readAccepted), the gate carries the state by id into every later
 * round, and the finding could then never be accepted ("already dismissed"), so the stage stayed
 * blocked for good. Each is refused now, before anything is written, with the way on the
 * finding's own fix gives. Invented Forge names.
 */

const LATER = "2026-10-21T10:00:00Z";
const GATE = stageGateOf("architecture");

/** A stage finding as the planner projects it (accept.ts stageFinding): no patch, only words. */
const stageFinding = (id: string, rule: string, waivable: boolean): Finding =>
  Finding.parse({
    schemaVersion: 1,
    id,
    kind: "issue",
    change: CHANGE,
    gate: GATE,
    round: 1,
    rule,
    layer: "org",
    lens: "true",
    severity: "blocking",
    artifact: "target-flows/",
    locator: { heading: "forge-ledger.post-transfer#1" },
    summary: `Finding of ${rule}.`,
    why: `Finding of ${rule}, in words.`,
    fix: {
      text: waivable
        ? `Fix target-flows/ and run atticus change architecture ${CHANGE} again. Or accept it: atticus finding ${CHANGE} ${id} waive --reason "<why>".`
        : `Fix target-flows/ and run atticus change architecture ${CHANGE} again. It can't be accepted: archive it in the manifest or take it out of the draft.`,
    },
    evidence: [{ source: "artifact", path: "target-flows/" }],
    waivable,
    state: "open",
    createdAt: NOW,
  });

const ACCEPTABLE = stageFinding("stage-0123456789ab", "delta.new-folder", true);
const NOT_ACCEPTABLE = stageFinding("stage-ba9876543210", "feature.archived-repo", false);

async function rootWithGate() {
  const root = await forgeChangeRoot();
  await writeGateRound(root, CHANGE, GATE, [ACCEPTABLE, NOT_ACCEPTABLE], NOW, { carryById: true });
  return root;
}

const newest = async (root: string) => {
  const n = (await roundsOf(root, CHANGE, GATE)).at(-1)!;
  return (await readRound(root, CHANGE, GATE, n)).findings.map((s) => s.finding);
};

const refusal = (e: unknown) => {
  expect(e).toBeInstanceOf(CriticError);
  expect((e as CriticError).code).toBe("refused");
  return (e as CriticError).message;
};

describe("a stage's own finding is settled by a fix to the draft or an acceptance, nothing else", () => {
  it.each([
    ["not-relevant", { reason: "Not in this release" }],
    ["apply", {}],
    ["edit-and-apply", { reason: "Fixed the folder by hand" }],
    ["ask", { askedOf: "architect" }],
  ] as const)("refuses %s on an acceptable one, naming Accept", async (action, extra) => {
    const root = await rootWithGate();
    const said = refusal(
      await act(root, CHANGE, ACCEPTABLE.id, action, { by: "pat", now: LATER, ...extra }).catch(
        (e: unknown) => e,
      ),
    );
    expect(said).toBe(
      `${ACCEPTABLE.id} is the architecture stage's own finding: only a fix to the draft or a person's acceptance settles it, so it can't be ${
        action === "not-relevant"
          ? "dismissed as not relevant"
          : action === "ask"
            ? "asked of someone"
            : "marked applied"
      }. ${ACCEPTABLE.fix.text}`,
    );
    // Nothing written: the finding is open, and a person can still accept it.
    expect((await newest(root)).map((f) => [f.id, f.state])).toEqual([
      [ACCEPTABLE.id, "open"],
      [NOT_ACCEPTABLE.id, "open"],
    ]);
    const r = await act(root, CHANGE, ACCEPTABLE.id, "waive", {
      by: "pat",
      reason: "The folder is new on purpose",
      now: LATER,
    });
    expect(r.finding.state).toBe("waived");
  });

  it("refuses not-relevant on one that can't be accepted, naming the fix to the draft", async () => {
    const root = await rootWithGate();
    const said = refusal(
      await act(root, CHANGE, NOT_ACCEPTABLE.id, "not-relevant", {
        by: "pat",
        reason: "Archived on purpose",
        now: LATER,
      }).catch((e: unknown) => e),
    );
    expect(said).toBe(
      `${NOT_ACCEPTABLE.id} is the architecture stage's own finding: only a fix to the draft or a person's acceptance settles it, so it can't be dismissed as not relevant. ${NOT_ACCEPTABLE.fix.text}`,
    );
  });

  it("leaves the finding open across the stage's next run, where a dismissal stranded it", async () => {
    const root = await rootWithGate();
    await act(root, CHANGE, ACCEPTABLE.id, "not-relevant", {
      by: "pat",
      reason: "Not in this release",
      now: LATER,
    }).catch(() => undefined);
    // The stage runs again with the same draft: the gate is written again, by id.
    await writeGateRound(root, CHANGE, GATE, [ACCEPTABLE, NOT_ACCEPTABLE], LATER, {
      carryById: true,
    });
    expect((await newest(root)).find((f) => f.id === ACCEPTABLE.id)?.state).toBe("open");
  });

  it("keeps every action on a critic gate's finding as it was", async () => {
    const root = await forgeChangeRoot();
    const plain = Finding.parse({
      ...ACCEPTABLE,
      id: "f-plan-1",
      gate: "plan",
      fix: { text: "Say it." },
    });
    await writeGateRound(root, CHANGE, "plan", [plain], NOW);
    const r = await act(root, CHANGE, plain.id, "not-relevant", {
      by: "pat",
      reason: "Not in this release",
      now: LATER,
    });
    expect(r.finding.state).toBe("dismissed");
  });
});
