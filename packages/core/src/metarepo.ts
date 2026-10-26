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

/** The org pack folder relative to the root with forward slashes, for messages and stored paths. */
export function orgPackRelOf(root: string): string {
  return isAdopted(root) ? ".atticus/org-pack" : "org-pack";
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

/** Where the facts an assistant writes live, with forward slashes (ADR 0124): `facts`, or `.atticus/facts` when adopted. */
export function factsRelOf(root: string): string {
  return isAdopted(root) ? ".atticus/facts" : "facts";
}

/** The facts folder (ADR 0124): `<repo>.jsonl` the assistant writes, `<repo>.rejected.jsonl` and `<repo>.verify.yaml` the verifier writes. */
export function factsDirOf(root: string): string {
  return join(root, ...factsRelOf(root).split("/"));
}

/**
 * The files the facts folder keeps beside a repo's facts file (ADR 0124): the questions the
 * assistant raised, what the verifier rejected, the files read and found to hold no fact, a
 * person's corrections, the verifier's report, and the read plan of a repo read in parts
 * (addendum A-ledger). None of them is a facts file of its own.
 */
export const FACTS_COMPANIONS = [
  ".questions.jsonl",
  ".rejected.jsonl",
  ".reviewed.jsonl",
  ".corrections.jsonl",
  ".verify.yaml",
  ".read-plan.yaml",
] as const;

/**
 * The repo a file in the facts folder belongs to, and whether it is the repo's facts file
 * (`<repo>.jsonl`) or one of its companions; undefined for any other file. Every place that lists
 * the facts folder reads it through this, so a companion is never taken for another repo.
 */
export function factsFileOf(name: string): { repo: string; facts: boolean } | undefined {
  for (const c of FACTS_COMPANIONS)
    if (name.endsWith(c) && name.length > c.length)
      return { repo: name.slice(0, -c.length), facts: false };
  if (name.endsWith(".jsonl") && name.length > ".jsonl".length)
    return { repo: name.slice(0, -".jsonl".length), facts: true };
  return undefined;
}

/** Where the map rendered from a repo's verified facts lives, with forward slashes (ADR 0124): `map`, or `.atticus/map` when adopted. */
export function mapRelOf(root: string): string {
  return isAdopted(root) ? ".atticus/map" : "map";
}

/** The map folder (ADR 0124): `<repo>/map.md`, `<repo>/flows/` and `<repo>/contracts/`, written by atticus map render. */
export function mapDirOf(root: string): string {
  return join(root, ...mapRelOf(root).split("/"));
}

/** Where judgments live (ADR 0117), relative to the root: `judgments`, or `.atticus/judgments` when adopted. */
export function judgmentsRelOf(root: string): string {
  return isAdopted(root) ? ".atticus/judgments" : "judgments";
}

/** The judgments folder (ADR 0117): judgments/<kind>/<key>.yaml. */
export function judgmentsDirOf(root: string): string {
  return join(root, ...judgmentsRelOf(root).split("/"));
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

/**
 * Where knowledge lives (ADR 0083), relative to the root: `knowledge`, or `.atticus/knowledge`
 * when adopted. It holds `snapshots/<source>/<date>/` (what a sync copied) and `items/` (what
 * the knowledge scan read from a snapshot).
 */
export function knowledgeRelOf(root: string): string {
  return isAdopted(root) ? ".atticus/knowledge" : "knowledge";
}

/** The knowledge folder (ADR 0083). */
export function knowledgeDirOf(root: string): string {
  return join(root, ...knowledgeRelOf(root).split("/"));
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
