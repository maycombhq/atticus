import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import {
  citedFiles,
  factsDirOf,
  factsRelOf,
  parseFacts,
  writeFileAtomic,
  type Fact,
} from "@maycombhq/core";
import { globToRegExp } from "@maycombhq/sdk";
import { lineRangeOf } from "@maycombhq/verify";
import { readReviewed } from "./facts-files.js";

/**
 * The read ledger of a repo read in parts (ADR 0124 addendum A-ledger). `atticus map <repo>
 * --estimate` plans a repo bigger than one session in parts; the plan is written beside the facts
 * as `facts/<repo>.read-plan.yaml` so the parts are the same in every session, and which part is
 * next is a fact of the facts file, never a list a person keeps by hand.
 *
 * A part is done when every unit it reads (a folder glob `planParts` gave it) is accounted for in
 * the facts: a kept fact cites a file under it, or `<repo>.reviewed.jsonl` names it as read and
 * holding no fact. So the state is read back from what the reader produced, not from anyone's
 * word that a part is finished, and a part re-read only ever stays done.
 */

/** When Atticus first saw a part (or a whole read) accounted for in the facts, and at which commit. */
const ReadStamp = z.strictObject({ at: z.string().min(1), commit: z.string().min(1) });

const Part = z.strictObject({
  part: z.number().int().positive(),
  paths: z.array(z.string().min(1)).min(1),
  files: z.number().int().nonnegative(),
  /** An estimate: the tokens the part's source counts as (`estimateTokens`), not a meter. */
  tokens: z.number().int().nonnegative(),
  /** ADR 0141 (v2): when `atticus verify` first found every unit of the part in the facts. */
  read: ReadStamp.optional(),
});

const PlanV1 = z.strictObject({
  schemaVersion: z.literal(1),
  repo: z.string().min(1),
  commit: z.string().min(1),
  session: z.number().int().positive(),
  plannedAt: z.string().min(1),
  parts: z.array(Part.omit({ read: true })).min(1),
});

/**
 * What a reader (or the person running it) says a read took (ADR 0141): Atticus can't meter the
 * tokens an assistant spends in Copilot agent mode or Claude Code, so these are recorded as
 * reported, never as measured, and kept apart from the estimate.
 */
const Reported = z.strictObject({
  at: z.string().min(1),
  /** The commit the read was of. */
  commit: z.string().min(1),
  tokens: z.number().int().positive().optional(),
  sessions: z.number().int().positive().optional(),
  /** The part the report is for, when it is for one. */
  part: z.number().int().positive().optional(),
  /** Who reported it (--by), when given. */
  by: z.string().min(1).optional(),
});

/**
 * ADR 0167: the reading rules a read was given: the FACT_RULES hash and the rule sets
 * (`RULE_SETS` in @maycombhq/assistant-files) it carried. A plan with none was read under the
 * rules before 2.0.0-beta.12, which recorded nothing.
 */
const RulesRecord = z.strictObject({
  hash: z.string().min(1),
  sets: z.array(z.string().min(1)),
});

/** ADR 0167: one session of a top-up: its files (or line ranges) and the sets it carries. */
const TopUpSession = z.strictObject({
  paths: z.array(z.string().min(1)).min(1),
  sets: z.array(z.string().min(1)).min(1),
  files: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
  /** When `atticus map <repo> --rules` last gave it to a reader. */
  given: z.string().min(1).optional(),
  /** When a verify that passed after it was given found it done. */
  done: ReadStamp.optional(),
});

/**
 * ADR 0167: a top-up under way: the sets the read lacked, planned in sessions at `commit` for the
 * rules of `hash`. Gone once every session is done and `rules` records the rules now.
 */
const TopUp = z.strictObject({
  commit: z.string().min(1),
  hash: z.string().min(1),
  sets: z.array(z.string().min(1)),
  session: z.number().int().positive(),
  plannedAt: z.string().min(1),
  /** beta.15: the model classes it was planned to read (`--models`), when one was asked for. */
  models: z.enum(["entries", "reachable", "all"]).optional(),
  sessions: z.array(TopUpSession),
});
export type TopUpT = z.infer<typeof TopUp>;

/**
 * ADR 0169: how a read takes model classes: those its entry points and calls reach, or all.
 * ADR 0170: or `entries`, those its own entry points reach, leaving the ones only an outbound
 * client reaches for later.
 */
