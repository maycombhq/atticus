import { open, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  acquireLock,
  checkoutDirOf,
  factsDirOf,
  loadOrgPack,
  LockHeldError,
  orgPackDirOf,
  readTerminalRuns,
  repoIdTwins,
  repoIdTwinWarning,
  type Fact,
  type OrgPack,
} from "@maycombhq/core";
import {
  baselineTarget,
  buildAndWrite,
  buildCacheHooks,
  buildCatalog,
  curatedDirOf,
  estateFacts,
  estateRepos,
  factsSlotPaths,
  generatedDirOf,
  legacyJoinsPath,
  loadBuildInputs,
  manifestAt,
  readCatalog,
  readersSlotPath,
  refusalCommands,
  serializeBuildManifest,
  type Build,
} from "@maycombhq/scanner";
import type { Output } from "./commands.js";
import { linkCountsOf, type LinkDetail } from "./doctor-counts.js";
import { isMetarepo, notMetarepo } from "./metarepo-guard.js";
import {
  cardLines,
  countBand,
  orderedFlags,
  platformWord,
  recordBand,
  repoBand,
  shapeText,
  timeBand,
  type RecordBand,
  type ShapeCard,
  type ShapeFlag,
  type Step,
} from "./shape-words.js";
import { standing } from "./standing.js";

/**
 * ADR 0202 point 10 (the field plan's Group 4): `atticus selfcheck`, run on the person's machine
 * against the real metarepo. It runs the invariants the tests hold, reads files only, makes no
 * network call and no model call, takes the scan lock, and writes nothing (the command line's
 * usual one line in .atticus/logs/atticus.log is `main`'s). Its answer is four named checks and a
 * shape card of fixed words (shape-words.ts): no name, id, path, hash or count of the estate is
 * in what it prints, unless the person on site asks for `--names`, on screen only.
 */

export const CHECK_IDS = [
  "calls-accounted",
  "refusals-have-next-step",
  "build-is-repeatable",
  "no-long-silence",
] as const;
export type CheckId = (typeof CHECK_IDS)[number];
export type CheckState = "passed" | "failed" | "skipped";

/** The longest a long command may print nothing. */
export const QUIET_LIMIT_MS = 30_000;

/**
 * The invented shapes that explain a failed check, nearest first, for the two checks that are
 * about the estate's shape: how its calls join, and where its build refuses. A failed check
 * names the first of them the card finds present. The other two (a build that isn't repeatable,
 * a long silence) are not explained by a shape flag, so they name none: a guess there sent
 * people after the wrong shape.
 */
export const CHECK_FLAGS: Partial<Record<CheckId, readonly ShapeFlag[]>> = {
  "calls-accounted": [
    "deploy-token-hosts",
    "gateway-proxies",
    "non-gateway-callee",
    "repos-with-no-system",
    "dotted-ids",
    "hand-pairings",
  ],
  "refusals-have-next-step": ["legacy-slots", "hand-pairings", "empty-repo", "unread-repo"],
};

/**
 * What the two builds in memory cost, by the card's record band only: words of a fixed table,
 * never a figure worked out from the estate's own count. Seeded with what was measured on the
 * invented field estate (beta.30: about 21 s and 0.72 GB at 14,000 records, 70 s and 1.4 GB at
 * 70,000). A band below 10k builds in seconds, so nothing is said.
 */
export const COST_BY_BAND: Partial<Record<RecordBand, string>> = {
  "10k-50k": "about half a minute and under 1 GB",
  "50k-200k": "about a minute or two and 1 to 2 GB",
  "over-200k": "several minutes and over 2 GB",
};

const b = countBand;

/**
 * Every word selfcheck prints (ADR 0202: the command line's words, in one constant). A check's
 * sentence gives its counts in bands; `exact` is the same with numbers, for `--names` only.
 */
