import { AsyncLocalStorage } from "node:async_hooks";

/**
 * ADR 0187: where a line printed by a command goes besides its own output, while it runs inside
 * the app's job. The job (in the server) sets the printer; the command line's `main`, and the
 * app's routes that run a command's code, pass each line they print to `printToCurrent`. Outside
 * a job there is no printer and nothing happens. No schema here: the command line loads it first.
 */

const printer = new AsyncLocalStorage<(line: string) => void>();

/** Run `work` with every line printed inside it (at any depth, across awaits) going to `print`. */
export function withPrinter<T>(print: (line: string) => void, work: () => T): T {
  return printer.run(print, work);
}

/** Print a line to the job this code runs in, if any. */
export function printToCurrent(line: string): void {
  const p = printer.getStore();
  if (!p) return;
  try {
    p(line);
  } catch {
    // printing never fails the work
  }
}
