import type { Api } from "@maycombhq/core";

/**
 * A flow (ADR 0079) as a sequence diagram (ADR 0092): a lane for who starts it, the gateway it
 * comes through, the component it runs in, and each component, table and topic its steps reach;
 * then one row per step, in order, with the data, the citation and who confirmed it. Loops and
 * retries are frames around the steps they repeat (ADR 0095). A change's target flow is the same
 * picture with each step marked added, changed or removed, so before and after show at once.
 * Pure functions of the API's views, so the screen only draws.
 */

export type LaneKind = "caller" | "gateway" | "self" | "component" | "store" | "topic";

export interface Lane {
  id: string;
  label: string;
  kind: LaneKind;
  /** A component or table the change adds. */
  isNew?: boolean;
}

export type Mark = "same" | "changed" | "added" | "removed";

/** One frame a row is inside: its nesting depth, and whether the row opens or closes it. */
export interface RowFrame {
  depth: number;
  kind: string;
  first: boolean;
  last: boolean;
  /** The steps the loop or retry repeats, as the spec numbers them. */
  repeats: { from: number; to: number };
}

export interface Row {
  /** The row's place: 0 is what starts the flow, then each step from 1. */
  n: number;
  /** The number a person reads: the step's number, Start, or "was 3" for a removed step. */
  shown: string;
  kind: string;
  what: string;
  from: string;
  to: string;
  /** On the arrow: the entry point, the table, the topic, or the gateway. */
  label?: string;
  /** The arrow points back to the caller (a response). */
  back: boolean;
  fields: string[];
  /** The first citation, as path:line. */
  cite?: string;
  /** How many more citations the step has. */
  more: number;
  confirmedBy?: string;
  /** The flow this call-out starts, from the estate pass. */
  opens?: { repo: string; flow: string; name?: string };
  /** Why the estate pass couldn't join this call-out. */
  unjoined?: string;
  /** The frames (loops, retries) this row is inside, outermost first. */
  frames: RowFrame[];
  /** In a change's target flow: what the change does to this step. */
  mark?: Exclude<Mark, "same">;
  /** A changed step: what it did before. */
  was?: string;
  /** The change's reason for this step. */
  why?: string;
}

/** A loop or retry and the rows it repeats, by row place (`n`). */
export interface Frame {
  kind: string;
  /** The loop or retry step's row. */
  step: number;
  /** The first and last rows inside the frame, the loop or retry itself included. */
  from: number;
  to: number;
  depth: number;
  repeats: { from: number; to: number };
}

export interface Sequence {
  lanes: Lane[];
  rows: Row[];
  frames: Frame[];
  errors: { when: string; then: string; cite?: string }[];
  /** What the spec is missing, in plain words. */
  gaps: string[];
}

type Ev = Api.FlowViewT["flow"]["steps"][number]["evidence"][number];

/** A step as both a spec's flow and a target flow have it. */
interface StepIn {
  kind: string;
  what: string;
  to?: { component: string; entry: string; new?: boolean };
  store?: { table: string; columns: string[]; new?: boolean };
  data?: {
    sends?: string[];
    returns?: string[];
    reads?: string[];
    checks?: string[];
    from?: string[];
    to?: string[];
  };
  refs?: string[];
  repeats?: { from: number; to: number };
  evidence: Ev[];
  confirmedBy?: string;
  mark?: Mark;
  today?: number;
  target?: number;
  was?: { kind: string; what: string };
  why?: string;
}

interface FlowIn {
  component: string;
  trigger: {
    kind: string;
    what: string;
    caller?: { who: string; via?: string } | undefined;
    evidence: Ev[];
  };
  steps: StepIn[];
  errors: { when: string; then: string; evidence: Ev[] }[];
  calls: Api.FlowViewT["calls"];
  unmatched: Api.FlowViewT["unmatched"];
  /** A target flow: repeats are target numbers, and rows show target numbers. */
  target: boolean;
}

const CALLER_BY_KIND: Record<string, string> = {
  action: "A person",
  page: "A person",
  job: "A schedule",
  listener: "A message",
};

const MAX_FIELDS = 6;
const names = (xs: string[]) =>
  xs.length > MAX_FIELDS
    ? `${xs.slice(0, MAX_FIELDS).join(", ")} and ${xs.length - MAX_FIELDS} more`
    : xs.join(", ");

const citeOf = (e: Ev | undefined) =>
  e?.path ? `${e.path}${e.line !== undefined ? `:${e.line}` : ""}` : undefined;

const REPEATING = new Set(["loop", "retry"]);

function fieldsOf(s: StepIn): string[] {
  const d = s.data ?? {};
  const out: string[] = [];
  for (const k of ["sends", "returns", "reads", "checks"] as const)
    if (d[k]?.length) out.push(`${k}: ${names(d[k])}`);
  if (d.from?.length || d.to?.length)
    out.push(`maps: ${names(d.from ?? [])} → ${names(d.to ?? [])}`);
  if (s.store?.columns.length) out.push(`columns: ${names(s.store.columns)}`);
  if (s.repeats) out.push(`repeats steps ${s.repeats.from} to ${s.repeats.to}`);
  return out;
}

