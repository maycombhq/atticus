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
const Id = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "an id is lower case: letters, digits, . _ -");

/** The three stages, and the fast path's one step that does all three (ADR 0113). */
export const STAGES = ["feature", "architecture", "stories", "small"] as const;
export const Stage = z.enum(STAGES);
export type Stage = z.infer<typeof Stage>;

/**
 * The change phase each stage belongs to, and so the gate its critic runs at. The fast path's
 * gate comes from its change type (fastGateOf); plan is where it lands when the type says nothing.
 */
export const STAGE_PHASE: Record<Stage, "define" | "design" | "plan"> = {
  feature: "define",
  architecture: "design",
  stories: "plan",
  small: "plan",
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
  newFlows: z.array(z.strictObject({ name: text(), repo: Id, why: text() })).default([]),
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
  /**
   * A write's sent fields that are stored as, or match rows by, a column of another name, as
   * the delta says it (ADR 0111 addendum, R3): `{ id: chat_id }` for a path parameter id that
   * is the chat_id column. Optional and additive: the flow delta stays at version 2.
   */
  as: z.record(z.string(), text()).optional(),
  /**
   * A field the step works out from columns, and how (W3b): `{ edited: "edited_at is not null" }`.
   * The expression names columns a step reads or writes, or of their tables; checked as a fact.
   * Optional and additive: the flow delta stays at version 2.
   */
  derived: z.record(z.string(), text()).optional(),
  /**
   * An entry step: the request fields it requires once the change is in (ADR 0125). A field
   * neither today's entry nor the catalog has, or one the catalog has as optional, breaks who
   * calls it. Optional and additive: the flow delta stays at version 2.
   */
  required: z.array(text()).optional(),
});
export type DeltaFields = z.infer<typeof DeltaFields>;

/** A delta step's `at` as its parts (B-places): the path, and the line or the function. */
export interface StepPlace {
  path: string;
  line?: number;
  function?: string;
}

/**
 * `path:line`, `path:function` or `path`; undefined for no path, or one that leaves the repo (an
 * absolute path, a drive letter, `..`).
 */
