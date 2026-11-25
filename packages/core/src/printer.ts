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
 * ADR 0210 part 5: a command's budget line goes to `say`; `ask` only where a person answers;
 * `yes`, --yes; `preflight`, what a run that writes checks first. Its runs share one budget.
 */
export interface RunIo {
  say(line: string): void;
  ask?(question: string): Promise<string | undefined>;
  yes?: boolean;
  preflight?(root: string): Promise<string | undefined>;
}

const runIo = new AsyncLocalStorage<RunIo>();
export const withRunIo = <T>(io: RunIo, work: () => T): T => runIo.run(io, work);
export const currentRunIo = (): RunIo | undefined => runIo.getStore();
