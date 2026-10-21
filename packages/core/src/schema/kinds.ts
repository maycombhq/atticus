import { z } from "zod";
import {
  commonFields,
  Confidence,
  Evidence,
  IsoDate,
  IsoDateTime,
  RecordId,
  Ref,
  Status,
} from "./common.js";

/**
 * Contract C1: catalog record kinds. One authoritative list.
 *
 * Naming note: every record already has a top-level `kind` (its record type), so a record's
 * own sub-type uses a specific name (endpointType, tableKind, settingKind, ...). See ADR 0005.
 */

const str = () => z.string().min(1);
const list = <T extends z.ZodType>(item: T) => z.array(item).default([]);

const record = <K extends string, S extends z.ZodRawShape>(kind: K, shape: S) =>
  z.strictObject({ kind: z.literal(kind), ...commonFields, ...shape });

// ---------- structure ----------

export const System = record("System", {
  name: str(),
  boundary: z.enum(["product", "internal", "vendor"]),
  owner: z.string().optional(),
  repos: list(str()),
  /** Free labels. By convention (ADR 0040) `saas` marks a SaaS product used as a system, with boundary `vendor`. */
  tags: list(str()),
  /** Who may see this system. "everyone" systems are the only ones on the catalog site. */
  accessGroup: z.string().default("everyone"),
});

/**
 * Documented `Component.type` values (ADR 0040). The field stays free text so an ecosystem can
 * name a shape this list doesn't have; tools treat these values as known.
 */
export const COMPONENT_TYPES = [
  "service",
  "spa",
  "bff",
  "mobile-app",
  "desktop-app",
  "function",
  "batch-job",
  "data-pipeline",
  "ml-model",
  "gateway",
  "worker",
  "library",
  "mainframe-program",
] as const;

export const Component = record("Component", {
  system: Ref,
  repo: z.string().optional(),
  path: z.string().optional(),
  /** What the component is. Free text; the documented values are COMPONENT_TYPES (ADR 0040). */
  type: str(),
  /** Where it runs today, e.g. kubernetes, openshift, cloud-run, vm. */
  runtime: z.string().optional(),
  migration: z.enum(["not-started", "in-progress", "done", "not-applicable"]).optional(),
  /**
   * Components it builds on (ADR 0068): the modules of the same repo its build file depends on
   * (a pom's dependencies, a package.json's packages). Left out when there are none.
   */
  uses: z.array(Ref).optional(),
});

export const Auth = z.enum(["none", "oauth2", "mtls", "api-key", "basic", "other"]);

export const Endpoint = record("Endpoint", {
  component: Ref,
  /**
   * What kind of entry point this is. ADR 0040 added graphql (method QUERY, MUTATION or
   * SUBSCRIPTION; pathOrTopic the field, e.g. Query.account), websocket and sse (pathOrTopic the
   * path), webhook (receives callbacks from another system), function (a serverless or scheduled
   * function's trigger) and transaction (an online transaction in a transaction monitor;
   * pathOrTopic the transaction id).
   */
  endpointType: z.enum([
    "rest",
    "grpc",
    "soap",
    "event-topic",
    "file-drop",
    "mq-queue",
    "batch-job",
    "graphql",
    "websocket",
    "sse",
    "webhook",
    "function",
    "transaction",
  ]),
  /** HTTP method (rest, webhook), QUERY, MUTATION or SUBSCRIPTION (graphql), the RPC method (grpc). */
  method: z.string().optional(),
  /** The path, topic, queue, field (graphql), Service/Method (grpc), trigger (function) or transaction id. */
  pathOrTopic: str(),
  normalizedPath: z.string().optional(),
  schemaRefs: list(Ref),
  auth: Auth.optional(),
});

