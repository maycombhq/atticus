import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { LOCAL_ONLY, loadOrgPack, RepoManifest, WORKSPACE_SCHEMA_VERSION } from "@maycombhq/core";
import { createWorkspace } from "@maycombhq/workspace";
import { adopt, AdoptError, init, MockRepoListing, reposDiscover, toPosix } from "../src/index.js";
import { cleanup, copyFixture, fixture, tempDir } from "./helpers.js";

/** Review round 50 (getting started): what repos discover, init and adopt write. */

afterAll(cleanup);

const T = 60_000;

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=Forge Dev",
      "-c",
      "user.email=dev@forge.example",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

async function metarepo(): Promise<string> {
  const root = join(await tempDir(), "forge-meta");
  await init(root, { name: "forge", platform: "forge", openspec: "folders" });
  return root;
}

const manifestPath = (root: string) => join(root, "org-pack/profiles/forge/repos.manifest.yaml");

/** A clone with one commit on main and the given origin; `pushFirst` writes pushurl above url. */
async function clone(
  parent: string,
  name: string,
  origin: string,
  o: { pushFirst?: string } = {},
): Promise<string> {
  const dir = join(parent, name);
  await mkdir(dir, { recursive: true });
  git(dir, "init", "--quiet");
  await writeFile(join(dir, "go.mod"), `module example.com/${name}\n`, "utf8");
  git(dir, "add", "go.mod");
  git(dir, "commit", "--quiet", "-m", "first");
  if (o.pushFirst) git(dir, "config", "remote.origin.pushurl", o.pushFirst);
  git(dir, "config", "remote.origin.url", origin);
  return dir;
}

describe("repos discover writes manifests Atticus reads as they are (round 50, 1 and 3)", () => {
  it("writes the manifest at the current schema version, with every field of each entry", async () => {
    const root = await metarepo();
    const host = new MockRepoListing({
      forge: [
        {
          name: "forge-batch",
          url: "https://git.example.com/forge/forge-batch.git",
          archived: true,
          defaultBranch: "release",
          files: { "jcl/NIGHTLY.jcl": "//NIGHTLY JOB" },
        },
        {
          name: "forge-web",
          url: "https://git.example.com/forge/forge-web.git",
          files: { "package.json": '{"dependencies":{"react":"18.3.1"}}' },
        },
      ],
    });
    const r = await reposDiscover(root, { host, org: "forge" });
    expect(r.wrote).toBe("manifest");
    const written = parse(await readFile(manifestPath(root), "utf8")) as { schemaVersion: number };
    expect(written.schemaVersion).toBe(WORKSPACE_SCHEMA_VERSION);
    // Read back, the manifest says exactly what discovery found: no field left out.
    expect(RepoManifest.parse(written).repos).toEqual(r.repos.map((x) => x.entry));
  });

  it("keeps a person's entries byte for byte in the proposal, at the manifest's version", async () => {
    const root = await metarepo();
    const mine = [
      "# Forge's repos, kept by the platform team.",
      "schemaVersion: 3",
      "platform: forge",
      "repos:",
      "  - id: forge-orders",
      "    url: https://dev.azure.com/forgeorg/Forge%20Payments/_git/forge-orders",
      "    description:",
      "      text: Takes card orders from the shop.",
      "      trust: verified",
      "      by: dana",
      "      at: 2026-10-01T09:00:00Z",
      "    defaultBranch: develop",
      "    type: spring-boot",
      "    owner: team-orders # the orders squad",
      "    extractors: [openapi]",
      "    dialects: [forge-boot]",
      "    sparse: [services/orders]",
      "    hosts: [orders.forge.example]",
      "    basePath: /orders",
      "",
    ].join("\n");
    await writeFile(manifestPath(root), mine, "utf8");
    const r = await reposDiscover(root, { dir: fixture("plain-multi") });
    expect(r.wrote).toBe("proposal");
    const text = await readFile(join(root, r.file!), "utf8");
    // The person's lines, comments and all, are there unchanged.
    expect(text).toContain(mine.split("\n").slice(3).join("\n").trimEnd());
    expect(text).toContain("# Forge's repos, kept by the platform team.");
    const proposal = RepoManifest.parse(parse(text));
    expect(proposal.schemaVersion).toBe(3);
    expect(proposal.repos[0]).toEqual(RepoManifest.parse(parse(mine)).repos[0]);
    expect(proposal.repos).toHaveLength(11);
  });
});

