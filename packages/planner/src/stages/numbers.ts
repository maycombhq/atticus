import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { writeFileAtomic } from "@maycombhq/changes";
import type { DeltaStep, FlowDelta } from "./schema.js";

/**
 * Stable story and task numbers (review round 50). The stories and tasks are worked out again
 * from the target flows on every run, and were numbered afresh each time: a repo the architecture
 * stage added (forge-gateway, before forge-orders) moved every story and task after it, so a task
 * run kept under tasks/<label>/ belonged to another task, a story file a person edited was
 * replaced under a new name, and a correction or a tick keyed by a label landed on another task.
 *
 * Atticus keeps the numbers it gave in `stage/stories-numbers.yaml`. A story or task that is
 * still there keeps its id and label; a new one gets the next free number after every number the
 * change has used; a removed one leaves a gap, never reused within the change.
 *
 * What makes a story or step the same one (its identity):
 * - a story: the same repo and the same flow (one target flow per flow);
 * - a changed or removed step: it changes or removes the same step of today's flow (its `step`);
 * - an added step: the same kind of step, after the same step of today's flow (`after`, when the
 *   target flow gives it), calling the same component (`to`) or storing in the same table
 *   (`store`), and the n-th such step of its target flow.
 * Its words, fields, place in the code and position in the target flow may change. A task (the
 * steps grouped into one unit) is the same task when it starts with the same step; else when it
 * covers a step a task of the story covered before.
 */

export const NUMBERS_FILE = "stage/stories-numbers.yaml";

const Key = z.string().min(1);
export const StoryNumbers = z.strictObject({
  schemaVersion: z.literal(1),
  /** Each repo's number, the first part of its steps' ids. */
  repos: z.record(z.string(), z.number().int().positive()).default({}),
  /** Each step's id (`<repo>.<n>`), by its identity (`stepKey`). */
  steps: z.record(z.string(), z.string()).default({}),
  stories: z
    .array(
      z.strictObject({
        repo: Key,
        flow: Key,
        id: Key,
        tasks: z.array(z.strictObject({ label: Key, steps: z.array(Key).min(1) })).default([]),
      }),
    )
    .default([]),
});
export type StoryNumbers = z.infer<typeof StoryNumbers>;

/** A story's identity: its repo and flow. */
export const storyKey = (repo: string, flow: string) => `${repo} ${flow}`;

/** An added step's identity before its ordinal; a changed or removed step's, today's number. */
function baseKey(s: DeltaStep): string {
  if (s.op !== "add") return `${s.op} ${s.step ?? "?"}`;
  return [
    `add ${s.kind ?? "step"}`,
    ...(s.after !== undefined ? [`after ${s.after}`] : []),
    ...(s.to ? [`to ${s.to.component}`] : []),
    ...(s.store ? [`in ${s.store.table}`] : []),
  ].join(" ");
}

/** Each step's identity, in the delta's order: `<repo> <flow> <base>#<n>`. */
export function stepKeys(d: FlowDelta): string[] {
  const seen = new Map<string, number>();
  return d.steps.map((s) => {
    const b = baseKey(s);
    const n = (seen.get(b) ?? 0) + 1;
    seen.set(b, n);
    return `${d.repo} ${d.flow} ${b}#${n}`;
  });
}

/** The change's kept numbers, or undefined (a change drafted before they were kept, or none). */
export async function readStoryNumbers(dir: string): Promise<StoryNumbers | undefined> {
  const t = await readFile(join(dir, ...NUMBERS_FILE.split("/")), "utf8").catch(() => undefined);
  if (t === undefined) return undefined;
  try {
    const r = StoryNumbers.safeParse(parse(t));
    return r.success ? r.data : undefined;
  } catch {
    return undefined;
  }
}

export async function writeStoryNumbers(dir: string, n: StoryNumbers): Promise<void> {
  await writeFileAtomic(
    join(dir, ...NUMBERS_FILE.split("/")),
    `# The numbers Atticus gave this change's stories and tasks, so a rerun keeps them (review round 50).\n${stringify(
      StoryNumbers.parse(n),
      { lineWidth: 0 },
    )}`,
  );
}

/** The highest number used: a story's (`s<n>-`), a step's within a repo, a task's within a story. */
export const storyNumber = (id: string) => Number(/^s(\d+)-/.exec(id)?.[1] ?? 0);
export const lastPart = (id: string) => Number(/\.(\d+)$/.exec(id)?.[1] ?? 0);
