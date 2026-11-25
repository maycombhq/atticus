import { readdir } from "node:fs/promises";
import {
  factsDirOf,
  hashCacheHooks,
  hashCacheWriteProblem,
  listQuestions,
  loadOrgPack,
  orgPackDirOf,
} from "@maycombhq/core";
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
 * join over every repo's facts (`estateFacts`); then one catalog build that never takes the last
 * build whole, because Apply's build always has a new facts slot, but uses its texts as Apply's
 * does (beta.32). With `--names`, how many record files the guards' hash read again: the rest
 * were kept by size and time (hash-cache.ts).
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
  apply:
    "Apply to every repo verifies each repo, then runs these steps and one build for the whole run (since beta.31).",
  total: (ms: number, cpuMs: number) =>
    `One Apply, before its writes: ${sec(ms)} s wall, ${sec(cpuMs)} s CPU.`,
  repos: (n: number) => `Repos with facts: ${n}.`,
  notKept: (code: string) =>
    `The guards' hash couldn't keep what it read (${code}), so every Apply reads every record file again: something holds or blocks the metarepo's .atticus/cache folder (antivirus, a sync tool, its rights).`,
  hashed: (again: number, of: number) =>
    `The guards' hash read ${again} of ${of} record files again; the rest were kept by their size and times.`,
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
  /** The guards' hash: the record files read again, of all. A count of the estate: `--names` only. */
  hashed?: { again: number; of: number };
  /** Item 11: why the kept hashes can't be written (an error code), when they can't. */
  hashCacheWrite?: string;
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
  let again = 0;
  const onHashed = hashCacheHooks.onHashed;
  hashCacheHooks.onHashed = (n) => {
    again += n;
    onHashed?.(n);
  };
  let disk: Awaited<ReturnType<typeof hashFiles>>;
  // Item 11: the hash's own phases (the walk; the stats, reads and sha256) are said too.
  const listening = buildPhases.on;
  buildPhases.on = (phase, ms, cpuMs) => phases.push({ phase, ms, cpuMs });
  try {
    disk = await timed(phases, HASH_PHASE, () =>
      hashFiles(generatedDirOf(root), { root, keep: false }),
    );
  } finally {
    if (onHashed) hashCacheHooks.onHashed = onHashed;
    else delete hashCacheHooks.onHashed;
    if (listening) buildPhases.on = listening;
    else delete buildPhases.on;
  }
  const hashCacheWrite = await hashCacheWriteProblem(root);
  await timed(phases, QUESTIONS_PHASE, () => listQuestions(root));
  await timed(phases, JOIN_PHASE, () => estateFacts(root, op, ""));

  buildPhases.on = (phase, ms, cpuMs) => phases.push({ phase, ms, cpuMs });
  // Apply's build has a new facts slot, so it never takes a kept build whole: nor does this one.
  // But it uses the last build's texts and parses, as Apply's does (beta.32: with the cache off,
  // every record was serialized again, 51 s on the owner's estate that an Apply doesn't spend).
  const wholeWas = buildCacheHooks.wholeOff;
  buildCacheHooks.wholeOff = true;
  try {
    const curated = await readCatalog(curatedDirOf(root, op));
    await buildCatalog(await loadBuildInputs(root, { op, curated: curated.records }));
  } finally {
    if (listening) buildPhases.on = listening;
    else delete buildPhases.on;
    if (wholeWas === undefined) delete buildCacheHooks.wholeOff;
    else buildCacheHooks.wholeOff = wholeWas;
  }
  return {
    phases,
    hashed: { again, of: disk.size },
    ...(hashCacheWrite ? { hashCacheWrite } : {}),
    totalMs: performance.now() - t0,
    cpuMs: cpuMsNow() - c0,
  };
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
    ...(t.hashCacheWrite ? [TIMING_WORDS.notKept(t.hashCacheWrite)] : []),
    ...(repos === undefined
      ? []
      : [
          TIMING_WORDS.repos(repos),
          ...(t.hashed ? [TIMING_WORDS.hashed(t.hashed.again, t.hashed.of)] : []),
        ]),
    TIMING_WORDS.notWritten,
    TIMING_WORDS.apply,
  ];
}