export const MODELS_MODES = ["entries", "reachable", "all"] as const;
export type ModelsMode = (typeof MODELS_MODES)[number];

/**
 * ADR 0169: the model files a read leaves out because no entry point, call or field fact
 * reaches them, said, never silent: why, the files and their tokens (an estimate).
 */
const NotReached = z.strictObject({
  why: z.string().min(1),
  files: z.array(z.string().min(1)),
  tokens: z.number().int().nonnegative(),
  /**
   * ADR 0170 (`--models entries`): those of `files` an outbound client reaches but no entry point
   * does, with why; `--models reachable` reads them.
   */
  clientOnly: z
    .strictObject({ why: z.string().min(1), files: z.array(z.string().min(1)) })
    .optional(),
});
export type NotReachedT = z.infer<typeof NotReached>;

export const ReadPlanFile = z.strictObject({
  /** 2 since ADR 0141 (a v1 file reads as v2: `migrateReadPlan`). */
  schemaVersion: z.literal(2),
  repo: z.string().min(1),
  /** The commit the plan was made at; the plan is stale at another commit. */
  commit: z.string().min(1),
  /** The session token budget the parts were planned for (`sessionTokensFor`). */
  session: z.number().int().positive(),
  plannedAt: z.string().min(1),
  /**
   * ADR 0141: what `--estimate` counted for the read (an estimate, not a meter): its source files
   * and tokens, and the sessions planned (the parts, or one). `reread` when the read is of the
   * files changed since the facts' commit only (addendum A-incremental).
   */
  estimate: z
    .strictObject({
      files: z.number().int().nonnegative(),
      tokens: z.number().int().nonnegative(),
      sessions: z.number().int().positive(),
      reread: z.literal(true).optional(),
    })
    .optional(),
  /** The parts in the order they are read; none for a repo one session reads (ADR 0141). */
  parts: z.array(Part),
  /** ADR 0141: when `atticus verify` first found the whole plan in the facts. */
  read: ReadStamp.extend({ sessions: z.number().int().positive() }).optional(),
  /** ADR 0141: what the reader reported the read took (`atticus map <repo> --spent`). */
  reported: z.array(Reported).optional(),
  /** ADR 0167: the reading rules the read was given; none when read before they were recorded. */
  rules: RulesRecord.optional(),
  /** ADR 0167: a top-up for the rule sets the read lacked, under way. */
  topUp: TopUp.optional(),
  /**
   * ADR 0169: `all` when a person asked for every model class (`--models all`), ADR 0170:
   * `entries` for those the entry points reach; left out, the read takes those its entry points
   * and calls reach.
   */
  models: z.enum(MODELS_MODES).optional(),
  /** ADR 0169: the model files the read leaves out, nothing reaching them. */
  notReached: NotReached.optional(),
});
export type ReadPlanFileT = z.infer<typeof ReadPlanFile>;
export type ReadPlanReport = z.infer<typeof Reported>;

/**
 * A read plan of either version as v2 (ADR 0141): a v1 plan (A-ledger) is the same plan with
 * nothing recorded yet. Undefined when it is neither.
 */
export function migrateReadPlan(raw: unknown): ReadPlanFileT | undefined {
  const v2 = ReadPlanFile.safeParse(raw);
  if (v2.success) return v2.data;
  const v1 = PlanV1.safeParse(raw);
  if (!v1.success) return undefined;
  return { ...v1.data, schemaVersion: 2 };
}

/** The plan's file, relative to the root with forward slashes, for messages. */
export const readPlanRelOf = (root: string, repo: string) =>
  `${factsRelOf(root)}/${repo}.read-plan.yaml`;

const readPlanPath = (root: string, repo: string) =>
  join(factsDirOf(root), `${repo}.read-plan.yaml`);

/** One unit of a part: the folder a glob from `planParts` stands for, and whether it goes deep. */
interface Unit {
  glob: string;
  dir: string;
  deep: boolean;
  /** A range of one file too big for a session: done by a cited line of its own, past the overlap (R4), or by its own path. */
  range?: { file: string; from: number; to: number };
  /** ADR 0169: one file named by its path (a reached model class, an entry point): done by itself. */
  file?: string;
}

/**
 * The folder a part's glob stands for: `src/a/**` is src/a and everything under it, `src/a/*` is
 * src/a's own files, `*` the root's own files. Those are the only shapes `planParts` writes; any
 * other path is read as the one file it names.
 */
