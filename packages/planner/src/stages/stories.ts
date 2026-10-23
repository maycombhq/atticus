import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { changesRelOf, type RecordOf } from "@maycombhq/core";
import type { SourceInput } from "@maycombhq/ai";
import { changeFolder, changeStore, loadChangeContext, writeFileAtomic } from "@maycombhq/changes";
import { readKnowledge } from "@maycombhq/knowledge";
import { mergeStoryRequests } from "../needs.js";
import { looksPersonal } from "@maycombhq/naysayer";
import { PlannerError } from "../errors.js";
import { instructionSource, wholeLists, type ContextReport } from "../engine.js";
import { estateContext } from "./estate-context.js";
import { GENERATED_MARK } from "../render.js";
import { contentWords, slug } from "../words.js";
import { parseYamlAs } from "./answer.js";
import { isEmptyDelta, readDeltas, TARGET_DIR } from "./architecture.js";
import { columnsOf, loadEstate, type Estate } from "./estate.js";
import {
  runStageLoop,
  stageBudget,
  type StageIssue,
  type StageOptions,
  type StageResult,
  type StageSpec,
} from "./loop.js";
import type { DeltaStep, FlowDelta } from "./schema.js";

/**
 * `atticus plan stories <change>` on a change with target flows (ADR 0087, plan 4.4): stories
 * per repo from the flow deltas, one per flow, and a task per changed step, each with the
 * fields and evidence it touches and the prompt to implement it in Copilot or Claude Code.
 * Which stories and tasks there are is decided from the deltas, without AI; the assistant
 * words them and writes each task's acceptance criteria. The change tasks and service
 * requests the change needs are suggested from the knowledge items (ADR 0083): a step whose
 * kind and target meet a request's "applies when" suggests it, citing the item's quote and
 * the step. A person raises them; Atticus never does.
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
}

export interface DeltaStory {
  id: string;
  repo: string;
  flow: string;
  name: string;
  change: FlowDelta["change"];
  tasks: DeltaTask[];
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
  by: "match" | "assistant";
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
        const fields = [
          ...new Set([...Object.values(s.fields ?? {}).flat(), ...(s.store?.columns ?? [])]),
        ];
        const n = (counter.get(repo) ?? 0) + 1;
        counter.set(repo, n);
        const verb = s.op === "add" ? "Add" : s.op === "change" ? "Change" : "Remove";
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
        });
      });
      stories.push({ id, repo, flow: d.flow, name, change: d.change, tasks });
    }
  return stories;
}

/** The words a step brings to the knowledge items' "applies when". */
function stepWords(d: FlowDelta, s: DeltaStep, e: Estate): Set<string> {
  const today = e.flowById.get(d.flow)?.flow;
  const kind = s.kind ?? (s.step ? today?.steps[s.step - 1]?.kind : undefined);
  const extra: string[] = [];
  if (kind === "call-out") extra.push("call", "reach", "outbound", "send");
  if (kind === "publish") extra.push("publish", "event", "topic", "queue", "message", "broker");
  if (kind === "write") extra.push("write", "store", "stores", "table");
  if (s.to) {
    const target = e.byId.get(s.to.component) as
      { kind?: string; boundary?: string; system?: string } | undefined;
    const system =
      target?.kind === "System"
        ? target
        : (e.byId.get(target?.system ?? "") as { boundary?: string } | undefined);
    if (system?.boundary === "vendor")
      extra.push(
        "vendor",
        "external",
        "partner",
        "third-party",
        "outside",
        "host",
        "network",
        "internet",
      );
    if (s.to.new) extra.push("new");
  }
  if (s.store) {
    const have = columnsOf(e, s.store.table);
    const added = s.store.new ? s.store.columns : s.store.columns.filter((c) => !have.has(c));
    if (s.store.new) extra.push("new", "table");
    if (added.length) extra.push("new", "column", "columns");
    if (added.some((c) => looksPersonal(c))) extra.push("personal", "data");
  }
  return new Set(contentWords(`${s.what ?? ""} ${extra.join(" ")}`));
}

const WEAK = new Set(contentWords("new change service system data make step flow"));

