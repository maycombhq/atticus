import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FlowDelta, loadEstate, renderArchitecture } from "../src/index.js";

/**
 * Sixth UX walk: a change that writes no table got a design.md with no "Rollout and rollback",
 * though the design artifact's instruction (Atticus's OpenSpec schema) says design.md covers it
 * and the release plan asks for it. It is written every time now: with no table to undo, it
 * says a redeploy of each repo's previous version, in reverse order, undoes the change.
 */
describe("design.md's Rollout and rollback", () => {
  it("is written for a change that writes no table, saying how a redeploy undoes it", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-rollback-"));
    const e = await loadEstate(root, []);
    const d = FlowDelta.parse({
      schemaVersion: 1,
      flow: "ledger.read-status",
      repo: "forge-ledger",
      change: "new",
      name: "Ledger answers an account's status",
      why: "The ledger has no read of the status.",
      steps: [{ op: "add", after: 0, kind: "respond", what: "Returns the status." }],
    });
    const md = renderArchitecture([d], e);
    expect(md).toContain(
      "## Rollout and rollback\n\nThe change writes and alters no table, so it has nothing to migrate back: roll back by redeploying the previous version of each repo, in the reverse of the deploy order. Atticus wrote this from the target flows; a person confirms it in the architecture PR.\n",
    );
  });
});