export const Interface = record("Interface", {
  from: Ref,
  to: Ref,
  endpoint: Ref.optional(),
  /** How the call travels. ADR 0040 added mesh (through a service mesh sidecar) and webhook (a callback registered with another system). */
  via: z.enum([
    "gateway",
    "direct",
    "event-bus",
    "pubsub",
    "sftp",
    "mq",
    "other",
    "mesh",
    "webhook",
  ]),
  /** GatewayRoute id when the call goes through a gateway. */
  route: Ref.optional(),
  method: z.string().optional(),
  normalizedPath: z.string(),
  auth: Auth.optional(),
  sync: z.enum(["sync", "async"]),
  direction: z.enum(["outbound", "inbound", "bidirectional"]).default("outbound"),
  pattern: z
    .strictObject({
      code: str(),
      source: z.enum(["drawn", "inferred", "asserted"]),
    })
    .optional(),
  conflicts: list(
    z.strictObject({
      field: str(),
      values: z.array(z.string()).min(2),
      note: z.string().optional(),
    }),
  ),
});

export const GatewayRoute = record("GatewayRoute", {
  proxy: str(),
  basepath: str(),
  target: z.string().optional(),
  policies: list(str()),
  scopes: list(str()),
  env: z.string().optional(),
  product: z.string().optional(),
  specPath: z.string().optional(),
});

export const Classification = z.string().min(1);

export const Schema = record("Schema", {
  format: z.enum(["openapi", "json-schema", "avro", "xsd", "other"]),
  ref: str(),
  version: z.string().optional(),
  fields: list(
    z.strictObject({
      name: str(),
      type: z.string().optional(),
      classification: Classification.optional(),
    }),
  ),
});

export const FieldMapping = record("FieldMapping", {
  interface: Ref,
  sourceField: str(),
  targetField: str(),
  transform: z.string().optional(),
});

// ---------- data ----------

/**
 * Documented `DataStore.storeType` values (ADR 0040). Free text stays allowed (older catalogs use
 * engine names); tools treat these values as known.
 */
export const STORE_TYPES = [
  "relational",
  "document",
  "key-value",
  "cache",
  "warehouse",
  "lake",
  "object-storage",
  "search",
  "feature-store",
  "queue",
  "stream",
  "file-share",
] as const;

export const DataStore = record("DataStore", {
  /** What kind of store. Free text; the documented values are STORE_TYPES (ADR 0040). */
  storeType: str(),
  ownerComponent: Ref.optional(),
  entitiesHeld: list(str()),
});

export const Table = record("Table", {
  dataStore: Ref,
  name: str(),
  tableKind: z.enum(["table", "view", "collection", "key-pattern"]),
  ownerComponent: Ref.optional(),
  readers: list(Ref),
  writers: list(Ref),
  retention: z.string().optional(),
});

export const Column = record("Column", {
  table: Ref,
  name: str(),
  type: str(),
  nullable: z.boolean().optional(),
  default: z.string().optional(),
  classification: Classification.optional(),
  glossaryTerm: Ref.optional(),
});

export const IndexConstraint = record("IndexConstraint", {
  table: Ref,
  constraintKind: z.enum(["primary-key", "foreign-key", "unique", "index"]),
  columns: z.array(str()).min(1),
  references: z
    .strictObject({
      table: Ref,
      columns: z.array(str()).min(1),
    })
    .optional(),
});

export const Migration = record("Migration", {
  dataStore: Ref,
  version: str(),
  tool: z.enum(["flyway", "liquibase", "alembic", "prisma", "other"]),
  file: str(),
  operations: list(str()),
  reversible: z.boolean().optional(),
});

// ---------- runtime and operations ----------

export const Deployment = record("Deployment", {
  component: Ref,
  env: str(),
  platform: str(),
  replicas: z.number().int().nonnegative().optional(),
  resources: z
    .strictObject({ cpu: z.string().optional(), memory: z.string().optional() })
    .optional(),
  autoscaling: z
    .strictObject({ min: z.number().int().nonnegative(), max: z.number().int().positive() })
    .optional(),
  networkPolicies: list(str()),
  backupAndFailover: z.string().optional(),
  /**
   * Public or internal routes to the deployment (ADR 0040): an ingress, a gateway-API route or a
   * platform route. Replaces the older `route.<name>` Setting convention, which stays readable.
   */
  ingress: z
    .array(
      z.strictObject({
        host: str(),
        path: z.string().optional(),
        /** True when the route terminates TLS. */
        tls: z.boolean().optional(),
      }),
    )
    .optional(),
});

