import { join } from "node:path";
import {
  catalogDirOf,
  raiseQuestions,
  readQuestion,
  type CatalogRecord,
  type Question,
} from "@maycombhq/core";
import {
  CONFLICT_STEP,
  conflictDraft,
  readConflicts,
  readKnowledge,
  type ConflictView,
} from "@maycombhq/knowledge";
import { readCatalog } from "@maycombhq/scanner";
import { readKnowledgeApplies } from "./stages/knowledge-applies.js";

/**
 * Pages that disagree about knowledge a change relies on, raised to a person (ADR 0124 addendum
 * B-task-knowledge). A conflict touches the change when an item it is about, or a section of one
 * of its pages, is in the change's knowledge list (knowledge.yaml: what its stages and its tasks
 * picked, not what a person excluded) or in a task's knowledge. Every such conflict is asked of a
 * person, with the page an ownership signal suggests named as a suggestion: nothing is picked
 * silently. Not asked: one a person already answered, one already asked (on this change or
 * another: the question's evidence names the item and pages, so the same topic and pages are
 * found whatever the snapshot's date), and one the code settles: a record verified from code
 * holds one page's value, and a document never overrides a fact verified from code; the conflict
 * says so and cites the record wherever it is shown.
 */

const pageFile = (page: string) => (/\.(md|markdown)$/i.test(page) ? page : `${page}.md`);

/** The catalog's records, for a conflict the code settles; none when the catalog can't be read. */
export async function codeFactRecords(root: string): Promise<CatalogRecord[]> {
  return (
    (
      await readCatalog(join(catalogDirOf(root), "generated"), { cacheRoot: root }).catch(
        () => undefined,
      )
    )?.records ?? []
  );
}

/** Whether a conflict touches any of these ids: an item it is about, or a section of its pages. */
export function conflictTouches(v: ConflictView, used: ReadonlySet<string>): boolean {
  if (v.conflict.about.some((id) => used.has(id))) return true;
  const pages = new Set(v.conflict.pages.map((p) => `${p.source}/${pageFile(p.page)}`));
  for (const id of used) {
    const hash = id.indexOf("#");
    if (hash > 0 && pages.has(id.slice(0, hash))) return true;
  }
  return false;
}

export interface AskedConflicts {
  /** Questions raised now. */
  raised: Question[];
  /** Questions about the change's conflicts that wait for a person (raised now or before). */
  open: Question[];
  /** The conflicts that touch the change, decided or not. */
  touching: ConflictView[];
}

/** Ask a person about each undecided conflict that touches the change, once. */
export async function askKnowledgeConflicts(
  root: string,
  change: string,
  by: { command: string; rerun: string; at: string; run?: string },
  o: { used?: Iterable<string>; records?: readonly CatalogRecord[] } = {},
): Promise<AskedConflicts> {
  const knowledge = await readKnowledge(root, { cacheRoot: root });
  const conflicts = knowledge.report?.conflicts ?? [];
  if (!conflicts.length) return { raised: [], open: [], touching: [] };
  const list = await readKnowledgeApplies(root, change);
  const used = new Set([
    ...(list?.items ?? []).filter((i) => i.status !== "excluded").map((i) => i.id),
    ...(o.used ?? []),
  ]);
  const records = o.records ?? (await codeFactRecords(root));
  const views = await readConflicts(root, { conflicts, records });
  const touching = views.filter((v) => conflictTouches(v, used));
  const ask = touching.filter((v) => !v.decided && !v.question);
  const drafts = [];
  for (const v of ask)
    drafts.push(await conflictDraft(root, v.conflict, { items: knowledge.items }));
  const raised = drafts.length
    ? (await raiseQuestions(root, drafts, { step: CONFLICT_STEP, repo: change, ...by })).raised
    : [];
  const open: Question[] = [...raised];
  for (const v of touching)
    if (v.question?.state === "open" && !open.some((q) => q.id === v.question!.id)) {
      const q = await readQuestion(root, v.question.id).catch(() => undefined);
      if (q) open.push(q);
    }
  return { raised, open, touching };
}
