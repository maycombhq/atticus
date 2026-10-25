import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import {
  answerWords,
  changesRelOf,
  fileJudgments,
  judgmentKey,
  makeJudgment,
  overrideJudgment,
  QuestionDraft,
  quotedIn,
  raiseQuestions,
  readQuestion,
  retireQuestion,
  type JudgmentStore,
  type Question,
  type CatalogRecord,
  type ChangeLifecycle,
  type RecordOf,
} from "@maycombhq/core";
import {
  APPLIES_SPEC,
  judgesDirectly,
  COVERS_FIELD_SPEC,
  judge,
  settle,
  type AiRuntime,
  type JudgeItem,
  type JudgeOptions,
  type JudgeSpec,
  type SourceInput,
} from "@maycombhq/ai";
import {
  changeFolder,
  changeFootprint,
  changeStore,
  loadChangeContext,
  scoreRisk,
  testsFor,
  writeFileAtomic,
  type ChangeContext,
} from "@maycombhq/changes";
import { readKnowledge } from "@maycombhq/knowledge";
import { mergeStoryRequests } from "../needs.js";
import { PlannerError } from "../errors.js";
import { instructionSource, wholeLists, type ContextReport } from "../engine.js";
import { recordKnowledge } from "./knowledge-applies.js";
import { estateContext } from "./estate-context.js";
import { GENERATED_MARK } from "../render.js";
import { slug } from "../words.js";
import { parseYamlAs } from "./answer.js";
import { isEmptyDelta, readDeltas, TARGET_DIR } from "./architecture.js";
import {
  allowedValuesSource,
  columnsOf,
  endpointKey,
  endpointsFor,
  estateIndex,
  loadEstate,
  schemaFieldsOf,
  triggerEntry,
  type Estate,
} from "./estate.js";
import { mergeDelta } from "./merge.js";
// A cycle (task-context reads the stories), safe: only functions are used, and only when called.
import { migrationPath } from "../task-context.js";
import {
  issueFingerprint,
  runStageLoop,
  SELF_CHECK_RULE,
  stageBudget,
  type StageIssue,
  type StageOptions,
  type StageResult,
  type StageSpec,
  refuseWhileEarlierStuck,
  retrievalWaiting,
  stageRetrievalAi,
  withoutResume,
} from "./loop.js";
import {
  fieldNames,
  StageLoop,
  type DeltaStep,
  type FlowDelta,
  type LoopFinding,
} from "./schema.js";

/**
 * `atticus plan stories <change>` on a change with target flows (ADR 0087, plan 4.4): stories
 * per repo from the flow deltas, one per flow, and a task per changed step, each with the
 * fields and evidence it touches and the prompt to implement it in Copilot or Claude Code.
 * Which stories and tasks there are is decided from the deltas, without AI; the assistant
 * words them and writes each task's acceptance criteria, saying which fields each criterion
 * checks. The change tasks and service requests the change needs come from the knowledge items
 * (ADR 0083): the story writer names each one a step meets, quoting the words of its "applies
 * when", and where the runtime calls a model directly a judge asks of every other step and
 * process whether it applies (ADR 0117). A person raises them; Atticus never does.
 */

export const STORY_AGENT = "story-writer-flows";
export const ANSWER_FILE = "stage/stories-answer.yaml";

type Process = RecordOf<"ProcessDefinition">;

export interface DeltaTask {
  id: string;
  story: string;
  repo: string;
  flow: string;
  op: DeltaStep["op"];
  /** The step's position in the delta's list, from 1. */
  position: number;
  kind?: string;
  title: string;
  what: string;
  fields: string[];
  /** Where today's code is: repo:path:line. */
  evidence: string[];
  target?: string;
  store?: string;
  /** call-out and publish: the entry it goes to, as the target flow writes it. */
  to?: { component: string; entry: string; new: boolean };
  /** A store step that adds columns or a table: what the target flow says of them (B-stories). */
  data?: TaskData;
}

/** The columns a store step adds, with what the target flow says of each. */
export interface TaskData {
  table: string;
  /** A table the change adds. */
  new: boolean;
  /** The columns the step adds (all of a new table's). */
  added: string[];
  types: Record<string, string>;
  classification: Record<string, string>;
  migration?: string;
  /** The migration's file in the repo, in the folder its store's migrations are in. */
  migrationFile?: string;
  retention?: string;
}

export interface DeltaStory {
  id: string;
  repo: string;
  flow: string;
  name: string;
  change: FlowDelta["change"];
  tasks: DeltaTask[];
  /** The entry that starts the flow: today's trigger endpoint, or a new flow's trigger entry. */
  entry?: string;
  /** Today's flow, a numbered line per step with its citations (Context). */
  before?: string[];
  /** The flow once the change is in, each changed step saying which task changes it. */
  after?: string[];
  /** Today's error paths, which the change passes through (Context). */
  errors?: string[];
  /** The steps of today's flow that stay as they are, by their target numbers (Scope: out). */
  kept?: number[];
  /** Stories of this change that land first: one adds an entry or table this one uses. */
  dependsOn?: string[];
}

export interface RequestTask {
  id: string;
  item: string;
  title: string;
  processKind: "process" | "request";
  flow: string;
  step: number;
  stepWhat: string;
  why: string;
  /** The story writer named it, or a judge found it applies (ADR 0117). */
  by: "assistant" | "judge";
  quote: Process["quote"];
  leadTime?: string;
  handledBy?: string;
  catalogueItem?: string;
}

const ev = (repo: string, e: { path?: string; line?: number }[]) =>
  e.filter((x) => x.path).map((x) => `${repo}:${x.path}${x.line ? `:${x.line}` : ""}`);

/**
 * Stories and tasks from the deltas, deterministically. A modify delta with no step is
 * context, not a change, so it gets no story (a story with no task has nothing to accept).
 */
export function storiesFromDeltas(all: FlowDelta[], e: Estate): DeltaStory[] {
  const deltas = all.filter((d) => !isEmptyDelta(d));
  const repos = [...new Set(deltas.map((d) => d.repo))].sort();
  const stories: DeltaStory[] = [];
  const counter = new Map<string, number>();
  let k = 0;
  for (const repo of repos)
    for (const d of deltas.filter((x) => x.repo === repo)) {
      const today = e.flowById.get(d.flow)?.flow;
      const name = d.name ?? today?.name ?? d.flow;
      const id = `s${++k}-${slug(d.flow.split(".").slice(1).join("-") || d.flow).slice(0, 40)}`;
      const tasks: DeltaTask[] = [];
      d.steps.forEach((s, i) => {
        const old = s.step ? today?.steps[s.step - 1] : undefined;
        const at = s.op === "add" ? (s.after ? today?.steps[s.after - 1] : undefined) : old;
        const evidence = at
          ? ev(d.repo, at.evidence)
          : s.op === "add" && s.after === 0 && today
            ? ev(d.repo, today.trigger.evidence)
            : [];
        const what = s.what ?? old?.what ?? "";
        const fields = [...new Set([...fieldNames(s.fields), ...(s.store?.columns ?? [])])];
        const n = (counter.get(repo) ?? 0) + 1;
        counter.set(repo, n);
        const verb = s.op === "add" ? "Add" : s.op === "change" ? "Change" : "Remove";
        const data = taskData(s, e);
        tasks.push({
          id: `${repos.indexOf(repo) + 1}.${n}`,
          story: id,
          repo,
          flow: d.flow,
          op: s.op,
          position: i + 1,
          ...((s.kind ?? old?.kind) ? { kind: s.kind ?? old!.kind } : {}),
          title: `${verb} the ${s.kind ?? old?.kind ?? "step"} step: ${what}`.replace(
            /[.\s]+$/,
            "",
          ),
          what,
          fields,
          evidence: evidence.length
            ? evidence
            : d.change === "new"
              ? []
              : ev(d.repo, today?.trigger.evidence ?? []),
          ...(s.to ? { target: `${s.to.component} ${s.to.entry}${s.to.new ? " (new)" : ""}` } : {}),
          ...(s.store
            ? {
                store: `${s.store.table}${s.store.new ? " (new)" : ""}: ${s.store.columns.join(", ")}`,
              }
            : {}),
          ...(s.to ? { to: { component: s.to.component, entry: s.to.entry, new: s.to.new } } : {}),
          ...(data ? { data } : {}),
        });
      });
      stories.push({
        id,
        repo,
        flow: d.flow,
        name,
        change: d.change,
        tasks,
        ...storyContext(d, tasks, e),
      });
    }
  // A story that calls an entry, or uses a table, another story of the change adds lands after it.
  const tableOf = (t: DeltaTask) => t.store?.split(/[\s:]/)[0];
  const adds = (o: DeltaStory, t: DeltaTask) =>
    (t.to?.new &&
      o.change === "new" &&
      o.entry !== undefined &&
      o.flow.split(".")[0] === t.to.component &&
      endpointKey(o.entry) === endpointKey(t.to.entry)) ||
    (!t.data?.new && o.tasks.some((x) => x.data?.new && x.data.table === tableOf(t)));
  for (const s of stories)
    s.dependsOn = stories
      .filter((o) => o !== s && s.tasks.some((t) => adds(o, t)))
      .map((o) => o.id);
  return stories;
}

/** The columns a store step adds, or undefined when it adds none (B-stories). */
function taskData(s: DeltaStep, e: Estate): TaskData | undefined {
  if (!s.store || s.op === "remove") return undefined;
  const have = columnsOf(e, s.store.table);
  const added = s.store.new ? s.store.columns : s.store.columns.filter((c) => !have.has(c));
  if (!added.length && !s.store.new) return undefined;
  return {
    table: s.store.table,
    new: s.store.new,
    added,
    types: s.store.types ?? {},
    classification: s.store.classification ?? {},
    ...(s.store.migration
      ? {
          migration: s.store.migration,
          migrationFile: migrationPath(s.store.migration, s.store.table, e),
        }
      : {}),
    ...(s.store.retention ? { retention: s.store.retention } : {}),
  };
}

const cites = (repo: string, at: { path?: string; line?: number }[]) => {
  const c = ev(repo, at);
  return c.length ? ` (${c.join(", ")})` : "";
};

/**
 * The story's context from the map and the target flow (B-stories): its entry, today's flow and
 * error paths with their citations, the flow once the change is in, and the steps it keeps.
 */
function storyContext(
  d: FlowDelta,
  tasks: DeltaTask[],
  e: Estate,
): Pick<DeltaStory, "entry" | "before" | "after" | "errors" | "kept"> {
  const today = e.flowById.get(d.flow);
  const entry = today ? triggerEntry(today, e) : d.trigger?.entry;
  const merged = mergeDelta(d, today?.flow);
  const taskOf = (n?: number) => tasks.find((t) => t.position === n)?.id;
  const after = merged.steps
    .filter((s) => s.target !== undefined)
    .map((s) => {
      const t = taskOf(s.change);
      const mark =
        s.mark === "added"
          ? `, added by task ${t}`
          : s.mark === "changed"
            ? `, changed by task ${t}`
            : "";
      return `${s.target}. ${s.kind}${mark}: ${s.what}`.replace(/[.\s]+$/, "");
    });
  for (const s of merged.steps.filter((x) => x.mark === "removed" && x.change))
    after.push(
      `Removed by task ${taskOf(s.change)}: ${s.what.replace(/[.\s]+$/, "")} (today's step ${s.today})`,
    );
  const kept = merged.steps.filter((s) => s.mark === "same" && s.target).map((s) => s.target!);
  return {
    ...(entry ? { entry } : {}),
    ...(today
      ? {
          before: today.flow.steps.map(
            (s, i) =>
              `${i + 1}. ${s.kind}: ${s.what.replace(/[.\s]+$/, "")}${cites(today.repo, s.evidence)}`,
          ),
          errors: today.flow.errors.map(
            (x) =>
              `${x.when.replace(/[.\s]+$/, "")}: ${x.then.replace(/[.\s]+$/, "")}${cites(today.repo, x.evidence)}`,
          ),
        }
      : {}),
    after,
    kept,
  };
}

/**
 * What the catalog says about a step, for a judge deciding whether a process applies to it:
 * its kind and what it does, where it goes (and whether that is a vendor outside the estate),
 * the table it uses and the columns it adds. Facts, not a match: the model reads them beside
 * the process's applies-when.
 */
export function stepFacts(d: FlowDelta, s: DeltaStep, e: Estate): string[] {
  const today = e.flowById.get(d.flow)?.flow;
  const kind = s.kind ?? (s.step ? today?.steps[s.step - 1]?.kind : undefined);
  const out = [
    `${s.op} a ${kind ?? "step"} step of flow ${d.flow} in repo ${d.repo}: ${s.what ?? ""}`.trim(),
  ];
  if (s.to) {
    const target = e.byId.get(s.to.component) as
      { kind?: string; boundary?: string; system?: string } | undefined;
    const system =
      target?.kind === "System"
        ? target
        : (e.byId.get(target?.system ?? "") as { boundary?: string } | undefined);
    out.push(
      `it goes to ${s.to.component} ${s.to.entry}${s.to.new ? " (new)" : ""}${system?.boundary ? `, whose system's boundary is ${system.boundary}` : ""}`,
    );
  }
  if (s.store) {
    const have = columnsOf(e, s.store.table);
    const added = s.store.new ? s.store.columns : s.store.columns.filter((c) => !have.has(c));
    out.push(
      `it uses table ${s.store.table}${s.store.new ? " (a new table)" : ""}${added.length ? `, adding columns ${added.join(", ")}` : ""}`,
    );
  }
  return out;
}

