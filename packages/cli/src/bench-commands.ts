import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import type { AiRuntime } from "@maycombhq/ai";
import {
  parseReference,
  parseReferenceFlows,
  scoreFacts,
  scoreRepo,
  type FactsScore,
  scoreSpecs,
  scoreVerifier,
  type EstatePassInput,
  type EstateSpecScore,
  type RepoScore,
  type VerifierScore,
} from "@maycombhq/evals";
import {
  parseFacts,
  readEstateJoins,
  readRepoSpec,
  ScanVerifyProposal,
  type CatalogRecord,
  type FlowRecord,
} from "@maycombhq/core";
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
  /**
   * Also score the drafted specs (ADR 0079) against bench/flows/<estate>.yaml; the repos of an
   * estate are also scanned together and joined (the estate pass, ADR 0085).
   */
  specs?: boolean;
  /** Only the repos of this estate. */
  estate?: string;
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
  if (o.estate) {
    repos = repos.filter((r) => r.estate === o.estate);
    if (repos.length === 0)
      throw new BenchError(`No repo of the bench is in the estate ${o.estate}.`);
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
    const scores: (RepoScore & { settings: boolean; verifier?: VerifierScore })[] = [];
    const skipped: string[] = [];
    // For --specs: each repo's catalog and drafted flows, by estate.
    const estates = new Map<
      string,
      { repo: string; flows: FlowRecord[]; records: CatalogRecord[] }[]
    >();
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
      // A spec drafted in the clone (atticus spec draft <clone> --root <clone>) is kept in
      // <cache>/specs/<repo>/ before the clone's .atticus/ is made fresh.
      const drafted = join(path, ".atticus", "specs", r.id);
      if (existsSync(drafted)) {
        await rm(join(cache, "specs", r.id), { recursive: true, force: true });
        await mkdir(join(cache, "specs"), { recursive: true });
        await cp(drafted, join(cache, "specs", r.id), { recursive: true });
      }
      // Atticus's own files are made fresh each run, so the score is of this build.
      await rm(join(path, ".atticus"), { recursive: true, force: true });
      if ((await main(["adopt", path], quiet)) !== 0)
        throw new BenchError(`atticus adopt failed on ${r.id}: run it by hand to see why.`);
      // Settings atticus bench survey drafted for this repo (ADR 0075) are put back each run.
      const saved = await readFile(join(cache, "settings", `${r.id}.yaml`), "utf8").catch(
        () => undefined,
      );
      if (saved !== undefined) {
        await mkdir(join(path, ".atticus", "org-pack", "scan"), { recursive: true });
        await writeFile(join(path, ".atticus", "org-pack", "scan", `${r.id}.yaml`), saved, "utf8");
      }
      if ((await main(["scan", "--root", path], quiet, { quiet: true })) === 2)
        throw new BenchError(`atticus scan failed on ${r.id}: run it by hand to see why.`);
      const { records } = await readCatalog(join(path, ".atticus", "catalog", "generated"));
      // What atticus bench verify flagged on this repo (ADR 0082), judged by the reference.
      const flagged = await readFile(join(cache, "verify", `${r.id}.yaml`), "utf8").then(
        (t) => ScanVerifyProposal.parse(parse(t)),
        () => undefined,
      );
      scores.push({
        ...scoreRepo(ref, records),
        settings: saved !== undefined,
        ...(flagged ? { verifier: scoreVerifier(ref, flagged) } : {}),
      });
      if (o.specs && r.estate) {
        const spec = await readRepoSpec(cache, r.id);
        const list = estates.get(r.estate) ?? [];
        list.push({ repo: r.id, flows: spec.flows, records });
        estates.set(r.estate, list);
      }
    }
    const specScores: EstateSpecScore[] = [];
    const noSpecs: string[] = [];
    const passes: EstatePassNote[] = [];
    for (const [estate, list] of estates) {
      const text = await readFile(join(dir, "flows", `${estate}.yaml`), "utf8").catch(
        () => undefined,
      );
      if (text === undefined) continue;
      if (list.every((x) => x.flows.length === 0)) {
        noSpecs.push(estate);
        continue;
      }
      // The estate pass (ADR 0085): the estate's repos scanned together, so Interfaces join.
      const pass =
        list.length > 1
          ? await estatePass(
              cache,
              estate,
              list.map((x) => x.repo),
              main,
            )
          : undefined;
      if (pass) passes.push(pass.note);
      specScores.push(
        scoreSpecs(
          parseReferenceFlows(text),
          list,
          list.flatMap((x) => x.records),
          pass?.input,
        ),
      );
    }
    const total = scores.reduce(
      (t, s) => ({
        found: t.found + s.total.found,
        missed: t.missed + s.total.missed,
        wrong: t.wrong + s.total.wrong,
      }),
      { found: 0, missed: 0, wrong: 0 },
    );
    const result = {
      at: new Date().toISOString(),
      repos: scores,
      total,
      skipped,
      ...(o.specs ? { specs: specScores, estatePasses: passes } : {}),
    };
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
        `${(s.repo + (s.settings ? " *" : "")).padEnd(26)} ${String(s.total.found).padStart(5)}  ${String(s.total.missed).padStart(6)}  ${String(s.total.wrong).padStart(5)}  ${pct(s.total.precision).padStart(9)}  ${pct(s.total.recall).padStart(6)}`,
      );
    const p = total.found / Math.max(1, total.found + total.wrong);
    const rc = total.found / Math.max(1, total.found + total.missed);
    io.out(
      `${"all".padEnd(26)} ${String(total.found).padStart(5)}  ${String(total.missed).padStart(6)}  ${String(total.wrong).padStart(5)}  ${pct(p).padStart(9)}  ${pct(rc).padStart(6)}`,
    );
    // Fields and config (ADR 0124 §6) are scored where a reference covers them; the baseline in
    // bench/README.md is the four kinds before them.
    if (scores.some((s) => s.kinds.fields || s.kinds.config)) {
      const b = scores.reduce(
        (t, s) => ({
          found: t.found + s.base.found,
          missed: t.missed + s.base.missed,
          wrong: t.wrong + s.base.wrong,
        }),
        { found: 0, missed: 0, wrong: 0 },
      );
      io.out(
        `${"all: serves to deploys".padEnd(26)} ${String(b.found).padStart(5)}  ${String(b.missed).padStart(6)}  ${String(b.wrong).padStart(5)}  ${pct(b.found / Math.max(1, b.found + b.wrong)).padStart(9)}  ${pct(b.found / Math.max(1, b.found + b.missed)).padStart(6)}`,
      );
    }
    if (scores.some((s) => s.settings))
      io.out("* scanned with the scan settings atticus bench survey drafted");
    const judged = scores.filter((s) => s.verifier);
    if (judged.length) {
      io.out("");
      io.out("What atticus bench verify flagged, and how much of it the reference agrees with:");
      io.out("REPO                       MISSED (AGREED)  WRONG (AGREED)  PRECISION");
      const cell = (x: { scored: number; agreed: number }) =>
        `${x.scored} (${x.agreed})`.padStart(15);
      for (const s of judged) {
        const v = s.verifier!;
        io.out(
          `${s.repo.padEnd(26)} ${cell(v.missed)} ${cell(v.wrong)}  ${pct(v.precision).padStart(9)}`,
        );
      }
      io.out(
        "Counted only where the reference covers the kind; MISSED and WRONG are the items the reference can judge.",
      );
    }
    for (const s of skipped) io.out(`Skipped ${s}`);
    if (o.specs) printSpecScores(specScores, noSpecs, passes, cache, io);
    io.out(`Details (what was missed and wrong, per kind): ${file}`);
    return 0;
  } catch (e) {
    return fail(io, e);
  }
}

