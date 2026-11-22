import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CODE_TABLE_FILE,
  decodeRequirements,
  parseCodeTable,
  parseRequirements,
  REQUIREMENTS_FILE,
  type CodeRow,
} from "@maycombhq/changes";
import { changesDirOf, changesRelOf, type CatalogRecord } from "@maycombhq/core";
import { readChangeFiles } from "@maycombhq/naysayer";
import { readChangeTasks, type ChangeTask } from "@maycombhq/speckit";

/**
 * ADR 0206 part B, 2: what a change with no target flow states of its code, for its map, impact
 * and estimate: the rows of design.md's "## In the code", or, before it is written, tasks.md's
 * repos and tasks. Files only.
 */

export interface QuickView {
  /** `design`: the table's rows; `tasks`: only tasks.md's repos and tasks. */
  from: "design" | "tasks";
  /** The file it is read from, relative to the metarepo. */
  source: string;
  rows: CodeRow[];
  tasks: ChangeTask[];
  /** The repos of tasks.md, in its order. */
  repos: string[];
  /** The ids requirements.md lists under `## Planned`. */
  planned: Set<string>;
}

/** Rows that say what the code has, as against a deployment's or a person's work. */
export const CODE_HAS = new Set([
  "serves",
  "listens",
  "calls",
  "publishes",
  "table",
  "column",
  "migration",
]);

/** A change's rows or tasks; undefined when it has neither a table nor a task. */
export async function quickViewOf(root: string, change: string): Promise<QuickView | undefined> {
  const dir = join(changesDirOf(root), change);
  const rel = `${changesRelOf(root)}/${change}`;
  const design = await readFile(join(dir, CODE_TABLE_FILE), "utf8").catch(() => undefined);
  const table = design === undefined ? undefined : parseCodeTable(design);
  const tasks = readChangeTasks(await readChangeFiles(dir).catch(() => ({}) as never)).filter(
    (t) => !!t.repo,
  );
  const req = await readFile(join(dir, REQUIREMENTS_FILE)).catch(() => undefined);
  const planned = new Set(req ? parseRequirements(decodeRequirements(req)).planned : []);
  const repos = [...new Set(tasks.map((t) => t.repo))];
  if (table?.found && table.rows.length)
    return {
      from: "design",
      source: `${rel}/${CODE_TABLE_FILE}`,
      rows: table.rows,
      tasks,
      repos,
      planned,
    };
  if (!tasks.length) return undefined;
  return { from: "tasks", source: `${rel}/tasks.md`, rows: [], tasks, repos, planned };
}

/** The component a repo's code is: the catalog's Component of the repo, else the repo's id. */
export function componentOfRepo(records: readonly CatalogRecord[], repo: string): string {
  const c = records
    .filter((r) => r.kind === "Component" && (r as { repo?: string }).repo === repo)
    .map((r) => r.id)
    .sort();
  return c[0] ?? repo;
}

/** `forge-ledger GET /v1/accounts/{id}` → the target and the entry. */
export function callOf(what: string): { target: string; entry: string } {
  const [target, ...rest] = what.split(/\s+/);
  return { target: target ?? "", entry: rest.join(" ") };
}
