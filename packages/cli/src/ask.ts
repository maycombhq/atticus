/**
 * ADR 0202 point 9: when the command line may ask its one question, and how. Kept apart from the
 * commands so `bin.ts` loads nothing more to decide it.
 */
import { assistantSession } from "./assistant-session.js";

/**
 * A question is asked only of a person at a terminal: standard input and output are both a
 * terminal, `--json` is not given, `CI` is not set, and no assistant or tool started the
 * command. An assistant's session runs commands under a terminal of its own (a Copilot session
 * Atticus started, Claude Code, Cursor, Gemini, any that sets ATTICUS_ASSISTANT), and the app or
 * an editor's extension says so with ATTICUS_STARTED_BY: none of them can answer, and a
 * question there would wait for ever. Anything else prints what it always printed.
 */
export function canAsk(o: {
  stdinTTY: boolean | undefined;
  stdoutTTY: boolean | undefined;
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
}): boolean {
  if (!o.stdinTTY || !o.stdoutTTY) return false;
  if (o.env.CI !== undefined && o.env.CI !== "") return false;
  if (o.env.ATTICUS_ACP_SESSION || assistantSession(o.env)) return false;
  const by = o.env.ATTICUS_STARTED_BY?.trim();
  if (by && by !== "terminal") return false;
  const end = o.argv.indexOf("--");
  const flags = end < 0 ? o.argv : o.argv.slice(0, end);
  return !flags.some((a) => a === "--json" || a.startsWith("--json="));
}

/** Ask on the terminal: the question, then the line typed (undefined at the end of input). */
export async function terminalAsk(question: string): Promise<string | undefined> {
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((done) => {
    let answered = false;
    rl.question(`${question} `, (answer) => {
      answered = true;
      rl.close();
      done(answer);
    });
    rl.once("close", () => {
      if (!answered) done(undefined);
    });
  });
}