export const SELFCHECK_WORDS = {
  head: (p: number, of: number) =>
    `atticus selfcheck: ${p} of ${of} checks passed. Nothing was sent anywhere.`,
  closest: (flag: string | undefined, make: string) =>
    `  Closest invented shape: ${flag ?? "none known: this is a new shape"}. Make it: ATTICUS_FIELD_SHAPE=${make}`,
  noShape: (make: string) =>
    `  Closest invented shape: none: this check is not about the estate's shape. The estate's: ATTICUS_FIELD_SHAPE=${make}`,
  exact: (text: string) => `  Exact, on this screen only: ${text}`,
  names: (count: number) => `  The first ${count}, on this screen only:`,
  card: "Shape card: fixed words only; no name, id, path, hash or count of this estate.",
  notRun: "it could not be run here (atticus selfcheck --names says why, on this screen only).",
  calls: (c: { ok: boolean; joined: number; asked: number; left: number; none: number }) =>
    `${c.ok ? "every call the join left has a reason" : "a call the join left has no reason"}: ${b(c.joined)} joined or placed outside, ${b(c.asked)} asked, ${b(c.left)} left with a reason, ${b(c.none)} with none.`,
  callsExact: (c: { joined: number; asked: number; left: number; none: number }) =>
    `${c.joined} joined or placed outside, ${c.asked} asked, ${c.left} left with a reason, ${c.none} with none.`,
  callsNone: "no call facts to check.",
  callsUnread: (repos: number) =>
    ` Repos whose facts are not all verified yet (${b(repos)}) were not counted.`,
  refusals: (c: { refusals: number; named: number }) =>
    c.refusals === 0
      ? "the build's guard and atticus status refuse nothing here."
      : c.named === c.refusals
        ? "every refusal here names a command to go on."
        : "a refusal here names no command to go on.",
  refusalsExact: (c: { refusals: number; named: number }) =>
    `${c.refusals} refused, ${c.named} with a command to go on.`,
  repeatable: (same: boolean) =>
    same
      ? "two builds in memory listed the same files, byte for byte."
      : "two builds in memory listed files whose hashes differ.",
  repeatableExact: (c: { files: number; differ: number }) =>
    `${c.files} files listed, ${c.differ} differ.`,
  repeatableQuick: "left out with --quick: it builds the catalog twice in memory.",
  cost: (band: RecordBand) =>
    `build-is-repeatable builds the catalog twice in memory. An estimate for ${band} records: ${COST_BY_BAND[band] ?? ""}. atticus selfcheck --quick leaves it out.`,
  quiet: (ok: boolean) =>
    ok
      ? "the newest run of each command on record printed a line at least every 30 seconds."
      : "the newest run of a command on record went over 30 seconds without a line.",
  quietExact: (c: { runs: number; over: number }) =>
    `${c.runs} commands on record, ${c.over} over 30 seconds.`,
  building: (k: number, of: number) =>
    of === 1
      ? "Building in memory…"
      : k === 1
        ? "Building in memory (1 of 2)…"
        : "Building in memory (2 of 2), with nothing kept…",
  guarding: "Running the build's guard…",
  quietNone:
    "No run on record since this Atticus was installed: run the command once, then selfcheck again.",
  busy: (since: string) =>
    `Another Atticus command is running on this metarepo (since ${since}), so selfcheck couldn't run. Run it again when that command has finished.`,
  /** The review of b30/review2-fixes: with no id, as every line above the card. */
  twins:
    "Warning: the manifests list repo ids that name one loose-end id, so the map couldn't tell their loose ends apart. atticus selfcheck --names (or atticus doctor) names them; rename one of each pair with atticus repo rename <id> <new id>.",
} as const;

export interface CheckResult {
  id: CheckId;
  state: CheckState;
  /** One sentence; its counts in bands only. */
  sentence: string;
  /** Under a failed check: its closest invented shape (a flag of the list), when one is known. */
  closest?: ShapeFlag;
  /** Under a failed check: the words that make an invented estate of this shape. */
  make?: string;
}

export interface Selfcheck {
  checks: CheckResult[];
  card: ShapeCard;
  /** With `names`: the first 20 ids or paths behind each failed check. Never in `--json`. */
  names: Partial<Record<CheckId, string[]>>;
  /** With `names`: each check's counts as numbers. Never in `--json`. */
  exact: Partial<Record<CheckId, string>>;
  /**
   * Each pair of repo ids that name one loose-end id, as its warning (repoIdTwinWarning): said
   * as SELFCHECK_WORDS.twins, the ids only with `names`. Never in `--json`.
   */
  twins: string[];
}

const NAMES_MAX = 20;

/**
 * A test's switches. Three checks hold unless Atticus has a bug (the join gives every call it
 * leaves a reason, a build is repeatable, every refusal names a command), so no estate can be
 * made to fail them: a test makes the fault here. `unaccounted` adds to the calls the join left with no reason; `second` stands
 * for the second build.
 */
export const selfcheckHooks: {
  unaccounted?: (detail: LinkDetail) => void;
  second?: (b: Build) => Build;
  /** Adds to what refused here, each with the commands it names. */
  refusals?: (list: { what: string; next: string[] }[]) => void;
} = {};

