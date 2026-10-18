import type { z } from "zod";
import type { ChangeArtifact, PHASES } from "@maycombhq/core";

/** One of the org-flow artifacts or Atticus's own change files (C6 ChangeArtifact). */
export type Artifact = z.infer<typeof ChangeArtifact>;
/** A lifecycle phase (C6 Phase). */
export type PhaseId = (typeof PHASES)[number];
