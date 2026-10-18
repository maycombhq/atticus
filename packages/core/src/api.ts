import { z } from "zod";
import { RunState, RunSummary, RuntimeKind } from "./schema/ai.js";
import { RecordId } from "./schema/common.js";
import { RECORD_KINDS, RECORD_SCHEMAS, type RecordKind } from "./schema/kinds.js";
import { ChangeArtifact, Phase } from "./schema/orgpack.js";
import { Finding, FindingAction, Lens, Severity } from "./schema/review.js";
import { ChangeRepos, ManifestRepo } from "./schema/workspace.js";

/**
 * Contract C4, local API. The UI only calls this API and the API only reads and writes
 * files, so anything the UI does can also be done from the CLI or by an assistant.
 *
 * The server listens on 127.0.0.1 only (default port 4321) and every request carries the
 * per-session token Atticus prints at start-up, so other local programs and web pages
 * can't drive it. See ADR 0015.
 */
export const API_VERSION = "1.0.0";
export const DEFAULT_PORT = 4321;

// ------------------------------------------------------------------ shared response shapes

/** RFC 9457 problem details, used for every error. */
export const Problem = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  /** Field-level problems for 400s. */
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  /** For 403s on gated actions: who can act, e.g. "Needs an architect: R. Patel". */
  needs: z.object({ role: z.string(), names: z.array(z.string()) }).optional(),
});

const Kind = z.enum(RECORD_KINDS as [RecordKind, ...RecordKind[]]);

export const CatalogRecord = z.union(
  RECORD_KINDS.map((k) => RECORD_SCHEMAS[k]) as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]],
);

export const RecordPage = z.object({
  items: z.array(CatalogRecord),
  total: z.number().int(),
  /** Pass back to get the next page; absent on the last page. */
  next: z.string().optional(),
});

export const KindCount = z.object({ kind: Kind, count: z.number().int(), stale: z.number().int() });

export const GraphNode = z.object({
  id: RecordId,
  kind: Kind,
  label: z.string(),
  status: z.string(),
  system: z.string().optional(),
});
export const GraphEdge = z.object({
  id: RecordId,
  from: RecordId,
  to: RecordId,
  via: z.string(),
  pattern: z.string().optional(),
  confidence: z.enum(["verified", "inferred", "asserted"]),
  status: z.string(),
});
export const Graph = z.object({ nodes: z.array(GraphNode), edges: z.array(GraphEdge) });

export const Impact = z.object({
  root: RecordId,
  affected: z.array(
    z.object({
      id: RecordId,
      kind: Kind,
      /** Hops from the root to this record. */
      path: z.array(RecordId),
      reason: z.string(),
      owner: z.string().optional(),
    }),
  ),
  /** Facts that would sharpen the answer but are missing: knowledge gaps. */
  gaps: z.array(z.object({ record: RecordId, field: z.string(), question: z.string() })),
});

export const Coverage = z.object({
  areas: z.array(
    z.object({ area: z.string(), known: z.number().int(), expected: z.number().int() }),
  ),
  systems: z.array(
    z.object({
      system: RecordId,
      known: z.number().int(),
      expected: z.number().int(),
      gaps: z.number().int(),
    }),
  ),
});

export const JobState = z.enum(["queued", "running", "done", "failed", "cancelled"]);
export const Job = z.object({
  id: z.string(),
  kind: z.enum(["scan", "sync", "reconcile", "index", "intake"]),
  state: JobState,
  progress: z.object({ done: z.number().int(), total: z.number().int(), message: z.string() }),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  errors: z.array(z.string()),
  /** Kind-specific outcome, e.g. scan diff counts. */
  result: z.record(z.string(), z.unknown()).optional(),
});
export const JobAccepted = z.object({ jobId: z.string() });

export const ArtifactStatus = z.object({
  artifact: ChangeArtifact,
  path: z.string(),
  status: z.enum(["blocked", "ready", "done", "not-required"]),
  owner: z.string().optional(),
  openFindings: z.number().int(),
});

export const ChangeState = z.enum([
  "draft",
  "define",
  "design",
  "plan",
  "build",
  "qa",
  "release-ready",
  "released",
  "archived",
  "returned",
  "post-release-review",
]);

