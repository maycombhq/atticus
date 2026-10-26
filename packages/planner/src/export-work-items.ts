import {
  criteriaFor,
  foldWords,
  partsOf,
  taskLabel,
  type DraftedStories,
} from "./stages/stories.js";

/**
 * A change's stories and tasks as work items (ADR 0124 addendum B-short), in no tracker's shape:
 * a story with its statement, context and criteria, each task under it with its steps, places,
 * fields, criteria and prompt file. The adapters write them in a tracker's import format
 * (`workItemsCsv` in `@maycombhq/adapters`), for a tracker Atticus has no API for. From the files
 * only: no model, no network.
 */

export interface WorkItemTask {
  /** The task's number as people see it (1.1, 1.2, 2.1). */
  label: string;
  title: string;
  steps: string[];
  places: string[];
  fields: string[];
  criteria: string[];
  /** The prompt file, relative to the change folder. */
  prompt: string;
  /** How to run it: `atticus task <change> <n>`. */
  run: string;
}

export interface WorkItemStory {
  id: string;
  title: string;
  statement: string;
  context?: string;
  change: string;
  repo: string;
  flow: string;
  /** The story file, relative to the change folder. */
  file: string;
  criteria: string[];
  tasks: WorkItemTask[];
}

const sentence = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);
const VERB = { add: "Add", change: "Change", remove: "Remove" } as const;

/** The change's stories as work items, each with its tasks in order. */
export function workItemsOf(d: DraftedStories): WorkItemStory[] {
  const change = d.change.id;
  return d.stories.map((s) => {
    const words = d.answer.stories.find((x) => x.id === s.id);
    const w = words ? foldWords(s, words) : undefined;
    return {
      id: s.id,
      title: w?.title ?? s.name,
      statement: w
        ? `As ${/^[aeiou]/i.test(w.asA) ? "an" : "a"} ${w.asA} I want ${w.iWant} so that ${sentence(w.soThat)}`
        : s.name,
      ...(w?.context ? { context: w.context } : {}),
      change,
      repo: s.repo,
      flow: s.flow,
      file: `stories/${s.id}.md`,
      criteria: s.tasks.flatMap((t) =>
        (w?.tasks.find((x) => x.id === t.id)?.criteria ?? []).map((c) => sentence(c.text)),
      ),
      tasks: s.tasks.map((t) => {
        const label = taskLabel(s, t);
        return {
          label,
          title: t.title,
          steps: partsOf(t).map((x) =>
            sentence(`${VERB[x.op]} the ${x.kind ?? "step"} step: ${x.what}`),
          ),
          places: [
            ...new Set(
              partsOf(t).flatMap((x) => (x.newFile ? [`${x.newFile} (new file)`] : x.evidence)),
            ),
          ],
          fields: t.fields,
          criteria: w ? criteriaFor(w, t.id).map((c) => sentence(c.text)) : [],
          prompt: `tasks/${label}.prompt.md`,
          run: `atticus task ${change} ${label}`,
        };
      }),
    };
  });
}