function unitOf(glob: string): Unit {
  const range = lineRangeOf(glob);
  if (range) return { glob, dir: range.file.replace(/\/?[^/]*$/, ""), deep: false, range };
  if (glob === "**") return { glob, dir: "", deep: true };
  if (glob.endsWith("/**")) return { glob, dir: glob.slice(0, -3), deep: true };
  if (glob === "*") return { glob, dir: "", deep: false };
  if (glob.endsWith("/*")) return { glob, dir: glob.slice(0, -2), deep: false };
  return { glob, dir: glob.replace(/\/?[^/]*$/, ""), deep: false, file: glob };
}

/** The folder a covered path sits in; a reviewed glob stands for its own folder, and below. */
function folderOf(path: string): { dir: string; deep: boolean } {
  const star = path.search(/[*?]/);
  if (star < 0) return { dir: path.replace(/\/?[^/]*$/, ""), deep: false };
  return { dir: path.slice(0, star).replace(/\/$/, ""), deep: true };
}

const isGlobPath = (p: string) => /[*?]/.test(p);
const under = (dir: string, of: string) => of === "" || dir === of || dir.startsWith(`${of}/`);

/**
 * Whether `file` is one a part's glob stands for (ADR 0161: the rest of a part a read stopped in):
 * a folder glob holds the files under it as `unitOf` reads it, a line range its file, and any
 * other path the one file it names.
 */
export function globHolds(glob: string, file: string): boolean {
  const u = unitOf(glob);
  if (u.range) return u.range.file === file;
  if (!/[*]/.test(glob)) return glob === file;
  const dir = file.replace(/\/?[^/]*$/, "");
  return u.deep ? under(dir, u.dir) : dir === u.dir;
}

export interface PartState extends z.infer<typeof Part> {
  state: "done" | "in-progress" | "to-read";
  /** The units of the part the facts account for. */
  covered: string[];
  /** The units nothing in the facts accounts for yet. */
  left: string[];
}

export interface ReadPlanProgress {
  repo: string;
  commit: string;
  session: number;
  plannedAt: string;
  parts: PartState[];
  total: number;
  done: number;
  /** The first part that isn't done, when one is left. */
  next?: PartState;
  /** True when the plan was made at another commit: re-plan with --estimate. */
  stale: boolean;
}

const HEADER =
  "# The parts this repo is read in (ADR 0124 addendum A-ledger), as atticus map --estimate planned them,\n# and what the read cost (ADR 0141): tokens are estimates, reported numbers are the reader's word.\n# Which part is next is read back from the facts; atticus next says it. Atticus writes this file.\n";

/** Write a read plan as it is. */
export async function saveReadPlan(root: string, plan: ReadPlanFileT): Promise<void> {
  await writeFileAtomic(
    readPlanPath(root, plan.repo),
    `${HEADER}${stringify(ReadPlanFile.parse(plan), { lineWidth: 0 })}`,
  );
}

/**
 * Write (or replace) a repo's read plan. The parts are numbered in the order they are read; none
 * for a repo one session reads. What the reader reported of an earlier plan is kept.
 */
export async function writeReadPlan(
  root: string,
  repo: string,
  o: {
    commit: string;
    session: number;
    now?: string;
    parts: readonly { paths: string[]; files: number; tokens: number }[];
    estimate?: ReadPlanFileT["estimate"];
    reported?: ReadPlanFileT["reported"];
    /** ADR 0167: the rules the read is (or was) given. */
    rules?: ReadPlanFileT["rules"];
    /** ADR 0169: the models asked for, and the model files left out. */
    models?: ModelsMode;
    notReached?: NotReachedT;
  },
): Promise<ReadPlanFileT> {
  const plan: ReadPlanFileT = {
    schemaVersion: 2,
    repo,
    commit: o.commit,
    session: o.session,
    plannedAt: o.now ?? stamp(),
    ...(o.estimate ? { estimate: o.estimate } : {}),
    parts: o.parts.map((p, i) => ({
      part: i + 1,
      paths: [...p.paths],
      files: p.files,
      tokens: p.tokens,
    })),
    ...(o.reported?.length ? { reported: [...o.reported] } : {}),
    ...(o.rules ? { rules: { hash: o.rules.hash, sets: [...o.rules.sets] } } : {}),
    ...(o.models && o.models !== "reachable" ? { models: o.models } : {}),
    ...(o.notReached?.files.length ? { notReached: o.notReached } : {}),
  };
  await saveReadPlan(root, plan);
  return plan;
}

