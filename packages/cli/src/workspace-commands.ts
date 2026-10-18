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
import type { Output } from "./commands.js";

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
