import { createHash, randomBytes } from "node:crypto";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import { z } from "zod";
import { writeFileAtomic } from "@maycombhq/core";
import {
  DEPLOY_FILE,
  READS_FILE,
  ReadFlow,
  renderArchitecture,
  renderData,
  TARGET_DIR,
} from "./architecture.js";
import { flowBase } from "./merge.js";
import type { Estate } from "./estate.js";
import { DeployStep, FLOW_DELTA_SCHEMA_VERSION, FlowDelta, type DeltaStep } from "./schema.js";
import { parse } from "yaml";

/**
 * ADR 0179: a change sketched on the canvas. Each stroke a person draws (a new call, a call
 * removed or sent elsewhere, a topic published or listened on, a table read or written, a new
 * box) becomes steps in a flow delta in the change's target-flows/, the files the stages already
 * write and the change diagram draws (ADR 0108). Every drawn step carries a mark in its `why`
 * (`drawn on the canvas by <who>, stroke <id>`), so Undo finds exactly it (a retarget's two
 * steps share one id) and the architecture stage keeps it as drawn. Pure: the caller reads the
 * deltas and writes them back after the person's yes. Nothing here is a fact: a stroke is a plan,
 * reviewed in the change's pull request, and the map changes only when code lands and is read.
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
  /** A stroke taken back: a drawn step, by flow and the step's index in the delta (its whole stroke goes). */
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

