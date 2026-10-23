import type { ComponentType } from "react";
import { Changes } from "./Changes.js";
import { CommandCenter } from "./CommandCenter.js";
import { Explore } from "./Explore.js";
import { Flows } from "./flows/Flows.js";
import { Questions } from "./Questions.js";
import { KNOW_SCREENS } from "./know/index.js";
import { KNOWLEDGE_SCREENS } from "./knowledge/index.js";
import { RUN_SCREENS } from "./run/index.js";
import { History } from "./history/History.js";
import { Runs } from "./runs/Runs.js";
import { ChangeDiagram } from "./work/ChangeDiagram.js";
import { Conformance } from "./work/Conformance.js";
import { Dashboard } from "./work/Dashboard.js";
import { Estimate } from "./work/Estimate.js";
import { Onboarding } from "./work/Onboarding.js";
import { ArchitecturePage, FeatureDesign, Stories, TaskListScreen } from "./work/Stage.js";

/**
 * Screen id (screens.ts) → component. Each screen gets the current hash so it can read its own
 * route (#/changes/<id>, #/explore?q=…). A screen not listed here shows the "being built" note.
 */
export type Screen = ComponentType<{ hash: string }>;

export const SCREEN_COMPONENTS: Record<string, Screen> = {
  // The six screens that follow the work (plan 4.5).
  dashboard: () => <Dashboard />,
  onboarding: () => <Onboarding />,
  "feature-design": FeatureDesign,
  architecture: ArchitecturePage,
  stories: Stories,
  "task-list": TaskListScreen,
  // Under More, unchanged.
  home: () => <CommandCenter />,
  changes: Changes,
  explore: Explore,
  flows: Flows,
  questions: Questions,
  ...KNOW_SCREENS,
  ...KNOWLEDGE_SCREENS,
  ...RUN_SCREENS,
  runs: Runs,
  // ADR 0110: what people asked their assistant, and what it answered.
  history: History,
  "change-diagram": ChangeDiagram,
  estimate: Estimate,
  conformance: Conformance,
};
