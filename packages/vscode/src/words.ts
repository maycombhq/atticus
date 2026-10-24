import type { NextStep } from "./types";

/**
 * The extension's words for what Atticus does (ADR 0098): plain words first, the command beside
 * them. No `vscode` here, so it is tested outside the editor.
 */

/**
 * What the extension says when something it does by itself goes wrong (ADR 0119): never
 * nothing, and never as if all were well.
 */
export const WORDS = {
  showOutput: "Show the output",
  lensesFailed: (why: string) =>
    `Atticus couldn't read which flows cite this file, so it shows no lenses for now: ${why}`,
  healthFailed: (why: string) => `Atticus couldn't check this machine and the metarepo: ${why}`,
  wholeEstate: "The whole estate",
  diagramPick: "Open which repo on the Architecture canvas?",
  changeDiagramPick: "Open the diagram of which change?",
  estimatePick: "Open the estimate of which change?",
  /**
   * How a command ended, in words (ADR 0119), for when it printed nothing to say so: the command
   * line's exit codes are 0 done, 1 problems found, 2 a mistake in how it was asked.
   */
  endedWith: (code: number | null | undefined) =>
    code === 0
      ? "Done."
      : code === 1
        ? "It found problems; the output says which."
        : code === 2
          ? "It couldn't run as asked; the output says why."
          : "It stopped before it finished; the output says why.",
  runNextStep: "Run the next step",
  showAll: "Show all",
  upgrade: "Upgrade",
  dontShowAgain: "Don't show again",
  setUpCopilot: "Set up Copilot",
  copilotMissing:
    "Atticus's AI steps run with GitHub Copilot, which isn't set up in this VS Code yet.",
  pickModel: "Pick the model",
  pickModelPlaceholder: "Which model runs Atticus's AI steps in VS Code?",
  modelDefault: "The model picked in Copilot Chat",
  modelDefaultDetail: "Else the first Copilot model. Nothing to set up.",
  modelConfigured: "Atticus's configured model",
  modelConfiguredDetail:
    "The model provider in runtime.yaml (Set up › AI in the app), run by Atticus's command line.",
  modelNone:
    "VS Code offers no language models: sign in to Copilot, or add an extension that offers one.",
  modelPicked: (what: string) => `Atticus's AI steps now run on ${what}.`,
};

/**
 * Which model a step runs on (ADR 0121 item 5), from the setting atticus.model: `vendor/family`
 * for any model VS Code offers, a bare family for Copilot's (as the setting always meant), and
 * `atticus` for runtime.yaml's model, run in model mode by the command line. Empty is Copilot's
 * default.
 */
export const CONFIGURED_MODEL = "atticus";
export interface ModelChoice {
  vendor: string;
  family: string;
}

export function modelChoice(setting: string): ModelChoice | "configured" | undefined {
  const v = setting.trim();
  if (!v) return undefined;
  if (v === CONFIGURED_MODEL) return "configured";
  const slash = v.indexOf("/");
  return slash > 0
    ? { vendor: v.slice(0, slash), family: v.slice(slash + 1) }
    : { vendor: "copilot", family: v };
}

export const modelSetting = (c: ModelChoice) => `${c.vendor}/${c.family}`;

export const modelPickItem = (m: ModelChoice & { name: string }) => ({
  label: m.name,
  description: modelSetting(m),
});

/** A row of Pick the model: a vendor's heading, or a choice with the setting it writes. */
export type ModelPickRow =
  | { separator: string }
  | { label: string; description?: string; detail?: string; setting: string; picked: boolean };

/**
 * Pick the model's rows: Copilot's default and Atticus's configured model first, then every
 * model VS Code offers, under its vendor, Copilot's first. The current choice is marked.
 */
export function modelPickRows(
  models: (ModelChoice & { name: string })[],
  current: string,
): ModelPickRow[] {
  const now = modelChoice(current);
  const nowSetting = now === "configured" ? CONFIGURED_MODEL : now ? modelSetting(now) : "";
  const rows: ModelPickRow[] = [
    {
      label: WORDS.modelDefault,
      detail: WORDS.modelDefaultDetail,
      setting: "",
      picked: nowSetting === "",
    },
    {
      label: WORDS.modelConfigured,
      detail: WORDS.modelConfiguredDetail,
      setting: CONFIGURED_MODEL,
      picked: nowSetting === CONFIGURED_MODEL,
    },
  ];
  const vendors = [...new Set(models.map((m) => m.vendor))].sort((a, b) =>
    a === "copilot" ? -1 : b === "copilot" ? 1 : a.localeCompare(b),
  );
  for (const v of vendors) {
    rows.push({ separator: v });
    const seen = new Set<string>();
    for (const m of models.filter((x) => x.vendor === v)) {
      const setting = modelSetting(m);
      if (seen.has(setting)) continue;
      seen.add(setting);
      rows.push({ ...modelPickItem(m), setting, picked: setting === nowSetting });
    }
  }
  return rows;
}

/** Something the window found when it opened: its id says whether it is the same thing again. */
export interface StartupItem {
  id: string;
  text: string;
}

/**
 * The one notice a window shows when it opens (ADR 0119), instead of a toast for each thing:
 * how many there are and the first. Undefined when nothing was found, or when the person said
 * "Don't show again" to exactly this set; a new or changed thing shows it again.
 */
export function startupNotice(
  items: StartupItem[],
  dismissed: string | undefined,
): { message: string; signature: string } | undefined {
  if (!items.length) return undefined;
  const signature = [...new Set(items.map((i) => i.id))].sort().join("|");
  if (signature === dismissed) return undefined;
  const first = items[0]!.text;
  return {
    message:
      items.length === 1
        ? `Atticus: ${first}`
        : `Atticus: ${items.length} things to look at. ${first}`,
    signature,
  };
}

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
