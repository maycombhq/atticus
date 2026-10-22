import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { absorb, init } from "@maycombhq/adopt";
import { absorbAcceptCommand } from "../src/setup-commands.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../adopt/test/fixtures");
const made: string[] = [];
afterAll(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true });
});

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

describe("atticus absorb accept", () => {
  it("says what it copied, what stays linked and the entry it added", async () => {
    const base = await mkdtemp(join(tmpdir(), "atticus-accept-cli-"));
    made.push(base);
    const root = join(base, "shop-meta");
    await init(root, { name: "shop", platform: "shop", openspec: "folders" });
    await absorb(root, join(FIXTURES, "critic-prompts"), { id: "design-review" });

    const dry = io();
    expect(await absorbAcceptCommand(root, "design-review", { dryRun: true }, dry.io)).toBe(0);
    expect(dry.out[0]).toMatch(
      /^Would copy 4 files from proposals\/absorb\/design-review\/ into the metarepo; 0 items stay linked\.$/,
    );
    expect(dry.out.at(-1)).toBe(
      "Would add design-review under absorbed: in org-pack/sources.yaml.",
    );

    const run = io();
    expect(await absorbAcceptCommand(root, "design-review", {}, run.io)).toBe(0);
    expect(run.out.slice(1, 5).every((l) => l.startsWith("  org-pack/"))).toBe(true);
    expect(run.out.at(-2)).toBe("Added design-review under absorbed: in org-pack/sources.yaml.");
    expect(run.out.at(-1)).toBe("Commit these through a pull request: merging it is the approval.");

    const again = io();
    expect(await absorbAcceptCommand(root, "design-review", {}, again.io)).toBe(0);
    expect(again.out).toEqual([
      "Copied 0 files from proposals/absorb/design-review/ into the metarepo (4 already there); 0 items stay linked.",
      "org-pack/sources.yaml already lists design-review.",
    ]);
  });

  it("needs an id, and says how to make a proposal that isn't there", async () => {
    const base = await mkdtemp(join(tmpdir(), "atticus-accept-cli-"));
    made.push(base);
    const root = join(base, "shop-meta");
    await init(root, { name: "shop", platform: "shop", openspec: "folders" });
    const none = io();
    expect(await absorbAcceptCommand(root, "", {}, none.io)).toBe(2);
    const missing = io();
    expect(await absorbAcceptCommand(root, "nobody", {}, missing.io)).not.toBe(0);
    expect(missing.err.join("\n")).toContain("atticus absorb <git-url|folder> --id nobody");
  });
});