export const Setting = record("Setting", {
  component: Ref,
  env: z.string().optional(),
  settingKind: z.enum([
    "timeout",
    "retry",
    "circuit-breaker",
    "rate-limit",
    "pool",
    "cache-ttl",
    "feature-flag",
    "config",
    "schedule",
  ]),
  /** The setting's name. A schedule keeps the `schedule.<job>` key (ADR 0024) with settingKind schedule (ADR 0040). */
  key: str(),
  /** The value, or a reference to where a secret value lives. Never a secret itself. */
  valueOrRef: z.string(),
  target: Ref.optional(),
});

export const ObservabilityAsset = record("ObservabilityAsset", {
  component: Ref,
  assetKind: z.enum(["log-config", "metric", "trace", "alert", "dashboard", "runbook"]),
  name: str(),
  link: z.string().optional(),
});

export const AccessGrant = record("AccessGrant", {
  subjectKind: z.enum(["service-account", "oauth-client", "role", "group"]),
  subject: str(),
  resource: str(),
  scopesOrPermissions: list(str()),
  env: z.string().optional(),
});

export const QualityAsset = record("QualityAsset", {
  component: Ref,
  assetKind: z.enum([
    "test-suite",
    "coverage-report",
    "pipeline",
    "dependency",
    "vulnerability",
    "licence-finding",
  ]),
  details: z.record(z.string(), z.unknown()).default({}),
});

export const Obligation = record("Obligation", {
  system: Ref,
  obligationKind: z.enum([
    "slo",
    "volume",
    "rpo",
    "rto",
    "retention",
    "freeze-window",
    "support-group",
  ]),
  value: str(),
  assertedBy: str(),
});

// ---------- knowledge and coordination ----------

export const GlossaryTerm = record("GlossaryTerm", {
  term: str(),
  definition: str(),
  fields: list(str()),
  owner: z.string().optional(),
});

export const Pattern = record("Pattern", {
  code: str(),
  name: str(),
  definition: str(),
  interaction: z.enum(["sync", "async", "data-access"]),
  route: z.string().optional(),
  targetType: z.string().optional(),
  controls: list(str()),
  resilience: z.string().optional(),
  technology: list(str()),
  detection: list(str()),
  checklistItems: list(str()),
  sourcePage: z.string().optional(),
  version: z.string().optional(),
  patternStatus: z.enum(["confirmed", "to-review", "deprecated"]),
});

export const Decision = record("Decision", {
  title: str(),
  decision: str(),
  reason: str(),
  links: z
    .strictObject({
      changes: list(str()),
      interfaces: list(Ref),
      systems: list(Ref),
    })
    .default({ changes: [], interfaces: [], systems: [] }),
  decidedBy: str(),
  date: IsoDate,
});

export const SourceDocument = record("SourceDocument", {
  path: str(),
  docType: str(),
  version: z.string().optional(),
  author: z.string().optional(),
  date: IsoDate.optional(),
  hash: z.string().regex(/^[0-9a-f]{64}$/, "sha-256 hex"),
  supersededBy: Ref.optional(),
  recordsProduced: list(Ref),
});

export const Party = record("Party", {
  name: str(),
  partyKind: z.enum(["internal-team", "vendor"]),
  owner: z.string().optional(),
  contacts: list(str()),
  channel: z.string().optional(),
  systems: list(Ref),
  /** Typical lead time per request type, e.g. { "firewall-rule": "10d" }. */
  typicalLeadTimes: z.record(z.string(), z.string()).default({}),
});

export const Initiative = record("Initiative", {
  title: str(),
  journey: z.enum([
    "new-feature",
    "new-integration",
    "vendor-api-change",
    "design-change",
    "migration",
    "retire-system",
  ]),
  changes: list(str()),
  parties: list(Ref),
  commitments: list(Ref),
  targetRelease: z.string().optional(),
  adoEpic: z.string().optional(),
});

