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

/** The layout from sources.yaml, or the defaults. */
export function layoutOf(root: string): { catalog: string; openspec: string } {
  try {
    const r = Sources.safeParse(
      parse(readFileSync(join(orgPackDirOf(root), "sources.yaml"), "utf8")),
    );
    if (r.success) return { catalog: r.data.layout.catalog, openspec: r.data.layout.openspec };
  } catch {
    // no sources.yaml: defaults
  }
  return { catalog: "catalog", openspec: "openspec" };
}

/** The catalog folder (holding generated/ and curated/). */
export function catalogDirOf(root: string): string {
  return join(root, ...layoutOf(root).catalog.split("/"));
}
