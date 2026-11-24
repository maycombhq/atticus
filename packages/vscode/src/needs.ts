/**
 * ADR 0202 point 8: the Atticus this extension needs, said to the command line. The extension
 * sets `ATTICUS_EXTENSION_NEEDS` for the `atticus ui` it starts, for every command it runs and
 * for its terminals, so `atticus status` (and the line after every refusal) can say "The
 * extension needs <version>" and name the one install command when the command line is behind.
 */

/** The oldest atticus this extension's flags and pages work with (atticus ui --embed, --parent). */
export const MIN_CLI = "2.0.0-beta.32";

/** The environment variable the command line reads. */
export const EXTENSION_NEEDS_ENV = "ATTICUS_EXTENSION_NEEDS";

/** What the extension adds to the environment of every atticus it starts. */
export const needsEnv = (): Record<string, string> => ({ [EXTENSION_NEEDS_ENV]: MIN_CLI });