export const Commitment = record("Commitment", {
  initiative: Ref,
  party: Ref,
  what: str(),
  owner: str(),
  neededBy: IsoDate,
  blocks: list(str()),
  commitmentStatus: z.enum(["open", "at-risk", "done", "slipped"]),
});

export const OwnerQuestion = record("OwnerQuestion", {
  system: Ref,
  owner: str(),
  question: str(),
  neededFact: str(),
  channel: z.enum(["ado", "teams", "email"]),
  questionState: z.enum(["sent", "answered", "overdue"]),
  answer: z.string().optional(),
});

export const ProcessArtifact = record("ProcessArtifact", {
  artifactType: z.enum(["snow-ticket", "ado-item", "change"]),
  ref: str(),
  processStatus: z.string().optional(),
  linkedRecords: list(Ref),
});

/** A work item, wiki page or spec a feature is linked to (outside the catalog). */
export const ExternalRef = z.strictObject({
  system: z.enum(["ado", "jira", "wiki", "openspec", "other"]),
  id: str(),
  url: z.string().optional(),
  title: z.string().optional(),
});

/**
 * A feature (ADR 0031): what a set of entry points and the records their flows span add up
 * to. Detected from code on every scan (`namedBy: detected`, confidence `inferred`), named by
 * an AI proposal (`ai`, still `inferred`) or confirmed by a person (`person`, `asserted`
 * through a curated decision). Ids are `feature.<slug>` of the primary resource.
 */
export const Capability = record("Capability", {
  name: str(),
  description: z.string().optional(),
  /** Where the feature starts: UI routes, public or gateway endpoints, jobs, event consumers. */
  entryPoints: list(Ref),
  /** Everything its flows reach: components, endpoints, interfaces, topics, tables. */
  records: list(Ref),
  owner: z.string().optional(),
  tags: list(str()),
  externalRefs: list(ExternalRef),
  namedBy: z.enum(["detected", "ai", "person"]),
});

// ---------- behaviour: flows (ADR 0079) ----------

/**
 * The Flow kind's own schema version (ADR 0079). Flows are drafted, not scanned, and live in
 * the metarepo's specs/<repo>/ folder, so their version moves on its own, not with the
 * catalog's SCHEMA_VERSION.
 */
export const FLOW_SCHEMA_VERSION = 1 as const;

/** What starts a flow: an entry point, a button or form, a page load, a listener, a job. */
export const FLOW_TRIGGER_KINDS = ["endpoint", "action", "page", "listener", "job"] as const;

/**
 * What a step does. lookup is a read to decide something; log is a log line or an audit
 * entry; loop and retry wrap the steps after them.
 */
export const FLOW_STEP_KINDS = [
  "entry",
  "lookup",
  "read",
  "write",
  "call-out",
  "publish",
  "transform",
  "validate",
  "branch",
  "log",
  "respond",
  "loop",
  "retry",
] as const;

/**
 * Who confirmed a step (plan principle 2): `check` when the citation check found what the
 * step names (an endpoint path, a table, a topic, a field) on the cited line; `ai` when the
 * AI's verification pass did; `person` when a person's review did. Left out until one has.
 */
export const ConfirmedBy = z.enum(["check", "ai", "person"]);

/** Step kinds the citation check can never confirm: it can only show their lines exist. */
export const NEVER_CHECKED_STEPS = ["transform", "branch", "validate"] as const;

/** Field names as the code names them. */
const fields = () => z.array(str()).optional();

export const FlowData = z.strictObject({
  /** Fields a call-out or publish sends. */
  sends: fields(),
  /** Fields a step returns or a response carries. */
  returns: fields(),
  /** Fields a step looks at. */
  reads: fields(),
  /** The rules a validation applies. */
  checks: fields(),
  /** A transform's source fields, in the same order as `to`. */
  from: fields(),
  /** A transform's target fields. */
  to: fields(),
});

export const FlowTrigger = z.strictObject({
  kind: z.enum(FLOW_TRIGGER_KINDS),
  /** The catalog record the trigger is, when it is one (an Endpoint for an endpoint or listener). */
  ref: Ref.optional(),
  /** What happens, in plain words. */
  what: str(),
  evidence: z.array(Evidence).min(1, "a trigger cites where it is"),
});