const stamp = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * ADR 0169: record in a repo's read plan which model files the read leaves out (none: the
 * record goes) and the models asked for, making a plan with no parts when there is none yet.
 * Nothing is written when the plan already says so.
 */
export async function recordNotReached(
  root: string,
  repo: string,
  o: { commit: string; session: number; models: ModelsMode; notReached?: NotReachedT },
): Promise<void> {
  const plan = await loadReadPlan(root, repo);
  const {
    notReached: _n,
    models: _m,
    ...rest
  } = plan ?? {
    schemaVersion: 2 as const,
    repo,
    commit: o.commit,
    session: o.session,
    plannedAt: stamp(),
    parts: [],
  };
  const next: ReadPlanFileT = {
    ...rest,
    ...(o.models !== "reachable" ? { models: o.models } : {}),
    ...(o.notReached?.files.length ? { notReached: o.notReached } : {}),
  };
  if (plan && JSON.stringify(plan) === JSON.stringify(next)) return;
  if (!plan && !next.notReached && !next.models) return;
  await saveReadPlan(root, next);
}

/** ADR 0169: the models mode a command uses: the one asked for, else the plan's, else reachable. */
export async function modelsModeOf(
  root: string,
  repo: string,
  asked: ModelsMode | undefined,
): Promise<ModelsMode> {
  return asked ?? (await loadReadPlan(root, repo))?.models ?? "reachable";
}

/** A repo's read plan as it is on file (a v1 plan as v2), or undefined when there is none or it doesn't read. */
export async function loadReadPlan(root: string, repo: string): Promise<ReadPlanFileT | undefined> {
  const text = await readFile(readPlanPath(root, repo), "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  try {
    return migrateReadPlan(parse(text));
  } catch {
    return undefined;
  }
}

/** Every `{file, line}` a fact cites: its cite and parts, and a flow's steps and errors. */
function citedLines(x: unknown, out: { file: string; line: number }[] = []) {
  if (Array.isArray(x)) for (const v of x) citedLines(v, out);
  else if (x && typeof x === "object") {
    const o = x as Record<string, unknown>;
    if (typeof o.file === "string" && typeof o.line === "number")
      out.push({ file: o.file, line: o.line });
    for (const v of Object.values(o)) if (v && typeof v === "object") citedLines(v, out);
  }
  return out;
}

/**
 * What the facts folder accounts for: the files a kept fact cites or that are reviewed as holding
 * no fact, the lines cited (for a file read in ranges), and the ranges reviewed by their own path.
 */
async function coveredOf(
  root: string,
  repo: string,
): Promise<{
  paths: string[];
  reviewed: Set<string>;
  lines: { file: string; line: number }[];
  ranges: Set<string>;
}> {
  const out = new Set<string>();
  const reviewed = new Set<string>();
  const lines: { file: string; line: number }[] = [];
  const ranges = new Set<string>();
  const text = await readFile(join(factsDirOf(root), `${repo}.jsonl`), "utf8").catch(
    () => undefined,
  );
  if (text !== undefined) {
    const parsed = parseFacts(text);
    const facts: readonly Fact[] = parsed.ok ? parsed.facts : [];
    for (const f of facts) {
      for (const p of citedFiles(f)) out.add(p);
      citedLines(f, lines);
    }
  }
  for (const e of (await readReviewed(root, repo)).entries)
    if (lineRangeOf(e.path)) ranges.add(e.path);
    else {
      out.add(e.path);
      reviewed.add(e.path);
    }
  return { paths: [...out], reviewed, lines, ranges };
}

/**
 * A repo's read plan with each part's state, read back from the facts. Undefined when the repo
 * has no plan on file (it fits one session, or it was never estimated).
 */
export async function readPlanProgress(
  root: string,
  repo: string,
  o: { commit?: string } = {},
): Promise<ReadPlanProgress | undefined> {
  const plan = await loadReadPlan(root, repo);
  // ADR 0141: a repo one session reads has a plan for its cost, but no parts and no ledger.
  if (!plan || !plan.parts.length) return undefined;
  return progressOf(plan, await coveredOf(root, repo), o);
}

