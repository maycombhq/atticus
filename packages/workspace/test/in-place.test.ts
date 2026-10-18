import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ManifestRepo } from "@maycombhq/core";
import { createWorkspace, type GitRunner } from "../src/index.js";

/**
 * A manifest url of `.` or `./<path>` names a repo already in place under the metarepo root
 * (an adopted repo, or a folder of clones). There is nothing to clone or update, so sync
 * skips it without running git and without touching the root's .gitignore.
 */
describe("workspace sync and in-place repos", () => {
  it("skips urls . and ./x without running git or writing anything", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-in-place-"));
    const calls: string[][] = [];
    const git: GitRunner = async (args) => {
      calls.push(args);
      throw new Error("git must not run for an in-place repo");
    };
    const repo = (id: string, url: string) =>
      ManifestRepo.parse({ id, url, type: "service", owner: "team" });
    const r = await createWorkspace(root, git).sync([
      repo("notes-service", "."),
      repo("notes-ui", "./ui"),
    ]);
    expect(r).toEqual([
      { id: "notes-service", action: "skipped", reason: "in place at ., nothing to clone" },
      { id: "notes-ui", action: "skipped", reason: "in place at ./ui, nothing to clone" },
    ]);
    expect(calls).toEqual([]);
    expect(existsSync(join(root, ".gitignore"))).toBe(false);
    expect(existsSync(join(root, "workspace"))).toBe(false);
  });
});