export const ChangeSummary = z.object({
  id: RecordId,
  title: z.string(),
  type: RecordId,
  state: ChangeState,
  phaseOwner: z.string().optional(),
  repos: z.array(RecordId),
  openFindings: z.object({
    blocking: z.number().int(),
    gap: z.number().int(),
    risk: z.number().int(),
    idea: z.number().int(),
  }),
  updatedAt: z.string(),
});

export const ChangeDetail = ChangeSummary.extend({
  artifacts: z.array(ArtifactStatus),
  repos: z.array(RecordId),
  workspace: ChangeRepos.optional(),
  handoff: z
    .object({
      phase: Phase,
      pr: z.string().optional(),
      state: z.enum(["none", "open", "merged", "closed"]),
    })
    .optional(),
});

export const ArtifactContent = z.object({
  artifact: ChangeArtifact,
  path: z.string(),
  content: z.string(),
  /** sha256 of the content; send it back on save to detect concurrent edits. */
  sha256: z.string(),
});

export const Task = z.object({
  id: z.string(),
  repo: RecordId,
  description: z.string(),
  done: z.boolean(),
  story: z.string().optional(),
  branch: z.string().optional(),
  run: z.string().optional(),
});

export const RunView = RunSummary.extend({
  /** For hand-off runs: the prompt file and the editor workspace to open. */
  promptPath: z.string().optional(),
  workspaceFile: z.string().optional(),
});

export const RepoView = ManifestRepo.extend({
  platform: RecordId,
  baseClone: z.object({
    present: z.boolean(),
    sha: z.string().optional(),
    dirty: z.boolean().optional(),
  }),
});

export const OrgPackView = z.object({
  defaulted: z.array(z.string()),
  counts: z.record(z.string(), z.number().int()),
  problems: z.array(z.object({ file: z.string(), path: z.string(), message: z.string() })),
});

export const Health = z.object({
  version: z.string(),
  apiVersion: z.string(),
  schemaVersion: z.number().int(),
  root: z.string(),
  openspec: z.string().optional(),
  user: z.string(),
});

// ------------------------------------------------------------------ request bodies

export const ScanRequest = z.strictObject({
  repos: z.array(RecordId).optional(),
  /** Ignore the cache and rescan everything. */
  full: z.boolean().default(false),
});

export const NewChangeRequest = z.strictObject({
  id: RecordId,
  title: z.string().min(1),
  type: RecordId,
  /** A work-tracker item the change starts from. */
  from: z.string().optional(),
  /** ADR 0043: role → people, the systems it touches and a change template. */
  owners: z.record(z.string(), z.array(z.string()).min(1)).optional(),
  systems: z.array(z.string()).optional(),
  template: z.string().optional(),
});

export const SaveArtifactRequest = z.strictObject({
  content: z.string(),
  /** The sha256 the edit started from; a mismatch returns 409. */
  baseSha256: z.string(),
});

export const StartRunRequest = z.strictObject({
  agent: RecordId,
  runtime: RuntimeKind.default("hand-off"),
  /** For task runs: the task id and the autonomy level wanted (capped by runtime.yaml). */
  task: z.string().optional(),
  autonomy: z.enum(["plan-only", "draft", "draft-and-pr"]).optional(),
});

export const FindingActionRequest = z.strictObject({
  action: FindingAction,
  reason: z.string().min(1).optional(),
  askedOf: z.string().min(1).optional(),
  /** For edit-and-apply: the edited fix. */
  patch: z.string().optional(),
  /** ADR 0043: the gate the finding belongs to, when the id alone is ambiguous. */
  gate: z.string().optional(),
});

export const OpenWorkspaceRequest = z.strictObject({ repos: z.array(RecordId).min(1) });

/** ADR 0043: the phase defaults to the change's current one; repo names the metarepo when runtime.yaml doesn't. */
export const HandoffRequest = z.strictObject({
  phase: Phase.optional(),
  repo: z.string().optional(),
});

/** ADR 0043: refresh a change from its hand-off PR. */
export const SyncRequest = z.strictObject({ repo: z.string().optional() });

/** ADR 0043, Release and Run screens: request bodies the CLI's uiRunRoutes parse. */
export const StepDoneRequest = z
  .strictObject({
    values: z.record(z.string(), z.string()).default({}),
    skip: z.boolean().optional(),
    note: z.string().trim().min(1).optional(),
    change: z.string().optional(),
  })
  .refine((x) => !x.skip || x.note, { message: "Say why you skip it.", path: ["note"] });