/**
 * R4: each line range's own first line, the line after the range before it in the same file
 * ends (its `start` as `lineRanges` made it), recomputed from the plan's ranges so the plan's
 * schema stays as it is. The first range of a file starts at its `from`.
 */
export function ownStarts(plan: Pick<ReadPlanFileT, "parts">): Map<string, number> {
  const byFile = new Map<string, { glob: string; from: number; to: number }[]>();
  for (const p of plan.parts)
    for (const glob of p.paths) {
      const r = lineRangeOf(glob);
      if (r) byFile.set(r.file, [...(byFile.get(r.file) ?? []), { glob, from: r.from, to: r.to }]);
    }
  const out = new Map<string, number>();
  for (const rs of byFile.values()) {
    rs.sort((a, b) => a.from - b.from || a.to - b.to);
    let end = 0;
    for (const r of rs) {
      out.set(r.glob, Math.min(r.to, Math.max(r.from, end + 1)));
      end = Math.max(end, r.to);
    }
  }
  return out;
}

/** Each part's state from what the facts folder accounts for. */
function progressOf(
  plan: ReadPlanFileT,
  of: Awaited<ReturnType<typeof coveredOf>>,
  o: { commit?: string },
): ReadPlanProgress {
  const repo = plan.repo;
  const covered = of.paths.map(folderOf);
  const own = ownStarts(plan);
  const parts: PartState[] = plan.parts.map((p) => {
    const units = p.paths.map(unitOf);
    const hit = (u: Unit) => {
      if (u.range) {
        const r = u.range;
        // R4: only from the range's own first line; the lines it shares with the range before
        // were read there, so a fact citing one says nothing of this range.
        const start = own.get(u.glob) ?? r.from;
        return (
          of.ranges.has(u.glob) ||
          of.lines.some((l) => l.file === r.file && l.line >= start && l.line <= r.to) ||
          // The whole file reviewed, or a folder glob reviewed over it.
          of.reviewed.has(r.file) ||
          [...of.reviewed].some((c) => folderOf(c).deep && under(u.dir, folderOf(c).dir))
        );
      }
      // ADR 0169: a file named alone is done when a fact cites it or a reviewed line names it,
      // not when another file of its folder is.
      if (u.file)
        return (
          of.paths.includes(u.file) ||
          [...of.reviewed].some((c) => isGlobPath(c) && globToRegExp(c).test(u.file!))
        );
      return covered.some((c) =>
        u.deep ? under(c.dir, u.dir) : c.dir === u.dir || (c.deep && under(u.dir, c.dir)),
      );
    };
    // ADR 0170: a part verify found accounted for (every file under it cited, reviewed, excluded
    // or left out as not reached) is stamped read, and stays done: the same count verify says.
    if (p.read) return { ...p, state: "done", covered: p.paths, left: [] };
    const yes = units.filter(hit).map((u) => u.glob);
    const no = units.filter((u) => !hit(u)).map((u) => u.glob);
    return {
      ...p,
      state: no.length === 0 ? "done" : yes.length ? "in-progress" : "to-read",
      covered: yes,
      left: no,
    };
  });
  const done = parts.filter((p) => p.state === "done").length;
  const next = parts.find((p) => p.state !== "done");
  return {
    repo,
    commit: plan.commit,
    session: plan.session,
    plannedAt: plan.plannedAt,
    parts,
    total: parts.length,
    done,
    ...(next ? { next } : {}),
    stale: o.commit !== undefined && o.commit !== plan.commit,
  };
}

/** ADR 0170: a unit of a part verify's coverage leaves unaccounted, with the files under it. */
export interface Unaccounted {
  glob: string;
  /** The source files under it verify lists as unknown; none for a line range no fact cites. */
  files: string[];
}

/**
 * ADR 0170: what of a part is left unaccounted, by verify's own count: under each folder glob
 * (or file named alone), the files `coverage.unknown` lists, which no fact cites, no reviewed
 * line names, and which are neither excluded nor left out as not reached. A line range, which
 * verify counts by its file, is left while no fact cites a line in it (`left`, from the facts).
 * None: the part is accounted for.
 */
