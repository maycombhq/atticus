import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { profilesRaised } from "../src/propose-profiles.js";

/**
 * ADR 0204 (Migration): the Propose page says when a proposal raises a profile to the version an
 * older Atticus refuses. Git is a mock (hard rule 5): HEAD's profile is at 1 or 2.
 */
describe("profiles a proposal raises (ADR 0204)", () => {
  it("names a profile raised to 3, and nothing else", async () => {
    const root = mkdtempSync(join(tmpdir(), "b30-cn-propose-"));
    for (const [p, v] of [
      ["forge", 3],
      ["harbor", 2],
    ] as const) {
      mkdirSync(join(root, "org-pack", "profiles", p), { recursive: true });
      writeFileSync(
        join(root, "org-pack", "profiles", p, "profile.yaml"),
        `schemaVersion: ${v}\nplatform: ${p}\nname: ${p}\n`,
      );
    }
    const git = async (args: readonly string[]) => ({
      stdout: args[1]!.includes("forge") ? "schemaVersion: 1\n" : "schemaVersion: 2\n",
      stderr: "",
      code: 0,
    });
    const files = [
      { path: "org-pack/profiles/forge/profile.yaml" },
      { path: "org-pack/profiles/harbor/profile.yaml" },
      { path: "facts/forge-orders.corrections.jsonl" },
    ];
    expect(await profilesRaised(root, files, git as never)).toEqual([
      { file: "org-pack/profiles/forge/profile.yaml", from: 1, to: 3 },
    ]);
  });
});
