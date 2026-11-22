import { readdir } from "node:fs/promises";
import { factsDirOf, loadOrgPack, orgPackDirOf } from "@maycombhq/core";
import {
  buildCatalog,
  buildPhases,
  curatedDirOf,
  generatedDirOf,
  hashFiles,
  loadBuildInputs,
  readCatalog,
} from "@maycombhq/scanner";

/**
 * Gate 1 of the v31 plan (docs/plan): `atticus selfcheck --timing`. One catalog build in memory,
 * timed phase by phase, after the read of the catalog on disk that each repo's Apply makes
 * first (`writeFactsIntoCatalog`, map-render-commands.ts), then the hash of every record file on
 * disk that the write's guards make (`hashFiles`, build.ts, with `keep: false`: nothing kept is
 * written). That hash is where antivirus and a slow disk show (beta.28.5's field report). The
 * build each Apply runs is this one; Apply to every repo runs one for each repo it applies. The
 * writes themselves are not timed: they write files, and selfcheck writes nothing.
 *
 * Like selfcheck (ADR 0202 point 10) it reads only, sends nothing and prints fixed words and
 * numbers. Phase names are the build's own (`phaseClock`, build-phases.ts), never the estate's.
 * The number of repos with facts is a count of the estate, so it is printed only with `--names`,
 * on screen, and never in `--json`.
 */

export const TIMING_WORDS = {
  head: "atticus selfcheck --timing: one catalog build in memory, timed phase by phase. Nothing was written or sent.",
  notWritten:
    "The writes after a build are not timed here: they write files, and selfcheck writes nothing.",
  apply:
    "Each repo's Apply reads the catalog and runs one build like this, then writes; Apply to every repo runs one for each repo it applies.",
  total: (ms: number, cpuMs: number) => `One build: ${sec(ms)} s wall, ${sec(cpuMs)} s CPU.`,
  repos: (n: number, ms: number) =>
    `Repos with facts: ${n}. Apply to every repo, at one build each: ${roughly(n * ms)}, before the writes.`,
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

const READ_PHASE = "read: the catalog on disk";
const HASH_PHASE = "guards: hash the catalog on disk";

function sec(ms: number): string {
  return (Math.max(0, ms) / 1000).toFixed(1);
}

/** Never to the second: a person plans by it. */
function roughly(ms: number): string {
  if (ms < 45_000) return "under a minute";
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `about ${min} min`;
  const h = Math.floor(min / 60);
  const rest = Math.round((min % 60) / 5) * 5;
  return rest ? `about ${h} h ${rest} min` : `about ${h} h`;
}

const cpuMsNow = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};

/**
 * Times the read and one build. The caller holds the scan lock. The curated decisions are read
 * here, as selfcheck reads them, so the build keeps no parses under .atticus/cache.
 */
export async function timeOneBuild(root: string): Promise<Timing> {
  const phases: PhaseTime[] = [];
  const t0 = performance.now();
  const c0 = cpuMsNow();
  const op = await loadOrgPack(orgPackDirOf(root));
  await readCatalog(generatedDirOf(root));
  phases.push({ phase: READ_PHASE, ms: performance.now() - t0, cpuMs: cpuMsNow() - c0 });
  const t2 = performance.now();
  const c2 = cpuMsNow();
  await hashFiles(generatedDirOf(root), { root, keep: false });
  phases.push({ phase: HASH_PHASE, ms: performance.now() - t2, cpuMs: cpuMsNow() - c2 });
  const ahead = phases.reduce((a, p) => ({ ms: a.ms + p.ms, cpuMs: a.cpuMs + p.cpuMs }), {
    ms: 0,
    cpuMs: 0,
  });

  const before = buildPhases.on;
  buildPhases.on = (phase, ms, cpuMs) => phases.push({ phase, ms, cpuMs });
  const t1 = performance.now();
  const c1 = cpuMsNow();
  try {
    const curated = await readCatalog(curatedDirOf(root, op));
    await buildCatalog(await loadBuildInputs(root, { op, curated: curated.records }));
  } finally {
    if (before) buildPhases.on = before;
    else delete buildPhases.on;
  }
  return {
    phases,
    totalMs: ahead.ms + (performance.now() - t1),
    cpuMs: ahead.cpuMs + (cpuMsNow() - c1),
  };
}

/** The repos with a facts file (`<repo>.jsonl`), as `factsRepos` counts them (verify-commands.ts). */
export async function factsRepoCount(root: string): Promise<number> {
  const side = /\.(questions|reviewed|rejected|corrections)\.jsonl$/;
  const names = await readdir(factsDirOf(root)).catch(() => [] as string[]);
  return names.filter((n) => n.endsWith(".jsonl") && !side.test(n)).length;
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
