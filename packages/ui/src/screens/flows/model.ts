import type { Api } from "@maycombhq/core";

/**
 * A flow (ADR 0079) as a sequence diagram (ADR 0092): a lane for who starts it, the gateway it
 * comes through, the component it runs in, and each component, table and topic its steps reach;
 * then one row per step, in order, with the data, the citation and who confirmed it. A pure
 * function of the API's FlowView, so the screen only draws.
 */

export type LaneKind = "caller" | "gateway" | "self" | "component" | "store" | "topic";

export interface Lane {
  id: string;
  label: string;
  kind: LaneKind;
}

export interface Row {
  /** 0 is what starts the flow; then each step, counting from 1 as the spec does. */
  n: number;
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
}

export interface Sequence {
  lanes: Lane[];
  rows: Row[];
  errors: { when: string; then: string; cite?: string }[];
  /** What the spec is missing, in plain words. */
  gaps: string[];
}

type Step = Api.FlowViewT["flow"]["steps"][number];
type Ev = Step["evidence"][number];

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

function fieldsOf(s: Step): string[] {
  const d = s.data ?? {};
  const out: string[] = [];
  for (const k of ["sends", "returns", "reads", "checks"] as const)
    if (d[k]?.length) out.push(`${k}: ${names(d[k])}`);
  if (d.from?.length || d.to?.length)
    out.push(`maps: ${names(d.from ?? [])} → ${names(d.to ?? [])}`);
  if (s.store?.columns.length) out.push(`columns: ${names(s.store.columns)}`);
  return out;
}

export function sequence(v: Api.FlowViewT): Sequence {
  const f = v.flow;
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
  const lane = (id: string, label: string, kind: LaneKind) => {
    if (!lanes.some((l) => l.id === id)) lanes.push({ id, label, kind });
    return id;
  };

  const rows: Row[] = [
    {
      n: 0,
      kind: t.kind,
      what: t.what,
      from: "caller",
      to: "self",
      ...(via ? { label: `via ${via}` } : {}),
      back: false,
      fields: [],
      ...(citeOf(t.evidence[0]) ? { cite: citeOf(t.evidence[0])! } : {}),
      more: t.evidence.length - 1,
    },
  ];

  f.steps.forEach((s, i) => {
    const n = i + 1;
    let to = "self";
    let label: string | undefined;
    let back = false;
    if (s.kind === "call-out" && s.to) {
      to = lane(`component:${s.to.component}`, s.to.component, "component");
      label = s.to.entry;
    } else if (s.kind === "publish") {
      const topic = s.to?.entry ?? s.refs[0] ?? "a topic";
      to = lane(`topic:${topic}`, topic, "topic");
    } else if (s.store && ["read", "write", "lookup"].includes(s.kind)) {
      to = lane(`store:${s.store.table}`, s.store.table, "store");
    } else if (s.kind === "respond") {
      to = "caller";
      back = true;
    }
    const call = v.calls.find((c) => c.step === n);
    const miss = v.unmatched.find((u) => u.step === n);
    rows.push({
      n,
      kind: s.kind,
      what: s.what,
      from: "self",
      to,
      ...(label ? { label } : {}),
      back,
      fields: fieldsOf(s),
      ...(citeOf(s.evidence[0]) ? { cite: citeOf(s.evidence[0])! } : {}),
      more: s.evidence.length - 1,
      ...(s.confirmedBy ? { confirmedBy: s.confirmedBy } : {}),
      ...(call
        ? {
            opens: { repo: call.repo, flow: call.flow, ...(call.name ? { name: call.name } : {}) },
          }
        : {}),
      ...(miss ? { unjoined: miss.message } : {}),
    });
  });

  return {
    lanes,
    rows,
    errors: f.errors.map((e) => ({
      when: e.when,
      then: e.then,
      ...(citeOf(e.evidence[0]) ? { cite: citeOf(e.evidence[0])! } : {}),
    })),
    gaps,
  };
}
