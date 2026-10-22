import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { init } from "@maycombhq/adopt";
import { Sources } from "@maycombhq/core";
import { sourcesAdd, sourcesSync } from "../src/knowledge-commands.js";

/** ADR 0101: a wiki kept in git, added from the command line and synced into a snapshot. */

const run = promisify(execFile);
function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
}

async function setup() {
  const base = await mkdtemp(join(tmpdir(), "atticus-cli-gitwiki-"));
  const wiki = join(base, "platform.wiki");
  await mkdir(join(wiki, "how-to"), { recursive: true });
  await writeFile(
    join(wiki, "how-to", "request-a-kafka-topic.md"),
    "# Request a Kafka topic\n\nRaise a CTASK in the platform catalogue.\n",
  );
  await run("git", ["init", "-q", "-b", "main"], { cwd: wiki });
  await run("git", ["add", "-A"], { cwd: wiki });
  await run(
    "git",
    ["-c", "user.name=W", "-c", "user.email=w@example.com", "commit", "-q", "-m", "pages"],
    { cwd: wiki },
  );
  const root = join(base, "forge-meta");
  await init(root, { name: "forge", platform: "forge", openspec: "folders" });
  return { base, wiki, root };
}

describe("atticus sources add git", () => {
  it("prints the entry for a git wiki, named after its repository", async () => {
    const { root } = await setup();
    const c = capture();
    expect(
      await sourcesAdd(root, "git", "https://git.example.com/forge/platform.wiki.git", c.io, {
        path: "docs",
      }),
    ).toBe(0);
    expect(c.out[1]).toBe(
      '  - { id: platform, type: git, location: "https://git.example.com/forge/platform.wiki.git", path: docs }',
    );
  });

  it("with --save writes it into sources.yaml, keeping the file's comments, with its tags", async () => {
    const { root, wiki } = await setup();
    const c = capture();
    expect(
      await sourcesAdd(root, "git", wiki, c.io, {
        id: "platform-wiki",
        submodule: false,
        kinds: ["platform-runbook", "change-process"],
        owner: "Platform team",
        save: true,
      }),
    ).toBe(0);
    const text = readFileSync(join(root, "org-pack", "sources.yaml"), "utf8");
    expect(text).toContain("# Where things are and what Atticus reads.");
    const s = Sources.parse(parse(text));
    expect(s.wikis[0]).toMatchObject({
      id: "platform-wiki",
      type: "git",
      checkout: "clone",
      owner: "Platform team",
      tags: { kinds: ["platform-runbook", "change-process"] },
    });
    expect(c.out.join("\n")).toMatch(/commit it through a pull request/);
    expect(c.out.join("\n")).toMatch(/atticus sources sync --source platform-wiki/);
  });
});

describe("atticus sources sync with a git wiki", () => {
  it("clones it, reads its pages and records the commit in the snapshot", async () => {
    const { root, wiki } = await setup();
    await sourcesAdd(root, "git", wiki, capture().io, { id: "platform-wiki", save: true });
    const c = capture();
    await sourcesSync(root, c.io, { now: "2026-10-22T10:00:00Z" });
    expect(c.out.join("\n")).toMatch(/platform-wiki: 1 page read, 0 skipped/);
    expect(c.out.join("\n")).toMatch(/at commit [0-9a-f]{7}/);
    const manifest = parse(
      readFileSync(
        join(root, "knowledge", "snapshots", "platform-wiki", "2026-10-22", "snapshot.yaml"),
        "utf8",
      ),
    ) as { commit?: string; pages: { page: string }[] };
    expect(manifest.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(manifest.pages.map((p) => p.page)).toEqual(["how-to/request-a-kafka-topic.md"]);
  });

  it("says what failed when the repository can't be read, and reads the rest", async () => {
    const { root } = await setup();
    await sourcesAdd(root, "git", join(root, "..", "no-such.wiki"), capture().io, {
      id: "missing",
      save: true,
    });
    const c = capture();
    expect(await sourcesSync(root, c.io, { now: "2026-10-22T10:00:00Z" })).toBe(1);
    expect(c.out.join("\n")).toMatch(
      /missing: 0 pages read[\s\S]*! Can't fetch the git wiki missing/,
    );
  });
});