function build(f: FlowIn): Sequence {
  const t = f.trigger;
  const gaps: string[] = [];
  const known = t.caller?.who;
  const callerLabel =
    known ??
    CALLER_BY_KIND[t.kind] ??
    (gaps.push("Who calls this entry point isn't known yet."), "Caller not known");
  const lanes: Lane[] = [{ id: "caller", label: callerLabel, kind: "caller" }];
  const via = t.caller?.via && t.caller.via !== "direct" ? t.caller.via : undefined;
  if (via) lanes.push({ id: "gateway", label: via, kind: "gateway" });
  lanes.push({ id: "self", label: f.component, kind: "self" });
  const lane = (id: string, label: string, kind: LaneKind, isNew?: boolean) => {
    const have = lanes.find((l) => l.id === id);
    if (!have) lanes.push({ id, label, kind, ...(isNew ? { isNew: true } : {}) });
    else if (isNew) have.isNew = true;
    return id;
  };

  const rows: Row[] = [
    {
      n: 0,
      shown: "Start",
      kind: t.kind,
      what: t.what,
      from: "caller",
      to: "self",
      ...(via ? { label: `via ${via}` } : {}),
      back: false,
      fields: [],
      ...(citeOf(t.evidence[0]) ? { cite: citeOf(t.evidence[0])! } : {}),
      more: Math.max(0, t.evidence.length - 1),
      frames: [],
    },
  ];

  f.steps.forEach((s, i) => {
    const n = i + 1;
    let to = "self";
    let label: string | undefined;
    let back = false;
    if (s.kind === "call-out" && s.to) {
      to = lane(`component:${s.to.component}`, s.to.component, "component", s.to.new);
      label = s.to.entry;
    } else if (s.kind === "publish") {
      const topic = s.to?.entry ?? s.refs?.[0] ?? "a topic";
      to = lane(`topic:${topic}`, topic, "topic", s.to?.new);
    } else if (s.store && ["read", "write", "lookup"].includes(s.kind)) {
      to = lane(`store:${s.store.table}`, s.store.table, "store", s.store.new);
    } else if (s.kind === "respond") {
      to = "caller";
      back = true;
    }
    // A spec's flow numbers its steps; a target flow shows its target numbers.
    const stepNo = f.target ? s.target : n;
    const call = f.target ? undefined : f.calls.find((c) => c.step === n);
    const miss = f.target ? undefined : f.unmatched.find((u) => u.step === n);
    if (REPEATING.has(s.kind) && !s.repeats && s.mark !== "removed")
      gaps.push(`Step ${stepNo ?? n} is a ${s.kind} that doesn't say which steps it repeats yet.`);
    rows.push({
      n,
      shown: stepNo !== undefined ? String(stepNo) : s.today !== undefined ? `was ${s.today}` : "",
      kind: s.kind,
      what: s.what,
      from: "self",
      to,
      ...(label ? { label } : {}),
      back,
      fields: fieldsOf(s),
      ...(citeOf(s.evidence[0]) ? { cite: citeOf(s.evidence[0])! } : {}),
      more: Math.max(0, s.evidence.length - 1),
      ...(s.confirmedBy ? { confirmedBy: s.confirmedBy } : {}),
      ...(call
        ? {
            opens: { repo: call.repo, flow: call.flow, ...(call.name ? { name: call.name } : {}) },
          }
        : {}),
      ...(miss ? { unjoined: miss.message } : {}),
      frames: [],
      ...(s.mark && s.mark !== "same" ? { mark: s.mark } : {}),
      ...(s.was && s.was.what !== s.what ? { was: s.was.what } : {}),
      ...(s.why ? { why: s.why } : {}),
    });
  });

  // Frames: a loop or retry and the steps it repeats, before it or after it. Repeats name step
  // numbers (target numbers in a target flow); a frame spans those rows and the loop's own.
  const rowOf = (no: number) =>
    f.target ? rows.find((r) => r.n > 0 && f.steps[r.n - 1]!.target === no)?.n : no;
  const frames: Frame[] = [];
  f.steps.forEach((s, i) => {
    if (!REPEATING.has(s.kind) || !s.repeats || s.mark === "removed") return;
    const a = rowOf(s.repeats.from);
    const b = rowOf(s.repeats.to);
    if (a === undefined || b === undefined || a > b || b > f.steps.length) return;
    const n = i + 1;
    frames.push({
      kind: s.kind,
      step: n,
      from: Math.min(a, n),
      to: Math.max(b, n),
      depth: 0,
      repeats: s.repeats,
    });
  });
  // Outer frames first; a frame inside another sits one deeper.
  frames.sort((x, y) => x.from - y.from || y.to - x.to);
  frames.forEach((fr, i) => {
    fr.depth = frames.slice(0, i).filter((o) => o.from <= fr.from && o.to >= fr.to).length;
  });
  for (const fr of frames)
    for (let n = fr.from; n <= fr.to; n++)
      rows[n]!.frames.push({
        depth: fr.depth,
        kind: fr.kind,
        first: n === fr.from,
        last: n === fr.to,
        repeats: fr.repeats,
      });
  for (const r of rows) r.frames.sort((x, y) => x.depth - y.depth);

  return {
    lanes,
    rows,
    frames,
    errors: f.errors.map((e) => ({
      when: e.when,
      then: e.then,
      ...(citeOf(e.evidence[0]) ? { cite: citeOf(e.evidence[0])! } : {}),
    })),
    gaps,
  };
}

/** A spec's flow, with the joins the estate pass found. */
export function sequence(v: Api.FlowViewT): Sequence {
  return build({
    component: v.flow.component,
    trigger: v.flow.trigger,
    steps: v.flow.steps,
    errors: v.flow.errors,
    calls: v.calls,
    unmatched: v.unmatched,
    target: false,
  });
}

/** A change's target flow beside today's: each step marked, numbered by the target flow. */
export function targetSequence(v: Api.TargetFlowViewT): Sequence {
  return build({
    component: v.component,
    trigger: { ...v.trigger, evidence: v.triggerEvidence },
    steps: v.steps,
    errors: [],
    calls: [],
    unmatched: [],
    target: true,
  });
}