/**
 * atticus bench facts [<repo>] [--facts file] [--batch n] [--json] (ADR 0124 §6): score the
 * facts an assistant wrote for each bench repo against its reference, with the same matcher and
 * found, missed and wrong as bench run, so the numbers compare with the readers' baseline. A
 * repo's facts are read from --facts (one repo only), else from the clone's own
 * .atticus/facts/<repo>.jsonl (the assistant ran /atticus map in the clone), else from
 * <cache>/facts/<repo>.jsonl. No clone is needed. Writes the scores to <cache>/results/.
 */
export async function benchFactsCommand(
  o: BenchOptions & { facts?: string },
  io: Output,
): Promise<number> {
  try {
    const { dir, cache, repos } = await load(o);
    if (o.facts && repos.length !== 1)
      throw new BenchError(
        "--facts names one repo's file: give the repo too (atticus bench facts <repo> --facts <file>).",
      );
    const scores: FactsScore[] = [];
    const skipped: string[] = [];
    for (const r of repos) {
      const refText = await readFile(join(dir, "references", `${r.id}.yaml`), "utf8").catch(
        () => undefined,
      );
      if (refText === undefined) {
        skipped.push(`${r.id}: no reference yet`);
        continue;
      }
      const ref = parseReference(refText);
      const candidates = o.facts
        ? [resolve(o.facts)]
        : [
            join(cache, r.id, ".atticus", "facts", `${r.id}.jsonl`),
            join(cache, "facts", `${r.id}.jsonl`),
          ];
      const file = candidates.find((f) => existsSync(f));
      if (!file) {
        if (o.facts) throw new BenchError(`There is no facts file at ${candidates[0]}.`);
        skipped.push(`${r.id}: no facts at ${candidates.join(" or ")}`);
        continue;
      }
      const parsed = parseFacts(await readFile(file, "utf8"));
      if (!parsed.ok)
        throw new BenchError(
          `${file} does not read as facts: ${parsed.issues
            .slice(0, 5)
            .map((i) => `${i.line !== undefined ? `line ${i.line}: ` : ""}${i.message}`)
            .join(
              "; ",
            )}${parsed.issues.length > 5 ? ` (and ${parsed.issues.length - 5} more)` : ""}`,
        );
      try {
        scores.push(scoreFacts(ref, parsed.facts));
      } catch (e) {
        throw new BenchError(`${r.id}: ${(e as Error).message}`);
      }
    }
    const sum = (pick: (s: FactsScore) => { found: number; missed: number; wrong: number }) => {
      const t = scores.reduce(
        (a, s) => ({
          found: a.found + pick(s).found,
          missed: a.missed + pick(s).missed,
          wrong: a.wrong + pick(s).wrong,
        }),
        { found: 0, missed: 0, wrong: 0 },
      );
      return {
        ...t,
        precision: t.found / Math.max(1, t.found + t.wrong),
        recall: t.found / Math.max(1, t.found + t.missed),
      };
    };
    const result = {
      at: new Date().toISOString(),
      repos: scores,
      total: sum((s) => s.total),
      base: sum((s) => s.base),
      skipped,
    };
    const out = join(cache, "results");
    await mkdir(out, { recursive: true });
    const saved = join(out, `${result.at.replace(/[:.]/g, "-")}.facts.json`);
    await writeFile(saved, JSON.stringify(result, null, 2) + "\n", "utf8");
    if (o.json) {
      io.out(JSON.stringify(result, null, 2));
      return 0;
    }
    const row = (
      name: string,
      t: { found: number; missed: number; wrong: number },
      facts?: number,
    ) => {
      const p = t.found / Math.max(1, t.found + t.wrong);
      const rc = t.found / Math.max(1, t.found + t.missed);
      return `${name.padEnd(26)} ${(facts === undefined ? "" : String(facts)).padStart(5)}  ${String(t.found).padStart(5)}  ${String(t.missed).padStart(6)}  ${String(t.wrong).padStart(5)}  ${pct(t.wrong + t.found === 0 ? 1 : p).padStart(9)}  ${pct(t.found + t.missed === 0 ? 1 : rc).padStart(6)}`;
    };
    io.out("REPO                       FACTS  FOUND  MISSED  WRONG  PRECISION  RECALL");
    for (const s of scores) {
      io.out(row(s.repo, s.total, s.facts.total));
      for (const [k, v] of Object.entries(s.kinds))
        io.out(row(`  ${k}`, { found: v.found, missed: v.missed.length, wrong: v.wrong.length }));
    }
    io.out(row("all", result.total));
    io.out(row("all: serves to deploys", result.base));
    io.out(
      "The last line counts only serves, calls, stores and deploys, the kinds the readers' baseline in bench/README.md is measured on.",
    );
    for (const s of skipped) io.out(`Skipped ${s}`);
    io.out(`Details (what was missed and wrong, per kind): ${saved}`);
    return 0;
  } catch (e) {
    return fail(io, e);
  }
}

