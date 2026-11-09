import type { Estate } from "./estate.js";
import type { FlowDelta } from "./schema.js";

/**
 * ADR 0188: the components a change plans that the catalog doesn't have yet, or retires. The
 * architect draws the future (a new box, a call to a component that isn't built, a component
 * taken away) before any repo exists, so the stage checks and the critic read the change's own
 * target flows for what it plans, and say "planned in this change" where they said "not in the
 * catalog". Read off the deltas only: nothing here is a fact, and the map changes when code
 * lands and is read.
 *
 * - new: a new flow's component the catalog doesn't have (`runsOn.component`, the box drawn on
 *   the canvas, ADR 0132), and a call's target marked new that the catalog doesn't have;
 * - retire: a component every one of whose flows today the change removes.
 *
 * The repo a planned new component deploys from is its delta's repo (the sketch writes the
 * component's own id there while no repo builds it), else the component's id.
 */
export interface Planned {
  component: string;
  action: "new" | "retire";
  repo: string;
}

export function plannedComponents(
  deltas: readonly FlowDelta[],
  e: Pick<Estate, "ids" | "flows">,
): Map<string, Planned> {
  const out = new Map<string, Planned>();
  for (const d of deltas) {
    const c = d.runsOn?.component;
    if (d.change === "new" && c && !e.ids.has(c))
      out.set(c, { component: c, action: "new", repo: d.repo });
  }
  for (const d of deltas)
    for (const s of d.steps)
      if (s.op !== "remove" && s.to?.new && !e.ids.has(s.to.component) && !out.has(s.to.component))
        out.set(s.to.component, { component: s.to.component, action: "new", repo: s.to.component });
  const removed = new Set(deltas.filter((d) => d.change === "remove").map((d) => d.flow));
  const byComponent = new Map<string, { flows: string[]; repo: string }>();
  for (const f of e.flows) {
    const x = byComponent.get(f.flow.component) ?? { flows: [], repo: f.repo };
    x.flows.push(f.flow.id);
    byComponent.set(f.flow.component, x);
  }
  for (const [component, x] of byComponent)
    if (x.flows.length && x.flows.every((f) => removed.has(f)))
      out.set(component, { component, action: "retire", repo: x.repo });
  return out;
}

/** The repos a change's planned new components deploy from. */
export const plannedRepos = (
  deltas: readonly FlowDelta[],
  e: Pick<Estate, "ids" | "flows">,
): Set<string> =>
  new Set(
    [...plannedComponents(deltas, e).values()].filter((p) => p.action === "new").map((p) => p.repo),
  );
