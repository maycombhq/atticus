/**
 * ADR 0113: Start this task in Copilot, and Attach to Atticus change. Pure, so tests can check
 * what the extension asks VS Code to do and what it says, without VS Code.
 */

/** The prompt file /atticus-task comes from, once `atticus assistant-files` has written it. */
export const TASK_PROMPT_FILE = ".github/prompts/atticus-task.prompt.md";

export const START_WORDS = {
  pickChange: "Start a task of which change?",
  pickTask: "Which task?",
  noTasks: (change: string) =>
    `${change} has no tasks yet: plan its stories first (Atticus: What's next says how).`,
  reading: (task: string) => `Reading task ${task}'s context (atticus task context)…`,
  opened: (task: string) =>
    `Copilot Chat is open in agent mode with task ${task} and its context. Press Enter to start; Copilot changes files only in the task's worktree, and you review every change.`,
  copied: (task: string, why: string) =>
    `Copilot Chat couldn't be opened (${why}), so task ${task}'s context is on the clipboard: paste it into Copilot Chat in agent mode.`,
  failed: (why: string) => `Couldn't read the task's context: ${why}`,
  attachPick: "Attach to which change?",
};

/**
 * What to open Copilot Chat with: the /atticus-task slash command where the metarepo has its
 * prompt file (it loads the context itself, in agent mode), else the context itself. Left in
 * the box for the person to send: agent mode edits files.
 */
export function startTaskChat(
  change: string,
  task: string,
  markdown: string,
  hasPromptFile: boolean,
): { query: string; mode: "agent"; isPartialQuery: true } {
  const query = hasPromptFile
    ? `/atticus-task ${change} ${task}`
    : [
        `Implement task ${task} of the Atticus change ${change}. Its context follows: read all of it first, work only in the worktree it names, and never push or merge.`,
        "",
        markdown.trim(),
      ].join("\n");
  return { query, mode: "agent", isPartialQuery: true };
}

/** The files to attach from what the Explorer passed: the one clicked, or every one selected. */
export function attachPaths(
  clicked: { scheme: string; fsPath: string } | undefined,
  selected: { scheme: string; fsPath: string }[] | undefined,
): string[] {
  const all = selected?.length ? selected : clicked ? [clicked] : [];
  return [...new Set(all.filter((u) => u.scheme === "file").map((u) => u.fsPath))];
}
