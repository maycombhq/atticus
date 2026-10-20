import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { loadOrgPack } from "@maycombhq/core";
import { fsRepo } from "@maycombhq/sdk";
import {
  detectRepoType,
  init,
  MockRepoListing,
  reposDiscover,
  toPosix,
  UNASSIGNED,
} from "../src/index.js";
import { cleanup, fixture, tempDir } from "./helpers.js";

afterAll(cleanup);

/** Hand-written: what each folder of the plain multi-repo fixture is. */
const EXPECTED_TYPES: Record<string, string> = {
  "batch-mainframe": "mainframe",
  "billing-net": "dotnet",
  "edge-gateway": "gateway",
  "event-topics": "event-config",
  "ledger-go": "go",
  "notify-worker": "node",
  "orders-api": "spring-boot",
  "platform-infra": "infra",
  "pricing-py": "python",
  "web-shop": "frontend",
};

describe("detectRepoType", () => {
  for (const [name, type] of Object.entries(EXPECTED_TYPES))
    it(`${name} is ${type}`, async () => {
      const d = await detectRepoType(fsRepo(name, fixture(`plain-multi/${name}`), "0000000"));
      expect(d.type).toBe(type);
      expect(d.signals.length).toBeGreaterThan(0);
    });

  it("agrees with the component extractor on what builds something", async () => {
    const yes = await detectRepoType(fsRepo("o", fixture("plain-multi/orders-api"), "0"));
    const no = await detectRepoType(fsRepo("g", fixture("plain-multi/edge-gateway"), "0"));
    expect(yes.component).toBe(true);
    expect(no.component).toBe(false);
  });

  it("says unknown, with low confidence, for a folder of notes", async () => {
    const d = await detectRepoType(fsRepo("docs", fixture("plain-multi/docs"), "0"));
    expect(d).toMatchObject({ type: "unknown", confidence: "low", component: false });
  });
});

async function metarepo(): Promise<string> {
  const root = join(await tempDir(), "shop-meta");
  await init(root, { name: "shop", platform: "shop", openspec: "folders" });
  return root;
}

describe("reposDiscover from a folder of clones", () => {
  it("fills the empty manifest init wrote, with owner questions", async () => {
    const root = await metarepo();
    const src = fixture("plain-multi");
    const r = await reposDiscover(root, { dir: src });
    expect(r.platform).toBe("shop");
    expect(r.wrote).toBe("manifest");
    expect(r.file).toBe("org-pack/profiles/shop/repos.manifest.yaml");
    expect(r.skipped).toEqual([{ path: "docs", reason: "no build file, code or platform files" }]);

    const manifest = parse(await readFile(join(root, r.file!), "utf8"));
    // Hand-written expectation: one entry per repo folder, in name order, url = the folder.
    expect(manifest).toEqual({
      schemaVersion: 1,
      platform: "shop",
      repos: Object.entries(EXPECTED_TYPES).map(([id, type]) => ({
        id,
        url: toPosix(resolve(src, id)),
        defaultBranch: "main",
        type,
        owner: UNASSIGNED,
      })),
    });
    // Every repo needs an owner and a system from a person; no type is unknown.
    expect(r.questions).toHaveLength(20);
    expect(r.questions.filter((q) => q.field === "type")).toEqual([]);
    expect(await readFile(join(root, r.questionsFile!), "utf8")).toContain(
      "- [ ] orders-api (owner): Which team owns orders-api?",
    );
    // The org pack still validates.
    expect((await loadOrgPack(join(root, "org-pack"))).problems).toEqual([]);
  });

  it("never overwrites a manifest a person wrote: it writes a proposal beside it", async () => {
    const root = await metarepo();
    const file = join(root, "org-pack/profiles/shop/repos.manifest.yaml");
    const mine =
      "schemaVersion: 1\nplatform: shop\nrepos:\n  - id: orders-api\n    url: https://git.example.com/shop/orders-api.git\n    type: spring-boot\n    owner: team-orders\n";
    await writeFile(file, mine, "utf8");
    const r = await reposDiscover(root, { dir: fixture("plain-multi") });
    expect(r.wrote).toBe("proposal");
    expect(r.file).toBe("proposals/repos/shop/repos.manifest.yaml");
    expect(await readFile(file, "utf8")).toBe(mine);
    const proposal = parse(await readFile(join(root, r.file!), "utf8")) as {
      repos: { id: string; owner: string; url: string }[];
    };
    // The person's entry is kept as it is; the nine other repos are added.
    expect(proposal.repos[0]).toEqual({
      id: "orders-api",
      url: "https://git.example.com/shop/orders-api.git",
      defaultBranch: "main",
      type: "spring-boot",
      owner: "team-orders",
    });
    expect(proposal.repos.map((x) => x.id)).toEqual([
      "orders-api",
      ...Object.keys(EXPECTED_TYPES).filter((x) => x !== "orders-api"),
    ]);
  });

  it("reads origin and branch from a clone's .git files without running git", async () => {
    const root = await metarepo();
    const src = join(await tempDir(), "clones");
    await mkdir(join(src, "ledger", ".git"), { recursive: true });
    await writeFile(join(src, "ledger", "go.mod"), "module example.com/ledger\n", "utf8");
    await writeFile(
      join(src, "ledger", ".git", "config"),
      '[core]\n\tbare = false\n[remote "origin"]\n\turl = https://pat@git.example.com/shop/ledger.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n',
      "utf8",
    );
    await writeFile(join(src, "ledger", ".git", "HEAD"), "ref: refs/heads/trunk\n", "utf8");
    const r = await reposDiscover(root, { dir: src }, { dryRun: true });
    expect(r.wrote).toBe("nothing");
    expect(r.repos.map((x) => x.entry)).toEqual([
      {
        id: "ledger",
        url: "https://git.example.com/shop/ledger.git",
        defaultBranch: "trunk",
        type: "go",
        owner: UNASSIGNED,
        extractors: [],
        dialects: [],
        sparse: [],
        archived: false,
        hosts: [],
        modules: [],
      },
    ]);
  });
});

describe("reposDiscover from a Git host organisation (mock)", () => {
  it("lists the organisation's repos and detects each type from its files", async () => {
    const root = await metarepo();
    const host = new MockRepoListing({
      shop: [
        {
          name: "checkout-ui",
          url: "https://git.example.com/shop/checkout-ui.git",
          files: { "package.json": '{"dependencies":{"vue":"3.5.0"}}' },
        },
        {
          name: "Payments-API",
          url: "https://git.example.com/shop/payments-api.git",
          defaultBranch: "develop",
          files: { "build.gradle.kts": 'plugins { id("org.springframework.boot") }' },
        },
        {
          name: "old-batch",
          url: "https://git.example.com/shop/old-batch.git",
          archived: true,
          files: { "jcl/NIGHTLY.jcl": "//NIGHTLY JOB" },
        },
        { name: "wiki-export", url: "https://git.example.com/shop/wiki-export.git", files: {} },
      ],
    });
    const r = await reposDiscover(root, { host, org: "shop" });
    expect(
      r.repos.map((x) => [x.entry.id, x.entry.type, x.entry.defaultBranch, x.entry.archived]),
    ).toEqual([
      ["checkout-ui", "frontend", "main", false],
      ["old-batch", "mainframe", "main", true],
      ["payments-api", "spring-boot", "develop", false],
      ["wiki-export", "unknown", "main", false],
    ]);
    expect(r.questions.filter((q) => q.field === "type").map((q) => q.repo)).toEqual([
      "wiki-export",
    ]);
    expect((await loadOrgPack(join(root, "org-pack"))).problems).toEqual([]);
  });
});
