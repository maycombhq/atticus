import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readManifests } from "@maycombhq/planner";
import { loadRepos } from "@maycombhq/workspace";

/**
 * ADR 0201 decision 8: the stages' estate counts the repos the manifests list. The planner can't
 * import the workspace's reader (`loadRepos`), so its own (`readManifests`) is fed the same
 * manifests here and must agree: the same repos where `loadRepos` reads, and a problem naming
 * the same file where `loadRepos` refuses. Invented Forge repos.
 */

const repo = (id: string, more = "") =>
  `  - id: ${id}\n    url: https://git.example.com/forge/${id}.git\n    type: infra\n    owner: team-platform\n${more}`;
const manifest = (platform: string, repos: string) =>
  `schemaVersion: 1\nplatform: ${platform}\nrepos:\n${repos}`;

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function metarepo(profiles: Record<string, string>): Promise<string> {
  root = await mkdtemp(join(tmpdir(), "atticus-manifest-readers-"));
  for (const [platform, text] of Object.entries(profiles)) {
    await mkdir(join(root, "org-pack/profiles", platform), { recursive: true });
    await writeFile(join(root, "org-pack/profiles", platform, "repos.manifest.yaml"), text);
  }
  // A profile folder with no manifest lists nothing, for both.
  await mkdir(join(root, "org-pack/profiles/empty"), { recursive: true });
  return root;
}

describe("the planner's manifest reader agrees with the workspace's", () => {
  it("lists the same repos, and tells the archived ones apart", async () => {
    const r = await metarepo({
      forge: manifest("forge", repo("forge-orders") + repo("forge-infra")),
      "forge-old": manifest("forge-old", repo("forge-batch", "    archived: true\n")),
    });
    const loaded = await loadRepos(r);
    const read = await readManifests(r);
    expect(read.problems).toEqual([]);
    expect([...read.repos, ...read.archived].sort()).toEqual(loaded.map((x) => x.id).sort());
    expect(read.repos).toEqual(loaded.filter((x) => !x.archived).map((x) => x.id));
    expect(read.archived).toEqual(["forge-batch"]);
  });

  it.each([
    [
      "a repo the schema refuses (no owner)",
      "schemaVersion: 1\nplatform: forge-b\nrepos:\n  - id: forge-billing\n    url: https://git.example.com/forge/forge-billing.git\n    type: infra\n",
    ],
    ["YAML that doesn't parse", "schemaVersion: 1\nrepos: [ {id: forge-search\n"],
    ["a repo id another profile has", manifest("forge-b", repo("forge-orders"))],
    ["a platform that isn't its folder's", manifest("forge-z", repo("forge-billing"))],
  ])("refuses what the workspace's refuses: %s", async (_what, text) => {
    const r = await metarepo({
      forge: manifest("forge", repo("forge-orders")),
      "forge-b": text,
    });
    const refused = await loadRepos(r).then(
      () => undefined,
      (e: Error & { path?: string }) => e,
    );
    const read = await readManifests(r);
    // Whatever the workspace's reader refuses, the planner's doesn't count and says.
    expect(read.problems.length > 0).toBe(refused !== undefined);
    if (refused) {
      expect(read.problems).toHaveLength(1);
      expect(read.problems[0]).toMatch(/^org-pack\/profiles\/forge-b\/repos\.manifest\.yaml: /);
      expect(refused.path).toContain(join("profiles", "forge-b", "repos.manifest.yaml"));
      expect(read.repos).toEqual(["forge-orders"]);
    } else expect(read.repos).toEqual((await loadRepos(r)).map((x) => x.id));
  });
});
