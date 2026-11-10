import { AsyncLocalStorage } from "node:async_hooks";
import { printToCurrent } from "@maycombhq/core/light";

/**
 * ADR 0187 (review): a Copilot ACP step's progress ("copilot: reading ...") goes where the run's
 * other lines go, not to standard error alone: the terminal still sees it, the command's run log
 * keeps it for the app's Console (`main` sets the run's line with `withRunLine`), and inside an
 * app job it is one of the job's lines (`printToCurrent`). Loaded at start: nothing heavy here.
 */

const runLine = new AsyncLocalStorage<(line: string) => void>();

/** Run `work` with progress printed inside it also going to `line` (the run's log). */
export function withRunLine<T>(line: (l: string) => void, work: () => T): T {
  return runLine.run(line, work);
}

/** A progress line: standard error (a step's own output stays data), the run's log, the job's. */
export function printProgress(
  l: string,
  write: (s: string) => void = (s) => void process.stderr.write(s),
): void {
  write(`${l}\n`);
  try {
    runLine.getStore()?.(l);
  } catch {
    // printing never fails the work
  }
  printToCurrent(l);
}
