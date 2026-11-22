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
    const git = async (args: readonly string[]) => {
      // No origin/HEAD here: the proposal's target is read as HEAD.
      if (args[0] === "symbolic-ref") throw new Error("exit 1");
      return {
        stdout: args[1]!.includes("forge") ? "schemaVersion: 1\n" : "schemaVersion: 2\n",
        stderr: "",
        code: 0,
      };
    };
    const files = [
      { path: "org-pack/profiles/forge/profile.yaml" },
      { path: "org-pack/profiles/harbor/profile.yaml" },
      { path: "facts/forge-orders.corrections.jsonl" },
    ];
    expect(await profilesRaised(root, files, git as never)).toEqual([
      { file: "org-pack/profiles/forge/profile.yaml", from: 1, to: 3 },
    ]);
  });

  it("compares with the proposal's target branch, not HEAD (the second review)", async () => {
    const root = mkdtempSync(join(tmpdir(), "b30-cn-propose-"));
    mkdirSync(join(root, "org-pack", "profiles", "forge"), { recursive: true });
    writeFileSync(
      join(root, "org-pack", "profiles", "forge", "profile.yaml"),
      "schemaVersion: 3\nplatform: forge\nname: forge\n",
    );
    const asked: string[][] = [];
    // The raise is committed on this branch already (HEAD at 3); the target, origin/main, is at 2.
    const git = async (args: readonly string[]) => {
      asked.push([...args]);
      if (args[0] === "symbolic-ref") return { stdout: "origin/main\n", stderr: "", code: 0 };
      const at = args[1]!.startsWith("origin/main:") ? 2 : 3;
      return { stdout: `schemaVersion: ${at}\n`, stderr: "", code: 0 };
    };
    expect(
      await profilesRaised(root, [{ path: "org-pack/profiles/forge/profile.yaml" }], git as never),
    ).toEqual([{ file: "org-pack/profiles/forge/profile.yaml", from: 2, to: 3 }]);
    expect(asked).toContainEqual(["show", "origin/main:org-pack/profiles/forge/profile.yaml"]);
  });
});
