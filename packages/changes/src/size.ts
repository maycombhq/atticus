import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fastGateOf, fastPathOf, type ChangeLifecycle } from "@maycombhq/core";
import type { ChangeContext } from "./context.js";
import { changeFolder } from "./store.js";

/** How a change is planned (ADR 0113): the fast path's one step, or the three stages. */
export interface ChangeSize {
  fast: boolean;
  /** type: its change type is small; brief: its brief says small and the type allows it. */
  why: ReturnType<typeof fastPathOf>["why"];
  /** The gate the fast path's critic runs at; undefined when gates.yaml has none for it. */
  gate?: string;
  /** Plain words for a person: why this change takes the path it takes. */
  words: string;
}

/** Whether a change takes the fast path, from its change type and its brief. */
export async function changeSize(ctx: ChangeContext, change: ChangeLifecycle): Promise<ChangeSize> {
  const type = ctx.orgPack.changeTypes.types.find((t) => t.id === change.type);
  if (!type)
    return {
      fast: false,
      why: "standard",
      words: `${change.type} isn't a change type in change-types.yaml, so ${change.id} takes the full path.`,
    };
  const brief = await readFile(join(changeFolder(ctx.root, change.id), "brief.md"), "utf8").catch(
    () => "",
  );
  const f = fastPathOf(type, brief);
  const gate = f.fast ? fastGateOf(type, ctx.orgPack.gates) : undefined;
  const words: Record<ChangeSize["why"], string> = {
    type: `${change.id} is a ${type.name.toLowerCase()} (${type.id}), a small type: one step from brief to tasks.`,
    brief: `${change.id}'s brief says it is small, and ${type.id} lets a brief say so: one step from brief to tasks.`,
    "brief-standard": `${change.id}'s brief says it is standard, so it takes the full path though ${type.id} is small.`,
    "brief-not-allowed": `${change.id}'s brief says it is small, but ${type.id} doesn't let a brief choose the fast path (smallWhenBriefSays in change-types.yaml), so it takes the full path.`,
    standard: `${change.id} is a ${type.id} change: the feature, architecture and stories stages.`,
  };
  return { fast: f.fast, why: f.why, ...(gate ? { gate } : {}), words: words[f.why] };
}
