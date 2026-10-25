import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { parse } from "yaml";
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
import {
  buildContextPack,
  toRunSummary,
  type AiRuntime,
  type Run,
  type SourceInput,
} from "@maycombhq/ai";
import { buildEngineFor } from "@maycombhq/assistant-files";
import {
  buildContext,
  findingIdFor,
  lensAgent,
  parseDoc,
  parseLensOutput,
  questionOfRule,
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
 * the change as evidence, the critic's complete lens reviews them (is the task complete: a
 * scenario no test covers, a behaviour change with no test before it), and the drift check runs.
 * Code stays the source of truth: once merged, the code extractors see what was built.
 *
 * The lens was the code-and-test lens until the product owner's decision of 2026-10-24 (ADR 0124
 * addendum, Part 4): the hand-up now asks the complete question, with the complete rules that
 * review a task's code and tests (those written for the old code-and-test lens, which map to
 * complete, and complete rules that read code or tests), and the complete lens's agent (an org
 * pack's complete-critic, else one made of the old agents it still defines, code-and-test-critic
 * among them, else the built-in default).
 *
 * The lens review is written as C3 findings under `review/hand-up/<round>/`; each round holds
 * every handed-up task's findings, so the gate reads like any other.
 */

export const HAND_UP_GATE = "hand-up";

