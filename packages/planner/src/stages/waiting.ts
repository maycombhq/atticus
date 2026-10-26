import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { changesDirOf } from "@maycombhq/core";
import { StageLoop, type Stage } from "./schema.js";

/**
 * The questions the stages hold back, read from their loop files alone. It is its own module,
 * and `@maycombhq/planner/waiting` its own entry, so `atticus questions list` doesn't load the
 * whole of the planner (the AI runtime, the critic, the extractors) to print a handful of
 * questions: that loading was most of the second the command took.
 */

/** A question a stage holds back over its stop's cap, as `atticus questions list` shows it. */
export interface WaitingQuestion {
  change: string;
  stage: Stage;
  question: string;
  evidence: string[];
  /** The command that asks it, once the open questions are answered: the stage's rerun. */
  rerun: string;
}

/** The command that runs a stage again (the same words `atticus questions list` prints). */
export function rerunOf(stage: Stage, change: string): string {
  return stage === "stories"
    ? `atticus plan stories ${change}`
    : `atticus change ${stage} ${change}`;
}

/**
 * Every question the changes' stages hold back over the stop's cap (ADR 0117 addendum,
 * 2026-10-25), from their loop files (`waiting`), by change and stage. A loop file that doesn't
 * read holds none.
 */
export async function waitingQuestions(root: string): Promise<WaitingQuestion[]> {
  const out: WaitingQuestion[] = [];
  const changes = (await readdir(changesDirOf(root), { withFileTypes: true }).catch(() => []))
    .filter((d) => d.isDirectory() && d.name !== "archive")
    .map((d) => d.name)
    .sort();
  for (const change of changes) {
    const files = (await readdir(join(changesDirOf(root), change, "stage")).catch(() => []))
      .filter((f) => f.endsWith(".yaml"))
      .sort();
    for (const f of files) {
      let loop: StageLoop;
      try {
        const r = StageLoop.safeParse(
          parse(await readFile(join(changesDirOf(root), change, "stage", f), "utf8")),
        );
        if (!r.success) continue;
        loop = r.data;
      } catch {
        continue;
      }
      for (const w of loop.waiting ?? [])
        out.push({ change, stage: loop.stage, ...w, rerun: rerunOf(loop.stage, change) });
    }
  }
  return out;
}
