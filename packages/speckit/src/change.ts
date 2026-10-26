import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  changeFolder,
  changeStore,
  loadChangeContext,
  writeFileAtomic,
  type ChangeContext,
} from "@maycombhq/changes";
import { RecordId, type ChangeLifecycle, type IntegrationPattern } from "@maycombhq/core";
import {
  docOf,
  parseDoc,
  readChangeFiles,
  readDataChanges,
  readHops,
  type ChangeFiles,
  type DataChange,
  type Doc,
  type Hop,
} from "@maycombhq/naysayer";
import { loadRepos, readChangeRepos, type LoadedRepo } from "@maycombhq/workspace";

/** Errors with a plain message for the CLI; `code` maps to exit codes there. */
export class SpecKitError extends Error {
  constructor(
    readonly code: "not-found" | "invalid" | "refused",
    message: string,
  ) {
    super(message);
    this.name = "SpecKitError";
  }
}

/** One line of the change's tasks.md: `- [ ] 1.2 What to do (story s1-...)` under `## <repo>`. */
export interface ChangeTask {
  id: string;
  repo: string;
  title: string;
  stories: string[];
  line: number;
  done: boolean;
}

const TASK_LINE = /^(\s*[-*]\s+\[)([ xX]?)(\]\s+)(\S+)\s+(.*)$/;

