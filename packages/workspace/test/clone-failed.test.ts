import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ManifestRepo } from "@maycombhq/core";
import { baseClonePath, createWorkspace, type GitRunner } from "../src/index.js";

/**
 * Review round 31: git leaves the folder when a clone's checkout fails (Windows, a path past 260
 * characters). The sync takes it away and says the cure, so the next sync clones it again rather
 * than calling it a base clone with local changes forever.
 */
describe("a clone whose checkout failed", () => {
  it("is removed, said with core.longpaths, and cloned on the next sync", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-clone-failed-"));
    const repo = ManifestRepo.parse({
      id: "forge-ledger",
      url: "https://git.example.com/forge/forge-ledger.git",
      type: "service",
      owner: "team",
    });
    const dest = baseClonePath(root, repo.id);
    let fail = true;
    const clones: string[][] = [];
    const git: GitRunner = async (args) => {
      if (args[0] === "clone") {
        clones.push(args);
        await mkdir(join(dest, ".git"), { recursive: true });
        await writeFile(join(dest, ".git", "index"), "");
        if (fail)
          throw new Error(
            "error: unable to create file src/main/java/com/forge/...: Filename too long\nfatal: unable to checkout working tree",
          );
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "rev-parse")
        return { stdout: "0123456789abcdef0123456789abcdef01234567\n", stderr: "" };
      return { stdout: "", stderr: "" };
    };
    const [first] = await createWorkspace(root, git).sync([repo]);
    expect(first).toMatchObject({ action: "failed" });
    // Review round 32: kept in the clone's own config, for the person's git and editor too.
    expect(clones[0]!.slice(0, 3)).toEqual(["clone", "-c", "core.longpaths=true"]);
    expect((first as { reason: string }).reason).toMatch(
      /git config --global core\.longpaths true/,
    );
    expect(existsSync(dest)).toBe(false);
    fail = false;
    const [second] = await createWorkspace(root, git).sync([repo]);
    expect(second).toMatchObject({ action: "cloned" });
  });
});
