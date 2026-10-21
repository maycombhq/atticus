import { z } from "zod";
import { FLOW_STEP_KINDS, FLOW_TRIGGER_KINDS, QuestionDraft } from "@maycombhq/core";

/**
 * The files the three stages of a change write into its folder (ADR 0087, revamp plan 4.4):
 * `feature.yaml` (the feature placed against the estate), `target-flows/<flow>.yaml` (one
 * flow delta per flow touched or added) and `stage/<stage>.yaml` (the loop's state: the
 * iteration, each finding's fingerprint and how often it came back). Stories and tasks are
 * the Markdown files `atticus plan stories` already writes, plus `requests.md`.
 */

export const STAGE_SCHEMA_VERSION = 1 as const;
const V = z.literal(STAGE_SCHEMA_VERSION);
const text = () => z.string().trim().min(1);
const Id = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, "an id is lower case: letters, digits, . _ -");

export const STAGES = ["feature", "architecture", "stories"] as const;
export const Stage = z.enum(STAGES);
export type Stage = z.infer<typeof Stage>;

/** The change phase each stage belongs to, and so the gate its critic runs at. */
export const STAGE_PHASE: Record<Stage, "define" | "design" | "plan"> = {
  feature: "define",
  architecture: "design",
  stories: "plan",
};

// ------------------------------------------------------------------ feature.yaml

export const Backing = z.enum(["existing", "new", "unbacked"]);
export type Backing = z.infer<typeof Backing>;

export const DesignField = z.strictObject({
  /** The node id in the design file. */
  figmaId: text(),
  label: text(),
  /** existing: the estate has it today; new: this change adds it; unbacked: nothing provides it. */
  backing: Backing,
  /** For existing: the API field and column, in words. */
  mapsTo: z.string().optional(),
  /** Catalog or flow ids the mapping rests on (each one is checked to exist). */
  refs: z.array(Id).default([]),
  /** What is missing, for new and unbacked (and existing data that still needs a link). */
  gap: z.string().optional(),
});
export type DesignField = z.infer<typeof DesignField>;

export const DesignAction = z.strictObject({
  figmaId: text(),
  label: text(),
  does: z.string().optional(),
  /** The call it makes today, "METHOD /path", or "none" for navigation. */
  endpoint: z.string().optional(),
  /** The flow it starts, when one exists. */
  flow: Id.optional(),
  gap: z.string().optional(),
});
export type DesignAction = z.infer<typeof DesignAction>;

export const DesignScreen = z.strictObject({
  figmaId: text(),
  name: text(),
  /** The UI flow (or page) it extends, when there is one. */
  flow: Id.optional(),
  fields: z.array(DesignField).default([]),
  actions: z.array(DesignAction).default([]),
});
export type DesignScreen = z.infer<typeof DesignScreen>;

export const FeaturePlacement = z.strictObject({
  schemaVersion: V,
  change: Id,
  /** What the stage started from. */
  entry: z.enum(["brief", "stories", "figma"]),
  /** What the feature is, in two or three plain sentences. */
  summary: text(),
  /** Existing features (Capability records) it touches. */
  features: z.array(z.strictObject({ id: Id, why: text() })).default([]),
  /** Existing flows (repo specs) it touches. */
  flows: z
    .array(
      z.strictObject({
        id: Id,
        why: text(),
        /** changed: the flow's steps change; read: it only reads what the flow gives. */
        how: z.enum(["changed", "read"]).default("changed"),
      }),
    )
    .default([]),
  /** Flows that don't exist yet. */
  newFlows: z
    .array(z.strictObject({ name: text(), repo: Id, why: text() }))
    .default([]),
  gaps: z
    .array(
      z.strictObject({
        what: text(),
        why: text(),
        /** The design element or flow it comes from. */
        from: z.string().optional(),
      }),
    )
    .default([]),
  /** Other open changes that touch the same flows or systems; Atticus fills these. */
  conflicts: z
    .array(
      z.strictObject({
        change: Id,
        flows: z.array(Id).default([]),
        systems: z.array(Id).default([]),
        why: text(),
      }),
    )
    .default([]),
  /** The design's screens, read from the export and mapped (Figma entry only). */
  design: z
    .strictObject({
      file: text(),
      screens: z.array(DesignScreen).default([]),
      /** Elements the reader found that aren't data or actions (a static title), with why. */
      ignored: z.array(z.strictObject({ figmaId: text(), why: text() })).default([]),
    })
    .optional(),
  /** Questions for a person; Atticus writes them to questions/. */
  questions: z.array(QuestionDraft).default([]),
});
export type FeaturePlacement = z.infer<typeof FeaturePlacement>;

