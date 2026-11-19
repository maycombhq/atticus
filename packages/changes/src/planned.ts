import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadOrgPack, orgPackDirOf } from "@maycombhq/core";
import { decodeRequirements, parseRequirements, REQUIREMENTS_FILE } from "./requirements.js";
import { changeFolder, changeStore } from "./store.js";

/** A `## <repo>` heading of tasks.md: one word, shaped like an id. */
const TASK_REPO = /^##\s+`?([a-z0-9][a-z0-9._-]*)`?\s*$/gm;

/**
 * Whether a heading is shaped like a repo id: lower case, with a dash, a dot or an underscore
 * between its parts (`forge-approvals-api`), so a heading of notes (`## overview`) is no repo.
 */
export const looksLikeRepoId = (h: string): boolean => /^[a-z0-9]+([._-][a-z0-9]+)+$/.test(h);

/** The repos a tasks.md groups its tasks under, in the file's order, each once. */
export function taskRepoHeadings(tasks: string): string[] {
  return [...new Set([...tasks.matchAll(TASK_REPO)].map((m) => m[1]!))];
}

/**
 * What one change's own files say it plans (ADR 0201 addendum, 2026-11-19): each id under its
 * requirements file's `## Planned` that it creates itself (not one it says another change
 * plans), and each `## <repo>` of its tasks.md that isn't in `known` (the manifests' repos).
 */
export async function plannedByChange(
  root: string,
  id: string,
  known: ReadonlySet<string>,
): Promise<string[]> {
  const dir = changeFolder(root, id);
  const bytes = await readFile(join(dir, REQUIREMENTS_FILE)).catch(() => undefined);
  const items = bytes ? parseRequirements(decodeRequirements(bytes)).plannedItems : [];
  const elsewhere = new Set(items.filter((x) => x.by !== undefined).map((x) => x.id));
  const tasks = await readFile(join(dir, "tasks.md"), "utf8").catch(() => "");
  return [
    ...new Set([
      ...items.filter((x) => x.by === undefined).map((x) => x.id),
      ...taskRepoHeadings(tasks).filter(
        (r) => !known.has(r) && !elsewhere.has(r) && looksLikeRepoId(r),
      ),
    ]),
  ];
}

/**
 * Each id an open change plans, with the changes that plan it, in id order. Read from the files:
 * the map tools say of such an id which change plans it, and the door check holds "planned by
 * `<change id>`" to it.
 */
export async function plannedByOpenChanges(root: string): Promise<Map<string, string[]>> {
  const pack = await loadOrgPack(orgPackDirOf(root));
  const known = new Set(pack.profiles.flatMap((p) => p.repos?.repos.map((r) => r.id) ?? []));
  const by = new Map<string, string[]>();
  const open = (await changeStore(root).list()).filter((c) => c.state !== "archived");
  for (const c of open.sort((a, b) => (a.id < b.id ? -1 : 1)))
    for (const id of await plannedByChange(root, c.id, known))
      by.set(id, [...(by.get(id) ?? []), c.id]);
  return new Map([...by].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
}
