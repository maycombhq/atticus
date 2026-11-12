import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { Cmd, commandArbs, GENERATED, prefixArb, stats, type Ctx, type Desc } from "./commands.js";
import { POOL, estateArb, type Code, type Estate } from "./estate.js";
import {
  INVARIANTS,
  InvariantError,
  KNOWN_FAILURES,
  settleAndCompare,
  type Invariant,
} from "./invariants.js";
import { changedPaths, World } from "./world.js";

export const REGRESSIONS = join(dirname(fileURLToPath(import.meta.url)), "regressions");

/** The test file, for a replay's `-t` filter and path. */
export const TEST_FILE = "test/properties/catalog-properties.test.ts";

/**
 * How many sequences, how long, from which seed, checking which invariants (ADR 0195 point 10):
 * 100 sequences of up to 10 commands in `pnpm check`, 2,000 of up to 20 in the nightly job.
 * Every run prints its seed; a failure prints a `Replay:` line that runs it again exactly.
 *
 * - ATTICUS_PROPERTIES_RUNS, _MAX_COMMANDS: the count and the length.
 * - ATTICUS_PROPERTIES_SEED, _PATH, _COMMANDS: a seed, fast-check's path and its replay path.
 * - ATTICUS_PROPERTIES_INVARIANTS=all (or a comma list) checks known failures too.
 * - ATTICUS_PROPERTIES_RECORD=1 writes a failing run's shrunk counterexample to regressions/.
 * - ATTICUS_PROPERTIES_VERBOSE=1 prints, per command, how often it ran and acted and its time.
 */
export function settings() {
  const env = process.env;
  const runs = Number(env.ATTICUS_PROPERTIES_RUNS ?? 100);
  const maxCommands = Number(env.ATTICUS_PROPERTIES_MAX_COMMANDS ?? 10);
  const seed = env.ATTICUS_PROPERTIES_SEED
    ? Number(env.ATTICUS_PROPERTIES_SEED)
    : Date.now() % 2 ** 31;
  const path = env.ATTICUS_PROPERTIES_PATH || undefined;
  // fast-check replays a command sequence from its own path too (fc.commands' replayPath).
  const commands = env.ATTICUS_PROPERTIES_COMMANDS || undefined;
  const asked = env.ATTICUS_PROPERTIES_INVARIANTS;
  const enabled = new Set<Invariant>(
    !asked
      ? INVARIANTS.filter((i) => !KNOWN_FAILURES.has(i))
      : asked === "all"
        ? INVARIANTS
        : (asked.split(",").map((s) => s.trim()) as Invariant[]),
  );
  return {
    runs,
    maxCommands,
    seed,
    path,
    commands,
    asked,
    enabled,
    record: env.ATTICUS_PROPERTIES_RECORD === "1",
    verbose: env.ATTICUS_PROPERTIES_VERBOSE === "1",
  };
}

/** A shrunk counterexample, as committed under regressions/. */
export interface Recorded {
  invariant: Invariant;
  /** What it shows, in a line. */
  note: string;
  seed?: number;
  estate: { repos: { base: string; code: Code }[] };
  commands: Desc[];
}

export function estateOf(r: Recorded["estate"]): Estate {
  return {
    repos: r.repos.map((x) => ({ base: POOL.find((b) => b.id === x.base)!, code: x.code })),
  };
}

export function recordedOf(e: Estate): Recorded["estate"] {
  return { repos: e.repos.map((r) => ({ base: r.base.id, code: r.code })) };
}

