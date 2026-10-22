import type { NextStep } from "./types";

/**
 * The extension's words for what Atticus does (ADR 0098): plain words first, the command beside
 * them. No `vscode` here, so it is tested outside the editor.
 */

const STEP_TITLES: Record<string, (s: NextStep) => string> = {
  discover: () => "Add the repos to the manifest",
  sync: () => "Clone or update the repos",
  survey: (s) => `Draft ${s.repo ?? "the repo"}'s scan settings with Copilot`,
  scan: (s) => (s.repo ? `Scan ${s.repo}` : "Scan the repos"),
  verify: (s) => `Check ${s.repo ?? "the repo"}'s scan against its code with Copilot`,
  accept: (s) => `Review and accept ${s.repo ?? "the repo"}'s scan proposal`,
  spec: (s) => `Draft ${s.repo ?? "the repo"}'s spec with Copilot`,
  "spec-check": (s) => `Check ${s.repo ?? "the repo"}'s spec`,
  answer: () => "Answer the open questions",
  "sync-source": (s) => `Sync the knowledge source ${s.source ?? ""}`.trimEnd(),
  knowledge: () => "Read the knowledge sources with Copilot",
  "new-change": () => "Start a change",
  feature: (s) => `Place ${s.change ?? "the change"} on the flows and features`,
  architecture: (s) => `Design ${s.change ?? "the change"}'s target flows`,
  stories: (s) => `Write ${s.change ?? "the change"}'s stories and tasks`,
  tasks: (s) => `Work through ${s.change ?? "the change"}'s tasks`,
  task: (s) => `Run a task of ${s.change ?? "the change"}`,
  release: (s) => `Plan ${s.change ?? "the change"}'s release`,
};

/** The first sentence, without its full stop. */
const firstSentence = (t: string) =>
  t
    .split(/(?<=[.!?])\s/)[0]!
    .replace(/[.!?]$/, "")
    .trim();

/** What the next step does, for a person: the command goes in the tooltip. */
export function stepTitle(s: NextStep): string {
  return STEP_TITLES[s.step]?.(s) ?? firstSentence(s.why);
}

/** What a command does, from its summary: up to its first colon, semicolon or bracket. */
export function commandTitle(summary: string): string {
  const cut = summary.split(/:\s|;\s|\s\(|\s\[/)[0]!.trim();
  return cut.length > 90 ? `${cut.slice(0, 87).trimEnd()}…` : cut;
}