export function parseAt(at: string): StepPlace | undefined {
  const t = at.trim().replace(/\\/g, "/");
  const m = /^(.+?)(?::(\d+)|:([A-Za-z_$][\w$.#]*)(?:\(\))?)?$/.exec(t);
  if (!m) return undefined;
  const path = m[1]!.replace(/^\.\//, "");
  if (!path || path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.split("/").includes(".."))
    return undefined;
  return {
    path,
    ...(m[2] ? { line: Number(m[2]) } : {}),
    ...(m[3] ? { function: m[3] } : {}),
  };
}

/** A step's field names, from its lists (sends, returns, reads, checks, from, to), not `as`. */
export const fieldNames = (f: DeltaFields | undefined): string[] =>
  f
    ? (["sends", "returns", "reads", "checks", "from", "to"] as const).flatMap((k) => f[k] ?? [])
    : [];

/** What a delete of the referenced row does to the rows that reference it. */
export const ON_DELETE = ["set-null", "cascade", "restrict", "no-action"] as const;

/** A foreign key: the column it references, as `<db>.<table>.<column>`, and its on-delete. */
export const StoreKey = z.strictObject({
  references: z
    .string()
    .trim()
    .regex(/^[^.\s]+(\.[^.\s]+){2,}$/, "write the column it references as <db>.<table>.<column>"),
  onDelete: z.enum(ON_DELETE),
});
export type StoreKey = z.infer<typeof StoreKey>;

export const DeltaStep = z.strictObject({
  op: z.enum(["add", "change", "remove"]),
  /** change and remove: the step's position in today's flow, from 1. */
  step: z.number().int().positive().optional(),
  /** add: the position it goes after (0: first). */
  after: z.number().int().min(0).optional(),
  /**
   * add: where the new step's code goes in the repo (ADR 0124 addendum B-places), when the
   * drafter knows it from the code: `path:line` of the line it goes after, or `path:function`
   * (the function it goes in), or the path alone. Checked against the repo's checkout and the
   * catalog; the step's and its task's citation. Left out, the task is placed after the step
   * before it (its neighbour's citation) and says so. Optional and additive: version 2 stays.
   */
  at: z.string().trim().min(1).optional(),
  kind: z.enum(FLOW_STEP_KINDS).optional(),
  /** What the step does once the change is in, in one plain sentence. */
  what: z.string().optional(),
  /** call-out and publish: where it goes. `new` when the component or entry doesn't exist yet. */
  to: z.strictObject({ component: Id, entry: text(), new: z.boolean().default(false) }).optional(),
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
      /**
       * The foreign keys of the columns this change adds (ADR 0111 addendum, S4): each column to
       * the `<db>.<table>.<column>` it references, and what a delete of that row does. Optional
       * and additive, on the table's one definition: the flow delta stays at version 2.
       */
      keys: z.record(z.string(), StoreKey).optional(),
      /**
       * The components that read or write the table, from the map (ADR 0124 addendum B-arch):
       * given when the step's change to the table breaks them (a column the table has gets
       * another type, or the step is marked breaking). Optional and additive: version 2 stays.
       */
      consumers: z.array(Id).optional(),
    })
    .optional(),
  fields: DeltaFields.optional(),
  /**
   * The drafter says the step's change breaks who uses it today, where no field is dropped
   * (ADR 0124 addendum B-arch): a field whose meaning changes (a field now required is said
   * under the entry step's `fields.required`, ADR 0125). On a step
   * that stores into a table it is the table's change; on any other, the flow's entry's.
   */
  breaking: z.boolean().optional(),
  /** loop and retry: the steps it repeats, by their numbers in the target flow (ADR 0095). */
  repeats: z
    .strictObject({ from: z.number().int().positive(), to: z.number().int().positive() })
    .optional(),
  why: z.string().optional(),
});
export type DeltaStep = z.infer<typeof DeltaStep>;

/**
 * The flow delta's own version (ADR 0111): 2 adds `base`, the version of today's flow the delta
 * was written against. Version 1 files still read; they carry no base and are flagged as not
 * pinned. The other stage files stay at STAGE_SCHEMA_VERSION 1: they didn't change.
 */
export const FLOW_DELTA_SCHEMA_VERSION = 2 as const;

export const FlowDelta = z.strictObject({
  schemaVersion: z.union([z.literal(1), z.literal(FLOW_DELTA_SCHEMA_VERSION)]),
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
  /**
   * The components (or systems) that call the flow's entry today, from the map (ADR 0124
   * addendum B-arch): given when the change breaks what the entry reads or returns, or removes
   * the flow. Optional and additive: the flow delta stays at version 2.
   */
  consumers: z.array(Id).optional(),
  steps: z.array(DeltaStep).default([]),
  /**
   * Written by Atticus, never the assistant (ADR 0111): the sha-256 of today's flow's steps (each
   * step's kind, what, to and store, in order) when this delta was written. A spec drafted again
   * since then gives another hash, so the merge says the step numbers may be stale.
   */
  base: z.strictObject({ steps: z.string().regex(/^[0-9a-f]{64}$/) }).optional(),
});
export type FlowDelta = z.infer<typeof FlowDelta>;

/**
 * One step of a change's deploy order across its repos (ADR 0124 addendum B-arch), in the order
 * they deploy: a repo's code, or, with `migration`, a migration (the file a target flow names
 * under store.migration) run from that repo. Kept in stage/architecture-deploy.yaml.
 */
export const DeployStep = z.strictObject({
  repo: Id,
  migration: z.string().trim().min(1).optional(),
  /** Why it sits where it does, in one plain sentence. */
  why: z.string().optional(),
});
export type DeployStep = z.infer<typeof DeployStep>;

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
  /**
   * decision: a person can decide it (the product, the data, the design), so a repeat or a
   * flip becomes a question; drafting: the shape of what the assistant wrote, so a repeat or
   * a flip stops the loop with a message instead (see finding-kind.ts). Left out: decision.
   */
  kind: z.enum(["decision", "drafting"]).optional(),
  /** The iteration a drafting finding stopped the loop in; earlier sightings don't count again. */
  stoppedAt: z.number().int().positive().optional(),
  /**
   * What a judge refused, so a person's answer to the finding's question is stored as their
   * verdict on exactly that (ADR 0117 addendum, V1): each field and the criterion it was claimed for.
   */
  judged: z.array(z.strictObject({ field: text(), criterion: text(), task: text() })).optional(),
  /**
   * A critic's risk finding (ADR 0115 addendum, 2026-10-25): it never blocks, and goes back to
   * the drafter with its fix for one more draft.
   */
  risk: z.boolean().optional(),
});
export type LoopFinding = z.infer<typeof LoopFinding>;

