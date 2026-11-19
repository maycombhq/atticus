import { unreadRepos, type Estate } from "./estate.js";
import type { FlowDelta } from "./schema.js";
import { acceptedWords } from "./accept.js";

/**
 * ADR 0189: the components a change plans that the catalog doesn't have yet, or retires. The
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

/** How a change knows an id the catalog doesn't hold (ADR 0203). */
export type Standing = "planned" | "not read" | "outside" | "accepted";

/**
 * ADR 0203: the ids a change may name that the catalog doesn't hold, each with its standing:
 * `outside` (its feature.yaml declares the party outside the map, B.7), `not read` (a repo a
 * manifest lists that nobody read, ADR 0201), `planned` (a component its target flows plan, ADR
 * 0189), or `accepted` (a person accepted a stage's finding about it, A.4, with who and why).
 * The checks that ask "is this id known" read it.
 */
export function knownToChange(
  deltas: readonly FlowDelta[],
  e: Pick<Estate, "ids" | "flows" | "records" | "manifestRepos" | "outside" | "accepted">,
): Map<string, { standing: Standing; by?: string; why?: string }> {
  const out = new Map<string, { standing: Standing; by?: string; why?: string }>();
  // Only a consumer a person accepted as one: an id accepted under another rule is no consumer.
  for (const [id, a] of e.accepted ?? [])
    if (CONSUMER_RULES.has(a.rule)) out.set(id, { standing: "accepted", by: a.by, why: a.why });
  for (const p of plannedComponents(deltas, e).values())
    if (p.action === "new") out.set(p.component, { standing: "planned" });
  // A repo that was read is known by its component: only one nobody read is named by its repo.
  for (const id of unreadRepos(e)) out.set(id, { standing: "not read" });
  for (const id of e.outside ?? []) out.set(id, { standing: "outside" });
  return out;
}

/**
 * ADR 0201: a consumer the catalog doesn't have that is still known, and why its use can't be
 * checked (its standing, knownToChange). The words that end the note; undefined for an id
 * nothing knows, which is refused as before.
 */
export function unreadConsumer(
  id: string,
  deltas: readonly FlowDelta[],
  e: Pick<Estate, "ids" | "flows" | "records" | "manifestRepos" | "outside" | "accepted">,
): string | undefined {
  const k = knownToChange(deltas, e).get(id);
  if (k?.standing === "outside")
    return "is declared outside the map in feature.yaml, so its use can't be checked.";
  if (k?.standing === "not read")
    return `is in the manifest and hasn't been read, so its use can't be checked: atticus map ${id}`;
  if (k?.standing === "planned")
    return "is planned in this change and hasn't been read, so its use can't be checked.";
  if (k?.standing === "accepted")
    return `is ${acceptedWords({ by: k.by!, why: k.why! })}, so its use can't be checked.`;
  return undefined;
}

/** The repos a change's planned new components deploy from. */
export const plannedRepos = (
  deltas: readonly FlowDelta[],
  e: Pick<Estate, "ids" | "flows">,
): Set<string> =>
  new Set(
    [...plannedComponents(deltas, e).values()].filter((p) => p.action === "new").map((p) => p.repo),
  );

/** The rules whose accepted id is a consumer, and those whose accepted id is a repo. */
const CONSUMER_RULES: ReadonlySet<string> = new Set([
  "delta.unknown-consumer",
  "stories.unknown-consumer",
]);
const REPO_RULES = ["feature.unknown-repo", "operation.unknown-repo"] as const;

/**
 * ADR 0203 A: the repos people accepted, known exactly as a newRepo is, by the rules that
 * accepted them. A check never passes over what its own rule accepted: it raises it again and the
 * acceptance is read off its fingerprint, so the acceptance stays on file.
 */
export const acceptedRepos = (
  e: Pick<Estate, "accepted">,
  rules: readonly string[] = REPO_RULES,
): Set<string> =>
  new Set([...(e.accepted ?? [])].filter(([, a]) => rules.includes(a.rule)).map(([id]) => id));
