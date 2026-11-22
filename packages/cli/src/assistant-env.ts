/**
 * Whether a command runs in a coding assistant's terminal, from the variables the assistants set
 * there (ADR 0115 addendum): imports nothing, so the command line can tell before it loads a
 * schema (ADR 0202 point 9: `ask.ts`, which every command reads, atticus --help too). Who the
 * assistant is, as recorded, is `assistantSession` (assistant-session.ts).
 */

/** The variable each assistant sets in the terminals it runs commands in, and its name. */
export const ASSISTANT_TERMINAL_VARS: readonly (readonly [string, string])[] = [
  ["CLAUDECODE", "claude-code"],
  ["GEMINI_CLI", "gemini-cli"],
  ["CURSOR_AGENT", "cursor"],
];

/** True exactly when `assistantSession(env)` names an assistant. */
export function underAssistant(env: Readonly<Record<string, string | undefined>>): boolean {
  if (env.ATTICUS_ASSISTANT?.trim()) return true;
  return ASSISTANT_TERMINAL_VARS.some(([k]) => !!env[k] && env[k] !== "0");
}
