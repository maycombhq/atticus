import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import {
  changesRelOf,
  type ChangeHandoff,
  type ChangeLifecycle,
  type ChangeType,
} from "@maycombhq/core";
import { createGit, type GitRunner } from "@maycombhq/workspace";
import type { ChangeContext } from "./context.js";
import { phaseArtifacts, phaseStage, sha256 } from "./lifecycle.js";
import type { StageStep } from "./policy.js";
import { changeFolder, changeStore, writeFileAtomic } from "./store.js";
import type { Artifact, PhaseId } from "./types.js";

/**
 * H1: what Atticus drafted beside what was merged (ADR 0087 addendum, "drafted against merged").
 *
 * When a stage's hand-off PR is found merged, the stage's files are kept twice in the change
 * folder: as the draft commit had them (`stage/<stage>.drafted/`) and as the merge commit has
 * them (`stage/<stage>.merged/`), with `stage/<stage>.capture.yaml` naming both commits. Both
 * come from the clone's own git (no fetch, no call to the Git host): the draft is the commit on
 * the hand-off branch whose files have the sha256s change.yaml recorded at hand-off, and the
 * merge is the first commit on the base branch that merged it (its message names the branch or
 * the PR, or it descends from the draft). A merge that isn't in the clone yet is recorded as
 * waiting, and completed by `atticus change learn` after a pull. The files are Atticus's own
 * (changes-owned schema, version 1); no contract changes.
 */

export const CAPTURE_SCHEMA_VERSION = 1;

export const DraftCapture = z.object({
  schemaVersion: z.literal(CAPTURE_SCHEMA_VERSION),
  change: z.string().min(1),
  stage: z.string().min(1),
  phase: z.string().min(1),
  pr: z.object({ number: z.number().int().positive(), url: z.string().min(1) }),
  branch: z.string().min(1),
  base: z.string().min(1),
  /** captured: both sides kept. waiting-for-merge: the merge isn't in the clone yet. no-draft: the drafted files are gone. */
  state: z.enum(["captured", "waiting-for-merge", "no-draft"]),
  /** When Atticus saw the PR merged (the sync's time). */
  mergedAt: z.string().min(1),
  capturedAt: z.string().min(1),
  drafted: z.object({
    from: z.enum(["git", "working-tree", "missing"]),
    commit: z.string().optional(),
  }),
  merged: z
    .object({
      commit: z.string().min(1),
      /** The merge commit's committer date. */
      at: z.string().min(1),
      how: z.enum(["message", "ancestry"]),
    })
    .optional(),
  files: z
    .array(
      z.object({
        path: z.string().min(1),
        status: z.enum(["same", "edited", "added", "removed"]),
        drafted: z.string().optional(),
        merged: z.string().optional(),
      }),
    )
    .default([]),
  note: z.string().optional(),
});
export type DraftCapture = z.infer<typeof DraftCapture>;

/** Where a stage's pair lives, relative to the change folder. */
export const capturePaths = (stage: string) => ({
  capture: `stage/${stage}.capture.yaml`,
  drafted: `stage/${stage}.drafted`,
  merged: `stage/${stage}.merged`,
});

const HEADER =
  "# What Atticus drafted beside what was merged (H1, ADR 0087 addendum). Atticus writes this file.\n";

/** Files that are never the draft: the change's own record, the brief, the loop state, the reviews, the design export. */
function machinery(path: string): boolean {
  return (
    path === "change.yaml" ||
    path === "brief.md" ||
    path.startsWith("stage/") ||
    path.startsWith("review/") ||
    path.startsWith("questions/") ||
    path.startsWith("design/") ||
    path.startsWith("inputs/")
  );
}

function artifactMatch(path: string, a: Artifact): boolean {
  if (a === "specs") return path.startsWith("specs/") && path.endsWith(".md");
  if (a === "stories")
    return path === "stories.md" || (path.startsWith("stories/") && path.endsWith(".md"));
  return path === `${a}.md`;
}

/** Whether a path in the change folder is part of what the stage (or the phase) drafts. */
export function draftedPath(
  path: string,
  step: StageStep | undefined,
  artifacts: Artifact[],
): boolean {
  if (machinery(path)) return false;
  if (step) {
    for (const w of step.writes)
      if (w.endsWith("/") ? path.startsWith(w) : path === w) return !machinery(path);
    return step.artifacts.some((a) => artifactMatch(path, a));
  }
  return artifacts.some((a) => a !== "brief" && artifactMatch(path, a));
}

export interface CaptureInput {
  ctx: ChangeContext;
  change: ChangeLifecycle;
  type: ChangeType;
  handoff: ChangeHandoff;
  /** The branch the PR merged into. */
  base: string;
  now: string;
  git?: GitRunner;
  /** The Git host's remote in the clone; default origin. */
  remote?: string;
}

