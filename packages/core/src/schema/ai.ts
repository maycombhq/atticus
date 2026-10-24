import { z } from "zod";
import { IsoDateTime, RecordId } from "./common.js";
import { BUILT_IN_ROLES, ChangeArtifact } from "./orgpack.js";

/**
 * Contract C5: the AI runtime's files. Agent definitions live in org-pack/agents/<id>.yaml;
 * context-pack manifests and run summaries are written per run. See ADR 0014.
 */
export const AI_SCHEMA_VERSION = 1 as const;

export const RuntimeKind = z.enum(["hand-off", "model", "headless-claude-code", "mock", "replay"]);
export type RuntimeKind = z.infer<typeof RuntimeKind>;

/** What an agent may be given as input. */
export const AgentInput = z.union([
  ChangeArtifact,
  z.enum([
    "catalog-slice",
    "checklist",
    "skills",
    "patterns",
    "glossary",
    "repo-code",
    "documents",
  ]),
]);

export const AgentDefinition = z
  .strictObject({
    schemaVersion: z.literal(AI_SCHEMA_VERSION),
    id: RecordId,
    /** The role the agent works for, e.g. the story writer works for the business analyst. */
    role: z.union([z.enum(BUILT_IN_ROLES), RecordId]),
    description: z.string().min(1),
    inputs: z.array(AgentInput).min(1),
    /** The change artifact it writes, or "findings" for critic agents. */
    outputArtifact: z.union([ChangeArtifact, z.literal("findings"), z.literal("code")]),
    /** Checklist pack used to check (or, for a critic, to apply) the output. */
    checklist: RecordId.optional(),
    tokenBudget: z.number().int().positive(),
    allowedRuntimes: z.array(RuntimeKind).min(1),
  })
  .superRefine((a, ctx) => {
    if (a.outputArtifact === "findings" && !a.checklist) {
      ctx.addIssue({
        code: "custom",
        path: ["checklist"],
        message: "a critic agent needs a checklist",
      });
    }
    if (a.inputs.includes(a.outputArtifact as never) && a.outputArtifact !== "findings") {
      ctx.addIssue({
        code: "custom",
        path: ["inputs"],
        message: "an agent can't read the artifact it writes",
      });
    }
  });
export type AgentDefinition = z.infer<typeof AgentDefinition>;

/** One source in a context pack. Ingested text is wrapped as quoted data in the prompt. */
export const ContextSource = z.strictObject({
  id: z.string().min(1),
  kind: z.enum([
    "artifact",
    "catalog",
    "checklist",
    "skill",
    "pattern",
    "document",
    "code",
    "instruction",
  ]),
  /** Where it came from: a path in the metarepo or a repo, or a record id. */
  origin: z.string().min(1),
  bytes: z.number().int().min(0),
  tokens: z.number().int().min(0),
  classification: RecordId,
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** Trusted sources are Atticus's own instructions and the org pack; everything else is data. */
  trusted: z.boolean(),
});

export const ContextPackManifest = z.strictObject({
  schemaVersion: z.literal(AI_SCHEMA_VERSION),
  change: RecordId,
  agent: RecordId,
  createdAt: IsoDateTime,
  budget: z.number().int().positive(),
  totalTokens: z.number().int().min(0),
  sources: z.array(ContextSource),
  /** Sources left out to stay within budget or classification, with why. */
  dropped: z.array(z.strictObject({ id: z.string(), reason: z.string() })).default([]),
  /** sha256 of the assembled prompt, so a replay can prove it saw the same input. */
  promptSha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ContextPackManifest = z.infer<typeof ContextPackManifest>;

/** Hand-off steps: prepared → waiting → produced → validated, or failed (then Retry). */
export const RunState = z.enum([
  "prepared",
  "waiting",
  "produced",
  "validated",
  "failed",
  "cancelled",
]);
export type RunState = z.infer<typeof RunState>;

/**
 * The run record's own version: 2 adds the tools a run's model called (ADR 0107 addendum); 3 how
 * its context was retrieved (ADR 0116): the model's expansion of the input and its order of the
 * candidates. A version 1 or 2 record is read through `migrateRunSummary`, with neither.
 */
export const RUN_SCHEMA_VERSION = 3 as const;

/**
 * How a run's context was retrieved (ADR 0116), when a model helped: what it read the input as
 * (search terms, the names it found, each mapped to an id the index has or said new, with the
 * input's words it took each from, and what the checks dropped) and its order of the candidates
 * (the ones it was shown, the ones it kept in its order, the ones it dropped). Each names the run
 * that answered, or says it came from the store of earlier answers. Data, never instructions.
 */
export const RunRetrieval = z.strictObject({
  expansion: z
    .strictObject({
      run: z.string().min(1).optional(),
      cached: z.boolean(),
      terms: z.array(z.string()),
      names: z.array(
        z.strictObject({
          name: z.string().min(1),
          id: z.string().min(1).optional(),
          new: z.boolean().optional(),
          quote: z.string(),
        }),
      ),
      dropped: z.array(z.strictObject({ name: z.string(), why: z.string() })).default([]),
    })
    .optional(),
  rerank: z
    .strictObject({
      run: z.string().min(1).optional(),
      cached: z.boolean(),
      shown: z.number().int().min(0),
      order: z.array(z.string()),
      dropped: z.array(z.string()),
      /** false: the answer named a candidate it wasn't shown (or one twice), so it was ignored. */
      used: z.boolean(),
    })
    .optional(),
  /** Whether similarity in meaning ranked too, or why not. */
  meaning: z.string().optional(),
});
export type RunRetrieval = z.infer<typeof RunRetrieval>;

/** A read-only tool a step's model may call beside its pack (ADR 0107 point 4). */
export const ToolDefinition = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  description: z.string().min(1),
  /** JSON Schema of the tool's input (an object). */
  inputSchema: z.record(z.string(), z.unknown()),
});
export type ToolDefinition = z.infer<typeof ToolDefinition>;

