import {
  createOpenSpec,
  ORG_FLOW,
  setDefaultSchema,
  writeOrgFlowSchema,
} from "@maycombhq/openspec-adapter";
import {
  createWorkspace,
  loadRepos,
  vscodeWorkspacePath,
  intellijProjectPath,
  type LoadedRepo,
} from "@maycombhq/workspace";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { HandoffRuntime } from "@maycombhq/ai";
import { NAMING_CHANGE, NAMING_OUTPUT } from "@maycombhq/features";
import { TEMPLATE_PROSE_CHANGE, TEMPLATE_PROSE_OUTPUT } from "@maycombhq/planner";
import { completeHandUpLens, handUpLensTask } from "@maycombhq/speckit";
import type { Output } from "./commands.js";
import { completeFeatureNaming } from "./feature-commands.js";
import { completeTemplatesDraft } from "./plan-commands.js";

function pick(
  all: LoadedRepo[],
  wanted: string[] | undefined,
  io: Output,
): LoadedRepo[] | undefined {
  if (!wanted || wanted.length === 0) return all;
  const byId = new Map(all.map((r) => [r.id, r]));
  const unknown = wanted.filter((w) => !byId.has(w));
  if (unknown.length > 0) {
    io.err(`Not in any repos.manifest.yaml: ${unknown.join(", ")}`);
    return undefined;
  }
  return wanted.map((w) => byId.get(w)!);
}

/** atticus workspace sync: clone or update base clones. Exit 1 if any repo failed. */
export async function workspaceSync(
  root: string,
  repoIds: string[] | undefined,
  io: Output,
): Promise<number> {
  const all = await loadRepos(root);
  if (all.length === 0) {
    io.err("No repos found. Add org-pack/profiles/<platform>/repos.manifest.yaml first.");
    return 1;
  }
  const repos = pick(all, repoIds, io);
  if (!repos) return 2;
  const results = await createWorkspace(root).sync(repos);
  for (const r of results) {
    const sha = r.sha ? ` ${r.sha.slice(0, 12)}` : "";
    const line = `${r.id}: ${r.action}${sha}${r.reason ? ` (${r.reason})` : ""}`;
    if (r.action === "failed") io.err(line);
    else io.out(line);
  }
  return results.some((r) => r.action === "failed") ? 1 : 0;
}

/** atticus workspace open <change> --repos a,b: worktrees, repos.yaml and editor workspaces. */
export async function workspaceOpen(
  root: string,
  change: string,
  repoIds: string[] | undefined,
  io: Output,
): Promise<number> {
  if (!repoIds || repoIds.length === 0) {
    io.err("Say which repos the change touches: --repos <id>,<id>");
    return 2;
  }
  const repos = pick(await loadRepos(root), repoIds, io);
  if (!repos) return 2;
  const c = await createWorkspace(root).openChange(change, repos);
  for (const r of c.repos) io.out(`${r.id}: ${r.branch} at ${r.worktree}`);
  io.out(`VS Code: ${vscodeWorkspacePath(root, change)}`);
  io.out(`IntelliJ: open the folder ${intellijProjectPath(root, change)}`);
  return 0;
}

/** atticus workspace prune <change>: remove finished worktrees. */
export async function workspacePrune(
  root: string,
  change: string,
  opts: { all?: boolean; force?: boolean },
  io: Output,
): Promise<number> {
  const r = await createWorkspace(root).prune(change, opts);
  for (const id of r.removed) io.out(`${id}: removed`);
  for (const k of r.kept) io.out(`${k.id}: kept (${k.reason})`);
  return 0;
}

/** atticus openspec setup: OpenSpec folders, the org-flow schema, and org-flow as the default. */
export async function openspecSetup(root: string, io: Output): Promise<number> {
  const os = createOpenSpec({ root });
  const v = await os.assertSupported();
  await os.init();
  await writeOrgFlowSchema(root);
  await setDefaultSchema(root, ORG_FLOW);
  io.out(`OpenSpec ${v} set up with the ${ORG_FLOW} schema in ${root}`);
  return 0;
}