export const StepRunRequest = z.strictObject({
  with: z.string().min(1),
  inputsSha256: z.string().regex(/^[0-9a-f]{64}$/, "the sha-256 the preview showed"),
  fillOnly: z.boolean().optional(),
  change: z.string().optional(),
});
export const ArchiveRequest = z.strictObject({ rescan: z.boolean().optional() });
export const DraftRequestsRequest = z.strictObject({ force: z.boolean().optional() });
/** Live mode is part of the shape so the server can refuse it in words: it calls a real model. */
export const EvalRunRequest = z.strictObject({
  mode: z.enum(["mock", "replay", "live"]).default("mock"),
  agents: z.array(z.string().min(1)).optional(),
  runs: z.number().int().min(1).max(10).optional(),
});
export const StartLessonRequest = z.strictObject({ lesson: z.string().min(1) });
export const CheckLessonRequest = z.strictObject({
  answer: z.string().optional(),
  lesson: z.string().optional(),
  step: z.string().optional(),
});
export const SandboxRequest = z.strictObject({ dir: z.string().trim().min(1) });

export const ReconcileRequest = z.strictObject({ diagram: z.string().min(1) });

// ------------------------------------------------------------------ live events

/** Messages on the WebSocket at /api/events. */
export const LiveEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("file.changed"), path: z.string() }),
  z.object({
    type: z.literal("job.progress"),
    jobId: z.string(),
    done: z.number().int(),
    total: z.number().int(),
    message: z.string(),
  }),
  z.object({ type: z.literal("job.done"), jobId: z.string(), state: JobState }),
  z.object({ type: z.literal("index.rebuilt"), records: z.number().int() }),
  z.object({ type: z.literal("run.changed"), runId: z.string(), state: RunState }),
]);

// ------------------------------------------------------------------ the document

type Op = {
  id: string;
  summary: string;
  tag: string;
  params?: {
    name: string;
    in: "path" | "query";
    schema: object;
    required?: boolean;
    description?: string;
  }[];
  body?: z.ZodType;
  ok: { status: 200 | 201 | 202 | 204; schema?: string | object; description: string };
  errors?: number[];
};

const str = { type: "string" };
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const arrayOf = (name: string) => ({ type: "array", items: ref(name) });
const p = (name: string, extra: Partial<NonNullable<Op["params"]>[number]> = {}) => ({
  name,
  in: "path" as const,
  schema: str,
  required: true,
  ...extra,
});
const q = (name: string, schema: object = str, description?: string) => ({
  name,
  in: "query" as const,
  schema,
  ...(description ? { description } : {}),
});

/** What a read-only view returns: the command's exit code, its JSON and anything it printed to stderr. */
const VIEW_RESULT = {
  type: "object",
  required: ["code", "data", "problems"],
  properties: { code: { type: "integer" }, data: {}, problems: { type: "array", items: str } },
};

