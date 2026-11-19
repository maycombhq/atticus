/**
 * ADR 0202 point 9: when the command line may ask its one question, and how. Kept apart from the
 * commands so `bin.ts` loads nothing more to decide it.
 */

/**
 * A question is asked only when standard input and output are both a terminal, `--json` is not
 * given and `CI` is not set. Anything else (a pipe, a script, a job of the app, an editor's run)
 * is never asked, and prints what it always printed.
 */
export function canAsk(o: {
  stdinTTY: boolean | undefined;
  stdoutTTY: boolean | undefined;
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
}): boolean {
  if (!o.stdinTTY || !o.stdoutTTY) return false;
  if (o.env.CI !== undefined && o.env.CI !== "") return false;
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
