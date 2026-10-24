import { cp, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { main } from "../src/main.js";

/**
 * atticus orgpack owner [<handle>] (WP4.4): who looks after the org pack, shown or set in
 * pack.yaml without editing YAML by hand; the rest of the file, its comments included, stays.
 */

const FORGE = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/forge/metarepo");

async function metarepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-orgpack-owner-"));
  await cp(join(FORGE, "org-pack"), join(root, "org-pack"), { recursive: true });
  return root;
}

const run = async (args: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(args, { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.join("\n"), err: err.join("\n") };
};

describe("atticus orgpack owner (WP4.4)", () => {
  it("says who looks after the org pack, and sets it keeping the rest of pack.yaml", async () => {
    const root = await metarepo();
    const before = await readFile(join(root, "org-pack/pack.yaml"), "utf8");
    const shown = await run(["orgpack", "owner", "--root", root]);
    expect(shown.code).toBe(0);
    expect(shown.out).toBe("team-platform looks after the org pack (org-pack/pack.yaml).");
    const set = await run(["orgpack", "owner", "priya.nair", "--root", root]);
    expect(set.code).toBe(0);
    expect(set.out).toContain("priya.nair now looks after the org pack");
    expect(set.out).toContain("Commit org-pack/pack.yaml");
    const after = await readFile(join(root, "org-pack/pack.yaml"), "utf8");
    expect(after).toContain("owner: priya.nair");
    expect(after).toContain("# The Forge org pack (fixture).");
    expect(after.replace("owner: priya.nair", "owner: team-platform")).toBe(before);
  });

  it("refuses a handle with spaces, and says when there is no org pack", async () => {
    const root = await metarepo();
    expect((await run(["orgpack", "owner", "Priya Nair", "--root", root])).code).toBe(2);
    const empty = await mkdtemp(join(tmpdir(), "atticus-orgpack-none-"));
    const none = await run(["orgpack", "owner", "--root", empty]);
    expect(none.code).toBe(2);
    expect(none.err).toMatch(/isn't an Atticus metarepo/);
  });
});