const OPS: Record<string, Record<string, Op>> = {
  "/api/health": {
    get: {
      id: "getHealth",
      summary: "Versions, the metarepo root and who is signed in",
      tag: "system",
      ok: { status: 200, schema: "Health", description: "OK" },
    },
  },
  "/api/catalog/kinds": {
    get: {
      id: "listKinds",
      summary: "Record counts per kind, with stale counts",
      tag: "catalog",
      ok: { status: 200, schema: arrayOf("KindCount"), description: "OK" },
    },
  },
  "/api/catalog/{kind}": {
    get: {
      id: "listRecords",
      summary: "Records of one kind, filtered and paged",
      tag: "catalog",
      params: [
        p("kind", { schema: { type: "string", enum: RECORD_KINDS } }),
        q("status"),
        q("system"),
        q("q", str, "Text search over id and name"),
        q("limit", { type: "integer", minimum: 1, maximum: 500 }),
        q("cursor"),
      ],
      ok: { status: 200, schema: "RecordPage", description: "OK" },
      errors: [400],
    },
  },
  "/api/catalog/{kind}/{id}": {
    get: {
      id: "getRecord",
      summary: "One record with its evidence",
      tag: "catalog",
      params: [p("kind", { schema: { type: "string", enum: RECORD_KINDS } }), p("id")],
      ok: { status: 200, schema: "CatalogRecord", description: "OK" },
      errors: [404],
    },
  },
  "/api/search": {
    get: {
      id: "search",
      summary: "Find records with the query language (docs/query-language.md)",
      tag: "catalog",
      params: [
        q("q", str, "The query, e.g. kind:interface via:gateway"),
        q("limit", { type: "integer" }),
      ],
      ok: {
        status: 200,
        schema: {
          type: "object",
          properties: {
            rows: { type: "array", items: { type: "object" } },
            total: { type: "integer" },
          },
        },
        description: "OK",
      },
      errors: [400],
    },
  },
  "/api/view/{name}": {
    get: {
      id: "getView",
      summary: "A read-only view: the JSON the matching atticus … --json command prints (ADR 0043)",
      tag: "views",
      params: [
        p("name", {
          schema: {
            type: "string",
            enum: [
              "coverage",
              "questions",
              "intake",
              "triage",
              "features",
              "glossary",
              "critic-stats",
              "conflicts",
              "sources",
              "reconcile",
            ],
          },
        }),
      ],
      ok: { status: 200, schema: VIEW_RESULT, description: "OK" },
      errors: [400, 404, 422],
    },
  },
  "/api/view/{name}/{id}": {
    get: {
      id: "getViewOf",
      summary: "A read-only view of one change, feature or initiative (ADR 0043)",
      tag: "views",
      params: [
        p("name", {
          schema: {
            type: "string",
            enum: ["features", "findings", "drift", "trace", "story-bar", "initiatives"],
          },
        }),
        p("id"),
      ],
      ok: { status: 200, schema: VIEW_RESULT, description: "OK" },
      errors: [400, 404, 422],
    },
  },
  "/api/initiatives": {
    get: {
      id: "listInitiatives",
      summary: "Every initiative with its status, critical path and commitments",
      tag: "views",
      ok: { status: 200, schema: { type: "array", items: { type: "object" } }, description: "OK" },
    },
  },
  "/api/diagram/{view}": {
    get: {
      id: "getDiagram",
      summary: "A catalog view drawn as Mermaid text",
      tag: "views",
      params: [
        p("view", {
          schema: { type: "string", enum: ["context", "container", "data", "event", "sequence"] },
        }),
        q("focus", str, "The system, for container and sequence views"),
      ],
      ok: {
        status: 200,
        schema: {
          type: "object",
          required: ["text"],
          properties: {
            code: { type: "integer" },
            text: str,
            problems: { type: "array", items: str },
          },
        },
        description: "OK",
      },
      errors: [400],
    },
  },
  "/api/graph": {
    get: {
      id: "getGraph",
      summary: "Systems, components and interfaces as a graph",
      tag: "catalog",
      params: [
        q("focus", str, "Record id to centre on"),
        q("depth", { type: "integer", minimum: 1, maximum: 6 }),
        q("status"),
      ],
      ok: { status: 200, schema: "Graph", description: "OK" },
    },
  },
  "/api/impact/{id}": {
    get: {
      id: "getImpact",
      summary: "Blast radius of changing a record (API, table, column, topic...)",
      tag: "catalog",
      params: [p("id"), q("depth", { type: "integer", minimum: 1, maximum: 10 })],
      ok: { status: 200, schema: "Impact", description: "OK" },
      errors: [404],
    },
  },
  "/api/coverage": {
    get: {
      id: "getCoverage",
      summary: "What the catalog knows per area and system, and the gaps",
      tag: "catalog",
      ok: { status: 200, schema: "Coverage", description: "OK" },
    },
  },
  "/api/repos": {
    get: {
      id: "listRepos",
      summary: "Repos from every manifest with their base-clone state",
      tag: "workspace",
      ok: { status: 200, schema: arrayOf("RepoView"), description: "OK" },
    },
  },
  "/api/workspace/sync": {
    post: {
      id: "syncWorkspace",
      summary: "Clone or update base clones",
      tag: "workspace",
      body: ScanRequest.pick({ repos: true }),
      ok: { status: 202, schema: "JobAccepted", description: "Job started" },
    },
  },
  "/api/scan": {
    post: {
      id: "startScan",
      summary: "Scan repos into the catalog",
      tag: "scans",
      body: ScanRequest,
      ok: { status: 202, schema: "JobAccepted", description: "Job started" },
      errors: [409],
    },
  },
  "/api/reconcile": {
    post: {
      id: "startReconcile",
      summary: "Check a diagram against the catalog",
      tag: "scans",
      body: ReconcileRequest,
      ok: { status: 202, schema: "JobAccepted", description: "Job started" },
      errors: [404],
    },
  },
  "/api/jobs/{jobId}": {
    get: {
      id: "getJob",
      summary: "Follow a job",
      tag: "scans",
      params: [p("jobId")],
      ok: { status: 200, schema: "Job", description: "OK" },
      errors: [404],
    },
  },
  "/api/jobs/{jobId}/cancel": {
    post: {
      id: "cancelJob",
      summary: "Cancel a job",
      tag: "scans",
      params: [p("jobId")],
      ok: { status: 200, schema: "Job", description: "OK" },
      errors: [404, 409],
    },
  },
  "/api/changes": {
    get: {
      id: "listChanges",
      summary: "Changes in the metarepo",
      tag: "changes",
      params: [q("state"), q("mine", { type: "boolean" })],
      ok: { status: 200, schema: arrayOf("ChangeSummary"), description: "OK" },
    },
    post: {
      id: "createChange",
      summary: "Start a change (creates the OpenSpec change)",
      tag: "changes",
      body: NewChangeRequest,
      ok: { status: 201, schema: "ChangeDetail", description: "Created" },
      errors: [400, 409, 422],
    },
  },
  "/api/changes/{changeId}": {
    get: {
      id: "getChange",
      summary: "A change with its artifacts, workspace and hand-off",
      tag: "changes",
      params: [p("changeId")],
      ok: { status: 200, schema: "ChangeDetail", description: "OK" },
      errors: [404],
    },
  },
  "/api/changes/{changeId}/status": {
    get: {
      id: "getChangeStatus",
      summary: "State, next step, risk, test kinds, approvals and what blocks it (ADR 0043)",
      tag: "changes",
      params: [p("changeId")],
      ok: {
        status: 200,
        schema: { type: "object", required: ["state", "nextStep"] },
        description: "OK",
      },
      errors: [404],
    },
  },
  "/api/changes/{changeId}/sync": {
    post: {
      id: "syncChange",
      summary: "Refresh the change from its hand-off PR and advance it when merged (ADR 0043)",
      tag: "changes",
      params: [p("changeId")],
      body: SyncRequest,
      ok: { status: 200, schema: "ChangeDetail", description: "OK" },
      errors: [400, 404, 422],
    },
  },
  "/api/changes/{changeId}/artifacts/{artifact}": {
    get: {
      id: "getArtifact",
      summary: "Read an artifact",
      tag: "changes",
      params: [
        p("changeId"),
        p("artifact", { schema: { type: "string", enum: ChangeArtifact.options } }),
      ],
      ok: { status: 200, schema: "ArtifactContent", description: "OK" },
      errors: [404],
    },
    put: {
      id: "saveArtifact",
      summary: "Save an artifact edited in the UI",
      tag: "changes",
      params: [
        p("changeId"),
        p("artifact", { schema: { type: "string", enum: ChangeArtifact.options } }),
      ],
      body: SaveArtifactRequest,
      ok: { status: 200, schema: "ArtifactContent", description: "Saved" },
      errors: [400, 403, 404, 409],
    },
  },
  "/api/changes/{changeId}/tasks": {
    get: {
      id: "listTasks",
      summary: "Tasks by repo, in order",
      tag: "changes",
      params: [p("changeId")],
      ok: { status: 200, schema: arrayOf("Task"), description: "OK" },
      errors: [404],
    },
  },
  "/api/changes/{changeId}/workspace": {
    post: {
      id: "openWorkspace",
      summary: "Create the change's worktrees and editor workspaces",
      tag: "changes",
      params: [p("changeId")],
      body: OpenWorkspaceRequest,
      ok: { status: 200, schema: "ChangeRepos", description: "OK" },
      errors: [400, 404],
    },
  },
  "/api/changes/{changeId}/handoff": {
    post: {
      id: "handOff",
      summary: "Open the phase's hand-off PR after its gate passes",
      tag: "changes",
      params: [p("changeId")],
      body: HandoffRequest,
      ok: { status: 201, schema: "ChangeDetail", description: "Hand-off PR opened" },
      errors: [400, 403, 404, 409, 422],
    },
  },
  "/api/changes/{changeId}/runs": {
    get: {
      id: "listRuns",
      summary: "AI runs for a change",
      tag: "ai",
      params: [p("changeId")],
      ok: { status: 200, schema: arrayOf("RunView"), description: "OK" },
      errors: [404],
    },
    post: {
      id: "startRun",
      summary: "Prepare an AI run (hand-off by default)",
      tag: "ai",
      params: [p("changeId")],
      body: StartRunRequest,
      ok: { status: 201, schema: "RunView", description: "Prepared" },
      errors: [400, 403, 404, 422],
    },
  },
  "/api/runs/{runId}": {
    get: {
      id: "getRun",
      summary: "A run's state",
      tag: "ai",
      params: [p("runId")],
      ok: { status: 200, schema: "RunView", description: "OK" },
      errors: [404],
    },
  },
  "/api/runs/{runId}/done": {
    post: {
      id: "markRunDone",
      summary: "Mark done: validate the hand-off output now",
      tag: "ai",
      params: [p("runId")],
      ok: { status: 200, schema: "RunView", description: "OK" },
      errors: [404, 409],
    },
  },
  "/api/runs/{runId}/retry": {
    post: {
      id: "retryRun",
      summary: "Retry a failed run",
      tag: "ai",
      params: [p("runId")],
      ok: { status: 200, schema: "RunView", description: "OK" },
      errors: [404, 409],
    },
  },
  "/api/runs/{runId}/cancel": {
    post: {
      id: "cancelRun",
      summary: "Cancel a run",
      tag: "ai",
      params: [p("runId")],
      ok: { status: 200, schema: "RunView", description: "OK" },
      errors: [404, 409],
    },
  },
  "/api/findings": {
    get: {
      id: "listFindings",
      summary: "Critic findings, filtered",
      tag: "findings",
      params: [
        q("change"),
        q("gate"),
        q("state"),
        q("lens", { type: "string", enum: Lens.options }),
        q("severity", { type: "string", enum: Severity.options }),
      ],
      ok: { status: 200, schema: arrayOf("Finding"), description: "OK" },
    },
  },
  "/api/findings/{changeId}/{findingId}": {
    get: {
      id: "getFinding",
      summary: "One finding",
      tag: "findings",
      params: [p("changeId"), p("findingId")],
      ok: { status: 200, schema: "Finding", description: "OK" },
      errors: [404],
    },
  },
  "/api/findings/{changeId}/{findingId}/action": {
    post: {
      id: "actOnFinding",
      summary: "Apply, Edit and apply, Not relevant, Waive or Ask",
      tag: "findings",
      params: [p("changeId"), p("findingId")],
      body: FindingActionRequest,
      ok: { status: 200, schema: "Finding", description: "Recorded" },
      errors: [400, 403, 404, 409, 422],
    },
  },
  "/api/todo": {
    get: {
      id: "listSteps",
      summary: "Manual steps, where they come from, and procedures with their executors",
      tag: "release",
      params: [q("change"), q("all", { type: "boolean" })],
      ok: { status: 200, schema: { type: "object" }, description: "OK" },
    },
  },
  "/api/todo/{stepId}/export": {
    get: {
      id: "exportStep",
      summary: "One step for copying: text, CSV or an import row",
      tag: "release",
      params: [p("stepId"), q("format", { type: "string", enum: ["text", "csv", "import"] })],
      ok: { status: 200, schema: { type: "object", properties: { text: str } }, description: "OK" },
      errors: [404],
    },
  },
  "/api/todo/{stepId}/done": {
    post: {
      id: "recordStep",
      summary: "Record a manual step's result, or skip it with a reason",
      tag: "release",
      params: [p("stepId")],
      body: StepDoneRequest,
      ok: { status: 200, schema: { type: "object" }, description: "OK" },
      errors: [400, 404, 422],
    },
  },
  "/api/todo/{stepId}/run": {
    get: {
      id: "previewStepRun",
      summary: "The exact inputs an executor would get, with their sha-256, before any run",
      tag: "release",
      params: [p("stepId"), q("with")],
      ok: { status: 200, schema: { type: "object" }, description: "OK" },
      errors: [400, 404],
    },
    post: {
      id: "runStep",
      summary: "Run a step with a team's own tool; the shown inputs' sha-256 is the approval",
      tag: "release",
      params: [p("stepId")],
      body: StepRunRequest,
      ok: { status: 200, schema: { type: "object" }, description: "OK" },
      errors: [400, 404, 422],
    },
  },
  "/api/release": {
    get: {
      id: "listReleases",
      summary: "Changes, those at go / no-go first",
      tag: "release",
      ok: { status: 200, schema: { type: "array", items: { type: "object" } }, description: "OK" },
    },
  },
  "/api/release/{changeId}": {
    get: {
      id: "getRelease",
      summary:
        "Release readiness: gates, approvers, requests, repos, rollout, conflicts and evidence",
      tag: "release",
      params: [p("changeId")],
      ok: { status: 200, schema: { type: "object" }, description: "OK" },
      errors: [404],
    },
  },
  "/api/release/{changeId}/archive": {
    post: {
      id: "archiveChange",
      summary: "Run the archive gate, then archive the released change",
      tag: "release",
      params: [p("changeId")],
      body: ArchiveRequest,
      ok: { status: 200, schema: { type: "object" }, description: "OK" },
      errors: [400, 404, 422],
    },
  },
  "/api/service-desk": {
    get: {
      id: "listServiceRequests",
      summary: "Service-request drafts matched to templates, with what is missing",
      tag: "release",
      params: [q("change")],
      ok: { status: 200, schema: { type: "object" }, description: "OK" },
    },
  },
  "/api/service-desk/{changeId}/draft": {
    post: {
      id: "draftServiceRequests",
      summary: "Draft the service requests a change needs",
      tag: "release",
      params: [p("changeId")],
      body: DraftRequestsRequest,
      ok: { status: 200, schema: { type: "object" }, description: "OK" },
      errors: [400, 404, 422],
    },
  },
  "/api/service-desk/{changeId}/submit": {
    post: {
      id: "submitServiceRequests",
      summary: "File the drafts through the manual desk: each becomes a step a person does",
      tag: "release",
      params: [p("changeId")],
      ok: { status: 200, schema: { type: "object" }, description: "OK" },
      errors: [400, 404, 422],
    },
  },
  "/api/governance": {
    get: {
      id: "getGovernance",
      summary:
        "Org-pack conformance, rule layers, waivers, override rates and separation of duties",
      tag: "run",
      ok: { status: 200, schema: { type: "object" }, description: "OK" },
    },
  },
  "/api/evals": {
    get: {
      id: "getEvals",
      summary: "AI quality: eval runs, pass rates and how people resolved critic findings",
      tag: "run",
      ok: { status: 200, schema: { type: "object" }, description: "OK" },
    },
  },
  "/api/evals/run": {
    post: {
      id: "runEvals",
      summary: "Run evals in mock or replay mode (live stays in the terminal)",
      tag: "run",
      body: EvalRunRequest,
      ok: { status: 200, schema: { type: "object" }, description: "OK" },
      errors: [400, 422],
    },
  },
  "/api/evals/defences": {
    get: {
      id: "getDefences",
      summary: "What the ingested-content defences found, and each change's quarantine",
      tag: "run",
      ok: { status: 200, schema: { type: "object" }, description: "OK" },
    },
  },
  "/api/learning": {
    get: {
      id: "getLearning",
      summary: "Lessons by role, progress and the current step",
      tag: "run",
      ok: { status: 200, schema: { type: "object" }, description: "OK" },
    },
  },
  "/api/learning/start": {
    post: {
      id: "startLesson",
      summary: "Start a lesson or a role's path",
      tag: "run",
      body: StartLessonRequest,
      ok: { status: 200, schema: { type: "object" }, description: "OK" },
      errors: [400, 422],
    },
  },
  "/api/learning/check": {
    post: {
      id: "checkLesson",
      summary: "Check the current step; a miss is pass false with the hint",
      tag: "run",
      body: CheckLessonRequest,
      ok: { status: 200, schema: { type: "object" }, description: "OK" },
      errors: [400],
    },
  },
  "/api/learning/sandbox": {
    post: {
      id: "createSandbox",
      summary: "Create a throwaway practice metarepo",
      tag: "run",
      body: SandboxRequest,
      ok: { status: 201, schema: { type: "object" }, description: "OK" },
      errors: [400, 422],
    },
  },
  "/api/settings": {
    get: {
      id: "getSettings",
      summary: "Runtime settings, adapters, executors, org pack and gates (read-only)",
      tag: "run",
      ok: { status: 200, schema: { type: "object" }, description: "OK" },
    },
  },
  "/api/settings/executors/check": {
    get: {
      id: "checkExecutors",
      summary: "Ping the executors set up here; nothing runs",
      tag: "run",
      ok: { status: 200, schema: { type: "object" }, description: "OK" },
    },
  },
  "/api/orgpack": {
    get: {
      id: "getOrgPack",
      summary: "Org pack summary and every validation problem",
      tag: "orgpack",
      ok: { status: 200, schema: "OrgPackView", description: "OK" },
    },
  },
};

