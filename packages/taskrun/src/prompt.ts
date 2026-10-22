import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AgentDefinition, changesRelOf, taskBranch } from "@maycombhq/core";
import { buildContextPack, type ContextPack, type SourceInput } from "@maycombhq/ai";
import type { TaskContext } from "@maycombhq/speckit";
import type { GitRunner } from "@maycombhq/workspace";
import { FILE_FORMAT } from "./apply.js";
import type { RunLevel } from "./store.js";

/**
 * The task runner's agent and context pack (C5). Trusted text first: Atticus's instructions
 * for the level, the skills that apply to the repo type and the safety rules. Everything else
 * (the change's story, design, interfaces, mappings and data, the handed-down Spec Kit
 * feature, the repo's file list, a build log) is wrapped as data, never instructions.
 */

export const TASK_RUNNER = "task-runner";

export function taskRunnerAgent(t: TaskContext): AgentDefinition {
  const own = t.ctx.orgPack.agents.find((a) => a.id === TASK_RUNNER);
  if (own) return own;
  return AgentDefinition.parse({
    schemaVersion: 1,
    id: TASK_RUNNER,
    role: "developer",
    description:
      "Implements one task of a change in its repo, with tests, within the approved design.",
    inputs: ["stories", "design", "interfaces", "data", "mappings", "skills", "repo-code"],
    outputArtifact: "code",
    tokenBudget: t.ctx.orgPack.runtime.budgets.defaultTokens,
    allowedRuntimes: ["hand-off", "model", "headless-claude-code", "mock", "replay"],
  });
}

export interface PackInput {
  t: TaskContext;
  level: RunLevel;
  engine: "speckit" | "atticus";
  /** The task worktree, where the repo files are read from. */
  worktree: string;
  /** The worktree path relative to the metarepo, for hand-off instructions. */
  worktreeRel: string;
  oneShot: boolean;
  git: GitRunner;
  /** A failing build's log for a fix run. */
  buildLog?: { command: string; text: string; attempt: number };
  now: Date;
}

function instructions(p: PackInput): string {
  const { t } = p;
  const branch = taskBranch(t.change.id, t.task.id);
  const feature =
    p.engine === "speckit"
      ? `The task's Spec Kit feature is \`specs/${t.task.id}/\` (spec.md, plan.md, data-model.md, contracts/, tasks.md): follow it, and keep tasks.md's boxes up to date.`
      : `The task file is \`.atticus/tasks/${t.task.id}.md\`.`;
  const common = [
    `# Run with AI: task ${t.task.id} of change ${t.change.id}`,
    "",
    `Task: ${t.task.title}. Repo: ${t.repo.id} (component ${t.component}), branch \`${branch}\`.`,
    feature,
    "",
    "Rules that always hold:",
    "- Stay inside the approved design. If the work needs an interface, table or system the design doesn't list, don't add it: say so in your report as a question for the architect.",
    "- Never push, merge, deploy or touch a protected branch; Atticus raises the pull request with a person's approval.",
    "- Don't edit `.specify/memory/constitution.md`: it is generated from the org pack.",
    "- needs.md (when the change has one) is what the organisation needs of this change: follow its standards and patterns for this task, its story and the whole change. Its requests and processes are a person's to raise, never yours. An item marked not yet verified was read from a wiki and no person has checked it: follow it, and say in your report if it looks wrong for this code.",
  ];
  if (p.buildLog)
    return [
      ...common,
      "",
      `## Fix the build (attempt ${p.buildLog.attempt})`,
      "",
      `\`${p.buildLog.command}\` failed after your last change. Its log is in the data below. Fix the cause in the code or tests; don't weaken or delete a test to make it pass.`,
      "",
      p.oneShot ? FILE_FORMAT : "Edit the files in the worktree, then stop.",
    ].join("\n");
  if (p.level === "plan")
    return [
      ...common,
      "",
      "## Plan only",
      "",
      "Change no code. Write the plan for this task in Markdown: the files to add or change with what changes in each, the tests to write for each acceptance criterion, the order of the work, risks, and open questions for the architect. Write only the plan.",
    ].join("\n");
  return [
    ...common,
    "",
    "## Draft the change",
    "",
    "Make the code and test changes the task needs, tested against every acceptance criterion. Atticus runs the build afterwards and sends failures back to you.",
    "",
    p.oneShot
      ? FILE_FORMAT
      : `Work in \`${p.worktreeRel}\` only. When you are done, write a short report of what you changed and why.`,
  ].join("\n");
}

