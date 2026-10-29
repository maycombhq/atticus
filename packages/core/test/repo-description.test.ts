import { cp, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  descriptionLine,
  descriptionNote,
  descriptionShape,
  descriptionWords,
  isSuggested,
  manifestFiles,
  ManifestEditError,
  migrateManifests,
  RepoDescription,
  RepoManifest,
  saysNotProduct,
  setManifestDescription,
} from "../src/index.js";

/**
 * A repo's description (ADR 0128): written into the manifest in place, read back as a note, and
 * read for the few proposals it helps. The invented Forge estate only (CLAUDE.md rule 3).
 */

const ESTATE = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/estate");
const MANIFEST = ["org-pack", "profiles", "forge", "repos.manifest.yaml"];

async function metarepo() {
  const root = await mkdtemp(join(tmpdir(), "atticus-describe-"));
  await cp(join(ESTATE, "org-pack"), join(root, "org-pack"), { recursive: true });
  return root;
}

const read = async (root: string) => readFile(join(root, ...MANIFEST), "utf8");

describe("setManifestDescription", () => {
  it("writes a person's words into the repo's entry and keeps the file's comments", async () => {
    const root = await metarepo();
    const file = await setManifestDescription(root, "forge-customers", {
      text: "Customer records and the API the web app reads them through.",
      trust: "verified",
      by: "pat",
      at: "2026-10-26T09:00:00Z",
      cites: [],
    });
    expect(file.platform).toBe("forge");
    const text = await read(root);
    expect(text).toContain("# The two invented repos of the estate");
    expect(text).toContain("Customer records and the API the web app reads them through.");
    const m = RepoManifest.parse(parse(text));
    expect(m.repos.find((r) => r.id === "forge-customers")!.description).toMatchObject({
      trust: "verified",
      by: "pat",
    });
    // The other repo is untouched.
    expect(m.repos.find((r) => r.id === "forge-web")!.description).toBeUndefined();
  });

  it("keeps a draft marked suggested with its cites, and a later confirm replaces it", async () => {
    const root = await metarepo();
    await setManifestDescription(root, "forge-web", {
      text: "The Forge web app: the pages a customer sees.",
      trust: "suggested",
      by: "assistant",
      cites: [{ file: "README.md", line: 2 }],
    } as RepoDescription);
    let d = RepoManifest.parse(parse(await read(root))).repos.find(
      (r) => r.id === "forge-web",
    )!.description!;
    expect(isSuggested(d)).toBe(true);
    expect(d.cites).toEqual([{ file: "README.md", line: 2 }]);
    await setManifestDescription(root, "forge-web", { ...d, trust: "verified", by: "pat" });
    d = RepoManifest.parse(parse(await read(root))).repos.find(
      (r) => r.id === "forge-web",
    )!.description!;
    expect(isSuggested(d)).toBe(false);
    expect(d.by).toBe("pat");
  });

  it("removes a description and says so when no manifest lists the repo", async () => {
    const root = await metarepo();
    await setManifestDescription(root, "forge-web", {
      text: "The Forge web app.",
    } as RepoDescription);
    await setManifestDescription(root, "forge-web", undefined);
    expect(await read(root)).not.toContain("description");
    await expect(setManifestDescription(root, "forge-nothing", undefined)).rejects.toBeInstanceOf(
      ManifestEditError,
    );
  });
});

describe("migrateManifests (atticus upgrade)", () => {
  it("rewrites a version-1 manifest at the current version, comments kept, once", async () => {
    const root = await metarepo();
    expect((await manifestFiles(root)).map((f) => f.rel)).toEqual([
      "org-pack/profiles/forge/repos.manifest.yaml",
    ]);
    expect(await migrateManifests(root, { dryRun: true })).toEqual([
      "org-pack/profiles/forge/repos.manifest.yaml",
    ]);
    // A dry run changes nothing.
    expect(await read(root)).toContain("schemaVersion: 1");
    expect(await migrateManifests(root)).toEqual(["org-pack/profiles/forge/repos.manifest.yaml"]);
    const text = await read(root);
    expect(text).toContain("schemaVersion: 3");
    expect(text).toContain("# The two invented repos of the estate");
    expect(RepoManifest.safeParse(parse(text)).success).toBe(true);
    expect(await migrateManifests(root)).toEqual([]);
  });
});

