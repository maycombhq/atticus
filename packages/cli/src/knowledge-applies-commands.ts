import {
  knowledgeAppliesMarkdown,
  readKnowledgeApplies,
  setKnowledgeStatus,
} from "@maycombhq/planner";
import { changesRelOf } from "@maycombhq/core";
import type { Output } from "./commands.js";

/**
 * atticus change knowledge <id> (ADR 0124, Part 5): the org knowledge that applies to a change,
 * as its stages picked it, with the near-misses; `--confirm` or `--exclude` any knowledge item,
 * listed or not (then it says just that). A confirmed item is selected by every later stage that
 * takes its kind; an excluded one is kept out of every later stage's selection.
 */
export async function changeKnowledge(
  root: string,
  change: string,
  o: { confirm?: string; exclude?: string; json?: boolean },
  io: Output,
): Promise<number> {
  // A person confirms or excludes any knowledge item, listed or not; what changed is said, not
  // the whole list again.
  const said: string[] = [];
  try {
    for (const [id, status] of [
      [o.confirm, "confirmed"],
      [o.exclude, "excluded"],
    ] as const) {
      if (!id) continue;
      const d = await setKnowledgeStatus(root, change, id, status);
      const i = d.items.find((x) => x.id === id)!;
      const what = `${id} (${i.kind}${i.title && i.title !== id ? `, ${i.title}` : ""})`;
      said.push(
        status === "confirmed"
          ? `Confirmed ${what}: every later stage that takes it selects it.`
          : `Excluded ${what}: every later stage leaves it out.`,
      );
    }
  } catch (e) {
    io.err((e as Error).message);
    return 2;
  }
  if (said.length) {
    if (o.json) io.out(JSON.stringify(await readKnowledgeApplies(root, change), null, 2));
    else for (const l of said) io.out(l);
    if (!o.json)
      io.out(
        `Written to ${changesRelOf(root)}/${change}/knowledge.yaml; commit it with the change's files.`,
      );
    return 0;
  }
  const doc = await readKnowledgeApplies(root, change);
  if (!doc) {
    io.err(
      `${change} has no knowledge list yet: its feature stage writes ${changesRelOf(root)}/${change}/knowledge.yaml with the patterns, standards, decisions, processes and requests and the wiki and document sections it picks, and every later stage adds what it picks (atticus change feature ${change}).`,
    );
    return 2;
  }
  if (o.json) io.out(JSON.stringify(doc, null, 2));
  else {
    for (const l of knowledgeAppliesMarkdown(doc).trimEnd().split("\n")) io.out(l);
    io.out(
      `Confirm or exclude an item: atticus change knowledge ${change} --confirm <id> (or --exclude <id>); an excluded one stays out of later stages.`,
    );
  }
  return 0;
}
