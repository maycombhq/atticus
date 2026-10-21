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

/**
 * How the critic tells a screen's own lines in a UI flow (ADR 0089): words, letter case
 * aside, that a line naming a person's action, a page load or what the screen does after a
 * response contains. An organisation with its own UI framework lists its own words.
 */
export const DEFAULT_UI_WORDS = {
  action: [
    "submit",
    "click",
    "press",
    "tap",
    "button",
    "form",
    "input",
    "select",
    "change",
    "href",
    "link",
    "keyup",
    "keydown",
    "drop",
    "toggle",
  ],
  page: [
    "route",
    "path",
    "page",
    "load",
    "init",
    "mount",
    "effect",
    "created",
    "activated",
    "resolve",
    "view",
    "screen",
  ],
  end: [
    "navigate",
    "router",
    "redirect",
    "location",
    "route",
    "refresh",
    "reload",
    "render",
    "show",
    "display",
    "setstate",
    "set(",
    "emit",
    "alert",
    "error",
    "message",
    "toast",
    "notify",
    "dialog",
    "close",
  ],
} as const;

export const SpecUi = z.strictObject({
  /** Words on a line where a person acts: a button, a form, a link. */
  actionWords: z
    .array(z.string().min(1))
    .min(1)
    .default([...DEFAULT_UI_WORDS.action]),
  /** Words on a line where a page loads: a route, an init hook. */
  pageWords: z
    .array(z.string().min(1))
    .min(1)
    .default([...DEFAULT_UI_WORDS.page]),
  /** Words on a line where the screen acts on a response: navigate, refresh, show an error. */
  endWords: z
    .array(z.string().min(1))
    .min(1)
    .default([...DEFAULT_UI_WORDS.end]),
});
export type SpecUi = z.infer<typeof SpecUi>;

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
  /** How the critic reads a UI flow's first and last lines (ADR 0089). */
  ui: SpecUi.default(SpecUi.parse({})),
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
      why: "Every entry point the repo serves starts a flow. It starts at the entry point; the trigger names who calls it (a vendor, another organisation's service, a scheduler, another repo's component) and how the call arrives (the gateway it comes through, or direct); when the code and config don't say, ask. It ends with the response or acknowledgement to that caller, after every call-out, event and write in order.",
    },
    {
      kind: "listener",
      from: { kind: "Endpoint", endpointType: ["event-topic", "mq-queue", "file-drop"] },
      why: "Every topic, queue or file drop the repo listens to starts a flow. The trigger names who sends to it and through what; when the code and config don't say, ask. It ends with the acknowledgement, after every call-out, event and write in order.",
    },
    {
      kind: "job",
      from: { kind: "Endpoint", endpointType: ["batch-job", "function"] },
      why: "Every job or scheduled function starts a flow.",
    },
    {
      kind: "page",
      why: "In a UI, a page that loads data starts a flow. It starts at the page's route or load hook and ends with what the page shows, or does on an error.",
    },
    {
      kind: "action",
      why: "In a UI, a button or form that calls out starts a flow. It starts at the person's action in the component or template (the form, the button), not in the service it calls, and ends with what the screen does after the response (navigate, refresh, show an error).",
    },
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
      why: "A transform names which fields become which. Write one wherever data crosses types: a form value to a request, a request to a DTO, a DTO to an entity, an entity to a DTO, a request to an event or to a downstream API's request.",
    },
    {
      kind: "validate",
      requires: ["data.checks"],
      why: "A validation names its rules. Each layer is its own step: the form, the request schema, the entity's constraints.",
    },
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

// ---------- the estate pass (ADR 0085) ----------

export const ESTATE_JOINS_SCHEMA_VERSION = 1 as const;

/**
 * How a call-out was matched to the flow its target starts: `interface`, through the catalog's
 * Interface from the caller's component to the target (and its gateway route); `endpoint`, the
 * step names the target's Endpoint id itself; `path`, no Interface, so by method and
 * normalised path on the target component.
 */
export const ESTATE_JOIN_HOW = ["interface", "endpoint", "path"] as const;

/**
 * Why a call-out wasn't joined: `no-target`, the catalog has no component or entry point it
 * reaches; `no-flow`, it reaches an entry point no flow starts at; `no-citation`, one end
 * (the caller's step or the callee's trigger) cites no file and line that exists;
 * `family-mismatch` (ADR 0088), no flow starts at the entry point it reaches, and the only ones
 * that stand for it do so through a family member spec check finds wrong.
 */
export const ESTATE_UNMATCHED_REASONS = [
  "no-target",
  "no-flow",
  "no-citation",
  "family-mismatch",
] as const;

/** A file and line, as `path:line` in the repo named beside it. */
const Cite = z.string().regex(/^.+:\d+$/, "a citation is path:line");

/** One call-out joined to the flow its target starts. Both ends cite a file and line. */
export const EstateJoin = z.strictObject({
  /** The caller: its repo, flow and step (1-based), and the step's citation. */
  from: z.strictObject({
    repo: RecordId,
    flow: RecordId,
    step: z.number().int().positive(),
    evidence: Cite,
  }),
  /** The callee: its repo, the flow, the Endpoint its trigger is, and the trigger's citation. */
  to: z.strictObject({
    repo: RecordId,
    flow: RecordId,
    trigger: RecordId,
    evidence: Cite,
  }),
  /** What the step names as its target: `<component> <entry>`. */
  entry: z.string().min(1),
  /** The Interface the call goes over, when the catalog has one. */
  interface: RecordId.optional(),
  how: z.enum(ESTATE_JOIN_HOW),
});
export type EstateJoin = z.infer<typeof EstateJoin>;

/** A call-out that wasn't joined, with why. */
export const EstateUnmatched = z.strictObject({
  from: z.strictObject({
    repo: RecordId,
    flow: RecordId,
    step: z.number().int().positive(),
    evidence: Cite.optional(),
  }),
  entry: z.string().min(1),
  reason: z.enum(ESTATE_UNMATCHED_REASONS),
  /** The entry point it reached, for `no-flow` and `no-citation`. */
  trigger: RecordId.optional(),
  interface: RecordId.optional(),
  message: z.string().min(1),
});
export type EstateUnmatched = z.infer<typeof EstateUnmatched>;

/** specs/estate.yaml: every call-out of the metarepo's specs, joined or not (ADR 0085). */
export const EstateJoins = z.strictObject({
  schemaVersion: z.literal(ESTATE_JOINS_SCHEMA_VERSION),
  joinedAt: IsoDateTime,
  /** The repos whose specs were read. */
  repos: z.array(RecordId).default([]),
  joins: z.array(EstateJoin).default([]),
  unmatched: z.array(EstateUnmatched).default([]),
});
export type EstateJoins = z.infer<typeof EstateJoins>;
