import { join } from "node:path";
import { parse } from "yaml";
import { DEFAULT_SOURCES, Sources } from "@maycombhq/core";
import type { z } from "zod";
import { isDir, readText } from "./files.js";

/**
 * Where things are in a metarepo, whichever way it was set up.
 *
 * - A metarepo made by `atticus init` keeps the org pack in `org-pack/` at its root and its
 *   local state (`workspace/`, `.index/`, `.runs/`) at the root, git-ignored.
 * - A repo adopted in place (`atticus adopt`) keeps everything Atticus owns in `.atticus/`:
 *   the org pack in `.atticus/org-pack/`, local state in `.atticus/` (ignored by
 *   `.atticus/.gitignore`), proposals in `.atticus/proposals/`. The org pack's `sources.yaml`
 *   `layout` says where the repo's own OpenSpec folder and catalog are; nothing is moved.
 *
 * Every command that takes `--root` resolves paths through this, so it works on both.
 */

export const ATTICUS_DIR = ".atticus";
export const ORG_PACK_DIR = "org-pack";
/** Local-state folders, relative to the state folder; never committed. */
export const STATE_FOLDERS = ["workspace", ".index", ".runs", "state", "absorbed"] as const;

export type Layout = z.infer<typeof Sources>["layout"];

export interface MetarepoPaths {
  root: string;
  /** True when the org pack is in `.atticus/org-pack` (adopted in place). */
  adopted: boolean;
  orgPackDir: string;
  /** The org pack folder relative to the root, with forward slashes. */
  orgPackRel: string;
  layout: Layout;
  catalogDir: string;
  openspecDir: string;
  /** The folder holding workspace/, .index/ and .runs/: the root, or `.atticus/`. */
  stateDir: string;
  /** Where Atticus writes proposals for people to review (never the org pack itself). */
  proposalsDir: string;
  proposalsRel: string;
  inputsDir: string;
}

/** The org pack's layout from sources.yaml, or the defaults when it has none or it is invalid. */
export async function readLayout(orgPackDir: string): Promise<Layout> {
  const text = await readText(join(orgPackDir, "sources.yaml"));
  if (text === undefined) return DEFAULT_SOURCES.layout;
  try {
    const r = Sources.safeParse(parse(text));
    return r.success ? r.data.layout : DEFAULT_SOURCES.layout;
  } catch {
    return DEFAULT_SOURCES.layout;
  }
}

/** Resolve a metarepo's paths: `org-pack/` at the root wins; else `.atticus/org-pack/`. */
export async function resolveMetarepo(root: string): Promise<MetarepoPaths> {
  const adopted =
    !(await isDir(join(root, ORG_PACK_DIR))) &&
    (await isDir(join(root, ATTICUS_DIR, ORG_PACK_DIR)));
  return pathsFor(root, adopted, await readLayout(orgPackDirOf(root, adopted)));
}

export function orgPackDirOf(root: string, adopted: boolean): string {
  return adopted ? join(root, ATTICUS_DIR, ORG_PACK_DIR) : join(root, ORG_PACK_DIR);
}

export function pathsFor(root: string, adopted: boolean, layout: Layout): MetarepoPaths {
  const stateDir = adopted ? join(root, ATTICUS_DIR) : root;
  const proposalsRel = adopted ? `${ATTICUS_DIR}/proposals` : "proposals";
  return {
    root,
    adopted,
    orgPackDir: orgPackDirOf(root, adopted),
    orgPackRel: adopted ? `${ATTICUS_DIR}/${ORG_PACK_DIR}` : ORG_PACK_DIR,
    layout,
    catalogDir: join(root, ...layout.catalog.split("/")),
    openspecDir: join(root, ...layout.openspec.split("/")),
    stateDir,
    proposalsDir: join(root, ...proposalsRel.split("/")),
    proposalsRel,
    inputsDir: adopted ? join(root, ATTICUS_DIR, "inputs") : join(root, "inputs"),
  };
}

/**
 * A manifest `url` that is a relative path (`.` or starting with `./`) names a repo that is
 * already in place under the metarepo root, as in an adopted repo or a folder of clones:
 * scans read it there instead of from a base clone under workspace/.
 */
export function inPlacePath(url: string): string | undefined {
  if (url === ".") return ".";
  if (url.startsWith("./")) {
    const rest = url.slice(2).replace(/\/+$/, "");
    if (rest === "") return ".";
    if (rest.split("/").includes("..")) return undefined;
    return rest;
  }
  return undefined;
}
