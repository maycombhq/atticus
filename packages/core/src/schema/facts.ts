import { z } from "zod";
import { Auth, FLOW_STEP_KINDS } from "./kinds.js";

/**
 * The facts file: what the assistant writes when it reads a repo (ADR 0124). One JSON line
 * per fact, in seven kinds plus flows, every one with a citation. It is the assistant's input
 * format, projected into catalog C1 by `projectFacts`; it is not a catalog contract of its own.
 *
 * A fact without a citation is not a fact; it is a question.
 */

const str = () => z.string().min(1);

export const FACT_KINDS = [
  "entry",
  "call",
  "store",
  "field",
  "deploy",
  "config",
  "framework",
  "flow",
] as const;
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
   * The other lines a claim is put together from (ADR 0124 addendum A4): every plain part of a
   * path must be written on the cited line or one of these, each part on its own line. A
   * framework fact's version, where the declaring line doesn't write it, is such a part too
   * (addendum A-framework).
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

/**
 * What identifies a consumer a gateway route names (ADR 0124 addendum A-callers): a developer
 * `app` subscribed to the route's API product or admitted by a condition, the API `product` the
 * route belongs to, a `client-id` a condition or an allowlist admits, or a certificate `subject`
 * an mTLS check admits.
 */
export const CALLER_KINDS = ["app", "product", "client-id", "subject"] as const;
export type CallerKind = (typeof CALLER_KINDS)[number];

/** A consumer a route names: the identity as written (`value`), cited on the line that names it. */
export const CallerCite = Cite.extend({ as: z.enum(CALLER_KINDS) });
export type CallerCite = z.infer<typeof CallerCite>;

export const EntryFact = z.strictObject({
  kind: z.literal("entry"),
  ...common,
  entryType: z.enum(ENTRY_TYPES),
  method: z.string().optional(),
  /** The path, topic, queue, schedule, screen route or transaction id. */
  path: str(),
  handler: z.string().optional(),
  auth: Auth.optional(),
  /**
   * The line that sets `auth` (an annotation, a middleware, a policy, a security setting) and
   * what it writes there (ADR 0124 addendum A-read). The verifier checks it as it checks a part;
   * an `auth` without it is left out of the kept fact, so the catalog never says it.
   */
  authCite: CitePart.optional(),
  /**
   * The scopes a caller's token must hold to be let in (ADR 0124 addendum A-gateway2): an
   * Apigee `OAuthV2`'s `<Scope>`, a `VerifyJWT` or `VerifyAccessToken` scope claim check, a
   * scope a `Condition` asserts on the token's claims, or one a shared flow checks; and, for a
   * service's own entry, the scope its annotation or middleware requires, though only a gateway
   * batch's rules ask for scopes (the prompt budget: see the addendum).
   *
   * One citation per scope: `value` is the scope as written, on the line that names it, with
   * the other lines a scope built from parts comes from in `with`, as for any other claim. The
   * verifier checks each like a part, so an invented scope, or one cited on a line that doesn't
   * name it, rejects the entry. A field on the entry, not a fact kind of its own: a scope has no
   * identity apart from the entry that demands it (see the addendum for why).
   */
  scopes: z.array(Cite).max(12).optional(),
  /**
   * The consumers the route lets in, as its own files name them (ADR 0124 addendum A-callers):
   * the API product it belongs to, the developer apps subscribed to that product, a client id or
   * app name a `Condition` or allowlist admits, a certificate subject an mTLS check admits. One
   * citation per consumer, `value` the identity as written, on the line that names it, with the
   * line that ties it to the route (the product's proxy list, the app's product list) in `with`.
   * The verifier checks each like a scope, so an invented consumer rejects the entry. Additive
   * and optional, as `scopes` is; only a gateway batch's rules ask for it.
   */
  callers: z.array(CallerCite).max(24).optional(),
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
  /**
   * A column's: not null. A request, response or message field's: it must be present, kept on
   * the Schema field (ADR 0125). Left out when the code doesn't say.
   */
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
/** A flag or a mode (`withCredentials: true`, `credentials: "include"`) is not a secret. */
const NOT_A_SECRET = /^(true|false|yes|no|on|off|include|omit|same-origin|none|null|\d+)$/i;

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
    /** The environment the value is for (`prod`, `Local`), when the file is one environment's (A4). */
    env: z.string().optional(),
  })
  .superRefine((c, ctx) => {
    const last =
      c.key
        .trim()
        .split(/[.:]|__|\s+/)
        .pop() ?? c.key;
    if (
      c.value !== undefined &&
      SECRET_KEY.test(last) &&
      !SECRET_SOURCE.test(c.value) &&
      !NOT_A_SECRET.test(c.value.trim())
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message: `"${c.key}" looks like a secret: give its source (env:NAME, vault:path), never its value`,
      });
    }
  });

/**
 * What a repo or one of its modules is built on (ADR 0124 addendum A-framework): a framework the
 * build file declares, cited on the line that declares it. A kind of its own, not a field on
 * another kind: its subject is the repo or the module (`repo` and `component`, which `common`
 * already carries), no other fact owns it, and it is read first and on its own — the rules a
 * batch's prompt carries are chosen from it before any entry is read. See the addendum for the
 * decision.
 *
 * Nothing is projected into catalog C1 from it: there is no field there to hold it, and a C1
 * field would be a schema bump with a migration. The views read the facts (`map.md`, the Map's
 * repo page, the Trust tab) as the gateway join's hops do.
 */
export const FrameworkFact = z.strictObject({
  kind: z.literal("framework"),
  ...common,
  /**
   * The framework's name as Atticus knows it (`spring-boot`, `asp.net`, `express`, `angular`,
   * `react`, `quarkus`, `django`, `rails`), or, for a house starter or platform library Atticus
   * doesn't know, the artifact or package as the build file declares it. The verifier checks the
   * name against the declaration on the cited line, so a name no declaration gives is rejected.
   */
  name: str(),
  /**
   * The version as declared, when the build file says. Left out when it doesn't (a BOM, a parent
   * pom or a lock file manages it and no line here names a version).
   *
   * Where the version is not written on the cited line — a `<properties>` entry, a parent pom's
   * `<version>`, a `<TargetFramework>`, a dependency-management block — that line goes in
   * `cite.with`, as any other part of a claim built across lines does (ADR 0124 addendum A4),
   * and the verifier checks it there. No field of its own: the version is part of this claim,
   * not a claim about something else, and `cite.with` is already the place a claim's other
   * lines go.
   */
  version: z.string().optional(),
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
  FrameworkFact,
  FlowFact,
]);
export type Fact = z.infer<typeof Fact>;
export type FactOf<K extends FactKind> = Extract<Fact, { kind: K }>;

/** A whole facts file, as an array (the JSONL form is one `Fact` per line). */
export const FactsFile = z.array(Fact);
