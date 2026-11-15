import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseRecord, runsDirOf } from "@maycombhq/core";
import {
  BUILD_MANIFEST_READS,
  buildManifestPath,
  listUndo,
  newerCatalogFiles,
  undoDirOf,
} from "@maycombhq/scanner";
import { startServer, type RunningServer } from "@maycombhq/server";
import { main } from "../src/main.js";
import { NEWER_GUARDED_COMMANDS, NEWER_GUARDED_ROUTES } from "../src/newer-guard.js";
import { extendUiRoutes } from "../src/ui-commands.js";
import { seedReadersSlots } from "./seed-slots.js";

/**
 * Beta.28.2 (ADR 0197, "beta.28.1 and older reading version 2"): beta.28.2 writes
 * catalog/sources/build.json version 2. Every command of this Atticus that would read or write
 * over it (catalog build, verify --write, scan, catalog edits, catalog undo, atticus upgrade,
 * and the app's Apply) refuses with the newer-Atticus words, exits non-zero, writes nothing and
 * takes no undo copy, and never says to run `atticus upgrade`. A version 1 build.json behaves as
 * before. Invented Forge estate (CLAUDE.md rule 3); no network (rule 5).
 */

const VERIFY = join(__dirname, "..", "..", "verify", "test", "fixtures");
const META = join(VERIFY, "metarepo");
const T = 240_000;
const made: string[] = [];
const servers: RunningServer[] = [];
afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()));
  await Promise.all(made.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5 })));
});

/** The newest build.json this Atticus reads (M), and the next one (N), a newer Atticus's. */
const M = BUILD_MANIFEST_READS;
const N = M + 1;
const MESSAGE = (n: number) =>
  `This metarepo's catalog was built by a newer Atticus (build.json version ${n}; this Atticus reads up to ${M}): upgrade Atticus (npm i -g @maycombhq/atticus@beta), don't run \`atticus upgrade\`.`;
/** build.json one version past this Atticus's, in the shape ADR 0197 draws version 2. */
const V2 = `${JSON.stringify(
  {
    version: N,
    buildVersion: "2.0.0-beta.28.2",
    sources: { "catalog/sources/readers/forge-ledger.json": "a".repeat(64) },
    sourceSets: { "0123456789abcdef": ["catalog/sources/readers/forge-ledger.json"] },
    files: [],
  },
  null,
  2,
)}\n`;
/** A newer build.json of a shape nobody knows yet, its version not first. */
const UNKNOWN = `${JSON.stringify({ shards: ["catalog/sources/build/0.json"], version: N + 1 }, null, 2)}\n`;

const run = async (args: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(args, { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.join("\n"), err: err.join("\n") };
};

/** The verify fixtures' metarepo, built once (a version 1 build.json and its undo copy). */
async function metarepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-newer-cli-"));
  made.push(root);
  cpSync(join(META, "org-pack"), join(root, "org-pack"), { recursive: true });
  cpSync(join(META, "catalog"), join(root, "catalog"), { recursive: true });
  cpSync(join(VERIFY, "repo"), join(root, "workspace", "forge-ledger"), { recursive: true });
  const raw = (parse(readFileSync(join(META, "scan-before.yaml"), "utf8")) as object[]).map((x) => {
    const p = parseRecord({ schemaVersion: 2, status: "current", ...x });
    if (!p.ok) throw new Error(JSON.stringify(p.issues));
    return p.record;
  });
  await seedReadersSlots(root, raw);
  mkdirSync(join(root, "facts"), { recursive: true });
  writeFileSync(
    join(root, "facts", "forge-ledger.jsonl"),
    readFileSync(join(VERIFY, "forge-ledger.facts.jsonl"), "utf8"),
  );
  const b = await run(["catalog", "build", "--root", root]);
  expect(b.code, b.err).toBe(0);
  return root;
}

