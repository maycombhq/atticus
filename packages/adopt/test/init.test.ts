import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { ChecklistPack, DEFAULT_GATES, loadOrgPack } from "@maycombhq/core";
import { readPackFiles, starterReviewText } from "@maycombhq/naysayer";
import type { GitRunner } from "@maycombhq/workspace";
import { AdoptError, exists, init } from "../src/index.js";
import { cleanup, tempDir } from "./helpers.js";

afterAll(cleanup);

const FORGE_PACK = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures/forge/metarepo/org-pack",
);

describe("init", () => {
  it("creates a metarepo from the built-in defaults that validates", async () => {
    const root = join(await tempDir(), "shop-meta");
    const r = await init(root, { name: "shop", platform: "shop", openspec: "folders" });
    expect(r.problems).toEqual([]);
    expect(r.openspec).toBe("folders");
    // Hand-written: the files a new metarepo starts with.
    for (const f of [
      "README.md",
      ".gitignore",
      "org-pack/pack.yaml",
      "org-pack/change-types.yaml",
      "org-pack/gates.yaml",
      "org-pack/runtime.yaml",
      "org-pack/sources.yaml",
      "org-pack/test-strategy.yaml",
      "org-pack/profiles/shop/profile.yaml",
      "org-pack/profiles/shop/repos.manifest.yaml",
      "org-pack/checklists/README.md",
      "org-pack/checklists/review.yaml",
      "openspec/config.yaml",
      "openspec/schemas/org-flow/schema.yaml",
      "catalog/generated/README.md",
      "catalog/curated/README.md",
    ])
      expect(r.created, f).toContain(f);
    // roles.yaml is deprecated (ADR 0073): a new metarepo doesn't get one.
    expect(r.created).not.toContain("org-pack/roles.yaml");
    expect(parse(await readFile(join(root, "org-pack/pack.yaml"), "utf8"))).toEqual({
      schemaVersion: 1,
      name: "shop",
      version: "0.1.0",
      owner: "unassigned",
    });
    expect(r.questions).toEqual([
      "Who owns the org pack? Set owner in org-pack/pack.yaml (normally the platform lead).",
    ]);
    const op = await loadOrgPack(join(root, "org-pack"));
    // Written out, not defaulted: a team sees the file it changes.
    expect(op.defaulted).toEqual([]);
    expect(op.gates).toEqual(DEFAULT_GATES);
    expect(parse(await readFile(join(root, "openspec/config.yaml"), "utf8"))).toMatchObject({
      schema: "org-flow",
    });
    const gi = await readFile(join(root, ".gitignore"), "utf8");
    for (const l of ["/workspace/", "/.index/", "/.runs/", "/.atticus/*"]) expect(gi).toContain(l);
    // B-place: the stamp atticus upgrade writes is committed (ADR 0051); the rest of .atticus/ isn't.
    expect(gi).toContain("\n!/.atticus/metarepo.yaml\n");
    expect(gi).not.toMatch(/^\/\.atticus\/$/m);
    // ADR 0120: the starter review, the org's own checklist to change or delete.
    const review = await readFile(join(root, "org-pack/checklists/review.yaml"), "utf8");
    expect(review).toBe(await starterReviewText());
    // AI rules, and the two code checks the product owner moved out of the constitution (2026-10-24).
    expect(
      ChecklistPack.parse(parse(review))
        .rules.filter((r) => r.check.type !== "ai")
        .map((r) => r.id),
    ).toEqual(["review.call-timeout-stated", "review.store-write-rollback"]);
    expect(await readFile(join(root, "org-pack/checklists/README.md"), "utf8")).toContain(
      "`review.yaml` is the starter review",
    );
    const packs = await readPackFiles(root, join(root, "org-pack/checklists"));
    expect(packs.problems).toEqual([]);
    expect(packs.packs.map((p) => [p.pack.name, p.file])).toEqual([
      ["review", "org-pack/checklists/review.yaml"],
    ]);
  });

  it("writes no starter review into an org pack it copies (--pack-from)", async () => {
    const root = join(await tempDir(), "forge-meta");
    const r = await init(root, {
      name: "forge",
      platform: "payments",
      packFrom: FORGE_PACK,
      openspec: "folders",
    });
    expect(r.created).not.toContain("org-pack/checklists/review.yaml");
    expect(await readFile(join(root, "org-pack/checklists/README.md"), "utf8")).not.toContain(
      "starter review",
    );
  });

  it("copies a given org pack and adds the platform profile", async () => {
    const root = join(await tempDir(), "forge-meta");
    const r = await init(root, {
      name: "forge",
      platform: "payments",
      packFrom: FORGE_PACK,
      openspec: "folders",
    });
    expect(r.problems).toEqual([]);
    const op = await loadOrgPack(join(root, "org-pack"));
    expect(op.pack?.name).toBe("forge");
    expect(op.profiles.map((p) => p.platform)).toEqual(["forge", "payments"]);
    expect(op.patterns.length).toBeGreaterThan(0);
    expect(r.questions).toEqual([]);
  });

  it("sets openspec up with the bundled OpenSpec CLI, offline", async () => {
    const root = join(await tempDir(), "cli-meta");
    const r = await init(root, { name: "shop", platform: "shop" });
    expect(r.openspec).toBe("cli");
    expect(await exists(join(root, "openspec/specs"))).toBe(true);
    expect(parse(await readFile(join(root, "openspec/config.yaml"), "utf8"))).toMatchObject({
      schema: "org-flow",
    });
  });

  it("marks the metarepo as an OpenSpec store only when asked (ADR 0126)", async () => {
    const plain = join(await tempDir(), "plain-meta");
    const p = await init(plain, { name: "forge", platform: "forge", openspec: "folders" });
    expect(p.created).not.toContain(".openspec-store/store.yaml");
    expect(p.openspecStore).toBeUndefined();

    const root = join(await tempDir(), "store-meta");
    const r = await init(root, {
      name: "forge.platform",
      platform: "forge",
      openspec: "folders",
      openspecStore: true,
    });
    expect(r.created).toContain(".openspec-store/store.yaml");
    // The org pack's name, made into an id OpenSpec accepts.
    expect(r.openspecStore).toEqual({ id: "forge-platform" });
    expect(await readFile(join(root, ".openspec-store/store.yaml"), "utf8")).toBe(
      "version: 1\nid: forge-platform\n",
    );
    // Committed with the metarepo: the .gitignore doesn't hide it.
    expect(await readFile(join(root, ".gitignore"), "utf8")).not.toMatch(/openspec-store/);
  });

  it("refuses a folder that is already a metarepo, and bad names", async () => {
    const root = join(await tempDir(), "twice");
    await init(root, { name: "shop", platform: "shop", openspec: "folders" });
    await expect(init(root, { name: "shop", platform: "shop" })).rejects.toThrow(AdoptError);
    await expect(
      init(join(await tempDir(), "x"), { name: "Shop Platform", platform: "shop" }),
    ).rejects.toThrow(/lowercase slug/);
  });
});

