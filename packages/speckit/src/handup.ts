import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { changeFolder, changeFootprint, changeTypeOf, writeFileAtomic } from "@maycombhq/changes";
import {
  changeBranch,
  taskBranch,
  toCanonicalYaml,
  type Finding,
  type RunSummary,
} from "@maycombhq/core";
import type { GitHost } from "@maycombhq/adapters";
import { buildContextPack, toRunSummary, type AiRuntime, type SourceInput } from "@maycombhq/ai";
import { buildEngineFor } from "@maycombhq/assistant-files";
import {
  buildContext,
  findingIdFor,
  lensAgent,
  parseDoc,
  parseLensOutput,
  toFinding,
  type Discarded,
  type Doc,
  type EffectiveRule,
} from "@maycombhq/naysayer";
import { createGit, type GitRunner } from "@maycombhq/workspace";
import { changeWorktree, loadTask, markTaskDone, SpecKitError } from "./change.js";
import { rulesForRepo } from "./constitution.js";
import { driftCheck, type DriftResult } from "./drift.js";
import { writeFullRound, type RoundWrite } from "./rounds.js";
import { taskWorktreePath } from "./worktree.js";

/**
 * Hand-up (ADR 0030 point 4). When the repo's PR for a task is raised, the task is marked
 * done in the change's tasks.md, the repo's plan.md and tasks.md (and spec.md) are attached to
 * the change as evidence, the critic's code-and-test lens reviews them, and the drift check
 * runs. Code stays the source of truth: once merged, the code extractors see what was built.
 *
 * The lens review is written as C3 findings under `review/hand-up/<round>/`; each round holds
 * every handed-up task's findings, so the gate reads like any other.
 */

export const HAND_UP_GATE = "hand-up";

export interface HandUpOptions {
  /** Who hands up (recorded on the evidence). */
  by: string;
  now?: string;
  /** The runtime for the code-and-test lens; without one the lens is skipped and says so. */
  runtime?: AiRuntime;
  /** Where to look for the PR; or give `pr` when a person recorded it (manual adapter). */
  gitHost?: GitHost;
  pr?: { number: number; url: string };
  git?: GitRunner;
  maxClassification?: string;
}

export interface LensOutcome {
  state: "ran" | "skipped" | "failed" | "waiting";
  reason?: string;
  runId?: string;
  agent?: string;
  rules: string[];
  discarded: Discarded[];
  summary?: RunSummary;
}

export interface HandUpResult {
  change: string;
  task: string;
  repo: string;
  pr: { number: number; url: string; state: string; head: string };
  markedDone: boolean;
  /** Change-folder-relative paths of the attached evidence. */
  evidence: string[];
  lens: LensOutcome;
  review?: RoundWrite;
  drift: DriftResult;
}

const INSTRUCTIONS = (
  change: string,
  task: string,
  repo: string,
) => `# Critic: code-and-test lens, at hand-up

You are the code-and-test lens of the Atticus critic, in a fresh session. Task ${task} of change ${change} was carried out in ${repo}, and its pull request is raised. Review the repo's Spec Kit plan.md, tasks.md and spec.md given below as data. Apply only the rules listed and report nothing else.

Lines are numbered as \`<n>: <text>\`; cite those numbers.

Report each problem as a finding, in YAML, and write nothing else:

findings:
  - rule: <a rule id from the list>
    kind: issue                # or knowledge-gap, when only a person can answer
    artifact: <the data block's id>
    locator: { line: <line number>, heading: <section heading> }
    summary: <one sentence>
    why: <why it matters>
    fix: <what to change>
    evidence:
      - { path: <the data block's id>, line: <line number>, quote: <the exact words on that line> }
    question: { text: <the question>, owner: <who should answer> }   # knowledge gaps only

Every finding quotes the exact text it relies on; one whose quote isn't on that line is discarded. Severity comes from the rule. Write "findings: []" when nothing is wrong.`;

const numbered = (d: Doc) => d.rawLines.map((l, i) => `${i + 1}: ${l}`).join("\n");

