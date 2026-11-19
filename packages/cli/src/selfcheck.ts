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
  orderedFlags,
  platformWord,
  recordBand,
  repoBand,
  shapeText,
  timeBand,
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
 * Each check's invented regression shapes, nearest first: a failed check names the first of
 * them the card finds present, so the fix can start from the Forge estate of that shape.
 */
export const CHECK_FLAGS: Record<CheckId, readonly ShapeFlag[]> = {
  "calls-accounted": [
    "deploy-token-hosts",
    "gateway-proxies",
    "non-gateway-callee",
    "repos-with-no-system",
    "dotted-ids",
    "hand-pairings",
  ],
  "refusals-have-next-step": ["legacy-slots", "hand-pairings", "empty-repo", "unread-repo"],
  "build-is-repeatable": ["nested-payloads", "dotted-ids", "legacy-slots", "gateway-proxies"],
  "no-long-silence": [
    "gateway-proxies",
    "nested-payloads",
    "legacy-slots",
    "ssh-origins",
    "https-origins",
  ],
};

const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** Every word selfcheck prints (ADR 0202: the command line's words, in one constant). */
export const SELFCHECK_WORDS = {
  head: (p: number, of: number) =>
    `atticus selfcheck: ${p} of ${of} checks passed. Nothing was sent anywhere.`,
  closest: (flag: string | undefined, make: string) =>
    `  Closest invented shape: ${flag ?? "none known: this is a new shape"}. Make it: ATTICUS_FIELD_SHAPE=${make}`,
  names: (count: number) => `  The first ${count}, on this screen only:`,
  card: "Shape card: fixed words only; no name, id, path, hash or count of this estate.",
  notRun: "it could not be run here (atticus selfcheck --names says why, on this screen only).",
  calls: (c: { calls: number; drawn: number; loose: number; asked: number; left: number }) =>
    `${n(c.calls, "call")}: ${c.drawn} drawn as a link, ${c.loose} listed as a loose call, ${c.asked} asked about, ${c.left} unaccounted for.`,
  callsUnread: (repos: number) =>
    ` ${n(repos, "repo's facts are", "repos' facts are")} not all verified yet, so their calls were not counted.`,
  refusals: (c: { refusals: number; named: number }) =>
    c.refusals === 0
      ? "the build's guard and atticus status refuse nothing here."
      : `${n(c.refusals, "refusal")} here, ${c.named} with a command to go on.`,
  repeatable: (c: { files: number; differ: number }) =>
    c.differ === 0
      ? `two builds in memory listed the same ${n(c.files, "file")}, byte for byte.`
      : `two builds in memory listed ${n(c.files, "file")}, and ${n(c.differ, "hash differs", "hashes differ")} between them.`,
  quiet: (c: { runs: number; over: number }) =>
    c.over === 0
      ? `the newest run of ${n(c.runs, "long command")} printed a line at least every 30 seconds.`
      : `the newest run of ${n(c.over, "long command")} of ${c.runs} went over 30 seconds without a line.`,
  building: (k: number) =>
    k === 1 ? "Building in memory (1 of 2)…" : "Building in memory (2 of 2), with nothing kept…",
  guarding: "Running the build's guard…",
  quietNone:
    "No run on record since this Atticus was installed: run the command once, then selfcheck again.",
} as const;

export interface CheckResult {
  id: CheckId;
  state: CheckState;
  /** One sentence, counts only. */
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
}

const NAMES_MAX = 20;

/**
 * A test's switches. The first two checks hold unless Atticus has a bug (the join accounts for
 * every call, and a build is repeatable), so no estate can be made to fail them: a test makes
 * the fault here. `unaccounted` adds to the calls the join left with no reason; `second` stands
 * for the second build.
 */
export const selfcheckHooks: {
  unaccounted?: (detail: LinkDetail) => void;
  second?: (b: Build) => Build;
} = {};

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
  o: { platform?: string; progress?: (line: string) => void } = {},
): Promise<Selfcheck> {
  const names: Selfcheck["names"] = {};
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
    // The join gives a reason for every call it leaves; one with none is listed nowhere.
    const left = detail.unaccounted.length;
    const drawn = l.verified + l.inferred + l.outside;
    const loose = Math.max(0, l.unresolved - left);
    const calls = drawn + l.asked + loose + left;
    results.set("calls-accounted", {
      state: left ? "failed" : "passed",
      sentence:
        SELFCHECK_WORDS.calls({ calls, drawn, loose, asked: l.asked, left }) +
        (estate.unverified.length ? SELFCHECK_WORDS.callsUnread(estate.unverified.length) : ""),
    });
    said("calls-accounted", detail.unaccounted);
  } catch (e) {
    failed("calls-accounted", e);
  }

  // ---- two builds in memory: the first as any build runs, the second with no kept build read
  let build: Build | undefined;
  try {
    o.progress?.(SELFCHECK_WORDS.building(1));
    // The curated decisions are read here with nothing kept: a build's own read of them keeps
    // its parses under .atticus/cache, and selfcheck writes nothing.
    const inputs = async () => {
      const pack = op ?? (await loadOrgPack(orgPackDirOf(root)));
      const curated = await readCatalog(curatedDirOf(root, pack));
      return loadBuildInputs(root, { op: pack, curated: curated.records });
    };
    const first = await buildCatalog(await inputs());
    o.progress?.(SELFCHECK_WORDS.building(2));
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
    const [a, b] = [first, build].map((x) => manifestAt(x, target));
    const same = serializeBuildManifest(a!) === serializeBuildManifest(b!);
    const then = new Map(a!.files.map((f) => [f.path, f.sha256] as const));
    const differ = same
      ? []
      : [...new Set([...then.keys(), ...b!.files.map((f) => f.path)])]
          .filter((p) => then.get(p) !== b!.files.find((f) => f.path === p)?.sha256)
          .sort();
    results.set("build-is-repeatable", {
      state: same ? "passed" : "failed",
      // A list that differs with every file's hash the same differs in its sources: one is said.
      sentence: SELFCHECK_WORDS.repeatable({
        files: b!.files.length,
        differ: same ? 0 : Math.max(differ.length, 1),
      }),
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
    const named = refusals.filter((x) => x.next.length).length;
    results.set("refusals-have-next-step", {
      state: named === refusals.length ? "passed" : "failed",
      sentence: SELFCHECK_WORDS.refusals({ refusals: refusals.length, named }),
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
            sentence: SELFCHECK_WORDS.quiet({ runs: measured.length, over: over.length }),
          }
        : { state: "skipped", sentence: SELFCHECK_WORDS.quietNone },
    );
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
    const closest = CHECK_FLAGS[id].find((f) => flags.includes(f));
    return { id, ...r, ...(closest ? { closest } : {}), make };
  });
  return { checks, card, names };
}

/** atticus selfcheck [--names] [--json]. 0 when none failed, 1 when one did, 2 for no metarepo. */
export async function selfcheckCommand(
  root: string,
  o: { json?: boolean; names?: boolean; platform?: string },
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
      io.err(e.message);
      return 1;
    }
    throw e;
  }
  let r: Selfcheck;
  try {
    r = await selfcheck(root, {
      ...(o.platform ? { platform: o.platform } : {}),
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
    if (c.state !== "failed") continue;
    io.out(W.closest(c.closest, c.make ?? ""));
    const shown = o.names ? (r.names[c.id] ?? []) : [];
    if (shown.length) {
      io.out(W.names(shown.length));
      for (const x of shown) io.out(`    ${x}`);
    }
  }
  io.out("");
  io.out(W.card);
  for (const l of cardLines(r.card)) io.out(`  ${l}`);
  return bad ? 1 : 0;
}
