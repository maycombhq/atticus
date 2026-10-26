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
  whatItRead: "What it read (pick a line to open the code there)",
  answers: "Answers",
  pickAnswer: "Pick the answer, or a line it read to see the code",
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
  // ADR 0121 addendum: a model per kind of step.
  pickScope: "Pick the model for every step, or for one kind of step?",
  scopeEvery: "For every step",
  scopeEveryDetail:
    "The setting atticus.model: the model for each kind of step that names none of its own.",
  scopeOne: "For one kind of step",
  scopeOneDetail:
    "atticus.models.read, .draft, .critic, .knowledge or .quick: for example the strongest model for drafts, a smaller one for quick checks.",
  pickClass: "Which kind of step?",
  pickClassModel: (label: string) => `Which model runs Atticus's ${label} steps in VS Code?`,
  classNow: (what: string) => `now: ${what}`,
  classFallback: "The next choice",
  classFallbackDetail:
    "runtime.yaml's model for this kind of step, else atticus.model, else the model picked in the chat.",
  modelPickedFor: (label: string, what: string) => `Atticus's ${label} steps now run on ${what}.`,
  modelFallbackFor: (label: string) =>
    `Atticus's ${label} steps now take the next choice: runtime.yaml's, else atticus.model.`,
  modelNotOffered: (model: string, where: string) =>
    `${model} (${where}) isn't offered in VS Code: an admin may have turned it off, or its extension isn't installed.`,
  modelConfiguredPassedOver: (where: string) =>
    `${where} says atticus, runtime.yaml's model run by the command line, which one request of a step handed to VS Code's model can't use.`,
  modelInstead: (stepClass: string | undefined, source: string) =>
    `This ${stepClass ?? "AI"} step runs on ${source} instead.`,
  modelNoneLeft:
    "No other model you allowed is offered, so the step stops: pick one with Atticus: Pick the model.",
  modelChatOrCopilot: "the chat's model",
  runsModel: (stepClass: string | undefined, model: string) =>
    stepClass ? `in VS Code: ${model} for ${stepClass} steps` : `in VS Code: ${model}`,
  startFromPick: "Start from an earlier change? Its steps read it as an example.",
  startFromNothing: "Start from nothing",
  startFromNothingDetail: "Write the brief from scratch.",
  findingSimilar: "Looking for earlier changes like it…",
  changesYouWatch: "Changes you watch:",
  ownerTitle: "Atticus: Who looks after the org pack",
  ownerPrompt:
    "The handle of the person or team who looks after the org pack, normally the platform lead (for example priya.nair or team-platform).",
  ownerRule: "One handle: letters, digits, dots and hyphens, no spaces.",
  // Every view and command; Atticus 1's legacy ones behind the setting atticus.fullUi.
  waitingHead: "Waiting on you",
  waitingHeadTip:
    "What waits on you across every change: open needs, open findings, manual steps and knowledge to verify. The open questions are in the Questions view.",
  nothingElseWaits: "Nothing else waits on you.",
  nothingElseWaitsTip:
    "No open need, no manual step, no open finding and no knowledge to verify. The open questions are in the Questions view.",
  readingQuestions: "Reading the open questions…",
  noQuestions: "No question waits for an answer.",
  noQuestionsTip: "When a step needs a person's answer, its question is here.",
  questionEvidence: (lines: string) => `What it read: ${lines}`,
  questionClick: "Click to answer it, with the lines it read beside the answers.",
  chatUse:
    "Use a command: /next, /map <repo>, /verify <repo>, /feature <change>, /architecture <change>, /stories <change>, /task <change> [task], /critic <change> or /answer; or /new, /diagram, /changemap, /estimate, /ask and /run. With the setting atticus.fullUi on, Atticus 1's too (/survey, /scanverify, /spec, /small).",
  taskSay: "Say which change, and the task if you know it: /task add-note-tags T2",
  taskStarting: (change: string, task?: string) =>
    task
      ? `Starting ${task} of ${change} in Copilot's agent mode, with its context.`
      : `Pick a task of ${change}; it starts in Copilot's agent mode, with its context.`,
  // ADR 0124 addendum D-cli: the command lists show the twelve first, the rest under Legacy.
  twelveCommands: "The twelve commands",
  legacyGroup: (area: string) => `Legacy · ${area}`,
  otherArea: "Other",
  fullUiChanged: (on: boolean) =>
    on
      ? "Atticus now offers Atticus 1's legacy commands too, and the app every page as a tab."
      : "Atticus now offers every view and command but Atticus 1's legacy ones; the app its six entries, with every other page under More pages.",
  // ADR 0121 addendum (2026-10-26): a step handed to Copilot's agent mode, which edits files and
  // runs commands, instead of to the @atticus chat participant, which answers.
  copilotAgentPick: "Hand which step to Copilot's agent mode?",
  copilotAgentButton: "Run it in Copilot's agent mode",
  copilotAgentNoStep:
    "Atticus has no next step to hand to Copilot. Atticus: What's next says what is waiting.",
  copilotAgentOpened: (agent: string, stepClass: string) =>
    `Copilot Chat is open on the ${agent} agent with the step's prompt. Press Enter to start; it writes where Atticus expects, runs Atticus's own check and fixes what comes back. This is a ${stepClass} step: pick the model your organisation names for ${stepClass} steps (atticus.models.${stepClass}).`,
  copilotAgentNoFile: (agent: string) =>
    `This workspace has no .github/agents/${agent}.agent.md, so the step goes to @atticus in the chat instead. The guide "Atticus's steps through Copilot agent mode" says how to add the agent files.`,
  copilotAgentNoAgent: (step: string) =>
    `No Copilot agent covers /${step}, so the step goes to @atticus in the chat, which runs it with the model you picked.`,
  copilotAgentFailed: (why: string) =>
    `Copilot Chat couldn't be opened in agent mode (${why}), so the step goes to @atticus in the chat instead.`,
  copilotAgentFallbackFailed: (why: string) =>
    `Neither Copilot's agent mode nor the @atticus chat could be opened (${why}). Open Copilot Chat yourself and type the command.`,
};