/**
 * A file of the task worktree as the pack sees it. Git may check it out with CRLF line endings
 * (Windows' default `core.autocrlf=true`); the pack, and with it the prompt hash a recorded
 * answer is found by, must not depend on that, so line endings are LF here.
 */
async function readIf(path: string): Promise<string | undefined> {
  return readFile(path, "utf8").then(
    (t) => t.replace(/\r\n/g, "\n"),
    () => undefined,
  );
}

export async function taskPack(p: PackInput): Promise<ContextPack> {
  const { t } = p;
  const agent = taskRunnerAgent(t);
  const levels = t.ctx.orgPack.pack?.classification ?? [
    "public",
    "internal",
    "confidential",
    "restricted",
  ];
  const skills = t.ctx.orgPack.skills.filter(
    (s) =>
      s.status === "active" &&
      (s.appliesTo.repoTypes.length === 0 || s.appliesTo.repoTypes.includes(t.repo.type)),
  );
  const sources: SourceInput[] = [
    {
      id: "0-instructions",
      kind: "instruction",
      origin: "atticus/taskrun",
      text: instructions(p),
      classification: "public",
      trusted: true,
    },
    ...skills.map((s) => ({
      id: `skill-${s.id}`,
      kind: "skill" as const,
      origin: `org-pack/process/skills/${s.id}/SKILL.md`,
      text: `## Skill: ${s.name}\n\n${s.body.trim()}`,
      classification: "public",
      trusted: true,
    })),
  ];
  const artifact = (rel: string, priority: number) => {
    const d = t.files.docs.get(rel);
    if (d)
      sources.push({
        id: rel,
        kind: "artifact",
        origin: `${changesRelOf(t.root)}/${t.change.id}/${rel}`,
        text: d.raw,
        classification: "internal",
        priority,
      });
  };
  for (const s of t.task.stories) artifact(`stories/${s}.md`, 30);
  for (const a of ["design.md", "interfaces.md", "mappings.md", "data.md"]) artifact(a, 20);
  // ADR 0101: what the organisation needs of the change: the standards to follow, the requests
  // a person raises. Items not yet verified are there too, marked.
  const needs = await readIf(
    join(t.root, ...changesRelOf(t.root).split("/"), t.change.id, "needs.md"),
  );
  if (needs !== undefined)
    sources.push({
      id: "needs.md",
      kind: "artifact",
      origin: `${changesRelOf(t.root)}/${t.change.id}/needs.md`,
      text: needs,
      classification: "internal",
      priority: 25,
    });
  const featureFiles =
    p.engine === "speckit"
      ? ["spec.md", "plan.md", "data-model.md", "tasks.md", "research.md", "quickstart.md"].map(
          (f) => `specs/${t.task.id}/${f}`,
        )
      : [`.atticus/tasks/${t.task.id}.md`];
  for (const f of featureFiles) {
    const text = await readIf(join(p.worktree, f));
    if (text !== undefined)
      sources.push({
        id: `repo:${f}`,
        kind: "code",
        origin: `${t.repo.id}:${f}`,
        text,
        classification: "internal",
        priority: 40,
      });
  }
  const listed = await p.git(["ls-files"], p.worktree).then(
    (r) => r.stdout.trim().split("\n").filter(Boolean),
    () => [] as string[],
  );
  if (listed.length)
    sources.push({
      id: "repo:files",
      kind: "code",
      origin: `${t.repo.id}:git ls-files`,
      text: `Files in ${t.repo.id}:\n${listed.slice(0, 400).join("\n")}${listed.length > 400 ? `\n(and ${listed.length - 400} more)` : ""}`,
      classification: "internal",
      priority: 10,
    });
  if (p.buildLog)
    sources.push({
      id: `build-log-${p.buildLog.attempt}`,
      kind: "document",
      origin: `build: ${p.buildLog.command}`,
      text: p.buildLog.text.split("\n").slice(-200).join("\n"),
      classification: "internal",
      priority: 50,
    });
  return buildContextPack({
    change: t.change.id,
    agent: agent.id,
    budget: t.ctx.orgPack.runtime.budgets.perAgent[agent.id] ?? agent.tokenBudget,
    sources,
    levels,
    maxClassification: levels.includes("confidential") ? "confidential" : levels.at(-1)!,
    now: p.now,
  });
}
