import { join } from "node:path";
import { loadOrgPack } from "@maycombhq/core";
import {
  loadOrgCommands,
  renderAssistantFiles,
  writeAssistantFiles,
  type RenderedFile,
  type WriteReport,
} from "@maycombhq/assistant-files";
import { exists, isDir } from "./files.js";
import { resolveMetarepo, type MetarepoPaths } from "./layout.js";

/**
 * Zero-install use: the `/atticus-*` commands (and the org's own commands, skills and agents)
 * are plain files committed in the repo (`.claude/commands/`, `.github/prompts/` and friends),
 * so anyone who clones it can run them in Claude Code or Copilot without installing Atticus.
 *
 * What zero-install can do: answer questions and walk impact from the committed catalog,
 * review a change the way the critic does, draft tasks and service-desk requests, check
 * release readiness, and run the org's commands and skills. Everything reads committed files.
 *
 * What it can't do: scan code (the catalog is only as fresh as the last committed scan),
 * record critic findings or move a change through its hand-offs (no state is written; the
 * assistant reports, a person or `atticus` records), open PRs, call adapters, or run
 * deterministic checks: those need the CLI. Generated files say so in their own words.
 *
 * In a repo adopted in place the org pack is in `.atticus/org-pack/`, so the generated text
 * points there; the catalog and change folders follow `sources.yaml` `layout`.
 */

/** Point `org-pack/` mentions at where the org pack really is. */
function relocate(text: string, orgPackRel: string): string {
  if (orgPackRel === "org-pack") return text;
  return text.replace(/(^|[^\w./-])org-pack\//g, `$1${orgPackRel}/`);
}

export async function renderZeroInstall(paths: MetarepoPaths): Promise<RenderedFile[]> {
  const orgPack = await loadOrgPack(paths.orgPackDir);
  const { commands } = await loadOrgCommands(paths.orgPackDir);
  return renderAssistantFiles({ orgPack, commands, profile: { kind: "metarepo" } }).map((f) => ({
    ...f,
    content: relocate(f.content, paths.orgPackRel),
    source: relocate(f.source, paths.orgPackRel),
  }));
}

/** Generate the metarepo's assistant files in place (adopted or not). */
export async function zeroInstallFiles(
  root: string,
  o: { force?: boolean; check?: boolean } = {},
): Promise<WriteReport & { files: RenderedFile[] }> {
  const paths = await resolveMetarepo(root);
  const files = await renderZeroInstall(paths);
  return { ...(await writeAssistantFiles(root, files, o)), files };
}

/**
 * Paths a command or instruction file points at under the metarepo's own folders (the org
 * pack, the catalog, OpenSpec, Spec Kit, .atticus), written in backticks. Placeholders
 * (`<change id>`) and globs (`*.yaml`) cut the path at their folder.
 */
export function referencedPaths(text: string, paths: MetarepoPaths): string[] {
  const roots = [
    paths.orgPackRel,
    paths.layout.catalog,
    paths.layout.openspec,
    ".specify",
    ".atticus",
  ];
  const out = new Set<string>();
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    let t = m[1]!;
    // A path has no spaces, except inside a <placeholder>.
    if (/\s/.test(t.replace(/<[^>]*>/g, ""))) continue;
    if (!roots.some((r) => t === r || t === `${r}/` || t.startsWith(`${r}/`))) continue;
    const cut = t.search(/[<*{$]/);
    if (cut >= 0) t = t.slice(0, t.lastIndexOf("/", cut) + 1);
    out.add(t.replace(/\/$/, ""));
  }
  return [...out].sort();
}

export interface ZeroInstallProblem {
  file: string;
  missing: string;
}

/** Every generated file's referenced paths exist in the repo: the structural zero-install check. */
export async function checkZeroInstall(
  root: string,
  files: { path: string; content: string }[],
): Promise<ZeroInstallProblem[]> {
  const paths = await resolveMetarepo(root);
  const problems: ZeroInstallProblem[] = [];
  for (const f of files)
    for (const ref of referencedPaths(f.content, paths)) {
      const full = join(root, ...ref.split("/"));
      if (!(await exists(full)) && !(await isDir(full)))
        problems.push({ file: f.path, missing: ref });
    }
  return problems;
}
