import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { quickPathOf, type ChangeLifecycle } from "@maycombhq/core";
import {
  changeFolder,
  changeTypeOf,
  CODE_TABLE_FILE,
  decodeRequirements,
  loadChangeContext,
  parseCodeTable,
  parseRequirements,
  REQUIREMENTS_FILE,
  rowIds,
} from "@maycombhq/changes";
import { recordQuickKnowledge } from "@maycombhq/planner";

/**
 * v31 (WP-05): before a quick change's plan hand-off, the org's knowledge it leads to, from the
 * ids its In the code rows and its Planned list cite and the words of its requirements and
 * proposal, written to knowledge.yaml so it rides with the hand-off. The line to print, or
 * nothing for any other change or phase. Never refuses: a failure is said in the line.
 */
export async function quickKnowledgeLine(
  root: string,
  c: ChangeLifecycle,
): Promise<string | undefined> {
  if (c.state !== "plan") return undefined;
  const ctx = await loadChangeContext(root);
  if (!quickPathOf(changeTypeOf(ctx, c.type))) return undefined;
  const dir = changeFolder(root, c.id);
  const read = (f: string) => readFile(join(dir, f), "utf8").catch(() => "");
  const req = await readFile(join(dir, REQUIREMENTS_FILE)).catch(() => undefined);
  const planned = req ? parseRequirements(decodeRequirements(req)).planned : [];
  const rows = parseCodeTable(await read(CODE_TABLE_FILE)).rows;
  const ids = [...new Set([...rows.flatMap(rowIds), ...planned])];
  const text = [req ? decodeRequirements(req) : "", await read("proposal.md")].join("\n\n");
  const r = await recordQuickKnowledge(root, c.id, { ids, text, title: c.title });
  const where = r.note ? `knowledge.yaml; ${r.note}` : "knowledge.yaml";
  return r.found
    ? `Knowledge: ${r.found} item${r.found === 1 ? "" : "s"} of the org's knowledge may apply (${where}); the hand-off PR lists them.`
    : `Knowledge: nothing in the org's knowledge was found for this change (${where}).`;
}