// ------------------------------------------------------------------ target-flows/<flow>.yaml

export const DeltaFields = z.strictObject({
  sends: z.array(text()).optional(),
  returns: z.array(text()).optional(),
  reads: z.array(text()).optional(),
  checks: z.array(text()).optional(),
  from: z.array(text()).optional(),
  to: z.array(text()).optional(),
});
export type DeltaFields = z.infer<typeof DeltaFields>;

export const DeltaStep = z.strictObject({
  op: z.enum(["add", "change", "remove"]),
  /** change and remove: the step's position in today's flow, from 1. */
  step: z.number().int().positive().optional(),
  /** add: the position it goes after (0: first). */
  after: z.number().int().min(0).optional(),
  kind: z.enum(FLOW_STEP_KINDS).optional(),
  /** What the step does once the change is in, in one plain sentence. */
  what: z.string().optional(),
  /** call-out and publish: where it goes. `new` when the component or entry doesn't exist yet. */
  to: z
    .strictObject({ component: Id, entry: text(), new: z.boolean().default(false) })
    .optional(),
  /** read, lookup and write: the table and columns. `new` for a table this change adds. */
  store: z
    .strictObject({
      table: Id,
      columns: z.array(text()).default([]),
      new: z.boolean().default(false),
      /** The database type of each column this change adds, e.g. { fraud_verdict: varchar(20) }. */
      types: z.record(z.string(), text()).optional(),
      /** The classification of each column this change adds, from the org pack's levels. */
      classification: z.record(z.string(), text()).optional(),
      /** The migration file that makes the change, e.g. V4__add_fraud_verdict.sql. */
      migration: z.string().optional(),
      /** A new table: how long its rows are kept. */
      retention: z.string().optional(),
    })
    .optional(),
  fields: DeltaFields.optional(),
  why: z.string().optional(),
});
export type DeltaStep = z.infer<typeof DeltaStep>;

export const FlowDelta = z.strictObject({
  schemaVersion: V,
  /** The flow's id: an existing flow in specs/<repo>/, or the new flow's id (<component>.<name>). */
  flow: Id,
  repo: Id,
  change: z.enum(["modify", "new", "remove"]),
  /** new: what a person calls the flow. */
  name: z.string().optional(),
  /** new: what starts it. */
  trigger: z
    .strictObject({ kind: z.enum(FLOW_TRIGGER_KINDS), what: text(), entry: z.string().optional() })
    .optional(),
  why: text(),
  steps: z.array(DeltaStep).default([]),
});
export type FlowDelta = z.infer<typeof FlowDelta>;

// ------------------------------------------------------------------ stage/<stage>.yaml

export const LoopFinding = z.strictObject({
  /** sha-256 (first 12 hex) of rule, target and evidence. */
  fingerprint: z.string().regex(/^[0-9a-f]{12}$/),
  rule: text(),
  target: text(),
  /** path:line, metarepo-relative, when there is one. */
  evidence: z.string().optional(),
  message: text(),
  blocking: z.boolean(),
  /** stage: the stage's own checks; critic: a critic round's finding. */
  source: z.enum(["stage", "critic"]),
  /** The iterations it was found in. */
  seenIn: z.array(z.number().int().positive()),
  /** The question it became once it came back unchanged twice or flipped. */
  question: z.string().optional(),
});
export type LoopFinding = z.infer<typeof LoopFinding>;

export const StageLoop = z.strictObject({
  schemaVersion: V,
  change: Id,
  stage: Stage,
  /** Drafts so far. */
  iteration: z.number().int().min(0),
  state: z.enum(["drafting", "waiting", "questions", "done"]),
  updatedAt: z.string(),
  /** The hand-off run being waited for. */
  run: z.string().optional(),
  /** Every finding seen in any iteration, current or not, so a flip is seen. */
  findings: z.array(LoopFinding).default([]),
  /** Questions this stage raised, by id. */
  questions: z.array(z.string()).default([]),
  /** Answered questions whose answers a draft has read. */
  read: z.array(z.string()).default([]),
  /** The critic rounds the loop ran, newest last. */
  critic: z
    .array(z.strictObject({ gate: text(), round: z.number().int().positive() }))
    .default([]),
});
export type StageLoop = z.infer<typeof StageLoop>;
