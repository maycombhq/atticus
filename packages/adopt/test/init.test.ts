import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { DEFAULT_GATES, loadOrgPack } from "@maycombhq/core";
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
    for (const l of ["/workspace/", "/.index/", "/.runs/", "/.atticus/"]) expect(gi).toContain(l);
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

  it("refuses a folder that is already a metarepo, and bad names", async () => {
    const root = join(await tempDir(), "twice");
    await init(root, { name: "shop", platform: "shop", openspec: "folders" });
    await expect(init(root, { name: "shop", platform: "shop" })).rejects.toThrow(AdoptError);
    await expect(
      init(join(await tempDir(), "x"), { name: "Shop Platform", platform: "shop" }),
    ).rejects.toThrow(/lowercase slug/);
  });
});
