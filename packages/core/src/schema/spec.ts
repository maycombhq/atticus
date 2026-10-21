import { z } from "zod";
import { IsoDateTime, RecordId } from "./common.js";
import { FLOW_STEP_KINDS, FLOW_TRIGGER_KINDS } from "./kinds.js";
import { QuestionId } from "./question.js";

/**
 * Repo specs (ADR 0079): the spec template a repo type carries (C6,
 * org-pack/repo-types/<id>/spec-template.yaml), the header of a repo's spec
 * (specs/<repo>/spec.yaml) and the critic's last findings (specs/<repo>/findings.yaml).
 */

export const SPEC_TEMPLATE_SCHEMA_VERSION = 1 as const;
export const SPEC_HEADER_SCHEMA_VERSION = 1 as const;
export const SPEC_FINDINGS_SCHEMA_VERSION = 1 as const;

/** What a step of a kind must record, besides its citation. */
export const STEP_REQUIREMENTS = [
  "to",
  "store.table",
  "store.columns",
  "data.sends",
  "data.returns",
  "data.reads",
  "data.checks",
  "data.from",
  "data.to",
] as const;
export type StepRequirement = (typeof STEP_REQUIREMENTS)[number];

/**
 * How triggers of a kind are found in the catalog: every Endpoint of these endpoint types, or
 * every Interface over these vias and directions. A trigger kind without `from` (a page, a
 * button) is found by the assistant, so the critic can't count them.
 */
export const TriggerSource = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("Endpoint"),
    endpointType: z.array(z.string().min(1)).min(1),
  }),
  z.strictObject({
    kind: z.literal("Interface"),
    via: z.array(z.string().min(1)).min(1),
    direction: z.array(z.enum(["outbound", "inbound", "bidirectional"])).default(["inbound"]),
  }),
]);
export type TriggerSource = z.infer<typeof TriggerSource>;

export const SpecTemplate = z.strictObject({
  schemaVersion: z.literal(SPEC_TEMPLATE_SCHEMA_VERSION),
  /** The repo type it belongs to (the folder under repo-types/), or `default`. */
  repoType: RecordId,
  /** Raised when the template changes; flows record <repoType>@<version>. */
  version: z.number().int().positive(),
  /** Which triggers a repo of the type has, and where in the catalog they are. */
  triggers: z
    .array(
      z.strictObject({
        kind: z.enum(FLOW_TRIGGER_KINDS),
        from: TriggerSource.optional(),
        why: z.string().min(1),
      }),
    )
    .min(1),
  /** The step kinds that occur, and what each must record. A kind not listed may still occur. */
  steps: z
    .array(
      z.strictObject({
        kind: z.enum(FLOW_STEP_KINDS),
        requires: z.array(z.enum(STEP_REQUIREMENTS)).default([]),
        why: z.string().min(1).optional(),
      }),
    )
    .default([]),
  /**
   * How flows group into families: by `resource`, the triggers of one component on the same
   * path once a trailing parameter is dropped (GET /owners, POST /owners, GET /owners/{id})
   * may be one flow that lists the others in `family`.
   */
  families: z
    .array(
      z.strictObject({
        id: RecordId,
        by: z.literal("resource"),
        why: z.string().min(1),
      }),
    )
    .default([]),
});
export type SpecTemplate = z.infer<typeof SpecTemplate>;

