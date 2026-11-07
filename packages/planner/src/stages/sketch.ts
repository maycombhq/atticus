import { z } from "zod";
import type { Estate } from "./estate.js";
import { FLOW_DELTA_SCHEMA_VERSION, FlowDelta, type DeltaStep } from "./schema.js";

/**
 * ADR 0179: a change sketched on the canvas. Each stroke a person draws (a new call, a call
 * removed or sent elsewhere, a topic published or listened on, a table read or written, a new
 * box) becomes a flow delta in the change's target-flows/, the files the stages already write
 * and the change diagram draws (ADR 0108). Pure: the caller reads the deltas and writes them
 * back after the person's yes. Nothing here is a fact: a stroke is a plan, reviewed in the
 * change's pull request, and the map changes only when code lands and is read.
 */

const Id = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "an id is lower case: letters, digits, . _ -");
const text = () => z.string().trim().min(1).max(500);

/** Where a stroke starts: a flow of the change (modify), or a new one of a component. */
const From = z.object({
  component: Id,
  /** The flow the step goes on; left out when the component has one flow, or a new one is named. */
  flow: Id.optional(),
  /** A new flow (the component has none fitting, or is new): what a person calls it, and what starts it. */
  newFlow: z
    .object({
      id: Id,
      name: text(),
      trigger: z.object({
        kind: z.enum(["endpoint", "action", "page", "listener", "job"]),
        what: text(),
        entry: z.string().trim().min(1).optional(),
      }),
      /** A component the catalog doesn't have yet: where it runs (ADR 0132), drawn as a new box. */
      runsOn: z
        .object({
          system: Id.optional(),
          platform: z.string().trim().min(1).optional(),
          cloud: z.string().trim().min(1).optional(),
          framework: z.string().trim().min(1).optional(),
        })
        .optional(),
    })
    .optional(),
});

export const Stroke = z.discriminatedUnion("kind", [
  /** A line from a component to another's API: a call-out step. */
  z.object({
    kind: z.literal("call"),
    from: From,
    to: z.object({
      component: Id,
      /** An Endpoint id, "METHOD /path" or a topic; `new` when the API doesn't exist yet. */
      entry: text(),
      new: z.boolean().optional(),
    }),
    what: text().optional(),
    /** The step it goes after (0: first); left out, the end of the flow. */
    after: z.number().int().min(0).optional(),
  }),
  /** A topic a component publishes, and (optionally) a component that listens. */
  z.object({
    kind: z.literal("topic"),
    from: From,
    topic: text(),
    listener: From.optional(),
    what: text().optional(),
  }),
  /** A table a step reads or writes. */
  z.object({
    kind: z.literal("table"),
    from: From,
    op: z.enum(["read", "write", "lookup"]),
    table: Id,
    columns: z.array(z.string().trim().min(1)).default([]),
    new: z.boolean().optional(),
    what: text().optional(),
  }),
  /** A step of today's flow taken out (a line deleted). */
  z.object({ kind: z.literal("remove"), flow: Id, step: z.number().int().positive(), why: text() }),
  /** A step of today's flow sent elsewhere (a line's end dragged): removed, and added to the new target. */
  z.object({
    kind: z.literal("retarget"),
    flow: Id,
    step: z.number().int().positive(),
    to: z.object({ component: Id, entry: text(), new: z.boolean().optional() }),
    why: text(),
  }),
  /** A stroke taken back: the delta step it made, by flow and the step's index in the delta. */
  z.object({ kind: z.literal("undo"), flow: Id, index: z.number().int().min(0) }),
]);
export type Stroke = z.infer<typeof Stroke>;

