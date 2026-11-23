import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { inputsDirOf, knowledgeDirOf, quickPathOf } from "@maycombhq/core";
import {
  changeFolder,
  CODE_TABLE_FILE,
  decodeRequirements,
  parseCodeTable,
  parseRequirements,
  REQUIREMENTS_FILE,
  rowIds,
  type Assessment,
  type ChangeContext,
} from "@maycombhq/changes";
import { recordQuickKnowledge } from "@maycombhq/planner";

/** What `atticus change handoff` says when no knowledge source is set up. */
export const NO_SOURCES =
  "No knowledge sources are set up: add a wiki with atticus sources add <type> <location>, or drop documents in inputs/ (atticus intake add <files>).";

/** Whether the metarepo has a source of the org's knowledge: a wiki, inputs/ or knowledge items. */
async function hasSources(ctx: ChangeContext): Promise<boolean> {
  if (ctx.orgPack.sources.wikis.length) return true;
  const any = (dir: string) =>
    readdir(dir).then(
      (x) => x.length > 0,
      () => false,
    );
  if (
    await stat(inputsDirOf(ctx.root)).then(
      (s) => s.isDirectory(),
      () => false,
    )
  )
    return true;
  return any(knowledgeDirOf(ctx.root));
}

/**
 * v31 (WP-05): once a quick change's plan hand-off passes its checks, the org's knowledge it leads
 * to, from the ids its In the code rows and its Planned list cite and the words of its
 * requirements and proposal, written to knowledge.yaml so it rides with the hand-off. The line
 * to print, or nothing for any other change or phase. Never throws: a failure is said.
 */
export async function quickKnowledgeLine(
  ctx: ChangeContext,
  a: Assessment,
): Promise<string | undefined> {
  if (a.phase !== "plan" || !quickPathOf(a.type)) return undefined;
  try {
    const c = a.change;
    const dir = changeFolder(ctx.root, c.id);
    const read = (f: string) => readFile(join(dir, f), "utf8").catch(() => "");
    const req = await readFile(join(dir, REQUIREMENTS_FILE)).catch(() => undefined);
    const planned = req ? parseRequirements(decodeRequirements(req)).planned : [];
    const rows = parseCodeTable(await read(CODE_TABLE_FILE)).rows;
    const ids = [...new Set([...rows.flatMap(rowIds), ...planned])];
    const text = [req ? decodeRequirements(req) : "", await read("proposal.md")].join("\n\n");
    const r = await recordQuickKnowledge(ctx.root, c.id, { ids, text, title: c.title });
    if (r.note) return `Knowledge: not listed: ${r.note} (knowledge.yaml says so).`;
    if (r.found)
      return `Knowledge: ${r.found} item${r.found === 1 ? "" : "s"} of the org's knowledge may apply (knowledge.yaml); the hand-off PR lists them.`;
    return (await hasSources(ctx))
      ? "Knowledge: nothing in the org's knowledge was found for this change (knowledge.yaml)."
      : `Knowledge: nothing listed. ${NO_SOURCES}`;
  } catch (e) {
    return `Knowledge: not listed: ${(e as Error).message.split("\n")[0]}.`;
  }
}