describe("what a description is read for", () => {
  const of = (text: string) => RepoDescription.parse({ text });

  it("says in the prompt that it is a note the code beats", () => {
    const note = descriptionNote("forge-web", of("The pages a customer sees."));
    expect(note).toContain("in the words of the person who added it");
    expect(note).toContain("the code is right");
    expect(
      descriptionNote("forge-web", RepoDescription.parse({ text: "x", trust: "suggested" })),
    ).toContain("nobody has confirmed yet");
  });

  it("marks an unconfirmed draft wherever it is shown", () => {
    expect(descriptionLine(of("The ledger."))).toBe("The ledger.");
    expect(descriptionLine(RepoDescription.parse({ text: "The ledger.", by: "pat" }))).toBe(
      "The ledger. — pat",
    );
    expect(
      descriptionLine(
        RepoDescription.parse({ text: "The ledger.", trust: "suggested", by: "assistant" }),
      ),
    ).toContain("unconfirmed");
  });

  it("reads a description that plainly says the repo is not product code", () => {
    expect(descriptionShape(of("Our documentation site, built from markdown."))).toMatchObject({
      docs: true,
      data: false,
      vendored: false,
    });
    expect(descriptionShape(of("A vendored text corpus we test the parser against"))).toMatchObject(
      { data: true, vendored: true },
    );
    expect(saysNotProduct(of("The ledger service: postings and balances."))).toBe(false);
    expect(saysNotProduct(undefined)).toBe(false);
    expect(saysNotProduct(of("Reference data for the payment rails."))).toBe(true);
  });

  it("gives the words a repo is matched on, folded and without the short ones", () => {
    expect(descriptionWords(of("The Ledger: postings and balances."))).toEqual([
      "and",
      "balances",
      "ledger",
      "postings",
      "the",
    ]);
    expect(descriptionWords(undefined)).toEqual([]);
  });
});

describe("the local API says what a repo is (C4 2.28.0, ADR 0128)", () => {
  it("is 2.28.0 or later, carries the line on a repo, and takes a set, a confirm or a drop", async () => {
    const { API_VERSION, Api } = await import("../src/index.js");
    // 2.26.0 and 2.27.0 landed beside this one (B-task-knowledge, the finding proposal), so the
    // description arrived at 2.28.0; a later additive version keeps all of it.
    const [major, minor] = API_VERSION.split(".").map(Number);
    expect(major).toBe(2);
    expect(minor).toBeGreaterThanOrEqual(28);
    const about = {
      text: "The ledger: every posting and the balances read from them.",
      trust: "verified" as const,
      by: "pat",
      at: "2026-10-26T09:00:00Z",
    };
    expect(
      Api.RepoBranchesView.parse({
        id: "forge-ledger",
        platform: "forge",
        url: "https://git.example.com/forge/forge-ledger.git",
        type: "spring-boot",
        owner: "team-ledger",
        description: about,
        defaultBranch: "main",
        branches: [],
        scans: [],
      }).description,
    ).toMatchObject(about);
    const repo = {
      id: "forge-ledger",
      platform: "forge",
      type: "spring-boot",
      owner: "team-ledger",
      manifest: "org-pack/profiles/forge/repos.manifest.yaml",
      cloned: true,
      scanSettings: { path: "org-pack/scan/forge-ledger.yaml", present: false },
      lastScan: null,
    };
    // Optional: a view written before this still parses.
    expect(Api.OnboardingRepo.parse(repo).description).toBeUndefined();
    expect(
      Api.OnboardingRepo.parse({
        ...repo,
        description: { ...about, trust: "suggested", cites: [{ file: "README.md", line: 3 }] },
      }).description?.cites,
    ).toEqual([{ file: "README.md", line: 3 }]);
    for (const body of [{ text: "The ledger." }, { accept: true }, { reject: true }, {}])
      expect(Api.EditRepoDescriptionRequest.safeParse(body).success).toBe(true);
    expect(Api.EditRepoDescriptionRequest.safeParse({ text: 7 }).success).toBe(false);
  });
});
