import { z } from "zod";
import { GENERATED_MARK } from "@maycombhq/changes";
import type { StageIssue } from "./loop.js";
import { bareWords, inAfterOrder, OPERATIONS_FILE, operationSchedule } from "./operations.js";
import { redactWords, type Operation, type Wave } from "./schema.js";

/**
 * ADR 0203 part B, point 5: stories and tasks of operations, by a small renderer of their own
 * beside the flow path (the ADR's fallback: stories.ts assumes a flow behind every story). One
 * story an operation, one task a repo of it, made without a model; the assistant words the story
 * and writes each task's criteria. The same files out: stories/<id>.md, rows of stories.md, lines
 * of tasks.md under `## <repo>` with `(after …)` for waves (ADR 0201), and one capability a repo,
 * `<repo>-operations`, in specs/.
 */

const Words = z.string().trim().min(1).transform(redactWords);
/** The assistant's words for one operation's story, in the story writer's answer. */
export const OperationWords = z.strictObject({
  /** The operation's id, as `_operations.yaml` has it. */
  id: z.string(),
  title: Words,
  asA: Words,
  iWant: Words,
  soThat: Words,
  tasks: z
    .array(z.strictObject({ repo: z.string(), criteria: z.array(Words).default([]) }))
    .default([]),
});
export type OperationWords = z.infer<typeof OperationWords>;

export interface OperationTask {
  /** As tasks.md numbers it: `o<story>.<repo>`. */
  label: string;
  repo: string;
  wave: number;
  /** The tasks it waits for: the last tasks of the wave before, and its operation's `after`. */
  after: string[];
}
export interface OperationStory {
  id: string;
  operation: Operation;
  tasks: OperationTask[];
}

/** The stories and tasks the operations give, in file order; no model. */
export function operationStories(
  ops: readonly Operation[],
  waves?: readonly Wave[],
): OperationStory[] {
  const { tasks } = operationSchedule(ops, waves);
  return ops.map((o, i) => ({
    id: `o${i + 1}-${o.id}`,
    operation: o,
    tasks: tasks
      .filter((t) => t.operation === o)
      .map((t) => ({
        label: t.label,
        repo: t.repo,
        wave: t.wave,
        after: t.waits.map((x) => x.label),
      })),
  }));
}

/** The skeleton the story writer reads: each operation's story and its tasks, as data. */
export const operationSkeleton = (stories: readonly OperationStory[]): string =>
  stories
    .map((s) =>
      [
        `story ${s.id}: ${s.operation.kind} operation ${s.operation.id} "${bareWords(s.operation.what)}"${s.operation.undo ? `; undo: ${bareWords(s.operation.undo)}` : ""}`,
        ...s.tasks.map((t) => `  task ${t.label}: in repo ${t.repo}, wave ${t.wave}`),
      ].join("\n"),
    )
    .join("\n");

export const OPERATION_STORIES_FORMAT = `
operations:    # one entry per operation story listed; its words, and a task per repo
  - id: <the operation's id, exactly as listed>
    title: <a short title>
    asA: <who>
    iWant: <what>
    soThat: <why>
    tasks:
      - repo: <the task's repo, exactly as listed>
        criteria:
          - "Given <how the repo is today>, when <the operation is done>, then <what a person or a rescan can check in the repo>"`;
export const OPERATION_STORIES_RULE =
  "\n- An operation story has no flow: write its words and, for each repo's task, criteria a person or a test can check in that repo (a deploy file, a setting's key, a pipeline's step). A cut-over's criteria say what shows it worked and that its undo was tried. Never write a secret's value.";

/** The checks of the operations' words: every story worded, every repo's task with criteria. */
export function checkOperationStories(
  words: readonly OperationWords[] | undefined,
  stories: readonly OperationStory[],
): StageIssue[] {
  const out: StageIssue[] = [];
  const issue = (rule: string, target: string, message: string, repo?: string) =>
    out.push({
      rule: `stories.${rule}`,
      target,
      message,
      blocking: true,
      ...(repo ? { repo } : {}),
    });
  for (const w of words ?? []) {
    const s = stories.find((x) => x.operation.id === w.id);
    if (!s)
      issue(
        "unknown-story",
        w.id,
        `Operation ${w.id} isn't one of the change's operations: ${stories.map((x) => x.operation.id).join(", ") || "it has none"}.`,
      );
    else
      for (const t of w.tasks.filter((t) => !s.tasks.some((x) => x.repo === t.repo)))
        issue(
          "unknown-task",
          `${s.id}:${t.repo}`,
          `Operation ${w.id} has no task in ${t.repo}: its repos are ${s.operation.repos.join(", ")}.`,
        );
  }
  for (const s of stories) {
    const w = words?.find((x) => x.id === s.operation.id);
    if (!w) {
      issue(
        "missing-story",
        s.id,
        `Story ${s.id} (operation ${s.operation.id}) has no wording: write its title, who, what and why, and a task with criteria for each of ${s.operation.repos.join(", ")}.`,
      );
      continue;
    }
    for (const t of s.tasks)
      if (!w.tasks.find((x) => x.repo === t.repo)?.criteria.length)
        issue(
          "no-criteria",
          t.label,
          `Task ${t.label} (operation ${s.operation.id} in ${t.repo}) has no acceptance criteria: write at least one a person or a test can check.`,
          t.repo,
        );
  }
  return out;
}

const criteriaOf = (w: OperationWords | undefined, repo: string) =>
  w?.tasks.find((t) => t.repo === repo)?.criteria ?? [];
const taskTitle = (s: OperationStory) => bareWords(s.operation.what).replace(/\s+/g, " ");

