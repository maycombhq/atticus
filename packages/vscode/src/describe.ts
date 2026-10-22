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
    case "stopped":
      return [`The step stopped without finishing.`, ...end.messages, ...end.errors];
    case "failed":
      return [`The step couldn't run.`, ...end.errors, ...end.messages];
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
