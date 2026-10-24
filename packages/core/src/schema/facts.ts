import { z } from "zod";
import { Auth, FLOW_STEP_KINDS } from "./kinds.js";

/**
 * The facts file: what the assistant writes when it reads a repo (ADR 0124). One JSON line
 * per fact, in six kinds plus flows, every one with a citation. It is the assistant's input
 * format, projected into catalog C1 by `projectFacts`; it is not a catalog contract of its own.
 *
 * A fact without a citation is not a fact; it is a question.
 */

const str = () => z.string().min(1);

export const FACT_KINDS = ["entry", "call", "store", "field", "deploy", "config", "flow"] as const;
export type FactKind = (typeof FACT_KINDS)[number];

/** A fact's id: any slug the assistant chooses; the projection makes catalog ids from the claim. */
export const FactId = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "fact ids are lowercase slugs: a-z, 0-9, '.', '_' and '-'");

/**
 * Another line that holds part of a claim built in code: a base URL, a class-level or group
 * prefix, a context path, a gateway's route, a proto's package and service, an MVC route
 * template. `value` is the part as written there.
 */
export const CitePart = z.strictObject({
  file: str(),
  line: z.number().int().positive(),
  value: str(),
});

/**
 * Where a fact rests. `value` is what the verifier looks for on the line (the route, the topic,
 * the table, the field, the host or the key); `quote` is the line's text, or enough of it, as a
 * second anchor. The verifier normalises the quote and never requires it from a binary,
 * notebook or minified file.
 */
export const Cite = z.strictObject({
  file: str(),
  line: z.number().int().positive(),
  value: str(),
  quote: z.string().max(200).optional(),
  /**
   * The other lines a path is put together from (ADR 0124 addendum A4): every plain part of the
   * path must be written on the cited line or one of these, each part on its own line.
   */
  with: z.array(CitePart).max(6).optional(),
});
export type Cite = z.infer<typeof Cite>;

/** Who confirmed the fact: the line check, a sample session, a person, or nobody yet. */
export const FactVerified = z.enum(["line", "sample", "person", "none"]);
/** Who produced it. */
export const FactBy = z.enum(["assistant", "reader", "person"]);
/** declared: the code states it; inferred: the assistant concluded it. */
export const FactConf = z.enum(["declared", "inferred"]);

const common = {
  id: FactId,
  repo: str(),
  commit: z.string().regex(/^[0-9a-f]{7,64}$/),
  /** The module in the repo the fact belongs to; the repo itself when left out. */
  component: z.string().optional(),
  cite: Cite,
  verified: FactVerified.default("none"),
  by: FactBy.default("assistant"),
  conf: FactConf.default("declared"),
};

export const ENTRY_TYPES = [
  "rest",
  "grpc",
  "soap",
  "graphql",
  "event-topic",
  "mq-queue",
  "batch-job",
  "function",
  "webhook",
  "websocket",
  "sse",
  "file-drop",
  "transaction",
  "screen",
] as const;

export const EntryFact = z.strictObject({
  kind: z.literal("entry"),
  ...common,
  entryType: z.enum(ENTRY_TYPES),
  method: z.string().optional(),
  /** The path, topic, queue, schedule, screen route or transaction id. */
  path: str(),
  handler: z.string().optional(),
  auth: Auth.optional(),
});

export const CALL_TYPES = [
  "rest",
  "grpc",
  "soap",
  "graphql",
  "event-topic",
  "mq-queue",
  "sftp",
  "webhook",
] as const;

export const CallFact = z.strictObject({
  kind: z.literal("call"),
  ...common,
  callType: z.enum(CALL_TYPES),
  method: z.string().optional(),
  path: str(),
  /** The host the call goes to, when the code names one. */
  host: z.string().optional(),
  /** The config key or constant the base URL comes from (ADR 0076). */
  base: z.string().optional(),
  /** The target component or system, when the assistant can name it; else the call stays unresolved. */
  to: z.string().optional(),
  /** The entry this call is made from. */
  from: FactId.optional(),
  sync: z.enum(["sync", "async"]).optional(),
});