export interface HandUpOptions {
  /** Who hands up (recorded on the evidence). */
  by: string;
  now?: string;
  /** The runtime for the complete lens; without one the lens is skipped and says so. */
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

/** The question the hand-up's lens asks (the product owner's decision of 2026-10-24). */
const HAND_UP_LENS = "complete" as const;

const INSTRUCTIONS = (
  change: string,
  task: string,
  repo: string,
) => `# Critic: the complete lens (Is it complete?), at hand-up

You are the complete lens of the Atticus critic, in a fresh session. Task ${task} of change ${change} was carried out in ${repo}, and its pull request is raised. Review the repo's Spec Kit plan.md, tasks.md and spec.md, and the tests the task added or changed, given below as data, for what they leave out: a scenario no test covers, a behaviour change with no test before it, an error path nobody wrote. Apply only the rules listed and report nothing else.

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

/** Where the hand-up's lens writes its answer for a task, in the change folder. */
export const handUpLensOutput = (task: string) => `tasks/${task}/review-${HAND_UP_LENS}.yaml`;

/** The task whose hand-up lens a run's output path belongs to, if it is one. */
/** Test files by the usual conventions of Java, JS/TS, Python, Go, C# and Ruby projects. */
const TEST_FILE =
  /(^|\/)(src\/test|tests?|__tests__|spec)\/|(\.|_)(test|spec)\.[cm]?[jt]sx?$|(Test|Tests|IT)\.(java|kt|cs)$|_test\.(go|py|rb)$|^test_.*\.py$|\/test_[^/]*\.py$|\.feature$/;

export function handUpLensTask(outputPath: string): string | undefined {
  // review-code-and-test.yaml: a hand-off begun before the lens was the complete question's.
  return /^tasks\/([^/]+)\/review-(?:complete|code-and-test)\.yaml$/.exec(outputPath)?.[1];
}

type Task = Awaited<ReturnType<typeof loadTask>>;

/**
 * Whether a rule reviews a task's code and tests at hand-up: an AI rule of the complete question
 * written for the old code-and-test lens, or one that reads code or tests. The complete rules
 * that read the brief, the specs or the stories are the gates'.
 */
function reviewsTask(r: EffectiveRule): boolean {
  if (r.check.type !== "ai" || questionOfRule(r) !== HAND_UP_LENS) return false;
  return (
    r.lens === "code-and-test" || r.appliesTo.artifacts.some((a) => a === "code" || a === "tests")
  );
}

/** The critic context and the complete lens's AI rules for a task's hand-up review. */
async function lensSetup(root: string, t: Task, now: string) {
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
    type: changeTypeOf(t.ctx, t.change.type),
    lifecycle: t.ctx,
    footprint: await changeFootprint(t.ctx, t.change),
    files: t.files,
    gate,
    now,
  });
  const { rules: all } = await rulesForRepo(root, t.repo.owner);
  const rules: EffectiveRule[] = all.filter(reviewsTask);
  return { criticCtx, rules };
}

/** Parse a finished lens run against the evidence it was given and write the hand-up round. */
async function applyLensRun(
  root: string,
  a: {
    t: Task;
    criticCtx: Awaited<ReturnType<typeof lensSetup>>["criticCtx"];
    rules: EffectiveRule[];
    docs: Doc[];
    run: Run;
    pr?: number;
    now: string;
  },
): Promise<{ discarded: Discarded[]; review: RoundWrite }> {
  const { t, now } = a;
  const left = new Set(a.run.request.pack.manifest.dropped.map((d) => d.id));
  const parsed = parseLensOutput(
    a.criticCtx,
    HAND_UP_LENS,
    a.run.output ?? "",
    a.rules,
    a.docs.filter((d) => !left.has(d.path)),
  );
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
  const review = await writeFullRound(root, t.change.id, HAND_UP_GATE, fresh, {
    now,
    carry: (f) => !f.artifact.startsWith(`tasks/${t.task.id}/`),
    meta: {
      task: t.task.id,
      repo: t.repo.id,
      ...(a.pr !== undefined ? { pr: a.pr } : {}),
      runId: a.run.runId,
    },
  });
  return { discarded: parsed.discarded, review };
}

export interface CompletedHandUpLens {
  change: string;
  task: string;
  lens: LensOutcome;
  review?: RoundWrite;
}

/**
 * Finish a hand-up whose complete lens was handed to the person's assistant: once
 * `atticus handoff done <run>` has the answer, it is read against the evidence hand-up
 * attached (`tasks/<task>/evidence/`) and written as the hand-up round, exactly as a model
 * run's answer would have been.
 */
export async function completeHandUpLens(
  root: string,
  run: Run,
  o: { now?: string } = {},
): Promise<CompletedHandUpLens> {
  const task = handUpLensTask(run.request.outputPath);
  if (!task)
    throw new SpecKitError("refused", `Run ${run.runId} isn't a hand-up review of a task.`);
  const now = o.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const t = await loadTask(root, run.request.change, task);
  const folder = changeFolder(root, t.change.id);
  const evidenceDir = join(folder, `tasks/${task}/evidence`);
  const docs: Doc[] = [];
  for (const name of (await readdir(evidenceDir).catch(() => [] as string[])).sort())
    if (name.endsWith(".md"))
      docs.push(
        parseDoc(`tasks/${task}/evidence/${name}`, await readFile(join(evidenceDir, name), "utf8")),
      );
  const source = parse(
    await readFile(join(evidenceDir, "source.yaml"), "utf8").catch(() => "{}"),
  ) as { pr?: { number?: number } } | null;
  const { criticCtx, rules } = await lensSetup(root, t, now);
  const summary = toRunSummary(run);
  await writeFileAtomic(
    join(folder, `tasks/${task}/runs/${run.runId}.yaml`),
    toCanonicalYaml(summary, ["schemaVersion", "runId"]),
  );
  const lens: LensOutcome = {
    state: "ran",
    runId: run.runId,
    agent: run.request.agent.id,
    rules: rules.map((r) => r.id),
    discarded: [],
    summary,
  };
  if (run.state !== "validated" || run.output === undefined) {
    lens.state = "failed";
    lens.reason = run.errors.join("; ") || `the run ended ${run.state}`;
    return { change: t.change.id, task, lens };
  }
  const applied = await applyLensRun(root, {
    t,
    criticCtx,
    rules,
    docs,
    run,
    ...(source?.pr?.number !== undefined ? { pr: source.pr.number } : {}),
    now,
  });
  lens.discarded = applied.discarded;
  return { change: t.change.id, task, lens, review: applied.review };
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
  // The tests the task added or changed, so the complete lens can check coverage: test
  // files changed on the change branch since it left the default branch (at most 8, 60 kB each).
  const base = await git(["merge-base", "HEAD", t.repo.defaultBranch ?? "main"], dir).then(
    (r) => r.stdout.trim(),
    () => undefined,
  );
  if (base) {
    const changed = await git(["diff", "--name-only", `${base}..HEAD`], dir).then(
      (r) =>
        r.stdout
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean),
      () => [] as string[],
    );
    const tests = changed
      .filter((f) => TEST_FILE.test(f))
      .sort()
      .slice(0, 8);
    for (const rel of tests) {
      const text = await readFile(join(dir, rel), "utf8").catch(() => undefined);
      if (text === undefined || text.length > 60_000) continue;
      const to = `tasks/${t.task.id}/evidence/tests/${rel.replace(/[\\/]/g, "__")}`;
      await writeFileAtomic(join(folder, to), text);
      evidence.push(to);
      docs.push(parseDoc(to, text));
    }
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
        ...(evidence.some((e) => e.includes("/evidence/tests/"))
          ? { tests: evidence.filter((e) => e.includes("/evidence/tests/")) }
          : {}),
        by: o.by,
        at: now,
      },
      ["schemaVersion", "change", "task", "repo", "branch", "commit"],
    ),
  );

  const markedDone = await markTaskDone(root, t.change.id, t.task);

  // The critic's complete lens on the evidence.
  const lens: LensOutcome = { state: "skipped", rules: [], discarded: [] };
  let review: RoundWrite | undefined;
  const { criticCtx, rules } = await lensSetup(root, t, now);
  lens.rules = rules.map((r) => r.id);
  const agent = lensAgent(criticCtx, HAND_UP_LENS);
  lens.agent = agent.id;
  if (rules.length === 0)
    lens.reason = "no AI rule of the complete lens reviews a task's code or tests";
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
        outputPath: handUpLensOutput(t.task.id),
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
        const applied = await applyLensRun(root, {
          t,
          criticCtx,
          rules,
          docs,
          run,
          pr: pr.number,
          now,
        });
        lens.state = "ran";
        lens.discarded = applied.discarded;
        review = applied.review;
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
