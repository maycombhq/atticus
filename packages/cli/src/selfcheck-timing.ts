import { readdir } from "node:fs/promises";
import { factsDirOf, listQuestions, loadOrgPack, orgPackDirOf } from "@maycombhq/core";
import {
  buildCacheHooks,
  buildCatalog,
  buildPhases,
  curatedDirOf,
  estateFacts,
  generatedDirOf,
  hashFiles,
  loadBuildInputs,
  readCatalog,
  readCatalogWithFiles,
} from "@maycombhq/scanner";

/**
 * Gate 1 of the v31 plan (docs/plan/v31.md, "Gates, in order"): `atticus selfcheck --timing`.
 * The read-only steps each repo's Apply makes before and around its build
 * (`projectFactsIntoCatalog` and `writeFactsIntoCatalog`, map-render-commands.ts), timed in turn:
 * the org pack; the catalog on disk, read as Apply reads it (`readCatalogWithFiles` with the
 * kept parses, `keep: false`); the hash of every record file that the write's guards make
 * (`hashFiles`, `keep: false`), where antivirus and a slow disk show; the questions; the estate
 * join over every repo's facts (`estateFacts`); then one catalog build with the build cache off,
 * because Apply's build always has a new facts slot and never hits the cache.
 *
 * Not timed: the writes, the guards' other checks and the compare, which write or need a
 * written build; selfcheck writes nothing. So the figure is a floor for one repo's Apply.
 *
 * Like selfcheck (ADR 0202 point 10) it sends nothing and prints fixed words and numbers.
 * Phase names are the build's own string literals (`phaseClock`, build-phases.ts) or this
 * file's, never the estate's. The count of repos with facts is a count of the estate, so it is
 * printed only with `--names`, on screen, and never in `--json`. A failure is one fixed sentence;
 * its message (which can name a path) only with `--names`.
 */

export const TIMING_WORDS = {
  head: "atticus selfcheck --timing: the read-only steps of one repo's Apply and one catalog build, in memory, timed in turn. Nothing was sent.",
  notWritten:
    "Not timed: the writes, the guards' other checks and the compare, which need a written build. The figure is a floor for one repo's Apply.",
  apply: "Apply to every repo runs these steps and one build for each repo it applies.",
  total: (ms: number, cpuMs: number) =>
    `One Apply, before its writes: ${sec(ms)} s wall, ${sec(cpuMs)} s CPU.`,
  repos: (n: number, ms: number) =>
    `Repos with facts: ${n}. Apply to every repo, at that each: at least ${timeWords(n * ms)}.`,
  failed:
    "atticus selfcheck --timing couldn't finish: a step failed. atticus selfcheck --timing --names says why, on this screen only.",
} as const;

export interface PhaseTime {
  phase: string;
  ms: number;
  cpuMs: number;
}
export interface Timing {
  phases: PhaseTime[];
  totalMs: number;
  cpuMs: number;
}

const PACK_PHASE = "read: the org pack";
const READ_PHASE = "read: the catalog on disk";
const HASH_PHASE = "guards: hash the catalog on disk";
const QUESTIONS_PHASE = "read: the questions";
const JOIN_PHASE = "join: every repo's facts";

/** The files beside a repo's facts that are not its facts (`FACTS_SIDE_FILES`, verify-commands.ts). */
export const FACTS_SIDE = /\.(questions|reviewed|rejected|corrections)\.jsonl$/;

function sec(ms: number): string {
  return (Math.max(0, ms) / 1000).toFixed(1);
}

/**
 * Never to the second: a person plans by it. The same words as `timeLeftWords`
 * (verify-commands.ts), which this file doesn't import so as to load nothing of verify; a test
 * holds the two equal.
 */
export function timeWords(ms: number): string {
  if (ms < 45_000) return "under a minute";
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `about ${min} min`;
  const five = Math.round(min / 5) * 5;
  const h = Math.floor(five / 60);
  return five % 60 ? `about ${h} h ${five % 60} min` : `about ${h} h`;
}

const cpuMsNow = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};

/** One step, timed into `phases`. */
async function timed<T>(phases: PhaseTime[], phase: string, f: () => Promise<T>): Promise<T> {
  const t = performance.now();
  const c = cpuMsNow();
  const out = await f();
  phases.push({ phase, ms: performance.now() - t, cpuMs: cpuMsNow() - c });
  return out;
}

/**
 * Times the steps and one build. The caller holds the scan lock. The curated decisions are read
 * here, as selfcheck reads them, so the build keeps no parses under .atticus/cache.
 */
export async function timeOneBuild(root: string): Promise<Timing> {
  const phases: PhaseTime[] = [];
  const t0 = performance.now();
  const c0 = cpuMsNow();
  const op = await timed(phases, PACK_PHASE, () => loadOrgPack(orgPackDirOf(root)));
  await timed(phases, READ_PHASE, () =>
    readCatalogWithFiles(generatedDirOf(root), { cacheRoot: root, keep: false }),
  );
  await timed(phases, HASH_PHASE, () => hashFiles(generatedDirOf(root), { root, keep: false }));
  await timed(phases, QUESTIONS_PHASE, () => listQuestions(root));
  await timed(phases, JOIN_PHASE, () => estateFacts(root, op, ""));

  const listening = buildPhases.on;
  const cacheWas = buildCacheHooks.off;
  buildPhases.on = (phase, ms, cpuMs) => phases.push({ phase, ms, cpuMs });
  // Apply's build has a new facts slot, so it never takes a kept build whole: nor does this one.
  buildCacheHooks.off = true;
  try {
    const curated = await readCatalog(curatedDirOf(root, op));
    await buildCatalog(await loadBuildInputs(root, { op, curated: curated.records }));
  } finally {
    if (listening) buildPhases.on = listening;
    else delete buildPhases.on;
    if (cacheWas === undefined) delete buildCacheHooks.off;
    else buildCacheHooks.off = cacheWas;
  }
  return { phases, totalMs: performance.now() - t0, cpuMs: cpuMsNow() - c0 };
}

/** The repos with a facts file (`<repo>.jsonl`), as `factsRepos` counts them (verify-commands.ts). */
export async function factsRepoCount(root: string): Promise<number> {
  const names = await readdir(factsDirOf(root)).catch(() => [] as string[]);
  return names.filter((n) => n.endsWith(".jsonl") && !FACTS_SIDE.test(n)).length;
}

/** The lines for the screen. `repos` only when the person asked for `--names`. */
export function timingLines(t: Timing, repos?: number): string[] {
  const width = Math.max(...t.phases.map((p) => p.phase.length));
  return [
    TIMING_WORDS.head,
    ...t.phases.map(
      (p) => `  ${p.phase.padEnd(width)}  ${sec(p.ms)} s wall, ${sec(p.cpuMs)} s CPU`,
    ),
    TIMING_WORDS.total(t.totalMs, t.cpuMs),
    ...(repos === undefined ? [] : [TIMING_WORDS.repos(repos, t.totalMs)]),
    TIMING_WORDS.notWritten,
    TIMING_WORDS.apply,
  ];
}