function renderStory(s: OperationStory, w: OperationWords | undefined): string {
  const o = s.operation;
  const sets = Object.entries(o.sets ?? {}).map(([k, v]) => `${k} ${v}`);
  return [
    `${GENERATED_MARK} stories from the operations (${OPERATIONS_FILE}). Edit the wording freely; tasks come from the operations. -->`,
    `# ${w?.title ?? taskTitle(s)}`,
    "",
    w
      ? `As a ${bareWords(w.asA)} I want ${bareWords(w.iWant)} so that ${bareWords(w.soThat)}.`
      : o.what,
    "",
    "## Context",
    "",
    `Operation ${o.id} (${o.kind}): ${o.what} It is work that changes no runtime step, so it has no flow; today's state and what it becomes are in design.md under Operations.`,
    "",
    "## Tasks",
    "",
    ...s.tasks.flatMap((t) => [
      `### Task ${t.label}: ${taskTitle(s)} (${t.repo})`,
      "",
      `- Operation: ${o.id} (${o.kind}), in ${OPERATIONS_FILE}; wave ${t.wave}`,
      ...(o.today?.length ? [`- Today: ${o.today.join(", ")} (catalog records)`] : []),
      ...(sets.length ? [`- Sets: ${sets.join(", ")}`] : []),
      ...(t.after.length ? [`- After: ${t.after.join(", ")}`] : []),
      ...(o.undo ? [`- Undo: ${o.undo}`] : []),
      `- Acceptance criteria: the ${criteriaOf(w, t.repo).length} under Task ${t.label} in Acceptance criteria`,
      "",
    ]),
    "## Acceptance criteria",
    "",
    ...s.tasks.flatMap((t) => [
      `Task ${t.label}:`,
      "",
      ...(criteriaOf(w, t.repo).length
        ? criteriaOf(w, t.repo).map((c) => `- ${c}`)
        : ["- None yet."]),
      "",
    ]),
    "## Traces to",
    "",
    `${OPERATIONS_FILE} (operation ${o.id}); ${o.repos.map((r) => `specs/${r}-operations/spec.md`).join(", ")}`,
    "",
    "## Systems and repos",
    "",
    o.repos.join(", "),
    "",
  ].join("\n");
}

/** A requirement an operation story of a repo, as the spec delta of `<repo>-operations` has it. */
export interface OperationRequirement {
  repo: string;
  name: string;
  text: string;
  criteria: string[];
}

export function operationRequirements(
  change: string,
  stories: readonly OperationStory[],
  words: readonly OperationWords[] | undefined,
): OperationRequirement[] {
  return stories.flatMap((s) => {
    const w = words?.find((x) => x.id === s.operation.id);
    return s.tasks
      .filter((t) => criteriaOf(w, t.repo).length)
      .map((t) => ({
        repo: t.repo,
        // Named for its change, so a later change with the same title is its own requirement.
        name: `${bareWords(w!.title)} (${change})`,
        text: `The team SHALL complete operation \`${s.operation.id}\` (${s.operation.kind}) in ${t.repo}: ${bareWords(s.operation.what)}.\n\nOperation: \`${s.operation.id}\`; story ${s.id} of ${change}.`,
        criteria: criteriaOf(w, t.repo),
      }));
  });
}

/**
 * The operation stories' files, and stories.md and tasks.md with their rows and lines added to
 * what the flow path wrote: a task under its repo's `## <repo>` heading (made when missing),
 * ending with `(after …)` when it waits; a person's ticks kept.
 */
export function withOperationStories(
  stories: readonly OperationStory[],
  words: readonly OperationWords[] | undefined,
  written: { index: string; tasks: string },
  ticked: ReadonlySet<string> = new Set(),
): { files: Record<string, string>; index: string; tasks: string } {
  // A change with no operation: the flows' files exactly as they were written.
  if (!stories.length) return { files: {}, ...written };
  const wordsOf = (s: OperationStory) => words?.find((x) => x.id === s.operation.id);
  const files = Object.fromEntries(
    stories.map((s) => [`stories/${s.id}.md`, renderStory(s, wordsOf(s))]),
  );
  const rows = stories.map(
    (s) =>
      `| ${s.id} | ${(wordsOf(s)?.title ?? taskTitle(s)).replace(/\|/g, "\\|")} | ${s.operation.repos.join(", ")} |  |`,
  );
  const lines = written.tasks.replace(/\n+$/, "").split("\n");
  // Repos in the order they run: by wave, then as the operations name them.
  const all = stories.flatMap((s) => s.tasks.map((t) => ({ s, t })));
  const ordered = inAfterOrder(stories.map((s) => s.operation)).flatMap((o) =>
    all.filter((x) => x.s.operation === o),
  );
  const repos = [...new Set(all.map((x) => x.t.repo))].sort(
    (a, b) => all.find((x) => x.t.repo === a)!.t.wave - all.find((x) => x.t.repo === b)!.t.wave,
  );
  for (const repo of repos) {
    const mine = ordered
      .filter((x) => x.t.repo === repo)
      .map(({ s, t }) => {
        const line = `${t.label} ${taskTitle(s)} (story ${s.id})${t.after.length ? ` (after ${t.after.join(", ")})` : ""}`;
        return `- [${ticked.has(line) ? "x" : " "}] ${line}`;
      });
    const head = lines.indexOf(`## ${repo}`);
    if (head < 0) lines.push("", `## ${repo}`, "", ...mine);
    else {
      let end = lines.findIndex((l, i) => i > head && /^##\s/.test(l));
      if (end < 0) end = lines.length;
      while (!lines[end - 1]!.trim()) end--;
      lines.splice(end, 0, ...mine);
    }
  }
  return {
    files,
    index: `${written.index.replace(/\n+$/, "")}\n${rows.join("\n")}\n`,
    tasks: `${lines.join("\n")}\n`,
  };
}
