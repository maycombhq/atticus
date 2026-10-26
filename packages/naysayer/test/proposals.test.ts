import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { checkFindings } from "@maycombhq/changes";
import { changeStore } from "@maycombhq/changes";
import { Finding } from "@maycombhq/core";
import {
  act,
  gateStatus,
  readProposals,
  recordedFacts,
  runCritic,
  type StoredFinding,
} from "../src/index.js";
import { CHANGE, NOW, changeDir, forgeChangeRoot, readText, write } from "./helpers.js";

/**
 * ADR 0115 addendum (2026-10-25, finding integrity). A live run's drafting assistant dismissed the
 * critic's finding itself (`resolution.by: claude`, not-relevant). Now an assistant, the drafter
 * included, can only propose that a blocking or risk finding is not relevant or fixed, with a
 * reason: the finding stays open, "proposed by the assistant, waiting on a person", until a
 * person's resolution closes it. A waiver is a person's only.
 */

const LATER = "2026-10-21T10:00:00Z";

async function plan(root: string) {
  await runCritic(root, CHANGE, { now: NOW });
  return gateStatus(root, CHANGE, "plan");
}
const first = (fs: StoredFinding[], severity: string) =>
  fs.find((f) => f.finding.severity === severity && f.finding.state === "open")!.finding;

describe("an assistant's resolution of a blocking or risk finding is a proposal", () => {
  it("keeps a blocking finding open when the drafter says not relevant, and a person's answer closes it", async () => {
    const root = await forgeChangeRoot();
    const blocking = first((await plan(root)).findings, "blocking");
    const r = await act(root, CHANGE, blocking.id, "not-relevant", {
      by: "claude",
      reason: "The rule doesn't apply to a read.",
      now: LATER,
    });
    expect(r.finding.state).toBe("open");
    expect(r.proposed).toMatchObject({ claim: "not-relevant", by: "claude" });
    expect(r.message).toContain(
      "proposed by the assistant (claude) as not relevant, waiting on a person",
    );
    // The finding file is untouched: C3's shape, still open, no resolution.
    const file = Finding.parse(parse(await readText(join(changeDir(root), r.path))));
    expect(file.state).toBe("open");
    expect(file.resolution).toBeUndefined();
    const s = await gateStatus(root, CHANGE, "plan");
    expect(s.mayProceed).toBe(false);
    expect(s.findings.find((f) => f.finding.id === blocking.id)!.proposal).toMatchObject({
      claim: "not-relevant",
      by: "claude",
      reason: "The rule doesn't apply to a read.",
    });
    expect(s.reasons.join("\n")).toContain(
      `${blocking.id} is proposed by the assistant (claude) as not relevant, waiting on a person`,
    );
    // The assistant's words are never "recorded by people" for the lenses.
    expect(await recordedFacts(root, CHANGE)).toEqual([]);

    // A person takes the proposal: with no reason of their own, the assistant's is kept, saying so.
    const decided = await act(root, CHANGE, blocking.id, "not-relevant", { by: "pat", now: LATER });
    expect(decided.finding.state).toBe("dismissed");
    expect(decided.finding.resolution).toMatchObject({
      by: "pat",
      reason: "The rule doesn't apply to a read. (proposed by claude; accepted by pat)",
    });
    expect(await readProposals(root, CHANGE, "plan", blocking.round)).toEqual([]);
    const after = await gateStatus(root, CHANGE, "plan");
    expect(after.findings.find((f) => f.finding.id === blocking.id)!.proposal).toBeUndefined();
  });

  it("refuses an assistant's waiver: only a person waives", async () => {
    const root = await forgeChangeRoot();
    const s = await plan(root);
    const blocking = first(s.findings, "blocking");
    await expect(
      act(root, CHANGE, blocking.id, "waive", { by: "copilot", reason: "Later." }),
    ).rejects.toThrow(/copilot is an assistant: only a person waives a finding/);
  });

  it("records an assistant's fix of a risk as claimed, for the next lens round to check", async () => {
    const root = await forgeChangeRoot();
    const risk = first((await plan(root)).findings, "risk");
    const r = await act(root, CHANGE, risk.id, "edit-and-apply", {
      by: "claude-code",
      reason: "Added a rollback line.",
      now: LATER,
    });
    expect(r.finding.state).toBe("open");
    expect(r.proposed).toMatchObject({ claim: "fixed", by: "claude-code" });
    expect(r.message).toContain("The next critic round checks the fix");
  });

  it("lets an assistant close what isn't blocking or a risk (an idea), as before", async () => {
    const root = await forgeChangeRoot();
    const s = await plan(root);
    const idea = s.findings.find(
      (f) => f.finding.severity === "idea" && f.finding.state === "open",
    );
    if (!idea) return;
    const r = await act(root, CHANGE, idea.finding.id, "not-relevant", {
      by: "claude",
      reason: "A note only.",
    });
    expect(r.finding.state).toBe("dismissed");
  });

  it("treats a finding an assistant dismissed before this rule as still open", async () => {
    const root = await forgeChangeRoot();
    const blocking = first((await plan(root)).findings, "blocking");
    const path = join(changeDir(root), "review/plan/1", `${blocking.id}.yaml`);
    // As a live run left it: dismissed, by the drafting assistant.
    await write(
      root,
      join("openspec/changes", CHANGE, "review/plan/1", `${blocking.id}.yaml`),
      stringify({
        ...blocking,
        state: "dismissed",
        resolution: { action: "not-relevant", by: "claude", at: LATER, reason: "Not ours." },
      }),
    );
    expect(Finding.parse(parse(await readText(path))).state).toBe("dismissed");
    const change = await changeStore(root).read(CHANGE);
    expect((await checkFindings(root, change, ["plan"])).map((r) => r.finding)).toContain(
      blocking.id,
    );
    expect(await recordedFacts(root, CHANGE)).toEqual([]);
    // The next round doesn't carry the assistant's dismissal; a person may still decide it.
    const next = await runCritic(root, CHANGE, { now: LATER });
    const again = next.findings.find(
      (f) => f.finding.rule === blocking.rule && f.finding.artifact === blocking.artifact,
    )!;
    expect(again.finding.state).toBe("open");
    expect(again.carried).toBe(false);
  });

  it("carries a not-relevant proposal to the next round while the finding stands", async () => {
    const root = await forgeChangeRoot();
    const blocking = first((await plan(root)).findings, "blocking");
    await act(root, CHANGE, blocking.id, "not-relevant", { by: "claude", reason: "Not ours." });
    const next = await runCritic(root, CHANGE, { now: LATER });
    const again = next.findings.find(
      (f) => f.finding.rule === blocking.rule && f.finding.artifact === blocking.artifact,
    )!;
    expect(again.finding.state).toBe("open");
    expect(await readProposals(root, CHANGE, "plan", next.round)).toEqual([
      expect.objectContaining({ finding: again.finding.id, claim: "not-relevant", by: "claude" }),
    ]);
  });
});