/**
 * The kinds of step (ADR 0121 addendum), as a person reads them: in Pick the model and in the
 * settings' descriptions.
 */
export const STEP_CLASS_WORDS: Record<
  "read" | "draft" | "critic" | "knowledge" | "quick",
  { label: string; detail: string }
> = {
  read: { label: "read", detail: "Reading repos into facts (atticus map), and scan verify." },
  draft: {
    label: "draft",
    detail:
      "The feature, architecture and stories drafts, small changes, spec drafts and scan surveys.",
  },
  critic: { label: "critic", detail: "The critic's lenses, and the hand-up lens." },
  knowledge: {
    label: "knowledge",
    detail: "The knowledge scan and find, what a change needs, and knowledge ask.",
  },
  quick: {
    label: "quick",
    detail: "Everything small: judgments, context expansion and ordering, names and short texts.",
  },
};

/**
 * The settings' descriptions (package.json contributes.configuration), kept here with the
 * extension's other words; a test checks the manifest says exactly these.
 */
export const SETTINGS_WORDS: Record<string, string> = {
  "atticus.model":
    "The model Atticus's AI steps run on in VS Code, for each kind of step that names none of its own (atticus.models.*). Set it with **Atticus: Pick the model**. `vendor/family` is any model VS Code offers (for example `copilot/gpt-4o`); a bare family (`gpt-4o`) is Copilot's; `atticus` is the model provider in `runtime.yaml`, run by Atticus's command line in model mode. Empty: the model picked in the chat, or else the first Copilot model.",
  ...Object.fromEntries(
    (["read", "draft", "critic", "knowledge", "quick"] as const).map((c) => [
      `atticus.models.${c}`,
      `The model for Atticus's ${c} steps in VS Code: ${STEP_CLASS_WORDS[c].detail} \`vendor/family\`, a bare Copilot family, or \`atticus\` (runtime.yaml's provider). It overrides runtime.yaml's \`models.${c}\` for you. Empty: runtime.yaml's, else \`atticus.model\`. A model VS Code doesn't offer is passed over, and the step says so.`,
    ]),
  ),
};

/** WP7.6: an archived change near a new one, as `atticus change similar --json` gives it. */
export interface SimilarChangesView {
  how: "meaning" | "words";
  note?: string;
  changes: {
    id: string;
    change: string;
    title: string;
    archived?: string;
    summary: string;
    file: string;
    score: number;
  }[];
}

