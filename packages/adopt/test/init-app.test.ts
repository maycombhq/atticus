import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { loadOrgPack, Runtime, RUNTIME_SCHEMA_VERSION } from "@maycombhq/core";
import type { GitRunner } from "@maycombhq/workspace";
import { init, metarepoIdFromUrl } from "../src/index.js";
import { cleanup, tempDir } from "./helpers.js";

/**
 * ADR 0190: a metarepo made from the app is ready for its first hand-off and for AI decides:
 * runtime.yaml at the current version, the Git host manual, and the metarepo's id on the host
 * when it is known (given, or from the clone's origin).
 */

afterAll(cleanup);

const runtimeOf = async (root: string) =>
  Runtime.parse(parse(await readFile(join(root, "org-pack/runtime.yaml"), "utf8")));

describe("init for the app", () => {
  it("writes runtime.yaml at the current version with a manual Git host", async () => {
    const root = join(await tempDir(), "forge-payments");
    const r = await init(root, { name: "forge-payments", platform: "forge", openspec: "folders" });
    expect(r.problems).toEqual([]);
    const rt = await runtimeOf(root);
    expect(rt.schemaVersion).toBe(RUNTIME_SCHEMA_VERSION);
    expect(rt.adapters.gitHost).toEqual({ type: "manual", settings: {} });
    // The org pack reads it as written: the Git host is set, so a hand-off is a step for a person.
    expect((await loadOrgPack(join(root, "org-pack"))).problems).toEqual([]);
    const text = await readFile(join(root, "org-pack/runtime.yaml"), "utf8");
    expect(text).toContain("gitHost: manual");
  });

  it("names the metarepo on the Git host when given", async () => {
    const root = join(await tempDir(), "meta");
    await init(root, {
      name: "forge-payments",
      platform: "forge",
      openspec: "folders",
      metarepo: "forge-metarepo",
    });
    expect((await runtimeOf(root)).adapters.gitHost).toEqual({
      type: "manual",
      settings: { metarepo: "forge-metarepo" },
    });
  });

  it("takes the metarepo's id from the clone's origin, asked of Git (local)", async () => {
    // A clone of the metarepo's (empty) repo on the host: inside a repository already.
    const root = join(await tempDir(), "clone");
    await mkdir(join(root, ".git"), { recursive: true });
    const asked: string[][] = [];
    const git: GitRunner = async (args) => {
      asked.push(args);
      if (args.join(" ") === "config --get remote.origin.url")
        return {
          stdout: "https://priya@dev.azure.com/forgeorg/Forge%20Payments/_git/forge-metarepo\n",
          stderr: "",
        };
      return { stdout: "", stderr: "" };
    };
    await init(root, { name: "forge-payments", platform: "forge", openspec: "folders", git });
    expect(asked).toContainEqual(["config", "--get", "remote.origin.url"]);
    expect((await runtimeOf(root)).adapters.gitHost?.settings).toEqual({
      metarepo: "forge-metarepo",
    });
  });
});

describe("the metarepo's id on the Git host, from a clone URL", () => {
  it.each([
    ["https://dev.azure.com/forgeorg/Forge%20Payments/_git/forge-metarepo", "forge-metarepo"],
    [
      "https://dev.azure.com/forgeorg/Forge%20Payments/_git/forge-metarepo?path=/",
      "forge-metarepo",
    ],
    ["https://github.com/forge/forge-metarepo.git", "forge/forge-metarepo"],
    ["git@github.com:forge/forge-metarepo.git", "forge/forge-metarepo"],
    ["https://gitlab.forge.example/payments/forge-metarepo/", "payments/forge-metarepo"],
    ["/srv/git/forge-metarepo.git", "forge-metarepo"],
    ["C:\\git\\forge-metarepo.git", "forge-metarepo"],
  ])("%s is %s", (url, id) => {
    expect(metarepoIdFromUrl(url)).toBe(id);
  });
  it("has none for an empty URL", () => expect(metarepoIdFromUrl("  ")).toBeUndefined());
});