export function partUnaccounted(
  part: Pick<PartState, "paths" | "left">,
  unknown: readonly string[],
): Unaccounted[] {
  const out: Unaccounted[] = [];
  for (const glob of part.paths) {
    if (lineRangeOf(glob)) {
      if (part.left.includes(glob)) out.push({ glob, files: [] });
      continue;
    }
    const files = unknown.filter((f) => globHolds(glob, f));
    if (files.length) out.push({ glob, files });
  }
  return out;
}

/** "part 4 of 13" — how a command names where a part read stands. */
export const partOfWords = (p: Pick<ReadPlanProgress, "total"> & { part: number }) =>
  `part ${p.part} of ${p.total}`;

const sameCommit = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);

/**
 * ADR 0141: what `atticus verify` records of a read, from the facts it just wrote: each part the
 * facts now account for is stamped with when and at which commit it was first seen read, and the
 * whole read once every part is (or, for a repo one session reads, once it has kept facts). A
 * stamp is never moved or taken back, so re-verifying changes nothing. Only a plan of the commit
 * being verified is stamped; a plan of another commit is stale and left for --estimate.
 */
export async function recordReadProgress(
  root: string,
  repo: string,
  o: {
    commit: string | undefined;
    kept: number;
    now?: string;
    /**
     * ADR 0170: verify's `coverage.unknown`, the source files no fact cites, no reviewed line
     * names and neither excluded nor left out as not reached. A part none of them is under is
     * accounted for as verify counts it, and stamped read.
     */
    unknown?: readonly string[];
  },
): Promise<ReadPlanFileT | undefined> {
  const plan = await loadReadPlan(root, repo);
  if (!plan || !o.commit || !sameCommit(plan.commit, o.commit)) return undefined;
  const at = o.now ?? stamp();
  const read = { at, commit: o.commit };
  let changed = false;
  let parts = plan.parts;
  let whole = plan.parts.length === 0 && o.kept > 0;
  if (plan.parts.length) {
    const progress = progressOf(plan, await coveredOf(root, repo), {});
    parts = plan.parts.map((p, i) => {
      const state = progress.parts[i]!;
      if (p.read) return p;
      if (state.state !== "done" && !(o.unknown && !partUnaccounted(state, o.unknown).length))
        return p;
      changed = true;
      return { ...p, read };
    });
    whole = parts.every((p) => p.read);
  }
  const next: ReadPlanFileT = {
    ...plan,
    parts,
    ...(whole && !plan.read
      ? { read: { ...read, sessions: plan.parts.length || 1 } }
      : plan.read
        ? { read: plan.read }
        : {}),
  };
  if (whole && !plan.read) changed = true;
  if (!changed) return plan;
  await saveReadPlan(root, next);
  return next;
}

/** ADR 0141: add what the reader reports a read took to the plan (`atticus map <repo> --spent`). */
export async function recordReported(
  root: string,
  repo: string,
  r: Omit<ReadPlanReport, "at" | "commit"> & { at?: string },
): Promise<ReadPlanFileT | undefined> {
  const plan = await loadReadPlan(root, repo);
  if (!plan) return undefined;
  const entry: ReadPlanReport = {
    at: r.at ?? stamp(),
    commit: plan.commit,
    ...(r.tokens ? { tokens: r.tokens } : {}),
    ...(r.sessions ? { sessions: r.sessions } : {}),
    ...(r.part ? { part: r.part } : {}),
    ...(r.by ? { by: r.by } : {}),
  };
  const next = { ...plan, reported: [...(plan.reported ?? []), entry] };
  await saveReadPlan(root, next);
  return next;
}

/**
 * What a repo's read cost, as the plan records it (ADR 0141), with each number saying where it
 * comes from: `estimated` is --estimate's count (tokens are estimated from the source, never
 * metered); `read` is what Atticus saw in the facts (the parts read, one session each as
 * planned); `reported` is the reader's word, summed over its reports of this plan's commit.
 */
export interface ReadCost {
  commit: string;
  session: number;
  estimated?: { tokens: number; files: number; sessions: number; reread?: true };
  /** Parts read so far (as planned, one session each), and when the whole read was done. */
  read: { parts: number; of: number; at?: string };
  reported?: { tokens?: number; sessions?: number; reports: number };
}

