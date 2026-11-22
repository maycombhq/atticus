import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  addManifestRepos,
  readOrgPackFile,
  renamedManifest,
  repoIdTwinOf,
  repoIdTwins,
  repoIdTwinWarning,
  unresolvedIdOf,
  writeOrgPackFile,
} from "../src/index.js";

/**
 * ADR 0124 addendum E-ids (the second whole-release review of beta.30): a loose end's id carries
 * its repo as the other ids name it (`unresolved.<factIdPart(repo)>.<rest>`), so `forge.api` and
 * `forge-api` name one id, and two repos' loose ends would be one record. The id scheme is C1's
 * and stays; two repo ids that name one loose-end id are refused wherever a repo id is written:
 * a repo added (one or a batch), a repo renamed, a manifest written in the raw editor. Invented
 * Forge names.
 */

const made: string[] = [];
afterAll(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true });
});

const entry = (id: string) =>
  `  - id: ${id}\n    url: https://git.forge.example/forge/${id.replace(/\./g, "-")}.git\n    type: unknown\n    owner: unassigned\n`;
const manifest = (platform: string, ids: string[]) =>
  `schemaVersion: 3\nplatform: ${platform}\nrepos:${ids.length ? `\n${ids.map(entry).join("")}` : " []\n"}`;

async function metarepo(forge: string[], northwind?: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-repo-id-twins-"));
  made.push(root);
  await mkdir(join(root, "org-pack", "profiles", "forge"), { recursive: true });
  await writeFile(join(root, "org-pack", "runtime.yaml"), "schemaVersion: 4\nadapters: {}\n");
  await writeFile(
    join(root, "org-pack", "profiles", "forge", "repos.manifest.yaml"),
    manifest("forge", forge),
  );
  if (northwind) {
    await mkdir(join(root, "org-pack", "profiles", "northwind"), { recursive: true });
    await writeFile(
      join(root, "org-pack", "profiles", "northwind", "repos.manifest.yaml"),
      manifest("northwind", northwind),
    );
  }
  return root;
}

const repo = (id: string) => ({
  id,
  url: `https://git.forge.example/forge/${id.replace(/\./g, "-")}-x.git`,
  type: "unknown",
  owner: "unassigned",
});

const WORDS = (x: string, y: string) => {
  const [a, b] = [x, y].sort() as [string, string];
  return `Repo ids ${a} and ${b} name one loose-end id (unresolved.${unresolvedIdOf(b, "").split(".")[1]}.…), so the map couldn't tell their loose ends apart`;
};

describe("repo ids that name one loose-end id", () => {
  it("are told by the loose end's own id part", () => {
    expect(unresolvedIdOf("forge.api", "c-1")).toBe(unresolvedIdOf("forge-api", "c-1"));
    expect(repoIdTwinOf("forge-api", ["forge-ledger", "forge.api"])).toBe("forge.api");
    expect(repoIdTwinOf("forge-api", ["forge-api", "forge-ledger"])).toBeUndefined();
    expect(repoIdTwinOf("forge-cards", ["forge.api"])).toBeUndefined();
  });

  it("are listed in pairs, each later id with the first that names its loose ends, for a warning", () => {
    // One rule everywhere: each pair sorted (cmpText), the second one the one to rename.
    expect(repoIdTwins(["forge.api", "forge-ledger", "forge-api", "forge--api"])).toEqual([
      ["forge--api", "forge-api"],
      ["forge--api", "forge.api"],
    ]);
    expect(repoIdTwins(["forge-api", "forge.api"])).toEqual(
      repoIdTwins(["forge.api", "forge-api"]),
    );
    expect(repoIdTwins(["forge-ledger", "forge-cards"])).toEqual([]);
    expect(repoIdTwinWarning("forge.api", "forge-api")).toBe(
      `${WORDS("forge-api", "forge.api")}: rename one (atticus repo rename forge.api <new id>)`,
    );
    expect(repoIdTwinWarning("forge-api", "forge.api")).toBe(
      repoIdTwinWarning("forge.api", "forge-api"),
    );
  });

  it("refuses one added beside the other, in another profile or the same batch", async () => {
    const root = await metarepo(["forge.api"], []);
    const file = join(root, "org-pack", "profiles", "northwind", "repos.manifest.yaml");
    const before = await readFile(file, "utf8");
    await expect(addManifestRepos(root, "northwind", [repo("forge-api")])).rejects.toThrow(
      `${WORDS("forge.api", "forge-api")}: give forge-api another id with --id.`,
    );
    await expect(
      addManifestRepos(root, "northwind", [repo("nw-ledger"), repo("nw.ledger")]),
    ).rejects.toThrow(`${WORDS("nw-ledger", "nw.ledger")}: give nw.ledger another id with --id.`);
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("refuses a rename to an id that names another repo's loose ends", async () => {
    const root = await metarepo(["forge.api", "forge-cards"]);
    await expect(renamedManifest(root, "forge-cards", "forge-api")).rejects.toThrow(
      `${WORDS("forge.api", "forge-api")}: give forge-cards another new id.`,
    );
    // A rename of the repo itself to its own twin is no clash: it is the same repo.
    await expect(renamedManifest(root, "forge.api", "forge-api")).resolves.toBeDefined();
  });

  it("refuses a manifest written in the raw editor that lists both, in it or beside another", async () => {
    const root = await metarepo(["forge-ledger"], ["nw-other"]);
    const rel = "profiles/northwind/repos.manifest.yaml";
    const f = await readOrgPackFile(root, rel);
    await expect(
      writeOrgPackFile(root, rel, manifest("northwind", ["nw.cards", "nw-cards"]), {
        baseSha256: f.sha256,
      }),
    ).rejects.toThrow(`${WORDS("nw.cards", "nw-cards")}: give one of them another id.`);
    await expect(
      writeOrgPackFile(root, rel, manifest("northwind", ["forge.ledger"]), {
        baseSha256: f.sha256,
      }),
    ).rejects.toThrow(`${WORDS("forge-ledger", "forge.ledger")}: give one of them another id.`);
  });
});