/** atticus openspec check: version support and validation of every change and spec. */
export async function openspecCheck(root: string, io: Output): Promise<number> {
  const os = createOpenSpec({ root });
  const v = await os.assertSupported();
  const report = await os.validate();
  for (const item of report.items) {
    for (const issue of item.issues.filter((i) => i.level !== "INFO")) {
      io.err(`${item.type} ${item.id}: ${issue.level}: ${issue.message}`);
    }
  }
  const t = report.summary.totals;
  io.out(`OpenSpec ${v}: ${t.items} checked, ${t.passed} passed, ${t.failed} failed`);
  return t.failed > 0 ? 1 : 0;
}

/**
 * Which command a hand-off run finishes: a change artifact (checked with openspec validate),
 * a hand-up's code-and-test lens, `feature suggest-names` or `templates draft`.
 */
export function completionOf(request: {
  change: string;
  outputPath: string;
}): "artifact" | "hand-up" | "feature-names" | "templates" {
  if (handUpLensTask(request.outputPath)) return "hand-up";
  if (request.change === NAMING_CHANGE && request.outputPath === NAMING_OUTPUT)
    return "feature-names";
  if (request.change === TEMPLATE_PROSE_CHANGE && request.outputPath === TEMPLATE_PROSE_OUTPUT)
    return "templates";
  return "artifact";
}

/**
 * atticus handoff done <runId>: the assistant (or person) says the artifact is written.
 * Atticus checks it (openspec validate on the change for change artifacts) and records the
 * result; for a run that finishes another command (hand-up's lens, feature suggest-names,
 * templates draft) it then parses the answer and applies it as that command would have.
 */
export async function handoffDone(
  root: string,
  runId: string,
  io: Output,
  deps: { now?: () => Date } = {},
): Promise<number> {
  const os = createOpenSpec({ root });
  const rt = new HandoffRuntime({
    root,
    validate: async (_file, request) => {
      // Answers that aren't change artifacts (a lens review, name proposals, template prose)
      // are checked as YAML here and read in full by the command they finish.
      if (completionOf(request) !== "artifact") {
        try {
          parse(await readFile(_file, "utf8"));
          return [];
        } catch (e) {
          return [`${request.outputPath} isn't YAML: ${(e as Error).message.split("\n")[0]}`];
        }
      }
      const report = await os.validate({ item: request.change, type: "change" });
      return report.items.flatMap((i) =>
        i.issues.filter((x) => x.level === "ERROR").map((x) => x.message),
      );
    },
  });
  const run = await rt.done(runId);
  if (run.state === "validated") {
    const kind = completionOf(run.request);
    const now = deps.now?.();
    if (kind === "hand-up") {
      const r = await completeHandUpLens(root, run, {
        ...(now ? { now: now.toISOString().replace(/\.\d{3}Z$/, "Z") } : {}),
      });
      const n = r.review?.findings.filter((f) =>
        f.finding.artifact.startsWith(`tasks/${r.task}/`),
      ).length;
      io.out(
        r.lens.state === "ran"
          ? `The code-and-test lens on task ${r.task} of ${r.change} raised ${n ?? 0} finding${n === 1 ? "" : "s"} (review/hand-up/${r.review?.round ?? "-"}).`
          : `The code-and-test lens on task ${r.task} was ${r.lens.state}: ${r.lens.reason ?? ""}`,
      );
      for (const d of r.lens.discarded) io.err(`Discarded: ${d.reason}`);
      return r.lens.state === "ran" ? 0 : 1;
    }
    if (kind === "feature-names") return completeFeatureNaming(root, run, io, now ? { now } : {});
    if (kind === "templates") return completeTemplatesDraft(root, run, io, deps);
    io.out(`${run.request.outputPath} for ${run.request.change} is valid`);
    return 0;
  }
  for (const e of run.errors) io.err(e);
  io.err(
    `${run.request.outputPath} needs fixing; run atticus handoff done ${runId} again when it's fixed`,
  );
  return 1;
}
