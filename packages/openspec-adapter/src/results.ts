import { z } from "zod";

/**
 * Shapes of OpenSpec's `--json` output that Atticus relies on. Objects are loose: OpenSpec
 * may add fields in a minor release, and that must not break Atticus. Fields listed here
 * are the contract; the contract tests run them against the pinned OpenSpec version.
 */

export const OpenSpecRoot = z.looseObject({ path: z.string(), source: z.string() });

export const StatusMessage = z.looseObject({
  severity: z.string(),
  code: z.string(),
  message: z.string(),
  fix: z.string().optional(),
});

/** Error envelope OpenSpec prints with a non-zero exit. */
export const ErrorEnvelope = z.looseObject({ status: z.array(StatusMessage).min(1) });

export const NewChangeResult = z.looseObject({
  change: z.looseObject({ id: z.string(), path: z.string(), schema: z.string() }),
  root: OpenSpecRoot,
});

export const ArtifactStatus = z.looseObject({
  id: z.string(),
  outputPath: z.string(),
  /** done, ready (all requirements met) or blocked. */
  status: z.string(),
  requires: z.array(z.string()),
  missingDeps: z.array(z.string()).optional(),
});

export const ChangeStatus = z.looseObject({
  changeName: z.string(),
  schemaName: z.string(),
  isComplete: z.boolean(),
  applyRequires: z.array(z.string()),
  artifacts: z.array(ArtifactStatus),
  root: OpenSpecRoot,
});
export type ChangeStatus = z.infer<typeof ChangeStatus>;

export const ArtifactInstructions = z.looseObject({
  changeName: z.string(),
  artifactId: z.string(),
  schemaName: z.string(),
  outputPath: z.string(),
  description: z.string(),
  instruction: z.string().optional(),
  template: z.string(),
  dependencies: z.array(z.unknown()),
  unlocks: z.array(z.string()),
});
export type ArtifactInstructions = z.infer<typeof ArtifactInstructions>;

export const ApplyTask = z.looseObject({
  id: z.string(),
  description: z.string(),
  done: z.boolean(),
  line: z.number().optional(),
});

export const ApplyInstructions = z.looseObject({
  changeName: z.string(),
  schemaName: z.string(),
  progress: z.looseObject({ total: z.number(), complete: z.number(), remaining: z.number() }),
  tasks: z.array(ApplyTask),
});
export type ApplyInstructions = z.infer<typeof ApplyInstructions>;

export const ValidationIssue = z.looseObject({
  level: z.enum(["ERROR", "WARNING", "INFO"]),
  path: z.string(),
  message: z.string(),
});
export type ValidationIssue = z.infer<typeof ValidationIssue>;

export const ValidationItem = z.looseObject({
  id: z.string(),
  type: z.enum(["change", "spec"]),
  valid: z.boolean(),
  issues: z.array(ValidationIssue),
});
export type ValidationItem = z.infer<typeof ValidationItem>;

export const ValidationReport = z.looseObject({
  items: z.array(ValidationItem),
  summary: z.looseObject({
    totals: z.looseObject({ items: z.number(), passed: z.number(), failed: z.number() }),
  }),
});
export type ValidationReport = z.infer<typeof ValidationReport>;

export const ChangeSummary = z.looseObject({
  name: z.string(),
  completedTasks: z.number(),
  totalTasks: z.number(),
  lastModified: z.string(),
  status: z.string(),
});
export type ChangeSummary = z.infer<typeof ChangeSummary>;

export const ChangeList = z.looseObject({ changes: z.array(ChangeSummary) });

export const SpecSummary = z.looseObject({ id: z.string(), requirementCount: z.number() });
export type SpecSummary = z.infer<typeof SpecSummary>;

export const SpecList = z.looseObject({ specs: z.array(SpecSummary) });

export const Scenario = z.looseObject({ name: z.string(), rawText: z.string() });

export const Requirement = z.looseObject({
  name: z.string(),
  text: z.string(),
  scenarios: z.array(Scenario),
});
export type Requirement = z.infer<typeof Requirement>;

export const Delta = z.looseObject({
  spec: z.string(),
  operation: z.enum(["ADDED", "MODIFIED", "REMOVED", "RENAMED"]),
  description: z.string(),
  requirements: z.array(Requirement).optional(),
});
export type Delta = z.infer<typeof Delta>;

export const ChangeDetail = z.looseObject({
  id: z.string(),
  title: z.string(),
  deltaCount: z.number(),
  deltas: z.array(Delta),
});
export type ChangeDetail = z.infer<typeof ChangeDetail>;

export const SpecDetail = z.looseObject({
  id: z.string(),
  title: z.string(),
  overview: z.string(),
  requirementCount: z.number(),
  requirements: z.array(Requirement),
});
export type SpecDetail = z.infer<typeof SpecDetail>;

export const ArchiveResult = z.looseObject({
  archive: z.looseObject({
    change: z.string(),
    archivedAs: z.string(),
    path: z.string(),
    specsUpdated: z.boolean(),
  }),
});
export type ArchiveResult = z.infer<typeof ArchiveResult>;

export const SchemaInfo = z.looseObject({
  name: z.string(),
  description: z.string().optional(),
  artifacts: z.array(z.string()),
  source: z.string(),
});
export type SchemaInfo = z.infer<typeof SchemaInfo>;
