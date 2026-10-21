import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { parseReference, scoreRepo, type RepoScore } from "@maycombhq/evals";
import { readCatalog } from "@maycombhq/scanner";
import type { Output } from "./commands.js";

/**
 * atticus bench (revamp plan, Phase 1): clone the bench's public repos at their pinned
 * commits, adopt and scan each with Atticus itself, and score the scan against the
 * reference a person wrote. Clones live outside the Atticus checkout, so lint and the
 * deny-list never read third-party code.
 */

const Manifest = z.strictObject({
  schemaVersion: z.literal(1),
  repos: z.array(
    z.strictObject({
      id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
      url: z.string().url(),
      commit: z.string().regex(/^[0-9a-f]{40}$/),
      stack: z.string(),
      batch: z.number().int().positive(),
      estate: z.string().optional(),
    }),
  ),
});
type BenchRepo = z.infer<typeof Manifest>["repos"][number];

export interface BenchOptions {
  /** The bench folder (repos.yaml, references/); default ./bench. */
  bench?: string;
  /** Where clones go; default %LOCALAPPDATA%/atticus/bench or ~/.cache/atticus/bench. */
  cache?: string;
  repo?: string;
  batch?: number;
  json?: boolean;
}

const defaultCache = () =>
  process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "atticus", "bench")
    : join(homedir(), ".cache", "atticus", "bench");

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((done, fail) =>
    execFile(
      "git",
      ["-c", "core.hooksPath=.no-hooks", ...args],
      { cwd, timeout: 600_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (e, out, err) =>
        e ? fail(new Error(`git ${args[0]}: ${err.trim() || e.message}`)) : done(out),
    ),
  );
}

async function load(o: BenchOptions): Promise<{ dir: string; cache: string; repos: BenchRepo[] }> {
  const dir = resolve(o.bench ?? "bench");
  const text = await readFile(join(dir, "repos.yaml"), "utf8").catch(() => undefined);
  if (text === undefined) throw new BenchError(`There is no bench at ${dir}: it needs repos.yaml.`);
  const m = Manifest.safeParse(parse(text));
  if (!m.success)
    throw new BenchError(
      `${join(dir, "repos.yaml")}: ${m.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  let repos = m.data.repos;
  if (o.repo) {
    repos = repos.filter((r) => r.id === o.repo);
    if (repos.length === 0) throw new BenchError(`${o.repo} isn't in the bench.`);
  }
  if (o.batch) repos = repos.filter((r) => r.batch <= o.batch!);
  return { dir, cache: resolve(o.cache ?? defaultCache()), repos };
}

class BenchError extends Error {}

const fail = (io: Output, e: unknown) => {
  if (e instanceof BenchError) {
    io.err(e.message);
    return 2;
  }
  throw e;
};

/** The commit a clone has checked out, or undefined if there's no clone. */
async function cloneCommit(path: string): Promise<string | undefined> {
  if (!existsSync(join(path, ".git"))) return undefined;
  return (await git(path, ["rev-parse", "HEAD"]).catch(() => "")).trim() || undefined;
}

