/**
 * What the extension offers by default (Phase D, the design's Surfaces; ADR 0124 addendum
 * D-app): three views, about fifteen commands in the Command Palette, and the @atticus steps that
 * run with the editor's model. Everything else stays registered and comes back with the setting
 * atticus.fullUi, as `atticus ui --full` does for the app: nothing is removed, it goes behind the
 * setting. package.json says the same, and test/manifest.test.ts holds the two together. No
 * `vscode` here.
 */

/** The setting, under `atticus.`, that offers every view and command again. */
export const FULL_UI = "fullUi";

/** The `when` clause of everything only the full arrangement offers. */
export const FULL_WHEN = "config.atticus.fullUi";

/** The sidebar by default, in its order. */
export const DEFAULT_VIEWS = [
  { id: "atticus.view", name: "Next and Waiting" },
  { id: "atticus.questions", name: "Questions" },
  { id: "atticus.changes", name: "Changes" },
];

/** The views behind atticus.fullUi, in the order they had (ADR 0105, 0106). */
export const FULL_VIEWS = [
  { id: "atticus.knowledge", name: "Knowledge" },
  { id: "atticus.repos", name: "Repos" },
  { id: "atticus.catalog", name: "Catalog" },
  { id: "atticus.runs", name: "Model runs" },
];

/** The commands the Command Palette offers by default, in package.json's order. */
export const DEFAULT_PALETTE = [
  "atticus.next",
  "atticus.runNext",
  "atticus.map",
  "atticus.verify",
  "atticus.feature",
  "atticus.architecture",
  "atticus.stories",
  "atticus.critic",
  "atticus.answer",
  "atticus.showApp",
  "atticus.showLog",
  "atticus.newChange",
  "atticus.startTask",
  "atticus.checkHealth",
  "atticus.pickModel",
];

/** The @atticus commands offered by default: the steps, run with the editor's model. */
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
];

/** Where the Atticus tab opens: Home, the first of the app's six entries. */
export const APP_HOME = "#/home";
