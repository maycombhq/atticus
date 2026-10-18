import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { absorb, init, refreshAbsorbed, refreshAllAbsorbed } from "../src/index.js";
import { cleanup, copyFixture, tempDir } from "./helpers.js";

afterAll(cleanup);

/**
 * A linked absorbed source is followed, not copied: refresh fetches it again, rewrites the
 * proposal from what it holds now and says what changed since the last absorb.
 */
describe("refresh an absorbed source", () => {
  async function setup() {
    const root = join(await tempDir(), "shop-meta");
    await init(root, { name: "shop", platform: "shop", openspec: "folders" });
    const src = await copyFixture("critic-prompts", "design-review-src");
    const first = await absorb(root, src, { id: "design-review", mode: "link" });
    return { root, src, first };
  }

  async function change(src: string) {
    const security = join(src, "review/security.yaml");
    await writeFile(
      security,
      (await readFile(security, "utf8")).replace(
        "New third-party libraries pass the dependency scan.",
        "New third-party libraries pass the dependency and licence scans.",
      ),
    );
    await rm(join(src, "review/stories.md"));
    await writeFile(
      join(src, "review/performance-checklist.md"),
      "# Performance review\n\n1. Every new endpoint states its expected load.\n2. Every new query has an index.\n",
    );
  }

  it("re-reads the source, rewrites the proposal and lists what changed", async () => {
    const { root, src, first } = await setup();
    await change(src);
    const r = await refreshAbsorbed(root, "design-review");
    expect(r.from).toBe("proposal");
    expect(r.entry).toMatchObject({ id: "design-review", url: src, mode: "link" });
    expect(r.result.proposal).toBe("proposals/absorb/design-review");
    // What changed in the source, and what that does to the inventory.
    expect(r.source).toEqual({
      added: ["review/performance-checklist.md"],
      removed: ["review/stories.md"],
      changed: ["review/security.yaml"],
    });
    expect(r.items.added).toEqual([
      "critic-rule:review/performance-checklist.md#1",
      "critic-rule:review/performance-checklist.md#2",
    ]);
    expect(r.items.removed).toEqual([
      "critic-rule:review/stories.md#1",
      "critic-rule:review/stories.md#2",
      "critic-rule:review/stories.md#3",
      "critic-rule:review/stories.md#4",
    ]);
    expect(r.items.changed).toEqual([]);
    // Linked rules stay references in the source, so the proposal's files are the same.
    expect(r.files).toEqual({ added: [], removed: [], changed: [] });
    expect(first.items.length).toBe(r.result.items.length + 2);

    // Nothing new since: nothing changed.
    const again = await refreshAbsorbed(root, "design-review");
    expect(again.source).toEqual({ added: [], removed: [], changed: [] });
    expect(again.items).toEqual({ added: [], removed: [], changed: [] });
  });

  it("refreshes every linked source in sources.yaml, and refuses an id it doesn't know", async () => {
    const { root, src } = await setup();
    await writeFile(
      join(root, "org-pack/sources.yaml"),
      stringify({
        schemaVersion: 1,
        absorbed: [{ id: "design-review", url: src, format: "plain", mode: "link" }],
      }),
    );
    await change(src);
    const all = await refreshAllAbsorbed(root);
    expect(all.map((r) => [r.id, r.from])).toEqual([["design-review", "sources.yaml"]]);
    expect(all[0]!.source.changed).toEqual(["review/security.yaml"]);
    await expect(refreshAbsorbed(root, "nobody")).rejects.toThrow(
      "There is no absorbed source nobody: absorb it first with atticus absorb <git-url|path> --id nobody.",
    );
  });
});
