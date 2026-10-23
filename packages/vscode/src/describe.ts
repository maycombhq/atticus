import type { StepEnd } from "./runner";
import type { OpenQuestion } from "./types";

/**
 * The words a person reads when a step ends (ADR 0090): in the chat, the side view and
 * notifications. Plain English, short sentences; the first line says what happened.
 */

/** Lines as a code block, with a fence longer than any backtick run inside. */
export function block(lines: string[]): string {
  const text = lines.join("\n");
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `\n${fence}text\n${text}\n${fence}\n`;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function questionLines(q: OpenQuestion): string[] {
  return [
    `${q.id}: ${q.question}`,
    ...q.options.map((o, i) => `  ${i + 1}. ${o.label}${o.means ? `: ${o.means}` : ""}`),
  ];
}

/** "What happened: why", the why being the first line printed, cut short when very long. */
function because(what: string, printed: string[]): string {
  const why = printed[0]?.trim();
  if (!why) return `${what}.`;
  return `${what}: ${why.length > 200 ? `${why.slice(0, 199).trimEnd()}…` : why}`;
}

export function describeEnd(end: StepEnd): string[] {
  const finish = (w: { resumeCommand?: string; runId?: string }) =>
    w.resumeCommand
      ? [
          `The run ${w.runId} is still waiting. To finish it another way, write its result file, then run atticus handoff done ${w.runId}, then: ${w.resumeCommand}`,
        ]
      : [];
  switch (end.state) {
    case "done":
      return [
        `The step is done${end.rounds ? ` after ${plural(end.rounds, "answer")} from the model` : ""}.`,
        ...end.messages,
      ];
    case "question":
      return [
        `The step stopped for a person: ${plural(end.questions.length, "question")} to answer. Answer with /answer (or Atticus: Answer an open question), then run the step again.`,
        ...end.questions.flatMap(questionLines),
      ];
    // The notice shows the first line only: it says why, in the command line's own words; all of
    // what it printed follows, for the output (Show details).
    case "stopped": {
      const all = [...end.messages, ...end.errors].filter((l) => l.trim());
      return [because("The step stopped without finishing", all), ...all];
    }
    case "failed": {
      const all = [...end.errors, ...end.messages].filter((l) => l.trim());
      return [because("The step couldn't run", all), ...all];
    }
    case "too-long":
      return [
        `The prompt is ${end.tokens} tokens, and ${end.model} takes at most ${end.max}. Nothing was cut and nothing was sent. Pick a model that takes more (the setting atticus.model), or run the step in a tool with a larger limit.`,
        ...finish(end),
      ];
    case "cancelled":
      return ["Cancelled. Nothing more was sent or written.", ...finish(end)];
    case "no-consent":
      return [
        "You didn't allow Atticus to use the Copilot model, so nothing was sent. Run the step again to be asked again.",
        ...finish(end),
      ];
    case "no-model":
      return [
        "No Copilot chat model is available. Sign in to GitHub Copilot, or check the setting atticus.model.",
        ...finish(end),
      ];
    case "model-error":
      return [`The model didn't answer: ${end.message}`, ...finish(end)];
    case "too-many-rounds":
      return [
        `Atticus handed the step back ${plural(end.rounds, "time")} and it still isn't done, so the runner stopped. Look at the last prompt: ${end.promptFile}`,
        ...finish(end),
      ];
  }
}

/**
 * The buttons on the notice a step ends with: what a person can do next, so that an ending is
 * never a dead end. Without a model, that is setting Copilot up (VS Code's own setup signs in, and
 * turns on the Copilot built into VS Code 1.143 and later).
 */
export function endActions(
  end: { state: StepEnd["state"]; files?: StepEnd["files"] },
  o: { copilot: boolean },
): string[] {
  const files = endFiles(end, "").map((f) => f.title);
  const next = (() => {
    switch (end.state) {
      case "question":
        return ["Answer"];
      case "no-model":
        return o.copilot ? ["Set up Copilot", "Pick a model"] : ["Set up Copilot"];
      case "too-long":
      case "model-error":
        return ["Pick a model"];
      default:
        return [];
    }
  })();
  return [...next, ...files, "Show details"];
}

export const OPEN_PROMPT = "Open the prompt";
export const OPEN_ANSWER = "Open the answer";

/**
 * The last round's prompt and answer an ending can open (ADR 0106), each with its button's title
 * and its path under the metarepo; only those the runner found on disk.
 */
export function endFiles(
  end: { files?: StepEnd["files"] },
  root: string,
): { title: string; path: string }[] {
  const at = (rel: string) => (root ? `${root.replace(/[\\/]+$/, "")}/${rel}` : rel);
  const f = end.files;
  return [
    ...(f?.prompt ? [{ title: OPEN_PROMPT, path: at(f.prompt) }] : []),
    ...(f?.answer ? [{ title: OPEN_ANSWER, path: at(f.answer) }] : []),
  ];
}

/** VS Code's own Copilot setup (sign in, turn the built-in Copilot on). */
export const COPILOT_SETUP = "workbench.action.chat.triggerSetup";

/**
 * How to set Copilot up, from the commands this VS Code has: its own setup when there is one (in
 * VS Code 1.143 Copilot is built in, and its extension shows only once it is set up), else
 * installing Copilot Chat, for an older VS Code.
 */
export function copilotSetup(commands: readonly string[]): { command: string; args: string[] } {
  return commands.includes(COPILOT_SETUP)
    ? { command: COPILOT_SETUP, args: [] }
    : { command: "workbench.extensions.installExtension", args: ["GitHub.copilot-chat"] };
}
