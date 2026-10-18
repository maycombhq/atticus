import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadOrgPack } from "@maycombhq/core";
import type { GitRunner } from "@maycombhq/workspace";
import { AdoptError } from "../errors.js";
import { listFiles, sha256 } from "../files.js";
import { resolveMetarepo } from "../layout.js";
import { absorb, type AbsorbedEntry, type AbsorbResult } from "./absorb.js";
import type { Action } from "./types.js";

/**
 * `atticus absorb --refresh <id>` and `atticus sources refresh`: a linked source is followed,
 * not copied, so refreshing fetches it again (a clone is made afresh, a folder is read where
 * it is), rewrites its proposal from what it holds now and says what changed since the last
 * absorb: proposal files added, removed or changed, and items that appeared, went away or
 * changed action. The org pack is never written; the proposal is reviewed as before.
 */

export interface RefreshResult {
  id: string;
  entry: AbsorbedEntry;
  /** Where the source's entry was found: the org pack, or the last absorb's proposal. */
  from: "sources.yaml" | "proposal";
  result: AbsorbResult;
  /** Files of the source itself, relative to it. */
  source: { added: string[]; removed: string[]; changed: string[] };
  /** Proposal files (not SUMMARY.md, PR.md or inventory.json), relative to the proposal. */
  files: { added: string[]; removed: string[]; changed: string[] };
  /** Item ids. */
  items: {
    added: string[];
    removed: string[];
    changed: { id: string; from: Action; to: Action }[];
  };
}

const META = new Set(["SUMMARY.md", "PR.md", "inventory.json"]);

interface Inventory {
  entry?: AbsorbedEntry;
  sources?: Record<string, string>;
  items?: { id: string; action: Action }[];
}

async function snapshot(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const f of await listFiles(dir))
    if (!META.has(f)) out.set(f, sha256(await readFile(join(dir, f))));
  return out;
}

export async function refreshAbsorbed(
  root: string,
  id: string,
  o: { git?: GitRunner } = {},
): Promise<RefreshResult> {
  const p = await resolveMetarepo(root);
  const listed = (await loadOrgPack(p.orgPackDir)).sources.absorbed.find((a) => a.id === id);
  const proposal = join(p.proposalsDir, "absorb", id);
  const inventory = JSON.parse(
    await readFile(join(proposal, "inventory.json"), "utf8").catch(() => "{}"),
  ) as Inventory;
  const entry = listed ?? inventory.entry;
  if (!entry)
    throw new AdoptError(
      "not-found",
      `There is no absorbed source ${id}: absorb it first with atticus absorb <git-url|path> --id ${id}.`,
    );
  if (entry.mode === "ignore")
    throw new AdoptError(
      "usage",
      `${id} is absorbed with mode ignore; there is nothing to refresh.`,
    );

  const before = await snapshot(proposal);
  const beforeItems = new Map((inventory.items ?? []).map((i) => [i.id, i.action]));
  const result = await absorb(root, entry.url, {
    id,
    ...(entry.mode ? { mode: entry.mode } : {}),
    ...(entry.ref ? { ref: entry.ref } : {}),
    ...(o.git ? { git: o.git } : {}),
  });
  const after = await snapshot(proposal);
  const afterItems = new Map(result.items.map((i) => [i.id, i.action]));

  const sorted = (xs: Iterable<string>) => [...xs].sort();
  const diff = (a: Map<string, string>, b: Map<string, string>) => ({
    added: sorted([...b.keys()].filter((f) => !a.has(f))),
    removed: sorted([...a.keys()].filter((f) => !b.has(f))),
    changed: sorted([...b.keys()].filter((f) => a.has(f) && a.get(f) !== b.get(f))),
  });
  return {
    id,
    entry: { ...entry },
    from: listed ? "sources.yaml" : "proposal",
    result,
    source: diff(
      new Map(Object.entries(inventory.sources ?? {})),
      new Map(Object.entries(result.sourceFiles)),
    ),
    files: diff(before, after),
    items: {
      added: sorted([...afterItems.keys()].filter((i) => !beforeItems.has(i))),
      removed: sorted([...beforeItems.keys()].filter((i) => !afterItems.has(i))),
      changed: [...afterItems]
        .filter(([i, a]) => beforeItems.has(i) && beforeItems.get(i) !== a)
        .map(([i, to]) => ({ id: i, from: beforeItems.get(i)!, to }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    },
  };
}

/** Refresh every source sources.yaml absorbs with mode link, in id order. */
export async function refreshAllAbsorbed(
  root: string,
  o: { git?: GitRunner } = {},
): Promise<RefreshResult[]> {
  const p = await resolveMetarepo(root);
  const linked = (await loadOrgPack(p.orgPackDir)).sources.absorbed
    .filter((a) => a.mode === "link")
    .sort((a, b) => a.id.localeCompare(b.id));
  const out: RefreshResult[] = [];
  for (const a of linked) out.push(await refreshAbsorbed(root, a.id, o));
  return out;
}
