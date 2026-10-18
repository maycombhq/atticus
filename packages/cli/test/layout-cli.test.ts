import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { fileStepStore } from "@maycombhq/adapters";
import { adopt, exists, hashTree, unadopt } from "@maycombhq/adopt";
import { generateAssistantFiles } from "@maycombhq/assistant-files";
import { changeFolder, changeStore } from "@maycombhq/changes";
import { changesDirOf } from "@maycombhq/core";
import { changeDir, loadRepos, writeChangeRepos } from "@maycombhq/workspace";
import { changeNew } from "../src/change-commands.js";

/**
 * A repo adopted in place without an OpenSpec folder of its own keeps OpenSpec inside
 * .atticus/ (sources.yaml layout.openspec: .atticus/openspec). Every command that reads or
 * writes a change folder resolves it through the layout, so nothing lands in openspec/ at
 * the repo root and unadopt still leaves the repo byte-identical.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "../../adopt/test/fixtures");
const made: string[] = [];
afterAll(async () => {
  while (made.length) await rm(made.pop()!, { recursive: true, force: true });
});

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

describe("change folders through the layout on an adopted repo", () => {
  it("keeps every change folder under .atticus/openspec/changes", async () => {
    const base = await mkdtemp(join(tmpdir(), "atticus-layout-"));
    made.push(base);
    const dir = join(base, "notes-service");
    await cp(join(FIXTURES, "assistant-repo"), dir, { recursive: true });
    const before = await hashTree(dir);
    await adopt(dir);
    const changes = join(dir, ".atticus", "openspec", "changes");
    expect(changesDirOf(dir)).toBe(changes);

    // changes: change new writes into the layout's folder and says where.
    const c = io();
    expect(
      await changeNew(
        dir,
        { title: "Add note tags", type: "feature", by: "pat", id: "add-note-tags" },
        c.io,
      ),
    ).toBe(0);
    expect(c.out.join("\n")).toContain("Write the brief: .atticus/openspec/changes/add-note-tags/");
    expect(await exists(join(changes, "add-note-tags", "change.yaml"))).toBe(true);
    expect(await exists(join(dir, "openspec"))).toBe(false);
    expect(changeFolder(dir, "add-note-tags")).toBe(join(changes, "add-note-tags"));
    expect((await changeStore(dir).list()).map((x) => x.id)).toEqual(["add-note-tags"]);

    // workspace: the change's repos.yaml sits in the same folder.
    expect(changeDir(dir, "add-note-tags")).toBe(join(changes, "add-note-tags"));
    const repo = (await loadRepos(dir))[0]!;
    await writeChangeRepos(dir, {
      schemaVersion: 1,
      change: "add-note-tags",
      repos: [
        {
          id: repo.id,
          branch: "change/add-note-tags",
          base: "main",
          worktree: ".atticus/workspace/.worktrees/add-note-tags/" + repo.id,
          build: { status: "not-run" },
        },
      ],
    });
    expect(await exists(join(changes, "add-note-tags", "repos.yaml"))).toBe(true);

    // assistant-files: finds the repo's worktree through the change folder.
    const g = await generateAssistantFiles(dir, { repo: repo.id, check: true });
    expect(g.dir).toBe(join(dir, ".atticus/workspace/.worktrees/add-note-tags", repo.id));

    // manual steps: a change's steps live in its folder.
    const steps = fileStepStore(dir);
    const s = await steps.create({
      slug: "open-pr",
      key: "git-host|pr|x",
      system: "git-host",
      action: "open-pull-request",
      change: "add-note-tags",
      title: "Open a pull request",
      where: "Git host",
      createdBy: "pat",
      createdAt: "2026-10-20T09:00:00Z",
    });
    expect(steps.pathOf(s).startsWith(join(changes, "add-note-tags", "steps"))).toBe(true);

    await unadopt(dir);
    expect(await hashTree(dir)).toEqual(before);
  });
});