export const StoreFact = z.strictObject({
  kind: z.literal("store"),
  ...common,
  /** The data store's name or id (a database, a bucket, a cache). */
  store: str(),
  storeType: z.string().optional(),
  /** The table, collection, key pattern, bucket path or queue. */
  name: str(),
  op: z.enum(["read", "write", "delete"]),
  tableKind: z.enum(["table", "view", "collection", "key-pattern"]).optional(),
  /** The entry under which the access happens. */
  under: FactId.optional(),
  columns: z.array(str()).optional(),
});

export const FieldFact = z.strictObject({
  kind: z.literal("field"),
  ...common,
  /** The entry, call or store fact the field belongs to. */
  owner: FactId,
  side: z.enum(["request", "response", "column", "screen", "message"]).optional(),
  name: str(),
  type: z.string().optional(),
  required: z.boolean().optional(),
  default: z.string().optional(),
  classification: z.string().optional(),
  /** Another field fact this one maps to (a request field to a column, say). */
  mappedTo: FactId.optional(),
  transform: z.string().optional(),
});

export const DeployFact = z.strictObject({
  kind: z.literal("deploy"),
  ...common,
  env: z.string().optional(),
  /** kubernetes, openshift, cloud-run, lambda, vm, ... */
  platform: str(),
  cloud: z.string().optional(),
  resourceType: z.string().optional(),
  resourceName: z.string().optional(),
  region: z.string().optional(),
  pipeline: z.string().optional(),
  replicas: z.number().int().nonnegative().optional(),
});

export const SETTING_KINDS = [
  "timeout",
  "retry",
  "circuit-breaker",
  "rate-limit",
  "pool",
  "cache-ttl",
  "feature-flag",
  "config",
  "schedule",
] as const;

/** Values that are secrets, or look like them, are never facts. */
/** A key whose last part ends in a secret word (`ClientSecret`, `db.password`), not one that only mentions it (`TokenUrl`, `AccessTokenLifetime`). */
const SECRET_KEY =
  /(password|passwd|pwd|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|credentials?)$/i;
const SECRET_SOURCE = /^(env:|vault:|secret:|ref:|\$\{|\{\{)/;

export const ConfigFact = z
  .strictObject({
    kind: z.literal("config"),
    ...common,
    settingKind: z.enum(SETTING_KINDS).default("config"),
    key: str(),
    /** The literal value, when it is not a secret. */
    value: z.string().optional(),
    /** Where the value comes from instead (env:NAME, vault:path, a placeholder). */
    source: z.string().optional(),
    /** The component or system the setting is about (a client's timeout names its target). */
    target: z.string().optional(),
  })
  .superRefine((c, ctx) => {
    const last =
      c.key
        .trim()
        .split(/[.:]|__|\s+/)
        .pop() ?? c.key;
    if (c.value !== undefined && SECRET_KEY.test(last) && !SECRET_SOURCE.test(c.value)) {
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message: `"${c.key}" looks like a secret: give its source (env:NAME, vault:path), never its value`,
      });
    }
  });

export const FlowFactStep = z.strictObject({
  kind: z.enum(FLOW_STEP_KINDS),
  what: str(),
  /** The entry, call, store or field fact the step touches. */
  ref: FactId.optional(),
  cite: Cite,
});

export const FlowFactError = z.strictObject({
  when: str(),
  then: str(),
  cite: Cite,
});

export const FlowFact = z.strictObject({
  kind: z.literal("flow"),
  ...common,
  name: str(),
  /** The entry fact that starts the flow. */
  entry: FactId,
  steps: z.array(FlowFactStep).min(1),
  outcome: z.string().optional(),
  errors: z.array(FlowFactError).default([]),
});

export const Fact = z.discriminatedUnion("kind", [
  EntryFact,
  CallFact,
  StoreFact,
  FieldFact,
  DeployFact,
  ConfigFact,
  FlowFact,
]);
export type Fact = z.infer<typeof Fact>;
export type FactOf<K extends FactKind> = Extract<Fact, { kind: K }>;

/** A whole facts file, as an array (the JSONL form is one `Fact` per line). */
export const FactsFile = z.array(Fact);
