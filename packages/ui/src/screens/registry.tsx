import type { ComponentType } from "react";
import { Architecture } from "./architecture/Architecture.js";
import { Changes } from "./Changes.js";
import { CommandCenter } from "./CommandCenter.js";
import { Explore } from "./Explore.js";
import { KNOW_SCREENS } from "./know/index.js";
import { RUN_SCREENS } from "./run/index.js";

/**
 * Screen id (screens.ts) → component. Each screen gets the current hash so it can read its own
 * route (#/changes/<id>, #/explore?q=…). A screen not listed here shows the "being built" note.
 */
export type Screen = ComponentType<{ hash: string }>;

export const SCREEN_COMPONENTS: Record<string, Screen> = {
  home: () => <CommandCenter />,
  architecture: Architecture,
  changes: Changes,
  explore: Explore,
  ...KNOW_SCREENS,
  ...RUN_SCREENS,
};