export function loadRegressions(): Recorded[] {
  let files: string[];
  try {
    files = readdirSync(REGRESSIONS).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  return files
    .sort()
    .map((f) => JSON.parse(readFileSync(join(REGRESSIONS, f), "utf8")) as Recorded);
}

/**
 * Run one sequence on a fresh metarepo: the prefix's commands (a beta.26 metarepo and its
 * upgrade, or none), then `cmds`, checking `enabled` after each, then what is pending settled
 * and the catalog compared with a fresh build.
 */
export async function runSequence(
  estate: Estate,
  prefix: Desc[],
  cmds: Iterable<fc.AsyncCommand<Ctx, World>>,
  enabled: ReadonlySet<Invariant>,
  then?: (w: World) => Promise<void>,
): Promise<void> {
  const w = await World.create(estate);
  try {
    const ctx: Ctx = { m: w.model, w, enabled };
    const setup = () => ({ model: ctx, real: w });
    if (prefix.length)
      await fc.asyncModelRun(
        setup,
        prefix.map((d) => new Cmd(d)),
      );
    await fc.asyncModelRun(setup, cmds);
    await settleAndCompare(ctx, (d) => new Cmd(d).run(ctx, w));
    await then?.(w);
  } finally {
    await w.dispose();
  }
}

/** Run a committed counterexample, checking its invariant (an order one: its last two writes). */
export function replay(r: Recorded): Promise<void> {
  const e = estateOf(r.estate);
  if (r.invariant === "order-independence") {
    const [a, b] = r.commands.slice(-2);
    return checkOrder(e, r.commands.slice(0, -2), [a!, b!]);
  }
  return runSequence(
    e,
    [],
    r.commands.map((d) => new Cmd(d)),
    new Set([r.invariant]),
  );
}

export const sequences = (maxCommands: number, replayPath?: string) =>
  fc.tuple(
    estateArb,
    prefixArb,
    fc.commands(commandArbs(), { maxCommands, ...(replayPath ? { replayPath } : {}) }),
  );

/** Two writes of different repos, after a short prefix: the order property's input. */
export const orderPairs = fc.tuple(
  estateArb,
  fc.array(
    fc.oneof(
      fc.constant<Desc>({ t: "scan" }),
      fc.nat({ max: 4 }).map<Desc>((slot) => ({ t: "verify-write", slot, ok: true })),
    ),
    { maxLength: 2 },
  ),
  fc.tuple(fc.boolean(), fc.boolean(), fc.nat({ max: 3 })),
);

/** The two writes an `orderPairs` value names: of slot 0 and of another slot of the estate. */
export function pairOf(e: Estate, [x, y, gap]: [boolean, boolean, number]): [Desc, Desc] {
  const n = e.repos.length;
  const write = (scan: boolean, slot: number): Desc =>
    scan ? { t: "scan-subset", slots: [slot] } : { t: "verify-write", slot, ok: true };
  return [write(x, 0), write(y, 1 + (gap % (n - 1)))];
}

/**
 * Order independence: the two writes in either order give the same catalog and slots. A write
 * a guard refused is confirmed with its listed count, as a person would, so both orders end
 * with both writes made.
 */
export async function checkOrder(
  e: Estate,
  prefix: Desc[],
  pair: [Desc, Desc],
  then?: (w: World) => Promise<void>,
): Promise<void> {
  const none = new Set<Invariant>();
  const one = await World.create(e);
  let two: World | undefined;
  const runAll = async (w: World, ds: Desc[]) => {
    const ctx: Ctx = { m: w.model, w, enabled: none };
    for (const d of ds) {
      await new Cmd(d).run(ctx, w);
      if (w.pending?.removals) await new Cmd({ t: "confirm-removals" }).run(ctx, w);
    }
  };
  try {
    await runAll(one, prefix);
    two = await one.copy();
    await runAll(one, [pair[0], pair[1]]);
    await runAll(two, [pair[1], pair[0]]);
    const [a, b] = [await one.snap(), await two.snap()];
    const d = [
      ...changedPaths(a.generated, b.generated).map((p) => `catalog/generated/${p}`),
      ...changedPaths(a.sources, b.sources).map((p) => `catalog/sources/${p}`),
    ];
    if (d.length)
      throw new InvariantError(
        "order-independence",
        `${JSON.stringify(pair[0])} then ${JSON.stringify(pair[1])} differs from the other order in ${d.slice(0, 6).join(", ")}`,
      );
    await then?.(one);
  } finally {
    await one.dispose();
    await two?.dispose();
  }
}

/** The commands of a counterexample that ran, as data (fast-check wraps each command). */
export function ranDescs(cmds: Iterable<unknown>): Desc[] {
  return [...cmds].flatMap((c) => {
    const w = c as { hasRan?: boolean; cmd?: Cmd } & Partial<Cmd>;
    const inner = w.cmd ?? (w as Cmd);
    return (w.hasRan ?? inner.ran) ? [inner.desc] : [];
  });
}

/** Write a failing run's shrunk counterexample under regressions/<invariant>.json. */
export function record(
  invariant: Invariant,
  note: string,
  seed: number,
  estate: Estate,
  commands: Desc[],
): void {
  mkdirSync(REGRESSIONS, { recursive: true });
  const r: Recorded = { invariant, note, seed, estate: recordedOf(estate), commands };
  writeFileSync(join(REGRESSIONS, `${invariant}.json`), JSON.stringify(r, null, 2) + "\n");
}

/** A property run that failed: what failed, and the shrunk counterexample that replays it. */
export interface Failure {
  invariant?: Invariant;
  message: string;
  seed: number;
  path?: string;
  estate: Estate;
  commands: Desc[];
  /** fast-check's replayPath of the command sequence, for ATTICUS_PROPERTIES_COMMANDS. */
  replay?: string;
  /** The test's name, for the replay's `-t`. */
  test?: string;
  error: unknown;
}

/** How often each command acted, and the run's time by command: for coverage and the budget. */
export function statsTable(): string {
  const rows = [...new Set([...GENERATED, ...stats.ran.keys()])]
    .map((t) => ({
      t,
      ran: stats.ran.get(t) ?? 0,
      acted: stats.acted.get(t) ?? 0,
      ms: Math.round(stats.ms.get(t) ?? 0),
    }))
    .sort((a, b) => b.ms - a.ms);
  return [
    "command               ran  acted      ms",
    ...rows.map(
      (r) =>
        `${r.t.padEnd(20)} ${String(r.ran).padStart(4)} ${String(r.acted).padStart(6)} ${String(r.ms).padStart(7)}`,
    ),
    `refusals by guard: ${[...stats.guards].map(([g, n]) => `${g} ${n}`).join(", ") || "none"}`,
    `system calls: ${stats.calls}, succeeded: ${stats.succeeded}`,
  ].join("\n");
}

/**
 * The commands whose state comes from the system's own earlier success: an answer needs a
 * question a scan asked, a hand edit or a curated decision needs records written, a confirmation
 * needs a guard's refusal, undo and `again` a write before them.
 */
const NEEDS_SUCCESS = new Set<string>([
  "answer",
  "curate",
  "uncurate",
  "hand-edit",
  "discard-edits",
  "curate-edits",
  "confirm-removals",
  "undo",
  "again",
]);

/**
 * The commands that never acted in a run, so the run tested nothing of them: the generators
 * must weight them up. A system that refused or lacked most of what it was asked (today's
 * writers) never reaches the states the commands in NEEDS_SUCCESS start from; completeness, not
 * coverage, is what fails it, so only the others are required of it. A confirmation of a large
 * removal is required only after a refusal for one.
 */
export function neverActed(): { idle: string[]; lenient: boolean } {
  const lenient = stats.succeeded < stats.calls / 2;
  return {
    lenient,
    idle: GENERATED.filter((t) => !stats.acted.get(t))
      .filter((t) => !lenient || !NEEDS_SUCCESS.has(t))
      .filter((t) => t !== "confirm-removals" || !!stats.guards.get("large-removals")),
  };
}

/**
 * Search `runs` random sequences (or, with `order`, order pairs) for a failure of `enabled`,
 * shrink the first one found, and say it; with `record`, write it under regressions/.
 */
export async function search(o: {
  runs: number;
  seed: number;
  path?: string;
  enabled: ReadonlySet<Invariant>;
  order?: boolean;
  record?: boolean;
  maxCommands?: number;
  /** fast-check's replayPath of the command sequence to replay. */
  commands?: string;
  test?: string;
}): Promise<Failure | undefined> {
  const params = { numRuns: o.runs, seed: o.seed, ...(o.path ? { path: o.path } : {}) };
  let found: { estate: Estate; commands: Desc[]; replay?: string } | undefined;
  let r: {
    failed: boolean;
    errorInstance: unknown;
    seed: number;
    counterexamplePath: string | null;
  };
  if (o.order) {
    const run = await fc.check(
      fc.asyncProperty(orderPairs, ([e, prefix, picks]) => checkOrder(e, prefix, pairOf(e, picks))),
      params,
    );
    r = run;
    if (run.failed && run.counterexample) {
      const [e, prefix, picks] = run.counterexample[0];
      found = { estate: e, commands: [...prefix, ...pairOf(e, picks)] };
    }
  } else {
    const run = await fc.check(
      fc.asyncProperty(sequences(o.maxCommands ?? 10, o.commands), ([e, prefix, cmds]) =>
        runSequence(e, prefix, cmds, o.enabled),
      ),
      params,
    );
    r = run;
    if (run.failed && run.counterexample) {
      const [e, prefix, cmds] = run.counterexample[0];
      const replay = /replayPath="([^"]*)"/.exec(String(cmds))?.[1];
      found = {
        estate: e,
        commands: [...prefix, ...ranDescs(cmds)],
        ...(replay ? { replay } : {}),
      };
    }
  }
  if (!r.failed || !found) return undefined;
  const err = r.errorInstance;
  const f: Failure = {
    ...found,
    ...(err instanceof InvariantError ? { invariant: err.invariant } : {}),
    message: err instanceof Error ? err.message : String(err),
    seed: r.seed,
    ...(r.counterexamplePath ? { path: r.counterexamplePath } : {}),
    ...(o.test ? { test: o.test } : {}),
    error: err,
  };
  if (o.record && f.invariant) record(f.invariant, f.message, f.seed, f.estate, f.commands);
  return f;
}

/** A failure in words: what broke, how to replay it, and the shrunk commands and estate. */
export function said(f: Failure): string {
  const s = settings();
  const env = [
    `ATTICUS_PROPERTIES_SEED=${f.seed}`,
    `ATTICUS_PROPERTIES_PATH=${f.path ?? ""}`,
    ...(f.replay ? [`ATTICUS_PROPERTIES_COMMANDS=${f.replay}`] : []),
    `ATTICUS_PROPERTIES_RUNS=${s.runs}`,
    `ATTICUS_PROPERTIES_MAX_COMMANDS=${s.maxCommands}`,
    ...(s.asked ? [`ATTICUS_PROPERTIES_INVARIANTS=${s.asked}`] : []),
  ].join(" ");
  const filter = f.test ? ` -t ${JSON.stringify(f.test)}` : "";
  return [
    f.message,
    `Replay: ${env} pnpm --filter @maycombhq/cli exec vitest run --config ../../vitest.shared.mjs ${TEST_FILE}${filter}`,
    `Shrunk to: ${JSON.stringify(f.commands)}`,
    `Estate: ${JSON.stringify(recordedOf(f.estate))}`,
  ].join("\n");
}
