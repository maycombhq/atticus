import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { absorb, init } from "@maycombhq/adopt";
import { absorbRefreshCommand, sourcesRefreshCommand } from "../src/setup-commands.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../adopt/test/fixtures");

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

describe("atticus absorb --refresh and sources refresh", () => {
  it("fetch a linked source again and show what changed", async () => {
    const base = await mkdtemp(join(tmpdir(), "atticus-refresh-cli-"));
    const root = join(base, "shop-meta");
    await init(root, { name: "shop", platform: "shop", openspec: "folders" });
    const src = join(base, "design-review-src");
    await cp(join(FIXTURES, "critic-prompts"), src, { recursive: true });
    await absorb(root, src, { id: "design-review", mode: "link" });

    const quiet = io();
    expect(await absorbRefreshCommand(root, "design-review", {}, quiet.io)).toBe(0);
    expect(quiet.out).toEqual([
      `Refreshed design-review from ${src}: nothing changed since the last absorb.`,
    ]);

    await rm(join(src, "review/stories.md"));
    const a = io();
    expect(await absorbRefreshCommand(root, "design-review", {}, a.io)).toBe(0);
    expect(a.out).toEqual([
      `Refreshed design-review from ${src}: 0 files added, 1 removed and 0 changed in the source.`,
      "  - review/stories.md",
      "Items: 0 new, 4 gone, 0 with a different action.",
      "  - critic-rule:review/stories.md#1",
      "  - critic-rule:review/stories.md#2",
      "  - critic-rule:review/stories.md#3",
      "  - critic-rule:review/stories.md#4",
      "Rewrote the proposal in proposals/absorb/design-review/; review it as before.",
    ]);

    const none = io();
    expect(await sourcesRefreshCommand(root, {}, none.io)).toBe(0);
    expect(none.out).toEqual(["No linked absorbed sources in sources.yaml; nothing to refresh."]);
    await writeFile(
      join(root, "org-pack/sources.yaml"),
      stringify({
        schemaVersion: 1,
        absorbed: [{ id: "design-review", url: src, format: "plain", mode: "link" }],
      }),
    );
    const all = io();
    expect(await sourcesRefreshCommand(root, {}, all.io)).toBe(0);
    expect(all.out).toEqual([
      `Refreshed design-review from ${src}: nothing changed since the last absorb.`,
    ]);

    const usage = io();
    expect(await absorbRefreshCommand(root, undefined, {}, usage.io)).toBe(2);
  });
});
