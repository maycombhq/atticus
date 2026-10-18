import type { Screen } from "../registry.js";
import { Evals } from "./Evals.js";
import { Governance } from "./Governance.js";
import { Learning } from "./Learning.js";
import { Release } from "./Release.js";
import { ServiceDesk } from "./ServiceDesk.js";
import { Settings } from "./Settings.js";
import { Todo } from "./Todo.js";

/** Screens of the Release and Run groups (to-do, release, service desk, governance, AI quality, learning, settings). */
export const RUN_SCREENS: Record<string, Screen> = {
  todo: Todo,
  release: Release,
  "service-desk": ServiceDesk,
  governance: Governance,
  evals: Evals,
  learning: Learning,
  settings: Settings,
};