const share = (a: number, b: number) => `${a}/${b} ${pct(b === 0 ? 1 : a / b)}`.padStart(13);

interface EstatePassNote {
  estate: string;
  /** The estate metarepo the repos were scanned together in. */
  root: string;
  repos: string[];
  /** Interfaces the joint scan found between the estate's repos. */
  interfaces: number;
  callOuts: number;
  joins: number;
  /** Where each repo's specs came from: drafted in the estate metarepo, or alone. */
  specsFrom: Record<string, "estate" | "alone" | "none">;
}

/**
 * The estate pass on the bench (ADR 0085): the estate's repos adopted into one metarepo at
 * <cache>/estates/<estate>/ (one org pack; each clone linked in at workspace/<id>), with their
 * saved settings and drafted specs, scanned together so Interfaces join, then joined with
 * atticus estate join. Specs drafted in that metarepo (atticus spec draft
 * <cache>/estates/<estate>/workspace/<id> --root <cache>/estates/<estate>) are kept in
 * <cache>/estate-specs/<estate>/ across runs and used before the ones drafted alone.
 */
async function estatePass(
  cache: string,
  estate: string,
  repos: string[],
  main: typeof import("./main.js").main,
): Promise<{ input: EstatePassInput; note: EstatePassNote }> {
  const quiet: Output = { out: () => {}, err: () => {} };
  const root = join(cache, "estates", estate);
  const kept = join(cache, "estate-specs", estate);
  // Specs drafted in the estate metarepo since the last run are kept before it is made fresh.
  for (const id of repos) {
    const drafted = join(root, ".atticus", "specs", id);
    if (!existsSync(drafted)) continue;
    const same = await readFile(join(drafted, "spec.yaml"), "utf8").catch(() => undefined);
    const alone = await readFile(join(cache, "specs", id, "spec.yaml"), "utf8").catch(
      () => undefined,
    );
    if (same === undefined || same === alone) continue;
    await rm(join(kept, id), { recursive: true, force: true });
    await mkdir(kept, { recursive: true });
    await cp(drafted, join(kept, id), { recursive: true });
  }
  // The links to the clones are removed, never what they point at (rm doesn't follow them).
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  if ((await main(["adopt", root], quiet)) !== 0)
    throw new BenchError(
      `atticus adopt failed on the ${estate} estate: run it by hand to see why.`,
    );
  const profiles = join(root, ".atticus", "org-pack", "profiles");
  const platform =
    (await readdir(profiles, { withFileTypes: true }).catch(() => []))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)[0] ?? "default";
  const entries: Record<string, unknown>[] = [];
  const specsFrom: EstatePassNote["specsFrom"] = {};
  await mkdir(join(root, "workspace"), { recursive: true });
  for (const id of repos) {
    const clone = join(cache, id);
    await symlink(clone, join(root, "workspace", id), "junction");
    // The repo's own manifest entry (from its adoption in place), read where the link is.
    const own = join(clone, ".atticus", "org-pack", "profiles");
    let entry: Record<string, unknown> | undefined;
    for (const p of await readdir(own).catch(() => [] as string[])) {
      const m = await readFile(join(own, p, "repos.manifest.yaml"), "utf8").then(
        (t) => parse(t) as { repos?: Record<string, unknown>[] },
        () => undefined,
      );
      entry = m?.repos?.find((r) => r.id === id) ?? m?.repos?.[0];
      if (entry) break;
    }
    entries.push({
      ...(entry ?? { type: "unknown", owner: "unassigned", defaultBranch: "main" }),
      id,
      url: `./workspace/${id}`,
    });
    const saved = await readFile(join(cache, "settings", `${id}.yaml`), "utf8").catch(
      () => undefined,
    );
    if (saved !== undefined) {
      await mkdir(join(root, ".atticus", "org-pack", "scan"), { recursive: true });
      await writeFile(join(root, ".atticus", "org-pack", "scan", `${id}.yaml`), saved, "utf8");
    }
    const from = existsSync(join(kept, id))
      ? join(kept, id)
      : existsSync(join(cache, "specs", id))
        ? join(cache, "specs", id)
        : undefined;
    specsFrom[id] = !from ? "none" : from.startsWith(kept) ? "estate" : "alone";
    if (from) await cp(from, join(root, ".atticus", "specs", id), { recursive: true });
  }
  await mkdir(join(profiles, platform), { recursive: true });
  await writeFile(
    join(profiles, platform, "repos.manifest.yaml"),
    `# The ${estate} estate of the bench, scanned together (ADR 0085). Written by atticus bench run --specs.\n${stringify({ schemaVersion: 1, platform, repos: entries }, { lineWidth: 0 })}`,
    "utf8",
  );
  if ((await main(["scan", "--root", root], quiet, { quiet: true })) === 2)
    throw new BenchError(
      `atticus scan failed on the ${estate} estate: run atticus scan --root ${root} to see why.`,
    );
  await main(["estate", "join", "--root", root], quiet);
  const { records } = await readCatalog(join(root, ".atticus", "catalog", "generated"), {
    cacheRoot: root,
  });
  const specs: { repo: string; flows: FlowRecord[] }[] = [];
  for (const id of repos)
    specs.push({ repo: id, flows: (await readRepoSpec(root, id, { cacheRoot: root })).flows });
  const joined = await readEstateJoins(root);
  const comps = new Map(
    records
      .filter((r) => r.kind === "Component")
      .map((r) => [r.id, r.kind === "Component" ? r.repo : undefined]),
  );
  const interfaces = records.filter((r) => {
    if (r.kind !== "Interface") return false;
    const a = comps.get(r.from);
    const b = comps.get(r.to);
    return !!a && !!b && a !== b && repos.includes(a) && repos.includes(b);
  }).length;
  return {
    input: { specs, records, joins: joined?.joins ?? [] },
    note: {
      estate,
      root,
      repos,
      interfaces,
      callOuts: (joined?.joins.length ?? 0) + (joined?.unmatched.length ?? 0),
      joins: joined?.joins.length ?? 0,
      specsFrom,
    },
  };
}