describe("init makes the metarepo a git repository", () => {
  it("runs git init on main when the folder isn't inside a repository", async () => {
    const root = join(await tempDir(), "forge-meta");
    const r = await init(root, { name: "forge", platform: "forge", openspec: "folders" });
    expect(r.git).toBe("initialised");
    expect(await readFile(join(root, ".git", "HEAD"), "utf8")).toBe("ref: refs/heads/main\n");
    // Git's own files aren't files the metarepo was made with.
    expect(r.created.some((f) => f.startsWith(".git/"))).toBe(false);
  });

  it("leaves a folder inside a repository alone", async () => {
    const outer = await tempDir();
    const calls: string[][] = [];
    const git: GitRunner = async (args) => {
      calls.push(args);
      return { stdout: "", stderr: "" };
    };
    await mkdir(join(outer, ".git"), { recursive: true });
    const r = await init(join(outer, "meta"), {
      name: "forge",
      platform: "forge",
      openspec: "folders",
      git,
    });
    expect(r.git).toBe("inside");
    expect(calls).toEqual([]);
    expect(await exists(join(outer, "meta", ".git"))).toBe(false);
  });

  it("falls back to git init and a main HEAD on a git without -b, and says when git can't run", async () => {
    const calls: string[][] = [];
    const old: GitRunner = async (args) => {
      calls.push(args);
      if (args.includes("-b")) throw new Error("git init failed: unknown switch `b'");
      return { stdout: "", stderr: "" };
    };
    const r = await init(join(await tempDir(), "old-git"), {
      name: "forge",
      platform: "forge",
      openspec: "folders",
      git: old,
    });
    expect(r.git).toBe("initialised");
    expect(calls).toEqual([
      ["init", "-b", "main"],
      ["init"],
      ["symbolic-ref", "HEAD", "refs/heads/main"],
    ]);
    const none = await init(join(await tempDir(), "no-git"), {
      name: "forge",
      platform: "forge",
      openspec: "folders",
      git: async () => {
        throw new Error("spawn git ENOENT");
      },
    });
    expect(none.git).toBe("unavailable");
    expect(none.gitNote).toBe(
      "git didn't run (spawn git ENOENT), so the folder isn't a git repository yet: run git init -b main in it.",
    );
  });
});
