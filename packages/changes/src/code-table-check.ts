import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { quickPathOf, type ChangeLifecycle, type ChangeType } from "@maycombhq/core";
import {
  checkCodeTable,
  CODE_TABLE_FILE,
  parseCodeTable,
  specNamesNotInRows,
  type CodeTable,
} from "./code-table.js";
import type { ChangeContext } from "./context.js";
import { asOpenItem, type Reason } from "./errors.js";
import { checkQuickTasks } from "./quick-tasks.js";
import { decodeRequirements, parseRequirements, REQUIREMENTS_FILE } from "./requirements.js";
import { changeFolder } from "./store.js";

/**
 * ADR 0206 point 4, the files side: a quick change's design.md In the code, checked before its
 * plan hand-off against its tasks.md, its spec deltas, its requirements' Planned list and the
 * map, and the map's names its spec deltas give that no row names (notes, never refusals).
 */

/** Each spec delta of a change folder: its path under the folder and its text. */
export async function specDeltas(dir: string): Promise<{ path: string; text: string }[]> {
  const out: { path: string; text: string }[] = [];
  for (const cap of (await readdir(join(dir, "specs")).catch(() => [] as string[])).sort()) {
    const text = await readFile(join(dir, "specs", cap, "spec.md"), "utf8").catch(() => undefined);
    if (text !== undefined) out.push({ path: `specs/${cap}/spec.md`, text });
  }
  return out;
}

/**
 * What the map has, for the table's ids: every record's id, each Endpoint's path or topic (a
 * topic is named by it), each Component's repo, and every repo a manifest lists, read or not.
 */
export function mapHas(ctx: Pick<ChangeContext, "records" | "orgPack">): (id: string) => boolean {
  const ids = new Set<string>();
  for (const r of ctx.records) {
    ids.add(r.id);
    const x = r as unknown as Record<string, unknown>;
    if (r.kind === "Endpoint" && typeof x.pathOrTopic === "string") ids.add(x.pathOrTopic);
    if (r.kind === "Component" && typeof x.repo === "string") ids.add(x.repo);
  }
  for (const p of ctx.orgPack.profiles) for (const r of p.repos?.repos ?? []) ids.add(r.id);
  return (id) => ids.has(id);
}

export interface CodeTableState {
  /** Whether the change is quick and has a design.md to read. */
  applies: boolean;
  table?: CodeTable;
  reasons: Reason[];
  /** The net: names of the map in the spec deltas that no row names. */
  notes: string[];
}

/** A quick change's table, its refusals and its notes; nothing for any other change. */
export async function codeTableState(
  ctx: ChangeContext,
  change: Pick<ChangeLifecycle, "id">,
  type: ChangeType,
): Promise<CodeTableState> {
  if (!quickPathOf(type)) return { applies: false, reasons: [], notes: [] };
  const dir = changeFolder(ctx.root, change.id);
  const design = await readFile(join(dir, CODE_TABLE_FILE), "utf8").catch(() => undefined);
  if (design === undefined) return { applies: false, reasons: [], notes: [] };
  const tasks = await readFile(join(dir, "tasks.md"), "utf8").catch(() => "");
  const specs = await specDeltas(dir);
  const req = await readFile(join(dir, REQUIREMENTS_FILE)).catch(() => undefined);
  const planned = req ? parseRequirements(decodeRequirements(req)).planned : [];
  const has = mapHas(ctx);
  const table = parseCodeTable(design);
  // ADR 0210 part 7: the table and the criteria are open items the plan hand-off's PR lists.
  const reasons: Reason[] = checkCodeTable(table, { tasks, specs, has, planned }).map((r) =>
    asOpenItem({ code: "design.code-table", artifact: "design", message: r.message }),
  );
  // v31 (WP-05): each task checked as the stories stage checks a story's; only none blocks.
  const found = checkQuickTasks({ tasks, table, specs, has, planned });
  for (const f of found.filter((x) => x.blocking))
    reasons.push(
      asOpenItem({ code: "stories.no-criteria", artifact: "tasks", message: f.message }),
    );
  const notes = [
    ...(table.found
      ? specNamesNotInRows(table, specs, (id) => has(id) || planned.includes(id))
      : []),
    ...found.filter((x) => !x.blocking).map((x) => x.message),
  ];
  return { applies: true, table, reasons, notes };
}