/** The drafted specs' scores against the reference flows, one line per estate. */
function printSpecScores(
  scores: EstateSpecScore[],
  none: string[],
  passes: EstatePassNote[],
  cache: string,
  io: Output,
) {
  io.out("");
  if (scores.length) {
    io.out(
      "SPECS (ADR 0079)        TRIGGERS     SEGMENTS        STEPS       TABLES       FIELDS    CITATIONS",
    );
    for (const s of scores) {
      const t = s.total;
      io.out(
        `${s.estate.padEnd(20)} ${share(t.triggersCovered, t.flows)} ${share(t.segmentsCovered, t.segments)} ${share(t.stepsMatched, t.steps)} ${share(t.tables.found, t.tables.want)} ${share(t.fields.found, t.fields.want)} ${share(t.citations.correct, t.citations.checked)}`,
      );
    }
    io.out(
      "Triggers: reference flows whose trigger has a drafted flow; segments: each repo's part of a flow; steps: matched in order; citations: matched steps within 3 lines of the reference's.",
    );
  }
  for (const p of passes) {
    const e2e = scores.find((s) => s.estate === p.estate)?.total.endToEnd;
    io.out("");
    io.out(
      `Estate pass (ADR 0085), ${p.estate}: ${p.repos.join(", ")} scanned together in ${p.root}; ${p.interfaces} Interfaces between them; ${p.joins} of ${p.callOuts} call-outs joined; ${e2e ? `${e2e.found} of ${e2e.want} reference flows that cross repos reached end to end${e2e.reached.length ? ` (${e2e.reached.join(", ")})` : ""}` : "nothing to score"}.`,
    );
    const alone = p.repos.filter((r) => p.specsFrom[r] === "alone");
    if (p.callOuts === 0 && alone.length)
      io.out(
        `  The specs of ${alone.join(", ")} were drafted with each repo scanned alone, so no call-out names another repo. Draft each in the estate, where the other repos are in the catalog: atticus spec draft ${join(p.root, "workspace", "<repo>")} --root ${p.root}, then atticus bench run --specs.`,
      );
  }
  for (const e of none)
    io.out(
      `No drafted specs for ${e} yet: run atticus spec draft <clone> --root <clone> for its repos (clones in ${cache}), then atticus bench run --specs.`,
    );
}

