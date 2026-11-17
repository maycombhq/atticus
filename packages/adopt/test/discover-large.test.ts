import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CancelledError, withSignal } from "@maycombhq/core";
import {
  cantListMessage,
  init,
  reposDiscover,
  toPosix,
  type DiscoverResult,
} from "../src/index.js";
import { cleanup, fixture, tempDir } from "./helpers.js";

afterAll(cleanup);

// Field report (2.0.0-beta.28.3): "Discover a folder of clones", given the folder of all ~40
// clones to add three new ones, took hours and said nothing. A repo the manifest lists already
// is told by its clone URL before anything of it is read; each folder is announced as it is
// read; a Stop is heard between folders; and one folder that takes too long is skipped, saying
// so, instead of holding the rest.

async function metarepo(): Promise<string> {
  const root = join(await tempDir(), "forge-meta");
  await init(root, { name: "forge", platform: "forge", openspec: "folders" });
  return root;
}

const manifestOf = (root: string) => join(root, "org-pack/profiles/forge/repos.manifest.yaml");

/** A clone as discovery reads one: a build file, .git/config with its origin, and HEAD. */
async function clone(dir: string, name: string, files: Record<string, string>): Promise<string> {
  const at = join(dir, name);
  await mkdir(join(at, ".git"), { recursive: true });
  await writeFile(
    join(at, ".git", "config"),
    `[remote "origin"]\n\turl = https://git.forge.example/forge/${name}.git\n`,
    "utf8",
  );
  await writeFile(join(at, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(at, path, ".."), { recursive: true });
    await writeFile(join(at, path), text, "utf8");
  }
  return at;
}

/** Three Forge clones: two the manifest lists (one by its ssh URL), one new. */
async function estate(): Promise<{ root: string; src: string }> {
  const root = await metarepo();
  const src = join(await tempDir(), "clones");
  await clone(src, "forge-ledger", { "go.mod": "module forge.example/ledger\n" });
  await clone(src, "forge-payments", { "pom.xml": "<project>spring-boot</project>\n" });
  await clone(src, "forge-statements", { "package.json": '{"dependencies":{"react":"18"}}' });
  await writeFile(
    manifestOf(root),
    [
      "schemaVersion: 3",
      "platform: forge",
      "repos:",
      "  - id: ledger",
      "    url: https://git.forge.example/forge/forge-ledger.git",
      "    type: go",
      "    owner: team-ledger",
      // The same repo, as its ssh address.
      "  - id: forge-payments",
      "    url: git@git.forge.example:forge/forge-payments.git",
      "    type: spring-boot",
      "    owner: team-payments",
      "",
    ].join("\n"),
    "utf8",
  );
  return { root, src };
}

/** A clock that moves one tick each time it is read: a folder's cost is how much it is read. */
const ticking = () => {
  let t = 0;
  return () => t++;
};

describe("repos discover over a folder most of whose clones the manifest lists already", () => {
  it("lists a repo the manifest has as already listed, by its clone URL, without reading it", async () => {
    const { root, src } = await estate();
    // No time at all to read a folder: a folder that is read is skipped as too slow, so the two
    // that come back as listed were never read.
    const r = await reposDiscover(
      root,
      { dir: src },
      { dryRun: true, repoTimeoutMs: 0, clock: ticking() },
    );
    expect(r.listed).toEqual([
      {
        path: "forge-ledger",
        id: "ledger",
        url: "https://git.forge.example/forge/forge-ledger.git",
      },
      {
        path: "forge-payments",
        id: "forge-payments",
        url: "https://git.forge.example/forge/forge-payments.git",
      },
    ]);
    expect(r.repos).toEqual([]);
    expect(r.skipped).toEqual([
      {
        path: "forge-statements",
        reason: "took too long to read (over 0 seconds); add it by its clone URL",
      },
    ]);
  });

  it("reads only the new repo, and the proposal adds only it", async () => {
    const { root, src } = await estate();
    const r = await reposDiscover(root, { dir: src });
    expect(r.repos.map((x) => [x.entry.id, x.entry.type, x.entry.url])).toEqual([
      ["forge-statements", "frontend", "https://git.forge.example/forge/forge-statements.git"],
    ]);
    expect(r.listed.map((l) => l.path)).toEqual(["forge-ledger", "forge-payments"]);
    // Questions are about what is added: nobody is asked who owns a repo the manifest has.
    expect([...new Set(r.questions.map((q) => q.repo))]).toEqual(["forge-statements"]);
    expect(r.wrote).toBe("proposal");
    const proposal = await readFile(join(root, r.file!), "utf8");
    expect(proposal.match(/^ {2}- id: /gm)).toHaveLength(3);
    expect(proposal).toContain("id: forge-statements");
  });

  it("also knows the repos another list names (the app's: every platform's manifest)", async () => {
    const { root, src } = await estate();
    const r = await reposDiscover(
      root,
      { dir: src },
      {
        dryRun: true,
        known: [{ id: "statements", url: "https://git.forge.example/forge/forge-statements.git" }],
      },
    );
    expect(r.repos).toEqual([]);
    expect(r.listed.map((l) => [l.path, l.id])).toEqual([
      ["forge-ledger", "ledger"],
      ["forge-payments", "forge-payments"],
      ["forge-statements", "statements"],
    ]);
  });

  it("says each folder as it comes to it, with where it is in the folder", async () => {
    const { root, src } = await estate();
    const said: string[] = [];
    await reposDiscover(
      root,
      { dir: src },
      {
        dryRun: true,
        onFolder: (f) =>
          said.push(`${f.listed ? "listed" : "reading"} ${f.folder} (${f.index} of ${f.total})`),
      },
    );
    expect(said).toEqual([
      "listed forge-ledger (1 of 3)",
      "listed forge-payments (2 of 3)",
      "reading forge-statements (3 of 3)",
    ]);
  });

  it("stops between folders when the job it runs in is stopped", async () => {
    const { root, src } = await estate();
    await writeFile(manifestOf(root), "schemaVersion: 3\nplatform: forge\nrepos: []\n", "utf8");
    const stop = new AbortController();
    const said: string[] = [];
    await expect(
      withSignal(stop.signal, () =>
        reposDiscover(
          root,
          { dir: src },
          {
            onFolder: (f) => {
              said.push(f.folder);
              if (f.index === 2) stop.abort();
            },
          },
        ),
      ),
    ).rejects.toBeInstanceOf(CancelledError);
    // The second was being announced when Stop came: it and the third are never read.
    expect(said).toEqual(["forge-ledger", "forge-payments"]);
    // Nothing written.
    expect(await readFile(manifestOf(root), "utf8")).toBe(
      "schemaVersion: 3\nplatform: forge\nrepos: []\n",
    );
  });

  it("skips one folder that takes too long to read, saying so, and reads the rest", async () => {
    const root = await metarepo();
    const src = join(await tempDir(), "clones");
    await clone(src, "forge-ledger", { "go.mod": "module forge.example/ledger\n" });
    // 400 folders of one file each: far more to walk than the others.
    const many: Record<string, string> = { "pom.xml": "<project>spring-boot</project>\n" };
    for (let i = 0; i < 400; i++) many[`src/p${i}/C${i}.java`] = "class C {}\n";
    await clone(src, "forge-monolith", many);
    await clone(src, "forge-statements", { "package.json": '{"dependencies":{"react":"18"}}' });
    const r = await reposDiscover(
      root,
      { dir: src },
      // 300 looks at the clock a folder: the small ones take a handful.
      { dryRun: true, repoTimeoutMs: 300, clock: ticking() },
    );
    expect(r.repos.map((x) => x.entry.id)).toEqual(["forge-ledger", "forge-statements"]);
    expect(r.skipped).toEqual([
      {
        path: "forge-monolith",
        reason: "took too long to read (over 0.3 seconds); add it by its clone URL",
      },
    ]);
  });
});