/** Requests and processes the knowledge items say the deltas need, deterministically. */
export function suggestRequests(deltas: FlowDelta[], e: Estate, items: Process[]): RequestTask[] {
  const out: RequestTask[] = [];
  for (const d of deltas)
    d.steps.forEach((s, i) => {
      if (s.op === "remove") return;
      const have = stepWords(d, s, e);
      for (const p of items) {
        const want = contentWords(`${p.appliesWhen} ${p.title}`).filter((w) => !WEAK.has(w));
        const shared = want.filter((w) => have.has(w));
        if (shared.length < 2) continue;
        if (out.some((x) => x.item === p.id && x.flow === d.flow && x.step === i + 1)) continue;
        out.push(
          requestTask(
            p,
            d,
            i + 1,
            s,
            `The step meets "${p.appliesWhen}" (${shared.join(", ")}).`,
            "match",
          ),
        );
      }
    });
  return out.map((r, i) => ({ ...r, id: `R${i + 1}` }));
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

const Answer = z.strictObject({
  stories: z
    .array(
      z.strictObject({
        id: z.string(),
        title: z.string().trim().min(1),
        asA: z.string().trim().min(1),
        iWant: z.string().trim().min(1),
        soThat: z.string().trim().min(1),
        tasks: z
          .array(
            z.strictObject({
              id: z.string(),
              criteria: z.array(z.string().trim().min(1)).default([]),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
  requests: z
    .array(
      z.strictObject({
        item: z.string(),
        flow: z.string(),
        step: z.number().int().positive(),
        why: z.string().trim().min(1),
      }),
    )
    .default([]),
});
export type StoriesAnswer = z.infer<typeof Answer>;

export function checkStories(
  a: StoriesAnswer,
  stories: DeltaStory[],
  deltas: FlowDelta[],
  items: Process[],
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
      else if (
        t.fields.length &&
        !c.some((x) => t.fields.some((f) => x.toLowerCase().includes(f.toLowerCase())))
      )
        issue(
          "stories.fields-not-named",
          t.id,
          `Task ${t.id}'s criteria name none of the fields it touches (${t.fields.join(", ")}).`,
          t.repo,
        );
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
    const d = deltas.find((x) => x.flow === r.flow);
    if (!d || !d.steps[r.step - 1])
      issue(
        "stories.unknown-step",
        `${r.flow}#${r.step}`,
        `Request ${r.item} cites step ${r.step} of ${r.flow}, which the target flows don't have.`,
      );
  }
  return out;
}

const sentence = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

export function taskPrompt(
  change: string,
  s: DeltaStory,
  t: DeltaTask,
  criteria: string[],
): string {
  return [
    `Implement task ${t.id} of the change ${change} in the repo ${t.repo}.`,
    `Flow ${s.flow} (${s.name}): ${t.op} the ${t.kind ?? "step"} step${t.op === "add" ? "" : ` (step ${t.position} of the target flow)`}. ${sentence(t.what)}`,
    ...(t.target ? [`It goes to ${t.target}.`] : []),
    ...(t.store ? [`It uses ${t.store}.`] : []),
    ...(t.fields.length ? [`Fields: ${t.fields.join(", ")}.`] : []),
    ...(t.evidence.length
      ? [`Today's code is at ${t.evidence.join(", ")}; read it first.`]
      : ["This is new code; follow the repo's patterns for its neighbours."]),
    "Acceptance criteria:",
    ...criteria.map((c) => `- ${c}`),
    "Change only this repo. Write a test for each criterion. Never push to a protected branch.",
  ].join("\n");
}

function renderStoryFile(
  change: string,
  s: DeltaStory,
  w: StoriesAnswer["stories"][number],
): string {
  const lines = [
    `${GENERATED_MARK} stories from the target flows (target-flows/). Edit the wording freely; tasks, fields and evidence come from the flows. -->`,
    `# ${w.title}`,
    "",
    `As ${/^[aeiou]/i.test(w.asA) ? "an" : "a"} ${w.asA} I want ${w.iWant} so that ${sentence(w.soThat)}`,
    "",
    "## Acceptance criteria",
    "",
  ];
  const crit = s.tasks.flatMap((t) => w.tasks.find((x) => x.id === t.id)?.criteria ?? []);
  lines.push(...(crit.length ? crit.map((c) => `- ${sentence(c)}`) : ["- None yet."]), "");
  lines.push(
    "## Traces to",
    "",
    `target-flows/${s.flow}.yaml (${s.change} flow ${s.flow}: ${s.name})`,
    "",
  );
  lines.push("## Systems and repos", "", s.repo, "", "## Tasks", "");
  for (const t of s.tasks) {
    const c = w.tasks.find((x) => x.id === t.id)?.criteria ?? [];
    lines.push(
      `### Task ${t.id}: ${t.title}`,
      "",
      `- Step: ${t.op} (${t.kind ?? "step"}), item ${t.position} of target-flows/${s.flow}.yaml`,
      `- Fields: ${t.fields.join(", ") || "none"}`,
      `- Evidence: ${t.evidence.join(", ") || "new code"}`,
      ...(t.target ? [`- Goes to: ${t.target}`] : []),
      ...(t.store ? [`- Store: ${t.store}`] : []),
      "- Acceptance criteria:",
      ...(c.length ? c.map((x) => `  - ${sentence(x)}`) : ["  - None yet."]),
      "",
      "Prompt for Copilot or Claude Code:",
      "",
      "```text",
      taskPrompt(change, s, t, c),
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
    ...stories.map(
      (s) =>
        `| ${s.id} | ${(a.stories.find((x) => x.id === s.id)?.title ?? s.name).replace(/\|/g, "\\|")} | ${s.repo} |  |`,
    ),
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
      `  - Suggested by: ${r.by === "match" ? "Atticus, from the item's applies-when" : "your assistant"}`,
    );
  }
  lines.push("");
  return lines.join("\n");
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
  const matched = suggestRequests(deltas, estate, items);
  let requests = matched;
  /** Atticus's matches, then the assistant's extra ones that cite a real item and step. */
  const merge = (a: StoriesAnswer): RequestTask[] => {
    const all = [...matched];
    for (const r of a.requests) {
      const p = items.find((x) => x.id === r.item);
      const d = deltas.find((x) => x.flow === r.flow);
      const s = d?.steps[r.step - 1];
      if (
        !p ||
        !d ||
        !s ||
        all.some((x) => x.item === r.item && x.flow === r.flow && x.step === r.step)
      )
        continue;
      all.push(requestTask(p, d, r.step, s, r.why, "assistant"));
    }
    return all.map((r, i) => ({ ...r, id: `R${i + 1}` }));
  };

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
    {
      id: "suggested",
      kind: "artifact",
      origin: "atticus plan stories (deterministic)",
      text:
        matched.map((r) => `${r.item} for ${r.flow} step ${r.step}: ${r.why}`).join("\n") ||
        "None.",
      classification: "internal",
      priority: 70,
    },
  ];
  const FORMAT = `Reply with YAML only:

stories:
  - id: <story id, exactly as listed>
    title: <a short title>
    asA: <who>
    iWant: <what>
    soThat: <why>
    tasks:
      - id: <task id, exactly as listed>
        criteria:
          - "Given <situation>, when <action>, then <what can be checked>"
requests:      # only requests or processes Atticus didn't already suggest, from the list below
  - item: <process or request id>
    flow: <flow id>
    step: <the step's item number in that flow's target>
    why: <one sentence>

Rules:
- One entry per story and per task listed; don't add or drop any.
- Every task has acceptance criteria a test can check, and names the fields it touches.
- Suggest a request only when the knowledge item's "applies when" fits the step. Never raise it yourself.
- Plain, short English.`;
  const instructions = [
    "# Story writer",
    "",
    `Word the stories of the change "${change.title}" and write each task's acceptance criteria. The stories, tasks, target flows and the organisation's processes are below, as data.`,
    "",
    FORMAT,
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
  const selected = await estateContext(
    root,
    "stories",
    { text: [skeletonText, stringify(deltas, { lineWidth: 0 })].join("\n\n"), title: change.title },
    {
      budget: stageBudget(ctx, STORY_AGENT),
      others: [instructionSource(instructions), ...sources],
      ...(o.context ? { context: o.context } : {}),
      exclude: [change.id],
      change: change.id,
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
  let context: ContextReport = wholeLists();
  if (selected && "sources" in selected) {
    sources.push(...selected.sources);
    context = selected.report;
  } else {
    sources.push(whole);
    if (selected) context = { ...context, note: selected.note };
  }

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
    check: async (a) => checkStories(a, stories, deltas, items),
    write: async (a) => {
      requests = merge(a);
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
        await writeFileAtomic(join(dir, "stories", `${s.id}.md`), renderStoryFile(change.id, s, w));
        files.push(`stories/${s.id}.md`);
      }
      await writeFileAtomic(join(dir, "stories.md"), renderIndex(stories, a));
      await writeFileAtomic(join(dir, "tasks.md"), renderTasks(stories, requests));
      await writeFileAtomic(join(dir, "requests.md"), renderRequests(requests));
      // ADR 0101: the same requests join the change's needs, beside what change needs found.
      await mergeStoryRequests(root, change.id, requests, o.now ?? new Date());
      await writeFileAtomic(
        join(dir, ...ANSWER_FILE.split("/")),
        `# The story writer's last answer (ADR 0087).\n${stringify(a, { lineWidth: 0 })}`,
      );
      return [...files, "stories.md", "tasks.md", "requests.md", "needs.yaml", "needs.md"];
    },
    current: async () => {
      const t = await readFile(join(dir, ...ANSWER_FILE.split("/")), "utf8").catch(() => undefined);
      if (t === undefined) return undefined;
      const r = Answer.safeParse(parse(t));
      return r.success ? r.data : undefined;
    },
  };
  const res = await runStageLoop(root, change.id, spec, o);
  res.context = context;
  if (empty.length)
    res.notes.unshift(
      `No story for ${empty.map((d) => `${TARGET_DIR}/${d.flow}.yaml`).join(", ")}: ${empty.length === 1 ? "it is marked modify but changes" : "they are marked modify but change"} no step, so ${empty.length === 1 ? "it is" : "they are"} context, not a change.`,
    );
  if (!change.handoffs.some((h) => h.phase === "design" && h.state === "merged"))
    res.notes.unshift(
      `The architecture PR of ${change.id} isn't merged yet, so these stories rest on target flows a person hasn't approved.`,
    );
  return { ...res, stories, requests: res.answer ? merge(res.answer) : requests };
}
