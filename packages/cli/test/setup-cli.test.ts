import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { hashTree, MockRepoListing } from "@maycombhq/adopt";
import { createGit } from "@maycombhq/workspace";
import { changeList, changeNew } from "../src/change-commands.js";
import { critic } from "../src/critic-commands.js";
import { orgPackValidate } from "../src/commands.js";
import { main } from "../src/main.js";
import { scanCommand } from "../src/scan-commands.js";
import {
  absorbCommand,
  adoptCommand,
  initCommand,
  reposDiscoverCommand,
  unadoptCommand,
  zeroInstallCommand,
} from "../src/setup-commands.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "../../adopt/test/fixtures");
const made: string[] = [];
afterAll(async () => {
  while (made.length) await rm(made.pop()!, { recursive: true, force: true });
});

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

async function temp(name: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "atticus-setup-cli-"));
  made.push(d);
  return join(d, name);
}

async function copy(fixture: string, as: string): Promise<string> {
  const dir = await temp(as);
  await cp(join(FIXTURES, fixture), dir, { recursive: true });
  return dir;
}

/** Make the copy a Git repo, as an adopted repo is, so `atticus scan` can read its commit. */
async function commit(dir: string) {
  const git = createGit();
  await git(["init", "-q", "-b", "main"], dir);
  await git(["add", "-A"], dir);
  await git(
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-q", "-m", "x"],
    dir,
  );
}

describe("atticus init", () => {
  it("needs a name and a platform", async () => {
    const t = io();
    expect(await initCommand(await temp("m"), {}, t.io)).toBe(2);
    expect(t.err[0]).toMatch(/^Usage: atticus init/);
  });

  it("creates a metarepo and says what to do next", async () => {
    const t = io();
    const dir = await temp("shop-meta");
    expect(await initCommand(dir, { name: "shop", platform: "shop" }, t.io)).toBe(0);
    expect(t.out[0]).toMatch(/^Created the shop metarepo in /);
    expect(t.out).toContain("OpenSpec is set up with the org-flow schema.");
    expect(t.out.at(-1)).toBe(
      "Next: atticus repos discover <folder of clones>, then atticus workspace sync and atticus scan.",
    );
    const again = io();
    expect(await initCommand(dir, { name: "shop", platform: "shop" }, again.io)).toBe(1);
    expect(again.err[0]).toMatch(/already a metarepo/);
  });

  it("names the org pack after the folder's base name, whatever path it is given", async () => {
    const dir = await temp("shop-meta");
    const t = io();
    expect(await main(["init", dir, "--platform", "shop"], t.io)).toBe(0);
    expect(t.err).toEqual([]);
    expect(t.out[0]).toMatch(/^Created the shop-meta metarepo in /);
    // A trailing slash is the same folder.
    const slash = io();
    expect(
      await main(["init", `${await temp("trail-meta")}/`, "--platform", "shop"], slash.io),
    ).toBe(0);
    expect(slash.out[0]).toMatch(/^Created the trail-meta metarepo/);
    // Two inits, each running the OpenSpec CLI twice (about 2 s each on Windows).
  }, 60_000);
});

describe("atticus repos discover", () => {
  it("proposes manifest entries from a folder of clones", async () => {
    const root = await temp("shop-meta");
    await initCommand(root, { name: "shop", platform: "shop" }, io().io);
    const t = io();
    expect(await reposDiscoverCommand(root, { from: join(FIXTURES, "plain-multi") }, t.io)).toBe(0);
    expect(t.out).toContain("  orders-api: spring-boot (pom.xml)");
    expect(t.out).toContain("  Skipped docs: no build file, code or platform files");
    expect(t.out).toContain("Wrote 10 repos to org-pack/profiles/shop/repos.manifest.yaml.");
    expect(t.out.at(-1)).toBe("20 questions need a person: proposals/repos/shop/QUESTIONS.md.");
  });

  it("lists an organisation through a Git host listing, and refuses one without", async () => {
    const root = await temp("shop-meta");
    await initCommand(root, { name: "shop", platform: "shop" }, io().io);
    const none = io();
    expect(await reposDiscoverCommand(root, { org: "shop" }, none.io)).toBe(2);
    const host = new MockRepoListing({
      shop: [
        {
          name: "ledger",
          url: "https://git.example.com/shop/ledger.git",
          files: { "go.mod": "module x" },
        },
      ],
    });
    const t = io();
    expect(await reposDiscoverCommand(root, { org: "shop", host, json: true }, t.io)).toBe(0);
    expect(JSON.parse(t.out.join("\n")).repos[0]).toMatchObject({ id: "ledger", type: "go" });
  });
});