/** What an applies judgment is about, as hashed into its key. */
const appliesInputs = (d: FlowDelta, i: number, p: Process, facts: string[]) => ({
  v: 1,
  process: p.id,
  appliesWhen: p.appliesWhen,
  flow: d.flow,
  step: i + 1,
  facts,
});

/**
 * The processes and requests a judge says apply to a step the story writer left without one
 * (ADR 0117): a recall check behind the writer's own reading, run where the runtime can call
 * a model directly. Each pair is asked once and kept in judgments/applies/; a hand-off relies
 * on the writer's reading (its prompt lists the processes), so it costs no extra round.
 */
export async function judgedRequests(
  deltas: FlowDelta[],
  e: Estate,
  items: Process[],
  declared: { item: string; flow: string; step: number }[],
  j: Omit<JudgeOptions, "store"> & { store: JudgmentStore },
): Promise<RequestTask[]> {
  const pairs: { d: FlowDelta; i: number; s: DeltaStep; p: Process; item: JudgeItem }[] = [];
  for (const d of deltas)
    d.steps.forEach((s, i) => {
      if (s.op === "remove") return;
      const facts = stepFacts(d, s, e);
      for (const p of items) {
        if (declared.some((x) => x.item === p.id && x.flow === d.flow && x.step === i + 1))
          continue;
        pairs.push({
          d,
          i,
          s,
          p,
          item: {
            inputs: appliesInputs(d, i, p, facts),
            texts: { appliesWhen: p.appliesWhen, step: facts.join("; ") },
          },
        });
      }
    });
  if (!pairs.length) return [];
  const r = await judge(
    APPLIES_SPEC,
    pairs.map((x) => x.item),
    j,
  );
  const out: RequestTask[] = [];
  for (const x of pairs) {
    const v = r.results.get(judgmentKey(APPLIES_SPEC.kind, x.item.inputs));
    if (v?.verdict !== "yes") continue;
    const quote = v.judgment?.quotes.find((q) => q.of === "appliesWhen")?.text;
    out.push(
      requestTask(
        x.p,
        x.d,
        x.i + 1,
        x.s,
        `${v.judgment?.why ?? "The step meets its applies-when."}${quote ? ` ("${quote}")` : ""}`,
        "judge",
      ),
    );
  }
  return out;
}

function requestTask(
  p: Process,
  d: FlowDelta,
  step: number,
  s: DeltaStep,
  why: string,
  by: RequestTask["by"],
): RequestTask {
  return {
    id: "",
    item: p.id,
    title: p.title,
    processKind: p.processKind,
    flow: d.flow,
    step,
    stepWhat: s.what ?? "",
    why,
    by,
    quote: p.quote,
    ...(p.leadTime ? { leadTime: p.leadTime } : {}),
    ...(p.handledBy ? { handledBy: p.handledBy } : {}),
    ...(p.catalogueItem ? { catalogueItem: p.catalogueItem } : {}),
  };
}

/**
 * An acceptance criterion and the fields whose value its then clause asserts (ADR 0117): the
 * story writer says which fields each criterion checks, and Atticus checks the set. A bare
 * string (an answer written before checks) checks nothing.
 */
/** What an error criterion's failure is (the stories bench's rules, bench/stories/rubric.md). */
export const STORY_ERROR_RULES = [
  "required",
  "format",
  "length",
  "range",
  "limit",
  "unique",
  "not-found",
  "forbidden",
  "conflict",
  "unavailable",
  "other",
] as const;

const Words = z.string().trim().min(1);

const CriterionObject = z.strictObject({
  text: Words,
  checks: z.array(Words).default([]),
  /**
   * Whether the criterion is about the step succeeding or failing (ADR 0124, Part 3): a task
   * that validates, writes, calls out or publishes has at least one `error` criterion.
   */
  outcome: z.enum(["success", "error"]).default("success"),
  /** The entry it exercises, as `METHOD /path` or a topic (B-stories). */
  entry: Words.optional(),
  /** The validation it relies on, in words: "cardToken is required". */
  validation: Words.optional(),
  /** An error criterion: what kind of failure it is. */
  rule: z.enum(STORY_ERROR_RULES).optional(),
  /** An error criterion: the status the caller sees, an HTTP status or a code. */
  status: z.union([z.number().int(), Words]).optional(),
});

export const StoryCriterion = z.union([
  Words.transform((text) => CriterionObject.parse({ text })),
  CriterionObject,
]);

/** Step kinds whose task needs an error criterion: what happens when it fails (ADR 0124, Part 3). */
export const NEEDS_ERROR_CASE = ["validate", "write", "call-out", "publish"] as const;
export type StoryCriterion = z.infer<typeof StoryCriterion>;

/** A request the story writer says a step meets, with the words of its applies-when. */
export const RequestIn = z.strictObject({
  item: z.string(),
  flow: z.string(),
  step: z.number().int().positive(),
  why: z.string().trim().min(1),
  /** The words of the item's applies-when the step meets, copied exactly. */
  quote: z.string().trim().min(1).optional(),
});

const Change = z.enum(["added", "changed", "removed"]);

/** A field of an entry whose contract changes (B-stories): side, type, required and default. */
export const StoryInterfaceField = z.strictObject({
  name: Words,
  side: z.enum(["request", "response", "message"]),
  type: Words,
  /** Left out, the story file shows the catalog's (ADR 0125), or says it isn't said. */
  required: z.boolean().optional(),
  default: Words.optional(),
  change: Change,
  /** A request or message field an entry of this repo gains or changes: what it accepts. */
  validation: Words.optional(),
});

/** An entry whose contract changes, and whether that breaks its consumers (B-stories). */
export const StoryInterfaceChange = z.strictObject({
  /** `METHOD /path`, or a topic. */
  entry: Words,
  change: Change,
  breaking: z.boolean(),
  why: Words.optional(),
  /** Who calls it: component or system ids. */
  consumers: z.array(Words).default([]),
  fields: z.array(StoryInterfaceField).default([]),
});
export type StoryInterfaceChange = z.infer<typeof StoryInterfaceChange>;

/** A column the story adds or changes, as the story says it (B-stories). */
export const StoryDataChange = z.strictObject({
  table: Words,
  column: Words,
  type: Words.optional(),
  nullable: z.boolean().optional(),
  default: Words.optional(),
  change: Change.default("added"),
  migration: Words.optional(),
  classification: Words.optional(),
  retention: Words.optional(),
});
export type StoryDataChange = z.infer<typeof StoryDataChange>;

/** A section that has nothing in it on purpose, and says why. */
const NoneWhy = z.strictObject({ none: Words });

/**
 * The sections of a professional story beyond its statement (ADR 0124 addendum B-stories, Part
 * 3): each optional, so an answer written before them still reads; the completeness check asks
 * for the missing ones.
 */
const StorySections = {
  /** What a reader needs that the code doesn't say. The flow before and after is Atticus's. */
  context: Words.optional(),
  scope: z
    .strictObject({ in: z.array(Words).default([]), out: z.array(Words).default([]) })
    .optional(),
  interfaces: z.union([z.array(StoryInterfaceChange), NoneWhy]).optional(),
  data: z.union([z.array(StoryDataChange), NoneWhy]).optional(),
  nonFunctional: z
    .strictObject({
      auth: Words.optional(),
      audit: Words.optional(),
      /** Timeouts and retries on every call the story adds or relies on. */
      timeouts: Words.optional(),
      performance: Words.optional(),
    })
    .optional(),
  /** Test notes: which test files gain which cases. */
  tests: z.array(Words).optional(),
  /** What lands first: stories of this change, repos, and anything else. */
  dependencies: z
    .strictObject({
      stories: z.array(Words).default([]),
      repos: z.array(Words).default([]),
      notes: z.array(Words).default([]),
    })
    .optional(),
};

