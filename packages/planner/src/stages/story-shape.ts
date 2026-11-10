import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { writeFileAtomic } from "@maycombhq/changes";
import { slug } from "../words.js";
import {
  lastPart,
  readStoryNumbers,
  storyNumber,
  withStoriesLock,
  writeStoryNumbers,
  type StoryNumbers,
} from "./numbers.js";
import type { DeltaStory, DeltaTask } from "./stories.js";

/**
 * "The BA shapes, the AI re-checks" (ADR 0191). The stories are worked out from the target flows,
 * one per repo and flow. The business analyst can rename a story, split one into several, merge
 * several into one, or add one, in plain words. Atticus keeps what they did in
 * `stage/stories-shape.yaml` (its own state, beside the loop files; it rides with the hand-off),
 * and the stories stage applies it to the stories it works out:
 *
 * - a rename keeps the story's number and its tasks; its name is the story's title;
 * - a merge keeps the first story's number and gives it every task of the others;
 * - a split keeps the story's number for its first part, and each other part gets the next free
 *   number (reserved in stage/stories-numbers.yaml when the split is recorded, so it never moves);
 * - an added story gets the next free number and starts with no task.
 *
 * The AI then maps the tasks to the stories: at the next draft it puts each task under the story
 * it belongs to (a task may move between stories of its repo that the shaping touched), and that
 * mapping is kept here (`assigned`) for every later run. A task moved to another story takes the
 * next free task number there, kept here too (`labels`), so it keeps it. The stage's check, and the
 * critic's tasks-cover-stories at the plan gate, say what is left uncovered: a story with no task,
 * or a task no story has.
 */

export const SHAPE_FILE = "stage/stories-shape.yaml";

/** The repo a reserved number of an added story is kept under, until a task gives it its repo. */
const SHAPED_REPO = "shaped";

const Id = z.string().trim().min(1);
const Words = z.string().trim().min(1);

export const ShapeEntry = z.strictObject({
  id: z.string().regex(/^sh-\d+$/),
  op: z.enum(["rename", "split", "merge", "add"]),
  story: Id.optional(),
  stories: z.array(Id).min(2).optional(),
  name: Words,
  words: Words.optional(),
  parts: z.array(z.strictObject({ id: Id, name: Words, words: Words.optional() })).optional(),
  added: Id.optional(),
  by: Id,
  at: Id,
  /** When a draft of the stories applied it. */
  applied: Id.optional(),
});
export type ShapeEntry = z.infer<typeof ShapeEntry>;

export const StoriesShape = z.strictObject({
  schemaVersion: z.literal(1),
  entries: z.array(ShapeEntry).default([]),
  /** Each moved task's story, as the AI mapped it, by task id. */
  assigned: z.record(z.string(), z.string()).default({}),
  /** A moved task's number in its new story, by task id. */
  labels: z.record(z.string(), z.string()).default({}),
});
export type StoriesShape = z.infer<typeof StoriesShape>;

const EMPTY: StoriesShape = { schemaVersion: 1, entries: [], assigned: {}, labels: {} };

export async function readShape(dir: string): Promise<StoriesShape> {
  const t = await readFile(join(dir, ...SHAPE_FILE.split("/")), "utf8").catch(() => undefined);
  if (t === undefined) return { ...EMPTY };
  const r = StoriesShape.safeParse(parse(t));
  return r.success ? r.data : { ...EMPTY };
}

export async function writeShape(dir: string, s: StoriesShape): Promise<void> {
  await writeFileAtomic(
    join(dir, ...SHAPE_FILE.split("/")),
    `# The business analyst's shaping of this change's stories, and how the AI mapped the tasks to them (ADR 0191). Atticus writes this file.\n${stringify(
      StoriesShape.parse(s),
      { lineWidth: 0 },
    )}`,
  );
}

export class ShapeError extends Error {
  constructor(
    readonly code: "not-found" | "refused",
    message: string,
  ) {
    super(message);
  }
}

export interface ShapeRequest {
  op: ShapeEntry["op"];
  story?: string;
  stories?: string[];
  name: string;
  words?: string;
  parts?: { name: string; words?: string }[];
}

/** The stories a change has: the kept numbers' (drafted) and those a shaping added. */
function knownStories(n: StoryNumbers, s: StoriesShape): Set<string> {
  return new Set([
    ...n.stories.map((x) => x.id),
    ...s.entries.flatMap((e) => [
      ...(e.parts ?? []).map((p) => p.id),
      ...(e.added ? [e.added] : []),
    ]),
  ]);
}

