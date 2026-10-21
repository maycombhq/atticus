import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { MockRuntime } from "@maycombhq/ai";
import { benchVerify } from "../src/bench-commands.js";
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

  it("scans with a repo's saved scan settings (atticus bench survey keeps them in the cache)", async () => {
    const b = await bench();
    const args = ["--bench", b.dir, "--cache", b.cache];
    expect(await main(["bench", "fetch", ...args], io().io)).toBe(0);
    // A setting that leaves out the migrations folder: the scan then finds no tables.
    await mkdir(join(b.cache, "settings"), { recursive: true });
    await writeFile(
      join(b.cache, "settings", "forge-ledger.yaml"),
      [
        "schemaVersion: 1",
        "repo: forge-ledger",
        "exclude:",
        '  - { path: "src/main/resources/db/**", why: test, at: "src/main/resources/db/migration/V1__create_account.sql:1" }',
        "",
      ].join("\n"),
    );
    const r = io();
    expect(await main(["bench", "run", ...args, "--json"], r.io), r.err.join("\n")).toBe(0);
    const result = JSON.parse(r.out.join("\n")) as {
      repos: { repo: string; settings: boolean; kinds: { stores: { found: number } } }[];
    };
    expect(result.repos[0]).toMatchObject({ settings: true, kinds: { stores: { found: 0 } } });
  }, 300_000);

  it("verifies each repo's scan with the assistant, keeps the proposal, and scores what it flagged (ADR 0082)", async () => {
    const b = await bench();
    const args = ["--bench", b.dir, "--cache", b.cache];
    expect(await main(["bench", "fetch", ...args], io().io)).toBe(0);
    // The reference has account and entry; the assistant calls entry wrong (the reference
    // disagrees) and confirms account.
    const runtime = new MockRuntime(
      (req) => {
        const id = (name: string) =>
          new RegExp(`^(\\S+) ${name}\\s+\\(`, "m").exec(req.pack.prompt)![1]!;
        return [
          "wrong:",
          `  - record: ${id("entry")}`,
          '    at: "src/main/resources/db/migration/V2__create_entry.sql:1"',
          "    says: CREATE TABLE entry",
          "    why: made up for the test",
          "    fix: { reader: nothing }",
          `confirmed: [${id("account")}]`,
        ].join("\n");
      },
      { now: () => new Date("2026-10-21T12:00:00Z") },
    );
    const v = io();
    expect(
      await benchVerify({ bench: b.dir, cache: b.cache }, v.io, { runtime }),
      v.err.join("\n"),
    ).toBe(0);
    expect(v.out[0]).toBe(
      "forge-ledger: Checked forge-ledger against its last scan: 0 missed, 1 wrong, 1 confirmed.",
    );
    expect(await readFile(join(b.cache, "verify", "forge-ledger.yaml"), "utf8")).toContain(
      "wrong:",
    );
    const r = io();
    expect(await main(["bench", "run", ...args, "--json"], r.io), r.err.join("\n")).toBe(0);
    const result = JSON.parse(r.out.join("\n")) as { repos: { verifier: unknown }[] };
    expect(result.repos[0]!.verifier).toEqual({
      missed: { flagged: 0, scored: 0, agreed: 0 },
      wrong: { flagged: 1, scored: 1, agreed: 0 },
      precision: 0,
    });
    const table = io();
    expect(await main(["bench", "run", ...args], table.io)).toBe(0);
    expect(table.out).toContainEqual(
      expect.stringMatching(/^forge-ledger\s+0 \(0\)\s+1 \(0\)\s+0%$/),
    );
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

  it("scans an estate's repos together, joins their specs and counts flows reached end to end (ADR 0085)", async () => {
    const ESTATE = join(HERE, "../../../fixtures/estate");
    const top = await mkdtemp(join(tmpdir(), "atticus-bench-estate-"));
    const dir = join(top, "bench");
    const cache = join(top, "cache");
    const lines = ["schemaVersion: 1", "repos:"];
    await mkdir(join(dir, "references"), { recursive: true });
    await mkdir(join(dir, "flows"), { recursive: true });
    for (const id of ["forge-web", "forge-customers"]) {
      const origin = join(top, "origin", id);
      await cp(join(ESTATE, "repos", id), origin, { recursive: true });
      git(origin, "init", "-q");
      git(origin, "add", "-A");
      git(origin, "commit", "-q", "-m", "fixture");
      git(origin, "config", "uploadpack.allowAnySHA1InWant", "true");
      const commit = git(origin, "rev-parse", "HEAD");
      lines.push(
        `  - id: ${id}`,
        `    url: ${pathToFileURL(origin).href}`,
        `    commit: ${commit}`,
        "    stack: invented",
        "    batch: 1",
        "    estate: forge-customers",
      );
      await writeFile(
        join(dir, "references", `${id}.yaml`),
        id === "forge-customers"
          ? `repo: ${id}\ncommit: ${commit}\ncovers: [stores]\nstores:\n  - { table: customers, at: "src/main/resources/schema.sql:1" }\n`
          : `repo: ${id}\ncommit: ${commit}\ncovers: [stores]\nstores: []\n`,
      );
      // The specs drafted for each repo, as atticus bench run keeps them in the cache.
      await cp(join(ESTATE, "specs", id), join(cache, "specs", id), { recursive: true });
    }
    await writeFile(join(dir, "repos.yaml"), lines.join("\n") + "\n");
    await cp(join(ESTATE, "reference.yaml"), join(dir, "flows", "forge-customers.yaml"));
    const args = ["--bench", dir, "--cache", cache];
    expect(await main(["bench", "fetch", ...args], io().io)).toBe(0);
    const r = io();
    expect(
      await main(["bench", "run", ...args, "--specs", "--estate", "forge-customers"], r.io),
    ).toBe(0);
    const result = JSON.parse(
      await readFile(join(cache, "results", (await readdir(join(cache, "results")))[0]!), "utf8"),
    ) as {
      specs: { total: { endToEnd?: { want: number; found: number; reached: string[] } } }[];
      estatePasses: { joins: number; callOuts: number; specsFrom: Record<string, string> }[];
    };
    expect(result.estatePasses[0]).toMatchObject({
      callOuts: 4,
      specsFrom: { "forge-web": "alone", "forge-customers": "alone" },
    });
    // The joint scan resolves the API's entry points; the UI's calls join by path to them.
    expect(result.estatePasses[0]!.joins).toBe(2);
    expect(result.specs[0]!.total.endToEnd).toEqual({
      want: 3,
      found: 2,
      reached: ["save-customer", "view-customer"],
    });
    expect(r.out.join("\n")).toMatch(
      /Estate pass \(ADR 0085\), forge-customers: forge-web, forge-customers scanned together/,
    );
    // The clones are still there after the estate metarepo is made fresh again.
    expect(
      await main(["bench", "run", ...args, "--specs", "--estate", "forge-customers"], io().io),
    ).toBe(0);
    expect(await readdir(join(cache, "forge-web", "src"))).toEqual(["app"]);
  }, 300_000);
});