/** The rows of "Start from an earlier change?": nothing first; undefined when none is near. */
export function pastChangeRows(
  r: SimilarChangesView,
): { label: string; description?: string; detail?: string; value: string }[] | undefined {
  if (!r.changes.length) return undefined;
  return [
    { label: WORDS.startFromNothing, detail: WORDS.startFromNothingDetail, value: "" },
    ...r.changes.map((c) => ({
      label: c.title,
      description: c.archived ? `archived ${c.archived}` : c.id,
      ...(c.summary ? { detail: c.summary } : {}),
      value: c.id,
    })),
  ];
}

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

/**
 * A model VS Code offers, as Pick the model lists it. `detail` is what VS Code itself says about
 * the model (Copilot's premium-request note, such as "1x"), when it exposes one: shown as it is,
 * and nothing in its place when it doesn't (ADR 0121 addendum: no price is invented).
 */
export type OfferedModel = ModelChoice & { name: string; detail?: string };

export const modelPickItem = (m: OfferedModel) => ({
  label: m.name,
  description: modelSetting(m),
  ...(m.detail?.trim() ? { detail: m.detail.trim() } : {}),
});

/**
 * The rows of "for which steps?": every step (atticus.model), then each kind with what falls in
 * it and its own setting now.
 */
export function scopeRows(
  every: string,
  perClass: Partial<Record<keyof typeof STEP_CLASS_WORDS, string>>,
): { label: string; description?: string; detail: string; scope: string }[] {
  const now = (v: string | undefined) => {
    const c = modelChoice(v ?? "");
    return c === "configured" ? WORDS.modelConfigured : c ? modelSetting(c) : undefined;
  };
  const everyNow = now(every);
  return [
    {
      label: WORDS.scopeEvery,
      ...(everyNow ? { description: WORDS.classNow(everyNow) } : {}),
      detail: WORDS.scopeEveryDetail,
      scope: "",
    },
    ...(Object.keys(STEP_CLASS_WORDS) as (keyof typeof STEP_CLASS_WORDS)[]).map((c) => {
      const n = now(perClass[c]);
      return {
        label: `${WORDS.scopeOne}: ${STEP_CLASS_WORDS[c].label}`,
        ...(n ? { description: WORDS.classNow(n) } : {}),
        detail: STEP_CLASS_WORDS[c].detail,
        scope: c,
      };
    }),
  ];
}

/** A row of Pick the model: a vendor's heading, or a choice with the setting it writes. */
export type ModelPickRow =
  | { separator: string }
  | { label: string; description?: string; detail?: string; setting: string; picked: boolean };

/**
 * Pick the model's rows: Copilot's default and Atticus's configured model first, then every
 * model VS Code offers, under its vendor, Copilot's first. The current choice is marked.
 */
export function modelPickRows(
  models: OfferedModel[],
  current: string,
  /** For one kind of step (ADR 0121 addendum): the first row is the next choice, not Copilot's. */
  o: { forClass?: boolean } = {},
): ModelPickRow[] {
  const now = modelChoice(current);
  const nowSetting = now === "configured" ? CONFIGURED_MODEL : now ? modelSetting(now) : "";
  const rows: ModelPickRow[] = [
    {
      label: o.forClass ? WORDS.classFallback : WORDS.modelDefault,
      detail: o.forClass ? WORDS.classFallbackDetail : WORDS.modelDefaultDetail,
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
  /** WP7.5: how many changes the person watches. */
  watching?: number,
): string {
  const parts: string[] = [];
  if (questions !== undefined) parts.push(`${questions} question${questions === 1 ? "" : "s"}`);
  if (next) {
    const t = next.person ? "a person's step" : stepTitle(next, titles);
    parts.push(`next: ${t.length > 70 ? `${t.slice(0, 67).trimEnd()}…` : t}`);
  }
  if (watching) parts.push(`watching ${watching}`);
  return `$(shield) Atticus${parts.length ? `: ${parts.join(" · ")}` : ""}`;
}

/** The status bar's tooltip lines for watched changes, as `atticus watch --json` says them. */
export function watchTooltip(lines: string[]): string {
  return lines.length ? [WORDS.changesYouWatch, ...lines].join("\n") : "";
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

/** WP4.4: the org pack's owner as a form: the handle it takes, or why it won't do. */
export function ownerProblem(handle: string): string | undefined {
  return /^[A-Za-z0-9][A-Za-z0-9._@-]*$/.test(handle.trim()) ? undefined : WORDS.ownerRule;
}

/** The current owner, from what `atticus orgpack owner` prints; undefined when none is set. */
export function ownerFrom(line: string): string | undefined {
  return /^(\S+) looks after the org pack/.exec(line.trim())?.[1];
}