export const FlowStep = z.strictObject({
  kind: z.enum(FLOW_STEP_KINDS),
  /** One plain sentence. */
  what: str(),
  /** Catalog records the step touches: Endpoint, Interface, Table, Column, a topic's Endpoint. */
  refs: list(Ref),
  /** Where a call-out or publish goes: the component and its entry point (an Endpoint id, or "METHOD /path", or a topic). */
  to: z.strictObject({ component: Ref, entry: str() }).optional(),
  data: FlowData.optional(),
  /** The table (a Table id) and columns a read, lookup or write touches, as the database names them. */
  store: z.strictObject({ table: Ref, columns: list(str()) }).optional(),
  evidence: z.array(Evidence).min(1, "every step cites the code it is read from"),
  confirmedBy: ConfirmedBy.optional(),
});

export const FlowError = z.strictObject({
  when: str(),
  then: str(),
  evidence: z.array(Evidence).min(1, "an error path cites the code it is read from"),
  confirmedBy: ConfirmedBy.optional(),
});

/**
 * A flow (ADR 0079): what happens, in order, when something enters a repo, with the data at
 * each step and a citation on every step. One file per flow at specs/<repo>/<id>.yaml in the
 * metarepo. The id is `<component>.<flow>`.
 */
export const Flow = z.strictObject({
  kind: z.literal("Flow"),
  schemaVersion: z.literal(FLOW_SCHEMA_VERSION, {
    error: `a Flow's schemaVersion is ${FLOW_SCHEMA_VERSION} (ADR 0079)`,
  }),
  id: RecordId,
  status: Status.default("current"),
  confidence: Confidence.default("inferred"),
  /** Citations for the flow as a whole beyond its trigger and steps; usually none. */
  evidence: z.array(Evidence).default([]),
  flags: z.array(z.string()).optional(),
  /** The component the flow starts in. */
  component: Ref,
  /** What a person would call it, in plain words. */
  name: str(),
  trigger: FlowTrigger,
  steps: z.array(FlowStep).min(1, "a flow has at least one step"),
  errors: list(FlowError),
  /** The other triggers this flow stands for (a family of near-identical ones), by catalog id. */
  family: list(Ref),
  /** The spec template it was written against: <repo type id>@<version>. */
  template: z.string().regex(/^[a-z0-9][a-z0-9._-]*@\d+$/, "template is <repo type id>@<version>"),
});

// ---------- housekeeping ----------

export const Unresolved = record("Unresolved", {
  unresolvedKind: str(),
  raw: str(),
  owner: z.string().optional(),
});

/** A human decision applied over generated records. Lives in catalog/curated/. */
export const CuratedDecision = z.strictObject({
  kind: z.literal("CuratedDecision"),
  schemaVersion: commonFields.schemaVersion,
  id: commonFields.id,
  status: commonFields.status,
  confidence: z.literal("asserted"),
  evidence: z.array(commonFields.evidence.element).default([]),
  flags: commonFields.flags,
  target: Ref,
  action: z.enum(["alias", "assert", "suppress", "resolve-conflict", "classify"]),
  value: z.unknown(),
  reason: str(),
  by: str(),
  at: IsoDateTime,
  pr: z.string().optional(),
});

export const RECORD_SCHEMAS = {
  System,
  Component,
  Endpoint,
  Interface,
  GatewayRoute,
  Schema,
  FieldMapping,
  DataStore,
  Table,
  Column,
  IndexConstraint,
  Migration,
  Deployment,
  Setting,
  ObservabilityAsset,
  AccessGrant,
  QualityAsset,
  Obligation,
  GlossaryTerm,
  Pattern,
  Decision,
  SourceDocument,
  Party,
  Initiative,
  Commitment,
  OwnerQuestion,
  ProcessArtifact,
  Capability,
  Flow,
  Unresolved,
  CuratedDecision,
} as const;

export type RecordKind = keyof typeof RECORD_SCHEMAS;
export const RECORD_KINDS = Object.keys(RECORD_SCHEMAS) as RecordKind[];