/** The stories a shaping merged away: no longer a story to name. */
function mergedAway(s: StoriesShape): Set<string> {
  return new Set(s.entries.flatMap((e) => (e.op === "merge" ? (e.stories ?? []).slice(1) : [])));
}

/**
 * Record a business analyst's rename, split, merge or added story. The stories must have been
 * drafted (the numbers kept), every story named must be one of them, and a new story takes the
 * next free number, reserved at once in the numbers file so it is never given to another.
 */
export function recordShape(
  dir: string,
  req: ShapeRequest,
  o: { by: string; at: string },
): Promise<{ shape: StoriesShape; entry: ShapeEntry }> {
  // ADR 0191 review: read, changed and written while no draft of the stories writes them.
  return withStoriesLock(dir, () => record(dir, req, o));
}

async function record(
  dir: string,
  req: ShapeRequest,
  o: { by: string; at: string },
): Promise<{ shape: StoriesShape; entry: ShapeEntry }> {
  const numbers = await readStoryNumbers(dir);
  if (!numbers?.stories.length)
    throw new ShapeError(
      "refused",
      "The stories aren't drafted yet: draft them first, then rename, split, merge or add one.",
    );
  const shape = await readShape(dir);
  const known = knownStories(numbers, shape);
  const gone = mergedAway(shape);
  const need = (id: string | undefined, what: string) => {
    if (!id) throw new ShapeError("refused", `Say which story to ${what}.`);
    if (!known.has(id) || gone.has(id))
      throw new ShapeError("not-found", `There is no story ${id} on this change.`);
    return id;
  };
  let next = Math.max(
    0,
    ...numbers.stories.map((x) => storyNumber(x.id)),
    ...[...known].map(storyNumber),
  );
  const fresh = (name: string) => `s${++next}-${slug(name).slice(0, 40) || "story"}`;
  const id = `sh-${Math.max(0, ...shape.entries.map((e) => Number(e.id.slice(3)))) + 1}`;
  const base = {
    id,
    op: req.op,
    name: req.name.trim(),
    ...(req.words?.trim() ? { words: req.words.trim() } : {}),
    by: o.by.replace(/^@/, ""),
    at: o.at,
  };
  let entry: ShapeEntry;
  const reserve: StoryNumbers["stories"] = [];
  // An added story has no repo until the AI gives it a task (its number is kept as "shaped's").
  const repoOf = (story: string) => {
    const r = numbers.stories.find((x) => x.id === story)?.repo;
    return r === SHAPED_REPO ? undefined : r;
  };
  if (req.op === "rename") entry = { ...base, story: need(req.story, "rename") };
  else if (req.op === "merge") {
    const ids = [...new Set(req.stories ?? [])];
    if (ids.length < 2) throw new ShapeError("refused", "Name two or more stories to merge.");
    ids.forEach((s) => need(s, "merge"));
    const repos = new Set(ids.map(repoOf).filter(Boolean));
    if (repos.size > 1)
      throw new ShapeError(
        "refused",
        `A story is one repo's work: ${ids.join(", ")} are in ${[...repos].join(" and ")}. Merge stories of one repo.`,
      );
    entry = { ...base, stories: ids };
  } else if (req.op === "split") {
    const story = need(req.story, "split");
    const parts = (req.parts ?? []).filter((p) => p.name.trim());
    if (!parts.length)
      throw new ShapeError("refused", "Name the other part (or parts) the story is split into.");
    entry = {
      ...base,
      story,
      parts: parts.map((p) => ({
        id: fresh(p.name),
        name: p.name.trim(),
        ...(p.words?.trim() ? { words: p.words.trim() } : {}),
      })),
    };
    for (const p of entry.parts!)
      reserve.push({
        repo: repoOf(story) ?? SHAPED_REPO,
        flow: `shape:${id}:${p.id}`,
        id: p.id,
        tasks: [],
      });
  } else {
    entry = { ...base, added: fresh(req.name) };
    reserve.push({ repo: SHAPED_REPO, flow: `shape:${id}`, id: entry.added!, tasks: [] });
  }
  const next_ = { ...shape, entries: [...shape.entries, ShapeEntry.parse(entry)] };
  await writeShape(dir, next_);
  if (reserve.length)
    await writeStoryNumbers(dir, { ...numbers, stories: [...numbers.stories, ...reserve] });
  return { shape: next_, entry };
}

/**
 * Take back a shaping no draft has applied yet. One a draft applied stays on file (a later one
 * changes it); its reserved numbers stay used, never given again.
 */