describe("repos discover reads a clone's origin as Git does (round 50, 2)", () => {
  it(
    "keeps spaces in an Azure DevOps URL, the ssh user and a Windows path; takes url, not pushurl; drops http credentials",
    async () => {
      const root = await metarepo();
      const src = join(await tempDir(), "clones");
      await clone(
        src,
        "forge-ledger",
        "https://pat:secret@dev.azure.com/forgeorg/Forge Payments/_git/forge ledger",
        { pushFirst: "https://push.forge.example/forge/ledger.git" },
      );
      await clone(src, "forge-cards", "ssh://git@git.forge.example:22/forge/cards.git");
      await clone(src, "forge-rates", "C:\\clones\\forge-rates");
      await clone(src, "forge-fx", "https://token123@git.forge.example/forge/fx.git");
      const r = await reposDiscover(root, { dir: src }, { dryRun: true });
      expect(Object.fromEntries(r.repos.map((x) => [x.entry.id, x.entry.url]))).toEqual({
        "forge-cards": "ssh://git@git.forge.example:22/forge/cards.git",
        "forge-fx": "https://git.forge.example/forge/fx.git",
        "forge-ledger": "https://dev.azure.com/forgeorg/Forge Payments/_git/forge ledger",
        "forge-rates": "C:\\clones\\forge-rates",
      });
    },
    T,
  );

  it(
    "so workspace sync --from points each base clone at the server's whole URL",
    async () => {
      const root = await metarepo();
      const src = join(await tempDir(), "clones");
      const url = "https://dev.azure.com/forgeorg/Forge Payments/_git/forge ledger";
      await clone(src, "forge-ledger", url.replace("https://", "https://pat:secret@"));
      await reposDiscover(root, { dir: src });
      const repos = RepoManifest.parse(parse(await readFile(manifestPath(root), "utf8"))).repos;
      const [s] = await createWorkspace(root).sync(repos, { from: src });
      expect(s).toMatchObject({ id: "forge-ledger", action: "cloned" });
      expect(
        git(join(root, "workspace", "forge-ledger"), "config", "--get", "remote.origin.url").trim(),
      ).toBe(url);
    },
    T,
  );
});

describe("repos discover with more than one profile (round 50, 6)", () => {
  it("asks for --platform instead of making a default profile", async () => {
    const root = await metarepo();
    await mkdir(join(root, "org-pack/profiles/cards"), { recursive: true });
    await writeFile(
      join(root, "org-pack/profiles/cards/profile.yaml"),
      "schemaVersion: 1\nplatform: cards\nname: cards\nsystems: []\n",
    );
    const err = await reposDiscover(root, { dir: fixture("plain-multi") }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdoptError);
    expect((err as AdoptError).code).toBe("usage");
    expect((err as Error).message).toContain("--platform");
    expect((err as Error).message).toContain("cards, forge");
    expect((await loadOrgPack(join(root, "org-pack"))).profiles.map((p) => p.platform)).toEqual([
      "cards",
      "forge",
    ]);
    // Named, it writes that profile's manifest.
    const r = await reposDiscover(root, { dir: fixture("plain-multi") }, { platform: "cards" });
    expect(r.file).toBe("org-pack/profiles/cards/repos.manifest.yaml");
  });
});

describe("repos discover with a found repo whose id the manifest lists already (round 50, 7)", () => {
  it("leaves out the same repo, and gives another repo with that id a new one, saying so", async () => {
    const root = await metarepo();
    const src = fixture("plain-multi");
    await writeFile(
      manifestPath(root),
      [
        "schemaVersion: 3",
        "platform: forge",
        "repos:",
        // The same repo as the folder (its URL, written another way): left out.
        "  - id: ledger-go",
        `    url: ${toPosix(resolve(src, "ledger-go"))}/`,
        "    type: go",
        "    owner: team-ledger",
        // Another repo that happens to have a found folder's id.
        "  - id: orders-api",
        "    url: https://git.example.com/forge/orders-api.git",
        "    type: spring-boot",
        "    owner: team-orders",
        "",
      ].join("\n"),
    );
    const r = await reposDiscover(root, { dir: src });
    const proposal = RepoManifest.parse(parse(await readFile(join(root, r.file!), "utf8")));
    const ids = proposal.repos.map((x) => x.id);
    expect(ids.filter((x) => x === "ledger-go")).toHaveLength(1);
    expect(ids).toContain("orders-api-2");
    expect(proposal.repos.find((x) => x.id === "orders-api-2")!.url).toBe(
      toPosix(resolve(src, "orders-api")),
    );
    expect(r.renamed).toEqual([
      {
        from: "orders-api",
        to: "orders-api-2",
        why: "the manifest lists orders-api already, with another clone URL",
      },
    ]);
    expect(r.repos.map((x) => x.entry.id)).toContain("orders-api-2");
    expect(r.questions.some((q) => q.repo === "orders-api-2")).toBe(true);
  });
});

describe("init and adopt write current files (round 50, 3 and 8)", () => {
  it("adopt writes its manifest at the current version and the whole local-only ignore list", async () => {
    const dir = await copyFixture("plain-multi", "forge-mono");
    const r = await adopt(dir);
    const m = parse(
      await readFile(
        join(dir, `.atticus/org-pack/profiles/${r.platform}/repos.manifest.yaml`),
        "utf8",
      ),
    ) as { schemaVersion: number };
    expect(m.schemaVersion).toBe(WORKSPACE_SCHEMA_VERSION);
    const ignore = (await readFile(join(dir, ".atticus/.gitignore"), "utf8")).split("\n");
    for (const l of LOCAL_ONLY) expect(ignore).toContain(l);
  });

  it(
    "init adds its .atticus lines to a CRLF .gitignore in CRLF",
    async () => {
      const root = join(await tempDir(), "forge-meta");
      await mkdir(root, { recursive: true });
      await writeFile(join(root, ".gitignore"), "node_modules/\r\n*.log\r\n", "utf8");
      await init(root, { name: "forge", platform: "forge", openspec: "folders" });
      const text = await readFile(join(root, ".gitignore"), "utf8");
      expect(text).toContain("!/.atticus/metarepo.yaml\r\n");
      expect(text.replace(/\r\n/g, "")).not.toContain("\n");
    },
    T,
  );
});
