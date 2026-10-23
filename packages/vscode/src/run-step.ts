import { answersFrom, type Catalog } from "./commands";
import { describeEnd } from "./describe";
import type { StepEnd } from "./runner";

/**
 * Run with Copilot from the app in a VS Code panel (ADR 0106). The page asks through the bridge
 * (packages/ui/src/api/bridge.ts) and the extension answers with messages; the shapes, agreed with
 * the app:
 *
 *   page → extension  { type: "run-step", id, args: string[] }
 *                     args: the step's command words and arguments, e.g. ["scan", "survey", "forge-ledger"]
 *   extension → page  { type: "run-progress", id, line }                      (any number)
 *   extension → page  { type: "run-end", id, state, lines, runId? }           (once)
 *
 * `id` is the page's own (a number or a string), echoed back. `state` is how the step ended (a
 * StepEnd state: done, question, stopped, failed, no-model, …), or "refused" when the message
 * wasn't one the extension runs, or "not-started" when there is no metarepo or command line.
 * `lines` are the words a person reads, the first saying what happened. `runId` is the last
 * round's run, for the app's Model runs screen.
 *
 * Only the catalogue's AI steps (`runs: "ai"`) are run, and any argument that starts with "-" is
 * refused, so the page can't add --root, --mode or an approve flag. The extension runs the step as
 * the sidebar does: Copilot, the person's consent, and every check of the command line. No
 * `vscode` here, so it is tested outside the editor.
 */

export type RunStepCheck =
  | { ok: true; id: unknown; command: string; args: string[]; spec?: string }
  | { ok: false; id: unknown; reason: string };

const okId = (id: unknown) =>
  typeof id === "number" || (typeof id === "string" && id.length <= 100) ? id : undefined;

/** The step a `run-step` message asks for, checked; undefined when the message isn't one. */
export function checkRunStep(m: unknown, catalog: Catalog): RunStepCheck | undefined {
  if (typeof m !== "object" || m === null || (m as { type?: unknown }).type !== "run-step")
    return undefined;
  const { id: rawId, args } = m as { id?: unknown; args?: unknown };
  const id = okId(rawId);
  const refuse = (reason: string): RunStepCheck => ({ ok: false, id, reason });
  if (id === undefined)
    return refuse("A run-step message needs its id: a number or a short string.");
  if (
    !Array.isArray(args) ||
    args.length < 1 ||
    args.length > 32 ||
    !args.every((a) => typeof a === "string" && a.length > 0 && a.length <= 1000)
  )
    return refuse(
      "A run-step message needs args: the step's command words and arguments, as text.",
    );
  const words = args as string[];
  // eslint-disable-next-line no-control-regex
  if (words.some((a) => /[\u0000-\u001f\u007f]/.test(a)))
    return refuse("An argument holds a control character or a line break.");
  const dashed = words.find((a) => a.startsWith("-"));
  if (dashed)
    return refuse(
      `The argument ${JSON.stringify(dashed)} starts with "-": the app passes no options to a step.`,
    );
  let cmd: Catalog["commands"][number] | undefined;
  for (const c of catalog.commands)
    if (
      c.words.length &&
      c.words.length <= words.length &&
      c.words.every((w, i) => words[i] === w) &&
      (!cmd || c.words.length > cmd.words.length)
    )
      cmd = c;
  if (!cmd || cmd.runs !== "ai")
    return refuse(
      `atticus ${words.slice(0, 2).join(" ")} isn't an AI step: the app only runs the AI steps with Copilot.`,
    );
  const rest = words.slice(cmd.words.length);
  const { missing } = answersFrom(cmd, rest);
  if (missing.length) return refuse(`atticus ${cmd.id} needs ${missing.join(", ")}.`);
  const max = cmd.args.some((a) => a.many) ? Infinity : cmd.args.length;
  if (rest.length > max)
    return refuse(
      `atticus ${cmd.id} takes ${max} argument${max === 1 ? "" : "s"}, not ${rest.length}.`,
    );
  return {
    ok: true,
    id,
    command: cmd.id,
    args: words,
    ...(cmd.id === "spec draft" && rest[0] ? { spec: rest[0] } : {}),
  };
}

export const runProgressMessage = (id: unknown, line: string) => ({
  type: "run-progress" as const,
  id,
  line,
});

/** How the step ended, for the page; undefined when it didn't start. */
export function runEndMessage(id: unknown, end: StepEnd | undefined) {
  if (!end)
    return {
      type: "run-end" as const,
      id,
      state: "not-started",
      lines: ["The step didn't start: open a metarepo, and check that atticus runs."],
    };
  const runId = end.files?.runId ?? ("runId" in end ? end.runId : undefined);
  return {
    type: "run-end" as const,
    id,
    state: end.state as string,
    lines: describeEnd(end),
    ...(runId ? { runId } : {}),
  };
}

/** The end of a message the extension refused. */
export const runRefusedMessage = (id: unknown, reason: string) => ({
  type: "run-end" as const,
  id,
  state: "refused",
  lines: [reason],
});