export const StageLoop = z.strictObject({
  schemaVersion: V,
  change: Id,
  stage: Stage,
  /** Drafts so far. */
  iteration: z.number().int().min(0),
  /** stopped: a drafting finding came back and the loop stopped for a person to fix a file. */
  state: z.enum(["drafting", "waiting", "questions", "stopped", "done"]),
  updatedAt: z.string(),
  /** The hand-off run being waited for. */
  run: z.string().optional(),
  /** Every finding seen in any iteration, current or not, so a flip is seen. */
  findings: z.array(LoopFinding).default([]),
  /** Questions this stage raised, by id. */
  questions: z.array(z.string()).default([]),
  /** Answered questions whose answers a draft has read. */
  read: z.array(z.string()).default([]),
  /**
   * Questions held back once and handed to the drafter with an answer on file that may decide
   * them, by the id they would have had (ADR 0117 addendum, 2026-10-24). One asked again after
   * that goes to a person. Also the critic's risks handed back for their one draft, as
   * `risk:<rule>:<file>` (ADR 0115 addendum, 2026-10-25).
   */
  handedBack: z.array(z.string()).optional(),
  /**
   * An answer that didn't read, copied into the change folder when the loop stopped on it (S5),
   * change-folder relative: the file the stop tells a person to fix, read back on the next run.
   */
  failedAnswer: z.string().optional(),
  /** A read-again of an answer that isn't YAML, handed off and waited for (S5): no draft spent. */
  readAgain: z.string().optional(),
  /**
   * The stage's source, change-folder relative (ADR 0087 addendum, 2026-10-25): the file or folder
   * a person edits (feature.yaml, target-flows/, stage/stories-answer.yaml). Every other file
   * under `written` is rendered from it, so a fix to one of those is refused with a pointer here.
   */
  source: z.string().optional(),
  /**
   * The questions due that the last stop didn't ask, over the change policy's questionsPerStop
   * (ADR 0117 addendum, 2026-10-25): their words and evidence, so a person sees what comes next
   * (`atticus questions list`). They are asked once the open ones are answered.
   */
  waiting: z.array(z.strictObject({ question: text(), evidence: z.array(z.string()) })).optional(),
  /** The critic rounds the loop ran, newest last. */
  critic: z.array(z.strictObject({ gate: text(), round: z.number().int().positive() })).default([]),
  /**
   * What Atticus last wrote, by change-folder path: the sha-256 of each file (ADR 0087 addendum,
   * 2026-10-24). A file that differs, or one under the stage's source that isn't listed, is a
   * person's edit: their version is the stage's answer, and it is never drafted over.
   */
  written: z.record(z.string(), z.string()).optional(),
  /**
   * The drafts that were a person's: the iteration, when, the files they edited and where
   * Atticus kept a copy of them before writing anything. Who wrote each draft, for provenance.
   */
  byPerson: z
    .array(
      z.strictObject({
        iteration: z.number().int().positive(),
        at: z.string(),
        files: z.array(z.string()),
        kept: z.string(),
        /** checked: their version was checked as the stage's draft; redrafted: the assistant drafted again from it (--force, or with answers). */
        how: z.enum(["checked", "redrafted"]),
      }),
    )
    .optional(),
  /**
   * A draft whose critic round is waiting for its AI lenses, handed off one at a time (ADR
   * 0115): the round, the draft's run and files, and what the stage's checks and the critic's
   * rules found in it, which join the lenses' findings once every lens is in.
   */
  review: z
    .strictObject({
      gate: text(),
      round: z.number().int().positive(),
      draft: z.string().optional(),
      /** person: the draft under review is a person's edit, so a blocking finding stops for them. */
      by: z.enum(["person"]).optional(),
      files: z.array(z.string()).default([]),
      /**
       * The questions the draft raised (ADR 0117 addendum, 2026-10-24): the stage's file doesn't
       * keep them, so they wait here with the draft until its lenses are in, and are raised then.
       */
      questions: z.array(QuestionDraft).optional(),
      issues: z
        .array(
          z.strictObject({
            rule: text(),
            target: text(),
            evidence: z.string().optional(),
            message: text(),
            blocking: z.boolean(),
            repo: z.string().optional(),
            kind: z.enum(["decision", "drafting"]).optional(),
            // The rest of a stage's issue (loop.ts StageIssue), kept for when the lenses are in:
            // a judged doubt goes back once, then is asked with its options, citing its line.
            options: z
              .array(z.strictObject({ label: text(), means: text(), changes: text() }))
              .optional(),
            ask: z.string().optional(),
            holdOnce: z.boolean().optional(),
            locateText: z.string().optional(),
            judged: z
              .array(z.strictObject({ field: text(), criterion: text(), task: text() }))
              .optional(),
            risk: z.boolean().optional(),
          }),
        )
        .default([]),
    })
    .optional(),
});
export type StageLoop = z.infer<typeof StageLoop>;
