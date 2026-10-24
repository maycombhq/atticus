import {
  knowledgeAppliesMarkdown,
  readKnowledgeApplies,
  setKnowledgeStatus,
} from "@maycombhq/planner";
import { changesRelOf } from "@maycombhq/core";
import type { Output } from "./commands.js";

/**
 * atticus change knowledge <id> (ADR 0124, Part 5): the org knowledge that applies to a change,
 * as its stages picked it, with the near-misses; `--confirm` or `--exclude` an item. An excluded
 * item is kept out of every later stage's selection.
 */
export async function changeKnowledge(
  root: string,
  change: string,
  o: { confirm?: string; exclude?: string; json?: boolean },
  io: Output,
): Promise<number> {
  try {
    if (o.confirm) await setKnowledgeStatus(root, change, o.confirm, "confirmed");
    if (o.exclude) await setKnowledgeStatus(root, change, o.exclude, "excluded");
  } catch (e) {
    io.err((e as Error).message);
    return 2;
  }
  const doc = await readKnowledgeApplies(root, change);
  if (!doc) {
    io.err(
      `${change} has no knowledge list yet: its stages write ${changesRelOf(root)}/${change}/knowledge.yaml when they select context (atticus change feature ${change}).`,
    );
    return 2;
  }
  if (o.json) io.out(JSON.stringify(doc, null, 2));
  else for (const l of knowledgeAppliesMarkdown(doc).trimEnd().split("\n")) io.out(l);
  if (o.confirm || o.exclude)
    io.out(
      `Written to ${changesRelOf(root)}/${change}/knowledge.yaml; commit it with the change's files.`,
    );
  return 0;
}
