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

/** What goes into review/ for every run; full packs and transcripts stay in git-ignored .runs/. */
export const RunSummary = z.strictObject({
  schemaVersion: z.literal(AI_SCHEMA_VERSION),
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
});
export type RunSummary = z.infer<typeof RunSummary>;

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