export interface SketchResult {
  deltas: FlowDelta[];
  /** The flows (delta files) the stroke changed. */
  changed: string[];
  /** Why the stroke couldn't be drawn; the deltas are as before. */
  problem?: string;
  /** When the component has several flows and none was named: which to pick from. */
  pick?: { flows: { id: string; name: string }[] };
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

/** The delta a stroke lands on: an existing one of the change, or a new modify/new delta. */
function deltaFor(
  deltas: FlowDelta[],
  from: z.infer<typeof From>,
  estate: Pick<Estate, "flows" | "ids">,
  by: string,
): { delta: FlowDelta; deltas: FlowDelta[] } | { problem: string; pick?: SketchResult["pick"] } {
  const own = estate.flows.filter((f) => f.flow.component === from.component);
  if (from.newFlow) {
    const id = from.newFlow.id;
    const had = deltas.find((d) => d.flow === id);
    if (had) return { delta: had, deltas };
    if (estate.flows.some((f) => f.flow.id === id))
      return { problem: `${id} is a flow of today's map already: draw on it, not a new one.` };
    const d: FlowDelta = {
      schemaVersion: FLOW_DELTA_SCHEMA_VERSION,
      flow: id,
      repo: repoOf(estate, from.component) ?? from.component,
      change: "new",
      name: from.newFlow.name,
      trigger: from.newFlow.trigger,
      why: `Drawn on the canvas by ${by}.`,
      ...(from.newFlow.runsOn || !estate.ids.has(from.component)
        ? { runsOn: { component: from.component, ...(from.newFlow.runsOn ?? {}) } }
        : {}),
      steps: [],
    };
    return { delta: d, deltas: [...deltas, d] };
  }
  const flowId =
    from.flow ??
    (deltas.filter((d) => d.repo === repoOf(estate, from.component) && d.change !== "remove")
      .length === 1 && own.length <= 1
      ? deltas.find((d) => d.repo === repoOf(estate, from.component))?.flow
      : own.length === 1
        ? own[0]!.flow.id
        : undefined);
  if (!flowId) {
    if (!own.length)
      return {
        problem: `${from.component} has no flow on the map yet: name a new one for the stroke to start.`,
      };
    return {
      problem: `${from.component} has ${own.length} flows: say which the stroke is on.`,
      pick: { flows: own.map((f) => ({ id: f.flow.id, name: f.flow.name })) },
    };
  }
  const had = deltas.find((d) => d.flow === flowId);
  if (had) return { delta: had, deltas };
  const today = estate.flows.find((f) => f.flow.id === flowId);
  if (!today) return { problem: `No flow of today's map is ${flowId}.` };
  const d: FlowDelta = {
    schemaVersion: FLOW_DELTA_SCHEMA_VERSION,
    flow: flowId,
    repo: today.repo,
    change: "modify",
    why: `Drawn on the canvas by ${by}.`,
    steps: [],
  };
  return { delta: d, deltas: [...deltas, d] };
}

const repoOf = (estate: Pick<Estate, "flows">, component: string) =>
  estate.flows.find((f) => f.flow.component === component)?.repo;

/** A stroke applied to the change's deltas: the deltas after, and which flows changed. */
export function applyStroke(
  deltas: readonly FlowDelta[],
  stroke: Stroke,
  estate: Pick<Estate, "flows" | "ids">,
  by: string,
): SketchResult {
  const before = deltas.map((d) => ({ ...d, steps: [...d.steps] }));
  const replace = (all: FlowDelta[], d: FlowDelta, step: DeltaStep): FlowDelta[] =>
    all.map((x) => (x.flow === d.flow ? { ...x, steps: [...x.steps, step] } : x));
  const stepWhat = (what: string | undefined, fallback: string) => what ?? fallback;
  switch (stroke.kind) {
    case "call": {
      const r = deltaFor(before, stroke.from, estate, by);
      if ("problem" in r) return { deltas: before, changed: [], ...r };
      const step: DeltaStep = {
        op: "add",
        ...(stroke.after !== undefined ? { after: stroke.after } : {}),
        kind: "call-out",
        what: stepWhat(stroke.what, `Calls ${stroke.to.component}'s ${stroke.to.entry}.`),
        to: { component: stroke.to.component, entry: stroke.to.entry, new: !!stroke.to.new },
      };
      return { deltas: replace(r.deltas, r.delta, step), changed: [r.delta.flow] };
    }
    case "topic": {
      const r = deltaFor(before, stroke.from, estate, by);
      if ("problem" in r) return { deltas: before, changed: [], ...r };
      const pub: DeltaStep = {
        op: "add",
        kind: "publish",
        what: stepWhat(stroke.what, `Publishes ${stroke.topic}.`),
        to: {
          component: stroke.listener?.component ?? stroke.from.component,
          entry: stroke.topic,
          new: false,
        },
      };
      let all = replace(r.deltas, r.delta, pub);
      const changed = [r.delta.flow];
      if (stroke.listener) {
        const l = deltaFor(all, stroke.listener, estate, by);
        if ("problem" in l) return { deltas: before, changed: [], ...l };
        const listen: DeltaStep = {
          op: "add",
          kind: "entry",
          what: `Listens on ${stroke.topic}.`,
          to: { component: stroke.from.component, entry: stroke.topic, new: false },
        };
        all = replace(l.deltas, l.delta, listen);
        changed.push(l.delta.flow);
      }
      return { deltas: all, changed };
    }
    case "table": {
      const r = deltaFor(before, stroke.from, estate, by);
      if ("problem" in r) return { deltas: before, changed: [], ...r };
      const step: DeltaStep = {
        op: "add",
        kind: stroke.op,
        what: stepWhat(
          stroke.what,
          `${stroke.op === "write" ? "Writes" : "Reads"} ${stroke.table}${stroke.columns.length ? ` (${stroke.columns.join(", ")})` : ""}.`,
        ),
        store: { table: stroke.table, columns: stroke.columns, new: !!stroke.new },
      };
      return { deltas: replace(r.deltas, r.delta, step), changed: [r.delta.flow] };
    }
    case "remove":
    case "retarget": {
      const today = estate.flows.find((f) => f.flow.id === stroke.flow);
      if (!today)
        return {
          deltas: before,
          changed: [],
          problem: `No flow of today's map is ${stroke.flow}.`,
        };
      const was = today.flow.steps[stroke.step - 1];
      if (!was)
        return {
          deltas: before,
          changed: [],
          problem: `${stroke.flow} has no step ${stroke.step}.`,
        };
      let all = before;
      let d = all.find((x) => x.flow === stroke.flow);
      if (!d) {
        d = {
          schemaVersion: FLOW_DELTA_SCHEMA_VERSION,
          flow: stroke.flow,
          repo: today.repo,
          change: "modify",
          why: `Drawn on the canvas by ${by}.`,
          steps: [],
        };
        all = [...all, d];
      }
      if (d.steps.some((s) => s.op !== "add" && s.step === stroke.step))
        return {
          deltas: before,
          changed: [],
          problem: `Step ${stroke.step} of ${stroke.flow} is changed already in this change.`,
        };
      all = replace(all, d, { op: "remove", step: stroke.step, why: stroke.why });
      if (stroke.kind === "retarget")
        all = replace(all, d, {
          op: "add",
          after: stroke.step,
          kind: was.kind,
          what: was.what,
          to: { component: stroke.to.component, entry: stroke.to.entry, new: !!stroke.to.new },
          why: stroke.why,
        });
      return { deltas: all, changed: [stroke.flow] };
    }
    case "undo": {
      const d = before.find((x) => x.flow === stroke.flow);
      if (!d || !d.steps[stroke.index])
        return {
          deltas: before,
          changed: [],
          problem: `${stroke.flow} has no step ${stroke.index} to take back.`,
        };
      const steps = d.steps.filter((_, i) => i !== stroke.index);
      // A delta drawn here with nothing left goes; one the stage wrote stays, empty or not.
      const all =
        steps.length === 0 && d.why.startsWith("Drawn on the canvas")
          ? before.filter((x) => x.flow !== d.flow)
          : before.map((x) => (x.flow === d.flow ? { ...x, steps } : x));
      return { deltas: all, changed: [stroke.flow] };
    }
  }
}

/** The delta files as text, as writeTargetFlows writes them (for a preview's line diff). */
export const deltaFileName = (flow: string) => `target-flows/${flow}.yaml`;

export { FlowDelta as SketchDelta };
export const sketchSlug = slug;
