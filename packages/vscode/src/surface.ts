/**
 * What the extension offers (Phase D, the design's Surfaces; ADR 0124 addendum D-app, and its
 * follow-up of 2026-10-25: nothing is hidden by default). Every view: Next and Waiting, Questions
 * and Changes open, then Knowledge, Repos, Catalog and Model runs collapsed below them. Every
 * command in the Command Palette and every @atticus command, but Atticus 1's legacy ones (the
 * older scanner, survey, spec and the small change's fast path), which the setting atticus.fullUi
 * offers again; with it the Atticus tab also starts as `atticus ui --full`. Nothing is removed.
 * package.json says the same, and test/manifest.test.ts holds the two together. No `vscode` here.
 */

/** The setting, under `atticus.`, that offers Atticus 1's legacy commands and `ui --full`. */
export const FULL_UI = "fullUi";

/** The `when` clause of everything only the setting offers: Atticus 1's legacy commands. */
export const FULL_WHEN = "config.atticus.fullUi";

/** The sidebar, in its order: the three a day starts from, then the four collapsed below. */
export const DEFAULT_VIEWS = [
  { id: "atticus.view", name: "Next and Waiting" },
  { id: "atticus.questions", name: "Questions" },
  { id: "atticus.changes", name: "Changes" },
  { id: "atticus.knowledge", name: "Knowledge" },
  { id: "atticus.repos", name: "Repos" },
  { id: "atticus.catalog", name: "Catalog" },
  // ADR 0106: the model runs at the bottom: what the AI was asked is part of trusting it.
  { id: "atticus.runs", name: "Model runs" },
];

/** The views that start collapsed, so the sidebar opens on Next and Waiting. */
export const COLLAPSED_VIEWS = [
  "atticus.knowledge",
  "atticus.repos",
  "atticus.catalog",
  "atticus.runs",
];

/**
 * The everyday commands of the Command Palette, in package.json's order: the ones the real-VS-Code
 * suite runs as a person would (test-vscode/person.ts). Every other command is offered too.
 */
export const DEFAULT_PALETTE = [
  "atticus.next",
  "atticus.runNext",
  // ADR 0121 addendum (2026-10-26): the same step, handed to Copilot's agent mode.
  "atticus.runInCopilotAgent",
  "atticus.map",
  "atticus.verify",
  "atticus.feature",
  "atticus.architecture",
  "atticus.stories",
  "atticus.critic",
  "atticus.answer",
  "atticus.showApp",
  // What people asked their assistant (ADR 0110).
  "atticus.promptHistory",
  "atticus.showLog",
  "atticus.newChange",
  "atticus.startTask",
  "atticus.checkHealth",
  "atticus.pickModel",
];

/** Atticus 1's legacy commands, in package.json's order: offered only with atticus.fullUi. */
export const LEGACY_PALETTE = [
  "atticus.survey",
  "atticus.scanverify",
  "atticus.spec",
  "atticus.small",
  "atticus.scanAll",
  "atticus.acceptCatalog",
];

/** The @atticus commands offered, in package.json's order: the steps first, then the rest. */
export const DEFAULT_CHAT = [
  "next",
  "map",
  "verify",
  "feature",
  "architecture",
  "stories",
  "task",
  "critic",
  "answer",
  "new",
  "diagram",
  "changemap",
  "estimate",
  "ask",
  "run",
];

/** Atticus 1's legacy @atticus commands: offered only with atticus.fullUi. */
export const LEGACY_CHAT = ["scanverify", "survey", "spec", "small"];

/** Where the Atticus tab opens: Home, the first of the app's six entries. */
export const APP_HOME = "#/home";

/**
 * The command line's twelve, in the order `atticus help` shows them (ADR 0124 addendum D-cli;
 * `TOP_WORDS` in packages/cli/src/top-commands.ts, held to it by test/manifest.test.ts). The
 * command lists show the commands under these words first and the legacy ones after.
 */
export const TOP_COMMANDS = [
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