/** Read tasks.md: tasks are checkbox lines under a `## <repo id>` heading, each with an id. */
export function readChangeTasks(files: ChangeFiles): ChangeTask[] {
  const doc = docOf(files, "tasks.md");
  if (!doc) return [];
  const out: ChangeTask[] = [];
  let repo = "";
  doc.lines.forEach((l, i) => {
    const h = /^##\s+(.+?)\s*$/.exec(l);
    if (h) {
      repo = h[1]!.replace(/[`*]/g, "").trim().split(/\s+/)[0]!.toLowerCase();
      return;
    }
    const m = TASK_LINE.exec(l);
    if (!m || !repo || !RecordId.safeParse(m[4]!.toLowerCase()).success) return;
    const rest = m[5]!;
    const stories = [...rest.matchAll(/\bstor(?:y|ies)\s+([a-z0-9][a-z0-9._-]*)/gi)].map((s) =>
      s[1]!.toLowerCase().replace(/[.,)]+$/, ""),
    );
    out.push({
      id: m[4]!.toLowerCase(),
      repo,
      title: rest.replace(/\s*\((?:story|stories)\b[^)]*\)\s*$/i, "").trim(),
      stories,
      line: i + 1,
      done: m[2]!.toLowerCase() === "x",
    });
  });
  return out;
}

/** Tick a task's box in the change's tasks.md (only that line changes). */
export async function markTaskDone(
  root: string,
  changeId: string,
  task: ChangeTask,
): Promise<boolean> {
  const path = join(changeFolder(root, changeId), "tasks.md");
  const lines = (await readFile(path, "utf8")).split("\n");
  const l = lines[task.line - 1];
  const m = l === undefined ? null : TASK_LINE.exec(l.replace(/\r$/, ""));
  if (!m || m[4]!.toLowerCase() !== task.id) return false;
  if (m[2]!.toLowerCase() === "x") return false;
  lines[task.line - 1] = l!.replace(
    TASK_LINE,
    (_a, a: string, _b: string, c: string, d: string, e: string) => `${a}x${c}${d} ${e}`,
  );
  await writeFileAtomic(path, lines.join("\n"));
  return true;
}

export interface Story {
  id: string;
  title: string;
  /** The story text between the title and the first section. */
  text: string[];
  criteria: string[];
  path: string;
}

export function readStory(files: ChangeFiles, id: string): Story | undefined {
  const doc = files.docs.get(`stories/${id}.md`);
  if (!doc) return undefined;
  const title = doc.sections.find((s) => s.level === 1)?.heading ?? id;
  const first = doc.sections.find((s) => s.level === 2);
  const start = (doc.sections.find((s) => s.level === 1)?.line ?? 0) + 1;
  const end = first ? first.line - 1 : doc.lines.length;
  const text = doc.lines
    .slice(start - 1, end)
    .join("\n")
    .trim()
    .split("\n");
  const ac = doc.sections.find((s) => /acceptance criteria/i.test(s.heading));
  const criteria = ac
    ? doc.lines
        .slice(ac.line, ac.end)
        .map((l) => /^\s*[-*]\s+(.*)$/.exec(l)?.[1]?.trim())
        .filter((x): x is string => !!x)
    : [];
  return { id, title, text: text[0] === "" ? [] : text, criteria, path: doc.path };
}

/**
 * The knowledge that applies to a task, as its story file lists it under the task (ADR 0124
 * addendum B-task-knowledge): the lines under "- Knowledge that applies:" in the task's section,
 * one level less indented. Data read from the metarepo, handed down as it is.
 */
export function readTaskKnowledge(files: ChangeFiles, storyIds: string[], task: string): string[] {
  const out: string[] = [];
  for (const id of storyIds) {
    const doc = files.docs.get(`stories/${id}.md`);
    if (!doc) continue;
    const head = new RegExp(`^###\\s+Task\\s+${task.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`, "i");
    const lines = doc.rawLines;
    const at = lines.findIndex((l) => head.test(l));
    if (at < 0) continue;
    let k = lines.findIndex((l, j) => j > at && /^- Knowledge that applies:\s*$/.test(l));
    const next = lines.findIndex((l, j) => j > at && /^#{1,3}\s/.test(l));
    if (k < 0 || (next >= 0 && k > next)) continue;
    for (k += 1; k < lines.length && /^\s{2,}\S/.test(lines[k]!); k++) out.push(lines[k]!.slice(2));
  }
  return out;
}

/** Everything about one task that hand-down, hand-up and Run with AI need. */
export interface TaskContext {
  root: string;
  ctx: ChangeContext;
  change: ChangeLifecycle;
  files: ChangeFiles;
  task: ChangeTask;
  repo: LoadedRepo;
  /** The component the repo builds (manifest component, else the repo id). */
  component: string;
  hops: Hop[];
  data: DataChange[];
  patterns: Map<string, IntegrationPattern>;
}

const STATES_WITH_APPROVED_DESIGN = new Set([
  "plan",
  "build",
  "qa",
  "release-ready",
  "released",
  "post-release-review",
]);

export async function loadTask(
  root: string,
  changeId: string,
  taskId: string,
  o: { needApprovedDesign?: boolean } = {},
): Promise<TaskContext> {
  const ctx = await loadChangeContext(root);
  const change = await changeStore(root)
    .read(changeId)
    .catch((e: Error) => {
      throw new SpecKitError("not-found", e.message);
    });
  if (o.needApprovedDesign !== false && !STATES_WITH_APPROVED_DESIGN.has(change.state))
    throw new SpecKitError(
      "refused",
      `${change.id} is ${change.state}: a task is handed down only after the design is approved (plan phase or later).`,
    );
  const files = await readChangeFiles(changeFolder(root, change.id));
  const tasks = readChangeTasks(files);
  const task = tasks.find((t) => t.id === taskId.toLowerCase());
  if (!task)
    throw new SpecKitError(
      "not-found",
      tasks.length
        ? `There is no task ${taskId} in ${change.id}'s tasks.md. Tasks: ${tasks.map((t) => t.id).join(", ")}.`
        : `${change.id} has no tasks yet: tasks.md needs \`- [ ] <id> <what>\` lines under a \`## <repo>\` heading.`,
    );
  const repo = (await loadRepos(root)).find((r) => r.id === task.repo);
  if (!repo)
    throw new SpecKitError(
      "not-found",
      `Task ${task.id} is under ${task.repo}, which no repos.manifest.yaml lists.`,
    );
  return {
    root,
    ctx,
    change,
    files,
    task,
    repo,
    component: repo.component ?? repo.id,
    hops: readHops(files),
    data: readDataChanges(files),
    patterns: new Map(ctx.orgPack.patterns.map((p) => [p.code, p])),
  };
}

/** The change worktree of a repo (workspace/.worktrees/<change>/<repo>, branch change/<id>). */
export async function changeWorktree(
  root: string,
  changeId: string,
  repo: string,
): Promise<string> {
  const r = (await readChangeRepos(root, changeId))?.repos.find((x) => x.id === repo);
  if (!r)
    throw new SpecKitError(
      "refused",
      `${repo} has no worktree for ${changeId} yet. Open it first: atticus workspace open ${changeId} --repos ${repo}`,
    );
  return join(root, r.worktree);
}

/** Interface `via` from a pattern's route; undefined when the pattern is unknown. */
export function viaOf(patterns: Map<string, IntegrationPattern>, code: string): string | undefined {
  const route = patterns.get(code)?.route;
  if (!route) return undefined;
  return ["gateway", "direct", "event-bus", "pubsub", "sftp", "mq"].includes(route)
    ? route
    : "other";
}

/** A Markdown file's sections under `## <METHOD> <path>` headings (mappings.md). */
export function mappingSections(
  doc: Doc | undefined,
): { method: string; path: string; lines: string[] }[] {
  if (!doc) return [];
  return doc.sections
    .filter((s) => s.level === 2)
    .map((s) => {
      const m = /^([A-Za-z]+)\s+(\S+)$/.exec(s.heading.trim());
      if (!m) return undefined;
      const body = doc.rawLines.slice(s.line, s.end).join("\n").trim();
      return { method: m[1]!.toUpperCase(), path: m[2]!, lines: body ? body.split("\n") : [] };
    })
    .filter((x): x is NonNullable<typeof x> => !!x);
}

export const reparse = (path: string, text: string) => parseDoc(path, text);
