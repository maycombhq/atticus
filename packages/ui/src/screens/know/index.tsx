import type { Screen } from "../registry.js";
import { Systems } from "./Systems.js";
import { Contracts, Diagrams, Initiatives, Reconcile } from "./Design.js";
import {
  EcosystemMap,
  Features,
  ImpactExplorer,
  IntakeScreen,
  OrgPackScreen,
  Scans,
} from "./Know.js";
import { ArchReview, Breakdown, Brief, Mappings, Tasks, TestTrace, UX } from "./Phase.js";

/** Screens of the Know, Define, Design, Plan and Build groups. */
export const KNOW_SCREENS: Record<string, Screen> = {
  map: () => <EcosystemMap />,
  systems: Systems,
  impact: ImpactExplorer,
  features: Features,
  orgpack: () => <OrgPackScreen />,
  intake: () => <IntakeScreen />,
  scans: () => <Scans />,
  brief: Brief,
  ux: UX,
  "arch-review": ArchReview,
  diagrams: Diagrams,
  reconcile: Reconcile,
  contracts: () => <Contracts />,
  mappings: Mappings,
  breakdown: Breakdown,
  initiatives: Initiatives,
  tasks: Tasks,
  trace: TestTrace,
};
