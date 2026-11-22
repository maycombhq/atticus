import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { MockRuntime, type AiRequest } from "@maycombhq/ai";
import { changeStore, checkFindings, loadChangeContext } from "@maycombhq/changes";
import {
  assistantNames,
  checkRoundState,
  gateStatus,
  recordedFacts,
  runCritic,
  type StoredFinding,
} from "../src/index.js";
import { CHANGE, NOW, forgeChangeRoot, write } from "./helpers.js";

/**
 * ADR 0203 A.4, the second review: Atticus's own agents and the org pack's persona files are
 * assistants on every path that reads a resolution, not only where a person acts. A waiver
 * written by hand into a finding's file by one of them closes nothing: the gate still blocks, the
 * lenses don't read it as recorded by people, and it is no person acting since the round ran.
 * Invented Forge names.
 */

const LATER = "2026-10-21T10:00:00Z";
const REASON = "Handled by the drafter, not a person.";

async function waivedBy(by: string) {
  const root = await forgeChangeRoot();
  await write(
    root,
    "org-pack/agents/ledger-architect.md",
    "---\nname: ledger-architect\n---\nW.\n",
  );
  await runCritic(root, CHANGE, { now: NOW, gate: "plan" });
  const s = await gateStatus(root, CHANGE, "plan");
  // An org rule's blocking finding a person may waive, as a lens would have raised it.
  const like = s.findings.find((f: StoredFinding) => f.finding.severity === "blocking")!.finding;
  const blocking = {
    ...like,
    id: "design-concurrency-handled-design-l4",
    rule: "design-concurrency-handled",
    layer: "org" as const,
    waivable: true,
    summary: "Two transfers on one account at once aren't said to be serialised.",
  };
  await write(
    root,
    join("openspec/changes", CHANGE, `review/plan/${blocking.round}`, `${blocking.id}.yaml`),
    stringify({
      ...blocking,
      state: "waived",
      resolution: { action: "waive", by, at: LATER, reason: REASON },
    }),
  );
  return { root, blocking };
}

describe.each(["feature-placer", "ledger-architect", "judge", "forge-ledger-naysayer"])(
  "a waiver %s wrote by hand",
  (by) => {
    it("still blocks the gate, on the lifecycle's reading and the critic's", async () => {
      const { root, blocking } = await waivedBy(by);
      const s = await gateStatus(root, CHANGE, "plan");
      expect(s.reasons.filter((x) => x.includes(blocking.id))).toHaveLength(1);
      const change = await changeStore(root).read(CHANGE);
      const known = assistantNames(await loadChangeContext(root));
      expect((await checkFindings(root, change, ["plan"], known)).map((r) => r.finding)).toContain(
        blocking.id,
      );
      expect((await checkRoundState(root, CHANGE, "plan", known)).actedOn).not.toContain(
        blocking.id,
      );
    });

    it("is not what people recorded, for the lenses of a later round", async () => {
      const { root } = await waivedBy(by);
      const known = assistantNames(await loadChangeContext(root));
      expect(await recordedFacts(root, CHANGE, known)).toEqual([]);
      const prompts: string[] = [];
      await runCritic(root, CHANGE, {
        now: LATER,
        gate: "plan",
        runtime: new MockRuntime((q: AiRequest) => {
          prompts.push(q.pack.prompt);
          return "findings: []\n";
        }),
      });
      expect(prompts.length).toBeGreaterThan(0);
      for (const p of prompts) expect(p).not.toContain(REASON);
    });
  },
);

describe("a person's waiver, for contrast", () => {
  it("is what people recorded", async () => {
    const { root } = await waivedBy("pat");
    expect((await recordedFacts(root, CHANGE)).map((f) => f.by)).toEqual(["pat"]);
  });
});