export function readCostOf(plan: ReadPlanFileT): ReadCost {
  const ofCommit = (plan.reported ?? []).filter((r) => sameCommit(r.commit, plan.commit));
  const sum = (k: "tokens" | "sessions") =>
    ofCommit.some((r) => r[k] !== undefined)
      ? ofCommit.reduce((n, r) => n + (r[k] ?? 0), 0)
      : undefined;
  const tokens = sum("tokens");
  const sessions = sum("sessions");
  const of = plan.parts.length || 1;
  return {
    commit: plan.commit,
    session: plan.session,
    ...(plan.estimate ? { estimated: plan.estimate } : {}),
    read: {
      parts: plan.parts.length ? plan.parts.filter((p) => p.read).length : plan.read ? 1 : 0,
      of,
      ...(plan.read ? { at: plan.read.at } : {}),
    },
    ...(ofCommit.length
      ? {
          reported: {
            ...(tokens !== undefined ? { tokens } : {}),
            ...(sessions !== undefined ? { sessions } : {}),
            reports: ofCommit.length,
          },
        }
      : {}),
  };
}

/** A token count in words: 61K, 1.2M. */
export const tokensWords = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
    : n >= 1000
      ? `${Math.round(n / 1000)}K`
      : String(n);

/** A read's cost in a sentence, saying which numbers are estimates and which the reader's word. */
export function readCostWords(c: ReadCost): string {
  const out: string[] = [];
  if (c.estimated)
    out.push(
      `estimated about ${tokensWords(c.estimated.tokens)} tokens in ${c.estimated.sessions} session${c.estimated.sessions === 1 ? "" : "s"}${c.estimated.reread ? " (a re-read)" : ""}`,
    );
  if (c.read.of > 1 || c.read.parts)
    out.push(
      c.read.at
        ? `read in ${c.read.of} part${c.read.of === 1 ? "" : "s"}`
        : `${c.read.parts} of ${c.read.of} part${c.read.of === 1 ? "" : "s"} read`,
    );
  if (c.reported)
    out.push(
      `reported ${[
        c.reported.tokens !== undefined ? `${tokensWords(c.reported.tokens)} tokens` : "",
        c.reported.sessions !== undefined
          ? `${c.reported.sessions} session${c.reported.sessions === 1 ? "" : "s"}`
          : "",
      ]
        .filter(Boolean)
        .join(" in ")}`,
    );
  return out.join("; ");
}

/**
 * atticus map <repo> --spent <tokens> [--sessions n] [--part n] (ADR 0141): record what the read
 * took as the reader reports it. Atticus runs no model here and meters nothing, so the numbers
 * are kept as the reader's word, beside --estimate's estimate, under the plan's commit.
 */
export async function mapSpent(
  root: string,
  repo: string,
  o: { spent?: string; sessions?: string; part?: string; by?: string },
  io: { out: (l: string) => void; err: (l: string) => void },
): Promise<number> {
  const count = (v: string | undefined, what: string): number | undefined | false => {
    if (v === undefined) return undefined;
    const n = Number(v.replace(/[_,]/g, "").replace(/k$/i, "000"));
    if (Number.isInteger(n) && n > 0) return n;
    io.err(`${what} is a whole number above 0 (got ${v}).`);
    return false;
  };
  const tokens = count(o.spent, "--spent");
  const sessions = count(o.sessions, "--sessions");
  const part = count(o.part, "--part");
  if (tokens === false || sessions === false || part === false) return 2;
  if (tokens === undefined && sessions === undefined) {
    io.err("Usage: atticus map <repo> --spent <tokens> [--sessions n] [--part n]");
    return 2;
  }
  const plan = await loadReadPlan(root, repo);
  if (!plan) {
    io.err(
      `${repo} has no read plan (${readPlanRelOf(root, repo)}) to record it in: run atticus map ${repo} --estimate first; it records the estimate the read is compared with.`,
    );
    return 2;
  }
  if (part !== undefined && !plan.parts.some((p) => p.part === part)) {
    io.err(
      `${repo}'s read plan has ${plan.parts.length ? `parts 1 to ${plan.parts.length}` : "no parts (one session reads it)"}: there is no part ${part}.`,
    );
    return 2;
  }
  const next = await recordReported(root, repo, {
    ...(tokens ? { tokens } : {}),
    ...(sessions ? { sessions } : {}),
    ...(part ? { part } : {}),
    ...(o.by ? { by: o.by } : {}),
  });
  const cost = readCostOf(next!);
  io.out(
    `Recorded in ${readPlanRelOf(root, repo)}, as reported (Atticus meters nothing): ${readCostWords(cost)}.`,
  );
  return 0;
}
