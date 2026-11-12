import { describe, expect, it } from "vitest";
import { netRenames, undoneRenames } from "../src/catalog-build-commands.js";

// Review of beta.27: an undo that takes back several renames' builds says one thing per repo,
// the id the manifest has now and the one to go back to.
describe("the renames an undo takes back", () => {
  const r = (a: string, b: string) => `atticus repo rename ${a} ${b}`;
  it("composes a chain into one rename, newest first in, oldest to newest out", () => {
    expect(netRenames([r("forge-a", "forge-b"), r("forge-ledger", "forge-a")])).toEqual([
      { from: "forge-ledger", to: "forge-b" },
    ]);
    expect(
      undoneRenames([
        { command: r("forge-a", "forge-b") },
        { command: r("forge-ledger", "forge-a") },
      ])[0]!.message,
    ).toContain("atticus repo rename forge-b forge-ledger");
  });
  it("says nothing of a rename taken back by a later one", () => {
    expect(netRenames([r("forge-a", "forge-ledger"), r("forge-ledger", "forge-a")])).toEqual([]);
  });
  it("keeps renames of different repos apart, and skips other commands", () => {
    expect(
      netRenames([r("forge-pay-v2", "forge-pay"), "atticus scan", r("forge-ledger", "forge-core")]),
    ).toEqual([
      { from: "forge-ledger", to: "forge-core" },
      { from: "forge-pay-v2", to: "forge-pay" },
    ]);
  });
});
