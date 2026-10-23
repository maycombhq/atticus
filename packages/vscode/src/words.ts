import type { NextStep } from "./types";

/**
 * The extension's words for what Atticus does (ADR 0098): plain words first, the command beside
 * them. No `vscode` here, so it is tested outside the editor.
 */

/** A change's title, by its id, when the extension can read it. */
export type ChangeTitles = (id: string) => string | undefined;

const STEP_TITLES: Record<string, (s: NextStep, c: (id?: string) => string) => string> = {
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
  feature: (s, c) => `Place ${c(s.change)} on the flows and features`,
  architecture: (s, c) => `Design ${c(s.change)}'s target flows`,
  stories: (s, c) => `Write ${c(s.change)}'s stories and tasks`,
  // ADR 0113: a small change, brief to tasks in one step.
  small: (s, c) => `Plan ${c(s.change)}, a small change, in one step`,
  // ADR 0101: what a change needs from the organisation, then raising each.
  needs: (s, c) => `Find what ${c(s.change)} needs from the organisation`,
  "raise-needs": (s, c) => `Raise ${c(s.change)}'s open needs`,
  "orgpack-draft": () => "Draft the org pack's systems from the wikis",
  "accept-orgpack": () => "Accept the systems drafted from the wikis",
  "verify-knowledge": () => "Check the knowledge items your changes use",
  tasks: (s, c) => `Work through ${c(s.change)}'s tasks`,
  task: (s, c) => `Run a task of ${c(s.change)}`,
  release: (s, c) => `Plan ${c(s.change)}'s release`,
};

/** The first sentence, without its full stop. */
const firstSentence = (t: string) =>
  t
    .split(/(?<=[.!?])\s/)[0]!
    .replace(/[.!?]$/, "")
    .trim();

/** What the next step does, for a person: the command goes in the tooltip. */
export function stepTitle(s: NextStep, titles?: ChangeTitles): string {
  const change = (id?: string) => {
    if (!id) return "the change";
    const t = titles?.(id);
    return t ? `“${t}”` : id;
  };
  return STEP_TITLES[s.step]?.(s, change) ?? firstSentence(s.why);
}

/**
 * A question as a row: the part that differs first. A question the critic raised again after a
 * draft fixed it says so in the row's description, not in front of every one of them.
 */
export function questionLabel(q: string): { label: string; description?: string } {
  const m =
    /^This came back after a draft had fixed it:\s*(?:The critic \(([^)]+)\):\s*)?(.+)$/s.exec(q);
  if (!m) return { label: q };
  return { label: m[2]!.trim(), description: m[1] ? `came back · ${m[1]}` : "came back" };
}

/** What a command does, from its summary: up to its first colon, semicolon or bracket. */
export function commandTitle(summary: string): string {
  const cut = summary.split(/:\s|;\s|\s\(|\s\[/)[0]!.trim();
  return cut.length > 90 ? `${cut.slice(0, 87).trimEnd()}…` : cut;
}

/** The status bar: the open questions and the next step, in the Next section's words. */
export function statusText(
  questions: number | undefined,
  next: NextStep | undefined,
  titles?: ChangeTitles,
): string {
  const parts: string[] = [];
  if (questions !== undefined) parts.push(`${questions} question${questions === 1 ? "" : "s"}`);
  if (next) {
    const t = next.person ? "a person's step" : stepTitle(next, titles);
    parts.push(`next: ${t.length > 70 ? `${t.slice(0, 67).trimEnd()}…` : t}`);
  }
  return `$(shield) Atticus${parts.length ? `: ${parts.join(" · ")}` : ""}`;
}

/**
 * What Run a command says beside an option that takes a value. The help's placeholder is shown as
 * an example only when it is one (`3`, `f.json`); a letter or a word standing for the value (`s`,
 * `run`, `<kind>`) means nothing to a person.
 */
export function optionHint(f: { value?: string }): string {
  if (!f.value) return "";
  const v = f.value.replace(/^<|>$/g, "");
  const placeholder = /^[a-z]$/.test(v) || /^[a-z][a-z-]*$/.test(v);
  return placeholder ? "you give its value" : `you give its value, such as ${v}`;
}