/** atticus bench fetch [--repo id] [--batch n] [--cache dir]: clone each repo at its pinned commit. */
export async function benchFetch(o: BenchOptions, io: Output): Promise<number> {
  try {
    const { cache, repos } = await load(o);
    await mkdir(cache, { recursive: true });
    for (const r of repos) {
      const path = join(cache, r.id);
      if ((await cloneCommit(path)) === r.commit) {
        io.out(`${r.id}: already at ${r.commit.slice(0, 12)}`);
        continue;
      }
      // A clone at another commit (the bench was re-pinned) is replaced whole.
      await rm(path, { recursive: true, force: true });
      await mkdir(path, { recursive: true });
      await git(path, ["init", "-q"]);
      await git(path, ["remote", "add", "origin", r.url]);
      await git(path, ["fetch", "-q", "--depth", "1", "origin", r.commit]);
      await git(path, ["checkout", "-q", "FETCH_HEAD"]);
      io.out(`${r.id}: cloned at ${r.commit.slice(0, 12)}`);
    }
    io.out(`Clones are in ${cache}. Next: atticus bench run`);
    return 0;
  } catch (e) {
    return fail(io, e);
  }
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/**
 * atticus bench run [--repo id] [--batch n] [--json]: adopt and scan each fetched repo with this
 * Atticus, then score it against its reference. Writes the scores to <cache>/results/.
 */
export async function benchRun(o: BenchOptions, io: Output): Promise<number> {
  try {
    const { dir, cache, repos } = await load(o);
    const { main } = await import("./main.js");
    const quiet: Output = { out: () => {}, err: () => {} };
    const scores: RepoScore[] = [];
    const skipped: string[] = [];
    for (const r of repos) {
      const path = join(cache, r.id);
      const refText = await readFile(join(dir, "references", `${r.id}.yaml`), "utf8").catch(
        () => undefined,
      );
      if (refText === undefined) {
        skipped.push(`${r.id}: no reference yet`);
        continue;
      }
      if ((await cloneCommit(path)) !== r.commit) {
        skipped.push(`${r.id}: not fetched at ${r.commit.slice(0, 12)} (run atticus bench fetch)`);
        continue;
      }
      const ref = parseReference(refText);
      if (ref.commit !== r.commit)
        throw new BenchError(
          `references/${r.id}.yaml is for ${ref.commit}, the bench pins ${r.commit}.`,
        );
      // Atticus's own files are made fresh each run, so the score is of this build.
      await rm(join(path, ".atticus"), { recursive: true, force: true });
      if ((await main(["adopt", path], quiet)) !== 0)
        throw new BenchError(`atticus adopt failed on ${r.id}: run it by hand to see why.`);
      if ((await main(["scan", "--root", path], quiet, { quiet: true })) === 2)
        throw new BenchError(`atticus scan failed on ${r.id}: run it by hand to see why.`);
      const { records } = await readCatalog(join(path, ".atticus", "catalog", "generated"));
      scores.push(scoreRepo(ref, records));
    }
    const total = scores.reduce(
      (t, s) => ({
        found: t.found + s.total.found,
        missed: t.missed + s.total.missed,
        wrong: t.wrong + s.total.wrong,
      }),
      { found: 0, missed: 0, wrong: 0 },
    );
    const result = { at: new Date().toISOString(), repos: scores, total, skipped };
    const out = join(cache, "results");
    await mkdir(out, { recursive: true });
    const file = join(out, `${result.at.replace(/[:.]/g, "-")}.json`);
    await writeFile(file, JSON.stringify(result, null, 2) + "\n", "utf8");
    if (o.json) {
      io.out(JSON.stringify(result, null, 2));
      return 0;
    }
    io.out("REPO                       FOUND  MISSED  WRONG  PRECISION  RECALL");
    for (const s of scores)
      io.out(
        `${s.repo.padEnd(26)} ${String(s.total.found).padStart(5)}  ${String(s.total.missed).padStart(6)}  ${String(s.total.wrong).padStart(5)}  ${pct(s.total.precision).padStart(9)}  ${pct(s.total.recall).padStart(6)}`,
      );
    const p = total.found / Math.max(1, total.found + total.wrong);
    const rc = total.found / Math.max(1, total.found + total.missed);
    io.out(
      `${"all".padEnd(26)} ${String(total.found).padStart(5)}  ${String(total.missed).padStart(6)}  ${String(total.wrong).padStart(5)}  ${pct(p).padStart(9)}  ${pct(rc).padStart(6)}`,
    );
    for (const s of skipped) io.out(`Skipped ${s}`);
    io.out(`Details (what was missed and wrong, per kind): ${file}`);
    return 0;
  } catch (e) {
    return fail(io, e);
  }
}

/** The repos a bench folder lists, for tests and the docs. */
export async function benchRepos(o: BenchOptions): Promise<string[]> {
  return (await load(o)).repos.map((r) => r.id);
}

/** Result files, newest first. */
export async function benchResults(o: BenchOptions): Promise<string[]> {
  const out = join(resolve(o.cache ?? defaultCache()), "results");
  return (await readdir(out).catch(() => [] as string[]))
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse();
}