const ERROR_TEXT: Record<number, string> = {
  400: "The request is invalid",
  401: "Missing or wrong session token",
  403: "You can't do this; the problem says who can",
  404: "Not found",
  409: "Conflict: the file changed since you read it, or the state doesn't allow this",
  422: "Atticus refused: the problem carries the command's own words (ADR 0043)",
};

/** Build the OpenAPI 3.1 document from the zod schemas. */
export function openApiDocument(): Record<string, unknown> {
  const reg = z.registry<{ id: string }>();
  const components: Record<string, z.ZodType> = {
    Problem,
    CatalogRecord,
    RecordPage,
    KindCount,
    Graph,
    Impact,
    Coverage,
    Job,
    JobAccepted,
    ChangeSummary,
    ChangeDetail,
    ArtifactContent,
    Task,
    RunView,
    RepoView,
    OrgPackView,
    Health,
    Finding,
    ChangeRepos,
    LiveEvent,
  };
  for (const k of RECORD_KINDS) reg.add(RECORD_SCHEMAS[k], { id: k });
  for (const [id, s] of Object.entries(components)) reg.add(s, { id });
  const generated = z.toJSONSchema(reg, {
    uri: (id) => `#/components/schemas/${id}`,
    io: "output",
    unrepresentable: "any",
  }) as { schemas: Record<string, Record<string, unknown>> };
  const schemas: Record<string, unknown> = {};
  for (const [id, s] of Object.entries(generated.schemas)) {
    const { $schema: _s, $id: _i, ...rest } = s;
    schemas[id] = rest;
  }

  const paths: Record<string, Record<string, unknown>> = {};
  for (const [path, ops] of Object.entries(OPS)) {
    paths[path] = {};
    for (const [method, op] of Object.entries(ops)) {
      const content = (schema: string | object) => ({
        "application/json": { schema: typeof schema === "string" ? ref(schema) : schema },
      });
      const responses: Record<string, unknown> = {
        [op.ok.status]: op.ok.schema
          ? { description: op.ok.description, content: content(op.ok.schema) }
          : { description: op.ok.description },
        401: {
          description: ERROR_TEXT[401],
          content: { "application/problem+json": { schema: ref("Problem") } },
        },
      };
      for (const e of op.errors ?? [])
        responses[e] = {
          description: ERROR_TEXT[e],
          content: { "application/problem+json": { schema: ref("Problem") } },
        };
      paths[path]![method] = {
        operationId: op.id,
        summary: op.summary,
        tags: [op.tag],
        ...(op.params
          ? {
              parameters: op.params.map((x) => ({
                ...x,
                required: x.in === "path" ? true : (x.required ?? false),
              })),
            }
          : {}),
        ...(op.body
          ? {
              requestBody: {
                required: true,
                content: {
                  "application/json": {
                    schema: stripMeta(
                      z.toJSONSchema(op.body, { io: "input", unrepresentable: "any" }),
                    ),
                  },
                },
              },
            }
          : {}),
        responses,
      };
    }
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "Atticus local API",
      version: API_VERSION,
      description:
        "Served by `atticus ui` on 127.0.0.1. The UI only calls this API, and the API only reads and writes files in the metarepo.",
      license: { name: "Apache-2.0", identifier: "Apache-2.0" },
    },
    servers: [{ url: `http://127.0.0.1:${DEFAULT_PORT}` }],
    security: [{ sessionToken: [] }],
    tags: [
      "system",
      "catalog",
      "views",
      "workspace",
      "scans",
      "changes",
      "ai",
      "findings",
      "orgpack",
    ].map((name) => ({ name })),
    paths,
    components: {
      schemas,
      securitySchemes: {
        sessionToken: {
          type: "apiKey",
          in: "header",
          name: "X-Atticus-Token",
          description: "Printed by `atticus ui` at start-up; new every session.",
        },
      },
    },
    "x-websocket": {
      path: "/api/events",
      description: "Live updates. Pass the session token as ?token= on the upgrade request.",
      messages: ref("LiveEvent"),
    },
  };
}

function stripMeta(s: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _s, ...rest } = s;
  return rest;
}
