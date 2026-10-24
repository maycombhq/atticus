import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canAdvance,
  changeReport,
  DEFAULT_CHANGE_POLICY,
  handoff,
  newChange,
  stagePathOf,
  syncHandoff,
} from "../src/index.js";
import { FEATURE_OWNERS, REPO, approval, copyPhase, forgeMetarepo, host } from "./helpers.js";

/**
 * A change on the stage path (ADR 0087: feature → architecture → stories) is checked against
 * the files its stages write and the loop state each stage keeps, not the change-draft
 * artifacts (proposal.md, specs/) the stages never write. Found on a real metarepo: `change
 * status` said "proposal.md is missing" after the feature stage was done.
 */

const ID = "add-transfer-limit";
const T = (h: string) => `2026-10-19T${h}:00Z`;

async function featureChange(root: string): Promise<void> {
  await newChange(root, {
    title: "Add transfer limit",
    type: "feature",
    by: "pat",
    owners: FEATURE_OWNERS,
    systems: ["ledger", "portal"],
    now: T("09:00"),
  });
}

const codes = (rs: { code: string }[]) => rs.map((r) => r.code);
const words = (rs: { message: string }[]) => rs.map((r) => r.message).join("\n");

describe("a change on the stage path", () => {
  it("is ready to hand off define once the feature stage is done, with no proposal or spec", async () => {
    const root = await forgeMetarepo();
    await featureChange(root);
    await copyPhase(root, ID, `${ID}/stages/define`);
    const r = await changeReport(root, ID);
    expect(r.state).toBe("define");
    expect(words(r.blockers)).not.toContain("proposal.md");
    expect(words(r.blockers)).not.toContain("spec.md");
    expect(r.blockers).toEqual([]);
    expect(r.nextStep).toBe('Ready to raise "Send to architecture".');
    const ready = await canAdvance(ID, root);
    expect(codes(ready.reasons)).toEqual(["no-handoff"]);
  });

  it("says which stage isn't done, and its command, while the stage's loop is still going", async () => {
    const root = await forgeMetarepo();
    await featureChange(root);
    await copyPhase(root, ID, `${ID}/stages/define`);
    await writeFile(
      join(root, "openspec/changes", ID, "stage/feature.yaml"),
      "schemaVersion: 1\nchange: add-transfer-limit\nstage: feature\niteration: 3\nstate: stopped\nupdatedAt: 2026-10-19T10:00:00Z\n",
    );
    const r = await changeReport(root, ID);
    expect(codes(r.blockers)).toEqual(["stage-not-done"]);
    expect(r.blockers[0]!.message).toBe(
      "The feature stage stopped and isn't done: see what stopped it, then run atticus change feature add-transfer-limit again.",
    );
  });

  it("carries the stage's files in its hand-off PR, and at design follows the architecture stage", async () => {
    const root = await forgeMetarepo();
    const gh = host();
    await featureChange(root);
    await copyPhase(root, ID, `${ID}/stages/define`);
    const h = await handoff(root, ID, {
      gitHost: gh,
      repo: REPO,
      by: "pat",
      approval: approval("pat", T("10:00")),
      now: T("10:00"),
    });
    const files = h.artifacts.map((a) => a.path);
    expect(files).toEqual(
      expect.arrayContaining(["brief.md", "feature.md", "feature.yaml", "stage/feature.yaml"]),
    );
    gh.review(REPO, 1, "ari", "approved");
    await syncHandoff(root, ID, {
      gitHost: gh,
      repo: REPO,
      approval: approval("pat", T("11:00")),
      now: T("11:00"),
    });
    // At design: the architecture stage stopped (its gate's rounds used up, say).
    await copyPhase(root, ID, `${ID}/stages/design`);
    const r = await changeReport(root, ID);
    expect(r.state).toBe("design");
    const blockers = words(r.blockers);
    for (const old of ["interfaces.md", "mappings.md", "ux.md"])
      expect(blockers).not.toContain(old);
    expect(blockers).toContain(
      "The architecture stage stopped and isn't done: see what stopped it, then run atticus change architecture add-transfer-limit again.",
    );
  });

  it("is read from the change policy, so an org pack can name its own stages and files", () => {
    const path = stagePathOf(DEFAULT_CHANGE_POLICY);
    expect(path.map((s) => [s.stage, s.phase, s.loop])).toEqual([
      ["feature", "define", "stage/feature.yaml"],
      ["architecture", "design", "stage/architecture.yaml"],
      ["stories", "plan", "stage/stories.yaml"],
    ]);
  });

  it("leaves a change on the change-draft path as it was: proposal and spec are due", async () => {
    const root = await forgeMetarepo();
    await featureChange(root);
    const r = await changeReport(root, ID);
    expect(words(r.blockers)).toContain("proposal.md");
    expect(codes(r.blockers)).not.toContain("stage-not-done");
  });
});
