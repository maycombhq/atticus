/**
 * `@maycombhq/core/light`: the few parts of core the command line needs before it knows which
 * command runs (its help's first line and its log). They load no schema, no zod and no YAML
 * reader, so `atticus --help` and the start of every command don't pay for building C1-C6.
 * Each is the same export as the package's own (`@maycombhq/core`); nothing here is new.
 */
export { SCHEMA_VERSION } from "./schema/version.js";
export { createLog, logFileOf, NO_LOG, type Log, type LogEntry, type LogLevel } from "./log.js";