describe("atticus adopt, other commands with --root, and unadopt", () => {
  it("adopts a Spec Kit repo; scan, change, critic and orgpack validate work on it; unadopt restores it", async () => {
    const dir = await copy("speckit-repo", "order-export");
    await commit(dir);
    const before = await hashTree(dir);

    const a = io();
    expect(await adoptCommand(dir, {}, a.io)).toBe(0);
    expect(a.out[0]).toMatch(
      /^Adopted .* in place in \d+\.\d s\. No file of the repo was changed\.$/,
    );
    expect(a.out[1]).toBe(
      "Found Spec Kit (.specify/); a constitution (.specify/memory/constitution.md); prompts in .github/prompts.",
    );
    expect(a.out[2]).toBe("Repos: order-export (node).");

    // Other commands against the adopted repo (--root). The org pack validates where it is.
    const v = io();
    expect(await orgPackValidate(join(dir, ".atticus/org-pack"), v.io)).toBe(0);
    const s = io();
    expect(await scanCommand(dir, {}, s.io)).toBe(0);
    expect(s.out[0]).toMatch(/^Scanned 1 repos/);
    const c = io();
    expect(
      await changeNew(
        dir,
        { title: "Export refunds", type: "feature", by: "pat", id: "export-refunds" },
        c.io,
      ),
    ).toBe(0);
    const l = io();
    expect(await changeList(dir, {}, l.io)).toBe(0);
    expect(l.out.join("\n")).toContain("export-refunds");
    const k = io();
    expect(await critic(dir, "export-refunds", {}, k.io)).toBeLessThan(2);

    // Zero-install files, then remove Atticus: the repo is byte-identical again.
    const z = io();
    expect(await zeroInstallCommand(dir, {}, z.io)).toBe(0);
    const u = io();
    expect(await unadoptCommand(dir, u.io)).toBe(0);
    expect(u.out).toContain("Removed .atticus/");
    expect(u.out.at(-1)).toBe("Atticus is removed; every other file is as it was before adoption.");
    expect(await hashTree(dir)).toEqual(before);
  });

  it("prints JSON and refuses a second adoption", async () => {
    const dir = await copy("openspec-repo", "catalog-service");
    const t = io();
    expect(await adoptCommand(dir, { json: true }, t.io)).toBe(0);
    const j = JSON.parse(t.out.join("\n"));
    expect(j.layout).toEqual({
      openspec: "openspec",
      catalog: ".atticus/catalog",
      skills: [],
      prompts: [],
    });
    expect(j.repos[0]).toMatchObject({ id: "catalog-service", url: ".", type: "spring-boot" });
    const again = io();
    expect(await adoptCommand(dir, {}, again.io)).toBe(1);
    expect(again.err[0]).toMatch(/already adopted/);
    const notAdopted = io();
    expect(await unadoptCommand(await copy("plain-multi", "x"), notAdopted.io)).toBe(1);
  });
});

describe("atticus absorb", () => {
  it("lists every item with its action and writes the proposal", async () => {
    const root = await temp("shop-meta");
    await initCommand(root, { name: "shop", platform: "shop" }, io().io);
    const t = io();
    expect(
      await absorbCommand(root, join(FIXTURES, "critic-prompts"), { id: "design-review" }, t.io),
    ).toBe(0);
    expect(t.out[0]).toMatch(
      /^Absorbed .* as design-review \(plain\): 23 items, 21 adopt, 0 link, 2 ignore\.$/,
    );
    expect(t.out).toContain("Translated 21 of 21 items (100%).");
    expect(t.out.at(-1)).toBe(
      "Wrote the proposal to proposals/absorb/design-review/ (8 files): PR.md is the pull request description; nothing in the org pack was changed.",
    );
    expect(await readFile(join(root, "proposals/absorb/design-review/PR.md"), "utf8")).toContain(
      "# Absorb design-review into the org pack",
    );
  });

  it("checks its arguments", async () => {
    const root = await temp("m");
    expect(await absorbCommand(root, "x", {}, io().io)).toBe(2);
    expect(await absorbCommand(root, "x", { id: "a", mode: "copy" }, io().io)).toBe(2);
    const t = io();
    expect(await absorbCommand(root, join(root, "nope"), { id: "a" }, t.io)).toBe(1);
    expect(t.err[0]).toMatch(/There is no folder or repository/);
  });
});
