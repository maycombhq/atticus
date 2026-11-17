import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Fact } from "@maycombhq/core";
import { repoSpecsHooks } from "@maycombhq/intake";
import { buildCacheHooks } from "@maycombhq/scanner";
import { createGit, type GitRunner } from "@maycombhq/workspace";
import { writeRepoSpecs } from "../src/contract-check-files.js";

/**
 * Beta.28.5, the owner's field report: "writing specs" took 16 s of a write that changed one
 * repo, on a Windows laptop with antivirus. A repo's specs are read at the facts' commit from
 * the clone's git, and every .yaml, .yml, .json, .proto and .avsc file of the commit was read
 * with a `git cat-file` of its own, a process each, to find the few that are specs; and an
 * OpenAPI file was parsed once more for each of its operations. A file read once and found to
 * hold no spec isn't read again while its content (git's id of it) is the same, and a spec file
 * is parsed once. The companion written is the same bytes, and is left alone when unchanged.
 */

const made: string[] = [];
afterAll(async () => {
  delete repoSpecsHooks.onVendorRead;
  delete buildCacheHooks.stamp;
  await Promise.all(made.map((d) => rm(d, { recursive: true, force: true })));
});

const git = (dir: string, ...args: string[]) =>
  execFileSync(
    "git",
    ["-c", "user.name=Forge", "-c", "user.email=forge@example.invalid", ...args],
    { cwd: dir, encoding: "utf8" },
  ).trim();

const OPS = 30;
const spec = (ops = OPS) =>
  [
    "openapi: 3.0.3",
    'info: { title: Ledger, version: "1" }',
    "paths:",
    ...Array.from({ length: ops }, (_, i) => [
      `  /ledger/${i}/{id}:`,
      "    get:",
      "      responses:",
      '        "200":',
      "          description: ok",
    ]).flat(),
    "",
  ].join("\n");

const PROTO =
  'syntax = "proto3";\npackage forge.ledger.v1;\nmessage Posted {\n  string id = 1;\n}\n';

const CONFIGS = 40;

const fact = (commit: string): Fact =>
  ({
    kind: "entry",
    id: "entry.get.ledger-0-id",
    repo: "forge-ledger",
    commit,
    entryType: "rest",
    method: "GET",
    path: "/ledger/0/{id}",
    cite: { file: "src/Ledger.java", line: 3, value: "/ledger/0/{id}" },
    verified: "line",
    by: "assistant",
    conf: "declared",
  }) as Fact;

async function clone() {
  const root = await mkdtemp(join(tmpdir(), "atticus-specs-reads-"));
  made.push(root);
  await mkdir(join(root, "facts"), { recursive: true });
  const dir = join(root, "checkouts", "forge-ledger");
  await mkdir(join(dir, "openapi"), { recursive: true });
  await mkdir(join(dir, "config"), { recursive: true });
  await mkdir(join(dir, "proto"), { recursive: true });
  git(dir, "init", "-q");
  await writeFile(join(dir, "openapi", "ledger.yaml"), spec());
  await writeFile(join(dir, "proto", "posted.proto"), PROTO);
  for (let i = 0; i < CONFIGS; i++)
    await writeFile(
      join(dir, "config", `settings-${i}.${i % 2 ? "json" : "yaml"}`),
      i % 2 ? `{"forge": {"setting": ${i}}}\n` : `forge:\n  setting: ${i}\n`,
    );
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "one");
  return { root, dir, head: git(dir, "rev-parse", "HEAD") };
}

/** The clone's git, counting the files it is asked to read. */
function counting(): { git: GitRunner; reads: string[] } {
  const real = createGit();
  const reads: string[] = [];
  return {
    reads,
    git: (args, cwd, o) => {
      if (args[0] === "cat-file") reads.push(args[2]!.split(":")[1]!);
      return real(args, cwd, o);
    },
  };
}

