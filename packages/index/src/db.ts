import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncT } from "node:sqlite";

export type Db = DatabaseSyncT;

/**
 * Open a SQLite database with Node's built-in driver (ADR 0002). Loaded lazily so commands
 * that never touch the index don't pay for it, and Node's one-line "experimental" warning
 * for node:sqlite is kept off the user's terminal.
 */
export function openDb(file: string): Db {
  const emit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === "string" ? warning : warning.message;
    if (/SQLite/i.test(text)) return;
    (emit as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    const { DatabaseSync } = createRequire(import.meta.url)(
      "node:sqlite",
    ) as typeof import("node:sqlite");
    return new DatabaseSync(file);
  } finally {
    process.emitWarning = emit;
  }
}
