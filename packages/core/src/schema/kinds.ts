import { z } from "zod";
import { commonFields, IsoDate, IsoDateTime, Ref } from "./common.js";

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
  tags: list(str()),
  /** Who may see this system. "everyone" systems are the only ones on the catalog site. */
  accessGroup: z.string().default("everyone"),
});

export const Component = record("Component", {
  system: Ref,
  repo: z.string().optional(),
  path: z.string().optional(),
  type: str(),
  /** Where it runs today, e.g. kubernetes, openshift, cloud-run, vm. */
  runtime: z.string().optional(),
  migration: z.enum(["not-started", "in-progress", "done", "not-applicable"]).optional(),
});

export const Auth = z.enum(["none", "oauth2", "mtls", "api-key", "basic", "other"]);

export const Endpoint = record("Endpoint", {
  component: Ref,
  endpointType: z.enum([
    "rest",
    "grpc",
    "soap",
    "event-topic",
    "file-drop",
    "mq-queue",
    "batch-job",
  ]),
  method: z.string().optional(),
  pathOrTopic: str(),
  normalizedPath: z.string().optional(),
  schemaRefs: list(Ref),
  auth: Auth.optional(),
});

export const Interface = record("Interface", {
  from: Ref,
  to: Ref,
  endpoint: Ref.optional(),
  via: z.enum(["gateway", "direct", "event-bus", "pubsub", "sftp", "mq", "other"]),
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

export const DataStore = record("DataStore", {
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
  ]),
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
  Unresolved,
  CuratedDecision,
} as const;

export type RecordKind = keyof typeof RECORD_SCHEMAS;
export const RECORD_KINDS = Object.keys(RECORD_SCHEMAS) as RecordKind[];
