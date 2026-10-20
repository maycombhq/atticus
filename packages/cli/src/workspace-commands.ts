import { readFile } from "node:fs/promises";
import {
  createOpenSpec,
  ORG_FLOW,
  setDefaultSchema,
  writeOrgFlowSchema,
} from "@maycombhq/openspec-adapter";
import {
  createWorkspace,
  GitError,
  loadRepos,
  vscodeWorkspacePath,
  intellijProjectPath,
  type LoadedRepo,
} from "@maycombhq/workspace";
import { HandoffRuntime } from "@maycombhq/ai";
import { NAMING_CHANGE, NAMING_OUTPUT } from "@maycombhq/features";
import { GLOSSARY_CHANGE, GLOSSARY_OUTPUT } from "@maycombhq/glossary";
import { lensRunOf } from "@maycombhq/naysayer";
import {
  STORY_PROSE_OUTPUT,
  DRAFT_OUTPUT,
  parseDraft,
  TEMPLATE_PROSE_CHANGE,
  TEMPLATE_PROSE_OUTPUT,
} from "@maycombhq/planner";
import { completeHandUpLens, handUpLensTask } from "@maycombhq/speckit";
import type { Output } from "./commands.js";
import { completeCriticLens } from "./critic-commands.js";
import { completeFeatureNaming } from "./feature-commands.js";
import { yamlAnswerProblems } from "./handoff-yaml.js";
import { completeTemplatesDraft } from "./plan-commands.js";
import { completeGlossaryScan } from "./quality-commands.js";

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
  let c;
  try {
    c = await createWorkspace(root).openChange(change, repos);
  } catch (e) {
    if (!(e instanceof GitError)) throw e;
    // Git's own words, with what to do: most often a base clone with no origin/main yet.
    io.err(`Git couldn't open the worktrees: ${(e.stderr || e.message).trim().split("\n")[0]}`);
    io.err(
      /origin\//.test(e.message + e.stderr)
        ? "A base clone has no origin branch to start from: run atticus workspace sync, then try again."
        : "Run atticus doctor, and atticus workspace sync, then try again.",
    );
    return 1;
  }
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
 * a hand-up's code-and-test lens, a critic AI lens, `feature suggest-names`, `glossary scan`,
 * `templates draft`, or the story writer of `plan stories` (finished by `--resume`).
 */
export function completionOf(request: {
  change: string;
  outputPath: string;
  outputIn?: string;
}):
  | "artifact"
  | "hand-up"
  | "critic-lens"
  | "feature-names"
  | "glossary"
  | "templates"
  | "story-prose"
  | "change-draft" {
  if (handUpLensTask(request.outputPath)) return "hand-up";
  if (lensRunOf(request)) return "critic-lens";
  if (request.change === GLOSSARY_CHANGE && request.outputPath === GLOSSARY_OUTPUT)
    return "glossary";
  if (request.outputIn === "run" && request.outputPath === STORY_PROSE_OUTPUT) return "story-prose";
  if (request.outputIn === "run" && request.outputPath === DRAFT_OUTPUT) return "change-draft";
  if (request.change === NAMING_CHANGE && request.outputPath === NAMING_OUTPUT)
    return "feature-names";
  if (request.change === TEMPLATE_PROSE_CHANGE && request.outputPath === TEMPLATE_PROSE_OUTPUT)
    return "templates";
  return "artifact";
}

/**
 * atticus handoff done <runId>: the assistant (or person) says the artifact is written.
 * Atticus checks it (openspec validate on the change for change artifacts) and records the
 * result; for a run that finishes another command (hand-up's lens, a critic lens, feature
 * suggest-names, glossary scan, templates draft) it then parses the answer and applies it as
 * that command would have. The story writer's answer is only checked; `plan stories --resume`
 * writes the plan from it.
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
      // Answers that aren't change artifacts (a lens review, name proposals, definitions,
      // template or story prose) are checked as YAML here and read in full by the command
      // they finish.
      // A change draft is checked in full by `change draft --resume`; here, that it is one.
      if (completionOf(request) === "change-draft") {
        const files = parseDraft(await readFile(_file, "utf8").catch(() => ""));
        return files.has("proposal.md")
          ? []
          : ['The draft has no "=== proposal.md" file; start each file with a line "=== <path>".'];
      }
      if (completionOf(request) !== "artifact") return yamlAnswerProblems(_file, request);
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
    if (kind === "critic-lens")
      return completeCriticLens(root, run, io, {
        ...(now ? { now: now.toISOString().replace(/\.\d{3}Z$/, "Z") } : {}),
      });
    if (kind === "glossary") return completeGlossaryScan(root, run, io, now ? { now } : {});
    if (kind === "story-prose") {
      io.out(
        `The story prose for ${run.request.change} is valid. Next: atticus plan stories ${run.request.change} --resume ${runId}`,
      );
      return 0;
    }
    if (kind === "change-draft") {
      io.out(
        `The draft for ${run.request.change} is in. Next: atticus change draft ${run.request.change} --resume ${runId}`,
      );
      return 0;
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
