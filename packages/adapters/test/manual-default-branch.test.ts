import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ManualGitHost, createAdapters, memoryStepStore } from "../src/index.js";

/**
 * Review round 48 (tasks and Git host): a manual Git host's default branch is the repo's own,
 * from the repos manifest (ADR 0123), not one "main" for every repo; a per-repo setting
 * overrides it, and the default branch is always protected.
 */

const MANIFEST = `schemaVersion: 1
platform: forge
repos:
  - id: forge-ledger
    url: https://git.example.com/forge/forge-ledger.git
    defaultBranch: develop
    type: forge-service
    owner: team-ledger
  - id: forge-portal-bff
    url: https://git.example.com/forge/forge-portal-bff.git
    type: forge-bff
    owner: team-portal
`;

async function metarepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-manual-branch-"));
  await mkdir(join(root, "org-pack/profiles/forge"), { recursive: true });
  await writeFile(join(root, "org-pack/profiles/forge/repos.manifest.yaml"), MANIFEST);
  return root;
}

describe("a manual Git host's default branch, per repo (review round 48)", () => {
  it("takes each repo's defaultBranch from the repos manifest, and protects it", async () => {
    const root = await metarepo();
    const gh = new ManualGitHost({ store: memoryStepStore(), root });
    expect(await gh.getRepo("forge-ledger")).toEqual({
      repo: "forge-ledger",
      defaultBranch: "develop",
      protectedBranches: ["develop"],
    });
    // Not given in the manifest: the adapter's setting, else main.
    expect((await gh.getRepo("forge-portal-bff")).defaultBranch).toBe("main");
    const set = new ManualGitHost({
      store: memoryStepStore(),
      root,
      settings: { defaultBranch: "trunk", protectedBranches: ["release"] },
    });
    expect(await set.getRepo("forge-portal-bff")).toEqual({
      repo: "forge-portal-bff",
      defaultBranch: "trunk",
      protectedBranches: ["release", "trunk"],
    });
    expect(await set.getRepo("forge-ledger")).toMatchObject({
      defaultBranch: "develop",
      protectedBranches: ["release", "develop"],
    });
  });

  it("lets a per-repo setting override the manifest, as createAdapters builds it", async () => {
    const root = await metarepo();
    const gh = createAdapters(
      {
        adapters: {
          gitHost: {
            type: "manual",
            settings: {
              "defaultBranch.forge-ledger": "main",
              "protectedBranches.forge-ledger": ["main", "release/2026.11"],
            },
          },
        },
      } as never,
      {},
      { store: memoryStepStore(), root },
    ).gitHost!;
    expect(await gh.getRepo("forge-ledger")).toEqual({
      repo: "forge-ledger",
      defaultBranch: "main",
      protectedBranches: ["main", "release/2026.11"],
    });
  });

  it("keeps main when there is no metarepo to read", async () => {
    const gh = new ManualGitHost({ store: memoryStepStore() });
    expect(await gh.getRepo("forge-ledger")).toEqual({
      repo: "forge-ledger",
      defaultBranch: "main",
      protectedBranches: ["main"],
    });
  });
});