export function removeShape(dir: string, entryId: string): Promise<StoriesShape> {
  return withStoriesLock(dir, () => unrecord(dir, entryId));
}

async function unrecord(dir: string, entryId: string): Promise<StoriesShape> {
  const shape = await readShape(dir);
  const e = shape.entries.find((x) => x.id === entryId);
  if (!e) throw new ShapeError("not-found", `There is no shaping ${entryId} on this change.`);
  if (e.applied)
    throw new ShapeError(
      "refused",
      `${entryId} is in the stories since ${e.applied}: rename, split or merge again to change it.`,
    );
  const next = { ...shape, entries: shape.entries.filter((x) => x !== e) };
  await writeShape(dir, next);
  return next;
}

/** The stories a shaping touched: a task may move between them. */
function shapedIds(shape: StoriesShape): Set<string> {
  return new Set(
    shape.entries.flatMap((e) => [
      ...(e.story ? [e.story] : []),
      ...(e.stories ?? []),
      ...(e.parts ?? []).map((p) => p.id),
      ...(e.added ? [e.added] : []),
    ]),
  );
}

export interface Shaped {
  stories: DeltaStory[];
  /** The BA's name for each story they named, by story id: the story's title. */
  names: Map<string, string>;
  /** What the BA said each new or split story is for, by story id. */
  words: Map<string, string>;
  /** Moved task numbers, by task id (kept in the shape file). */
  labels: Record<string, string>;
  /** Each moved task's story, by task id. */
  assigned: Record<string, string>;
  /** Stories merged away, to the story they went into. */
  merged: Map<string, string>;
}

const storyNo = (id: string) => /^s(\d+)-/.exec(id)?.[1] ?? "1";

/**
 * The stories with the shaping applied, and the tasks where the AI mapped them: `assign` is a
 * draft's own mapping (task id → story id), else the one kept from the last draft. A task moves
 * only to a story of its repo that the shaping touched (a split's part, an added story, a merged
 * one, or back); anything else is left where it was, and `shapeIssues` says so.
 */
