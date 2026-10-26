import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { loadOpenSpecSettings, orgPackDirOf } from "@maycombhq/core";
import {
  addStoreReference,
  readStoreVia,
  readStoreMarker,
  STORE_MARKER,
  type StoreSpecEntry,
  type StoreView,
} from "@maycombhq/openspec-adapter";
import { createGit, type GitRunner } from "@maycombhq/workspace";

/**
 * OpenSpec stores (beta, ADR 0126) as the metarepo uses them: the stores org-pack/openspec.yaml
 * names, read read-only and labelled beside the metarepo's own changes and specs, and the
 * `references:` entry hand-down adds to a code repo when the org pack turns it on. Nothing here
 * registers, clones, pulls, pushes or writes into a store.
 */

/** A store the org pack names, as read. */
export interface OpenSpecStore extends StoreView {
  /** How Atticus shows what came from it: openspec.yaml's label, else store.yaml's id, else the folder's name. */
  label: string;
  /** The path as openspec.yaml gives it. */
  path: string;
}

/** A store's folder: a path relative to the metarepo root, absolute, or starting `~/`. */
export function storeDirOf(root: string, path: string): string {
  if (path === "~" || path.startsWith("~/") || path.startsWith("~\\"))
    return join(homedir(), path.slice(2));
  return isAbsolute(path) ? resolve(path) : resolve(root, path);
}

function packRel(root: string): string {
  return relative(root, orgPackDirOf(root)).split(sep).join("/");
}

/** The stores org-pack/openspec.yaml names, each read (read-only), with what couldn't be. */
export async function openspecStores(
  root: string,
): Promise<{ stores: OpenSpecStore[]; problems: string[] }> {
  const { settings, problem } = await loadOpenSpecSettings(orgPackDirOf(root));
  const problems = problem ? [`${packRel(root)}/${problem}`] : [];
  const stores: OpenSpecStore[] = [];
  for (const s of settings.stores) {
    const dir = storeDirOf(root, s.path);
    // ADR 0006 addendum: through `openspec list` in the store where it runs; its files if not.
    const view = await readStoreVia(dir);
    stores.push({ ...view, label: s.label ?? view.id ?? basename(dir), path: s.path });
  }
  const seen = new Set<string>();
  for (const s of stores) {
    if (seen.has(s.label))
      problems.push(
        `${packRel(root)}/openspec.yaml: two stores are labelled ${s.label}; give one a label`,
      );
    seen.add(s.label);
  }
  return { stores, problems };
}

/** A capability's spec in the stores, by its folder name, with the store's label. */
export async function storeSpecLookup(
  root: string,
  capability: string,
): Promise<(StoreSpecEntry & { store: string })[]> {
  const { stores } = await openspecStores(root);
  return stores.flatMap((s) =>
    s.specs.filter((x) => x.id === capability).map((x) => ({ store: s.label, ...x })),
  );
}

const REMOTE = /^[a-z][a-z0-9+.-]*:\/\//i;
const SCP = /^[^/\\]+@[^:/\\]+:/;

/**
 * The metarepo's origin, when it is somewhere a teammate can clone from (a URL, not a local
 * folder), and only when the metarepo is a Git repo's top, so a parent repo's origin is never
 * taken for it.
 */
export async function metarepoOrigin(
  root: string,
  git: GitRunner = createGit(),
): Promise<string | undefined> {
  if (!existsSync(join(root, ".git"))) return undefined;
  try {
    const url = (await git(["remote", "get-url", "origin"], root)).stdout.trim();
    if (!url || url.startsWith("file:")) return undefined;
    return REMOTE.test(url) || SCP.test(url) ? url : undefined;
  } catch {
    return undefined;
  }
}

export type ReferenceResult =
  | { action: "off" }
  | { action: "added" | "present"; file: string }
  | { action: "skipped"; file: string; why: string };

/**
 * Hand-down's step for OpenSpec (ADR 0126): when org-pack/openspec.yaml has
 * `referenceInRepos: true`, add this metarepo under `references:` in the code repo's
 * openspec/config.yaml (its store.yaml id, with its origin as `remote` when it has one). Only an
 * existing config is edited, keeping its comments and every other key; nothing else is touched.
 */
export async function referenceMetarepoIn(
  root: string,
  repoDir: string,
  o: { git?: GitRunner } = {},
): Promise<ReferenceResult> {
  const { settings } = await loadOpenSpecSettings(orgPackDirOf(root));
  if (!settings.referenceInRepos) return { action: "off" };
  const file = "openspec/config.yaml";
  const marker = await readStoreMarker(root);
  if (!marker.marker)
    return {
      action: "skipped",
      file,
      why: marker.missing
        ? `this metarepo isn't an OpenSpec store yet (no ${STORE_MARKER}): run atticus upgrade --openspec-store, commit the file, then hand down again`
        : `this metarepo's ${STORE_MARKER} can't be read (${marker.notes.join("; ")})`,
    };
  const path = join(repoDir, "openspec", "config.yaml");
  const text = await readFile(path, "utf8").catch(() => undefined);
  if (text === undefined)
    return {
      action: "skipped",
      file,
      why: "the repo has no openspec/config.yaml, so there is nowhere to add the metarepo as an OpenSpec reference",
    };
  const remote = marker.marker.remote ?? (await metarepoOrigin(root, o.git));
  const r = addStoreReference(text, { id: marker.marker.id, ...(remote ? { remote } : {}) });
  if ("problem" in r) return { action: "skipped", file, why: r.problem };
  if (r.action === "added") await writeFile(path, r.text, "utf8");
  return { action: r.action, file };
}
