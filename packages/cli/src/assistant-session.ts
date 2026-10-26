import { assistantActor } from "@maycombhq/core";

/**
 * The coding assistant a command runs under, read from what the assistants set in the terminals
 * they run commands in (ADR 0115 addendum, 2026-10-25). `atticus finding` with no --by records it
 * instead of the Git user, so an assistant's decision on a blocking or risk finding is a proposal
 * that waits on a person. `ATTICUS_ASSISTANT` names one Atticus doesn't know. A name that isn't
 * an assistant's is recorded as `<name>-assistant`, so it reads as one. Words only: a person runs
 * their own decision from their own terminal, or gives --by.
 */
export function assistantSession(
  env: Record<string, string | undefined>,
): { by: string; because: string } | undefined {
  const named = env.ATTICUS_ASSISTANT?.trim();
  if (named)
    return {
      by: assistantActor(named) ? named : `${named}-assistant`,
      because: "ATTICUS_ASSISTANT is set",
    };
  const known: [string, string][] = [
    ["CLAUDECODE", "claude-code"],
    ["GEMINI_CLI", "gemini-cli"],
    ["CURSOR_AGENT", "cursor"],
  ];
  for (const [k, by] of known) if (env[k] && env[k] !== "0") return { by, because: `${k} is set` };
  return undefined;
}
