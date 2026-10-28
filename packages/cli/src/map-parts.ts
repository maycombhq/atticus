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

const Part = z.strictObject({
  part: z.number().int().positive(),
  paths: z.array(z.string().min(1)).min(1),
  files: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
});

export const ReadPlanFile = z.strictObject({
  schemaVersion: z.literal(1),
  repo: z.string().min(1),
  /** The commit the plan was made at; the plan is stale at another commit. */
  commit: z.string().min(1),
  /** The session token budget the parts were planned for. */
  session: z.number().int().positive(),
  plannedAt: z.string().min(1),
  parts: z.array(Part).min(1),
});
export type ReadPlanFileT = z.infer<typeof ReadPlanFile>;

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
  /** A range of one file too big for a session: done by a cited line in it (or its own path). */
  range?: { file: string; from: number; to: number };
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
  return { glob, dir: glob.replace(/\/?[^/]*$/, ""), deep: false };
}

/** The folder a covered path sits in; a reviewed glob stands for its own folder, and below. */
function folderOf(path: string): { dir: string; deep: boolean } {
  const star = path.search(/[*?]/);
  if (star < 0) return { dir: path.replace(/\/?[^/]*$/, ""), deep: false };
  return { dir: path.slice(0, star).replace(/\/$/, ""), deep: true };
}

const under = (dir: string, of: string) => of === "" || dir === of || dir.startsWith(`${of}/`);

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

/** Write (or replace) a repo's read plan. The parts are numbered in the order they are read. */
export async function writeReadPlan(
  root: string,
  repo: string,
  o: {
    commit: string;
    session: number;
    now?: string;
    parts: readonly { paths: string[]; files: number; tokens: number }[];
  },
): Promise<ReadPlanFileT> {
  const plan: ReadPlanFileT = {
    schemaVersion: 1,
    repo,
    commit: o.commit,
    session: o.session,
    plannedAt: o.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    parts: o.parts.map((p, i) => ({
      part: i + 1,
      paths: [...p.paths],
      files: p.files,
      tokens: p.tokens,
    })),
  };
  await writeFileAtomic(
    readPlanPath(root, repo),
    `# The parts this repo is read in (ADR 0124 addendum A-ledger), as atticus map --estimate planned them.\n# Which part is next is read back from the facts; atticus next says it. Atticus writes this file.\n${stringify(plan, { lineWidth: 0 })}`,
  );
  return plan;
}

/** A repo's read plan as it is on file, or undefined when there is none or it doesn't read. */
export async function loadReadPlan(root: string, repo: string): Promise<ReadPlanFileT | undefined> {
  const text = await readFile(readPlanPath(root, repo), "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  try {
    const r = ReadPlanFile.safeParse(parse(text));
    return r.success ? r.data : undefined;
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
  if (!plan) return undefined;
  const of = await coveredOf(root, repo);
  const covered = of.paths.map(folderOf);
  const parts: PartState[] = plan.parts.map((p) => {
    const units = p.paths.map(unitOf);
    const hit = (u: Unit) => {
      if (u.range) {
        const r = u.range;
        return (
          of.ranges.has(u.glob) ||
          of.lines.some((l) => l.file === r.file && l.line >= r.from && l.line <= r.to) ||
          // The whole file reviewed, or a folder glob reviewed over it.
          of.reviewed.has(r.file) ||
          [...of.reviewed].some((c) => folderOf(c).deep && under(u.dir, folderOf(c).dir))
        );
      }
      return covered.some((c) =>
        u.deep ? under(c.dir, u.dir) : c.dir === u.dir || (c.deep && under(u.dir, c.dir)),
      );
    };
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

/** "part 4 of 13" — how a command names where a part read stands. */
export const partOfWords = (p: Pick<ReadPlanProgress, "total"> & { part: number }) =>
  `part ${p.part} of ${p.total}`;
