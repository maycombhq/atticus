/**
 * Which commands take --handoff (ADR 0086), on their own: the help, the command catalogue and
 * the flag check read this list, and must not load the hand-off itself (the model runtime, the
 * index and the critic) to do so. handoff-flag.ts runs the hand-off.
 */

/** The AI steps that take --handoff. */
const STEPS = new Set([
  "scan survey",
  "scan verify",
  "spec draft",
  "knowledge scan",
  // ADR 0087: the feature and architecture stages (plan stories already takes it).
  "change feature",
  "change architecture",
  // ADR 0113: the fast path's one step.
  "change small",
  "change draft",
  "plan stories",
  // ADR 0101: what a change needs from the organisation.
  "change needs",
  "knowledge find",
  "knowledge ask",
]);

export const isHandoffStep = (group: string | undefined, command: string | undefined) =>
  STEPS.has(`${group ?? ""} ${command ?? ""}`) ||
  isCritic(group, command) ||
  // ADR 0124 §4: atticus map <repo>, the batched read, one batch per hand-off.
  (group === "map" && !!command && !command.startsWith("-"));

/**
 * `atticus critic <change>` (ADR 0106 addendum): its AI lenses wait together, one run each, so
 * --handoff offers them one at a time, oldest first, and each resume offers the next.
 */
export const isCritic = (group: string | undefined, command: string | undefined) =>
  group === "critic" && !!command && command !== "stats";