/** How many files under a folder end so; nothing is read but the names. */
async function countFiles(dir: string, ending: string): Promise<number> {
  let n = 0;
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => []))
    if (e.isDirectory()) n += await countFiles(join(dir, e.name), ending);
    else if (e.name.endsWith(ending)) n++;
  return n;
}

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

/**
 * A repo that only forwards: its manifest types it so, or one of its calls is its route's own
 * line (a gateway's route is an entry and the call it forwards, cited at the same line).
 */
function isGateway(type: string | undefined, facts: readonly Fact[] | undefined): boolean {
  if (/gateway|proxy/i.test(type ?? "")) return true;
  const entries = new Map(
    (facts ?? []).filter((f) => f.kind === "entry").map((f) => [f.id, f.cite] as const),
  );
  return (facts ?? []).some((c) => {
    if (c.kind !== "call" || !c.from) return false;
    const at = entries.get(c.from);
    return !!at && at.file === c.cite.file && at.line === c.cite.line;
  });
}

async function headOf(path: string, bytes = 600): Promise<string> {
  const fh = await open(path, "r").catch(() => undefined);
  if (!fh) return "";
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } catch {
    return "";
  } finally {
    await fh.close();
  }
}

/** Which shape flags the estate has, read from the manifests, the facts and the slots. */
async function shapeFlags(
  root: string,
  op: OrgPack,
  estate: Awaited<ReturnType<typeof estateFacts>>,
  detail: LinkDetail,
): Promise<ShapeFlag[]> {
  const flags = new Set<ShapeFlag>();
  const repos = estateRepos(op);
  const factsOf = new Map(estate.repos.map((r) => [r.repo, r.facts] as const));
  const gateway = new Set(
    repos.filter((r) => isGateway(r.type, factsOf.get(r.id))).map((r) => r.id),
  );
  if (gateway.size) flags.add("gateway-proxies");
  if (detail.tokenHost) flags.add("deploy-token-hosts");
  for (const r of repos) {
    if (!r.system) flags.add("repos-with-no-system");
    if (r.id.includes(".")) flags.add("dotted-ids");
    if (/^(git@|ssh:\/\/)/i.test(r.url ?? "")) flags.add("ssh-origins");
    if (/^https:\/\//i.test(r.url ?? "")) flags.add("https-origins");
  }
  for (const r of estate.repos)
    if (r.facts.some((f) => f.kind === "field" && /[.[\]]/.test(f.name)))
      flags.add("nested-payloads");
  // Slots a catalog from before the upgrade was adopted into.
  if (await exists(legacyJoinsPath(root))) flags.add("legacy-slots");
  const dir = factsDirOf(root);
  const filed = new Set(await readdir(dir).catch(() => [] as string[]));
  for (const r of repos) {
    const slot = readersSlotPath(root, r.id);
    if (!flags.has("legacy-slots") && /"status":\s*"legacy"/.test(await headOf(slot)))
      flags.add("legacy-slots");
    const clone = await readdir(checkoutDirOf(root, r.id)).catch(() => undefined);
    const read =
      filed.has(`${r.id}.jsonl`) ||
      (await exists(slot)) ||
      (await exists(factsSlotPaths(root, r.id).facts));
    if (clone && clone.every((e) => e === ".git") && !read) flags.add("empty-repo");
    else if (!clone && !read) flags.add("unread-repo");
  }
  // Calls a person paired by hand, and whether one is paired with a repo that is no gateway.
  for (const name of filed) {
    if (!name.endsWith(".corrections.jsonl")) continue;
    for (const l of (await readFile(join(dir, name), "utf8").catch(() => "")).split("\n")) {
      if (!l.includes('"link"')) continue;
      try {
        const c = JSON.parse(l) as { action?: string; link?: { repo?: string } };
        if (c.action !== "link") continue;
        flags.add("hand-pairings");
        if (c.link?.repo && !gateway.has(c.link.repo)) flags.add("non-gateway-callee");
      } catch {
        // a line that doesn't read is no pairing
      }
    }
  }
  return orderedFlags(flags);
}

/** A run's command in the card's words, by its first words only (never an id it was given). */
function stepOf(command: readonly string[]): Step {
  const [a, b] = command;
  if (a === "workspace" && b === "sync") return "sync";
  if (a === "map") return "read";
  if (a === "verify") return "verify";
  if (a === "catalog" && b === "build") return "build";
  if (a === "scan") return "scan";
  return "other";
}
/**
 * Run the four checks and make the card. Reads only: the builds are made in memory, the guard
 * is run as `catalog build --check` runs it, and no cache is written.
 */
export async function selfcheck(
  root: string,
  o: {
    platform?: string;
    progress?: (line: string) => void;
    /** Leave out the check that builds the catalog twice: one build, as any command makes. */
    quick?: boolean;
  } = {},
): Promise<Selfcheck> {
  const names: Selfcheck["names"] = {};
  const exact: Selfcheck["exact"] = {};
  const said = (id: CheckId, lines: readonly string[]) => {
    if (lines.length) names[id] = lines.slice(0, NAMES_MAX);
  };
  const why = (e: unknown) => [e instanceof Error ? e.message : String(e)];
  const results = new Map<CheckId, Omit<CheckResult, "id">>();
  const failed = (id: CheckId, e: unknown) => {
    results.set(id, { state: "failed", sentence: SELFCHECK_WORDS.notRun });
    said(id, why(e));
  };

  // ---- the estate's facts, read once: the calls' tally and the card's flags
  const detail: LinkDetail = { unaccounted: [], tokenHost: false };
  let op: OrgPack | undefined;
  let estate: Awaited<ReturnType<typeof estateFacts>> | undefined;
  try {
    op = await loadOrgPack(orgPackDirOf(root));
    estate = await estateFacts(root, op, "");
    const l = linkCountsOf(estate, op, detail);
    selfcheckHooks.unaccounted?.(detail);
    // The join gives a reason for every call it leaves; one with none is listed nowhere. This
    // is the join's own tally: it is not compared with the catalog's arrows or the questions.
    const none = detail.unaccounted.length;
    const c = {
      joined: l.verified + l.inferred + l.outside,
      asked: l.asked,
      left: Math.max(0, l.unresolved - none),
      none,
    };
    const unread = estate.unverified.length
      ? SELFCHECK_WORDS.callsUnread(estate.unverified.length)
      : "";
    results.set(
      "calls-accounted",
      c.joined + c.asked + c.left + c.none === 0
        ? { state: "skipped", sentence: SELFCHECK_WORDS.callsNone + unread }
        : {
            state: none ? "failed" : "passed",
            sentence: SELFCHECK_WORDS.calls({ ok: !none, ...c }) + unread,
          },
    );
    exact["calls-accounted"] = SELFCHECK_WORDS.callsExact(c);
    said("calls-accounted", detail.unaccounted);
  } catch (e) {
    failed("calls-accounted", e);
  }

  // ---- two builds in memory: the first as any build runs, the second with no kept build read
  // The curated decisions are read here with nothing kept: a build's own read of them keeps
  // its parses under .atticus/cache, and selfcheck writes nothing.
  const inputs = async () => {
    const pack = op ?? (await loadOrgPack(orgPackDirOf(root)));
    const curated = await readCatalog(curatedDirOf(root, pack));
    return loadBuildInputs(root, { op: pack, curated: curated.records });
  };
  let build: Build | undefined;
  if (o.quick) {
    results.set("build-is-repeatable", {
      state: "skipped",
      sentence: SELFCHECK_WORDS.repeatableQuick,
    });
    // One build, for the guard and the card.
    o.progress?.(SELFCHECK_WORDS.building(1, 1));
    build = await buildCatalog(await inputs()).catch(() => undefined);
  } else
    try {
      // What it costs is said before it starts, where the catalog is large: by the band of its
      // record files on disk (one file a record), in the table's words.
      const band = recordBand(await countFiles(generatedDirOf(root), ".yaml"));
      if (COST_BY_BAND[band]) o.progress?.(SELFCHECK_WORDS.cost(band));
      o.progress?.(SELFCHECK_WORDS.building(1, 2));
      const first = await buildCatalog(await inputs());
      o.progress?.(SELFCHECK_WORDS.building(2, 2));
      const was = buildCacheHooks.off;
      buildCacheHooks.off = true;
      try {
        build = await buildCatalog(await inputs());
      } finally {
        if (was === undefined) delete buildCacheHooks.off;
        else buildCacheHooks.off = was;
      }
      if (selfcheckHooks.second) build = selfcheckHooks.second(build);
      const target = baselineTarget(root);
      const [x, y] = [first, build].map((m) => manifestAt(m, target));
      const same = serializeBuildManifest(x!) === serializeBuildManifest(y!);
      const then = new Map(x!.files.map((f) => [f.path, f.sha256] as const));
      const differ = same
        ? []
        : [...new Set([...then.keys(), ...y!.files.map((f) => f.path)])]
            .filter((p) => then.get(p) !== y!.files.find((f) => f.path === p)?.sha256)
            .sort();
      results.set("build-is-repeatable", {
        state: same ? "passed" : "failed",
        sentence: SELFCHECK_WORDS.repeatable(same),
      });
      // A list that differs with every file's hash the same differs in its sources: one is said.
      exact["build-is-repeatable"] = SELFCHECK_WORDS.repeatableExact({
        files: y!.files.length,
        differ: same ? 0 : Math.max(differ.length, 1),
      });
      said("build-is-repeatable", differ);
    } catch (e) {
      failed("build-is-repeatable", e);
    }

  // ---- the build's guard, as `catalog build --check` runs it, and where the metarepo stands
  try {
    o.progress?.(SELFCHECK_WORDS.guarding);
    const command = "atticus catalog build";
    const was = buildCacheHooks.off;
    buildCacheHooks.off = true;
    let checked;
    try {
      checked = await buildAndWrite(root, {
        command,
        check: true,
        keepNoReads: true,
        ...(build ? { build } : {}),
      });
    } finally {
      if (was === undefined) delete buildCacheHooks.off;
      else buildCacheHooks.off = was;
    }
    const where = await standing(root);
    const refusals: { what: string; next: string[] }[] = [];
    const r = checked.guard.refused;
    if (r) refusals.push({ what: r.reasons.join(", "), next: refusalCommands(r, command) });
    if (where.state !== "up-to-date")
      refusals.push({ what: where.state, next: where.do ? [where.do] : [] });
    selfcheckHooks.refusals?.(refusals);
    const named = refusals.filter((x) => x.next.length).length;
    results.set("refusals-have-next-step", {
      state: named === refusals.length ? "passed" : "failed",
      sentence: SELFCHECK_WORDS.refusals({ refusals: refusals.length, named }),
    });
    exact["refusals-have-next-step"] = SELFCHECK_WORDS.refusalsExact({
      refusals: refusals.length,
      named,
    });
    said(
      "refusals-have-next-step",
      refusals.filter((x) => !x.next.length).map((x) => x.what),
    );
  } catch (e) {
    failed("refusals-have-next-step", e);
  }

  // ---- the newest finished run of each long command: how long it printed nothing
  let slowest: ShapeCard["slowest"] = { step: "none" };
  try {
    const runs = readTerminalRuns(root).filter((r) => r.state !== "running" && r.finishedAt);
    let longest = -1;
    for (const r of runs) {
      const ms = Date.parse(r.finishedAt!) - Date.parse(r.startedAt);
      if (Number.isFinite(ms) && ms > longest) {
        longest = ms;
        slowest = { step: stepOf(r.command), time: timeBand(ms) };
      }
    }
    // Every command that keeps a run is a long one or one that writes (core's run log). Newest
    // first already (readTerminalRuns): the first of each command is its newest. A command is
    // told by its first word, or by the card's word for it; no id it was given is read.
    const newest = new Map<string, { step: Step; ms: number | undefined }>();
    for (const r of runs) {
      const step = stepOf(r.command);
      const key = step === "other" ? `other ${r.command[0] ?? ""}` : step;
      if (!newest.has(key)) newest.set(key, { step, ms: r.longestQuietMs });
    }
    const measured = [...newest.values()].filter((x) => x.ms !== undefined);
    const over = measured.filter((x) => x.ms! > QUIET_LIMIT_MS);
    results.set(
      "no-long-silence",
      measured.length
        ? {
            state: over.length ? "failed" : "passed",
            sentence: SELFCHECK_WORDS.quiet(!over.length),
          }
        : { state: "skipped", sentence: SELFCHECK_WORDS.quietNone },
    );
    if (measured.length)
      exact["no-long-silence"] = SELFCHECK_WORDS.quietExact({
        runs: measured.length,
        over: over.length,
      });
    said(
      "no-long-silence",
      over.map((x) => x.step),
    );
  } catch (e) {
    failed("no-long-silence", e);
  }

  // ---- the card: bands and flags only
  const flags = op && estate ? await shapeFlags(root, op, estate, detail).catch(() => []) : [];
  const card: ShapeCard = {
    repos: repoBand(op ? estateRepos(op).length : 0),
    records: recordBand(build ? build.files.size : 0),
    flags,
    platform: platformWord(o.platform ?? process.platform),
    slowest,
  };
  const make = shapeText(card);
  const checks = CHECK_IDS.map((id): CheckResult => {
    const r = results.get(id)!;
    if (r.state !== "failed") return { id, ...r };
    const closest = CHECK_FLAGS[id]?.find((f) => flags.includes(f));
    return { id, ...r, ...(closest ? { closest } : {}), make };
  });
  const twins = repoIdTwins(
    (op?.profiles ?? []).flatMap((p) => (p.repos?.repos ?? []).map((r) => r.id)),
  ).map(([a, b]) => repoIdTwinWarning(a, b));
  return { checks, card, names, exact, twins };
}

/** atticus selfcheck [--names] [--quick] [--timing] [--json]. 0 when none failed, 1 when one did, 2 for no metarepo. */
export async function selfcheckCommand(
  root: string,
  o: { json?: boolean; names?: boolean; quick?: boolean; timing?: boolean; platform?: string },
  io: Output,
): Promise<number> {
  if (!isMetarepo(root)) {
    io.err(notMetarepo(root));
    return 2;
  }
  let lock: Awaited<ReturnType<typeof acquireLock>>;
  try {
    lock = await acquireLock(root, "scan", "atticus selfcheck");
  } catch (e) {
    if (e instanceof LockHeldError) {
      // Nothing of the holder is said: its command can name a repo, and its message a host and
      // a path. It couldn't run, which is not a failed check: exit 2.
      io.err(SELFCHECK_WORDS.busy(e.held.startedAt));
      return 2;
    }
    throw e;
  }
  if (o.timing) {
    // Gate 1 of the v31 plan: one build in memory, timed (selfcheck-timing.ts). The four
    // checks don't run: this is the number to read off the screen, on its own.
    const { timeOneBuild, factsRepoCount, timingLines, TIMING_WORDS } =
      await import("./selfcheck-timing.js");
    try {
      const t = await timeOneBuild(root);
      if (o.json) {
        const { phases, totalMs, cpuMs, hashCacheWrite } = t;
        io.out(
          JSON.stringify(
            { phases, totalMs, cpuMs, ...(hashCacheWrite ? { hashCacheWrite } : {}) },
            null,
            2,
          ),
        );
        return 0;
      }
      const repos = o.names ? await factsRepoCount(root) : undefined;
      for (const l of timingLines(t, repos)) io.out(l);
      return 0;
    } catch (e) {
      // A held file's message names its path: the fixed sentence, the message with --names only.
      if (o.json) io.out(JSON.stringify({ error: TIMING_WORDS.failed }, null, 2));
      else io.err(TIMING_WORDS.failed);
      if (o.names && !o.json) io.err(`  ${e instanceof Error ? e.message : String(e)}`);
      return 2;
    } finally {
      await lock.release();
    }
  }
  let r: Selfcheck;
  try {
    r = await selfcheck(root, {
      ...(o.platform ? { platform: o.platform } : {}),
      ...(o.quick ? { quick: true } : {}),
      progress: (l) => (io.progress ?? io.err)(l),
    });
  } finally {
    await lock.release();
  }
  const bad = r.checks.some((c) => c.state === "failed");
  if (o.json) {
    // The same words, and nothing --names would show: that is for the screen only.
    io.out(JSON.stringify({ checks: r.checks, card: r.card }, null, 2));
    return bad ? 1 : 0;
  }
  const W = SELFCHECK_WORDS;
  io.out(W.head(r.checks.filter((c) => c.state === "passed").length, r.checks.length));
  for (const c of r.checks) {
    io.out(`${c.state} ${c.id}: ${c.sentence}`);
    if (o.names && r.exact[c.id]) io.out(W.exact(r.exact[c.id]!));
    if (c.state !== "failed") continue;
    io.out(CHECK_FLAGS[c.id] ? W.closest(c.closest, c.make ?? "") : W.noShape(c.make ?? ""));
    const shown = o.names ? (r.names[c.id] ?? []) : [];
    if (shown.length) {
      io.out(W.names(shown.length));
      for (const x of shown) io.out(`    ${x}`);
    }
  }
  if (r.twins.length) {
    io.out(W.twins);
    if (o.names) for (const t of r.twins) io.out(`    ${t}`);
  }
  io.out("");
  io.out(W.card);
  for (const l of cardLines(r.card)) io.out(`  ${l}`);
  return bad ? 1 : 0;
}