/** The mark every drawn step and drawn delta carries in its `why`. */
export const DRAWN = "drawn on the canvas";
const MARK_RE = /drawn on the canvas by (.+?), stroke ([a-z0-9]+)\)?$/i;
const deltaWhy = (by: string) => `Drawn on the canvas by ${by}.`;
const stepWhy = (by: string, id: string, reason?: string) =>
  `${reason ? `${reason} (` : ""}${DRAWN} by ${by}, stroke ${id}${reason ? ")" : ""}`;
export const isDrawnDelta = (d: Pick<FlowDelta, "why">) => d.why.toLowerCase().startsWith(DRAWN);
/** The stroke id a step carries, when a person drew it. */
export const strokeIdOf = (s: Pick<DeltaStep, "why">): string | undefined =>
  MARK_RE.exec(s.why ?? "")?.[2];
export const isDrawnStep = (s: Pick<DeltaStep, "why">) => strokeIdOf(s) !== undefined;
/** The person who drew a step, from its mark. */
export const drawnBy = (s: Pick<DeltaStep, "why">): string | undefined =>
  MARK_RE.exec(s.why ?? "")?.[1];

export const newStrokeId = () => randomBytes(4).toString("hex");

/** The flows a component owns: today's of that component, and the change's new or drawn ones of it. */
function flowsOf(
  deltas: readonly FlowDelta[],
  component: string,
  estate: Pick<Estate, "flows">,
): { id: string; name: string }[] {
  const out = new Map<string, string>();
  for (const f of estate.flows) if (f.flow.component === component) out.set(f.flow.id, f.flow.name);
  for (const d of deltas)
    if (
      !out.has(d.flow) &&
      d.change !== "remove" &&
      (d.runsOn?.component === component ||
        (d.change === "new" && d.flow.startsWith(`${component}.`)))
    )
      out.set(d.flow, d.name ?? d.flow);
  return [...out].map(([id, name]) => ({ id, name }));
}

/** The delta a stroke lands on: an existing one of the change, or a new modify/new delta. */
function deltaFor(
  deltas: FlowDelta[],
  from: z.infer<typeof From>,
  estate: Pick<Estate, "flows" | "ids">,
  by: string,
): { delta: FlowDelta; deltas: FlowDelta[] } | { problem: string; pick?: SketchResult["pick"] } {
  const own = flowsOf(deltas, from.component, estate);
  if (from.newFlow) {
    const id = from.newFlow.id;
    const had = deltas.find((d) => d.flow === id);
    if (had?.change === "remove")
      return {
        problem: `${id} is removed in this change: take the removal back, or draw on another flow.`,
      };
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
      why: deltaWhy(by),
      ...(from.newFlow.runsOn || !estate.ids.has(from.component)
        ? { runsOn: { component: from.component, ...(from.newFlow.runsOn ?? {}) } }
        : {}),
      steps: [],
    };
    return { delta: d, deltas: [...deltas, d] };
  }
  const flowId = from.flow ?? (own.length === 1 ? own[0]!.id : undefined);
  if (!flowId) {
    if (!own.length)
      return {
        problem: `${from.component} has no flow on the map yet: name a new one for the stroke to start.`,
      };
    return {
      problem: `${from.component} has ${own.length} flows: say which the stroke is on.`,
      pick: { flows: own },
    };
  }
  if (from.flow && !own.some((f) => f.id === from.flow))
    return { problem: `${from.flow} isn't a flow of ${from.component}.` };
  const had = deltas.find((d) => d.flow === flowId);
  if (had?.change === "remove")
    return {
      problem: `${flowId} is removed in this change: take the removal back, or draw on another flow.`,
    };
  if (had) return { delta: had, deltas };
  const today = estate.flows.find((f) => f.flow.id === flowId);
  if (!today) return { problem: `No flow of today's map is ${flowId}.` };
  const d: FlowDelta = {
    schemaVersion: FLOW_DELTA_SCHEMA_VERSION,
    flow: flowId,
    repo: today.repo,
    change: "modify",
    why: deltaWhy(by),
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
  strokeId: string = newStrokeId(),
): SketchResult {
  const before = deltas.map((d) => ({ ...d, steps: [...d.steps] }));
  const replace = (all: FlowDelta[], d: FlowDelta, step: DeltaStep): FlowDelta[] =>
    all.map((x) => (x.flow === d.flow ? { ...x, steps: [...x.steps, step] } : x));
  const stepWhat = (what: string | undefined, fallback: string) => what ?? fallback;
  const why = (reason?: string) => stepWhy(by, strokeId, reason);
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
        why: why(),
      };
      return { deltas: replace(r.deltas, r.delta, step), changed: [r.delta.flow] };
    }
    case "topic": {
      const r = deltaFor(before, stroke.from, estate, by);
      if ("problem" in r) return { deltas: before, changed: [], ...r };
      // Where the publish goes: the listener, when one is drawn; a topic with no listener yet
      // names no component (a line to itself would draw a loop).
      const pub: DeltaStep = {
        op: "add",
        kind: "publish",
        what: stepWhat(stroke.what, `Publishes ${stroke.topic}.`),
        ...(stroke.listener && stroke.listener.component !== stroke.from.component
          ? { to: { component: stroke.listener.component, entry: stroke.topic, new: false } }
          : {}),
        why: why(),
      };
      let all = replace(r.deltas, r.delta, pub);
      const changed = [r.delta.flow];
      if (stroke.listener) {
        const l = deltaFor(all, stroke.listener, estate, by);
        if ("problem" in l) return { deltas: before, changed: [], ...l };
        // The listener's step is an entry (a message arrives); it goes nowhere, so no `to`.
        const listen: DeltaStep = {
          op: "add",
          kind: "entry",
          what: `Listens on ${stroke.topic}.`,
          why: why(),
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
        why: why(),
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
      if (d?.change === "remove")
        return {
          deltas: before,
          changed: [],
          problem: `${stroke.flow} is removed in this change: take the removal back, or draw on another flow.`,
        };
      if (!d) {
        d = {
          schemaVersion: FLOW_DELTA_SCHEMA_VERSION,
          flow: stroke.flow,
          repo: today.repo,
          change: "modify",
          why: deltaWhy(by),
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
      all = replace(all, d, { op: "remove", step: stroke.step, why: why(stroke.why) });
      if (stroke.kind === "retarget")
        all = replace(all, d, {
          op: "add",
          after: stroke.step,
          kind: was.kind,
          what: was.what,
          to: { component: stroke.to.component, entry: stroke.to.entry, new: !!stroke.to.new },
          why: why(stroke.why),
        });
      return { deltas: all, changed: [stroke.flow] };
    }
    case "undo": {
      const d = before.find((x) => x.flow === stroke.flow);
      const s = d?.steps[stroke.index];
      const id = s ? strokeIdOf(s) : undefined;
      if (!d || !s || !id)
        return {
          deltas: before,
          changed: [],
          problem: s
            ? `Step ${stroke.index} of ${stroke.flow} wasn't drawn on the canvas: the stage wrote it, so edit the file or run the stage again.`
            : `${stroke.flow} has no step ${stroke.index} to take back.`,
        };
      // The whole stroke goes (a retarget is two steps), on every flow it touched.
      const all = before
        .map((x) => ({ ...x, steps: x.steps.filter((y) => strokeIdOf(y) !== id) }))
        // A delta drawn here with nothing left goes; one the stage wrote stays, empty or not.
        .filter((x) => !(x.steps.length === 0 && isDrawnDelta(x)));
      const changed = before
        .filter((x) => x.steps.some((y) => strokeIdOf(y) === id))
        .map((x) => x.flow);
      return { deltas: all, changed };
    }
  }
}

/** The strokes drawn so far, for Undo: one entry per stroke, with the first step's place. */
export function drawnStrokes(
  deltas: readonly FlowDelta[],
): { flow: string; index: number; what: string; by?: string }[] {
  const out: { flow: string; index: number; what: string; by?: string }[] = [];
  const seen = new Set<string>();
  for (const d of deltas)
    d.steps.forEach((s, index) => {
      const id = strokeIdOf(s);
      if (!id || seen.has(id)) return;
      seen.add(id);
      const pair = d.steps.find((y, j) => j !== index && strokeIdOf(y) === id);
      const what =
        s.op === "remove"
          ? pair?.to
            ? `step ${s.step} sent to ${pair.to.component} ${pair.to.entry}`
            : `step ${s.step} removed`
          : `${s.kind ?? s.op}${s.to ? ` → ${s.to.component} ${s.to.entry}` : ""}${s.store ? ` ${s.store.table}` : ""}`;
      const by = drawnBy(s);
      out.push({ flow: d.flow, index, what, ...(by ? { by } : {}) });
    });
  return out;
}

/** The deltas with only their drawn steps: the frame the architecture stage keeps (SKETCH_RULE). */
export function sketchOf(deltas: readonly FlowDelta[]): FlowDelta[] {
  return deltas
    .map((d) => ({ ...d, steps: d.steps.filter(isDrawnStep) }))
    .filter((d) => d.steps.length || isDrawnDelta(d));
}

/** A delta file's text as the sketch writes it: the stage's header, by this person. */
export function renderSketchDelta(d: FlowDelta, estate: Pick<Estate, "flowById">, by: string) {
  const today = d.change === "new" ? undefined : estate.flowById.get(d.flow)?.flow;
  const pinned: FlowDelta = {
    ...d,
    schemaVersion: FLOW_DELTA_SCHEMA_VERSION,
    ...(today ? { base: { steps: flowBase(today) } } : {}),
  };
  return `# The target of flow ${d.flow} (ADR 0087): the steps this change adds, changes or removes. Drafted by ${by}; base pins the version of today's flow it was written against (ADR 0111).\n${stringify(FlowDelta.parse(pinned), { lineWidth: 0 })}`;
}

const MARK = "<!-- Generated by atticus change architecture";

export interface SketchFile {
  /** Relative to the change folder. */
  file: string;
  /** The text after; left out when the file goes. */
  now?: string;
}

/**
 * The files a stroke changes, as the write makes them: the changed flows' delta files (others
 * untouched, their headers kept) and, where Atticus wrote them, design.md and data.md rendered
 * from every delta. The preview shows exactly these; writeSketch writes exactly these.
 */
export async function planSketchWrite(
  dir: string,
  deltas: readonly FlowDelta[],
  changed: readonly string[],
  estate: Estate,
  by: string,
): Promise<SketchFile[]> {
  const out: SketchFile[] = [];
  for (const flow of [...new Set(changed)]) {
    const d = deltas.find((x) => x.flow === flow);
    out.push({
      file: `${TARGET_DIR}/${flow}.yaml`,
      ...(d ? { now: renderSketchDelta(d, estate, by) } : {}),
    });
  }
  const read = async (f: string) => readFile(join(dir, f), "utf8").catch(() => undefined);
  const design = await read("design.md");
  if (design === undefined || design.startsWith(MARK)) {
    const t = await read(READS_FILE);
    const reads = t === undefined ? undefined : z.array(ReadFlow).safeParse(parse(t)?.reads);
    const dt = await read(DEPLOY_FILE);
    const deploy = dt === undefined ? undefined : z.array(DeployStep).safeParse(parse(dt)?.deploy);
    const all = deltas.filter((d) => d.steps.length || d.change !== "modify");
    const now = renderArchitecture(
      all,
      estate,
      reads?.success ? reads.data : [],
      deploy?.success && deploy.data.length ? deploy.data : undefined,
    );
    if (now !== design) out.push({ file: "design.md", now });
  }
  const data = await read("data.md");
  if (data === undefined || data.startsWith(MARK)) {
    const now = renderData([...deltas], estate);
    if (now && now !== data) out.push({ file: "data.md", now });
    else if (!now && data?.startsWith(MARK)) out.push({ file: "data.md" });
  }
  return out;
}

/** Writes what planSketchWrite planned, nothing else. */
export async function writeSketch(dir: string, files: readonly SketchFile[]): Promise<void> {
  for (const f of files) {
    const path = join(dir, ...f.file.split("/"));
    if (f.now === undefined) await rm(path, { force: true });
    else await writeFileAtomic(path, f.now);
  }
}

/** A fingerprint of the files a stroke reads and writes, so a write can refuse files that changed since the preview. */
export async function sketchFingerprint(dir: string): Promise<string> {
  const h = createHash("sha256");
  const take = async (rel: string) => {
    h.update(rel);
    h.update("\0");
    h.update(await readFile(join(dir, ...rel.split("/")), "utf8").catch(() => ""));
    h.update("\0");
  };
  for (const f of (await readdir(join(dir, TARGET_DIR)).catch(() => [] as string[])).sort())
    if (f.endsWith(".yaml")) await take(`${TARGET_DIR}/${f}`);
  // Everything the write renders from, so the write is the preview, design.md included.
  for (const f of [READS_FILE, DEPLOY_FILE, "design.md", "data.md"]) await take(f);
  return h.digest("hex").slice(0, 16);
}

export const sketchSlug = slug;
export { FlowDelta as SketchDelta };
