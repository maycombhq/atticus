import { readFile } from "node:fs/promises";
import { SCAN_REVIEW_OUTPUT } from "@maycombhq/assistant-kit";
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
import { HandoffRuntime, type AiRequest } from "@maycombhq/ai";
import { runsDirOf } from "@maycombhq/core";
import { join } from "node:path";
import { NAMING_CHANGE, NAMING_OUTPUT } from "@maycombhq/features";
import { GLOSSARY_CHANGE, GLOSSARY_OUTPUT } from "@maycombhq/glossary";
import { lensAnswerProblem, lensRunOf } from "@maycombhq/naysayer";
import {
  checkScanAnswer,
  KNOWLEDGE_SCAN_OUTPUT,
  readSnapshot,
  type Snapshot,
} from "@maycombhq/knowledge";
import {
  STORY_PROSE_OUTPUT,
  checkStageDraft,
  formatDraftProblems,
  stageOfOutput,
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
import { storeSummaryLines } from "./openspec-stores-commands.js";
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
  o: { from?: string } = {},
): Promise<number> {
  const all = await loadRepos(root);
  if (all.length === 0) {
    io.err("No repos found. Add org-pack/profiles/<platform>/repos.manifest.yaml first.");
    return 1;
  }
  const repos = pick(all, repoIds, io);
  if (!repos) return 2;
  // --from <folder>: copy each missing base clone from your own clone there, with no network.
  const results = await createWorkspace(root).sync(repos, o.from ? { from: o.from } : {});
  for (const r of results) {
    const sha = r.sha ? ` ${r.sha.slice(0, 12)}` : "";
    const why = r.from ? `copied from your clone at ${r.from}` : r.reason;
    const line = `${r.id}: ${r.action}${sha}${why ? ` (${why})` : ""}`;
    if (r.action === "failed") io.err(line);
    else io.out(line);
    // ADR 0123: the manifest names one default branch; the remote may call another its default.
    const named = repos.find((x) => x.id === r.id)?.defaultBranch;
    if (r.remoteDefault && named && r.remoteDefault !== named)
      io.err(
        `${r.id}: the manifest says ${named}, the remote's default is ${r.remoteDefault}. The catalog is read from ${named}; if ${r.remoteDefault} is the one to read, set defaultBranch: ${r.remoteDefault} in the manifest (or on Set up › Repos).`,
      );
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
  // ADR 0126: the stores org-pack/openspec.yaml names, read-only; never validated or counted here.
  const stores = await storeSummaryLines(root);
  for (const l of stores.out) io.out(l);
  for (const l of stores.err) io.err(l);
  return t.failed > 0 ? 1 : 0;
}

/**
 * Which command a hand-off run finishes: a change artifact (checked with openspec validate),
 * a hand-up's complete lens, a critic AI lens, `feature suggest-names`, `glossary scan`,
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
  | "change-draft"
  | "scan-review"
  | "step-answer" {
  if (handUpLensTask(request.outputPath)) return "hand-up";
  if (lensRunOf(request)) return "critic-lens";
  if (request.change === GLOSSARY_CHANGE && request.outputPath === GLOSSARY_OUTPUT)
    return "glossary";
  if (request.outputIn === "run" && request.outputPath === STORY_PROSE_OUTPUT) return "story-prose";
  if (request.outputIn === "run" && request.outputPath === DRAFT_OUTPUT) return "change-draft";
  if (request.outputIn === "run" && request.outputPath === SCAN_REVIEW_OUTPUT) return "scan-review";
  if (request.change === NAMING_CHANGE && request.outputPath === NAMING_OUTPUT)
    return "feature-names";
  if (request.change === TEMPLATE_PROSE_CHANGE && request.outputPath === TEMPLATE_PROSE_OUTPUT)
    return "templates";
  // Any other answer in the run's own folder (scan survey, scan verify, spec draft, knowledge
  // scan and ask, onboard) is read back and checked in full by the step's --resume (ADR 0086).
  if (request.outputIn === "run") return "step-answer";
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
  /** model: the model that wrote the answer (`--model`, ADR 0121 addendum), kept in its record. */
  deps: { now?: () => Date; model?: string } = {},
): Promise<number> {
  const os = createOpenSpec({ root });
  // W3a: a stage's draft is checked here with the stage's own checks, the way a linter is run:
  // its problems are listed with their lines and the run stays open to fix, until it is clean or
  // the draft has had its self-checks (the change policy's draftSelfChecks); then it goes in as it is.
  const before = await readRunJson(root, runId);
  const checks = before ? (before.state === "failed" ? before.attempt + 1 : before.attempt) : 1;
  let handedAsIs: number | undefined;
  const selfChecked = async (file: string, request: AiRequest): Promise<string[]> => {
    const stage = stageOfOutput(request.outputPath);
    if (!request.selfCheck || !stage) return [];
    const problems = await checkStageDraft(
      root,
      request.change,
      stage,
      await readFile(file, "utf8").catch(() => ""),
    ).catch((e: Error) => [
      { rule: "stage.check", target: stage, message: e.message, blocking: true },
    ]);
    if (!problems.length) return [];
    if (checks >= request.selfCheck.limit) {
      handedAsIs = checks;
      return [];
    }
    return [formatDraftProblems(problems)];
  };
  // B2: the knowledge scan's answer is checked here as the scan checks it (each quote on its
  // page, the values tied to it, the superseded pages), against the pages it was given, and the
  // run stays open to fix; after the scan's attempts it goes in as it is, and the resume hands
  // what still fails back with the next prompt.
  const scanChecked = async (file: string, request: AiRequest): Promise<string[]> => {
    if (request.change !== "knowledge-scan" || request.outputPath !== KNOWLEDGE_SCAN_OUTPUT)
      return [];
    const problems = checkScanAnswer(
      await scanSnapshots(root, request),
      await readFile(file, "utf8").catch(() => ""),
    );
    if (!problems.length) return [];
    if (checks >= SCAN_CHECKS) {
      handedAsIs = checks;
      return [];
    }
    return [
      `The answer fails ${problems.length === 1 ? "a check" : `${problems.length} checks`} the knowledge scan makes; fix each in ${request.outputPath} (or drop the item):`,
      ...problems.map((p) => `- ${p}`),
    ];
  };
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
      if (completionOf(request) === "step-answer") {
        if (!/\.ya?ml$/.test(request.outputPath))
          return (await readFile(_file, "utf8").catch(() => "")).trim()
            ? []
            : [`${request.outputPath} is empty`];
        const yaml = await yamlAnswerProblems(_file, request);
        if (yaml.length) return yaml;
        const scan = await scanChecked(_file, request);
        return scan.length ? scan : selfChecked(_file, request);
      }
      // The hand-up lens's review must be one, as a critic lens's must (yamlAnswerProblems).
      if (completionOf(request) === "hand-up") {
        const why = lensAnswerProblem(await readFile(_file, "utf8").catch(() => ""));
        return why ? [`${request.outputPath}: ${why}`] : [];
      }
      if (completionOf(request) !== "artifact") return yamlAnswerProblems(_file, request);
      const report = await os.validate({ item: request.change, type: "change" });
      return report.items.flatMap((i) =>
        i.issues.filter((x) => x.level === "ERROR").map((x) => x.message),
      );
    },
  });
  const run = await rt.done(runId, deps.model ? { model: deps.model } : {});
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
          ? `The complete lens on task ${r.task} of ${r.change} raised ${n ?? 0} finding${n === 1 ? "" : "s"} (review/hand-up/${r.review?.round ?? "-"}).`
          : `The complete lens on task ${r.task} was ${r.lens.state}: ${r.lens.reason ?? ""}`,
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
    if (kind === "scan-review") {
      const repo = run.request.change.replace(/^review-/, "");
      io.out(`The review of ${repo} is in. Next: atticus scan review ${repo} --resume ${runId}`);
      return 0;
    }
    if (kind === "change-draft") {
      io.out(
        `The draft for ${run.request.change} is in. Next: atticus change draft ${run.request.change} --resume ${runId}`,
      );
      return 0;
    }
    if (kind === "step-answer") {
      if (handedAsIs)
        io.out(
          run.request.change === "knowledge-scan"
            ? `${run.request.outputPath} still has problems, and is handed in as it is after ${handedAsIs} checks: the knowledge scan keeps what passes and hands the rest back with its next prompt.`
            : `${run.request.outputPath} still has problems, and is handed in as it is after ${handedAsIs} checks: the stage hands its problems back with the next draft.`,
        );
      io.out(
        `The answer for ${run.request.change} is in. Run the step again with --resume ${runId}: it checks the answer and writes the result.`,
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

/** A knowledge scan's answer is checked by handoff done this many times, as the scan's attempts. */
const SCAN_CHECKS = 3;

/** The snapshots' pages a knowledge scan's run was given (its pack's page sources), newest. */
async function scanSnapshots(root: string, request: AiRequest): Promise<Snapshot[]> {
  const sent = new Set(
    request.pack.manifest.sources.filter((s) => s.id.startsWith("page-")).map((s) => s.origin),
  );
  const out: Snapshot[] = [];
  for (const source of [...new Set([...sent].map((o) => o.split("/")[0]!))].sort()) {
    const s = await readSnapshot(root, source).catch(() => undefined);
    if (!s) continue;
    out.push({ ...s, pages: s.pages.filter((p) => sent.has(`${p.source}/${p.pagePath}`)) });
  }
  return out;
}

/** A run's state and attempt, read off its run.json in whichever change folder holds it. */
async function readRunJson(
  root: string,
  runId: string,
): Promise<{ state: string; attempt: number } | undefined> {
  const { readdir } = await import("node:fs/promises");
  const dir = runsDirOf(root);
  for (const change of await readdir(dir).catch(() => [] as string[])) {
    const text = await readFile(join(dir, change, runId, "run.json"), "utf8").catch(
      () => undefined,
    );
    if (text === undefined) continue;
    try {
      const r = JSON.parse(text) as { state?: unknown; attempt?: unknown };
      return {
        state: typeof r.state === "string" ? r.state : "",
        attempt: typeof r.attempt === "number" ? r.attempt : 1,
      };
    } catch {
      return undefined;
    }
  }
  return undefined;
}