export function applyShape(
  base: readonly DeltaStory[],
  shape: StoriesShape,
  assign?: Readonly<Record<string, string>>,
  numbers?: StoryNumbers,
): Shaped {
  const stories: DeltaStory[] = base.map((s) => ({ ...s, tasks: [...s.tasks] }));
  const names = new Map<string, string>();
  const words = new Map<string, string>();
  const merged = new Map<string, string>();
  if (!shape.entries.length) return { stories, names, words, labels: {}, assigned: {}, merged };
  const byId = () => new Map(stories.map((s) => [s.id, s]));
  // A story the BA added has no repo of its own until it holds a task (it took the last story's).
  const unplaced = (s: DeltaStory) => !s.tasks.length && !base.some((b) => b.id === s.id);
  for (const e of shape.entries) {
    const at = byId();
    if (e.op === "rename" && e.story && at.has(merged.get(e.story) ?? e.story)) {
      const s = at.get(merged.get(e.story) ?? e.story)!;
      names.set(s.id, e.name);
      s.name = e.name;
    }
    if (e.op === "merge" && e.stories) {
      const [first, ...rest] = e.stories.map((x) => merged.get(x) ?? x);
      const into = at.get(first!);
      if (!into) continue;
      names.set(into.id, e.name);
      into.name = e.name;
      for (const id of rest) {
        const from = at.get(id);
        if (!from || from === into) continue;
        // ADR 0191 review: an added story merges with a story of any repo, and takes its repo.
        if (from.repo !== into.repo && unplaced(into)) {
          into.repo = from.repo;
          into.flow = from.flow;
          into.change = from.change;
        }
        if (from.repo !== into.repo && !unplaced(from)) continue;
        into.tasks.push(...from.tasks.map((t) => ({ ...t, story: into.id })));
        into.dependsOn = [...new Set([...(into.dependsOn ?? []), ...(from.dependsOn ?? [])])];
        stories.splice(stories.indexOf(from), 1);
        merged.set(id, into.id);
      }
    }
    if (e.op === "split" && e.story) {
      const from = at.get(merged.get(e.story) ?? e.story);
      if (!from) continue;
      names.set(from.id, e.name);
      from.name = e.name;
      if (e.words) words.set(from.id, e.words);
      let k = stories.indexOf(from);
      for (const p of e.parts ?? []) {
        names.set(p.id, p.name);
        if (p.words) words.set(p.id, p.words);
        stories.splice(++k, 0, {
          ...from,
          id: p.id,
          name: p.name,
          tasks: [],
          ...(from.dependsOn ? { dependsOn: [...from.dependsOn] } : {}),
        });
      }
    }
    if (e.op === "add" && e.added) {
      names.set(e.added, e.name);
      if (e.words) words.set(e.added, e.words);
      const like = stories.at(-1);
      stories.push({
        id: e.added,
        repo: like?.repo ?? "",
        flow: like?.flow ?? "",
        name: e.name,
        change: like?.change ?? "modify",
        tasks: [],
      });
    }
  }
  for (const s of stories)
    if (s.dependsOn)
      s.dependsOn = [...new Set(s.dependsOn.map((d) => merged.get(d) ?? d))].filter(
        (d) => d !== s.id,
      );
  // The tasks, where the AI mapped them.
  const touched = shapedIds(shape);
  for (const [k, v] of merged) if (touched.has(k)) touched.add(v);
  const want = assign ?? shape.assigned;
  const assigned: Record<string, string> = {};
  const labels: Record<string, string> = {};
  const order = new Map(base.flatMap((s) => s.tasks).map((t, i) => [t.id, i]));
  for (const [taskId, storyId0] of Object.entries(want)) {
    const storyId = merged.get(storyId0) ?? storyId0;
    const at = byId();
    const to = at.get(storyId);
    const from = stories.find((s) => s.tasks.some((t) => t.id === taskId));
    if (!to || !from || from === to) continue;
    if (!touched.has(to.id) && !touched.has(from.id)) continue;
    const t = from.tasks.find((x) => x.id === taskId)!;
    // An added story takes the repo of the first task it is given.
    if (!to.tasks.length && !base.some((b) => b.id === to.id) && to.repo !== t.repo) {
      to.repo = t.repo;
      to.flow = t.flow;
    }
    if (to.repo !== t.repo) continue;
    from.tasks.splice(from.tasks.indexOf(t), 1);
    to.tasks.push({ ...t, story: to.id });
    to.tasks.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    assigned[taskId] = to.id;
  }
  // A moved task keeps the number it was given in its new story; a newly moved one takes the
  // story's next free number. A task back in its own story has its own number again.
  // ADR 0191 review: every number in a story is one task's. A task of the story keeps the number
  // the numbers gave it (whatever moved out before it); a moved task's kept number that one of the
  // story's own tasks now has is given up for the next free one; and the next free number is
  // after every number the story has used, a removed task's too (the numbers file), so none is
  // given twice or given again.
  const usedOf = new Map((numbers?.stories ?? []).map((x) => [x.id, x.tasks.map((t) => t.label)]));
  for (const s of stories) {
    const own = base.find((b) => b.id === s.id);
    const n = storyNo(s.id);
    const ownLabel = new Map((own?.tasks ?? []).map((t, i) => [t.id, t.label ?? `${n}.${i + 1}`]));
    const taken = new Set(
      s.tasks.flatMap((t) => (ownLabel.has(t.id) ? [ownLabel.get(t.id)!] : [])),
    );
    const used = [
      ...ownLabel.values(),
      ...(usedOf.get(s.id) ?? []),
      ...Object.values(shape.labels).filter((l) => l.startsWith(`${n}.`)),
    ];
    let last = Math.max(0, ...used.map(lastPart));
    s.tasks = s.tasks.map((t, i): DeltaTask => {
      const mine = ownLabel.get(t.id);
      if (mine !== undefined) {
        if (mine === `${n}.${i + 1}`) {
          if (t.label === undefined) return t;
          const { label: _drop, ...rest } = t;
          return rest;
        }
        return t.label === mine ? t : { ...t, label: mine };
      }
      const kept = shape.labels[t.id];
      const label = kept?.startsWith(`${n}.`) && !taken.has(kept) ? kept : `${n}.${++last}`;
      taken.add(label);
      labels[t.id] = label;
      return { ...t, label };
    });
  }
  return { stories, names, words, labels, assigned, merged };
}

/**
 * The mapping a draft gives: each task the answer lists under another story than the one it is
 * in now, where that story is one the shaping touched (or the task's is). An answer that keeps
 * every task where it was maps nothing new.
 */
export function assignFromAnswer(
  answer: { stories: { id: string; tasks: { id: string }[] }[] },
  shaped: readonly DeltaStory[],
  shape: StoriesShape,
): Record<string, string> {
  const out: Record<string, string> = { ...shape.assigned };
  if (!shape.entries.length) return out;
  const touched = shapedIds(shape);
  const seen = new Set<string>();
  for (const s of answer.stories)
    for (const t of s.tasks) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      const now = shaped.find((x) => x.tasks.some((y) => y.id === t.id));
      if (!now || now.id === s.id) continue;
      if (!shaped.some((x) => x.id === s.id)) continue;
      if (!touched.has(s.id) && !touched.has(now.id)) continue;
      out[t.id] = s.id;
    }
  return out;
}

