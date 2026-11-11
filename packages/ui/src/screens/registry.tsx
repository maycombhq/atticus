import type { ComponentType } from "react";
import { Architecture } from "./architecture/Architecture.js";
import { Changes } from "./Changes.js";
import { Trust } from "./map/Trust.js";
import { Outside } from "./map/Outside.js";
import { Mismatches } from "./map/Mismatches.js";
import { Decisions } from "./map/Decisions.js";
import { CommandCenter } from "./CommandCenter.js";
import { Explore } from "./Explore.js";
import { Flows } from "./flows/Flows.js";
import { Questions } from "./Questions.js";
import { KNOW_SCREENS } from "./know/index.js";
import { KNOWLEDGE_SCREENS } from "./knowledge/index.js";
import { RUN_SCREENS } from "./run/index.js";
import { History } from "./history/History.js";
import { Words } from "./run/Words.js";
import { Runs } from "./runs/Runs.js";
import { ChangeDiagram } from "./work/ChangeDiagram.js";
import { Conformance } from "./work/Conformance.js";
import { ChangeCockpit } from "./work/Cockpit.js";
import { Estimate } from "./work/Estimate.js";
import { ChangeKnowledgePage } from "./work/KnowledgePage.js";
import { Onboarding } from "./work/Onboarding.js";
import { ArchitecturePage, FeatureDesign, Stories, TaskListScreen } from "./work/Stage.js";
import { ChangeWork } from "./work/cw.js";
import { SCREENS } from "../app/screens.js";

/**
 * Screen id (screens.ts) → component. Each screen gets the current hash so it can read its own
 * route (#/changes/<id>, #/explore?q=…). A screen not listed here shows the "being built" note.
 */
export type Screen = ComponentType<{ hash: string }>;

const BARE: Record<string, Screen> = {
  // The stage screens of plan 4.5 (Change's tabs) and the first steps. The Overview is part of
  // Home: its address, #/dashboard, opens Home (OLD_ADDRESSES in app/screens.ts).
  onboarding: () => <Onboarding />,
  "feature-design": FeatureDesign,
  "change-knowledge": ChangeKnowledgePage,
  architecture: ArchitecturePage,
  stories: Stories,
  "task-list": TaskListScreen,
  // Map: the estate canvas (the Architecture workspace, without a change's step) and Trust.
  canvas: ({ hash }) => <Architecture hash={hash} screen="canvas" />,
  trust: () => <Trust />,
  // O4 (ADR 0149): the systems outside the estate, one page each.
  outside: Outside,
  // F7 (ADR 0164): the contract check on every link, estate-wide.
  mismatches: Mismatches,
  // ADR 0181: what the AI decided, Correct, and each batch's Undo.
  decisions: Decisions,
  // Home: one page, Waiting on you with the Overview merged in.
  home: () => <CommandCenter />,
  // Every other page, unchanged (behind --full, or reached by a link).
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
  cockpit: ChangeCockpit,
  conformance: Conformance,
  words: Words,
};

/**
 * beta.26: the change and work screens in the IDE look. Every page of a change (but the two that
 * hold the map's canvas, which keep the map's own look) and Model runs, History and Flows sit in
 * ChangeWork, the scope of cw.css.
 */
export const CW_SCREENS: ReadonlySet<string> = new Set([
  ...SCREENS.filter(
    (s) => s.section === "Change" && s.id !== "architecture" && s.id !== "change-diagram",
  ).map((s) => s.id),
  "runs",
  "history",
  "flows",
]);

export const SCREEN_COMPONENTS: Record<string, Screen> = Object.fromEntries(
  Object.entries(BARE).map(([id, S]): [string, Screen] => {
    if (!CW_SCREENS.has(id)) return [id, S];
    const Wrapped: Screen = (p) => (
      <ChangeWork>
        <S {...p} />
      </ChangeWork>
    );
    Wrapped.displayName = `ChangeWork(${id})`;
    return [id, Wrapped];
  }),
);