const Answer = z.strictObject({
  stories: z
    .array(
      z.strictObject({
        id: z.string(),
        title: z.string().trim().min(1),
        asA: z.string().trim().min(1),
        iWant: z.string().trim().min(1),
        soThat: z.string().trim().min(1),
        ...StorySections,
        tasks: z
          .array(
            z.strictObject({
              id: z.string(),
              criteria: z.array(StoryCriterion).default([]),
              /** The tests this task adds: the test file and its cases. */
              tests: z.array(Words).optional(),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
  requests: z.array(RequestIn).default([]),
});
export type StoriesAnswer = z.infer<typeof Answer>;
/** The story writer's answer's schema, for the fast path (ADR 0113). */
export const StoriesAnswerSchema = Answer;

/** A name folded for comparing as written: lower case, underscores and hyphens left out. */
const foldName = (s: string) => s.toLowerCase().replace(/[_-]/g, "");

/**
 * Whether a criterion's then clause (the words after its first "then"; the whole criterion when
 * it has none) writes a field's name (its last part: renamedAt for chat.renamedAt), as a word
 * of its own, case and underscores aside (renamed_at is renamedAt). A fact a test can see; a
 * field named only in the given, or in other words ("the time it was renamed"), is the model's
 * claim, judged.
 */
export function writesField(criterion: string, field: string): boolean {
  const name = foldName(field.split(".").at(-1)!);
  if (!name) return false;
  const then = /\bthen\b/i.exec(criterion);
  return criterion
    .slice(then ? then.index + then[0].length : 0)
    .split(/[^A-Za-z0-9_.-]+/)
    .flatMap((w) => [w, ...w.split(".")])
    .some((w) => foldName(w.replace(/^[.-]+|[.-]+$/g, "")) === name);
}

/** A criterion's claim that it checks a field, where the field isn't written in it. */
export interface UnwrittenCheck {
  task: string;
  repo: string;
  field: string;
  criterion: string;
}

/** What the sections check reads beside the answer (B-stories). */
export interface SectionCheckOptions {
  /** Check the story's sections (the stories stage; the fast path's answer has none yet). */
  sections?: boolean;
  /** Every field name something knows, folded (knownFieldNames). */
  known?: Set<string>;
  /** The estate, for the entries, components and repos it has. */
  estate?: Estate;
}

export function checkStories(
  a: StoriesAnswer,
  stories: DeltaStory[],
  deltas: FlowDelta[],
  items: Process[],
  o: SectionCheckOptions = {},
): StageIssue[] {
  const out: StageIssue[] = [];
  const issue = (rule: string, target: string, message: string, repo?: string) =>
    out.push({ rule, target, message, blocking: true, ...(repo ? { repo } : {}) });
  for (const s of a.stories) {
    const want = stories.find((x) => x.id === s.id);
    if (!want) {
      issue(
        "stories.unknown-story",
        s.id,
        `Story ${s.id} isn't one of the stories the target flows give: ${stories.map((x) => x.id).join(", ")}.`,
      );
      continue;
    }
    for (const t of s.tasks)
      if (!want.tasks.some((x) => x.id === t.id))
        issue(
          "stories.unknown-task",
          `${s.id}:${t.id}`,
          `Task ${t.id} isn't a task of story ${s.id}.`,
          want.repo,
        );
  }
  for (const want of stories) {
    const got = a.stories.find((x) => x.id === want.id);
    if (!got) {
      issue(
        "stories.missing-story",
        want.id,
        `Story ${want.id} (${want.flow} in ${want.repo}) has no wording: write its title, who, what and why, and its tasks' criteria.`,
        want.repo,
      );
      continue;
    }
    for (const t of want.tasks) {
      const c = got.tasks.find((x) => x.id === t.id)?.criteria ?? [];
      if (c.length === 0)
        issue(
          "stories.no-criteria",
          t.id,
          `Task ${t.id} (${t.title}) has no acceptance criteria.`,
          t.repo,
        );
      else {
        for (const x of c)
          for (const f of x.checks.filter((f) => !t.fields.includes(f)))
            issue(
              "stories.unknown-check",
              `${t.id}:${f}`,
              `Task ${t.id}: a criterion says it checks ${f}, which isn't one of the task's fields (${t.fields.join(", ") || "none"}).`,
              t.repo,
            );
        if (
          t.op !== "remove" &&
          t.kind &&
          (NEEDS_ERROR_CASE as readonly string[]).includes(t.kind) &&
          !c.some((x) => x.outcome === "error")
        )
          out.push({
            rule: "stories.no-error-case",
            target: t.id,
            message: `Task ${t.id} (${t.title}) ${t.kind === "validate" ? "validates input" : t.kind === "write" ? "writes data" : "calls another system"} but no criterion says what happens when that fails: add one with outcome: error (${t.kind === "validate" ? "the input is rejected and with what" : t.kind === "write" ? "the write fails and what the caller sees" : "the call fails or times out and what the caller sees"}).`,
            blocking: false,
            repo: t.repo,
          });
        const unchecked = t.fields.filter((f) => !c.some((x) => x.checks.includes(f)));
        if (unchecked.length)
          issue(
            "stories.field-not-checked",
            t.id,
            `Task ${t.id}'s criteria check no value of ${unchecked.join(", ")}: write a criterion whose then clause asserts each, and list it under that criterion's checks.`,
            t.repo,
          );
      }
    }
  }
  for (const r of a.requests) {
    const p = items.find((x) => x.id === r.item);
    if (!p)
      issue(
        "stories.unknown-request",
        r.item,
        `Request ${r.item} isn't a process or request in the knowledge items.`,
      );
    else if (!r.quote || !quotedIn(p.appliesWhen, r.quote))
      issue(
        "stories.request-unquoted",
        `${r.item}:${r.flow}#${r.step}`,
        `Request ${r.item} for ${r.flow} step ${r.step}: quote the words of its applies-when ("${p.appliesWhen}") that the step meets, copied exactly.`,
      );
    const d = deltas.find((x) => x.flow === r.flow);
    if (!d || !d.steps[r.step - 1])
      issue(
        "stories.unknown-step",
        `${r.flow}#${r.step}`,
        `Request ${r.item} cites step ${r.step} of ${r.flow}, which the target flows don't have.`,
      );
  }
  if (o.sections) out.push(...checkSections(a, stories, deltas, o));
  return out;
}

/**
 * Every field name something knows (B-stories), folded as writesField folds them: the target
 * flows' fields, the columns their stores name, `as` and `derived`, and the estate's columns,
 * schema fields and the fields its flows carry. A field a story names that none of them has is
 * invented.
 */
export function knownFieldNames(e: Estate, deltas: FlowDelta[]): Set<string> {
  const names: string[] = [];
  const add = (xs: Iterable<string> | undefined) => {
    for (const x of xs ?? []) names.push(x, ...x.split("."));
  };
  for (const d of deltas)
    for (const s of d.steps) {
      add(fieldNames(s.fields));
      add(Object.keys(s.fields?.as ?? {}));
      add(Object.values(s.fields?.as ?? {}));
      add(Object.keys(s.fields?.derived ?? {}));
      add(s.store?.columns);
    }
  for (const r of e.records as (CatalogRecord & Record<string, unknown>)[]) {
    if (r.kind === "Column") add([typeof r.name === "string" ? r.name : r.id.split(".").pop()!]);
    if (r.kind === "Schema" && Array.isArray(r.fields))
      add(
        (r.fields as { name?: unknown }[]).flatMap((f) =>
          typeof f.name === "string" ? [f.name] : [],
        ),
      );
  }
  for (const f of e.flows)
    for (const s of f.flow.steps) {
      for (const k of ["sends", "returns", "reads", "checks", "from", "to"] as const)
        add(s.data?.[k]);
      add(s.store?.columns);
    }
  return new Set(names.map(foldName).filter(Boolean));
}

/** Words in a criterion that are written like a field: snake_case or lowerCamelCase. */
export function fieldLikeNames(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?<![\w.$/{-])[a-z][a-z0-9]*(?:_[a-z0-9]+)+(?![\w(-])/g))
    out.add(m[0]);
  for (const m of text.matchAll(/(?<![\w.$/{-])[a-z]+[A-Z][A-Za-z0-9]*(?![\w(-])/g)) out.add(m[0]);
  return [...out];
}

const SECTION_NAMES = {
  scopeOut: "scope (out)",
  interfaces: "interface changes",
  data: "data changes",
  auth: "auth",
  audit: "audit",
  timeouts: "timeouts and retries",
  performance: "performance",
  tests: "test notes",
  dependencies: "dependencies",
} as const;

/**
 * The completeness check of a story's sections (ADR 0124 addendum B-stories, Part 3), run on
 * every draft before the critic: an entry the target flows add is in the interface changes; a
 * request field an entry of this repo gains has a validation and an error criterion; every
 * field and column a section names is one the target flows or the estate know; a column a step
 * adds has its type, nullable, classification and retention, and its write a migration; a
 * dependency is a story or repo of the change. A check on what the story wrote is blocking, so
 * the draft goes back with the list; a section the story leaves out is a risk (not blocking)
 * until the recorded replays are re-recorded with the sections, so old recordings still pass.
 */
export function checkSections(
  a: StoriesAnswer,
  stories: DeltaStory[],
  deltas: FlowDelta[],
  o: SectionCheckOptions = {},
): StageIssue[] {
  const out: StageIssue[] = [];
  const push = (
    rule: string,
    target: string,
    message: string,
    blocking: boolean,
    repo: string,
    locateText?: string,
  ) => out.push({ rule, target, message, blocking, repo, ...(locateText ? { locateText } : {}) });
  const known = o.known ?? new Set<string>();
  const e = o.estate;
  // Entries something knows: the stories' own, the target flows', and the estate's.
  const entries = new Set([
    ...stories.flatMap((s) => (s.entry ? [endpointKey(s.entry)] : [])),
    ...deltas.flatMap((d) => [
      ...(d.trigger?.entry ? [endpointKey(d.trigger.entry)] : []),
      ...d.steps.flatMap((s) => (s.to ? [endpointKey(s.to.entry)] : [])),
    ]),
    ...(e?.endpoints ?? []),
  ]);
  const repos = new Set([
    ...stories.map((s) => s.repo),
    ...(e?.flows.map((f) => f.repo) ?? []),
    ...((e?.records ?? []) as (CatalogRecord & Record<string, unknown>)[]).flatMap((r) =>
      r.kind === "Component" && typeof r.repo === "string" ? [r.repo] : [],
    ),
  ]);
  /** Whether an entry is served by the story's repo: its flow's own, or an endpoint of its components. */
  const served = (s: DeltaStory, entry: string) => {
    const k = endpointKey(entry);
    if (s.entry && endpointKey(s.entry) === k) return true;
    return ((e?.records ?? []) as (CatalogRecord & Record<string, unknown>)[]).some(
      (r) =>
        r.kind === "Endpoint" &&
        typeof r.method === "string" &&
        typeof r.pathOrTopic === "string" &&
        endpointKey(`${r.method} ${r.pathOrTopic}`) === k &&
        (e!.byId.get(String(r.component)) as { repo?: string } | undefined)?.repo === s.repo,
    );
  };

  for (const s of stories) {
    const w = a.stories.find((x) => x.id === s.id);
    if (!w) continue; // stories.missing-story says so
    // The story's fields, folded as writesField folds names (card_token is cardToken).
    const fields = new Set(s.tasks.flatMap((t) => t.fields.map(foldName)));
    const named = [...new Set(s.tasks.flatMap((t) => t.fields))];
    const criteria = s.tasks.flatMap((t) =>
      (w.tasks.find((x) => x.id === t.id)?.criteria ?? []).map((c) => ({ t, c })),
    );

    // ---- sections left out: a risk for now
    const missing: string[] = [];
    if (!w.scope?.out.length) missing.push(SECTION_NAMES.scopeOut);
    if (w.interfaces === undefined) missing.push(SECTION_NAMES.interfaces);
    if (w.data === undefined) missing.push(SECTION_NAMES.data);
    for (const k of ["auth", "audit", "timeouts", "performance"] as const)
      if (!w.nonFunctional?.[k]) missing.push(SECTION_NAMES[k]);
    if (!w.tests?.length) missing.push(SECTION_NAMES.tests);
    if (w.dependencies === undefined) missing.push(SECTION_NAMES.dependencies);
    if (missing.length)
      push(
        "stories.section-missing",
        s.id,
        `Story ${s.id} has no ${andList(missing)}: write ${missing.length === 1 ? "it" : "each"} (interfaces and data may be { none: <why> }, dependencies may be empty lists), so a developer can build it without asking.`,
        false,
        s.repo,
      );

    // ---- interface changes
    const added = [
      ...(s.change === "new" && s.entry ? [s.entry] : []),
      ...s.tasks.flatMap((t) => (t.to?.new && t.op !== "remove" ? [t.to.entry] : [])),
    ];
    if (w.interfaces !== undefined) {
      const listed = Array.isArray(w.interfaces) ? w.interfaces : [];
      for (const x of [...new Set(added)])
        if (!listed.some((i) => endpointKey(i.entry) === endpointKey(x)))
          push(
            "stories.interface-missing",
            `${s.id}:${x}`,
            `Story ${s.id}: the target flow adds ${x}, but ${Array.isArray(w.interfaces) ? "the interface changes don't list it" : `the interface changes say none ("${w.interfaces.none}")`}: list it with its fields (side, type, required, default), whether it is breaking, and its consumers.`,
            true,
            s.repo,
          );
      for (const i of listed) {
        if (!entries.has(endpointKey(i.entry)))
          push(
            "stories.unknown-entry",
            `${s.id}:${i.entry}`,
            `Story ${s.id}: the interface change names ${i.entry}, which neither the target flows nor the catalog have. Name an entry of the flow, or add it in the target flows (atticus change architecture).`,
            true,
            s.repo,
          );
        if (e)
          for (const c of i.consumers.filter((c) => !e.ids.has(c)))
            push(
              "stories.unknown-consumer",
              `${s.id}:${i.entry}:${c}`,
              `Story ${s.id}: ${i.entry}'s consumer ${c} isn't a component or system in the catalog. Name consumers by their catalog ids, or leave them out and say who calls it in why.`,
              true,
              s.repo,
            );
        const inbound = served(s, i.entry);
        for (const f of i.fields) {
          const target = `${s.id}:${i.entry}:${f.name}`;
          const isNew = f.change !== "removed";
          if (!(isNew ? fields : known).has(foldName(f.name)))
            push(
              "stories.invented-field",
              target,
              isNew
                ? `Story ${s.id}: ${i.entry} lists ${f.name} as ${f.change}, but no step of the target flow carries it (the story's fields: ${named.join(", ") || "none"}). Name the field as the target flow does, or add it to the step in the target flows (atticus change architecture).`
                : `Story ${s.id}: ${i.entry} lists ${f.name} as removed, but neither the target flows nor the catalog know a field of that name.`,
              true,
              s.repo,
            );
          if (!inbound || !isNew || f.side === "response" || !fields.has(foldName(f.name)))
            continue;
          if (!f.validation)
            push(
              "stories.field-no-validation",
              target,
              `Story ${s.id}: ${i.entry} gains or changes the ${f.side} field ${f.name} but says nothing it accepts: add its validation (required, format, length or range, and what is refused).`,
              true,
              s.repo,
            );
          const same = (x: string) => foldName(x) === foldName(f.name);
          const own = criteria.filter(({ t }) => t.fields.some(same));
          if (!own.some(({ c }) => c.outcome === "error" && c.checks.some(same)))
            push(
              "stories.field-no-error-case",
              target,
              `Story ${s.id}: no criterion says what happens when ${f.name}, a ${f.side} field ${i.entry} gains or changes, is wrong: add one with outcome: error that checks ${f.name}, saying the status and message the caller sees${own[0] ? ` (on task ${own[0].t.id})` : ""}.`,
              true,
              s.repo,
            );
        }
      }
    }
    for (const { t, c } of criteria)
      if (c.entry && !entries.has(endpointKey(c.entry)))
        push(
          "stories.unknown-entry",
          `${t.id}:${c.entry}`,
          `Task ${t.id}: the criterion "${c.text}" names the entry ${c.entry}, which neither the target flows nor the catalog have.`,
          true,
          t.repo,
          c.text,
        );

    // ---- data changes: each column a step adds, with what the target flow and the story say
    const rows = Array.isArray(w.data) ? w.data : [];
    const written = w.data !== undefined && Array.isArray(w.data);
    const stored = (table: string, column: string) =>
      s.tasks.some(
        (t) =>
          (t.data?.table === table && t.data.added.includes(column)) ||
          (t.store?.split(/[\s:]/)[0] === table && t.fields.includes(column)),
      );
    for (const r of rows)
      if (!stored(r.table, r.column))
        push(
          "stories.unknown-column",
          `${s.id}:${r.table}.${r.column}`,
          `Story ${s.id}: the data changes name ${r.table}.${r.column}, which no step of the target flow stores. Name the columns the steps add, as the target flow names them.`,
          true,
          s.repo,
        );
    for (const t of s.tasks) {
      if (!t.data) continue;
      for (const col of t.data.added) {
        const target = `${t.id}:${col}`;
        const r = rows.find((x) => x.table === t.data!.table && x.column === col);
        if (w.data !== undefined && !written) {
          push(
            "stories.data-missing",
            target,
            `Task ${t.id} adds ${t.data.table}.${col}, but the data changes say none ("${(w.data as { none: string }).none}"): list the column with its type, nullable, default, migration, classification and retention.`,
            true,
            t.repo,
          );
          continue;
        }
        const flow = {
          type: t.data.types[col],
          classification: t.data.classification[col],
          retention: t.data.retention,
        };
        const differs = (["type", "classification", "retention"] as const).filter(
          (k) => flow[k] && r?.[k] && flow[k]!.trim() !== r[k]!.trim(),
        );
        if (differs.length)
          push(
            "stories.data-differs",
            target,
            `Task ${t.id}: the data changes say ${t.data.table}.${col} has ${differs.map((k) => `${k} ${r![k]}`).join(" and ")}, but the target flow says ${differs.map((k) => `${k} ${flow[k]}`).join(" and ")}. Write what the target flow says, or change the target flow in the architecture stage.`,
            true,
            t.repo,
          );
        if (r?.migration && t.data.migration && r.migration !== t.data.migration)
          push(
            "stories.data-differs",
            `${target}:migration`,
            `Task ${t.id}: the data changes name the migration ${r.migration} for ${col}, but the target flow names ${t.data.migration}.`,
            true,
            t.repo,
          );
        const lacks = [
          ...(flow.type || r?.type ? [] : ["type"]),
          ...(r?.nullable !== undefined ? [] : ["nullable"]),
          ...(flow.classification || r?.classification ? [] : ["classification"]),
          ...(flow.retention || r?.retention ? [] : ["retention"]),
        ];
        if (lacks.length)
          push(
            "stories.data-incomplete",
            target,
            `Task ${t.id} adds ${t.data.table}.${col}, and nothing says its ${andList(lacks)}: add ${lacks.length === 1 ? "it" : "them"} to the column's data change${written ? "" : " (the story has no data changes yet)"}.`,
            written,
            t.repo,
          );
      }
      if (
        t.kind === "write" &&
        !t.data.migration &&
        !rows.some(
          (r) => r.table === t.data!.table && t.data!.added.includes(r.column) && r.migration,
        )
      )
        push(
          "stories.write-no-migration",
          t.id,
          `Task ${t.id} writes ${t.data.new ? `the new table ${t.data.table}` : `${t.data.added.join(", ")} to ${t.data.table}`}, but neither the target flow nor the data changes name the migration that makes ${t.data.new ? "it" : t.data.added.length === 1 ? "the column" : "the columns"}: name it on the column's data change (the file the repo's migrations would call it).`,
          written,
          t.repo,
        );
    }

    // ---- dependencies: stories and repos of the change
    for (const d of w.dependencies?.stories ?? [])
      if (d === s.id || !stories.some((x) => x.id === d))
        push(
          "stories.unknown-dependency",
          `${s.id}:${d}`,
          `Story ${s.id} depends on ${d}, which ${d === s.id ? "is the story itself" : `isn't a story of this change (${stories.map((x) => x.id).join(", ")})`}.`,
          true,
          s.repo,
        );
    for (const d of w.dependencies?.repos ?? [])
      if (!repos.has(d))
        push(
          "stories.unknown-dependency",
          `${s.id}:${d}`,
          `Story ${s.id} depends on the repo ${d}, which isn't a repo of the change or the estate.`,
          true,
          s.repo,
        );

    // ---- a criterion that names a field nothing knows: a risk, read by the story lens
    const own = new Set([
      ...fields,
      ...(Array.isArray(w.interfaces) ? w.interfaces : []).flatMap((i) =>
        i.fields.map((f) => foldName(f.name)),
      ),
      ...rows.map((r) => foldName(r.column)),
    ]);
    const seen = new Set<string>();
    for (const { t, c } of criteria)
      for (const n of fieldLikeNames(c.text)) {
        const k = `${t.id}:${n}`;
        if (seen.has(k) || own.has(foldName(n)) || known.has(foldName(n))) continue;
        seen.add(k);
        push(
          "stories.unknown-name",
          k,
          `Task ${t.id}: the criterion "${c.text}" names ${n}, which reads like a field but neither the target flows nor the catalog know it. Name the field as the code does, or say it in plain words.`,
          false,
          t.repo,
          c.text,
        );
      }
  }
  return out;
}

/** The criteria's claims to check a field that the criterion doesn't write (writesField). */
export function unwrittenChecks(a: StoriesAnswer, stories: DeltaStory[]): UnwrittenCheck[] {
  const out: UnwrittenCheck[] = [];
  for (const want of stories)
    for (const t of want.tasks) {
      const c =
        a.stories.find((x) => x.id === want.id)?.tasks.find((x) => x.id === t.id)?.criteria ?? [];
      for (const x of c)
        for (const f of x.checks)
          if (t.fields.includes(f) && !writesField(x.text, f))
            out.push({ task: t.id, repo: t.repo, field: f, criterion: x.text });
    }
  return out;
}

/** A judge for criteria, where the runtime calls a model directly; none for hand-off and mock. */
export const judgeRuntime = (runtime: AiRuntime): AiRuntime | undefined =>
  judgesDirectly(runtime) ? runtime : undefined;

/**
 * The covers-field judgment's inputs (ADR 0117). Version 2 since the question became "does the
 * outcome depend on the field's value" (addendum V2), so a verdict to the old question is never
 * read for the new one; a person's verdict is stored under the same key.
 */
export const coversInputs = (field: string, criterion: string) => ({ v: 2, field, criterion });

const coversItem = (c: UnwrittenCheck): JudgeItem => ({
  inputs: coversInputs(c.field, c.criterion),
  texts: { criterion: c.criterion },
  facts: [`the field: ${c.field}`],
});

/** How the criteria's claims to check a field they don't write were settled (ADR 0117). */
async function settleCoverage(
  claims: UnwrittenCheck[],
  j: { runtime?: AiRuntime; store: JudgmentStore; change: string; now: Date },
): Promise<
  {
    claim: UnwrittenCheck;
    verdict: string | undefined;
    /** The judge's words: its quote of the criterion and why, when it gave them. */
    quote?: string;
    why?: string;
  }[]
> {
  if (!claims.length) return [];
  const items = claims.map(coversItem);
  const r = await settle(COVERS_FIELD_SPEC, items, {
    ...(j.runtime ? { runtime: j.runtime } : {}),
    store: j.store,
    change: j.change,
    now: j.now,
  });
  return claims.map((claim, i) => {
    const j = r.get(judgmentKey(COVERS_FIELD_SPEC.kind, items[i]!.inputs));
    const quote = j?.judgment?.quotes.find((q) => q.of === "criterion")?.text;
    return {
      claim,
      // No entry in settle's results: nothing settled it, so the claim is unjudged.
      verdict: j?.verdict,
      ...(quote ? { quote } : {}),
      ...(j?.judgment?.why ? { why: j.judgment.why } : {}),
    };
  });
}

/** "a, b and c". */
const andList = (xs: string[]) =>
  xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}` : (xs[0] ?? "");

/**
 * Whether each criterion checks the field it claims to and doesn't write (ADR 0117). Whether
 * it does is meaning, so a check doesn't decide it: a stored verdict does, else the judge, asked
 * once for all of them, where the runtime calls a model directly (settle). "no" goes back to the
 * writer, as a person's decision if it comes back. "unsure", and a claim no judge read (a
 * hand-off spends no extra prompt and guesses nothing), is a note, never a stop: the story file
 * says so, for the critic's story lens and the PR's reviewer (writeStories' `unjudged`).
 */
export async function coverageIssues(
  all: UnwrittenCheck[],
  j: {
    runtime?: AiRuntime;
    store: JudgmentStore;
    change: string;
    now: Date;
    /** Claims a person answered in words no judge read (V1): they stand as the person left them. */
    decided?: Map<string, DecidedClaim>;
  },
): Promise<StageIssue[]> {
  const out: StageIssue[] = [];
  const decided = new Map(
    [...(j.decided ?? [])].filter(([k]) =>
      all.some((c) => `${c.task}:${c.field}` === k && c.criterion === j.decided!.get(k)!.criterion),
    ),
  );
  const claims = all.filter((c) => !decided.has(`${c.task}:${c.field}`));
  // U3: one finding, and so one question, per criterion the judge refused, naming every field it
  // refused there, with the judge's reason; never one per field.
  const refused = new Map<
    string,
    { c: UnwrittenCheck; fields: string[]; quote?: string; why?: string }
  >();
  for (const { claim: c, verdict: v, quote, why } of await settleCoverage(claims, j)) {
    if (v === "yes") continue;
    if (v === "no") {
      const key = `${c.task}\n${c.criterion}`;
      const r = refused.get(key) ?? { c, fields: [] };
      r.fields.push(c.field);
      r.quote ??= quote;
      r.why ??= why;
      refused.set(key, r);
    } else
      out.push({
        rule: "stories.check-unjudged",
        target: `${c.task}:${c.field}`,
        message: `Task ${c.task}: the criterion "${c.criterion}" says it checks ${c.field} without naming it; ${v === "unsure" ? "a judge couldn't tell whether it does" : "no judge read it here"}. The story lens and the reviewer confirm it.`,
        blocking: false,
        repo: c.repo,
      });
  }
  for (const { c, fields, quote, why } of refused.values())
    out.push(coversRefusal(c.task, c.repo, c.criterion, fields, quote, why));
  for (const [key, d] of decided)
    out.push({
      rule: "stories.check-answered",
      target: key,
      message: `Task ${d.task}: a person answered ${d.question} about the criterion "${d.criterion}" in their own words ("${d.words}"); no judge read the answer here, so the criterion stands as the person left it, for the story lens and the reviewer.`,
      blocking: false,
    });
  return out;
}

/** The option labels of the covers-field question, and what each means as a verdict (V1). */
export const COVERS_OPTIONS = {
  yes: "yes, it checks them",
  change: "no: change the criterion",
  notNeeded: "not needed",
} as const;

/**
 * The finding, and the person's question, for a criterion the judge refused (U3, V2): one per
 * criterion, naming every field refused there, with the judge's quote and why. The question asks
 * what the judge asked, whether the outcome depends on the fields' values; a refusal case (a key
 * that doesn't match) is the stories format's own rule, never asked here.
 */
export function coversRefusal(
  task: string,
  repo: string,
  criterion: string,
  fields: string[],
  quote?: string,
  why?: string,
): StageIssue {
  const them = andList(fields);
  const one = fields.length === 1;
  const reason = `${quote ? `, quoting "${quote}"` : ""}${why ? `: ${why}` : "."}`;
  return {
    rule: "stories.check-not-in-criterion",
    target: `${task}:${[...fields].sort().join(",")}`,
    message: `Task ${task}: the criterion "${criterion}" says it checks ${them}, but a judge read it and says its outcome doesn't depend on ${one ? "that field's value" : "their values"}${reason} Make its then clause state ${one ? "the value" : "their values"}, or a result that follows from ${one ? "a value" : "values"} its given clause fixes, or check ${one ? "it" : "them"} in another criterion.`,
    blocking: true,
    kind: "decision",
    repo,
    // A doubt goes back to the drafter once more, with the judge's reason, before a person.
    holdOnce: true,
    locateText: criterion,
    judged: fields.map((field) => ({ field, criterion, task })),
    ask: `Does the criterion "${criterion}" of task ${task} check ${them}: does its outcome depend on ${one ? "its value" : "their values"}? A judge read it and says no${reason}`,
    options: [
      {
        label: COVERS_OPTIONS.yes,
        means: `The criterion checks ${them} as written`,
        changes: `The criterion stands; a person's verdict overrules the judge's no`,
      },
      {
        label: COVERS_OPTIONS.change,
        means: `The criterion doesn't check ${them}; the next draft changes it so it does`,
        changes: `The next draft changes the criterion`,
      },
      {
        label: COVERS_OPTIONS.notNeeded,
        means: `${them} ${one ? "needs" : "need"} no check in this criterion; say why with --text`,
        changes: `The criterion stands, with the reason given`,
      },
    ],
  };
}

/**
 * Does a person's answer, in their own words, to the judge's covers-field question say the
 * criterion checks the fields (or needs no check), or ask for a change? (ADR 0117 addendum, V1.)
 * Asked only of an answer in words; an option the person picked is a fact.
 */
export const COVERS_ANSWER_SPEC: JudgeSpec = {
  kind: "covers-answer",
  ask: "A judge refused an acceptance criterion and a person answered the question about it, in their own words. Does the person's answer say the criterion checks the fields as written, say no check is needed, or ask for the criterion to change?",
  verdicts: ["checks", "not-needed", "change"],
  means: {
    checks: "the person says the criterion checks the fields as it is written",
    "not-needed": "the person says the fields need no check in this criterion",
    change: "the person says the criterion is wrong and should change",
  },
  quote: "one",
  quoteFrom: "answer",
};

/** A criterion's refused fields, from a finding the loop keeps: its record, or its own words (V0). */
function judgedOf(
  f: LoopFinding,
): { task: string; criterion: string; fields: string[] } | undefined {
  if (f.judged?.length)
    return {
      task: f.judged[0]!.task,
      criterion: f.judged[0]!.criterion,
      fields: f.judged.map((x) => x.field),
    };
  // A finding from before the record was kept: Atticus's own message, as it wrote it.
  const m = /^Task (\S+): the criterion "(.*)" says it checks (.+?), but a judge/.exec(f.message);
  if (!m) return undefined;
  return {
    task: m[1]!,
    criterion: m[2]!,
    fields: m[3]!.split(/, | and /).filter(Boolean),
  };
}

/** Whether a covers-field question is in the old form: one field, asked as "check <field>?". */
const oldForm = (question: string) =>
  /^Does the criterion ".*" of task \S+ check \S+\? A judge read it and says no\.$/.test(question);

/**
 * A person's answers to the judge's covers-field questions, read in before the stage drafts
 * (ADR 0117 addendum, V1 and V0). The person decides, not the judge: an answer that the criterion
 * checks the fields, or needs no check, is stored as the person's verdict (with who and when) for
 * each field, so the judge is never asked about it again; an answer that asks for a change is
 * stored as their no. An option is a fact; an answer in words is read by a judge where a model is
 * called directly, and else stands as the person's words (a note, never a guess). Open questions
 * of the old form (one per field) are retired and asked again as one per criterion, within the
 * cap; the loop file is updated to link the findings to them.
 */
export async function settleCoversAnswers(
  root: string,
  change: string,
  dir: string,
  j: {
    runtime?: AiRuntime;
    store: JudgmentStore;
    now: Date;
    cap: number;
    locate: (criterion: string) => Promise<string | undefined>;
    rerun: string;
  },
): Promise<{ notes: string[]; decided: Map<string, DecidedClaim> }> {
  const notes: string[] = [];
  const decided = new Map<string, DecidedClaim>();
  const file = join(dir, "stage", "stories.yaml");
  const text = await readFile(file, "utf8").catch(() => undefined);
  if (text === undefined) return { notes, decided };
  const parsed = StageLoop.safeParse(parse(text));
  if (!parsed.success) return { notes, decided };
  const loop = parsed.data;
  const at = j.now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const words: { key: string; q: Question; c: NonNullable<ReturnType<typeof judgedOf>> }[] = [];
  const stale: { f: LoopFinding; q: Question; c: NonNullable<ReturnType<typeof judgedOf>> }[] = [];
  const verdicts: { c: NonNullable<ReturnType<typeof judgedOf>>; q: Question; v: "yes" | "no" }[] =
    [];
  for (const f of loop.findings) {
    if (f.rule !== "stories.check-not-in-criterion" || !f.question) continue;
    const c = judgedOf(f);
    const q = await readQuestion(root, f.question).catch(() => undefined);
    if (!c || !q) continue;
    if (q.state === "open" && oldForm(q.question)) {
      stale.push({ f, q, c });
      continue;
    }
    if (q.state !== "answered" || !q.answer) continue;
    if (q.answer.option !== undefined) {
      const label = q.options[q.answer.option - 1]?.label;
      // The option is the person's choice: a fact. The old label for a change still reads as one.
      const v =
        label === COVERS_OPTIONS.yes || label === COVERS_OPTIONS.notNeeded
          ? "yes"
          : label === COVERS_OPTIONS.change || label === "no: add a criterion for the refusal"
            ? "no"
            : undefined;
      if (v) verdicts.push({ c, q, v });
    } else words.push({ key: f.fingerprint, q, c });
  }
  // An answer in the person's words: read by a judge of the answer where one can be asked.
  if (words.length) {
    const items = words.map((w) => ({
      inputs: { v: 1, question: w.q.question, answer: answerWords(w.q) ?? "" },
      texts: { question: w.q.question, answer: answerWords(w.q) ?? "" },
    }));
    const r = await settle(COVERS_ANSWER_SPEC, items, {
      ...(j.runtime ? { runtime: j.runtime } : {}),
      store: j.store,
      change,
      now: j.now,
    });
    words.forEach((w, i) => {
      const v = r.get(judgmentKey(COVERS_ANSWER_SPEC.kind, items[i]!.inputs))?.verdict;
      if (v === "checks" || v === "not-needed") verdicts.push({ c: w.c, q: w.q, v: "yes" });
      else if (v === "change") verdicts.push({ c: w.c, q: w.q, v: "no" });
      else
        for (const field of w.c.fields)
          decided.set(`${w.c.task}:${field}`, {
            task: w.c.task,
            criterion: w.c.criterion,
            question: w.q.id,
            words: answerWords(w.q) ?? "",
          });
    });
  }
  for (const { c, q, v } of verdicts)
    for (const field of c.fields)
      await personVerdict(j.store, coversInputs(field, c.criterion), {
        verdict: v,
        name: q.answer!.by,
        at: q.answer!.at,
        why: `${q.id}: ${answerWords(q) ?? ""}`,
      });

  // V0: the old form's open questions, regrouped one per criterion, within the cap.
  if (stale.length) {
    const groups = new Map<
      string,
      { c: (typeof stale)[number]["c"]; qs: Question[]; fields: string[] }
    >();
    for (const s of stale) {
      const key = `${s.c.task}\n${s.c.criterion}`;
      const g = groups.get(key) ?? { c: s.c, qs: [], fields: [] };
      g.qs.push(s.q);
      for (const f of s.c.fields) if (!g.fields.includes(f)) g.fields.push(f);
      groups.set(key, g);
    }
    let asked = 0;
    const retiredIds = new Set<string>();
    for (const g of groups.values()) {
      // A field a person already decided isn't asked again.
      const open: string[] = [];
      for (const f of g.fields) {
        const s = await j.store.get(
          COVERS_FIELD_SPEC.kind,
          judgmentKey(COVERS_FIELD_SPEC.kind, coversInputs(f, g.c.criterion)),
        );
        if (s?.confirmedBy.by !== "person") open.push(f);
      }
      if (!open.length || asked >= j.cap) continue;
      const issue = coversRefusal(g.c.task, g.qs[0]!.repo, g.c.criterion, open);
      const evidence = (await j.locate(g.c.criterion)) ?? g.qs[0]!.evidence[0]!;
      const raised = await raiseQuestions(
        root,
        [
          QuestionDraft.parse({
            question: issue.ask,
            options: issue.options,
            evidence: [evidence],
            scope: "repo",
          }),
        ],
        {
          step: "change-stories",
          repo: g.qs[0]!.repo,
          command: j.rerun,
          rerun: j.rerun,
          at,
        },
      );
      const now = raised.of[0] ?? raised.raised[0] ?? raised.known[0];
      if (!now) continue;
      asked++;
      for (const q of g.qs) {
        await retireQuestion(root, q.id, {
          why: "asked again as one question per criterion (ADR 0117 addendum), with the fields still open",
          replacedBy: [now.id],
          at,
        });
        retiredIds.add(q.id);
      }
      // The loop links the regrouped finding to its question, by its fingerprint as the check
      // writes it, and drops the old per-field findings.
      loop.findings = loop.findings.filter((f) => !g.qs.some((q) => q.id === f.question));
      loop.findings.push({
        fingerprint: issueFingerprint(issue.rule, issue.target, ""),
        rule: issue.rule,
        target: issue.target,
        message: issue.message,
        blocking: true,
        source: "stage",
        seenIn: [Math.max(1, loop.iteration)],
        question: now.id,
        kind: "decision",
        judged: issue.judged!,
      });
      loop.questions = [...new Set([...loop.questions, now.id])].sort();
      notes.push(
        `Retired ${g.qs.length} question${g.qs.length === 1 ? "" : "s"} in the old form (one per field) for task ${g.c.task}'s criterion; ${now.id} asks them as one.`,
      );
    }
    if (retiredIds.size) {
      loop.questions = loop.questions.filter((id) => !retiredIds.has(id));
      loop.findings.sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
      await writeFileAtomic(
        file,
        `# The stories stage's loop (ADR 0087): drafts, the findings each one had, and the questions it raised. Atticus writes this file.\n${stringify(StageLoop.parse(loop), { lineWidth: 0 })}`,
      );
    }
  }
  return { notes, decided };
}

/** A claim a person answered in words that no judge read (V1): it stands as they left it. */
export interface DecidedClaim {
  task: string;
  criterion: string;
  question: string;
  words: string;
}

/** Store a person's verdict, never replacing another person's (ADR 0117 §2). */
async function personVerdict(
  store: JudgmentStore,
  inputs: Record<string, unknown>,
  o: { verdict: "yes" | "no"; name: string; at: string; why: string },
): Promise<void> {
  const kind = COVERS_FIELD_SPEC.kind;
  const key = judgmentKey(kind, inputs);
  const was = await store.get(kind, key);
  if (was?.confirmedBy.by === "person") return;
  if (was) await overrideJudgment(store, kind, key, o);
  else
    await store.put(
      makeJudgment({
        kind,
        inputs,
        verdict: o.verdict,
        confirmedBy: { by: "person", name: o.name },
        at: o.at,
        why: o.why,
      }),
    );
}

/** The claims no judgment settled (unjudged or unsure), for the story file's note. */
export async function unjudgedChecks(
  claims: UnwrittenCheck[],
  j: { runtime?: AiRuntime; store: JudgmentStore; change: string; now: Date },
): Promise<UnwrittenCheck[]> {
  return (await settleCoverage(claims, j))
    .filter((x) => x.verdict !== "yes" && x.verdict !== "no")
    .map((x) => x.claim);
}

const sentence = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

/** What a task's prompt adds beside the step and criteria (B-stories): the story's own words for it. */
export interface TaskPromptExtras {
  /** The interface fields and columns of the task's fields, each in one line. */
  contract?: string[];
  tests?: string[];
  command?: string;
}

export function taskPrompt(
  change: string,
  s: DeltaStory,
  t: DeltaTask,
  criteria: StoryCriterion[],
  x: TaskPromptExtras = {},
): string {
  return [
    `Implement task ${t.id} of the change ${change} in the repo ${t.repo}.`,
    `Flow ${s.flow} (${s.name}): ${t.op} the ${t.kind ?? "step"} step${t.op === "add" ? "" : ` (step ${t.position} of the target flow)`}. ${sentence(t.what)}`,
    ...(t.target ? [`It goes to ${t.target}.`] : []),
    ...(t.store ? [`It uses ${t.store}.`] : []),
    ...(t.fields.length ? [`Fields: ${t.fields.join(", ")}.`] : []),
    ...(x.contract ?? []).map(sentence),
    ...(t.evidence.length
      ? [`Today's code is at ${t.evidence.join(", ")}; read it first.`]
      : ["This is new code; follow the repo's patterns for its neighbours."]),
    "Acceptance criteria:",
    ...criteria.map(
      (c) => `- ${c.text}${c.checks.length ? ` (checks ${c.checks.join(", ")})` : ""}`,
    ),
    ...(x.tests?.length ? ["Tests to add:", ...x.tests.map((y) => `- ${y}`)] : []),
    ...(x.command ? [`Run ${x.command} until it passes.`] : []),
    "Change only this repo. Write a test for each criterion. Never push to a protected branch.",
  ].join("\n");
}

/** What the story file needs beside the story writer's words (B-stories). */
export interface StoryFileExtras {
  /** The definition of done: the org pack's checks and Atticus's own items. */
  done?: string[];
  /** Each repo's build and test command, from repos.manifest.yaml. */
  commands?: Record<string, string>;
  /** The test kinds the test strategy asks of this change. */
  testKinds?: string[];
  requests?: RequestTask[];
  /** The estate, for a field's required the story leaves out (ADR 0125). */
  estate?: Estate;
}

/**
 * Whether an interface field is required: the story's word, else the catalog's for that entry,
 * side and field (ADR 0125), else unknown. Endpoints the entry names that disagree are unknown.
 */
function requiredOf(
  e: Estate | undefined,
  entry: string,
  f: { name: string; side: "request" | "response" | "message"; required?: boolean },
): { required?: boolean; from: "story" | "catalog" } {
  if (f.required !== undefined) return { required: f.required, from: "story" };
  const said = new Set<boolean>();
  for (const id of e ? endpointsFor(e, entry) : [])
    for (const x of schemaFieldsOf(e!, id, f.side))
      if (foldName(x.name) === foldName(f.name) && x.required !== undefined) said.add(x.required);
  return said.size === 1 ? { required: [...said][0]!, from: "catalog" } : { from: "catalog" };
}

export type StoryWords = StoriesAnswer["stories"][number];
const NOT_WRITTEN = "Not written yet.";
const cell = (v: string | undefined) => (v ?? "not said").replace(/\|/g, "\\|");

/**
 * A column a step adds, with the target flow's facts and the story's words over them: the story
 * file's Data changes, and the stories bench's draft of the story (B-stories-bench).
 */
export function storyColumns(
  s: DeltaStory,
  w: StoryWords,
): (StoryDataChange & { task?: string })[] {
  const rows = Array.isArray(w.data) ? w.data : [];
  const out: (StoryDataChange & { task?: string })[] = [];
  for (const t of s.tasks)
    for (const col of t.data?.added ?? []) {
      const d = t.data!;
      const r = rows.find((x) => x.table === d.table && x.column === col);
      const type = d.types[col] ?? r?.type;
      const migration = d.migration ?? r?.migration;
      const classification = d.classification[col] ?? r?.classification;
      const retention = d.retention ?? r?.retention;
      out.push({
        task: t.id,
        table: d.table,
        column: col,
        change: "added",
        ...(type ? { type } : {}),
        ...(r?.nullable !== undefined ? { nullable: r.nullable } : {}),
        ...(r?.default ? { default: r.default } : {}),
        ...(migration ? { migration } : {}),
        ...(classification ? { classification } : {}),
        ...(retention ? { retention } : {}),
      });
    }
  for (const r of rows)
    if (!out.some((x) => x.table === r.table && x.column === r.column)) out.push(r);
  return out;
}

/** The interface fields and columns a task's fields are, one line each, for its prompt. */
function contractOf(s: DeltaStory, w: StoryWords, t: DeltaTask, e?: Estate): string[] {
  const out: string[] = [];
  // A call's entry is the task's that makes the call; any other entry is the flow's own.
  const calls = new Set(s.tasks.flatMap((x) => (x.to ? [endpointKey(x.to.entry)] : [])));
  const mine = (entry: string) =>
    t.to
      ? endpointKey(t.to.entry) === endpointKey(entry) || !calls.has(endpointKey(entry))
      : !calls.has(endpointKey(entry));
  for (const i of (Array.isArray(w.interfaces) ? w.interfaces : []).filter((i) => mine(i.entry)))
    for (const f of i.fields.filter((f) => t.fields.includes(f.name))) {
      const r = requiredOf(e, i.entry, f);
      const req =
        r.required === undefined
          ? "required not said"
          : `${r.required ? "required" : "optional"}${r.from === "catalog" ? ", from the catalog" : ""}`;
      out.push(
        `${i.entry} ${f.change === "removed" ? "loses" : f.change === "added" ? "gains" : "changes"} the ${f.side} field ${f.name} (${f.type}, ${req}${f.default ? `, default ${f.default}` : ""})${f.validation ? `. Validation: ${f.validation.replace(/[.\s]+$/, "")}` : ""}`,
      );
    }
  for (const r of storyColumns(s, w).filter((r) => r.task === t.id))
    out.push(
      `Column ${r.table}.${r.column}: ${r.type ?? "type not said"}, ${r.nullable === undefined ? "nullable not said" : r.nullable ? "nullable" : "not null"}${r.default ? `, default ${r.default}` : ""}${r.migration ? `, migration ${r.migration}` : ""}`,
    );
  return out;
}

/** A criterion's entry, validation and error, after its words in the task's list. */
function criterionDetails(c: StoryCriterion): string {
  const parts = [
    ...(c.entry ? [`Entry: ${c.entry}`] : []),
    ...(c.validation ? [`Validation: ${c.validation.replace(/[.\s]+$/, "")}`] : []),
    ...(c.outcome === "error"
      ? [`Error${c.rule ? `: ${c.rule}` : ""}${c.status !== undefined ? `, ${c.status}` : ""}`]
      : []),
  ];
  return parts.length ? ` (${parts.join("; ")})` : "";
}

/** Atticus's own definition of done, for every story (the org pack's checks come after). */
export const DEFAULT_DONE = [
  "Every acceptance criterion has a test, and the repo's build and tests pass",
  "The interface and data changes are in the code as written here, and no other entry, field or column changed",
  "A person reviewed and merged each task's pull request; nothing was pushed to a protected branch",
];

/**
 * The definition of done (B-stories): Atticus's own items, the test kinds the org pack's test
 * strategy asks of the change, and the checks of its build and qa gates (gates.yaml).
 */
export function definitionOfDone(
  ctx: Pick<ChangeContext, "orgPack">,
  change: Pick<ChangeLifecycle, "type">,
  kinds: { required: string[]; row?: { changeType: string; risk: string } },
): string[] {
  const out = [...DEFAULT_DONE];
  if (kinds.required.length)
    out.push(
      `Tests of each kind test-strategy.yaml asks of a ${kinds.row?.changeType ?? change.type} change${kinds.row ? ` at ${kinds.row.risk} risk` : ""}: ${kinds.required.join(", ")}`,
    );
  for (const g of ctx.orgPack.gates.gates.filter((x) => x.phase === "build" || x.phase === "qa"))
    if (g.checks.length || g.checklists.length)
      out.push(
        `The ${g.id} gate (gates.yaml) passes: ${[...g.checks.map((c) => c.check), ...g.checklists.map((c) => `checklist ${c}`)].join(", ")}`,
      );
  return out;
}

function renderStoryFile(
  change: string,
  s: DeltaStory,
  w: StoryWords,
  unjudged: UnwrittenCheck[] = [],
  x: StoryFileExtras = {},
): string {
  const lines = [
    `${GENERATED_MARK} stories from the target flows (target-flows/). Edit the wording freely; tasks, fields and evidence come from the flows. -->`,
    `# ${w.title}`,
    "",
    `As ${/^[aeiou]/i.test(w.asA) ? "an" : "a"} ${w.asA} I want ${w.iWant} so that ${sentence(w.soThat)}`,
    "",
  ];

  // ---- Context: the story's words, then the flow before and after, from the map and the delta.
  lines.push("## Context", "");
  if (w.context) lines.push(sentence(w.context), "");
  const started = s.entry ? `, started by ${s.entry}` : "";
  if (s.before?.length)
    lines.push(`Today, flow ${s.flow} (${s.name})${started}:`, "", ...s.before, "");
  if (s.errors?.length)
    lines.push("Its error paths today:", "", ...s.errors.map((e) => `- ${e}`), "");
  if (s.after?.length)
    lines.push(
      s.change === "new"
        ? `The new flow ${s.flow} (${s.name})${started}:`
        : s.change === "remove"
          ? `Once the change is in, flow ${s.flow} is removed:`
          : "Once the change is in:",
      "",
      ...s.after,
      "",
    );

  // ---- Scope
  const kept = s.change === "modify" && s.kept?.length ? s.kept : [];
  const out = [
    ...(kept.length
      ? [
          `Step${kept.length === 1 ? "" : "s"} ${andList(kept.map(String))} of the flow ${kept.length === 1 ? "stays as it is" : "stay as they are"}.`,
        ]
      : []),
    ...(w.scope?.out ?? []).map(sentence),
  ];
  lines.push(
    "## Scope",
    "",
    "In:",
    "",
    ...s.tasks.map((t) => `- Task ${t.id}: ${sentence(t.title)}`),
    ...(w.scope?.in ?? []).map((i) => `- ${sentence(i)}`),
    "",
    "Out:",
    "",
    ...(out.length ? out.map((o) => `- ${o}`) : [`- ${NOT_WRITTEN}`]),
    "",
  );

  // ---- Acceptance criteria (the critic and test generation read this list)
  lines.push("## Acceptance criteria", "");
  const crit = s.tasks.flatMap((t) => w.tasks.find((y) => y.id === t.id)?.criteria ?? []);
  lines.push(...(crit.length ? crit.map((c) => `- ${sentence(c.text)}`) : ["- None yet."]), "");

  // ---- Interface changes
  lines.push("## Interface changes", "");
  if (w.interfaces === undefined) lines.push(NOT_WRITTEN, "");
  else if (!Array.isArray(w.interfaces)) lines.push(`None: ${sentence(w.interfaces.none)}`, "");
  else if (!w.interfaces.length) lines.push("None.", "");
  else
    for (const i of w.interfaces) {
      lines.push(
        `### ${i.entry}`,
        "",
        `${i.change[0]!.toUpperCase()}${i.change.slice(1)}, ${i.breaking ? "breaking" : "additive"}${i.why ? `: ${sentence(i.why)}` : "."} Consumers: ${i.consumers.length ? i.consumers.join(", ") : "none named"}.`,
        "",
      );
      if (i.fields.length)
        lines.push(
          "| Field | Side | Type | Required | Default | Change | Validation |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          ...i.fields.map((f) => {
            const r = requiredOf(x.estate, i.entry, f);
            const req =
              r.required === undefined
                ? "not said"
                : `${r.required ? "yes" : "no"}${r.from === "catalog" ? " (catalog)" : ""}`;
            return `| ${cell(f.name)} | ${f.side} | ${cell(f.type)} | ${req} | ${cell(f.default ?? "none")} | ${f.change} | ${cell(f.validation ?? (f.side === "response" ? "none" : "none given"))} |`;
          }),
          "",
        );
    }

  // ---- Data changes: the target flow's columns, with the story's words over them
  lines.push("## Data changes", "");
  const cols = storyColumns(s, w);
  if (cols.length)
    lines.push(
      "| Table | Column | Type | Nullable | Default | Change | Migration | Classification | Retention |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
      ...cols.map(
        (r) =>
          `| ${cell(r.table)} | ${cell(r.column)} | ${cell(r.type)} | ${r.nullable === undefined ? "not said" : r.nullable ? "yes" : "no"} | ${cell(r.default ?? "none")} | ${r.change} | ${cell(r.migration)} | ${cell(r.classification)} | ${cell(r.retention)} |`,
      ),
      "",
    );
  else if (w.data && !Array.isArray(w.data)) lines.push(`None: ${sentence(w.data.none)}`, "");
  else lines.push(w.data === undefined ? NOT_WRITTEN : "None.", "");

  // ---- Non-functional
  const nf = w.nonFunctional ?? {};
  lines.push(
    "## Non-functional",
    "",
    `- Auth: ${sentence(nf.auth ?? NOT_WRITTEN)}`,
    `- Audit: ${sentence(nf.audit ?? NOT_WRITTEN)}`,
    `- Timeouts and retries: ${sentence(nf.timeouts ?? NOT_WRITTEN)}`,
    `- Performance: ${sentence(nf.performance ?? NOT_WRITTEN)}`,
    "",
  );

  // ---- Tests: the kinds alone (the story bar reads them as a list), then the notes
  if (x.testKinds?.length) lines.push("## Tests", "", x.testKinds.join(", "), "");
  lines.push(
    "## Test notes",
    "",
    ...(w.tests?.length ? w.tests.map((n) => `- ${sentence(n)}`) : [`- ${NOT_WRITTEN}`]),
    "",
  );

  // ---- Depends on, in one line (the story bar reads it as a list)
  const deps = [
    ...new Set([...(s.dependsOn ?? []), ...(w.dependencies?.stories ?? [])]),
    ...(w.dependencies?.repos ?? []).map((r) => `the ${r} repo`),
    ...(w.dependencies?.notes ?? []).map((n) => n.replace(/[.\s]+$/, "")),
  ];
  lines.push(
    "## Depends on",
    "",
    deps.length ? sentence(deps.join("; ")) : w.dependencies ? "None." : NOT_WRITTEN,
    "",
  );

  // ---- Definition of done
  const waits = (x.requests ?? []).filter((r) => r.flow === s.flow);
  lines.push(
    "## Definition of done",
    "",
    ...[
      ...(x.done ?? DEFAULT_DONE),
      ...(waits.length
        ? [`A person has raised ${andList(waits.map((r) => `${r.id} ${r.title}`))} (requests.md)`]
        : []),
    ].map((d) => `- ${sentence(d)}`),
    "",
  );

  lines.push(
    "## Traces to",
    "",
    `target-flows/${s.flow}.yaml (${s.change} flow ${s.flow}: ${s.name})`,
    "",
  );
  lines.push("## Systems and repos", "", s.repo, "", "## Tasks", "");
  const command = x.commands?.[s.repo];
  for (const t of s.tasks) {
    const tw = w.tasks.find((y) => y.id === t.id);
    const c = tw?.criteria ?? [];
    // The files the step's citations are in, with their lines, and a migration it names (new).
    const byFile = new Map<string, string[]>();
    for (const c of t.evidence) {
      const m = /^(.+?)(?::(\d+))?$/.exec(c)!;
      const ls = byFile.get(m[1]!) ?? [];
      if (m[2] && !ls.includes(m[2])) ls.push(m[2]);
      byFile.set(m[1]!, ls);
    }
    const files = [
      ...[...byFile].map(
        ([f, ls]) =>
          `${f}${ls.length ? ` (line${ls.length === 1 ? "" : "s"} ${andList(ls)})` : ""}`,
      ),
      ...(t.data?.migrationFile ? [`${t.repo}:${t.data.migrationFile} (new migration)`] : []),
    ];
    lines.push(
      `### Task ${t.id}: ${t.title}`,
      "",
      `- Step: ${t.op} (${t.kind ?? "step"}), item ${t.position} of target-flows/${s.flow}.yaml`,
      `- Fields: ${t.fields.join(", ") || "none"}`,
      `- Evidence: ${t.evidence.join(", ") || "new code"}`,
      ...(t.target ? [`- Goes to: ${t.target}`] : []),
      ...(t.store ? [`- Store: ${t.store}`] : []),
      `- Files to touch: ${files.join(", ") || "new code; follow the repo's patterns for its neighbours"}`,
      "- Acceptance criteria:",
      ...(c.length
        ? c.flatMap((y) => [
            `  - ${sentence(y.text)}${criterionDetails(y)}`,
            ...unjudged
              .filter((u) => u.task === t.id && u.criterion === y.text)
              .map(
                (u) =>
                  `  - Not judged yet: this criterion says it checks ${u.field} without naming it. The story lens and the reviewer confirm it does (judgments/covers-field/ keeps a verdict).`,
              ),
          ])
        : ["  - None yet."]),
      "- Tests to add:",
      ...(tw?.tests?.length
        ? tw.tests.map((y) => `  - ${sentence(y)}`)
        : [
            `  - A test for each criterion above${t.evidence[0] ? `, beside the tests of ${t.evidence[0].split(":")[1]}` : ""}.`,
          ]),
      `- Run: ${command ? `\`${command}\`` : `the repo's build and tests (repos.manifest.yaml names no build command for ${t.repo})`}`,
      "",
      "Prompt for Copilot or Claude Code:",
      "",
      "```text",
      taskPrompt(change, s, t, c, {
        contract: contractOf(s, w, t, x.estate),
        ...(tw?.tests?.length ? { tests: tw.tests } : {}),
        ...(command ? { command } : {}),
      }),
      "```",
      "",
    );
  }
  return lines.join("\n");
}

function renderIndex(stories: DeltaStory[], a: StoriesAnswer): string {
  return [
    `${GENERATED_MARK} stories from the target flows. -->`,
    "# Stories",
    "",
    "| Story | Title | Repos | Depends on |",
    "| --- | --- | --- | --- |",
    ...stories.map((s) => {
      const w = a.stories.find((x) => x.id === s.id);
      // Story ids only: the critic reads the cell as a list of stories.
      const deps = [
        ...new Set([
          ...(s.dependsOn ?? []),
          ...(w?.dependencies?.stories ?? []).filter((d) => stories.some((x) => x.id === d)),
        ]),
      ];
      return `| ${s.id} | ${(w?.title ?? s.name).replace(/\|/g, "\\|")} | ${s.repo} | ${deps.join(", ")} |`;
    }),
    "",
  ].join("\n");
}

function renderTasks(stories: DeltaStory[], requests: RequestTask[]): string {
  const lines = [
    `${GENERATED_MARK} tasks from the stories. Tick them as they are done. -->`,
    "# Tasks",
    "",
  ];
  for (const repo of [...new Set(stories.map((s) => s.repo))]) {
    lines.push(`## ${repo}`, "");
    for (const s of stories.filter((x) => x.repo === repo))
      for (const t of s.tasks) {
        lines.push(`- [ ] ${t.id} ${t.title} (story ${s.id})`);
        const waits = requests.filter((r) => r.flow === s.flow && r.step === t.position);
        if (waits.length)
          lines.push(
            `  - Waits for: ${waits.map((r) => `${r.id} ${r.title}${r.leadTime ? ` (${r.leadTime})` : ""}`).join("; ")}`,
          );
      }
    lines.push("");
  }
  return lines.join("\n");
}

function renderRequests(requests: RequestTask[]): string {
  const lines = [
    `${GENERATED_MARK} change tasks and service requests suggested from the knowledge items. A person raises each one; Atticus never does. -->`,
    "# Requests and processes",
    "",
  ];
  if (!requests.length) lines.push("The knowledge items suggest none for these target flows.", "");
  for (const r of requests) {
    const q = r.quote;
    lines.push(
      `- [ ] ${r.id} ${r.title} (${r.processKind}${r.leadTime ? `, lead time ${r.leadTime}` : ""}${r.handledBy ? `, handled by ${r.handledBy}` : ""}${r.catalogueItem ? `, ${r.catalogueItem}` : ""})`,
      `  - For: ${r.flow} step ${r.step} (${r.stepWhat})`,
      `  - Why: ${r.why}`,
      `  - Knowledge item: ${r.item}, quoting ${q.source}/${q.page}${q.line ? `:${q.line}` : ""} (${q.section}, snapshot ${q.snapshot}): "${q.text}"`,
      `  - Suggested by: ${r.by === "judge" ? "a judgment that the step meets its applies-when (judgments/applies/)" : "your assistant, quoting its applies-when"}`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * The story writer's requests that cite a real item and step and quote its applies-when, then
 * the ones a judge found (judgedRequests) that the writer left out.
 */
export function mergeRequests(
  a: StoriesAnswer,
  deltas: FlowDelta[],
  items: Process[],
  judged: RequestTask[] = [],
): RequestTask[] {
  const all: RequestTask[] = [];
  for (const r of a.requests) {
    const p = items.find((x) => x.id === r.item);
    const d = deltas.find((x) => x.flow === r.flow);
    const s = d?.steps[r.step - 1];
    if (
      !p ||
      !d ||
      !s ||
      !r.quote ||
      !quotedIn(p.appliesWhen, r.quote) ||
      all.some((x) => x.item === r.item && x.flow === r.flow && x.step === r.step)
    )
      continue;
    all.push(requestTask(p, d, r.step, s, `${r.why} ("${r.quote}")`, "assistant"));
  }
  for (const r of judged)
    if (!all.some((x) => x.item === r.item && x.flow === r.flow && x.step === r.step)) all.push(r);
  return all.map((r, i) => ({ ...r, id: `R${i + 1}` }));
}

/**
 * Write the stories, stories.md, tasks.md, requests.md and the needs they add, and keep the
 * story writer's answer. Shared by the stories stage and the fast path (ADR 0113).
 */
export async function writeStories(
  root: string,
  change: string,
  stories: DeltaStory[],
  a: StoriesAnswer,
  requests: RequestTask[],
  now: Date,
  /** Criteria's claims no judgment settled: noted under them for the story lens and the reviewer. */
  unjudged: UnwrittenCheck[] = [],
  /** The definition of done, the repos' commands and the test kinds (B-stories). */
  extras: Omit<StoryFileExtras, "requests"> = {},
): Promise<string[]> {
  const dir = changeFolder(root, change);
  const keep = new Set(stories.map((s) => `${s.id}.md`));
  for (const f of await readdir(join(dir, "stories")).catch(() => [] as string[])) {
    if (keep.has(f) || !f.endsWith(".md")) continue;
    if ((await readFile(join(dir, "stories", f), "utf8")).startsWith(GENERATED_MARK))
      await rm(join(dir, "stories", f));
  }
  const files: string[] = [];
  for (const s of stories) {
    const w = a.stories.find((x) => x.id === s.id) ?? {
      id: s.id,
      title: s.name,
      asA: "user",
      iWant: s.name,
      soThat: "the change works",
      tasks: [],
    };
    await writeFileAtomic(
      join(dir, "stories", `${s.id}.md`),
      renderStoryFile(change, s, w, unjudged, { ...extras, requests }),
    );
    files.push(`stories/${s.id}.md`);
  }
  await writeFileAtomic(join(dir, "stories.md"), renderIndex(stories, a));
  await writeFileAtomic(join(dir, "tasks.md"), renderTasks(stories, requests));
  await writeFileAtomic(join(dir, "requests.md"), renderRequests(requests));
  // ADR 0101: the same requests join the change's needs, beside what change needs found.
  await mergeStoryRequests(root, change, requests, now);
  await writeFileAtomic(
    join(dir, ...ANSWER_FILE.split("/")),
    `# The story writer's last answer (ADR 0087).\n${stringify(a, { lineWidth: 0 })}`,
  );
  return [...files, "stories.md", "tasks.md", "requests.md", "needs.yaml", "needs.md"];
}

/** The story writer's last answer, as kept in the change folder. */
export async function readStoriesAnswer(dir: string): Promise<StoriesAnswer | undefined> {
  const t = await readFile(join(dir, ...ANSWER_FILE.split("/")), "utf8").catch(() => undefined);
  if (t === undefined) return undefined;
  // The same reader as the model's answer (S6): relies_on_gaps and a code fence read as there.
  return parseYamlAs(t, Answer, (d) => d, "stories").value;
}

/** The line of a story file that holds the words, as metarepo path:line (U3). */
async function locateInStories(
  dir: string,
  rel: string,
  words: string,
): Promise<string | undefined> {
  for (const f of (await readdir(join(dir, "stories")).catch(() => [] as string[])).sort()) {
    if (!f.endsWith(".md")) continue;
    const lines = (await readFile(join(dir, "stories", f), "utf8")).split(/\r?\n/);
    const n = lines.findIndex((l) => l.includes(words));
    if (n >= 0) return `${rel}/stories/${f}:${n + 1}`;
  }
  return undefined;
}

/**
 * The definition of done, each repo's build command and the test kinds for a change's stories
 * (B-stories), from the org pack. A footprint that can't be worked out leaves the test kinds out.
 */
export async function storyExtras(
  ctx: ChangeContext,
  change: ChangeLifecycle,
): Promise<Omit<StoryFileExtras, "requests">> {
  let kinds: { required: string[]; row?: { changeType: string; risk: string } } = {
    required: [],
  };
  try {
    const footprint = await changeFootprint(ctx, change);
    const risk = scoreRisk({ type: change.type, footprint }, ctx.policy);
    kinds = testsFor(ctx.orgPack.testStrategy, change.type, risk.level);
  } catch {
    // The test kinds are a convenience: the definition of done says what it can without them.
  }
  const commands: Record<string, string> = {};
  for (const p of ctx.orgPack.profiles)
    for (const r of p.repos?.repos ?? []) if (r.build) commands[r.id] = r.build;
  return {
    done: definitionOfDone(ctx, change, kinds),
    commands,
    testKinds: [...kinds.required],
  };
}

/** A change's drafted stories as the stories stage wrote them, read back from its folder. */
export interface DraftedStories {
  change: ChangeLifecycle;
  /** The change's folder. */
  dir: string;
  stories: DeltaStory[];
  answer: StoriesAnswer;
  /** The definition of done, the repos' commands and the test kinds, as the story files have them. */
  extras: Omit<StoryFileExtras, "requests">;
  /** The requests the writer named that cite a real item and step (no judge is asked here). */
  requests: RequestTask[];
}

/**
 * The stories the stage drafted for a change (B-stories-bench): the stories and tasks worked out
 * again from its target flows over the estate, the story writer's last answer, and what the story
 * files say beside it. Writes nothing and asks no model, so the stories bench can score a draft.
 */
export async function draftedStories(root: string, changeId: string): Promise<DraftedStories> {
  const change = await changeStore(root)
    .read(changeId)
    .catch((e: Error) => {
      throw new PlannerError("not-found", e.message);
    });
  const dir = changeFolder(root, change.id);
  const read = await readDeltas(dir);
  if (read.problems.length)
    throw new PlannerError("refused", `The target flows don't read: ${read.problems.join("; ")}`);
  const deltas = read.deltas.filter((d) => !isEmptyDelta(d));
  if (!deltas.length)
    throw new PlannerError(
      "refused",
      `${change.id} has no target flows that change a step yet: run atticus change architecture ${change.id} first.`,
    );
  const answer = await readStoriesAnswer(dir);
  if (!answer)
    throw new PlannerError(
      "refused",
      `${change.id} has no stories yet (no ${ANSWER_FILE}): run atticus plan stories ${change.id} first.`,
    );
  const ctx = await loadChangeContext(root);
  const estate = await loadEstate(root, ctx.records);
  const items = (await readKnowledge(root)).items.filter(
    (i): i is Process => i.kind === "ProcessDefinition",
  );
  return {
    change,
    dir,
    stories: storiesFromDeltas(deltas, estate),
    answer,
    extras: await storyExtras(ctx, change),
    requests: mergeRequests(answer, deltas, items),
  };
}

export interface StoriesStageResult extends StageResult<StoriesAnswer> {
  stories: DeltaStory[];
  requests: RequestTask[];
}

export async function storiesStage(
  root: string,
  changeId: string,
  o: StageOptions,
): Promise<StoriesStageResult> {
  const change = await changeStore(root)
    .read(changeId)
    .catch((e: Error) => {
      throw new PlannerError("not-found", e.message);
    });
  const dir = changeFolder(root, change.id);
  const rel = `${changesRelOf(root)}/${change.id}`;
  await refuseWhileEarlierStuck(root, await loadChangeContext(root), change, "stories");
  const read = await readDeltas(dir);
  if (read.problems.length)
    throw new PlannerError("refused", `The target flows don't read: ${read.problems.join("; ")}`);
  const empty = read.deltas.filter(isEmptyDelta);
  const deltas = read.deltas.filter((d) => !isEmptyDelta(d));
  if (empty.length && !deltas.length)
    throw new PlannerError(
      "refused",
      `${change.id}'s target flows change no step (${empty.map((d) => d.flow).join(", ")} only say modify): run atticus change architecture ${change.id} again.`,
    );
  if (!deltas.length)
    throw new PlannerError(
      "refused",
      `${change.id} has no target flows yet: run atticus change architecture ${change.id} first.`,
    );
  // Files a person wrote are kept unless forced.
  if (!o.force) {
    const own: string[] = [];
    for (const f of ["stories.md", "tasks.md", "requests.md"]) {
      const t = await readFile(join(dir, f), "utf8").catch(() => undefined);
      if (t !== undefined && !t.startsWith(GENERATED_MARK)) own.push(f);
    }
    if (own.length)
      throw new PlannerError(
        "refused",
        `${change.id} already has planning files a person wrote: ${own.join(", ")}. Re-run with --force to replace them.`,
      );
  }
  const ctx = await loadChangeContext(root);
  const estate = await loadEstate(root, ctx.records);
  const items = (await readKnowledge(root)).items.filter(
    (i): i is Process => i.kind === "ProcessDefinition",
  );
  const stories = storiesFromDeltas(deltas, estate);
  // B-stories: what the completeness check knows, and what each story file says beside the words.
  const sectionCheck: SectionCheckOptions = {
    sections: true,
    known: knownFieldNames(estate, deltas),
    estate,
  };
  const extras = await storyExtras(ctx, change);
  let requests: RequestTask[] = [];
  const now = o.now ?? new Date();
  const store = fileJudgments(root);
  const judging = judgeRuntime(o.runtime);
  const merge = async (a: StoriesAnswer) =>
    mergeRequests(
      a,
      deltas,
      items,
      judging
        ? await judgedRequests(deltas, estate, items, a.requests, {
            runtime: judging,
            store,
            change: change.id,
            now,
          })
        : [],
    );

  const skeletonText = stories
    .map((s) =>
      [
        `story ${s.id}: ${s.change} flow ${s.flow} "${s.name}" in repo ${s.repo}`,
        ...s.tasks.map(
          (t) =>
            `  task ${t.id}: ${t.title}; fields ${t.fields.join(", ") || "none"}; evidence ${t.evidence.join(", ") || "new code"}${t.target ? `; goes to ${t.target}` : ""}${t.store ? `; store ${t.store}` : ""}`,
        ),
      ].join("\n"),
    )
    .join("\n");
  const itemsText = items
    .map(
      (p) =>
        `${p.processKind} ${p.id} "${p.title}": applies when ${p.appliesWhen.replace(/[.\s]+$/, "")}${p.leadTime ? `; lead time ${p.leadTime}` : ""}`,
    )
    .join("\n");
  const sources: SourceInput[] = [
    {
      id: "stories",
      kind: "artifact",
      origin: `${rel}/target-flows (deterministic)`,
      text: skeletonText,
      classification: "internal",
      priority: 100,
    },
    {
      id: "deltas",
      kind: "artifact",
      origin: `${rel}/target-flows/`,
      text: stringify(deltas, { lineWidth: 0 }),
      classification: "internal",
      priority: 90,
    },
    // S2: the values the code allows in the columns of the tables the steps store into.
    ...allowedValuesSource(
      estate,
      deltas.flatMap((d) => d.steps.flatMap((s) => (s.store ? [s.store.table] : []))),
    ),
  ];
  const FORMAT = `Reply with YAML only:

stories:
  - id: <story id, exactly as listed>
    title: <a short title>
    asA: <who>
    iWant: <what>
    soThat: <why>
    context: <what a developer needs that the code doesn't say: a standard, a vendor's rule, a constraint>
    scope:
      in: [<what else this story changes, beyond its tasks>]
      out: [<what a reader might expect that this story does not do>]
    interfaces:    # each entry whose contract changes; or { none: <why> }
      - entry: <METHOD /path, or a topic>
        change: added | changed | removed
        breaking: <true or false>
        why: <why it is breaking or additive>
        consumers: [<component or system ids that call it>]
        fields:
          - { name: <field>, side: request | response | message, type: <type>, required: <true or false>, default: <value>, change: added | changed | removed, validation: <what it accepts and what is refused> }
    data:          # each column a step adds or changes; or { none: <why> }
      - { table: <table id>, column: <column>, type: <database type>, nullable: <true or false>, default: <value>, change: added | changed | removed, migration: <file>, classification: <level>, retention: <how long it is kept> }
    nonFunctional:
      auth: <who may do it, and whether that changes>
      audit: <what is recorded, or why nothing is>
      timeouts: <the timeout and retries of every call the story adds or relies on>
      performance: <the extra work per request, and any limit>
    tests: [<a test file and the cases it gains>]
    dependencies:
      stories: [<story ids of this change that land first>]
      repos: [<repos whose change lands first>]
      notes: [<anything else that happens first: a migration run, a vendor's release>]
    tasks:
      - id: <task id, exactly as listed>
        criteria:
          - text: "Given <situation>, when <action>, then <what can be checked>"
            checks: [<each of the task's fields whose value this criterion's outcome depends on>]
            outcome: success   # or error, for what happens when the step fails
            entry: <the entry it exercises, METHOD /path>
            validation: <error criteria: the rule it relies on>
            rule: <error criteria: required, format, length, range, limit, unique, not-found, forbidden, conflict, unavailable or other>
            status: <error criteria: the status the caller sees>
        tests: [<the test file and cases this task adds>]
requests:      # every request or process from the list below that a step meets
  - item: <process or request id>
    flow: <flow id>
    step: <the step's item number in that flow's target>
    why: <one sentence>
    quote: "<the words of its applies when that the step meets, copied exactly>"

Rules:
- One entry per story and per task listed; don't add or drop any.
- Every task has acceptance criteria a test can check. Each of the task's fields is under the checks of a criterion that checks it; checks name only the task's fields.
- A criterion checks a field when its outcome depends on the field's value: its then clause states the value, or a result that follows from a value its given clause fixes.
- For each key a step matches rows by or checks (its fields.checks), add one criterion of its own for the refusal: what happens when that key doesn't match.
- A task whose step validates, writes, calls out or publishes has at least one criterion with outcome: error: the input rejected and with what message or status, the write failing, the call failing or timing out, and what the caller sees each time.
- Write every section of each story, so a developer builds it without asking. Every line comes from the target flows, the estate or the brief: name only the fields, columns, entries, stories and repos they have.
- Interfaces: list every entry the target flows add (a new flow's trigger, a call to a new entry) and every entry whose request or response fields change, with each field's side, type, required and default; say whether the change breaks its consumers and why.
- Every request field an entry of this repo gains or changes has a validation, and a criterion with outcome: error that checks it, saying the status and message the caller sees.
- Data: every column a step adds, with its type, nullable, default, migration, classification and retention, as the target flow says them; a write that adds a column names its migration.
- Non-functional: auth, audit, the timeout and retries of every call, and the cost per request. Dependencies: the stories and repos that land first, or empty lists.
- Name a request only when the knowledge item's "applies when" fits the step, quoting those words. Never raise it yourself.
- Plain, short English.`;
  const instructions = [
    "# Story writer",
    "",
    `Word the stories of the change "${change.title}" and write each task's acceptance criteria. The stories, tasks, target flows and the organisation's processes are below, as data.`,
    "",
    FORMAT,
    "",
    SELF_CHECK_RULE,
  ].join("\n");

  // The processes the target flows call for (ADR 0107), or every one.
  const processLine = (p: Process) =>
    `${p.processKind} ${p.id} "${p.title}": applies when ${p.appliesWhen.replace(/[.\s]+$/, "")}${p.leadTime ? `; lead time ${p.leadTime}` : ""}`;
  const byId = new Map(items.map((p) => [p.id, p]));
  const whole: SourceInput = {
    id: "processes",
    kind: "document",
    origin: "knowledge/items (ADR 0083)",
    text: itemsText || "No process or request is in the knowledge items.",
    classification: "internal",
    priority: 80,
  };
  // T1/U1: the stories stage selects from the estate too, on every path: its input is the brief,
  // the target flows and the design, and the flows it changes lead to their records. Without the
  // estate it selected only processes, so a draft had no record of the estate at all.
  const brief = await readFile(join(dir, "brief.md"), "utf8").catch(() => "");
  const design = await readFile(join(dir, "design.md"), "utf8").catch(() => "");
  const selected = await estateContext(
    root,
    "stories",
    {
      text: [brief, skeletonText, stringify(deltas, { lineWidth: 0 }), design]
        .filter((x) => x.trim())
        .join("\n\n"),
      title: change.title,
      ids: [...new Set(deltas.map((d) => d.flow))],
    },
    {
      estate,
      budget: stageBudget(ctx, STORY_AGENT),
      others: [instructionSource(instructions), ...sources],
      ...(o.context ? { context: o.context } : {}),
      exclude: [change.id],
      change: change.id,
      ai: stageRetrievalAi(ctx, o, `plan stories ${change.id}`),
      origin: "knowledge/items (ADR 0083)",
      priority: 80,
      knowledge: {
        kinds: ["ProcessDefinition"],
        line: (id) => {
          const p = byId.get(id);
          return p ? processLine(p) : undefined;
        },
        id: "processes",
        origin: "knowledge/items (ADR 0083), selected",
        priority: 80,
        empty: "No process or request in the knowledge items matches the target flows.",
      },
    },
  );
  if (selected && "waiting" in selected)
    return {
      ...retrievalWaiting<StoriesAnswer>(change.id, "stories", selected),
      stories: [],
      requests: [],
    };
  let context: ContextReport = wholeLists();
  if (selected && "sources" in selected) {
    sources.push(...selected.sources);
    context = selected.report;
  } else {
    sources.push(whole, {
      id: "estate-index",
      kind: "catalog",
      origin: "atticus plan stories (deterministic)",
      text: estateIndex(estate),
      classification: "internal",
      priority: 70,
    });
    if (selected) context = { ...context, note: selected.note };
  }

  // V1, V0: the person's answers to the judge's questions settle its judgments, before any draft.
  // A draft's self-check (W3a) writes nothing, so it settles nothing either.
  const settled =
    o.checkDraft !== undefined
      ? { notes: [], decided: new Map<string, DecidedClaim>() }
      : await settleCoversAnswers(root, change.id, dir, {
          ...(judging ? { runtime: judging } : {}),
          store,
          now,
          cap: ctx.policy.questionsPerStop,
          locate: (words) => locateInStories(dir, rel, words),
          rerun: `atticus plan stories ${change.id}`,
        });
  const spec: StageSpec<StoriesAnswer> = {
    stage: "stories",
    agent: STORY_AGENT,
    description:
      "Words a change's stories from its target flows and writes each task's acceptance criteria.",
    output: "stories-answer.yaml",
    source: ANSWER_FILE,
    instructions,
    ...(context.gaps?.length ? { gaps: context.gaps } : {}),
    sources,
    parse: (text) => {
      const r = parseYamlAs(text, Answer, (d) => d, "stories");
      return { ...(r.value ? { answer: r.value } : {}), issues: r.issues };
    },
    check: async (a) => [
      ...checkStories(a, stories, deltas, items, sectionCheck),
      ...(await coverageIssues(unwrittenChecks(a, stories), {
        ...(judging ? { runtime: judging } : {}),
        store,
        change: change.id,
        now,
        decided: settled.decided,
      })),
    ],
    write: async (a) => {
      requests = await merge(a);
      const open = await unjudgedChecks(unwrittenChecks(a, stories), {
        ...(judging ? { runtime: judging } : {}),
        store,
        change: change.id,
        now,
      });
      return writeStories(root, change.id, stories, a, requests, now, open, { ...extras, estate });
    },
    current: () => readStoriesAnswer(dir),
    locate: async (i) => (i.locateText ? locateInStories(dir, rel, i.locateText) : undefined),
  };
  const retrieved = selected && "sources" in selected ? selected : undefined;
  if (retrieved?.retrieval && (retrieved.retrieval.expansion || retrieved.retrieval.rerank))
    spec.retrieval = retrieved.retrieval;
  const res = await runStageLoop(
    root,
    change.id,
    spec,
    retrieved?.consumed || (selected && "consumed" in selected && selected.consumed)
      ? withoutResume(o)
      : o,
  );
  res.context = context;
  await recordKnowledge(root, change.id, "stories", context);
  res.notes.unshift(...settled.notes);
  if (empty.length)
    res.notes.unshift(
      `No story for ${empty.map((d) => `${TARGET_DIR}/${d.flow}.yaml`).join(", ")}: ${empty.length === 1 ? "it is marked modify but changes" : "they are marked modify but change"} no step, so ${empty.length === 1 ? "it is" : "they are"} context, not a change.`,
    );
  if (!change.handoffs.some((h) => h.phase === "design" && h.state === "merged"))
    res.notes.unshift(
      `The architecture PR of ${change.id} isn't merged yet, so these stories rest on target flows a person hasn't approved.`,
    );
  return { ...res, stories, requests: res.answer ? await merge(res.answer) : requests };
}
