/**
 * The twelve commands a person meets first (ADR 0124 addendum D-cli, "Surfaces" and "Adoption
 * and the cut" in the design). `atticus help` shows only these; every other command is under
 * `atticus legacy`, and still runs by its own name exactly as before, since scripts, the editors
 * and the tests call it. Three of the twelve are new names for commands that exist: `join` is
 * `estate join`, `stories` is `plan stories`, `task <change> <task>` is `task run`.
 */

/** The twelve, in the order the help shows them. `scripts/help-text.mjs` reads this list. */
export const TOP_WORDS = [
  "init",
  "map",
  "verify",
  "join",
  "change",
  "critic",
  "stories",
  "task",
  "questions",
  "knowledge",
  "next",
  "ui",
] as const;

const TOP = new Set<string>(TOP_WORDS);

/** True for a command outside the twelve, reached with `atticus legacy` (help and legacy aren't). */
export const isLegacy = (first: string | undefined): boolean =>
  !!first && !TOP.has(first) && first !== "legacy" && first !== "help";

/**
 * What `atticus help` prints under its first line: the twelve, one line each, then how to reach
 * the rest. `pnpm docs:commands` reads it from this file too, so the reference can't drift.
 */
export const TOP_HELP = `  atticus init <folder> --platform <p>  Start your team's metarepo (atticus adopt <path> uses Atticus inside one repo)
  atticus map <repo>                    Your assistant reads a repo into facts, each citing its file and line (/atticus-map does it in one session)
  atticus verify <repo> [--write]       Check the facts against the code; --write puts them in the catalog and renders the map
  atticus join [--json]                 Follow flows from repo to repo through the calls the facts join; writes specs/estate.yaml
  atticus change new "<title>"          Start a change; atticus help change lists its stages and the rest
  atticus critic <change>               Review a change: rule checks, then four questions (is it true, complete, safe, can it ship)
  atticus stories <change>              The stories stage: stories with acceptance criteria and tasks, from the design
  atticus task <change> <task>          Run one task with your assistant: a plan, a draft or a pull request
  atticus questions                     What Atticus needs a person to answer, and who can answer it
  atticus knowledge scan                Read your wikis into patterns, standards, processes and decisions; atticus help knowledge lists the rest
  atticus next                          The next step to take, its command and its slash command
  atticus ui [--open]                   Open the app on this machine

  atticus help <command>                What one command takes (atticus explain <command> says it in plain words)
  atticus legacy                        Every other command (scan, plan, release, estate and more); each still runs by its own name
  atticus help --all                    Every command, grouped by area`;

/** `atticus help`: the version line, the twelve and the way to the rest. */
export function topHelp(versionLine: string): string {
  return [
    versionLine,
    "",
    "Map a multi-repo estate from its code, then take each change from idea to code, with a person approving every gate.",
    "",
    TOP_HELP,
    "",
    "Every command also takes --root <dir> (the metarepo) and --by <handle> (who is acting).",
  ].join("\n");
}

/**
 * The words a command line names, as the command that exists: `legacy <words>` is `<words>`,
 * `stories` is `plan stories`, `task <change> <task>` is `task run`, `join` is `estate join`.
 * `positions` are the indexes of argv's positional words (the parser's tokens), so an option and
 * its value stay where they are. Anything else, and a line already rewritten, is left as it is.
 */
export function aliasArgv(argv: readonly string[], positions: readonly number[]): string[] {
  const out = [...argv];
  let at = [...positions];
  // `atticus legacy <words>` runs <words>; `atticus legacy` alone is the list.
  if (at.length > 1 && out[at[0]!] === "legacy") {
    out.splice(at[0]!, 1);
    at = at.slice(1).map((i) => i - 1);
  }
  const first = at[0];
  if (first === undefined) return out;
  const word = out[first];
  const second = at[1] === undefined ? undefined : out[at[1]];
  if (word === "join") out.splice(first, 1, "estate", "join");
  else if (word === "stories") out.splice(first, 1, "plan", "stories");
  else if (word === "task" && second !== "run" && second !== "context")
    out.splice(first + 1, 0, "run");
  return out;
}
