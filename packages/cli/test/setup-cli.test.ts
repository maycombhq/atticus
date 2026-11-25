import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    // It wasn't inside a git repository: it is one now, on main.
    expect(t.out[1]).toBe(`Made ${dir} a git repository (git init, branch main).`);
    expect(t.out).toContain("OpenSpec is set up with the org-flow schema.");
    // ADR 0006 addendum (2026-10-26), trial problem 1: init writes the slash commands it names
    // below, so /atticus-map works in a fresh metarepo without atticus assistant-files.
    expect(t.out.find((l) => l.startsWith("Your assistant's files"))).toMatch(
      /^Your assistant's files are written \(\d+ of them, \.claude\/commands\/, \.github\/prompts\/, CLAUDE\.md\), so \/atticus-map works here; atticus assistant-files writes them again when the org pack changes\.$/,
    );
    // ADR 0124 §4: the tier the assistant reads a repo at, and where to see the first read's cost;
    // a new metarepo has no probe on file, so it is from runtime.yaml, with the command that
    // measures it (addendum A-probe).
    expect(t.out.at(-2)).toMatch(
      /^Your assistant reads a repo at: agentic \(tier 1\), from runtime\.yaml: .*atticus probe measures it with your assistant\. atticus map <repo> --estimate/,
    );
    // ADR 0201: the starter personas aren't written for the assistants yet; init says how.
    expect(t.out).toContain(
      "The org pack has starter personas and the define-change skill (org-pack/agents/, org-pack/skills/). Write them for Claude and Copilot, with the map tools: atticus skills write.",
    );
    // Atticus 2 reads a repo with the assistant (/atticus-map), not a scan.
    expect(t.out.at(-1)).toBe(
      "Next: atticus repos discover <folder of clones> and atticus workspace sync, then read each repo: /atticus-map <repo> in your assistant (or atticus map <repo>), then atticus verify <repo> --write.",
    );
    const again = io();
    expect(await initCommand(dir, { name: "shop", platform: "shop" }, again.io)).toBe(1);
    expect(again.err[0]).toMatch(/already a metarepo/);
  });

  it("makes it an OpenSpec store too with --openspec-store, and says how to register it (ADR 0126)", async () => {
    const t = io();
    const dir = await temp("forge-meta");
    expect(
      await initCommand(dir, { name: "forge", platform: "forge", openspecStore: true }, t.io),
    ).toBe(0);
    expect(t.out).toContain(
      "It is also the OpenSpec store forge (beta, .openspec-store/store.yaml): once it is pushed, a developer runs openspec store register <their clone> to use it from plain OpenSpec.",
    );
    expect(await readFile(join(dir, ".openspec-store/store.yaml"), "utf8")).toBe(
      "version: 1\nid: forge\n",
    );
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
    expect(t.out).toContain(
      `Next: atticus workspace sync --from "${join(FIXTURES, "plain-multi")}" copies each repo from these clones, with no network.`,
    );
    expect(t.out.at(-1)).toBe("20 questions need a person: proposals/repos/shop/QUESTIONS.md.");
  });

  // Field report (beta.28.3): the folder of every clone, given to add a few, took hours and said
  // nothing. A repo the manifest lists is told by its clone URL and not read; each folder is
  // said as it is come to (progress: a terminal's standard error).
  it("says each folder as it reads it, and lists a repo the manifest has without reading it", async () => {
    const root = await temp("forge-meta");
    await initCommand(root, { name: "forge", platform: "forge" }, io().io);
    const src = join(FIXTURES, "plain-multi");
    await writeFile(
      join(root, "org-pack/profiles/forge/repos.manifest.yaml"),
      `schemaVersion: 3\nplatform: forge\nrepos:\n  - id: ledger\n    url: ${join(src, "ledger-go").replace(/\\/g, "/")}\n    type: go\n    owner: team-ledger\n`,
    );
    const t = io();
    const progress: string[] = [];
    expect(
      await reposDiscoverCommand(
        root,
        { from: src, dryRun: true },
        { ...t.io, progress: (l) => progress.push(l) },
      ),
    ).toBe(0);
    expect(progress).toHaveLength(11);
    expect(progress[0]).toBe("Reading batch-mainframe (1 of 11)…");
    expect(progress[5]).toBe("ledger-go (6 of 11): listed already as ledger, not read.");
    expect(t.out).toContain("  Already listed: ledger-go (ledger)");
    expect(t.out.some((l) => l.startsWith("  ledger-go:"))).toBe(false);
    expect(t.out).toContain("Found 9 repos; nothing written (dry run).");
    // As data too, and no progress line among it.
    const j = io();
    expect(await reposDiscoverCommand(root, { from: src, dryRun: true, json: true }, j.io)).toBe(0);
    expect(JSON.parse(j.out.join("\n")).listed).toEqual([
      { path: "ledger-go", id: "ledger", url: join(src, "ledger-go").replace(/\\/g, "/") },
    ]);
    expect(j.err).toEqual([]);
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
    expect(a.out.join("\n")).toMatch(
      /^Your assistant reads a repo at: agentic \(tier 1\), from runtime\.yaml/m,
    );

    // Other commands against the adopted repo (--root). The org pack validates where it is.
    const v = io();
    expect(await orgPackValidate(join(dir, ".atticus/org-pack"), v.io)).toBe(0);
    // ADR 0210 part 6: no facts yet, so the catalog comes from the readers, turned on.
    await writeFile(
      join(dir, ".atticus/org-pack/conventions.yaml"),
      'schemaVersion: 3\nreaders: "on"\n',
    );
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