describe("a repo's specs, read at the facts' commit (beta.28.5)", () => {
  it("reads every candidate file once, then only the files that are specs; the companion is the same bytes and left alone", async () => {
    const { root, dir, head } = await clone();
    const companion = join(root, "facts", "forge-ledger.specs.yaml");
    const first = counting();
    const a = await writeRepoSpecs(root, "forge-ledger", dir, [fact(head)], undefined, first.git);
    expect(a.specs).toHaveLength(OPS + 1);
    expect(a.specs[0]).toMatchObject({ role: "own", entry: "entry.get.ledger-0-id" });
    expect(first.reads).toHaveLength(CONFIGS + 2);
    const bytes = await readFile(companion, "utf8");
    const long = new Date("2026-01-01T00:00:00Z");
    await utimes(companion, long, long);

    const second = counting();
    const b = await writeRepoSpecs(root, "forge-ledger", dir, [fact(head)], undefined, second.git);
    expect(second.reads.sort()).toEqual(["openapi/ledger.yaml", "proto/posted.proto"]);
    expect(b).toEqual(a);
    expect(await readFile(companion, "utf8")).toBe(bytes);
    expect((await stat(companion)).mtimeMs).toBe(long.getTime());
  });

  it("reads a file again once its content is another: a config file that becomes a spec is one", async () => {
    const { root, dir, head } = await clone();
    await writeRepoSpecs(root, "forge-ledger", dir, [fact(head)], undefined, counting().git);
    await writeFile(join(dir, "config", "settings-0.yaml"), spec(2).replaceAll("ledger", "rates"));
    await writeFile(join(dir, "config", "settings-1.json"), '{"forge": {"setting": "other"}}\n');
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "two");
    const next = git(dir, "rev-parse", "HEAD");
    const c = counting();
    const f = await writeRepoSpecs(root, "forge-ledger", dir, [fact(next)], undefined, c.git);
    expect(c.reads.sort()).toEqual([
      "config/settings-0.yaml",
      "config/settings-1.json",
      "openapi/ledger.yaml",
      "proto/posted.proto",
    ]);
    expect(f.specs).toHaveLength(OPS + 1 + 2);
    // And what a read with nothing kept gives.
    const cold = await mkdtemp(join(tmpdir(), "atticus-specs-cold-"));
    made.push(cold);
    await mkdir(join(cold, "facts"), { recursive: true });
    const all = counting();
    expect(
      await writeRepoSpecs(cold, "forge-ledger", dir, [fact(next)], undefined, all.git),
    ).toEqual(f);
    expect(all.reads).toHaveLength(CONFIGS + 2);
    expect(await readFile(join(cold, "facts", "forge-ledger.specs.yaml"), "utf8")).toBe(
      await readFile(join(root, "facts", "forge-ledger.specs.yaml"), "utf8"),
    );
  });

  it("parses an OpenAPI file once for its operations' paths, not once per operation", async () => {
    const { root, dir, head } = await clone();
    let parses = 0;
    repoSpecsHooks.onVendorRead = () => parses++;
    await writeRepoSpecs(root, "forge-ledger", dir, [fact(head)], undefined, counting().git);
    expect(parses).toBe(1);
  });

  // The review of beta.28.5: what is kept is of the code that read (the build cache's stamp),
  // not of the version's name: another build of Atticus reads every file again.
  it("reads every file again under another build of Atticus, and keeps nothing where the code has no stamp", async () => {
    const { root, dir, head } = await clone();
    const reads = async () => {
      const c = counting();
      await writeRepoSpecs(root, "forge-ledger", dir, [fact(head)], undefined, c.git);
      return c.reads.length;
    };
    buildCacheHooks.stamp = "one build";
    expect(await reads()).toBe(CONFIGS + 2);
    expect(await reads()).toBe(2);
    buildCacheHooks.stamp = "another build, the same version";
    expect(await reads()).toBe(CONFIGS + 2);
    expect(await reads()).toBe(2);
    buildCacheHooks.stamp = null;
    expect(await reads()).toBe(CONFIGS + 2);
    expect(await reads()).toBe(CONFIGS + 2);
  });
});