export interface CaptureResult {
  capture: DraftCapture;
  /** The capture file, relative to the change folder. */
  file: string;
}

interface Git {
  run(args: string[]): Promise<string>;
  tryRun(args: string[]): Promise<string | undefined>;
}

async function openGit(
  root: string,
  runner: GitRunner,
): Promise<{ git: Git; prefix: string } | undefined> {
  const top = await runner(["rev-parse", "--show-toplevel"], root).then(
    (r) => r.stdout.trim(),
    () => undefined,
  );
  if (!top) return undefined;
  const prefix = (await runner(["rev-parse", "--show-prefix"], root)).stdout.trim();
  const run = async (args: string[]) => (await runner(args, top)).stdout;
  return {
    git: { run, tryRun: (args) => run(args).catch(() => undefined) },
    prefix,
  };
}

/** sha256 of a file as git holds it, matching the hash taken from disk with either line ending. */
const sameText = (text: string, recorded: string) =>
  sha256(text) === recorded ||
  sha256(text.replace(/\r?\n/g, "\r\n")) === recorded ||
  sha256(text.replace(/\r\n/g, "\n")) === recorded;

async function walk(dir: string, rel = ""): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(join(dir, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walk(dir, p)));
    else out.push(p);
  }
  return out.sort();
}

interface LogEntry {
  sha: string;
  at: string;
  message: string;
}

async function firstParentLog(git: Git, ref: string): Promise<LogEntry[]> {
  const out = await git.tryRun([
    "log",
    "--first-parent",
    "-n",
    "500",
    "--format=%H%x1f%cI%x1f%B%x1e",
    ref,
  ]);
  if (!out) return [];
  return out
    .split("\x1e")
    .map((x) => x.replace(/^\s+/, ""))
    .filter(Boolean)
    .map((x) => {
      const [sha, at, message] = x.split("\x1f");
      return { sha: sha!.trim(), at: (at ?? "").trim(), message: message ?? "" };
    });
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The commit that merged the hand-off into the base branch, as far as the clone knows. */
async function findMerge(
  git: Git,
  refs: string[],
  branch: string,
  pr: number,
  draft: string | undefined,
): Promise<DraftCapture["merged"]> {
  const names = new RegExp(`(^|[^\\w.-])${escape(branch)}($|[^\\w/.-])`);
  const number = new RegExp(`(#|!|\\bPR\\s*)${pr}(?!\\d)`);
  for (const ref of refs) {
    const log = await firstParentLog(git, ref);
    if (!log.length) continue;
    // Oldest first: the first commit that merged it, not a later one that mentions it.
    const oldest = [...log].reverse();
    const byBranch = oldest.find((e) => names.test(e.message));
    const byNumber = byBranch ?? oldest.find((e) => number.test(e.message));
    if (byNumber) return { commit: byNumber.sha, at: byNumber.at, how: "message" };
    if (draft) {
      const after = await git.tryRun(["rev-list", "--ancestry-path", `${draft}..${ref}`]);
      const descendants = new Set(
        (after ?? "")
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
      );
      const merge = oldest.find((e) => descendants.has(e.sha));
      if (merge) return { commit: merge.sha, at: merge.at, how: "ancestry" };
      const ff = oldest.find((e) => e.sha === draft);
      if (ff) return { commit: ff.sha, at: ff.at, how: "ancestry" };
    }
  }
  return undefined;
}

async function existing(git: Git, refs: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const r of refs)
    if (await git.tryRun(["rev-parse", "--verify", "--quiet", `${r}^{commit}`])) out.push(r);
  return out;
}

async function blob(git: Git, commit: string, path: string): Promise<string | undefined> {
  return git.tryRun(["cat-file", "blob", `${commit}:${path}`]);
}

/** The commit on `ref` whose files have the hashes recorded at hand-off. */
async function findDraft(
  git: Git,
  ref: string,
  dirInTree: string,
  recorded: { path: string; sha256: string }[],
): Promise<string | undefined> {
  const commits = await git.tryRun(["rev-list", "-n", "100", ref, "--", dirInTree]);
  for (const c of (commits ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)) {
    let all = true;
    for (const r of recorded) {
      const text = await blob(git, c, `${dirInTree}/${r.path}`);
      if (text === undefined || !sameText(text, r.sha256)) {
        all = false;
        break;
      }
    }
    if (all) return c;
  }
  return undefined;
}

/** The stage a phase's hand-off belongs to: the stage path's stage, else the phase itself. */
export async function captureStageOf(
  ctx: ChangeContext,
  change: ChangeLifecycle,
  phase: PhaseId,
): Promise<{ name: string; step?: StageStep }> {
  const step = await phaseStage(ctx, change, phase);
  return step ? { name: step.stage, step } : { name: phase };
}