/**
 * atticus bench survey [--repo id] [--batch n] [--mode m]: have the assistant draft each repo's
 * scan settings (atticus scan survey, ADR 0075) and keep them in <cache>/settings/, so every
 * later bench run scans with them. Each repo is one assistant run (or up to three attempts).
 */
export async function benchSurvey(
  o: BenchOptions & { mode?: string },
  io: Output,
): Promise<number> {
  try {
    const { cache, repos } = await load(o);
    const { main } = await import("./main.js");
    const quiet: Output = { out: () => {}, err: () => {} };
    await mkdir(join(cache, "settings"), { recursive: true });
    for (const r of repos) {
      const path = join(cache, r.id);
      if ((await cloneCommit(path)) !== r.commit) {
        io.out(`${r.id}: not fetched at ${r.commit.slice(0, 12)} (run atticus bench fetch)`);
        continue;
      }
      await rm(join(path, ".atticus"), { recursive: true, force: true });
      if ((await main(["adopt", path], quiet)) !== 0)
        throw new BenchError(`atticus adopt failed on ${r.id}: run it by hand to see why.`);
      // The adopted org pack allows hand-off only; the bench may run the assistant headless.
      if (o.mode) {
        const rt = join(path, ".atticus", "org-pack", "runtime.yaml");
        const text = await readFile(rt, "utf8");
        if (!text.includes(`- ${o.mode}`))
          await writeFile(
            rt,
            text.replace(/^(\s+)- hand-off$/m, `$1- hand-off\n$1- ${o.mode}`),
            "utf8",
          );
      }
      const lines: string[] = [];
      const code = await main(
        ["scan", "survey", path, "--root", path, ...(o.mode ? ["--mode", o.mode] : [])],
        { out: (l) => lines.push(l), err: (l) => lines.push(l) },
      );
      const drafted = join(path, ".atticus", "org-pack", "scan", `${r.id}.yaml`);
      const text = code === 0 ? await readFile(drafted, "utf8").catch(() => undefined) : undefined;
      if (text === undefined) {
        io.out(`${r.id}: no settings (${lines.at(-1) ?? "the survey didn't finish"})`);
        continue;
      }
      await writeFile(join(cache, "settings", `${r.id}.yaml`), text, "utf8");
      io.out(`${r.id}: ${lines[0] ?? "settings drafted"}`);
    }
    io.out(`Settings are in ${join(cache, "settings")}. Next: atticus bench run`);
    return 0;
  } catch (e) {
    return fail(io, e);
  }
}