// The review (N5): a folder that can't be listed is refused in plain words that name it, never
// a raw file-system error (the app showed "job failed").
describe("repos discover of a folder that can't be listed", () => {
  it("refuses a folder that isn't there, and a file, naming it and why", async () => {
    const root = await metarepo();
    const gone = join(await tempDir(), "no-such-folder");
    await expect(reposDiscover(root, { dir: gone }, { dryRun: true })).rejects.toMatchObject({
      name: "AdoptError",
      code: "not-found",
      message: `The folder ${gone} can't be listed (it isn't there): give a folder of clones that is on this machine.`,
    });
    const file = join(await tempDir(), "notes.txt");
    await writeFile(file, "x", "utf8");
    await expect(reposDiscover(root, { dir: file }, { dryRun: true })).rejects.toMatchObject({
      name: "AdoptError",
      code: "source",
      message: `The folder ${file} can't be listed (it is a file, not a folder): give a folder of clones that is on this machine.`,
    });
  });

  it("says no permission as that, with what to do", () => {
    expect(cantListMessage("/work/clones", "EACCES")).toBe(
      "The folder /work/clones can't be listed (this account isn't allowed to read it): give it read access, or copy the clones to a folder you can read.",
    );
    expect(cantListMessage("/work/clones", "EPERM")).toBe(
      cantListMessage("/work/clones", "EACCES"),
    );
    expect(cantListMessage("/work/clones", "EIO")).toBe(
      "The folder /work/clones can't be listed (the system said EIO): give a folder of clones that is on this machine.",
    );
  });
});

describe("repos discover over a folder of only new repos is as it was", () => {
  /** What the release before read of the plain multi-repo fixture, written by hand. */
  const PLAIN: [string, string][] = [
    ["batch-mainframe", "mainframe"],
    ["billing-net", "dotnet"],
    ["edge-gateway", "gateway"],
    ["event-topics", "event-config"],
    ["ledger-go", "go"],
    ["notify-worker", "node"],
    ["orders-api", "spring-boot"],
    ["platform-infra", "infra"],
    ["pricing-py", "python"],
    ["web-shop", "frontend"],
  ];

  it("finds the same repos, ids, types, URLs, skipped folders and questions", async () => {
    const root = await metarepo();
    const src = fixture("plain-multi");
    const said: string[] = [];
    const r: DiscoverResult = await reposDiscover(
      root,
      { dir: src },
      { dryRun: true, onFolder: (f) => said.push(`${f.folder} ${f.index}/${f.total}`) },
    );
    expect(r.repos.map((x) => [x.entry.id, x.entry.type])).toEqual(PLAIN);
    expect(r.repos.map((x) => x.entry.url)).toEqual(PLAIN.map(([id]) => toPosix(resolve(src, id))));
    expect(r.repos.map((x) => x.dir)).toEqual(PLAIN.map(([id]) => join(src, id)));
    expect(r.listed).toEqual([]);
    expect(r.renamed).toEqual([]);
    expect(r.skipped).toEqual([{ path: "docs", reason: "no build file, code or platform files" }]);
    expect(r.questions).toHaveLength(20);
    // Every folder is announced, the one that isn't a repo too.
    expect(said).toHaveLength(11);
    expect(said[0]).toBe("batch-mainframe 1/11");
    expect(said[10]).toBe("web-shop 11/11");
  });
});