/**
 * Keep the drafted and the merged files of a merged hand-off (H1). Undefined when the metarepo
 * isn't a git clone, or the hand-off drafted nothing. Never throws for what git can't say: a
 * merge not yet in the clone is `waiting-for-merge`, a draft no commit or file has is `no-draft`.
 */
export async function captureHandoff(input: CaptureInput): Promise<CaptureResult | undefined> {
  const { ctx, change, handoff } = input;
  const root = ctx.root;
  const opened = await openGit(root, input.git ?? createGit());
  if (!opened) return undefined;
  const { git, prefix } = opened;
  const remote = input.remote ?? "origin";
  const phase = handoff.phase as PhaseId;
  const { name, step } = await captureStageOf(ctx, change, phase);
  const artifacts = phaseArtifacts(ctx, input.type, phase);
  const isDraft = (p: string) => draftedPath(p, step, artifacts);
  const recorded = handoff.artifacts.filter((a) => isDraft(a.path));
  if (!recorded.length) return undefined;

  const dirInTree = `${prefix}${changesRelOf(root)}/${change.id}`;
  const branchRefs = await existing(git, [
    `refs/heads/${handoff.branch}`,
    `refs/remotes/${remote}/${handoff.branch}`,
  ]);
  let draft: string | undefined;
  for (const ref of branchRefs) {
    draft = await findDraft(git, ref, dirInTree, recorded);
    if (draft) break;
  }
  const baseRefs = await existing(git, [
    `refs/remotes/${remote}/${input.base}`,
    `refs/heads/${input.base}`,
  ]);
  const merged = await findMerge(git, baseRefs, handoff.branch, handoff.pr.number, draft);
  // A merge commit holds the branch as its second parent, even after the host deleted it.
  if (
    !draft &&
    merged &&
    (await git.tryRun(["rev-parse", "--verify", "--quiet", `${merged.commit}^2`]))
  )
    draft = await findDraft(git, `${merged.commit}^2`, dirInTree, recorded);

  const folder = changeFolder(root, change.id);
  const draftedFiles = new Map<string, string>();
  let from: DraftCapture["drafted"]["from"] = "missing";
  if (draft) {
    from = "git";
    const listed = await git.tryRun([
      "ls-tree",
      "-r",
      "--name-only",
      "--full-tree",
      draft,
      "--",
      dirInTree,
    ]);
    const paths = new Set(recorded.map((r) => r.path));
    for (const full of (listed ?? "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)) {
      const p = full.slice(dirInTree.length + 1);
      if (isDraft(p) && paths.has(p)) {
        const t = await blob(git, draft, full);
        if (t !== undefined) draftedFiles.set(p, t);
      }
    }
  } else {
    // Not in git (no publisher pushed it from here): the working tree, if it is still the draft.
    const texts = await Promise.all(
      recorded.map(
        async (r) =>
          [
            r,
            await readFile(join(folder, ...r.path.split("/")), "utf8").catch(() => undefined),
          ] as const,
      ),
    );
    if (texts.every(([r, t]) => t !== undefined && sameText(t, r.sha256))) {
      from = "working-tree";
      for (const [r, t] of texts) draftedFiles.set(r.path, t!);
    }
  }

  const mergedFiles = new Map<string, string>();
  if (merged) {
    const listed = await git.tryRun([
      "ls-tree",
      "-r",
      "--name-only",
      "--full-tree",
      merged.commit,
      "--",
      dirInTree,
    ]);
    for (const full of (listed ?? "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)) {
      const p = full.slice(dirInTree.length + 1);
      if (!isDraft(p)) continue;
      const t = await blob(git, merged.commit, full);
      if (t !== undefined) mergedFiles.set(p, t);
    }
  }

  const state: DraftCapture["state"] =
    from === "missing" ? "no-draft" : merged ? "captured" : "waiting-for-merge";
  const paths = [
    ...new Set([...draftedFiles.keys(), ...(merged ? mergedFiles.keys() : [])]),
  ].sort();
  const files: DraftCapture["files"] = paths.map((path) => {
    const d = draftedFiles.get(path);
    const m = merged ? mergedFiles.get(path) : undefined;
    const status =
      !merged || d === m
        ? "same"
        : d === undefined
          ? "added"
          : m === undefined
            ? "removed"
            : "edited";
    return {
      path,
      status,
      ...(d !== undefined ? { drafted: sha256(d) } : {}),
      ...(m !== undefined ? { merged: sha256(m) } : {}),
    };
  });
  const capture: DraftCapture = {
    schemaVersion: CAPTURE_SCHEMA_VERSION,
    change: change.id,
    stage: name,
    phase,
    pr: handoff.pr,
    branch: handoff.branch,
    base: input.base,
    state,
    mergedAt: handoff.updatedAt ?? input.now,
    capturedAt: input.now,
    drafted: { from, ...(draft ? { commit: draft } : {}) },
    ...(merged ? { merged } : {}),
    files: state === "captured" ? files : [],
    ...(state === "waiting-for-merge"
      ? {
          note: `The merge of PR #${handoff.pr.number} isn't in this clone yet: pull ${input.base}, then run atticus change learn.`,
        }
      : state === "no-draft"
        ? {
            note: `No commit on ${handoff.branch} and no file on disk has the drafted files' hashes any more, so the draft can't be compared.`,
          }
        : {}),
  };

  const p = capturePaths(name);
  await rm(join(folder, ...p.drafted.split("/")), { recursive: true, force: true });
  await rm(join(folder, ...p.merged.split("/")), { recursive: true, force: true });
  const put = async (base: string, rel: string, text: string) => {
    const f = join(folder, ...base.split("/"), ...rel.split("/"));
    await mkdir(dirname(f), { recursive: true });
    await writeFileAtomic(f, text);
  };
  for (const [rel, t] of draftedFiles) await put(p.drafted, rel, t);
  if (state === "captured") for (const [rel, t] of mergedFiles) await put(p.merged, rel, t);
  await mkdir(join(folder, "stage"), { recursive: true });
  await writeFileAtomic(
    join(folder, ...p.capture.split("/")),
    HEADER + stringify(capture, { lineWidth: 0 }),
  );
  return { capture, file: p.capture };
}

/** A kept pair, read back: the capture and the drafted and merged files by path. */
export interface DraftPair {
  capture: DraftCapture;
  /** The change folder, relative to the metarepo root, forward slashes. */
  folder: string;
  drafted: Map<string, string>;
  merged: Map<string, string>;
}

async function readFolderFiles(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const f of await walk(dir))
    out.set(f, (await readFile(join(dir, ...f.split("/")), "utf8")).replace(/\r\n/g, "\n"));
  return out;
}

async function changeFolders(root: string): Promise<string[]> {
  const base = join(root, ...changesRelOf(root).split("/"));
  const out: string[] = [];
  const list = async (dir: string) =>
    (await readdir(dir, { withFileTypes: true }).catch(() => []))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  for (const name of await list(base)) {
    if (name === "archive")
      for (const a of await list(join(base, "archive"))) out.push(join(base, "archive", a));
    else out.push(join(base, name));
  }
  return out;
}

/** Every capture in the metarepo, open and archived changes alike, with their files. */
export async function readDraftPairs(root: string): Promise<DraftPair[]> {
  const out: DraftPair[] = [];
  for (const folder of await changeFolders(root)) {
    const names = (await readdir(join(folder, "stage")).catch(() => [] as string[]))
      .filter((f) => f.endsWith(".capture.yaml"))
      .sort();
    for (const f of names) {
      let capture: DraftCapture;
      try {
        capture = DraftCapture.parse(parse(await readFile(join(folder, "stage", f), "utf8")));
      } catch {
        continue;
      }
      const p = capturePaths(capture.stage);
      out.push({
        capture,
        folder: relative(root, folder).split(sep).join("/"),
        drafted: await readFolderFiles(join(folder, ...p.drafted.split("/"))),
        merged: await readFolderFiles(join(folder, ...p.merged.split("/"))),
      });
    }
  }
  return out;
}

/**
 * Capture every merged hand-off that has no complete capture yet: one whose merge wasn't in the
 * clone when it was synced, or one merged before Atticus kept drafts. Local only.
 */
export async function completeCaptures(
  root: string,
  ctx: ChangeContext,
  o: { now: string; git?: GitRunner; remote?: string; defaultBase?: string },
): Promise<CaptureResult[]> {
  const out: CaptureResult[] = [];
  let changes: ChangeLifecycle[];
  try {
    changes = await changeStore(root).list();
  } catch {
    return out;
  }
  for (const change of changes) {
    const type = ctx.orgPack.changeTypes.types.find((t) => t.id === change.type);
    if (!type) continue;
    for (const h of change.handoffs.filter((x) => x.state === "merged")) {
      const { name } = await captureStageOf(ctx, change, h.phase as PhaseId);
      const file = join(changeFolder(root, change.id), ...capturePaths(name).capture.split("/"));
      const prior = await readFile(file, "utf8").then(
        (t) => DraftCapture.safeParse(parse(t)),
        () => undefined,
      );
      if (
        prior?.success &&
        prior.data.pr.number === h.pr.number &&
        prior.data.state !== "waiting-for-merge"
      )
        continue;
      const base = prior?.success ? prior.data.base : (o.defaultBase ?? "main");
      const r = await captureHandoff({
        ctx,
        change,
        type,
        handoff: h,
        base,
        now: o.now,
        ...(o.git ? { git: o.git } : {}),
        ...(o.remote ? { remote: o.remote } : {}),
      });
      if (r) out.push(r);
    }
  }
  return out;
}
