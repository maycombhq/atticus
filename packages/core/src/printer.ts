import { AsyncLocalStorage } from "node:async_hooks";

/**
 * ADR 0187: where a line printed by a command goes besides its own output, while it runs inside
 * the app's job. The job (in the server) sets the printer; the command line's `main`, and the
 * app's routes that run a command's code, pass each line they print to `printToCurrent`. Outside
 * a job there is no printer and nothing happens. No schema here: the command line loads it first.
 */

/**
 * Beta.28.1: how a line is printed. `now`: a progress line (a step of long work), sent to the
 * Console at once rather than in the next batch of lines, so it is there before the step's work
 * keeps the thread.
 */
export interface PrintOptions {
  now?: boolean;
}

const printer = new AsyncLocalStorage<(line: string, o?: PrintOptions) => void>();

/** Run `work` with every line printed inside it (at any depth, across awaits) going to `print`. */
export function withPrinter<T>(print: (line: string, o?: PrintOptions) => void, work: () => T): T {
  return printer.run(print, work);
}

/** Print a line to the job this code runs in, if any. */
export function printToCurrent(line: string, o?: PrintOptions): void {
  const p = printer.getStore();
  if (!p) return;
  try {
    if (o) p(line, o);
    else p(line);
  } catch {
    // printing never fails the work
  }
}

/**
 * ADR 0210 part 5: where a model run's budget line goes and how it asks, for the command that
 * runs (the command line sets it; the AI runtime reads it). Here, beside the printer, so the
 * command line sets it without loading the runtime.
 */
export interface RunIo {
  say(line: string): void;
  /** Set only where a person can answer (Output.ask). */
  ask?(question: string): Promise<string | undefined>;
  /** --yes: an unattended run goes past the budget. */
  yes?: boolean;
}

const runIo = new AsyncLocalStorage<RunIo>();
const listener = new AsyncLocalStorage<(line: string) => void>();
export const withRunIo = <T>(io: RunIo, work: () => T): T => runIo.run(io, work);
export const currentRunIo = (): RunIo | undefined => runIo.getStore();
/** The app's job hears the plan line, to show it as its run panel's start line. */
export const withPlanListener = <T>(hear: (line: string) => void, work: () => T): T =>
  listener.run(hear, work);
export const currentPlanListener = () => listener.getStore();