/** One tool call a model made, and what it was given back, as kept in the run record. */
export const ToolCallRecord = z.strictObject({
  /** The round of the conversation it was made in, from 1. */
  round: z.number().int().positive(),
  /** The provider's id of the call, when it gives one. */
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  /** What the model was given back, exactly (data, already cut to the caps). */
  output: z.string(),
  /** Tokens of the output, as the pack counts them. */
  tokens: z.number().int().min(0),
  /** The call failed or was refused; the output says why. */
  error: z.boolean().optional(),
});
export type ToolCallRecord = z.infer<typeof ToolCallRecord>;

/** The tools a run offered and how its model used them. */
export const RunTools = z.strictObject({
  /** The tools offered, by name. */
  offered: z.array(z.string()),
  calls: z.array(ToolCallRecord).default([]),
  /** When a cap ended the tool calls: which one (the rounds, or the tokens tools may return). */
  stopped: z.string().min(1).optional(),
});
export type RunTools = z.infer<typeof RunTools>;

/** What goes into review/ for every run; full packs and transcripts stay in git-ignored .runs/. */
export const RunSummary = z.strictObject({
  schemaVersion: z.literal(RUN_SCHEMA_VERSION),
  runId: z.string().regex(/^run-[0-9a-z-]+$/),
  change: RecordId,
  agent: RecordId,
  runtime: RuntimeKind,
  state: RunState,
  startedAt: IsoDateTime,
  finishedAt: IsoDateTime.optional(),
  /** Change-folder-relative path of what the run wrote. */
  output: z.string().optional(),
  usage: z
    .strictObject({ inputTokens: z.number().int().min(0), outputTokens: z.number().int().min(0) })
    .optional(),
  contextManifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
  errors: z.array(z.string()).default([]),
  attempt: z.number().int().positive().default(1),
  /** The tools the run's model was offered and what it called (version 2). */
  tools: RunTools.optional(),
  /** How the run's context was retrieved, when a model helped (version 3, ADR 0116). */
  retrieval: RunRetrieval.optional(),
});
export type RunSummary = z.infer<typeof RunSummary>;

/**
 * A stored run record at the current version: version 1 (before tools) and 2 (before retrieval)
 * read as version 3 with neither; anything else is returned as it is, for the schema to judge.
 */
export function migrateRunSummary(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const r = raw as Record<string, unknown>;
  return r.schemaVersion === 1 || r.schemaVersion === 2
    ? { ...r, schemaVersion: RUN_SCHEMA_VERSION }
    : raw;
}

/** Read a stored run record of any version (ADR 0107 addendum). */
export const readRunSummary = (raw: unknown) => RunSummary.safeParse(migrateRunSummary(raw));

/** A recorded model output for the replay runtime, keyed by agent and prompt hash. */
export const Recording = z.strictObject({
  schemaVersion: z.literal(AI_SCHEMA_VERSION),
  agent: RecordId,
  promptSha256: z.string().regex(/^[0-9a-f]{64}$/),
  output: z.string(),
  usage: z.strictObject({
    inputTokens: z.number().int().min(0),
    outputTokens: z.number().int().min(0),
  }),
  model: z.string().min(1),
  recordedAt: IsoDateTime,
});
export type Recording = z.infer<typeof Recording>;
