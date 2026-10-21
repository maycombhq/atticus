import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { main } from "../src/main.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const LEDGER = join(HERE, "../../../fixtures/forge/repos/forge-ledger");

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    { cwd, encoding: "utf8" },
  ).trim();

/** A bench of one repo: the invented Forge ledger, served from a local git repo (no network). */
async function bench() {
  const top = await mkdtemp(join(tmpdir(), "atticus-bench-"));
  const origin = join(top, "origin", "forge-ledger");
  await cp(LEDGER, origin, { recursive: true });
  git(origin, "init", "-q");
  git(origin, "add", "-A");
  git(origin, "commit", "-q", "-m", "fixture");
  // Fetching a commit by id from a local repo needs this (GitHub allows it by default).
  git(origin, "config", "uploadpack.allowAnySHA1InWant", "true");
  const commit = git(origin, "rev-parse", "HEAD");
  const dir = join(top, "bench");
  await mkdir(join(dir, "references"), { recursive: true });
  await writeFile(
    join(dir, "repos.yaml"),
    [
      "schemaVersion: 1",
      "repos:",
      "  - id: forge-ledger",
      `    url: ${pathToFileURL(origin).href}`,
      `    commit: ${commit}`,
      "    stack: invented Spring service",
      "    batch: 1",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(dir, "references", "forge-ledger.yaml"),
    [
      "repo: forge-ledger",
      `commit: ${commit}`,
      "covers: [stores]",
      "stores:",
      '  - { table: account, at: "src/main/resources/db/migration/V1__create_account.sql:1" }',
      '  - { table: entry, at: "src/main/resources/db/migration/V2__create_entry.sql:1" }',
      '  - { table: ledger_audit, at: "src/main/resources/db/migration/V2__create_entry.sql:1" }',
      "",
    ].join("\n"),
  );
  return { dir, cache: join(top, "cache"), commit };
}

describe("atticus bench", () => {
  it("fetches each repo at its pinned commit, scans it and scores it against the reference", async () => {
    const b = await bench();
    const args = ["--bench", b.dir, "--cache", b.cache];
    const f = io();
    expect(await main(["bench", "fetch", ...args], f.io), f.err.join("\n")).toBe(0);
    expect(f.out[0]).toBe(`forge-ledger: cloned at ${b.commit.slice(0, 12)}`);
    expect(git(join(b.cache, "forge-ledger"), "rev-parse", "HEAD")).toBe(b.commit);
    // Fetching again leaves a clone at the right commit alone.
    const again = io();
    expect(await main(["bench", "fetch", ...args], again.io)).toBe(0);
    expect(again.out[0]).toBe(`forge-ledger: already at ${b.commit.slice(0, 12)}`);

    const r = io();
    expect(await main(["bench", "run", ...args, "--json"], r.io), r.err.join("\n")).toBe(0);
    const result = JSON.parse(r.out.join("\n")) as {
      repos: { repo: string; kinds: { stores: { found: number; missed: string[] } } }[];
    };
    expect(result.repos).toHaveLength(1);
    expect(result.repos[0]!.kinds.stores).toMatchObject({ found: 2, missed: ["ledger_audit"] });
    expect((await readdir(join(b.cache, "results"))).length).toBe(1);

    const table = io();
    expect(await main(["bench", "run", ...args], table.io)).toBe(0);
    expect(table.out[0]).toMatch(/^REPO\s+FOUND\s+MISSED\s+WRONG\s+PRECISION\s+RECALL$/);
    expect(table.out[1]).toMatch(/^forge-ledger\s+2\s+1\s+0\s+100%\s+67%$/);
  }, 300_000);

  it("skips a repo with no reference or no clone, and refuses a reference for another commit", async () => {
    const b = await bench();
    const args = ["--bench", b.dir, "--cache", b.cache];
    const notFetched = io();
    expect(await main(["bench", "run", ...args], notFetched.io)).toBe(0);
    expect(notFetched.out).toContain(
      `Skipped forge-ledger: not fetched at ${b.commit.slice(0, 12)} (run atticus bench fetch)`,
    );
    expect(await main(["bench", "fetch", ...args], io().io)).toBe(0);
    const ref = join(b.dir, "references", "forge-ledger.yaml");
    await writeFile(ref, (await readFile(ref, "utf8")).replace(b.commit, "f".repeat(40)));
    const wrong = io();
    expect(await main(["bench", "run", ...args], wrong.io)).toBe(2);
    expect(wrong.err[0]).toMatch(/references\/forge-ledger\.yaml is for f{40}, the bench pins/);
    const none = io();
    expect(await main(["bench", "run", ...args, "--repo", "nope"], none.io)).toBe(2);
    expect(none.err[0]).toBe("nope isn't in the bench.");
  }, 300_000);
});