/** Every file of the metarepo with its bytes, but this machine's build cache and build report. */
async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(d: string, rel: string) {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const r = `${rel}${e.name}`;
      // This machine's caches, log and latest build report, none of them the metarepo's.
      if (
        r === ".index/build-cache" ||
        r === ".index/build-report.json" ||
        r === ".atticus/cache" ||
        r === ".atticus/logs"
      )
        continue;
      if (e.isDirectory()) await walk(join(d, e.name), `${r}/`);
      else out[r] = await readFile(join(d, e.name), "utf8");
    }
  }
  await walk(dir, "");
  return out;
}

async function serve(root: string) {
  const s = await startServer({
    root,
    port: 0,
    user: "pat",
    version: "1.0.0",
    extend: (r, ctx) => extendUiRoutes(r, ctx),
  });
  servers.push(s);
  const call = async (path: string, method = "GET", body?: unknown) => {
    const r = await fetch(s.url + path, {
      method,
      headers: {
        "X-Atticus-Token": s.token,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await r.text();
    return { status: r.status, body: (text ? JSON.parse(text) : {}) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any -- a route's JSON, read loosely
  };
  const job = async (path: string, body: unknown = {}) => {
    const started = await call(path, "POST", body);
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    for (let n = 0; n < 1200; n++) {
      const j = await call(`/api/jobs/${String(started.body.jobId)}`);
      if (j.body.state !== "running" && j.body.state !== "queued") return j.body;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`${path} didn't end`);
  };
  return { call, job };
}

/** Never the advice for a catalog from before the slots. */
const notUpgradeAdvice = (text: string) => {
  expect(text).not.toMatch(/written before beta\.27/);
  expect(text).not.toMatch(/run atticus upgrade(?!`)/);
  expect(text).not.toMatch(/atticus upgrade --yes/);
};

describe("a catalog a newer Atticus built is refused by every writer, which writes nothing (ADR 0197)", () => {
  it(
    "build.json one version past this Atticus's: catalog build, verify --write, scan, catalog edits, catalog undo and atticus upgrade refuse in the newer-Atticus words",
    async () => {
      const root = await metarepo();
      await writeFile(buildManifestPath(root), V2);
      const undoDir = await undoDirOf(root);
      const copies = (await listUndo(undoDir)).length;
      const before = await tree(root);
      const r = (...a: string[]) => run([...a, "--root", root]);
      for (const args of [
        ["catalog", "build"],
        ["catalog", "build", "--discard-edits", "3"],
        ["catalog", "build", "--allow-removals", "3"],
        ["catalog", "build", "--check"],
        ["verify", "forge-ledger", "--write"],
        ["scan", "--no-drift"],
        ["catalog", "edits"],
        ["catalog", "edits", "--curate"],
        ["catalog", "undo"],
        ["catalog", "undo", "--yes"],
        ["upgrade"],
        ["upgrade", "--yes"],
        ["upgrade", "--check"],
      ]) {
        const x = await r(...args);
        expect(x.code, `${args.join(" ")}: ${x.err}`).not.toBe(0);
        if (args.includes("--check") && args[0] === "catalog") {
          // --check compares and says the catalog isn't what builds; it still writes nothing.
          continue;
        }
        expect(x.err, args.join(" ")).toContain(MESSAGE(N));
        notUpgradeAdvice(x.err);
      }
      // --json carries the reason a program reads.
      const j = await r("catalog", "build", "--json");
      expect(j.code).toBe(1);
      expect(JSON.parse(j.out).refused).toMatchObject({
        reasons: ["newer-atticus"],
        newer: [{ path: "catalog/sources/build.json", field: "version", version: N, reads: M }],
      });
      for (const args of [
        ["upgrade", "--json"],
        ["catalog", "edits", "--json"],
        ["catalog", "undo", "--yes", "--json"],
      ]) {
        const x = await r(...args);
        expect(x.code).toBe(1);
        expect(JSON.parse(x.out).refused.reasons, args.join(" ")).toEqual(["newer-atticus"]);
      }
      expect(await tree(root)).toEqual(before);
      expect((await listUndo(undoDir)).length).toBe(copies);
    },
    T,
  );

  it(
    "every command-line writer of the build's inputs (curated decisions, corrections, answers, the org pack) refuses before it writes",
    async () => {
      const root = await metarepo();
      await writeFile(buildManifestPath(root), V2);
      const before = await tree(root);
      for (const words of [...NEWER_GUARDED_COMMANDS].map((c) => c.split(" "))) {
        const x = await run([...words, "--root", root]);
        expect(x.code, `${words.join(" ")}: ${x.err}`).toBe(1);
        expect(x.err, words.join(" ")).toContain(`Nothing written: ${MESSAGE(N)}`);
        notUpgradeAdvice(x.err);
        const j = await run([...words, "--json", "--root", root]);
        if (j.code === 1 && j.out.trim().startsWith("{"))
          expect(JSON.parse(j.out).refused.reasons, words.join(" ")).toEqual(["newer-atticus"]);
      }
      expect(await tree(root)).toEqual(before);
    },
    T,
  );

  it(
    "the writers found on the second pass: baseline, catalog migrate, cross-check decisions, name and glossary proposals, the AI's answers and a decide hand-off's Done refuse before they write",
    async () => {
      const root = await metarepo();
      await writeFile(buildManifestPath(root), V2);
      // A Match's hand-off waiting for its Done (its answer becomes the AI's pairings).
      const runDir = join(runsDirOf(root), "match-forge-ledger", "run-20261115000000-0001");
      mkdirSync(runDir, { recursive: true });
      writeFileSync(
        join(runDir, "run.json"),
        `${JSON.stringify({ state: "waiting", request: { agent: "decide-match" } }, null, 2)}\n`,
      );
      const before = await tree(root);
      for (const words of [
        ["baseline"],
        ["catalog", "migrate"],
        ["catalog", "crosscheck", "forge-ledger", "--promote", "x"],
        ["catalog", "crosscheck", "forge-ledger", "--dismiss", "x"],
        ["catalog", "crosscheck", "forge-ledger", "--undismiss", "x"],
        ["feature", "suggest-names"],
        ["glossary", "scan"],
        ["questions", "propose"],
        ["handoff", "done", "run-20261115000000-0001"],
      ]) {
        const x = await run([...words, "--root", root]);
        expect(x.code, `${words.join(" ")}: ${x.err}`).toBe(1);
        expect(x.err, words.join(" ")).toContain(`Nothing written: ${MESSAGE(N)}`);
        notUpgradeAdvice(x.err);
        const j = await run([...words, "--json", "--root", root]);
        expect(j.code, words.join(" ")).toBe(1);
        expect(JSON.parse(j.out).refused.reasons, words.join(" ")).toEqual(["newer-atticus"]);
      }
      // What only reads isn't one of them.
      for (const words of [
        ["catalog", "migrate", "--dry-run"],
        ["catalog", "crosscheck", "forge-ledger"],
      ]) {
        const x = await run([...words, "--root", root]);
        expect(x.err, words.join(" ")).not.toContain(`Nothing written: ${MESSAGE(N)}`);
      }
      expect(await tree(root)).toEqual(before);
    },
    T,
  );

  it(
    "the app's writers found on the second pass: accepting the baseline, call corrections, adding repos to a profile, an org-pack file: 409, nothing written",
    async () => {
      const root = await metarepo();
      await writeFile(buildManifestPath(root), V2);
      const before = await tree(root);
      const { call } = await serve(root);
      for (const [method, path] of [
        ["POST", "/api/baseline"],
        ["POST", "/api/links/corrections"],
        ["POST", "/api/setup/repos"],
        ["PUT", "/api/setup/file"],
      ] as const) {
        expect(NEWER_GUARDED_ROUTES.has(`${method} ${path}`), path).toBe(true);
        const x = await call(path, method, {});
        expect(x.status, path).toBe(409);
        expect(x.body.refused?.reasons, path).toEqual(["newer-atticus"]);
        expect(x.body.detail, path).toContain(MESSAGE(N));
      }
      expect(await tree(root)).toEqual(before);
    },
    T,
  );

  it("each guarded route is one the app's server has", () => {
    const src = join(__dirname, "..", "src");
    const text = readdirSync(src)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => readFileSync(join(src, f), "utf8"))
      .join("\n");
    for (const route of NEWER_GUARDED_ROUTES) {
      const [method, pattern] = route.split(" ") as [string, string];
      // On one line, or with the method and pattern on lines of their own.
      const escaped = pattern.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
      expect(text, route).toMatch(new RegExp(`\\.add\\(\\s*"${method}",\\s*"${escaped}"`));
    }
  });

  it(
    "a branch's own slot written by a newer Atticus is known too",
    async () => {
      const root = await metarepo();
      const dir = join(root, "catalog", "branches", "feature-x", "sources");
      mkdirSync(join(dir, "readers"), { recursive: true });
      writeFileSync(join(dir, "readers", "forge-ledger.json"), '{\n  "slotVersion": 2\n}\n');
      const files = await newerCatalogFiles(root, {
        target: { generated: join(dir, "..", "generated"), manifest: join(dir, "build.json") },
      });
      expect(files.map((f) => f.path)).toEqual([
        "catalog/branches/feature-x/sources/readers/forge-ledger.json",
      ]);
      expect(await newerCatalogFiles(root)).toEqual([]);
    },
    T,
  );

  it(
    "a build.json of an unknown shape, two versions past, is refused the same way",
    async () => {
      const root = await metarepo();
      await writeFile(buildManifestPath(root), UNKNOWN);
      const before = await tree(root);
      for (const args of [
        ["catalog", "build"],
        ["verify", "forge-ledger", "--write"],
        ["upgrade", "--yes"],
      ]) {
        const x = await run([...args, "--root", root]);
        expect(x.code).not.toBe(0);
        expect(x.err).toContain(MESSAGE(N + 1));
        notUpgradeAdvice(x.err);
      }
      expect(await tree(root)).toEqual(before);
    },
    T,
  );

  it(
    "the app: Apply's job and GET /api/build say the reason newer-atticus with the words, and the upgrade is refused (409); nothing written",
    async () => {
      const root = await metarepo();
      await writeFile(buildManifestPath(root), V2);
      const before = await tree(root);
      const { call } = await serve(root);
      const applied = await call("/api/facts/forge-ledger/apply", "POST", {});
      expect(applied.status).toBe(409);
      expect(applied.body.refused).toMatchObject({ reasons: ["newer-atticus"] });
      expect(applied.body.refused.message).toContain(MESSAGE(N));
      const view = await call("/api/build");
      expect(view.status).toBe(200);
      expect(view.body.pending.refused.reasons).toEqual(["newer-atticus"]);
      expect(view.body.upgrade).toBeUndefined();
      // Every writer of the build's inputs: 409 with the refusal, before its body is read.
      for (const route of NEWER_GUARDED_ROUTES) {
        const [method, pattern] = route.split(" ") as [string, string];
        const path = pattern
          .replace(/\{repo\}|\{repoId\}/g, "forge-ledger")
          .replace(/\{[^}]+\}/g, "x");
        const x = await call(path, method, {});
        expect(x.status, route).toBe(409);
        expect(x.body.refused?.reasons, route).toEqual(["newer-atticus"]);
        expect(x.body.detail, route).toContain(MESSAGE(N));
      }
      const up = await call("/api/upgrade", "POST", {});
      expect(up.status).toBe(409);
      expect(JSON.stringify(up.body)).toContain("built by a newer Atticus");
      const preview = await call("/api/facts/forge-ledger/preview");
      if (preview.status === 200 && preview.body.preview?.confirm)
        expect(preview.body.preview.confirm.refused).toEqual(["newer-atticus"]);
      expect(await tree(root)).toEqual(before);
    },
    T,
  );

  it(
    "a version 1 build.json behaves exactly as before: the build is up to date, Apply waits for its removals",
    async () => {
      const root = await metarepo();
      const c = await run(["catalog", "build", "--check", "--root", root]);
      expect(c.code, c.out + c.err).toBe(0);
      const v = await run(["verify", "forge-ledger", "--write", "--json", "--root", root]);
      expect(v.err).not.toContain("newer Atticus");
      const u = await run(["upgrade", "--check", "--root", root]);
      expect(u.err).not.toContain("newer Atticus");
    },
    T,
  );
});