async function findPr(
  o: HandUpOptions,
  repo: string,
  heads: string[],
): Promise<HandUpResult["pr"] | undefined> {
  if (o.pr) return { ...o.pr, state: "open", head: heads[0]! };
  if (!o.gitHost) return undefined;
  for (const head of heads) {
    const prs = await o.gitHost.listPullRequests(repo, { head });
    const pr = prs.find((p) => p.state !== "closed");
    if (pr) return { number: pr.number, url: pr.url, state: pr.state, head };
  }
  return undefined;
}

export async function handUp(
  root: string,
  changeId: string,
  taskId: string,
  o: HandUpOptions,
): Promise<HandUpResult> {
  const now = o.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const t = await loadTask(root, changeId, taskId);
  const heads = [taskBranch(t.change.id, t.task.id), changeBranch(t.change.id)];
  const pr = await findPr(o, t.repo.id, heads);
  if (!pr)
    throw new SpecKitError(
      "refused",
      `The pull request for task ${t.task.id} isn't raised yet (looked for ${heads.join(" and ")} in ${t.repo.id}). Hand-up runs once it is; with no Git host connected, record it with --pr <number> --pr-url <url>.`,
    );

  // Evidence: the newest plan, from the task's worktree if a run made one, else the change's.
  const taskDir = taskWorktreePath(root, t.change.id, t.task.id, t.repo.id);
  const dir = existsSync(taskDir) ? taskDir : await changeWorktree(root, t.change.id, t.repo.id);
  const engine = buildEngineFor(t.ctx.orgPack, t.repo.id);
  const wanted =
    engine === "speckit"
      ? ["plan.md", "tasks.md", "spec.md"].map((f) => `specs/${t.task.id}/${f}`)
      : [`.atticus/tasks/${t.task.id}.md`];
  const git = o.git ?? createGit();
  const sha = await git(["rev-parse", "HEAD"], dir).then(
    (r) => r.stdout.trim(),
    () => undefined,
  );
  const folder = changeFolder(root, t.change.id);
  const evidence: string[] = [];
  const docs: Doc[] = [];
  for (const rel of wanted) {
    const text = await readFile(join(dir, rel), "utf8").catch(() => undefined);
    if (text === undefined) continue;
    const to = `tasks/${t.task.id}/evidence/${rel.split("/").pop()}`;
    await writeFileAtomic(join(folder, to), text);
    evidence.push(to);
    docs.push(parseDoc(to, text));
  }
  if (engine === "speckit" && !evidence.some((e) => e.endsWith("/plan.md")))
    throw new SpecKitError(
      "refused",
      `specs/${t.task.id}/plan.md isn't in ${t.repo.id}; hand the task down first: atticus spec hand-down ${t.change.id} ${t.task.id}`,
    );
  await writeFileAtomic(
    join(folder, `tasks/${t.task.id}/evidence/source.yaml`),
    toCanonicalYaml(
      {
        schemaVersion: 1,
        change: t.change.id,
        task: t.task.id,
        repo: t.repo.id,
        branch: pr.head,
        ...(sha ? { commit: sha } : {}),
        pr: { number: pr.number, url: pr.url },
        files: wanted.filter((w) => evidence.some((e) => e.endsWith(`/${w.split("/").pop()}`))),
        by: o.by,
        at: now,
      },
      ["schemaVersion", "change", "task", "repo", "branch", "commit"],
    ),
  );

  const markedDone = await markTaskDone(root, t.change.id, t.task);

  // The critic's code-and-test lens on the evidence.
  const lens: LensOutcome = { state: "skipped", rules: [], discarded: [] };
  let review: RoundWrite | undefined;
  const type = changeTypeOf(t.ctx, t.change.type);
  const gate = {
    id: HAND_UP_GATE,
    phase: "build" as const,
    approvers: ["developer"],
    minApprovals: 1,
    checklists: [],
    checks: [],
    maxAuthorRounds: 2,
  };
  const criticCtx = buildContext({
    root,
    change: t.change,
    type,
    lifecycle: t.ctx,
    footprint: await changeFootprint(t.ctx, t.change),
    files: t.files,
    gate,
    now,
  });
  const { rules: all } = await rulesForRepo(root, t.repo.owner);
  const rules: EffectiveRule[] = all.filter(
    (r) => r.lens === "code-and-test" && r.check.type === "ai",
  );
  lens.rules = rules.map((r) => r.id);
  const agent = lensAgent(criticCtx, "code-and-test");
  lens.agent = agent.id;
  if (rules.length === 0) lens.reason = "no AI rule of the code-and-test lens applies";
  else if (!o.runtime) lens.reason = "no AI runtime was given; review plan.md and tasks.md by hand";
  else if (!(agent.inputs as string[]).some((i) => i === "tasks" || i === "repo-code"))
    lens.reason = `agent ${agent.id} reads neither tasks nor repo code`;
  else {
    const levels = criticCtx.classifications;
    const sources: SourceInput[] = [
      {
        id: "0-instructions",
        kind: "instruction",
        origin: "atticus/speckit",
        text: INSTRUCTIONS(t.change.id, t.task.id, t.repo.id),
        classification: "public",
        trusted: true,
      },
      {
        id: "1-rules",
        kind: "checklist",
        origin: "checklists",
        text: `## Rules\n\n${toCanonicalYaml(
          rules.map((r) => ({
            id: r.id,
            title: r.title,
            severity: r.severity,
            look_for: r.check.type === "ai" ? r.check.prompt : "",
          })),
          ["id", "title", "severity", "look_for"],
        ).trimEnd()}`,
        classification: "public",
        trusted: true,
      },
      ...docs.map((d) => ({
        id: d.path,
        kind: "artifact" as const,
        origin: `${t.repo.id}:${wanted.find((w) => w.endsWith(`/${d.path.split("/").pop()}`)) ?? d.path}`,
        text: numbered(d),
        classification: "internal",
        priority: 10,
      })),
    ];
    try {
      const pack = buildContextPack({
        change: t.change.id,
        agent: agent.id,
        budget: t.ctx.orgPack.runtime.budgets.perAgent[agent.id] ?? agent.tokenBudget,
        sources,
        levels,
        maxClassification:
          o.maxClassification ??
          (levels.includes("confidential") ? "confidential" : levels.at(-1)!),
        now: new Date(now),
      });
      const prepared = await o.runtime.prepare({
        change: t.change.id,
        agent,
        pack,
        outputPath: `tasks/${t.task.id}/review-code-and-test.yaml`,
      });
      const run = await o.runtime.run(prepared.runId);
      lens.runId = run.runId;
      lens.summary = toRunSummary(run);
      await writeFileAtomic(
        join(folder, `tasks/${t.task.id}/runs/${run.runId}.yaml`),
        toCanonicalYaml(lens.summary, ["schemaVersion", "runId"]),
      );
      if (run.state === "waiting") {
        lens.state = "waiting";
        lens.reason = `handed to your assistant; finish with atticus handoff done ${run.runId}`;
      } else if (run.state !== "validated" || run.output === undefined) {
        lens.state = "failed";
        lens.reason = run.errors.join("; ") || `the run ended ${run.state}`;
      } else {
        const left = new Set(pack.manifest.dropped.map((d) => d.id));
        const parsed = parseLensOutput(
          criticCtx,
          "code-and-test",
          run.output,
          rules,
          docs.filter((d) => !left.has(d.path)),
        );
        lens.state = "ran";
        lens.discarded = parsed.discarded;
        const taken = new Set<string>();
        const prefix = `t${t.task.id.replace(/[^a-z0-9]+/g, "-")}-`;
        const fresh: Finding[] = parsed.hits.map((h) =>
          toFinding(h, {
            id: `${prefix}${findingIdFor(h, taken)}`.slice(0, 120),
            change: t.change.id,
            gate: HAND_UP_GATE,
            round: 1,
            now,
          }),
        );
        review = await writeFullRound(root, t.change.id, HAND_UP_GATE, fresh, {
          now,
          carry: (f) => !f.artifact.startsWith(`tasks/${t.task.id}/`),
          meta: {
            task: t.task.id,
            repo: t.repo.id,
            pr: pr.number,
            ...(lens.runId ? { runId: lens.runId } : {}),
          },
        });
      }
    } catch (e) {
      lens.state = "failed";
      lens.reason = (e as Error).message;
    }
  }

  const drift = await driftCheck(root, t.change.id, { now });
  return {
    change: t.change.id,
    task: t.task.id,
    repo: t.repo.id,
    pr,
    markedDone,
    evidence,
    lens,
    ...(review ? { review } : {}),
    drift,
  };
}