/** The adopted org pack allows hand-off only; the bench may run the assistant headless. */
async function allowMode(path: string, mode: string): Promise<void> {
  const rt = join(path, ".atticus", "org-pack", "runtime.yaml");
  const text = await readFile(rt, "utf8");
  if (!text.includes(`- ${mode}`))
    await writeFile(rt, text.replace(/^(\s+)- hand-off$/m, `$1- hand-off\n$1- ${mode}`), "utf8");
}

/**
 * atticus bench verify [--repo id] [--batch n] [--mode m] (ADR 0082): scan each repo (with its
 * saved settings), have the assistant verify the scan (atticus scan verify), and keep the
 * proposal and findings in <cache>/verify/, so atticus bench run can say how often the
 * reference agrees with what the verifier flagged. `deps.runtime` stands in for the assistant
 * in tests.
 */
export async function benchVerify(
  o: BenchOptions & { mode?: string },
  io: Output,
  deps: { runtime?: AiRuntime; now?: Date } = {},
): Promise<number> {
  try {
    const { cache, repos } = await load(o);
    const { main } = await import("./main.js");
    const quiet: Output = { out: () => {}, err: () => {} };
    await mkdir(join(cache, "verify"), { recursive: true });
    for (const r of repos) {
      const path = join(cache, r.id);
      if ((await cloneCommit(path)) !== r.commit) {
        io.out(`${r.id}: not fetched at ${r.commit.slice(0, 12)} (run atticus bench fetch)`);
        continue;
      }
      await rm(join(path, ".atticus"), { recursive: true, force: true });
      if ((await main(["adopt", path], quiet)) !== 0)
        throw new BenchError(`atticus adopt failed on ${r.id}: run it by hand to see why.`);
      const saved = await readFile(join(cache, "settings", `${r.id}.yaml`), "utf8").catch(
        () => undefined,
      );
      if (saved !== undefined) {
        await mkdir(join(path, ".atticus", "org-pack", "scan"), { recursive: true });
        await writeFile(join(path, ".atticus", "org-pack", "scan", `${r.id}.yaml`), saved, "utf8");
      }
      if (o.mode) await allowMode(path, o.mode);
      if ((await main(["scan", "--root", path], quiet, { quiet: true })) === 2)
        throw new BenchError(`atticus scan failed on ${r.id}: run it by hand to see why.`);
      const lines: string[] = [];
      const capture: Output = { out: (l) => lines.push(l), err: (l) => lines.push(l) };
      let code: number;
      if (deps.runtime) {
        const { scanVerify } = await import("./scan-verify-commands.js");
        code = await scanVerify(
          path,
          path,
          {},
          { runtime: deps.runtime, ...(deps.now ? { now: deps.now } : {}) },
          capture,
        );
      } else
        code = await main(
          ["scan", "verify", path, "--root", path, ...(o.mode ? ["--mode", o.mode] : [])],
          capture,
        );
      const dir = join(path, ".atticus", "proposals", "scan");
      const proposal =
        code === 0
          ? await readFile(join(dir, `${r.id}.yaml`), "utf8").catch(() => undefined)
          : undefined;
      if (proposal === undefined) {
        io.out(`${r.id}: no proposal (${lines.at(-1) ?? "the check didn't finish"})`);
        continue;
      }
      await writeFile(join(cache, "verify", `${r.id}.yaml`), proposal, "utf8");
      const md = await readFile(join(dir, `${r.id}.findings.md`), "utf8").catch(() => undefined);
      if (md !== undefined)
        await writeFile(join(cache, "verify", `${r.id}.findings.md`), md, "utf8");
      io.out(`${r.id}: ${lines[0] ?? "checked"}`);
    }
    io.out(`Proposals are in ${join(cache, "verify")}. Next: atticus bench run`);
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