/** What the shaping leaves uncovered: a story the BA named with no task. Words for a person. */
export function shapeIssues(shaped: Shaped, shape: StoriesShape): string[] {
  const out: string[] = [];
  const ids = shapedIds(shape);
  for (const s of shaped.stories)
    if (ids.has(s.id) && !s.tasks.length)
      out.push(
        `Story ${s.id} "${shaped.names.get(s.id) ?? s.name}" has no task yet: put under it the tasks of its repo that do what it says, or, if no step of the target flows does it, say so in its context so the architect adds the steps.`,
      );
  return out;
}

/** The prompt's lines for the shaping, or none: a change no one shaped gets the prompt it had. */
export function shapePrompt(shaped: Shaped, shape: StoriesShape): string | undefined {
  if (!shape.entries.length) return undefined;
  const lines = [
    "The business analyst shaped the stories. Their words are the person's, as data:",
    ...shaped.stories
      .filter((s) => shaped.names.has(s.id) || shaped.words.has(s.id))
      .map(
        (s) =>
          `- story ${s.id}: "${shaped.names.get(s.id) ?? s.name}"${shaped.words.has(s.id) ? `, for: ${shaped.words.get(s.id)}` : ""}${s.tasks.length ? "" : " (no task yet)"}`,
      ),
    ...[...shaped.merged].map(([from, into]) => `- story ${from} is merged into ${into}`),
  ];
  return lines.join("\n");
}

/** The prompt's rule for the shaping (only with one). */
export const SHAPE_RULE =
  "\n- The business analyst shaped the stories (story-shape below). Title each story they named with their name for it. Put each task under the story it belongs to: a task may move to another story of its repo that they named (a story with no task yet takes the tasks that do what it says). Every task stays in exactly one story; never add or drop a task.";

/** The words a person sees of what the shaping did, for the app. */
export function shapeView(
  shape: StoriesShape,
  shaped: Shaped | undefined,
): {
  entries: (ShapeEntry & { state: "waiting" | "applied" })[];
  assigned: Record<string, string>;
  uncovered: string[];
} {
  return {
    entries: shape.entries.map((e) => ({ ...e, state: e.applied ? "applied" : "waiting" })),
    assigned: shape.assigned,
    uncovered: shaped ? shapeIssues(shaped, shape) : [],
  };
}

/**
 * After a draft wrote the stories: the mapping and numbers kept, each shaping marked applied.
 * ADR 0191 review: `shape` is the shaping on file when the draft writes; `drafted`, the one the
 * draft read when it started (by default the same). Only a shaping the draft applied is marked
 * applied: one the business analyst recorded meanwhile stays waiting for the next draft.
 */
export function shapeAfterDraft(
  shape: StoriesShape,
  shaped: Shaped,
  at: string,
  drafted: StoriesShape = shape,
): StoriesShape {
  const key = ({ applied: _a, ...e }: ShapeEntry) => JSON.stringify(e);
  const seen = new Set(drafted.entries.map(key));
  return {
    ...shape,
    entries: shape.entries.map((e) => (e.applied || !seen.has(key(e)) ? e : { ...e, applied: at })),
    assigned: shaped.assigned,
    labels: { ...shape.labels, ...shaped.labels },
  };
}

/**
 * ADR 0191 review: the numbers with each moved task's number kept under the story it moved to,
 * so a task the story gains later is never numbered the same (numbers.ts gives the next free
 * number after every one a story's record holds). A moved task is kept by its id (`moved <id>`),
 * never a step's identity, so no task of the story takes the number as its own.
 */
export function numbersWithMoved(numbers: StoryNumbers, shaped: Shaped): StoryNumbers {
  return {
    ...numbers,
    stories: numbers.stories.map((x) => {
      const s = shaped.stories.find((y) => y.id === x.id);
      const have = new Set(x.tasks.map((t) => t.label));
      const add = (s?.tasks ?? []).flatMap((t) => {
        const label = shaped.labels[t.id];
        if (!label || have.has(label)) return [];
        have.add(label);
        return [{ label, steps: [`moved ${t.id}`] }];
      });
      return add.length ? { ...x, tasks: [...x.tasks, ...add] } : x;
    }),
  };
}
