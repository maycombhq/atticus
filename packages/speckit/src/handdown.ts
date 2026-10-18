import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { taskBranch, type BuildEngine } from "@maycombhq/core";
import {
  buildEngineFor,
  generateAssistantFiles,
  writeAssistantFiles,
  type WriteReport,
} from "@maycombhq/assistant-files";
import { createGit, toRepoRelative, type GitRunner } from "@maycombhq/workspace";
import { changeWorktree, loadTask, type TaskContext } from "./change.js";
import {
  constitutionPlan,
  renderConstitution,
  renderConstitutionSection,
  rulesForRepo,
} from "./constitution.js";
import {
  contractFile,
  renderAsyncApi,
  renderAtticusTask,
  renderChecklist,
  renderDataModel,
  renderOpenApi,
  renderPlan,
  renderSpec,
} from "./render.js";

/**
 * Hand-down (ADR 0030 point 2). When a task starts, Atticus creates the task's work in the
 * target repo's change worktree, on branch change/<id>:
 *
 * - Spec Kit engine: `specs/<task-id>/` with spec.md, a seeded plan.md, data-model.md and
 *   contracts/ (OpenAPI for what the repo serves, AsyncAPI for topics it uses) where the
 *   change has them, checklists/requirements.md; `.specify/feature.json` pointing at it;
 *   `.specify/memory/constitution.md` from the org pack; and Spec Kit's templates, scripts and
 *   `/speckit.*` commands through the skill source (assistant files).
 * - Atticus engine: `.atticus/tasks/<task-id>.md`.
 *
 * Files a developer already changed are never overwritten (`force` overrides), so a second
 * hand-down is safe. The result is committed on the change branch locally; nothing is pushed.
 */

export interface HandDownOptions {
  force?: boolean;
  /** Commit on the change branch (default true). */
  commit?: boolean;
  git?: GitRunner;
}

export interface HandDownResult {
  change: string;
  task: string;
  repo: string;
  engine: BuildEngine;
  /** The change worktree, relative to the metarepo. */
  worktree: string;
  /** specs/<task-id> or .atticus/tasks */
  feature: string;
  written: string[];
  unchanged: string[];
  /** Files a developer changed since the last hand-down: kept. */
  kept: string[];
  assistantFiles: WriteReport;
  commit?: string;
  problems: string[];
}

async function putIfFree(
  dir: string,
  rel: string,
  text: string,
  force: boolean,
  r: Pick<HandDownResult, "written" | "unchanged" | "kept">,
): Promise<void> {
  const full = join(dir, rel);
  const current = await readFile(full, "utf8").catch(() => undefined);
  if (current === text) {
    r.unchanged.push(rel);
    return;
  }
  if (current !== undefined && !force) {
    r.kept.push(rel);
    return;
  }
  await mkdir(dirname(full), { recursive: true });
  await writeFile(`${full}.atticus-tmp`, text, "utf8");
  await rename(`${full}.atticus-tmp`, full);
  r.written.push(rel);
}

/** The files hand-down writes for a task, as repo-relative path → text (pure). */
export function handDownFiles(t: TaskContext, engine: BuildEngine): Map<string, string> {
  const files = new Map<string, string>();
  if (engine === "atticus") {
    files.set(`.atticus/tasks/${t.task.id}.md`, renderAtticusTask(t));
    return files;
  }
  const dir = `specs/${t.task.id}`;
  files.set(`${dir}/spec.md`, renderSpec(t));
  files.set(`${dir}/plan.md`, renderPlan(t));
  const dm = renderDataModel(t);
  if (dm) files.set(`${dir}/data-model.md`, dm);
  const oa = renderOpenApi(t);
  if (oa) files.set(`${dir}/${contractFile(t)}`, oa);
  const aa = renderAsyncApi(t);
  if (aa) files.set(`${dir}/contracts/${t.component}-events.yaml`, aa);
  files.set(`${dir}/checklists/requirements.md`, renderChecklist(t));
  return files;
}

export function featureJson(t: TaskContext): string {
  return (
    JSON.stringify(
      {
        feature_directory: `specs/${t.task.id}`,
        change: t.change.id,
        task: t.task.id,
        branch: taskBranch(t.change.id, t.task.id),
      },
      null,
      2,
    ) + "\n"
  );
}

export async function handDown(
  root: string,
  changeId: string,
  taskId: string,
  o: HandDownOptions = {},
): Promise<HandDownResult> {
  const t = await loadTask(root, changeId, taskId);
  const dir = await changeWorktree(root, t.change.id, t.repo.id);
  const engine = buildEngineFor(t.ctx.orgPack, t.repo.id);
  const r: HandDownResult = {
    change: t.change.id,
    task: t.task.id,
    repo: t.repo.id,
    engine,
    worktree: toRepoRelative(root, dir),
    feature: engine === "speckit" ? `specs/${t.task.id}` : ".atticus/tasks",
    written: [],
    unchanged: [],
    kept: [],
    assistantFiles: { results: [], upToDate: true },
    problems: [],
  };
  for (const [rel, text] of handDownFiles(t, engine)) await putIfFree(dir, rel, text, !!o.force, r);

  if (engine === "speckit") {
    // The current feature is Atticus's to set: always point it at the task handed down last.
    await putIfFree(dir, ".specify/feature.json", featureJson(t), true, r);
    const rules = await rulesForRepo(root, t.repo.owner);
    r.problems.push(...rules.problems);
    const input = {
      repo: t.repo.id,
      rules: rules.rules,
      orgPack: t.ctx.orgPack,
      constitutionVersion: rules.constitutionVersion,
      team: t.repo.owner,
    };
    const path = ".specify/memory/constitution.md";
    // A constitution the team wrote itself is never replaced, even with force: Atticus's
    // rules go into a marked section of it, or nowhere when the section can't be placed.
    const plan = constitutionPlan(await readFile(join(dir, path), "utf8").catch(() => undefined));
    if (plan.mode === "refuse") {
      r.kept.push(path);
      r.problems.push(plan.reason);
    } else {
      const c = await writeAssistantFiles(
        dir,
        [
          {
            path,
            content:
              plan.mode === "file" ? renderConstitution(input) : renderConstitutionSection(input),
            source: "org-pack checklists and the Atticus constitution",
            mode: plan.mode,
            style: "html",
          },
        ],
        { ...(o.force ? { force: true } : {}) },
      );
      for (const x of c.results)
        (x.action === "created" || x.action === "updated"
          ? r.written
          : x.action === "unchanged"
            ? r.unchanged
            : r.kept
        ).push(x.path);
    }
  }

  const af = await generateAssistantFiles(root, {
    repo: t.repo.id,
    dir,
    ...(o.force ? { force: true } : {}),
  });
  r.assistantFiles = { results: af.results, upToDate: af.upToDate };
  r.problems.push(...af.problems);

  if (o.commit !== false && (r.written.length || af.results.some((x) => x.written))) {
    const git = o.git ?? createGit();
    await git(["add", "-A", "--", "."], dir);
    const staged = (await git(["diff", "--cached", "--name-only"], dir)).stdout.trim();
    if (staged) {
      await git(
        [
          "commit",
          "-q",
          "-m",
          `Hand down task ${t.task.id} of ${t.change.id}: ${t.task.title}`,
          "-m",
          `Atticus-Change: ${t.change.id}\nAtticus-Task: ${t.task.id}`,
        ],
        dir,
      );
      r.commit = (await git(["rev-parse", "HEAD"], dir)).stdout.trim();
    }
  }
  return r;
}
