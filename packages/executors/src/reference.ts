import { fileURLToPath } from "node:url";

/**
 * Path of the reference executor: a tiny local program (plain JavaScript, no dependencies)
 * that speaks all three transports (`--transport http|command|mcp`). Tests use it, and it is
 * a starting point for a team writing its own executor. It never touches a network beyond
 * 127.0.0.1 and never reads credentials.
 */
export const REFERENCE_EXECUTOR = fileURLToPath(
  new URL("../reference/reference-executor.mjs", import.meta.url),
);
