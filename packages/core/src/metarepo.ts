import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { Sources } from "./schema/orgpack.js";

/**
 * Where a metarepo keeps things, for every command that takes `--root`. A metarepo made by
 * `atticus init` has `org-pack/` at its root and its local state (`.index/`, `.runs/`,
 * `workspace/`) there too. A repo adopted in place (`atticus adopt`) keeps everything Atticus
 * owns in `.atticus/`: the org pack in `.atticus/org-pack/` and local state in `.atticus/`.
 * Either way the catalog and OpenSpec folders are where `sources.yaml` `layout` says.
 * Synchronous so it can replace a plain `join(root, "org-pack")` anywhere.
 */

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** True when the org pack is in `.atticus/org-pack/` (a repo adopted in place). */
export function isAdopted(root: string): boolean {
  return !isDir(join(root, "org-pack")) && isDir(join(root, ".atticus", "org-pack"));
}

/** The org pack folder: `org-pack/` at the root, else `.atticus/org-pack/` when adopted. */
export function orgPackDirOf(root: string): string {
  return isAdopted(root) ? join(root, ".atticus", "org-pack") : join(root, "org-pack");
}

/** The folder holding local state (`.index/`, `.runs/`, `workspace/`): the root, or `.atticus/`. */
export function stateDirOf(root: string): string {
  return isAdopted(root) ? join(root, ".atticus") : root;
}

/** Run folders (`.runs/<change>/<runId>/`: prompts, packs, build logs): under the state folder. */
export function runsDirOf(root: string): string {
  return join(stateDirOf(root), ".runs");
}

/** The run folders relative to the root with forward slashes, for messages and stored paths. */
export function runsRelOf(root: string): string {
  return isAdopted(root) ? ".atticus/.runs" : ".runs";
}

/** Where intake looks for what people drop in: `inputs/`, or `.atticus/inputs/` when adopted. */
export function inputsDirOf(root: string): string {
  return join(stateDirOf(root), "inputs");
}

/** Where Atticus writes proposals for people to review, relative to the root with forward slashes. */
export function proposalsRelOf(root: string): string {
  return isAdopted(root) ? ".atticus/proposals" : "proposals";
}

/** The proposals folder: `proposals/`, or `.atticus/proposals/` when adopted. */
export function proposalsDirOf(root: string): string {
  return join(root, ...proposalsRelOf(root).split("/"));
}

/** Where questions to people live (ADR 0078), relative to the root: `questions`, or `.atticus/questions` when adopted. */
export function questionsRelOf(root: string): string {
  return isAdopted(root) ? ".atticus/questions" : "questions";
}

/** The questions folder (ADR 0078). */
export function questionsDirOf(root: string): string {
  return join(root, ...questionsRelOf(root).split("/"));
}

/** Where repo specs live (ADR 0079), relative to the root: `specs`, or `.atticus/specs` when adopted. */
export function specsRelOf(root: string): string {
  return isAdopted(root) ? ".atticus/specs" : "specs";
}

/** The specs folder (ADR 0079), holding one folder per repo. */
export function specsDirOf(root: string): string {
  return join(root, ...specsRelOf(root).split("/"));
}

/** One repo's spec folder, relative to the root: `specs/<repo>` (spec.yaml and one file per flow). */
export function specRelOf(root: string, repo: string): string {
  return `${specsRelOf(root)}/${repo}`;
}

/** One repo's spec folder (ADR 0079). */
export function specDirOf(root: string, repo: string): string {
  return join(specsDirOf(root), repo);
}

// Change folders resolve through the layout on every call, so the parsed file is kept until
// sources.yaml changes (size or time).
const layouts = new Map<string, { key: string; layout: { catalog: string; openspec: string } }>();

/** The layout from sources.yaml, or the defaults. */
export function layoutOf(root: string): { catalog: string; openspec: string } {
  const file = join(orgPackDirOf(root), "sources.yaml");
  let key = "none";
  try {
    const s = statSync(file);
    key = `${s.mtimeMs}:${s.size}`;
  } catch {
    // no sources.yaml: defaults
  }
  const hit = layouts.get(file);
  if (hit && hit.key === key) return { ...hit.layout };
  let layout = { catalog: "catalog", openspec: "openspec" };
  try {
    const r = Sources.safeParse(parse(readFileSync(file, "utf8")));
    if (r.success) layout = { catalog: r.data.layout.catalog, openspec: r.data.layout.openspec };
  } catch {
    // no sources.yaml, or not YAML: defaults
  }
  layouts.set(file, { key, layout });
  return { ...layout };
}

/** The catalog folder (holding generated/ and curated/). */
export function catalogDirOf(root: string): string {
  return join(root, ...layoutOf(root).catalog.split("/"));
}

/**
 * Where OpenSpec keeps changes, relative to the root with forward slashes: `changes/` under
 * `layout.openspec` (`openspec/changes` by default, `.atticus/openspec/changes` in a repo
 * adopted without its own OpenSpec folder). For messages, PR file lists and CODEOWNERS paths.
 */
export function changesRelOf(root: string): string {
  return `${layoutOf(root).openspec.replace(/\/+$/, "")}/changes`;
}

/** The OpenSpec folder (holding config.yaml, specs/ and changes/). */
export function openspecDirOf(root: string): string {
  return join(root, ...layoutOf(root).openspec.split("/"));
}

/** The folder holding change folders (`<id>/`) and `archive/`. */
export function changesDirOf(root: string): string {
  return join(root, ...changesRelOf(root).split("/"));
}
