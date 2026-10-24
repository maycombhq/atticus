import type { RecordOf } from "@maycombhq/core";
import type { SequenceStep, SequenceView } from "./views.js";

type Flow = RecordOf<"Flow">;

/** Who starts a flow, when the spec doesn't name the caller (ADR 0092). */
const CALLER: Record<Flow["trigger"]["kind"], string> = {
  endpoint: "Caller not known",
  listener: "A message",
  job: "A schedule",
  action: "A person",
  page: "A person",
};

/**
 * One flow (ADR 0079) as a sequence diagram, with ADR 0092's lanes: who starts it, the flow's
 * component, then each component, table and topic its steps reach, in the order first reached.
 * One numbered row per step: a call-out's arrow goes to the called component labelled with the
 * entry point, a read, lookup or write to its table with the columns, a publish to its topic, a
 * response back to the caller (dashed); any other step is a note over the component. A pure
 * function of the record: the same flow always gives the same view.
 */
export function flowSequenceView(flow: Flow, o: { source?: string } = {}): SequenceView {
  const participants: SequenceView["participants"] = [];
  const seen = new Set<string>();
  const lane = (id: string, label = id) => {
    if (seen.has(id)) return;
    seen.add(id);
    participants.push({ id, label });
  };
  const caller = flow.trigger.caller?.who ?? CALLER[flow.trigger.kind];
  lane("caller", caller);
  lane(flow.component);
  const steps: SequenceStep[] = [
    { kind: "message", from: "caller", to: flow.component, label: flow.trigger.what, async: false },
  ];
  flow.steps.forEach((s, i) => {
    const n = `${i + 1}. ${s.kind}`;
    if ((s.kind === "call-out" || s.kind === "publish") && s.to) {
      // A publish goes to its topic; a call-out to the component it calls.
      const target = s.kind === "publish" ? s.to.entry : s.to.component;
      lane(target);
      steps.push({
        kind: "message",
        from: flow.component,
        to: target,
        label: `${n}: ${s.to.entry}`,
        async: s.kind === "publish",
      });
    } else if (s.store && (s.kind === "read" || s.kind === "lookup" || s.kind === "write")) {
      lane(s.store.table);
      const cols = s.store.columns.length ? ` (${s.store.columns.join(", ")})` : "";
      steps.push({
        kind: "message",
        from: flow.component,
        to: s.store.table,
        label: `${n}: ${s.what}${cols}`,
        async: false,
      });
    } else if (s.kind === "respond") {
      steps.push({
        kind: "message",
        from: flow.component,
        to: "caller",
        label: `${n}: ${s.what}`,
        async: false,
        reply: true,
      });
    } else steps.push({ kind: "note", over: [flow.component], text: `${n}: ${s.what}` });
  });
  return {
    type: "sequence",
    title: flow.name,
    ...(o.source ? { source: o.source } : {}),
    participants,
    steps,
  };
}