/** The spec template used for a repo with no repo type, or a type without its own template. */
export const DEFAULT_SPEC_TEMPLATE: SpecTemplate = SpecTemplate.parse({
  schemaVersion: 1,
  repoType: "default",
  version: 1,
  triggers: [
    {
      kind: "endpoint",
      from: {
        kind: "Endpoint",
        endpointType: [
          "rest",
          "grpc",
          "soap",
          "graphql",
          "websocket",
          "sse",
          "webhook",
          "transaction",
        ],
      },
      why: "Every entry point the repo serves starts a flow.",
    },
    {
      kind: "listener",
      from: { kind: "Endpoint", endpointType: ["event-topic", "mq-queue", "file-drop"] },
      why: "Every topic, queue or file drop the repo listens to starts a flow.",
    },
    {
      kind: "job",
      from: { kind: "Endpoint", endpointType: ["batch-job", "function"] },
      why: "Every job or scheduled function starts a flow.",
    },
    { kind: "page", why: "In a UI, a page that loads data starts a flow." },
    { kind: "action", why: "In a UI, a button or form that calls out starts a flow." },
  ],
  steps: [
    { kind: "entry" },
    { kind: "lookup" },
    { kind: "read", requires: ["store.table"], why: "A read names the table it reads." },
    {
      kind: "write",
      requires: ["store.table", "store.columns"],
      why: "A write names the table and the columns it writes.",
    },
    { kind: "call-out", requires: ["to"], why: "A call-out names where it goes." },
    { kind: "publish", requires: ["to"], why: "A publish names the topic it goes to." },
    {
      kind: "transform",
      requires: ["data.from", "data.to"],
      why: "A transform names which fields become which.",
    },
    { kind: "validate", requires: ["data.checks"], why: "A validation names its rules." },
    { kind: "branch" },
    { kind: "log" },
    { kind: "respond" },
    { kind: "loop" },
    { kind: "retry" },
  ],
  families: [
    {
      id: "crud",
      by: "resource",
      why: "Plain create, read, update and delete entry points on one resource are one flow with its variations, not one flow each.",
    },
  ],
});

/** `<repoType>@<version>`, as a flow records it. */
export const templateRef = (t: SpecTemplate): string => `${t.repoType}@${t.version}`;

/** The header of a repo's spec: specs/<repo>/spec.yaml. */
export const SpecHeader = z.strictObject({
  schemaVersion: z.literal(SPEC_HEADER_SCHEMA_VERSION),
  repo: RecordId,
  /** The commit the spec was drafted from, when known. */
  commit: z
    .string()
    .regex(/^[0-9a-f]{7,64}$/)
    .optional(),
  /** The template it was written against: <repoType>@<version>. */
  template: z.string().regex(/^[a-z0-9][a-z0-9._-]*@\d+$/),
  /** False until the template is merged; the spec reads "template not yet reviewed" until then. */
  templateReviewed: z.boolean().default(false),
  /** The last draft. */
  drafted: z
    .strictObject({
      at: IsoDateTime,
      run: z.string().min(1).optional(),
    })
    .optional(),
  /** The flows in the spec, by id. */
  flows: z.array(RecordId).default([]),
  /** Each cited file and the sha-256 (first 16 hex) it had, so a changed file marks its flows stale. */
  files: z.record(z.string(), z.string().regex(/^[0-9a-f]{16}$/)).default({}),
  /** Questions (ADR 0078) raised about this spec and still open. */
  questions: z.array(QuestionId).default([]),
});
export type SpecHeader = z.infer<typeof SpecHeader>;

/** One finding of the spec critic. */
export const SpecFinding = z.strictObject({
  /** sha-256 (first 12 hex) of rule, target and evidence. */
  fingerprint: z.string().regex(/^[0-9a-f]{12}$/),
  rule: z.string().min(1),
  /** What it is about: a flow id, with the trigger, step, table or field. */
  target: z.string().min(1),
  /** path:line the finding is about, when there is one. */
  evidence: z.string().optional(),
  message: z.string().min(1),
  /** How many checks in a row, across redrafts, found it. */
  seen: z.number().int().positive().default(1),
  /** The question it became, once it came back unchanged after a redraft. */
  question: QuestionId.optional(),
});
export type SpecFinding = z.infer<typeof SpecFinding>;

/** The critic's last findings: specs/<repo>/findings.yaml. */
export const SpecFindings = z.strictObject({
  schemaVersion: z.literal(SPEC_FINDINGS_SCHEMA_VERSION),
  repo: RecordId,
  checkedAt: IsoDateTime,
  /** The draft the check read (the header's drafted.at), so a redraft between checks is seen. */
  draftedAt: IsoDateTime.optional(),
  findings: z.array(SpecFinding).default([]),
});
export type SpecFindings = z.infer<typeof SpecFindings>;

/** The template for a repo type: its own when the org pack has one, else the default. */
export function specTemplateFor(
  templates: readonly SpecTemplate[],
  repoType: string | undefined,
): SpecTemplate {
  return (repoType && templates.find((t) => t.repoType === repoType)) || DEFAULT_SPEC_TEMPLATE;
}
