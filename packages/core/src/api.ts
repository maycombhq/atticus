import { z } from "zod";
import { RunRetrieval, RunState, RunSummary, RunTools, RuntimeKind } from "./schema/ai.js";
import { Evidence, RecordId } from "./schema/common.js";
import {
  Flow,
  FlowCaller,
  FlowData,
  KNOWLEDGE_KINDS,
  RECORD_KINDS,
  RECORD_SCHEMAS,
  type RecordKind,
} from "./schema/kinds.js";
import { ChangeArtifact, Phase, SOURCE_AUTHORITIES, SourceScope } from "./schema/orgpack.js";
import { Finding, FindingAction, Lens, Severity } from "./schema/review.js";
import { AnswerMatch, Question, QuestionScopeLevel } from "./schema/question.js";
import { FactCorrection } from "./schema/fact-corrections.js";
import { JOIN_GUESS_FLAGS } from "./facts-join.js";
import { AUDIT_ANSWERS, AuditItem } from "./audit.js";
import { ChangeRepos, GitRef, ManifestRepo } from "./schema/workspace.js";

/**
 * Contract C4, local API. The UI only calls this API and the API only reads and writes
 * files, so anything the UI does can also be done from the CLI or by an assistant.
 *
 * The server listens on 127.0.0.1 only (default port 4321) and every request carries the
 * per-session token Atticus prints at start-up, so other local programs and web pages
 * can't drive it. See ADR 0015.
 */
/**
 * 2.0.0 (ADR 0073): PUT /api/me and GET /api/me/approvals are gone; /api/me is the Git user.
 * 2.1.0 (ADR 0078): the questions API, /api/questions.
 * 2.2.0 (ADR 0084): GET /api/onboarding, for the Onboarding and Dashboard screens.
 * 2.3.0 (ADR 0092): the specs API, /api/specs, for the Flows screen.
 * 2.4.0 (ADR 0094): GET /api/cites, the flow steps and records that cite each line of one file.
 * 2.5.0 (ADR 0095): a change's target flows beside today's, /api/changes/{id}/target-flows.
 * 2.6.0 (ADR 0101): the Product kind in the catalog.
 * 2.7.0 (ADR 0102): knowledge in the app: /api/knowledge (sources, items and their reviews,
 *   the last scan, searching the wikis, saved searches), a change's needs and the org pack
 *   drafted from the wikis.
 * 2.8.0 (ADR 0106): model runs, GET /api/runs and /api/runs/{id}/transcript, and POST /api/runs.
 * 2.9.0 (ADR 0108): a change's picture, GET /api/changes/{id}/map.
 * 2.10.0 (ADR 0109): a change's estimate, GET /api/changes/{id}/estimate.
 * 2.11.0 (ADR 0110): the prompt and response history, GET /api/history and /api/history/{id}.
 * 2.12.0 (ADR 0107 addendum): what a model run's tools were asked and gave back: toolCalls in
 *   GET /api/runs and tools in the transcript; run records are at version 2.
 * 2.13.0 (ADR 0113): files attached to a change, GET and POST /api/changes/{id}/inputs, and
 *   whether a change takes the fast path (fastPath on a change).
 * 2.14.0 (ADR 0114): does the code do what the design says, GET /api/changes/{id}/conformance.
 * 2.15.0 (ADR 0116): how a run's context was retrieved, retrieval in the transcript (the model's
 *   expansion and rerank); run records are at version 3.
 * 2.22.0 (ADR 0124 addendum, the app's six entries): GET /api/trust (the Trust tab), a change's
 *   knowledge.yaml (GET /api/changes/{id}/knowledge, POST .../knowledge/{item}), and `full` in
 *   health (`atticus ui --full`). Additive only.
 * 2.23.0 (ADR 0124 addendum D-app, F3 and B10): the Map with its evidence, a repo's facts as the
 *   Map cites them and a person's correction of one (GET /api/facts/{repo}, POST
 *   .../corrections); a stage tab's critic findings with their options, a comment on one and
 *   the stage's questions (GET /api/changes/{id}/stages/{stage}, POST .../comments). Additive only.
 * 2.24.0 (ADR 0124 addendum B2): a change's knowledge with a title for each item and near-miss
 *   and why each was picked in plain words (title, reason). Additive only.
 * 2.25.0 (ADR 0124 addendum B-change): a change read from its stages' files. In GET
 *   /api/changes/{id}/status, `progress` (the stages done, the phases ahead of the gate and a
 *   sentence), each risk factor's `cites` and the new factors, and in `tests` `matrix` and
 *   `added`; `work` in the cockpit; `flows` in a release's conflict overlap. Additive only.
 * 2.26.0 (ADR 0124 addendum B-task-knowledge): the tasks whose own selection picked a change's
 *   item (tasks), and the pages that disagree with who decided which applies (conflicts, on a
 *   change's knowledge and on a knowledge item). Additive only.
 * 2.27.0 (ADR 0115 addendum, 2026-10-25): a stage tab's finding carries what an assistant
 *   proposed about it (`proposal`: not relevant or fixed, by whom, why), waiting on a person.
 *   Additive only.
 * 2.28.0 (ADR 0128): what a repo is, in a person's words. `description` on a repo in GET
 *   /api/onboarding and GET /api/repos/branches, and PUT /api/repos/{repo}/description, which
 *   sets, confirms or drops it. Additive only.
 * 2.29.0 (ADR 0124 addendum A-framework): what each repo is built on. `frameworks` on a repo in
 *   GET /api/trust — the framework its facts declare, the version as declared, where it is
 *   cited, and the frameworks whose patterns the facts show none of. Additive only.
 * 2.30.0 (ADR 0132): many wikis. A knowledge source's `authority`, `appliesTo` (and in words,
 *   `scope`), `readRestricted` and `maxPages` (and `authority` and `scope` on onboarding's
 *   wikis), and the two export types; a conflict's suggested
 *   page by `status`, `exception` or `authority`; and on a change's knowledge item, its page's
 *   `source` and that source's `authority`. Additive only.
 * 2.31.0 (ADR 0133): a prototype compared with the estate. GET
 *   /api/changes/{id}/prototypes: each prototype attached to the change, its calls placed as
 *   exists, changes, new or vendor, each cited. Additive only.
 * 2.32.0 (ADR 0135): why a link is there and what each count on a repo holds. `joins` on a
 *   graph edge (each call merged into it, how it was joined, verified or not, and its lines at
 *   both ends), and in GET /api/trust the lists behind a repo's counts (`lists`: the facts
 *   rejected, the files not read and excluded, the questions open). Additive only.
 * 2.33.0 (ADR 0140): questions asked in order and routed to their owner. GET /api/questions
 *   lists them in the order to ask (what a change in flight rests on first, then the answers
 *   that join the most calls), with `about` (the changes each rests on, the calls it joins, its
 *   owner team or why it has none) and, with `mine=true`, only the person's teams' (`me`).
 *   Additive only.
 * 2.34.0 (ADR 0141): the estate's freshness, GET /api/trust/fresh — per repo, the facts' commit
 *   against the clone's, the files changed that the facts cite, the facts to read again and carried,
 *   and the command to run, most stale first. It runs read-only local git in the clones (never
 *   the network, never a write). Additive only.
 * 2.35.0 (ADR 0142): the prototype comparison's further differences (`field-enum`,
 *   `header-missing`, `header-required`, `error-missing`, `error-unhandled`, with the difference's
 *   `value` or `status`), and a vendor-group call's `boundary` (`internal`: another team's
 *   system). Additive only.
 * 2.36.0 (ADR 0144): a change's impact, as designed, GET /api/changes/{changeId}/impact (V1);
 *   and a question's checked proposal (`about[id].proposal`) with POST
 *   /api/questions/{id}/answer's `acceptProposal` (Q5). Additive only.
 * 2.37.0 (ADR 0148, plan item P3): the sample audit's precision on Map › Trust,
 *   `TrustRepo.audit` — from `facts/<repo>.audit.yaml`, the facts' and the links' precision with
 *   what was drawn, answered right, wrong and unsure, still open or gone, and a 95% interval —
 *   and GET /api/facts/{repo} gives `verified: sample` for a fact answered right there that still
 *   cites the line the person saw. Additive only.
 * 2.38.0 (ADR 0124 addendum J0/J1 guesses): a link joined by a platform-wide setting, a
 *   setting's folder name or despite an open exposure conflict is a guess: `LINK_HOWS` gains
 *   `platform-setting`, `folder-name` and `conflict`, and a change's impact caller's `guessed`
 *   takes any of `JOIN_GUESS_FLAGS`. Additive only.
 * 2.41.0 (ADR 0153): a question's answer carries `match` (the rule it covers, Q2) and
 *   `proposal` (the assistant's proposal it accepted, Q5); POST /api/questions/{id}/answer takes
 *   `match`; and GET /api/questions' `about[id].owner` can be a change's people (`{ change,
 *   people }`, Q4). Additive only.
 * 2.42.0 (ADR 0149, plan items C4, O4 and P3's follow-up): after a correction, the commands to
 *   run and a preview of the next verify --write (GET /api/facts/{repo}/preview, `line` on a
 *   correction's result); the outside systems (GET /api/outside); and a sample audit drawn and
 *   answered in the app (GET and POST /api/facts/{repo}/audit). Additive only.
 * 2.43.0 (ADR 0156): a change's impact walks up the chain: each item's `chain` (who calls the
 *   callers, each hop with its depth, the callers it calls through, its verdict and owner, and the
 *   guess it rests on), `capped`, and the `upstream` counts. Additive only.
 * 2.44.0 (ADR 0160, plan item O3): another team's map, read-only. A link's join can be `shared`
 *   (`LINK_HOWS`), with `HierJoin.shared` naming the team, their repo, the line and their commit;
 *   an outside system's view gains `shared` (the team's entries, each with the calls that reach
 *   it, and the calls their map has no entry for), and a caller its `entry` and `seen: shared`.
 *   And (J1) a link joined by a Kubernetes Service's bare name with no
 *   cited namespace of the caller's the same is a guess: `LINK_HOWS` gains `service-name`, and
 *   `JOIN_GUESS_FLAGS` `joined-by-service-name`. Additive only.
 * 2.45.0 (ADR 0162, plan item F8): GET /api/questions/{id}/targets, the "Another repo…" picker of a
 *   targets question (every repo of the manifest, read or not, every system of the profiles, every
 *   team in roles.yaml, a team with no system saying the one naming it adds); POST
 *   /api/questions/{id}/answer takes `target` (any of them) with `addSystem` and `name` (a vendor
 *   or a team's system written into the profile, for review) and returns `system`; a question's
 *   `reopened` (question schema 4). Additive only.
 * 2.47.0 (ADR 0164, plan item F7): the contract check on every link. GET /api/contracts (the
 *   Mismatches page: every link checked, each mismatch and unconfirmed difference with both
 *   ends' lines and the mappings it went through); `TrustView.contracts` (the counts, for the
 *   Trust tab); and an outside system's view gains `contracts` (the calls to it against its
 *   newest intaken spec, and which findings that spec brings that the one before didn't).
 *   Additive only.
 */
export const API_VERSION = "2.47.0";
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

// ------------------------------------------------------------------ hierarchical graph (ADR 0081)

/** The lenses on the one model (plan 4.6). The flow lens arrives with the behaviour hierarchy. */
export const GRAPH_LENSES = [
  "architecture",
  "repo",
  "data",
  "integration",
  "infrastructure",
] as const;
export const GraphLens = z.enum(GRAPH_LENSES);

/** Structure levels: estate → system → repo → component → element. */
export const HIER_KINDS = [
  "estate",
  "system",
  "repo",
  "component",
  "endpoint",
  "topic",
  "client",
  "store",
  "table",
  "deployment",
  "environment",
  "unknown",
] as const;
export const HierKind = z.enum(HIER_KINDS);

/** current only for now; new, changed and retired come with feature views. */
export const HierState = z.enum(["current", "new", "changed", "retired"]);

/** A hierarchy node id: `estate`, or `<kind>:<record id>` (e.g. system:ledger). */
export const HierId = z.string().regex(/^(estate|[a-z]+:[a-z0-9][a-z0-9._-]*)$/);

/** Evidence as the inspector shows it: the file and line (`at`, path:line). */
export const HierEvidence = z.object({
  source: z.string(),
  repo: z.string().optional(),
  at: z.string(),
});

export const HierNode = z.object({
  id: HierId,
  kind: HierKind,
  label: z.string(),
  parent: HierId.optional(),
  /** Children this node has in the lens; 0 means it can't be opened. */
  childCount: z.number().int().nonnegative(),
  state: HierState,
  /** What the catalog is missing here, e.g. inferred, no-repo, no-component, not-in-catalog. */
  gaps: z.array(z.string()),
  evidence: z.array(HierEvidence),
  properties: z.record(
    z.string(),
    z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
  ),
  /** The catalog record behind the node, when there is one. */
  record: z.object({ kind: z.string(), id: RecordId }).optional(),
  /** The command for this node's next step; the app shows it, never runs it. */
  next: z.object({ command: z.string(), why: z.string() }).optional(),
});

export const HIER_EDGE_TYPES = [
  "calls",
  "publishes",
  "subscribes",
  "uses",
  "reads",
  "writes",
  "references",
  "deployed-to",
] as const;

/**
 * 2.32.0 (ADR 0135, C1): how a link's call found its callee, from its Interface's flags and via:
 * a person's `answer`, the component (`named`) or `repo` the call names, a `host` the manifest
 * lists, a person who `declared` the caller of a gateway route, a publish heard on its `topic`;
 * or a guess, by its `path` or a host's first `label`. `unknown` when the record doesn't say
 * (written before 2.32.0, or by the built-in readers). 2.38.0 (J0, J1): the guesses a join by
 * host can rest on, a `platform-setting` nobody aimed at the caller, a setting's `folder-name`,
 * or a host or base path an open `conflict` disputes. 2.44.0 (J1): or a Kubernetes Service's
 * short name (`service-name`) the caller's own cited namespace doesn't resolve.
 */
export const LINK_HOWS = [
  "answer",
  "named",
  "repo",
  "host",
  "declared",
  "topic",
  "path",
  "label",
  "platform-setting",
  "folder-name",
  "conflict",
  "service-name",
  "shared",
  "unknown",
] as const;
export const HierJoin = z.object({
  /** The catalog Interface the call is. */
  interface: z.string(),
  from: z.string(),
  to: z.string(),
  how: z.enum(LINK_HOWS),
  /** Through one or more gateways (the Interface's via). */
  gateway: z.boolean(),
  /** The Interface is verified: both ends declared, and nobody had to guess the callee. */
  verified: z.boolean(),
  method: z.string().optional(),
  path: z.string().optional(),
  /** The caller's lines: the call, and the config that ties it to the host. */
  caller: z.array(HierEvidence),
  /** The callee's lines: the entry that serves it. */
  callee: z.array(HierEvidence),
  /** Each gateway hop's lines, in order. */
  hops: z.array(HierEvidence),
  /** Lines the record doesn't place at either end (a built-in reader's). */
  other: z.array(HierEvidence),
  /**
   * 2.44.0 (ADR 0160): the call is answered by an entry of another team's shared map: the team,
   * their repo, the entry's line and the commit their code is at. Theirs to correct.
   */
  shared: z
    .object({
      team: z.string(),
      repo: z.string(),
      at: z.string(),
      commit: z.string().optional(),
    })
    .optional(),
});

/** Parallel edges between the same two nodes of the same type are one edge with a count. */
export const HierEdge = z.object({
  id: z.string(),
  from: HierId,
  to: HierId,
  type: z.enum(HIER_EDGE_TYPES),
  sync: z.enum(["sync", "async", "mixed"]).optional(),
  /** How calls travel (gateway, direct, event-bus...); "mixed" when merged calls differ. */
  via: z.string().optional(),
  count: z.number().int().positive(),
  state: HierState,
  gaps: z.array(z.string()),
  /** Up to five pieces of evidence across the merged edges. */
  evidence: z.array(HierEvidence),
  /**
   * 2.32.0 (ADR 0135, C1): the calls merged into the edge, each with how it was joined and its
   * lines at both ends; at most 20, by Interface id (`count` says how many in all).
   */
  joins: z.array(HierJoin).optional(),
});

const Suggest = z.object({ mode: z.enum(["focus", "group"]), id: HierId.optional() });

/** GET /api/graph/node/{id}: a node, its children (lazy), and its edges inside and out. */
export const GraphNodeView = z.object({
  lens: GraphLens,
  node: HierNode,
  /** Ancestors from the estate down to the node's parent: the breadcrumbs. */
  path: z.array(HierNode),
  children: z.array(HierNode),
  /** Nodes outside this one that its children's edges reach, each lifted to the nearest level. */
  outside: z.array(HierNode),
  edges: z.array(HierEdge),
  /** True when "uses" edges are the transitive reduction (the default; ?all=1 draws all). */
  reduced: z.boolean(),
  /** Edges the reduction left out. */
  hiddenEdges: z.number().int().nonnegative(),
  /** The view is better drawn another way: in focus on a table, or grouped (over 60 nodes). */
  suggest: Suggest.optional(),
});

/** GET /api/graph/focus/{id}: a node and its direct neighbours, with the edges between them. */
export const GraphFocusView = z.object({
  lens: GraphLens,
  node: HierNode,
  path: z.array(HierNode),
  neighbours: z.array(HierNode),
  edges: z.array(HierEdge),
});

export const LayoutPosition = z.object({ x: z.number().finite(), y: z.number().finite() });

/** PUT /api/graph/layout/{viewKey}: keep this arrangement. */
export const PutLayoutRequest = z.strictObject({
  lens: GraphLens,
  node: HierId,
  positions: z.record(HierId, LayoutPosition),
});

export const ViewLayoutResult = z.object({
  view: z.string(),
  saved: z.boolean(),
  path: z.string(),
  positions: z.record(z.string(), LayoutPosition),
});

export type GraphLensT = z.infer<typeof GraphLens>;
export type HierKindT = z.infer<typeof HierKind>;
export type HierNodeT = z.infer<typeof HierNode>;
export type HierEdgeT = z.infer<typeof HierEdge>;
export type HierJoinT = z.infer<typeof HierJoin>;
export type HierEvidenceT = z.infer<typeof HierEvidence>;
export type GraphNodeViewT = z.infer<typeof GraphNodeView>;
export type GraphFocusViewT = z.infer<typeof GraphFocusView>;

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
  kind: z.enum(["scan", "sync", "reconcile", "index", "intake", "step"]),
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
  /** ADR 0113: it takes the fast path, one step from brief to tasks (its type is small, or its brief says so). */
  fastPath: z.boolean().optional(),
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

/** ADR 0106: one run in the list of model runs. */
export const RunListItem = RunView.extend({
  /** The round of its step, carried across hand-offs (ADR 0103). */
  attempt: z.number().int().min(1),
  /** Whether an answer is there to read. */
  answered: z.boolean(),
  /** How many problems the checks handed back to this round. */
  handedBack: z.number().int().min(0),
  /** The prompt's size, as the context pack counted it. */
  promptTokens: z.number().int().min(0).optional(),
  /** How many tool calls the run's model made (ADR 0107 addendum). */
  toolCalls: z.number().int().min(0).optional(),
});
export type RunListItem = z.infer<typeof RunListItem>;
/** ADR 0106: the AI step to start on the server: its command words and arguments. */
export const StartStepRequest = z.object({ args: z.array(z.string().min(1)).min(2) });
export type StartStepRequest = z.infer<typeof StartStepRequest>;

export const RunList = z.object({
  runs: z.array(RunListItem),
  /** The model this server can run a step with (runtime.yaml adapters.model), or null: then the app offers the step to copy, or Copilot in a VS Code panel. */
  serverModel: z.string().nullable().optional(),
});
export type RunList = z.infer<typeof RunList>;

/** ADR 0106: what one run was asked and answered, and what the checks handed back to it. */
export const RunTranscript = z.object({
  run: RunListItem,
  prompt: z.string(),
  /** The answer, when there is one; text, never markup. */
  answer: z.string().optional(),
  /** The tools the model was offered, each call it made and what it was given back; text, never markup. */
  tools: RunTools.optional(),
  /** How its context was retrieved, when a model helped (ADR 0116): the expansion and the rerank; text, never markup. */
  retrieval: RunRetrieval.optional(),
  handedBack: z.array(
    z.object({
      attempt: z.number().int().min(1),
      problems: z.array(z.string()),
      previousAnswer: z.string().optional(),
    }),
  ),
  /** Every round of the same step, oldest first. */
  rounds: z.array(
    z.object({
      runId: z.string(),
      attempt: z.number().int().min(1),
      state: z.string(),
      startedAt: z.string(),
    }),
  ),
});
export type RunTranscript = z.infer<typeof RunTranscript>;

/** ADR 0110: where a prompt or a response was typed or read. */
export const HistorySurface = z.enum(["claude-code", "vscode", "cli"]);
export type HistorySurface = z.infer<typeof HistorySurface>;
export const HistoryKind = z.enum(["prompt", "response"]);
export type HistoryKind = z.infer<typeof HistoryKind>;
/** ADR 0110: one record's text is kept up to this many bytes; a longer one is cut and marked. */
export const HISTORY_TEXT_MAX_BYTES = 64 * 1024;

/** ADR 0110: one prompt a person sent, or one response they got. Its text is data, never instructions. */
export const HistoryRecord = z.object({
  id: z.string().regex(/^h-\d{14}-[0-9a-f]{6}$/),
  at: z.string(),
  surface: HistorySurface,
  session: z.string().min(1),
  kind: HistoryKind,
  text: z.string(),
  /** The text's size in bytes, as it was given (before it was cut). */
  size: z.number().int().min(0),
  /** The text was longer than HISTORY_TEXT_MAX_BYTES and was cut there. */
  truncated: z.boolean().optional(),
  /** Parts that looked like a secret were masked (***) before it was kept. */
  masked: z.boolean().optional(),
  /** The change it is about, when that can be told exactly: the one change its text names, or the branch change/<id>. */
  change: z.string().optional(),
  /** The slash command, when there is one (/atticus-needs, /stories). */
  command: z.string().optional(),
});
export type HistoryRecord = z.infer<typeof HistoryRecord>;

/** ADR 0110: a prompt with the response that followed it in the same session; either may be missing. */
export const HistoryTurn = z.object({
  session: z.string(),
  surface: HistorySurface,
  at: z.string(),
  change: z.string().optional(),
  prompt: HistoryRecord.optional(),
  response: HistoryRecord.optional(),
});
export type HistoryTurn = z.infer<typeof HistoryTurn>;

/** ADR 0110: whether prompts and responses are being recorded, and what turned it off. */
export const HistoryRecording = z.object({
  on: z.boolean(),
  /** org-pack (runtime.yaml history.record: false) or local (atticus history off). */
  offBy: z.enum(["org-pack", "local"]).optional(),
});
export type HistoryRecording = z.infer<typeof HistoryRecording>;

export const HistoryList = z.object({
  /** Newest first. */
  turns: z.array(HistoryTurn),
  /** How many turns matched before the limit. */
  total: z.number().int().min(0),
  recording: HistoryRecording,
});
export type HistoryList = z.infer<typeof HistoryList>;

export const HistoryEntry = z.object({
  record: HistoryRecord,
  /** The prompt this answered, or the response that followed it. */
  pair: HistoryRecord.optional(),
});
export type HistoryEntry = z.infer<typeof HistoryEntry>;

export const RepoView = ManifestRepo.extend({
  platform: RecordId,
  baseClone: z.object({
    present: z.boolean(),
    sha: z.string().optional(),
    dirty: z.boolean().optional(),
  }),
});

/**
 * ADR 0084: what the Onboarding and Dashboard screens show, read from files only: each repo
 * of every manifest, whether its base clone and scan settings are there, and what the last
 * scan wrote for it (counted from the evidence of catalog/generated); and the knowledge sources.
 */
/**
 * 2.28.0 (ADR 0128): what a repo is, in a person's words, as every screen shows it: the line,
 * whether a person wrote or confirmed it (`verified`) or the assistant drafted it and nobody has
 * (`suggested`), who, when, and the lines a draft was read from.
 */
export const RepoAbout = z.object({
  text: z.string(),
  trust: z.enum(["suggested", "verified"]),
  by: z.string().optional(),
  at: z.string().optional(),
  cites: z.array(z.object({ file: z.string(), line: z.number().int().positive() })).optional(),
});
export type RepoAboutT = z.infer<typeof RepoAbout>;

/** PUT /api/repos/{repo}/description (2.28.0): set or replace the line, confirm a draft, or drop it. */
export const EditRepoDescriptionRequest = z.object({
  /** The line a person typed; left out with `accept` to confirm the draft as it stands. */
  text: z.string().optional(),
  /** Confirm the draft on file as a person's own words. */
  accept: z.boolean().optional(),
  /** Drop the description: nothing then says what the repo is. */
  reject: z.boolean().optional(),
});

export const OnboardingRepo = z.object({
  id: RecordId,
  platform: RecordId,
  type: RecordId,
  owner: RecordId,
  /** 2.28.0: what it is, in a person's words (ADR 0128); left out when nothing says. */
  description: RepoAbout.optional(),
  /** The manifest file that lists it, relative to the metarepo. */
  manifest: z.string(),
  /** The branch the catalog is read from, and the others scanned beside it (ADR 0123). */
  defaultBranch: z.string().optional(),
  branches: z.array(z.string()).optional(),
  cloned: z.boolean(),
  /** org-pack/scan/<repo>.yaml (ADR 0075). */
  scanSettings: z.object({ path: z.string(), present: z.boolean() }),
  /** Null when no record in catalog/generated cites this repo. */
  lastScan: z
    .object({
      records: z.number().int(),
      kinds: z.record(z.string(), z.number().int()),
      commit: z.string().optional(),
      scannedAt: z.string().optional(),
    })
    .nullable(),
});

export const OnboardingView = z.object({
  manifests: z.array(z.object({ platform: RecordId, path: z.string(), repos: z.number().int() })),
  repos: z.array(OnboardingRepo),
  sources: z.object({
    path: z.string(),
    present: z.boolean(),
    wikis: z.array(
      z.object({
        id: z.string(),
        type: z.string(),
        location: z.string(),
        spaces: z.array(z.string()),
        owner: z.string().optional(),
        /** 2.30.0 (ADR 0132): how much its word counts, and where it applies, in words. */
        authority: z.enum(SOURCE_AUTHORITIES).optional(),
        scope: z.string().optional(),
      }),
    ),
    absorbed: z.array(
      z.object({ id: z.string(), url: z.string(), format: z.string(), mode: z.string() }),
    ),
  }),
  catalog: z.object({ records: z.number().int() }),
  /** Files that couldn't be read: a manifest, sources.yaml or a catalog file. */
  problems: z.array(z.object({ file: z.string(), message: z.string() })),
});
export type OnboardingViewT = z.infer<typeof OnboardingView>;

/**
 * 2.22.0 (ADR 0124 addendum, the app's Trust tab): how far to trust each repo's map, read from
 * files only: `facts/<repo>.jsonl`, the verifier's `<repo>.verify.yaml`, the checkout's HEAD read
 * from its `.git` files (no git runs), and which records of catalog/generated cite the repo from
 * its facts and which from the built-in readers.
 */
export const TrustState = z.enum([
  /** No facts file: the assistant hasn't read the repo. */
  "not-read",
  /** Facts the verifier hasn't checked (no report, or facts still marked unverified). */
  "unverified",
  /** The verifier rejected some: fix them and verify again. */
  "rejected",
  /** The facts are of another commit than the checkout's. */
  "stale",
  /** Verified, but the catalog doesn't hold them yet (atticus verify --write). */
  "unwritten",
  /** Verified and in the catalog, with source files no fact cites yet. */
  "unknown-files",
  "trusted",
]);
/** 2.37.0 (ADR 0148): a sample audit's count of one kind, with its precision and 95% interval. */
export const AuditTallyView = z.object({
  drawn: z.number().int(),
  right: z.number().int(),
  wrong: z.number().int(),
  unsure: z.number().int(),
  open: z.number().int(),
  gone: z.number().int(),
  /** right / (right + wrong); null with neither. */
  precision: z.number().nullable(),
  low: z.number().nullable(),
  high: z.number().nullable(),
});
export type AuditTallyViewT = z.infer<typeof AuditTallyView>;
export const TrustRepo = z.object({
  repo: z.string(),
  /** `facts/<repo>.jsonl`: how many facts, how many not verified, and their commit. */
  facts: z.object({
    path: z.string(),
    present: z.boolean(),
    count: z.number().int(),
    unverified: z.number().int(),
    commit: z.string().optional(),
  }),
  /** `facts/<repo>.verify.yaml`; report is null when it isn't there or can't be read. */
  verify: z.object({
    path: z.string(),
    report: z
      .object({
        accepted: z.number().int(),
        rejected: z.number().int(),
        redacted: z.number().int(),
        coverage: z.object({
          /** Files read over files that count, 0 to 1. */
          ratio: z.number(),
          read: z.number().int(),
          unknown: z.number().int(),
          excluded: z.number().int(),
        }),
        /** The first files no fact cites (at most 50). */
        unknownFiles: z.array(z.string()),
        commit: z.string().optional(),
      })
      .nullable(),
  }),
  /** The repo's checkout (its base clone, or the metarepo when adopted) and its HEAD. */
  checkout: z.object({ path: z.string(), present: z.boolean(), commit: z.string().optional() }),
  /** Whether the facts' commit is the checkout's; null when either isn't known. */
  sameCommit: z.boolean().nullable(),
  /** Records of catalog/generated citing the repo: from its facts, from the readers. */
  catalog: z.object({
    from: z.enum(["facts", "readers", "both", "none"]),
    fromFacts: z.number().int(),
    fromReaders: z.number().int(),
  }),
  state: TrustState,
  /** The command to run next (and the assistant's slash command), absent when trusted. */
  next: z.object({ command: z.string(), slash: z.string().optional() }).optional(),
  /**
   * 2.29.0 (ADR 0124 addendum A-framework): what the repo is built on, from its framework facts
   * — one entry per framework, with the version as declared, the module when a module declares
   * its own, where it is cited (`file:line`), and whether the facts show none of its patterns,
   * which is a question for a person rather than a fact about the repo. Empty until the repo is
   * read; a framework is never guessed here.
   */
  frameworks: z
    .array(
      z.object({
        name: z.string(),
        version: z.string().optional(),
        component: z.string().optional(),
        cite: z.string(),
        /** The question its missing patterns raise, when the facts show none of them. */
        gap: z.string().optional(),
      }),
    )
    .optional(),
  /**
   * 2.32.0 (ADR 0135, C3): what the counts count, so each opens its list. `rejected`: every line
   * of `<repo>.rejected.jsonl` (a rejected fact with its file and line, or a refused question,
   * reviewed entry or line that isn't a fact); `excluded`: the files the scan settings exclude
   * (the first 50); `asked`: the open questions about the repo with the lines they read;
   * `unverified`: the facts not checked yet (the first 50). Not read is `verify.report.unknownFiles`.
   */
  lists: z
    .object({
      rejected: z.array(
        z.object({
          fact: z.string().optional(),
          kind: z.string().optional(),
          file: z.string().optional(),
          line: z.number().int().optional(),
          code: z.string(),
          message: z.string(),
        }),
      ),
      excluded: z.array(z.string()),
      asked: z.array(
        z.object({ id: z.string(), question: z.string(), lines: z.array(z.string()) }),
      ),
      unverified: z.array(
        z.object({ fact: z.string(), kind: z.string(), file: z.string(), line: z.number().int() }),
      ),
    })
    .optional(),
  /**
   * 2.37.0 (ADR 0148, P3): the sample audit's precision, from `facts/<repo>.audit.yaml` (`path`):
   * the facts' (and per kind) and the links', each with the sample size and a 95% interval. A
   * fact answer whose fact has been read again since is gone, not counted; left out when the
   * repo has no audit.
   */
  audit: z
    .object({
      path: z.string(),
      facts: AuditTallyView,
      byKind: z.record(z.string(), AuditTallyView),
      links: AuditTallyView,
    })
    .optional(),
});
/** 2.47.0 (ADR 0164): the contract check's counts. */
export const ContractCounts = z.object({
  links: z.number().int(),
  compared: z.number().int(),
  mismatches: z.number().int(),
  unconfirmed: z.number().int(),
});
export const TrustView = z.object({
  /** Where the facts files are, relative to the metarepo. */
  factsDir: z.string(),
  repos: z.array(TrustRepo),
  /** 2.47.0 (ADR 0164): the contract check's counts over the estate (the Mismatches page). */
  contracts: ContractCounts.optional(),
  /** Files that couldn't be read: a manifest, a facts file, a report or a catalog file. */
  problems: z.array(z.object({ file: z.string(), message: z.string() })),
});
export type TrustViewT = z.infer<typeof TrustView>;

/**
 * 2.34.0 (ADR 0141, plan item P5): which repos' clones have moved past their facts' commit, and
 * what reading each again costs, for every repo at once (the per-repo re-read plan of ADR 0124
 * addendum A-incremental over the estate). Read from the facts files and the clones with local
 * git only; nothing is fetched or written.
 */
export const FreshState = z.enum([
  /** Facts cite files that changed, or source files changed: read again. */
  "stale",
  /** The clone doesn't have the commit the facts were read at. */
  "unknown-commit",
  /** The clone moved, but nothing the facts cite changed and no source file did. */
  "moved",
  /** No clone to compare with. */
  "no-checkout",
  "fresh",
  /** No facts yet. */
  "not-read",
]);
export const FreshRepo = z.object({
  repo: z.string(),
  state: FreshState,
  factsFile: z.string(),
  facts: z.number().int(),
  /** The commits the facts were read at, sorted. */
  factsCommits: z.array(z.string()),
  /** The commit the clone is at. */
  head: z.string().optional(),
  /** Facts already of the clone's commit. */
  current: z.number().int(),
  /** Facts whose every cited file is unchanged: carried by atticus verify. */
  carried: z.number().int(),
  /** Facts citing a file that changed, or of a commit the clone lacks: read again. */
  reread: z.number().int(),
  /** Files the facts cite that changed since. */
  citedChanged: z.number().int(),
  /** Every file changed since the facts' commits. */
  changed: z.number().int(),
  /** The source files a re-read opens. */
  toRead: z.number().int(),
  /** Commits the facts name that the clone doesn't have. */
  unknown: z.array(z.string()),
  command: z.string().optional(),
  slash: z.string().optional(),
});
export const FreshView = z.object({
  factsDir: z.string(),
  /** Most stale first. */
  repos: z.array(FreshRepo),
  problems: z.array(z.object({ file: z.string(), message: z.string() })),
});
export type FreshViewT = z.infer<typeof FreshView>;
export type FreshRepoT = z.infer<typeof FreshRepo>;
export type TrustRepoT = z.infer<typeof TrustRepo>;

/**
 * 2.22.0 (ADR 0124, Part 5): the org knowledge that applies to a change (`knowledge.yaml`, as its
 * stages' selections wrote it), with what a person confirmed or excluded and the near-misses.
 */
export const ChangeKnowledgeItem = z.object({
  id: z.string(),
  kind: z.string(),
  status: z.enum(["suggested", "confirmed", "excluded"]),
  stages: z.array(z.string()),
  score: z.number(),
  why: z.string().optional(),
  file: z.string().optional(),
  /** 2.24.0: what a person knows it by: an item's title, a section's heading path. */
  title: z.string().optional(),
  /** 2.24.0: why it was picked, in plain words (`why` is the selection's own account). */
  reason: z.string().optional(),
  /** 2.26.0: the tasks whose own selection picked it (B-task-knowledge). */
  tasks: z.array(z.string()).optional(),
  /** 2.30.0 (ADR 0132): the source of the page it is read from, and how much its word counts. */
  source: z.string().optional(),
  authority: z.enum(SOURCE_AUTHORITIES).optional(),
});

/**
 * 2.26.0 (ADR 0124 addendum B-task-knowledge): pages that disagree about a knowledge item, what
 * each says, the pages that apply (none while undecided, every one for "both, in different
 * cases") and who decided: a person's answer to the question about it, or the code (a record
 * verified from code holds one page's value: a document never overrides it). The page an
 * ownership signal suggests is shown as a suggestion, never as a decision.
 */
export const KnowledgeConflictView = z.object({
  /** The items it is about and its pages, each sorted: the same key is never asked twice. */
  key: z.string(),
  about: z.array(z.string()),
  summary: z.string().optional(),
  pages: z.array(z.object({ source: z.string(), page: z.string(), says: z.string() })),
  applies: z.array(z.object({ source: z.string(), page: z.string() })),
  decided: z
    .discriminatedUnion("by", [
      z.object({
        by: z.literal("person"),
        who: z.string(),
        at: z.string(),
        question: z.string(),
        /** "Both, in different cases" in the person's own words. */
        words: z.string().optional(),
      }),
      z.object({
        by: z.literal("code"),
        /** The catalog record verified from code, its kind, the value and where: repo:path:line. */
        record: z.string(),
        kind: z.string(),
        value: z.string(),
        at: z.string(),
      }),
    ])
    .optional(),
  /** The page an ownership signal suggests, and which signal: a suggestion only. */
  suggested: z
    .object({
      source: z.string(),
      page: z.string(),
      /** 2.30.0: status, exception and authority (ADR 0132). */
      signal: z.enum([
        "replaces",
        "owner",
        "source-kind",
        "space",
        "last-edited",
        "status",
        "exception",
        "authority",
      ]),
      detail: z.string(),
    })
    .optional(),
  question: z
    .object({ id: z.string(), state: z.enum(["open", "answered", "retired"]), repo: z.string() })
    .optional(),
});
export type KnowledgeConflictViewT = z.infer<typeof KnowledgeConflictView>;

export const ChangeKnowledgeView = z.object({
  change: z.string(),
  file: z.string(),
  /** False before a stage of the change has selected context. */
  present: z.boolean(),
  items: z.array(ChangeKnowledgeItem),
  nearMisses: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      score: z.number(),
      stage: z.string(),
      /** 2.24.0: what a person knows it by. */
      title: z.string().optional(),
    }),
  ),
  /** 2.26.0: the pages that disagree about what the change or one of its tasks relies on. */
  conflicts: z.array(KnowledgeConflictView).optional(),
  /** The command that lists it (and confirms or excludes with --confirm, --exclude). */
  command: z.string(),
});
/** atticus change knowledge <change> --confirm|--exclude <item>. */
export const SetChangeKnowledgeRequest = z.strictObject({
  status: z.enum(["confirmed", "excluded"]),
});
export const SetChangeKnowledgeResult = z.object({
  knowledge: ChangeKnowledgeView,
  file: z.string(),
  /** The git command that commits the file (the app runs no git). */
  commit: z.string(),
});
export type ChangeKnowledgeViewT = z.infer<typeof ChangeKnowledgeView>;
export type SetChangeKnowledgeResultT = z.infer<typeof SetChangeKnowledgeResult>;

/**
 * 2.23.0 (ADR 0124 addendum D-app, F3): a repo's facts as the Map cites them. Each fact with the
 * line it rests on and its quote, who made it and who checked it, the fields a person may correct
 * and a correction already on file. A flow's steps and error paths carry their own citations.
 */
export const FactCiteSpot = z.object({
  file: z.string(),
  line: z.number().int().positive(),
  value: z.string(),
  quote: z.string().optional(),
});
export const FactCiteView = z.object({
  id: z.string(),
  kind: z.string(),
  /** The claim in a few words: `GET /accounts/{accountId}`, `ledger.entries (write)`. */
  label: z.string(),
  /** The fields a person may correct, with their values now. */
  claim: z.record(z.string(), z.string()),
  cite: FactCiteSpot,
  /** A flow's steps and error paths, each at its own line. */
  steps: z.array(FactCiteSpot.extend({ what: z.string() })).optional(),
  verified: z.enum(["line", "sample", "person", "none"]),
  by: z.enum(["assistant", "reader", "person"]),
  /** A person's correction of the fact, on file; atticus verify applies it. */
  correction: FactCorrection.optional(),
});
export const RepoFactsView = z.object({
  repo: z.string(),
  /** `facts/<repo>.jsonl`, from the metarepo's root. */
  file: z.string(),
  present: z.boolean(),
  commit: z.string().optional(),
  facts: z.array(FactCiteView),
  /** `facts/<repo>.corrections.jsonl`: how many, and the facts they name the file doesn't have. */
  corrections: z.object({ file: z.string(), count: z.number().int(), stale: z.array(z.string()) }),
  /** Open questions about the repo, with the lines they read (path:line). */
  questions: z.array(
    z.object({ id: z.string(), question: z.string(), evidence: z.array(z.string()) }),
  ),
  /** The command that checks the facts again and applies the corrections. */
  verify: z.string(),
  problems: z.array(z.object({ file: z.string(), message: z.string() })),
});
/** Mark a fact wrong (with why) or correct its claim: its fields, or the line it is on. */
export const FactCorrectionRequest = z.strictObject({
  fact: z.string().min(1),
  action: z.enum(["wrong", "edit"]),
  set: z.record(z.string().min(1), z.string()).optional(),
  line: z.number().int().positive().optional(),
  reason: z.string().trim().min(1).max(500).optional(),
});
export const FactCorrectionResult = z.object({
  correction: FactCorrection,
  /** `facts/<repo>.corrections.jsonl`, from the metarepo's root. */
  file: z.string(),
  /** The git command that commits the file (the app runs no git). */
  commit: z.string(),
  /** The command that applies it: the verifier reads the corrections every time it runs. */
  verify: z.string(),
  /** 2.42.0 (ADR 0149): the line appended to the file, exactly as written. */
  line: z.string().optional(),
});
/**
 * 2.42.0 (ADR 0149, C4): after a correction the app writes, the commands a person runs (the app
 * runs none) and what the next `atticus verify <repo> --write` will change, computed in-process
 * by the same functions that command uses, writing nothing.
 */
export const NextStepView = z.object({
  step: z.enum(["verify", "branch", "add", "commit", "push", "pr"]),
  /** The command to copy; absent for a pull request on a Git host Atticus has no command for. */
  command: z.string().optional(),
});
export const PreviewLinkView = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  method: z.string().optional(),
  path: z.string(),
  confidence: z.string(),
  how: z.string().optional(),
  flags: z.array(z.string()).optional(),
  /** Under changed: the confidence and flags it had before. */
  was: z.object({ confidence: z.string(), flags: z.array(z.string()).optional() }).optional(),
});
export const VerifyPreviewView = z.object({
  repo: z.string(),
  /** The one file the app wrote: `facts/<repo>.corrections.jsonl`. */
  wrote: z.string(),
  /** The branch the git steps make. */
  branch: z.string(),
  /** In order: verify --write, then branch, add (the exact files), commit, push, pull request. */
  steps: z.array(NextStepView),
  /** What the next verify --write will change; absent when it can't be worked out here (`unavailable`). */
  preview: z
    .object({
      facts: z.object({
        /** Facts the write leaves out: marked wrong by a person, or rejected by the verifier. */
        dropped: z.array(
          z.object({
            id: z.string(),
            kind: z.string(),
            label: z.string(),
            why: z.enum(["wrong", "rejected"]),
            message: z.string().optional(),
          }),
        ),
        /** Facts whose claim or line the write changes (a person's edit), field by field. */
        edited: z.array(
          z.object({
            id: z.string(),
            kind: z.string(),
            label: z.string(),
            fields: z.array(
              z.object({
                name: z.string(),
                was: z.string().optional(),
                now: z.string().optional(),
              }),
            ),
          }),
        ),
        kept: z.number().int(),
      }),
      /** The write puts nothing in the catalog while facts are rejected: how many. */
      blocked: z.object({ rejected: z.number().int() }).optional(),
      /** The catalog records it adds, changes and removes; absent when blocked. */
      catalog: z
        .object({
          added: z.number().int(),
          changed: z.number().int(),
          removed: z.number().int(),
          /** Record files whose only change is their evidence (a line moved, a new commit). */
          evidenceOnly: z.number().int(),
          /** The record files it writes or removes, from the metarepo's root. */
          files: z.array(z.string()),
        })
        .optional(),
      /** The links (Interfaces) it adds, removes, changes, and moves (one call, another callee). */
      links: z
        .object({
          added: z.array(PreviewLinkView),
          removed: z.array(PreviewLinkView),
          changed: z.array(PreviewLinkView),
          /**
           * Links this repo's calls no longer make whose record stays, held by the callee's side
           * alone, until that repo is written again.
           */
          unmade: z.array(PreviewLinkView),
          moved: z.array(
            z.object({
              from: z.string(),
              method: z.string().optional(),
              path: z.string(),
              was: z.string(),
              to: z.string(),
            }),
          ),
        })
        .optional(),
      /** The checkout's HEAD is past the facts' commit: verify reads the changed files' facts again. */
      headMoved: z.object({ head: z.string(), commit: z.string() }).optional(),
      /** Corrections on file that meet no fact in this read (kept, applied when it is read again). */
      staleCorrections: z.array(z.string()),
    })
    .optional(),
  /** Why there is no preview: no checkout of the repo, or a facts file that doesn't read. */
  unavailable: z.enum(["no-checkout", "unreadable-facts"]).optional(),
});
export type VerifyPreviewViewT = z.infer<typeof VerifyPreviewView>;
export type PreviewLinkViewT = z.infer<typeof PreviewLinkView>;
/**
 * 2.42.0 (ADR 0149, P3's follow-up): a sample audit drawn and answered in the app, by the same
 * functions as `atticus verify audit` (the same seed draws the same sample). Each item with the
 * text of every line it cites, read from the checkout.
 */
export const AuditItemView = AuditItem.extend({
  lines: z.array(z.object({ cite: z.string(), text: z.string().optional() })),
});
export const AuditSampleView = z.object({
  repo: z.string(),
  /** `facts/<repo>.audit.yaml`, from the metarepo's root. */
  file: z.string(),
  seed: z.string(),
  size: z.number().int(),
  /** The seed a draw takes when none is given, `<repo>@<commit>`, as the CLI's. */
  defaultSeed: z.string().optional(),
  /** This draw's items, with any answers on file. */
  items: z.array(AuditItemView),
  /** Why the repo can't be audited yet; then `items` is empty. */
  refused: z.enum(["no-facts", "bad-facts", "unverified", "bad-file"]).optional(),
  /** Under `unverified`: how many facts aren't verified. */
  unverified: z.number().int().optional(),
  /** The precision over the answers on file that still stand (links checked by the join). */
  precision: z.object({ facts: AuditTallyView, links: AuditTallyView }).optional(),
  /** The same draw in a terminal. */
  command: z.string(),
});
export const AuditAnswerRequest = z.strictObject({
  seed: z.string().min(1).max(200),
  size: z.number().int().positive().max(100),
  answers: z
    .array(
      z.strictObject({
        id: z.string().min(1),
        answer: z.enum(AUDIT_ANSWERS),
        note: z.string().trim().max(500).optional(),
      }),
    )
    .min(1),
});
export const AuditAnswerResult = z.object({
  file: z.string(),
  answered: z.number().int(),
  open: z.number().int(),
  items: z.array(AuditItemView),
  precision: z.object({ facts: AuditTallyView, links: AuditTallyView }),
  /** The git command that commits the file (the app runs no git). */
  commit: z.string(),
});
export type AuditItemViewT = z.infer<typeof AuditItemView>;
export type AuditSampleViewT = z.infer<typeof AuditSampleView>;
export type AuditAnswerResultT = z.infer<typeof AuditAnswerResult>;

/**
 * 2.47.0 (ADR 0164, F7): one difference the contract check found between the two sides of a
 * link: what each side says and its line, the mappings it went through, and whether it is a
 * mismatch or unconfirmed (a mapping on the way nobody traced).
 */
export const ContractEndView = z.object({
  repo: z.string().optional(),
  system: z.string().optional(),
  what: z.string(),
  value: z.string().optional(),
  at: z.string().optional(),
});
export const ContractFactEnd = z.object({
  repo: z.string(),
  fact: z.string(),
  component: z.string(),
  at: z.string(),
});
export const ContractMismatchView = z.object({
  id: z.string(),
  interface: z.string().optional(),
  interfaces: z.array(z.string()).optional(),
  call: ContractFactEnd,
  entry: ContractFactEnd.optional(),
  system: z.string().optional(),
  status: z.enum(["mismatch", "unconfirmed"]),
  kind: z.enum([
    "field-missing",
    "field-extra",
    "field-not-sent",
    "field-required",
    "field-type",
    "field-number",
    "error-unlisted",
    "error-unanswered",
  ]),
  side: z.enum(["request", "response", "message"]).optional(),
  field: z.string().optional(),
  error: z.string().optional(),
  sender: ContractEndView,
  receiver: ContractEndView,
  via: z.array(z.string()).optional(),
  untraced: z.string().optional(),
  message: z.string(),
});
export const ContractLinkView = z.object({
  key: z.string(),
  interface: z.string().optional(),
  interfaces: z.array(z.string()).optional(),
  call: ContractFactEnd,
  entry: ContractFactEnd.optional(),
  system: z.string().optional(),
  kind: z.enum(["rest", "topic", "outside"]),
  method: z.string().optional(),
  path: z.string(),
  through: z.array(z.string()),
  specs: z.array(z.string()),
  compared: z.number().int(),
  mismatches: z.number().int(),
  unconfirmed: z.number().int(),
});
/** GET /api/contracts (2.47.0, ADR 0164): the estate's contract check. */
export const ContractsView = z.object({
  links: z.array(ContractLinkView),
  findings: z.array(ContractMismatchView),
  counts: ContractCounts,
  /** What the facts or the specs on file left out, said once. */
  notes: z.array(z.string()),
});
export type ContractMismatchViewT = z.infer<typeof ContractMismatchView>;
export type ContractLinkViewT = z.infer<typeof ContractLinkView>;
export type ContractsViewT = z.infer<typeof ContractsView>;

/**
 * 2.42.0 (ADR 0149, O4): the systems outside the estate (every profile system no estate repo
 * belongs to: vendors and other teams), each with who calls it, the operations its intaken spec
 * publishes, the calls that match nothing in that spec, and its open questions.
 */
export const OutsideCallView = z.object({
  repo: z.string(),
  component: z.string().optional(),
  /** The call fact, when the join names it. */
  fact: z.string().optional(),
  /** `path:line` of the call. */
  at: z.string(),
  method: z.string().optional(),
  path: z.string().optional(),
  /**
   * Where it was seen: a catalog Interface to the system, the estate join's outside list, the
   * system's spec (its hosts or names matched the call, ADR 0130), or more than one.
   */
  seen: z.array(z.enum(["interface", "join", "spec", "shared"])),
  /** The Interface record, when the catalog has one. */
  interface: z.string().optional(),
  /** The spec operation it reaches (its Endpoint id), when it matches one. */
  operation: z.string().optional(),
  /** Through a gateway's forwarding call (the route and the gateway's call), when it is. */
  through: z.object({ repo: z.string(), at: z.string() }).optional(),
  /** 2.44.0 (ADR 0160): the entry of another team's shared map that answers it. */
  entry: z
    .object({ team: z.string(), repo: z.string(), fact: z.string(), at: z.string() })
    .optional(),
});
export const OutsideSystemView = z.object({
  id: z.string(),
  name: z.string(),
  boundary: z.string(),
  owner: z.string().optional(),
  aliases: z.array(z.string()),
  callers: z.array(OutsideCallView),
  /** Its newest intaken spec in inputs/; absent when none is linked to it. */
  spec: z
    .object({
      path: z.string(),
      title: z.string().optional(),
      version: z.string().optional(),
      operations: z.array(
        z.object({
          id: z.string(),
          method: z.string(),
          path: z.string(),
          cite: z.string(),
          /** How many of the callers reach it. */
          calls: z.number().int(),
        }),
      ),
    })
    .optional(),
  /** Calls to it that match no operation of its spec, with why. */
  unmatched: z.array(OutsideCallView.extend({ message: z.string() })),
  /** Calls two or more of its operations answer equally well. */
  ambiguous: z.array(OutsideCallView.extend({ candidates: z.array(z.string()) })),
  /** Open questions about it: naming it, or citing a line one of its calls is on. */
  questions: z.array(z.object({ id: z.string(), repo: z.string(), question: z.string() })),
  /** With no spec: how to add one. */
  addSpec: z.array(z.string()).optional(),
  /**
   * 2.44.0 (ADR 0160): the map its team shares, read-only: whose, their commit, when it was
   * imported, each entry with how many of the callers reach it, and the calls it has no entry for.
   */
  shared: z
    .object({
      team: z.string(),
      name: z.string(),
      commit: z.string(),
      importedAt: z.string(),
      entries: z.array(
        z.object({
          repo: z.string(),
          component: z.string(),
          fact: z.string(),
          method: z.string().optional(),
          path: z.string(),
          at: z.string(),
          commit: z.string().optional(),
          calls: z.number().int(),
        }),
      ),
      unmatched: z.array(OutsideCallView.extend({ message: z.string() })),
    })
    .optional(),
  /**
   * 2.47.0 (ADR 0164): the calls to it checked against its newest intaken spec, and the ids of
   * the findings that spec brings that the one it replaced didn't (`new`, when there was one).
   */
  contracts: z
    .object({ findings: z.array(ContractMismatchView), new: z.array(z.string()).optional() })
    .optional(),
});
export const OutsideView = z.object({
  systems: z.array(OutsideSystemView),
  /** What the estate's facts left out (a repo not verified), said once. */
  notes: z.array(z.string()),
});
export type OutsideSystemViewT = z.infer<typeof OutsideSystemView>;
export type OutsideCallViewT = z.infer<typeof OutsideCallView>;
export type OutsideViewT = z.infer<typeof OutsideView>;

export type FactCiteViewT = z.infer<typeof FactCiteView>;
export type RepoFactsViewT = z.infer<typeof RepoFactsView>;
export type FactCorrectionResultT = z.infer<typeof FactCorrectionResult>;

/**
 * 2.23.0 (ADR 0124 addendum D-app, B10): a stage tab's critic findings (the latest round of the
 * stage's gate, `review/<gate>/<round>/`), each with the options it allows and the comments a
 * person wrote on it, the stage's own questions, and the command to run next. A comment is a
 * question the person answered as they asked it (ADR 0078), listed in the stage's loop file, so
 * the stage's next run reads it as a person's answer and hands it to the drafter (ADR 0087).
 */
export const STAGE_TABS = ["feature", "architecture", "stories"] as const;
export const StageTab = z.enum(STAGE_TABS);
export const StageComment = z.object({
  /** The question the comment is written as, `questions/<id>.yaml`. */
  question: z.string(),
  text: z.string(),
  by: z.string(),
  at: z.string(),
  /** A draft of the stage has read it. */
  read: z.boolean(),
});
export const StageFindingView = z.object({
  finding: Finding,
  /** The finding's file, from the metarepo's root. */
  file: z.string(),
  options: z.object({
    /** The fix's one action, in words. */
    fix: z.string(),
    /** Apply: record the fix as made (an issue). */
    apply: z.boolean(),
    /** Not relevant, with a reason (an issue). */
    dismiss: z.boolean(),
    /** Waive, with a reason: a blocking finding of a rule that allows it. */
    waive: z.boolean(),
    /** A knowledge gap's question to its owner: Ask routes it. */
    ask: z.object({ text: z.string(), owner: z.string() }).optional(),
  }),
  comments: z.array(StageComment),
  /**
   * ADR 0115 addendum (2026-10-25): what an assistant proposed about the open finding (that it
   * is not relevant, or fixed), waiting on a person. Only a person's resolution closes a blocking
   * or risk finding. Optional (additive, API 2.25.0).
   */
  proposal: z
    .object({
      claim: z.enum(["not-relevant", "fixed"]),
      by: z.string(),
      at: z.string(),
      reason: z.string().optional(),
    })
    .optional(),
});
export const StageReviewView = z.object({
  change: z.string(),
  stage: StageTab,
  /** The gate the stage's critic reviews at; null when gates.yaml has none for its phase. */
  gate: z.string().nullable(),
  /** The round shown, the gate's latest; null before the critic reviewed anything. */
  round: z.number().int().nullable(),
  /** `stage/<stage>.yaml`, the stage's loop: whether the stage has run, and where it stopped. */
  loop: z.object({
    file: z.string(),
    present: z.boolean(),
    state: z.string().optional(),
    iteration: z.number().int().optional(),
  }),
  findings: z.array(StageFindingView),
  /** The questions the stage raised (comments aside), open first. */
  questions: z.array(Question),
  /** The stage's command (and slash command), which reads the answers and comments. */
  next: z.object({ command: z.string(), slash: z.string() }),
  problems: z.array(z.object({ file: z.string(), message: z.string() })),
});
export const StageCommentRequest = z.strictObject({
  finding: z.string().min(1),
  /** The gate the finding belongs to, when its id alone is ambiguous. */
  gate: z.string().optional(),
  text: z.string().trim().min(1).max(4000),
});
export const StageCommentResult = z.object({
  comment: StageComment,
  /** The files written, from the metarepo's root: the question, and the stage's loop file. */
  files: z.array(z.string()),
  /** The git command that commits them (the app runs no git). */
  commit: z.string(),
  next: z.object({ command: z.string(), slash: z.string() }),
});
export type StageReviewViewT = z.infer<typeof StageReviewView>;
export type StageFindingViewT = z.infer<typeof StageFindingView>;
export type StageCommentResultT = z.infer<typeof StageCommentResult>;

/**
 * ADR 0092: the specs (ADR 0079) as the Flows screen reads them, from files only: the repos
 * with a spec, one repo's flows, and one flow with the joins of the estate pass (ADR 0085).
 */
export const SpecList = z.object({
  repos: z.array(z.object({ repo: RecordId, flows: z.number().int() })),
});

export const SpecFlowSummary = z.object({
  id: RecordId,
  name: z.string(),
  component: RecordId,
  trigger: z.object({ kind: z.string(), what: z.string() }),
  steps: z.number().int(),
  /** Steps a check, the AI's verification or a person confirmed. */
  confirmed: z.number().int(),
  errors: z.number().int(),
  /** Call-outs joined to another repo's flow, and the flows whose call-outs reach this one. */
  calls: z.number().int(),
  calledBy: z.number().int(),
});

export const SpecView = z.object({
  repo: RecordId,
  /** The spec folder, relative to the metarepo. */
  path: z.string(),
  commit: z.string().optional(),
  template: z.string().optional(),
  flows: z.array(SpecFlowSummary),
  /** Files in the folder that don't read, with why. */
  problems: z.array(z.object({ file: z.string(), message: z.string() })),
});

/** A step of one flow joined to a step or trigger of another (estate.yaml). */
export const FlowLink = z.object({
  /** The caller's step, 1-based. */
  step: z.number().int().positive(),
  repo: RecordId,
  flow: RecordId,
  /** The other flow's name, when its spec reads. */
  name: z.string().optional(),
  how: z.string(),
});

export const FlowView = z.object({
  repo: RecordId,
  /** The flow's file, relative to the metarepo. */
  file: z.string(),
  flow: Flow,
  /** Whether specs/estate.yaml was there to read the joins from. */
  joined: z.boolean(),
  /** This flow's call-outs and the flows they start. */
  calls: z.array(FlowLink),
  /** The flows whose call-outs start this one; step is their step. */
  calledBy: z.array(FlowLink),
  /** This flow's call-outs the estate pass couldn't join, with why. */
  unmatched: z.array(
    z.object({
      step: z.number().int().positive(),
      entry: z.string(),
      reason: z.string(),
      message: z.string(),
    }),
  ),
});
/**
 * ADR 0094: one file's cited lines, for an editor's CodeLens: each line a spec flow (its trigger,
 * a step) or a catalog record cites, with what cites it.
 */
export const CiteList = z.object({
  /** The code's repo and the file's path in it, as the citations name them. */
  repo: RecordId,
  path: z.string(),
  lines: z.array(
    z.object({
      line: z.number().int().positive(),
      flows: z.array(
        z.object({
          /** The repo whose spec holds the flow. */
          repo: RecordId,
          flow: RecordId,
          name: z.string(),
          /** 0 for what starts the flow, else the step, counting from 1. */
          step: z.number().int().nonnegative(),
          kind: z.string(),
          confirmedBy: z.string().optional(),
          /** WP7.3: the changes in flight whose target flows touch this flow. */
          changes: z.array(z.string()).optional(),
        }),
      ),
      records: z.array(
        z.object({
          kind: z.string(),
          id: RecordId,
          name: z.string().optional(),
          /** The citation's source: code, config, migration… */
          source: z.string(),
        }),
      ),
    }),
  ),
});
export type CiteListT = z.infer<typeof CiteList>;
/**
 * ADR 0095: a change's target flows (target-flows/<flow>.yaml, ADR 0087) beside today's flows
 * in the specs: each step marked same, changed, added or removed, with its number in today's
 * flow and in the target flow (repeats are target numbers).
 */
export const TargetFlowSummary = z.object({
  flow: RecordId,
  repo: RecordId,
  change: z.enum(["modify", "new", "remove"]),
  name: z.string(),
  why: z.string(),
  added: z.number().int(),
  changed: z.number().int(),
  removed: z.number().int(),
});

export const TargetFlowList = z.object({
  change: RecordId,
  flows: z.array(TargetFlowSummary),
  /** Target-flow files that don't read, with why. */
  problems: z.array(z.string()),
});

export const MergedStep = z.object({
  mark: z.enum(["same", "changed", "added", "removed"]),
  today: z.number().int().positive().optional(),
  target: z.number().int().positive().optional(),
  kind: z.string(),
  what: z.string(),
  to: z
    .object({ component: z.string(), entry: z.string(), new: z.boolean().optional() })
    .optional(),
  store: z
    .object({
      table: z.string(),
      columns: z.array(z.string()),
      new: z.boolean().optional(),
      migration: z.string().optional(),
    })
    .optional(),
  data: FlowData.optional(),
  repeats: z.object({ from: z.number().int(), to: z.number().int() }).optional(),
  evidence: z.array(Evidence),
  confirmedBy: z.string().optional(),
  was: z
    .object({
      kind: z.string(),
      what: z.string(),
      to: z.object({ component: z.string(), entry: z.string() }).optional(),
    })
    .optional(),
  why: z.string().optional(),
});

export const TargetFlowView = z.object({
  change: RecordId,
  /** The target-flow file, relative to the metarepo. */
  file: z.string(),
  flow: RecordId,
  repo: RecordId,
  delta: z.enum(["modify", "new", "remove"]),
  name: z.string(),
  why: z.string(),
  component: z.string(),
  trigger: z.object({ kind: z.string(), what: z.string(), caller: FlowCaller.optional() }),
  triggerEvidence: z.array(Evidence),
  steps: z.array(MergedStep),
  counts: z.object({
    added: z.number().int(),
    changed: z.number().int(),
    removed: z.number().int(),
  }),
  /** Why some of it can't be shown (today's flow isn't in the spec). */
  problems: z.array(z.string()),
});
const MapLegend = z.enum(["new", "modify", "retire"]);

/** A change's picture (ADR 0108): what its target flows touch, each part marked + new, ◇ modify or ✕ retire. */
export const ChangeMap = z.object({
  change: RecordId,
  title: z.string(),
  /** The folder the picture is drawn from, relative to the metarepo. */
  source: z.string(),
  groups: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      kind: z.enum(["system", "datastore"]),
      boundary: z.enum(["product", "internal", "vendor"]).optional(),
      legend: MapLegend.optional(),
    }),
  ),
  nodes: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      kind: z.enum(["system", "component", "table", "topic", "box"]),
      boundary: z.enum(["product", "internal", "vendor"]).optional(),
      legend: MapLegend.optional(),
      group: z.string().optional(),
    }),
  ),
  edges: z.array(
    z.object({
      id: z.string(),
      from: z.string(),
      to: z.string(),
      label: z.string(),
      async: z.boolean(),
      legend: MapLegend.optional(),
    }),
  ),
  /** The same picture as Mermaid, to paste into a chat, a wiki or a pull request. */
  mermaid: z.string(),
  /** How many target flows it is drawn from. */
  flows: z.number().int(),
  /** Target flows that don't read, or whose today isn't in the spec. */
  problems: z.array(z.string()),
});
export type ChangeMapT = z.infer<typeof ChangeMap>;

const Days = z.object({ p20: z.number(), p50: z.number(), p80: z.number() });

/** A change's estimate (ADR 0109): its size from the target flows, ranges with their drivers. */
export const ChangeEstimate = z.object({
  change: RecordId,
  title: z.string(),
  /** The target-flow folder it is counted from, relative to the metarepo. */
  source: z.string(),
  units: z.array(
    z.object({
      flow: z.string(),
      repo: z.string(),
      step: z.number().int().optional(),
      what: z.string(),
      class: z.string(),
      days: Days.optional(),
      source: z.string(),
    }),
  ),
  needsClass: z.number().int(),
  effort: Days.optional(),
  perRepo: z.array(
    z.object({ repo: z.string(), units: z.number().int(), effort: Days.optional() }),
  ),
  drivers: z.array(
    z.object({
      id: z.string(),
      what: z.string(),
      count: z.number().int(),
      widens: z.number().optional(),
      source: z.string().optional(),
    }),
  ),
  calendar: z.object({
    effortDays: z.number().optional(),
    waitDays: z.number().optional(),
    longer: z.enum(["work", "waiting"]).optional(),
  }),
  calibration: z.object({ calibrated: z.literal(false), source: z.string().optional() }),
  /** The org pack's estimates.yaml, relative to the metarepo, when it has one. */
  table: z.string().optional(),
  /** What couldn't be read: target flows, estimates.yaml, the forecast. */
  problems: z.array(z.string()),
});
export type ChangeEstimateT = z.infer<typeof ChangeEstimate>;

/** A team a question or a repo goes to, or why none does (ADR 0140). */
const OwnerOf = z.union([
  z.object({ team: z.string(), name: z.string().optional() }),
  z.object({ none: z.string() }),
]);

/**
 * 2.36.0 (ADR 0144, V1): a change's impact, as designed. For each entry or table its target flows
 * break: who calls or uses it today (`breaks`, or `may-break` when the join only guessed the link),
 * the fields that stop crossing, the gateway routes to update, each with its owner team.
 */
export const ChangeImpact = z.object({
  change: RecordId,
  /** How many target flows the change has; none means the architecture stage hasn't run. */
  flows: z.number().int(),
  breaks: z.number().int(),
  mayBreak: z.number().int(),
  routes: z.number().int(),
  /** 2.43.0 (ADR 0156): up the chain, hops that surely break and those resting on a guess. */
  upstream: z.object({ breaks: z.number().int(), mayBreak: z.number().int() }).optional(),
  /** The critic's rule that asks about a guessed link. */
  rule: z.string(),
  items: z.array(
    z.object({
      kind: z.enum(["endpoint", "table"]),
      flow: z.string(),
      repo: z.string(),
      id: z.string().optional(),
      name: z.string(),
      why: z.array(z.string()),
      fields: z.object({ gone: z.array(z.string()), required: z.array(z.string()) }),
      owner: OwnerOf,
      callers: z.array(
        z.object({
          component: z.string(),
          repo: z.string().optional(),
          verdict: z.enum(["breaks", "may-break"]),
          guessed: z.enum(JOIN_GUESS_FLAGS).optional(),
          interfaces: z.array(z.string()),
          flows: z.array(z.string()),
          routes: z.array(z.string()),
          at: z.array(z.string()),
          owner: OwnerOf,
        }),
      ),
      routes: z.array(
        z.object({
          id: z.string(),
          proxy: z.string().optional(),
          basepath: z.string().optional(),
          repo: z.string().optional(),
          at: z.array(z.string()),
          callers: z.array(z.string()),
          owner: OwnerOf,
        }),
      ),
      /** 2.43.0 (ADR 0156): who calls the callers, by depth (2 up to 5) then component. */
      chain: z
        .array(
          z.object({
            component: z.string(),
            repo: z.string().optional(),
            depth: z.number().int(),
            via: z.array(z.string()),
            entries: z.array(z.string()),
            verdict: z.enum(["breaks", "may-break"]),
            guessed: z.enum(JOIN_GUESS_FLAGS).optional(),
            restsOn: z.string().optional(),
            interfaces: z.array(z.string()),
            flows: z.array(z.string()),
            routes: z.array(z.string()),
            at: z.array(z.string()),
            owner: OwnerOf,
          }),
        )
        .optional(),
      /** The walk stopped at its depth cap with callers still above. */
      capped: z.literal(true).optional(),
    }),
  ),
  owners: z.array(z.object({ owner: OwnerOf, repos: z.array(z.string()) })),
  /** What couldn't be read: target flows, the manifests, roles.yaml. */
  problems: z.array(z.string()),
});
export type ChangeImpactT = z.infer<typeof ChangeImpact>;

/** Where a conformance item is: a file of the repo at the branch's commit, or the target flow. */
const ConformCite = z.object({
  source: z.enum(["artifact", "code"]),
  repo: z.string().optional(),
  path: z.string(),
  line: z.number().int().positive().optional(),
});

/** One thing the conformance check looked for, or found that no target flow names (ADR 0114). */
export const ConformItem = z.object({
  status: z.enum(["found", "missing", "still-there", "unexpected"]),
  check: z.enum(["call", "publish", "table", "column", "migration", "trigger", "endpoint"]),
  /** The target flow and its step (from 1); none for something no target flow names. */
  flow: z.string().optional(),
  item: z.number().int().positive().optional(),
  task: z.string().optional(),
  what: z.string(),
  record: z.string().optional(),
  at: z.array(ConformCite),
  /** The finding it became on the conform gate, and its state; none for what was found. */
  finding: z.object({ id: z.string(), state: z.string() }).optional(),
});
export type ConformItemT = z.infer<typeof ConformItem>;

/**
 * The newest conformance check of one repo of a change (ADR 0114), as stored in the change
 * folder at conform/<repo>.yaml: the branch's commit scanned, compared with the target flows.
 */
export const ConformRepoResult = z.object({
  schemaVersion: z.literal(1),
  change: RecordId,
  repo: z.string(),
  /** The branch checked, and the commits: the branch's and the base it was cut from. */
  ref: z.string(),
  commit: z.string(),
  base: z.string(),
  /** The task whose steps were checked; none: every step of the repo's target flows. */
  task: z.string().optional(),
  checkedAt: z.string(),
  counts: z.object({
    found: z.number().int(),
    missing: z.number().int(),
    stillThere: z.number().int(),
    unexpected: z.number().int(),
  }),
  items: z.array(ConformItem),
  /** Steps no scan can show (a branch, a transform): a person or a test checks them. */
  unchecked: z.array(
    z.object({
      flow: z.string(),
      item: z.number().int().positive().optional(),
      kind: z.string(),
      why: z.string(),
    }),
  ),
  problems: z.array(z.string()),
});
export type ConformRepoResultT = z.infer<typeof ConformRepoResult>;

/** A change's newest conformance results, one per repo checked (ADR 0114). */
export const ChangeConformance = z.object({
  change: RecordId,
  title: z.string(),
  /** How many target flows the change has; 0: nothing to compare yet. */
  flows: z.number().int(),
  results: z.array(ConformRepoResult),
  /** The built-in gate the findings are on, and its newest round. */
  gate: z.literal("conform"),
  round: z.number().int().positive().optional(),
  problems: z.array(z.string()),
});
export type ChangeConformanceT = z.infer<typeof ChangeConformance>;
export type TargetFlowListT = z.infer<typeof TargetFlowList>;
export type TargetFlowViewT = z.infer<typeof TargetFlowView>;

export type SpecListT = z.infer<typeof SpecList>;
export type SpecViewT = z.infer<typeof SpecView>;
export type FlowViewT = z.infer<typeof FlowView>;

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
  /** 2.22.0: started with `atticus ui --full`, so the app offers every page, not only the six. */
  full: z.boolean().optional(),
});

// ------------------------------------------------------------------ request bodies

export const ScanRequest = z.strictObject({
  repos: z.array(RecordId).optional(),
  /** Ignore the cache and rescan everything. */
  full: z.boolean().default(false),
  /** Another branch, scanned beside the baseline into catalog/branches/<branch>/ (ADR 0123). */
  ref: GitRef.optional(),
});

/** ADR 0123: each repo's branches, as the Repos screen shows them. */
export const RepoBranchesView = z.object({
  id: RecordId,
  platform: z.string(),
  url: z.string(),
  type: z.string(),
  owner: z.string(),
  /** 2.28.0: what it is, in a person's words (ADR 0128); left out when nothing says. */
  description: RepoAbout.optional(),
  defaultBranch: z.string(),
  /** The branch the remote calls its default, as the base clone last heard it. */
  remoteDefault: z.string().optional(),
  branches: z.array(z.string()),
  /** The base clone's commit: what the baseline catalog was read from. */
  commit: z.string().optional(),
  /** Its branches scanned beside the baseline, with when and at which commit. */
  scans: z.array(z.object({ branch: z.string(), scannedAt: z.string(), commit: z.string() })),
});
export const RepoBranchesList = z.object({ repos: z.array(RepoBranchesView) });
/** What a branch's catalog changes against the baseline, for the repos it read. */
export const BranchCompare = z.object({
  branch: z.string(),
  scannedAt: z.string(),
  repos: z.array(z.object({ id: z.string(), commit: z.string() })),
  added: z.array(z.string()),
  removed: z.array(z.string()),
  changed: z.array(z.object({ record: z.string(), fields: z.array(z.string()) })),
});
export const EditRepoBranchesRequest = z.strictObject({
  defaultBranch: GitRef.optional(),
  branches: z.array(GitRef).optional(),
});
/** WP7.5: follow a change, or stop following it (the person's own .atticus/me.yaml). */
export const WatchRequest = z.strictObject({ change: RecordId, watch: z.boolean() });

/** WP7.2: the lines around each line a question cites. */
export const QuestionEvidenceList = z.object({
  excerpts: z.array(
    z.object({
      ref: z.string(),
      line: z.number().int(),
      start: z.number().int(),
      lines: z.array(z.string()),
      found: z.boolean(),
    }),
  ),
});
export type QuestionEvidenceListT = z.infer<typeof QuestionEvidenceList>;

/** WP7.1: the change cockpit, what a person needs to follow one change. */
export const ChangeCockpit = z.object({
  id: z.string(),
  state: z.string(),
  next: z
    .object({
      step: z.string(),
      command: z.string(),
      slash: z.string().optional(),
      why: z.string(),
    })
    .passthrough()
    .optional(),
  nextStep: z.string(),
  reasons: z.array(z.object({ code: z.string(), message: z.string() })),
  risk: z.object({ level: z.string(), score: z.number() }),
  /** Where the stages' work is against the state (ADR 0124 addendum B-change, 2.25.0). */
  work: z.string().optional(),
  stages: z.array(
    z.object({
      stage: z.enum(["feature", "architecture", "stories"]),
      state: z.string(),
      drafts: z.number().int(),
      rounds: z.number().int(),
      openQuestions: z.number().int(),
    }),
  ),
  openQuestions: z.number().int(),
  repos: z.array(
    z.object({ id: z.string(), branch: z.string(), base: z.string(), pr: z.string().optional() }),
  ),
});
export type ChangeCockpitT = z.infer<typeof ChangeCockpit>;
export type RepoBranchesViewT = z.infer<typeof RepoBranchesView>;
export type RepoBranchesListT = z.infer<typeof RepoBranchesList>;
export type BranchCompareT = z.infer<typeof BranchCompare>;

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
  /** WP7.6: an archived change to start from (its folder or its id), attached as an example. */
  like: z.string().min(1).optional(),
});

/** WP7.6: an archived change near a new brief. */
export const PastChange = z.object({
  /** The archive folder's name, <date>-<id>. */
  id: z.string(),
  change: z.string(),
  title: z.string(),
  archived: z.string().optional(),
  summary: z.string(),
  file: z.string(),
  /** cos for meaning, the words' score for words. */
  score: z.number(),
});

/** WP7.6: the archived changes nearest a new brief, by meaning or, where that is off, by words. */
export const SimilarChanges = z.object({
  how: z.enum(["meaning", "words"]),
  note: z.string().optional(),
  changes: z.array(PastChange),
});
export type SimilarChangesT = z.infer<typeof SimilarChanges>;

/** WP7.6: attach an archived change to a change as an example its steps read (ADR 0113). */
export const AttachPastChangeRequest = z.strictObject({ like: z.string().min(1) });
export const AttachPastChangeResult = z.object({
  /** The archive folder attached. */
  like: z.string(),
  /** Where it went in the change: inputs/like-<id>.md. */
  file: z.string(),
});

/** ADR 0113: a file attached to a change, as inputs/index.yaml lists it. */
export const ChangeInput = z.object({
  path: z.string(),
  name: z.string(),
  kind: z.string(),
  format: z.string(),
  sha256: z.string(),
  bytes: z.number().int(),
  addedBy: z.string(),
  addedAt: z.string(),
  /** text: a reader read it, cited by line or page; needs-reading: a picture or a file no reader takes. */
  read: z.enum(["text", "needs-reading"]),
  readAs: z.string().optional(),
  citeBy: z.enum(["line", "page", "section"]).optional(),
  version: z.string().optional(),
  date: z.string().optional(),
  supersedes: z.string().optional(),
  supersededBy: z.string().optional(),
  defences: z
    .object({ risk: z.enum(["medium", "high"]), reason: z.string(), rules: z.array(z.string()) })
    .optional(),
});
export const ChangeInputList = z.object({ files: z.array(ChangeInput) });

/** ADR 0113: one file to attach, its bytes in base64; at most 15 MB of file. */
export const AttachFileRequest = z.strictObject({
  name: z.string().min(1).max(200),
  content: z
    .string()
    .min(1)
    .max(20 * 1024 * 1024)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, "base64"),
});

export const AttachResult = z.object({
  added: z.array(ChangeInput),
  refused: z.array(z.object({ name: z.string(), why: z.string() })),
  notes: z.array(z.string()),
});
/** A file in the metarepo's inputs/ (ADR 0122): what it is, whether it was read, its items. */
export const DocumentView = z.object({
  path: z.string(),
  kind: z.string(),
  title: z.string().optional(),
  systems: z.array(z.string()),
  state: z.enum(["read", "skipped", "not-synced"]),
  reason: z.string().optional(),
  duplicateOf: z.string().optional(),
  supersededBy: z.string().optional(),
  inbox: z.boolean(),
  modifiedAt: z.string().optional(),
  items: z.array(z.object({ id: z.string(), title: z.string(), verified: z.boolean() })),
});
export const DocumentList = z.object({
  documents: z.array(DocumentView),
  snapshot: z.object({ date: z.string() }).nullable(),
  commands: z.array(z.string()),
});
export const AddDocumentResult = z.object({
  added: z.array(z.object({ name: z.string(), path: z.string(), kind: z.string() })),
  refused: z.array(z.object({ name: z.string(), why: z.string() })),
});
export const PromoteResult = z.object({ path: z.string(), note: z.string() });
export type DocumentViewT = z.infer<typeof DocumentView>;
export type DocumentListT = z.infer<typeof DocumentList>;
export type AddDocumentResultT = z.infer<typeof AddDocumentResult>;

export type ChangeInputT = z.infer<typeof ChangeInput>;
export type ChangeInputListT = z.infer<typeof ChangeInputList>;
export type AttachResultT = z.infer<typeof AttachResult>;

// ------------------------------------------------------------------ a prototype compared (ADR 0133)

/** One end of the comparison: a fact, its repo and component, and the line it cites. */
const PrototypeEnd = z.object({
  repo: z.string(),
  fact: z.string(),
  component: z.string(),
  at: z.string(),
});
const PrototypeSaid = z.object({ value: z.string(), at: z.string() });

/** One way the estate (or a vendor) serves an operation other than as the prototype needs. */
export const PrototypeDifferenceView = z.object({
  kind: z.enum([
    "field-missing",
    "field-type",
    "field-required",
    "field-enum",
    "header-missing",
    "header-required",
    "error-missing",
    "error-unhandled",
    "scope-missing",
    "auth",
  ]),
  side: z.enum(["request", "response"]).optional(),
  field: z.string().optional(),
  scope: z.string().optional(),
  value: z.string().optional(),
  status: z.string().optional(),
  prototype: PrototypeSaid,
  estate: PrototypeSaid.optional(),
  message: z.string(),
});

/** One call of the prototype (a screen's to its BFF, the BFF's to a mock), placed in a group. */
export const PrototypeCallView = z.object({
  id: z.string(),
  leg: z.enum(["ui-bff", "bff-mock"]),
  group: z.enum(["exists", "changes", "new", "vendor"]),
  method: z.string().optional(),
  path: z.string(),
  call: PrototypeEnd,
  lands: PrototypeEnd,
  auth: z.string().optional(),
  scopes: z.array(z.string()).optional(),
  estate: z
    .object({
      entry: PrototypeEnd,
      endpoint: z.string(),
      how: z.string(),
      gateway: z.array(z.string()).optional(),
      auth: z.string().optional(),
      scopes: z.array(z.string()).optional(),
    })
    .optional(),
  vendor: z
    .object({
      system: z.string(),
      name: z.string(),
      operation: z.string(),
      method: z.string(),
      path: z.string(),
      at: z.string().optional(),
      through: z.array(z.string()),
      boundary: z.enum(["vendor", "internal"]).optional(),
    })
    .optional(),
  candidates: z.array(PrototypeEnd).optional(),
  differences: z.array(PrototypeDifferenceView),
  sentence: z.string(),
});

export const PrototypeComparisonView = z.object({
  prototype: z.string(),
  counts: z.object({
    exists: z.number().int(),
    changes: z.number().int(),
    new: z.number().int(),
    vendor: z.number().int(),
  }),
  calls: z.array(PrototypeCallView),
  repos: z.array(z.string()),
  uses: z.array(z.string()),
  endpoints: z.array(z.string()),
  vendorOperations: z.array(z.string()),
  vendors: z.array(z.string()),
  left: z.array(z.object({ call: PrototypeEnd, why: z.string() })),
});

/**
 * A prototype attached to a change (`atticus change attach <change> --prototype <repo>`), compared
 * again from today's facts; `problem` says why it can't be (its facts aren't verified, it is no
 * longer typed a prototype).
 */
export const ChangePrototype = z.object({
  repo: z.string(),
  /** The attached comparison: inputs/prototype-<repo>.md. */
  attached: z.string(),
  about: z.object({ text: z.string(), trust: z.enum(["suggested", "verified"]) }).optional(),
  comparison: PrototypeComparisonView.optional(),
  problem: z.string().optional(),
});
export const ChangePrototypeList = z.object({ prototypes: z.array(ChangePrototype) });
export type PrototypeCallViewT = z.infer<typeof PrototypeCallView>;
export type ChangePrototypeT = z.infer<typeof ChangePrototype>;
export type ChangePrototypeListT = z.infer<typeof ChangePrototypeList>;

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
/** ADR 0045: record a measured outcome of a released change, as the signed-in person. */
export const RecordOutcomeRequest = z.strictObject({
  /** The measure's id, its number in the brief, or its words. */
  measure: z.string().trim().min(1),
  value: z.string().trim().min(1).max(500),
  note: z.string().trim().min(1).max(1000).optional(),
});
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

/** ADR 0047: accept the as-is catalog as the baseline, as the person (their Git user, ADR 0073). */
export const BaselineRequest = z.strictObject({ note: z.string().trim().min(1).optional() });

/** ADR 0046: run the critic at a gate (the change's current one by default). */
export const RunCriticRequest = z.strictObject({ gate: z.string().min(1).optional() });

/** ADR 0048: how often the person wants their digest, and where it goes. */
export const SaveNotifyRequest = z.strictObject({
  digest: z.enum(["off", "daily", "weekly"]),
  channel: z.string().trim().min(1).optional(),
});

/** ADR 0048: show the digest, or send it through the notify adapter (the click is the approval). */
export const SendDigestRequest = z.strictObject({ send: z.boolean().default(false) });

/** ADR 0043: choose one of a triage item's numbered options; it writes a curated decision. */
export const TriageDecideRequest = z.strictObject({
  option: z.number().int().min(1),
  reason: z.string().trim().min(1).optional(),
});

export const ReconcileRequest = z.strictObject({ diagram: z.string().min(1) });

/** ADR 0078: the questions in questions/, and the files that aren't valid questions. */
export const QuestionList = z.object({
  questions: z.array(Question),
  problems: z.array(z.object({ file: z.string(), message: z.string() })),
  /**
   * 2.33.0 (ADR 0140), by question id: the changes in flight that rest on it, how many calls its
   * answer joins, and the team it goes to (the repo manifest's owner, named by roles.yaml) or why
   * none does.
   */
  about: z
    .record(
      z.string(),
      z.object({
        restsOn: z.array(z.string()),
        joins: z.number().int(),
        owner: z.union([
          z.object({ team: z.string(), name: z.string().optional() }),
          /** 2.41.0 (ADR 0153, Q4): a change's own question goes to the change's people. */
          z.object({ change: z.string(), people: z.array(z.string()) }),
          z.object({ none: z.string() }),
        ]),
        /**
         * 2.36.0 (ADR 0144, Q5): the answer the assistant proposed, for an open question, when
         * every line it cites says what it quotes. A person accepts it or answers otherwise.
         */
        proposal: z
          .object({
            answer: z.object({
              option: z.number().int().optional(),
              text: z.string().optional(),
            }),
            why: z.string(),
            cites: z.array(
              z.object({
                repo: z.string().optional(),
                file: z.string(),
                line: z.number().int(),
                quote: z.string(),
              }),
            ),
            by: z.string(),
            at: z.string(),
            file: z.string(),
          })
          .optional(),
      }),
    )
    .optional(),
  /** 2.33.0 (ADR 0140): with mine=true, who the person is and the teams roles.yaml puts them on. */
  me: z
    .object({
      handle: z.string(),
      teams: z.array(z.object({ id: z.string(), name: z.string().optional() })),
    })
    .optional(),
});
export type QuestionListT = z.infer<typeof QuestionList>;

/** ADR 0078: answer a question with one of its options or in the person's own words. */
export const AnswerQuestionRequest = z.strictObject({
  option: z.number().int().min(1).optional(),
  text: z.string().trim().min(1).optional(),
  /** The scope the person confirms; default the one proposed. */
  scope: QuestionScopeLevel.optional(),
  /** The repo type, when a repo question is widened to its type. */
  repoType: RecordId.optional(),
  /**
   * 2.36.0 (ADR 0144, Q5): accept the assistant's proposed answer, checked again, as the person's
   * own (in place of option or text).
   */
  acceptProposal: z.literal(true).optional(),
  /**
   * 2.41.0 (ADR 0153, Q2): the rule the answer covers, for a target or hosts question: a host
   * pattern (`*.payments.forge.internal`) or a path prefix (`/forge/limits/**`).
   */
  match: AnswerMatch.optional(),
  /**
   * 2.45.0 (ADR 0162, F8): for a targets question, the repo, system or team the call goes to, from
   * the picker (in place of option or text). A vendor not in the profile, or a team with no
   * system, needs `addSystem`: the system is written into the profile, for review.
   */
  target: z.string().trim().min(1).optional(),
  addSystem: z.enum(["vendor", "internal"]).optional(),
  /** The new system's name, with `addSystem`; the target's words when left out. */
  name: z.string().trim().min(1).optional(),
});

/** ADR 0078: the answered question, the command to run next and, for a repo type, its skill file. */
export const AnsweredQuestion = z.object({
  question: Question,
  rerun: z.string(),
  skill: z.object({ path: z.string(), written: z.boolean() }).optional(),
  /** 2.45.0 (ADR 0162): the system a `target` answer wrote into the profile. */
  system: z
    .object({
      id: z.string(),
      profile: z.string(),
      added: z.boolean(),
      boundary: z.enum(["vendor", "internal"]),
      owner: z.string().optional(),
    })
    .optional(),
});

/** 2.45.0 (ADR 0162, F8): the "Another repo…" picker of a targets question. */
export const TargetPickList = z.object({
  picks: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(["repo", "system", "team"]),
      name: z.string(),
      read: z.boolean().optional(),
      boundary: z.string().optional(),
      /** A team with no system yet: the system naming it adds to the profile (with addSystem). */
      adds: z
        .object({
          id: z.string(),
          name: z.string(),
          boundary: z.literal("internal"),
          owner: z.string(),
        })
        .optional(),
    }),
  ),
});
export type TargetPickListT = z.infer<typeof TargetPickList>;

// ------------------------------------------------------------------ knowledge (ADR 0101, 0102)

const FileProblem = z.object({ file: z.string(), message: z.string() });
const KnowledgeKindE = z.enum(KNOWLEDGE_KINDS);

/** The wiki types sources.yaml takes (C6). */
export const WIKI_TYPES = [
  "confluence",
  "ado-wiki",
  "sharepoint",
  "markdown-folder",
  "git",
  // 2.30.0 (ADR 0132): a space or site exported to a folder.
  "confluence-export",
  "sharepoint-export",
] as const;

/** A person's review of a knowledge item (ADR 0101); stale: its page changed since. */
export const KnowledgeReviewSummary = z.object({
  state: z.enum(["verified", "corrected", "rejected", "stale"]),
  verdict: z.enum(["verified", "corrected", "rejected"]),
  by: z.string(),
  at: z.string(),
  note: z.string().optional(),
  /** The fields a correction set. */
  corrected: z.array(z.string()).optional(),
});

/** One knowledge source of sources.yaml, with its newest snapshot. */
export const KnowledgeSource = z.object({
  id: z.string(),
  type: z.string(),
  location: z.string(),
  ref: z.string().optional(),
  path: z.string().optional(),
  checkout: z.enum(["clone", "submodule"]).optional(),
  owner: z.string().optional(),
  tags: z.object({ kinds: z.array(z.string()), frameworks: z.array(z.string()) }),
  /** 2.30.0 (ADR 0132): how much its word counts; left out, as a team's. */
  authority: z.enum(SOURCE_AUTHORITIES).optional(),
  /** 2.30.0: where it applies (sources.yaml appliesTo); left out, everywhere. */
  appliesTo: SourceScope.optional(),
  /** 2.30.0: appliesTo in words: "platforms gcp; new components". */
  scope: z.string().optional(),
  /** 2.30.0: page overrides of its authority or status. */
  byPage: z.number().int().optional(),
  readRestricted: z.boolean().optional(),
  maxPages: z.number().int().optional(),
  /** The newest snapshot `atticus sources sync` took; none before the first sync. */
  snapshot: z
    .object({
      date: z.string(),
      takenAt: z.string(),
      /** A git wiki's commit the pages were read at. */
      commit: z.string().optional(),
      pages: z.number().int(),
      skipped: z.number().int(),
      ageDays: z.number().int(),
    })
    .optional(),
  /** The snapshot the last knowledge scan read of it. */
  scanned: z.object({ date: z.string(), pages: z.number().int() }).optional(),
  /** No snapshot, or the newest is older than staleDays: sync it again. */
  stale: z.boolean(),
  /** The commands to read it: sync here, then the AI step in a terminal or Copilot Chat. */
  commands: z.object({ sync: z.string(), scan: z.string(), slash: z.string() }),
});

export const KnowledgeSourceList = z.object({
  file: z.string(),
  types: z.array(z.string()),
  kindSuggestions: z.array(z.string()),
  staleDays: z.number().int(),
  sources: z.array(KnowledgeSource),
  problems: z.array(FileProblem),
});

/** atticus sources add <type> <location> [--id --path --ref --submodule --kind --framework --owner --save]. */
export const AddSourceRequest = z.strictObject({
  type: z.enum(WIKI_TYPES),
  location: z.string().trim().min(1),
  id: RecordId.optional(),
  path: z.string().trim().min(1).optional(),
  ref: z.string().trim().min(1).optional(),
  submodule: z.boolean().optional(),
  kinds: z.array(RecordId).optional(),
  frameworks: z.array(RecordId).optional(),
  owner: z.string().trim().min(1).optional(),
  /** Write the entry into sources.yaml; without it, the entry to add is only printed. */
  save: z.boolean().default(true),
});

/** What a command printed, and its exit code (0 done, 1 done with problems to read). */
export const CommandOutput = z.object({
  code: z.number().int(),
  lines: z.array(z.string()),
  problems: z.array(z.string()),
});

/** A knowledge item as people reviewed it, with what Correct may set. */
export const KnowledgeItemView = z.object({
  id: z.string(),
  kind: KnowledgeKindE,
  /** The C1 kind it is stored as. */
  recordKind: z.string(),
  title: z.string(),
  /** The record, with any correction applied (C1). */
  record: z.record(z.string(), z.unknown()),
  review: KnowledgeReviewSummary.optional(),
  /** The fields a person may correct and whether each is text, a list or links. */
  fields: z.record(z.string(), z.enum(["text", "list", "links"])),
  /** Another page disagrees with it. */
  conflict: z.boolean(),
  /** 2.26.0: the pages that disagree about it, and who decided which applies. */
  conflicts: z.array(KnowledgeConflictView).optional(),
});

export const KnowledgeItemList = z.object({
  items: z.array(KnowledgeItemView),
  problems: z.array(FileProblem),
});

/** What the last knowledge scan read and changed, and the reviews to check again. */
export const KnowledgeScanView = z.object({
  scannedAt: z.string().optional(),
  snapshots: z.array(z.object({ source: z.string(), date: z.string(), pages: z.number().int() })),
  changes: z
    .object({
      at: z.string(),
      added: z.array(z.string()),
      changed: z.array(z.string()),
      removed: z.array(z.string()),
    })
    .optional(),
  checkAgain: z.array(
    z.object({ id: z.string(), kind: KnowledgeKindE, title: z.string(), by: z.string() }),
  ),
  conflicts: z.number().int(),
  injections: z.number().int(),
  failed: z.number().int(),
  command: z.string(),
  slash: z.string(),
});

const FieldValue = z.union([
  z.string(),
  z.array(z.string()),
  z.array(z.strictObject({ url: z.string().min(1), label: z.string().optional() })),
]);

/** atticus knowledge verify|correct|reject <item>, as the signed-in person. */
export const ReviewItemRequest = z.strictObject({
  verdict: z.enum(["verified", "corrected", "rejected"]),
  /** Required to reject: the reason. */
  note: z.string().trim().min(1).optional(),
  /** Correct only: field → value; a list takes strings, links take { url, label }. */
  set: z.record(z.string(), FieldValue).optional(),
});

export const ReviewedItem = z.object({ item: KnowledgeItemView, file: z.string() });

/** A section of a snapshot page that mentions the phrase searched for. */
export const PageMatch = z.object({
  source: z.string(),
  page: z.string(),
  section: z.string(),
  line: z.number().int(),
  excerpt: z.string(),
});

export const WikiSearchResult = z.object({
  phrase: z.string(),
  /** Sources with a snapshot to search. */
  sources: z.number().int(),
  matches: z.array(PageMatch),
  pages: z.array(z.string()),
  /** The AI step that reads those pages: the command and the slash command. */
  command: z.string(),
  slash: z.string(),
});

export const FindCandidateView = z.object({
  id: z.string(),
  kind: KnowledgeKindE,
  recordKind: z.string(),
  title: z.string(),
  record: z.record(z.string(), z.unknown()),
  /** The item it already is, when it is one. */
  known: z.string().optional(),
  kept: z.object({ by: z.string(), at: z.string(), as: KnowledgeKindE }).optional(),
  /** The kinds it can be kept as. */
  keepAs: z.array(KnowledgeKindE),
});

export const SavedFindView = z.object({
  slug: z.string(),
  phrase: z.string(),
  at: z.string(),
  file: z.string(),
  matches: z.array(PageMatch),
  candidates: z.array(FindCandidateView),
});

export const SavedFindList = z.object({ finds: z.array(SavedFindView) });

/** atticus knowledge keep <item> --find <slug> [--as kind] [--set f=v] [--note]. */
export const KeepCandidateRequest = z.strictObject({
  item: RecordId,
  as: KnowledgeKindE.optional(),
  note: z.string().trim().min(1).optional(),
  set: z.record(z.string(), FieldValue).optional(),
});

export const KeptCandidate = z.object({ item: KnowledgeItemView, as: KnowledgeKindE });

/** One need of a change (needs.yaml, ADR 0101), with its item's review. */
export const NeedView = z.object({
  item: z.string(),
  kind: KnowledgeKindE,
  title: z.string(),
  for: z.string(),
  why: z.string(),
  because: z
    .object({ file: z.string(), quote: z.string(), line: z.number().int().optional() })
    .optional(),
  when: z.enum(["before-design", "before-build", "before-release"]).optional(),
  from: z.enum(["assistant", "stories"]),
  leadTime: z.string().optional(),
  handledBy: z.string().optional(),
  catalogueItem: z.string().optional(),
  inputs: z.array(z.string()),
  steps: z.array(z.string()),
  rules: z.array(z.string()),
  urls: z.array(z.object({ url: z.string(), label: z.string().optional() })),
  page: z.string().optional(),
  status: z.enum(["open", "done", "not-needed"]),
  note: z.string().optional(),
  by: z.string().optional(),
  at: z.string().optional(),
  review: KnowledgeReviewSummary.optional(),
});

export const ChangeNeedsView = z.object({
  change: z.string(),
  file: z.string(),
  /** False before atticus change needs has run for the change. */
  present: z.boolean(),
  updatedAt: z.string().optional(),
  needs: z.array(NeedView),
  considered: z.array(z.object({ item: z.string(), why: z.string() })),
  command: z.string(),
  slash: z.string(),
});

/** atticus needs done|skip|reopen <change> <item> [--for t] [--note]. */
export const MarkNeedRequest = z.strictObject({
  status: z.enum(["done", "not-needed", "open"]),
  /** Required for not-needed: why. For done, the ticket (a CTASK number, say). */
  note: z.string().trim().min(1).optional(),
  /** Which target, when the item is needed for more than one. */
  for: z.string().min(1).optional(),
});

export const MarkedNeed = z.object({ need: NeedView, file: z.string() });

/** A system the org pack draft proposes for a platform profile (ADR 0101). */
export const OrgPackProposalView = z.object({
  from: z.string(),
  kind: z.string(),
  action: z.enum(["add", "update"]),
  system: z.object({
    id: z.string(),
    name: z.string(),
    boundary: z.enum(["product", "internal", "vendor"]),
    owner: z.string().optional(),
    aliases: z.array(z.string()),
    tags: z.array(z.string()),
  }),
  adds: z
    .object({ aliases: z.array(z.string()).optional(), owner: z.string().optional() })
    .optional(),
  verified: z.boolean(),
  verifiedBy: z.string().optional(),
  quote: z.string().optional(),
  page: z.string().optional(),
  notes: z.array(z.string()),
});

export const OrgPackDraftView = z.object({
  platforms: z.array(
    z.object({
      platform: z.string(),
      file: z.string(),
      /** False before atticus orgpack draft has run for the platform. */
      present: z.boolean(),
      at: z.string().optional(),
      proposals: z.array(OrgPackProposalView),
      command: z.string(),
    }),
  ),
});

export const DraftOrgPackRequest = z.strictObject({ platform: RecordId.optional() });

/** atticus orgpack accept <platform> --only id,id: the picked proposals into profile.yaml. */
export const AcceptOrgPackRequest = z.strictObject({
  only: z.array(z.string().min(1)).min(1),
});

export const AcceptedOrgPack = z.object({
  added: z.array(z.string()),
  updated: z.array(z.string()),
  left: z.number().int(),
  file: z.string(),
});

export type KnowledgeSourceListT = z.infer<typeof KnowledgeSourceList>;
export type KnowledgeSourceT = z.infer<typeof KnowledgeSource>;
export type KnowledgeItemViewT = z.infer<typeof KnowledgeItemView>;
export type KnowledgeItemListT = z.infer<typeof KnowledgeItemList>;
export type KnowledgeScanViewT = z.infer<typeof KnowledgeScanView>;
export type WikiSearchResultT = z.infer<typeof WikiSearchResult>;
export type SavedFindViewT = z.infer<typeof SavedFindView>;
export type SavedFindListT = z.infer<typeof SavedFindList>;
export type FindCandidateViewT = z.infer<typeof FindCandidateView>;
export type NeedViewT = z.infer<typeof NeedView>;
export type ChangeNeedsViewT = z.infer<typeof ChangeNeedsView>;
export type OrgPackDraftViewT = z.infer<typeof OrgPackDraftView>;
export type OrgPackProposalViewT = z.infer<typeof OrgPackProposalView>;
export type KnowledgeReviewSummaryT = z.infer<typeof KnowledgeReviewSummary>;
export type CommandOutputT = z.infer<typeof CommandOutput>;
export type AcceptedOrgPackT = z.infer<typeof AcceptedOrgPack>;
export type MarkedNeedT = z.infer<typeof MarkedNeed>;
export type ReviewedItemT = z.infer<typeof ReviewedItem>;
export type KeptCandidateT = z.infer<typeof KeptCandidate>;

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
  "/api/me": {
    get: {
      id: "getMe",
      summary:
        "Who is using the app: the metarepo's Git user (handle, name, email, and a warning when the OS user stood in), what AI may do and the digest settings (ADR 0073)",
      tag: "system",
      ok: {
        status: 200,
        schema: { type: "object", required: ["user", "source", "ai"] },
        description: "OK",
      },
    },
  },
  "/api/me/notify": {
    put: {
      id: "saveNotify",
      summary: "How often the person wants their digest and where it goes (.atticus/me.yaml)",
      tag: "system",
      body: SaveNotifyRequest,
      ok: { status: 200, schema: { type: "object" }, description: "Saved" },
      errors: [400],
    },
  },
  "/api/me/watch": {
    put: {
      id: "watchChange",
      summary:
        "Follow a change, or stop following it: the digest and the editors say how each watched change is doing (.atticus/me.yaml, never committed)",
      tag: "system",
      body: WatchRequest,
      ok: { status: 200, schema: { type: "object" }, description: "Saved" },
      errors: [400],
    },
  },
  "/api/me/digest": {
    post: {
      id: "sendDigest",
      summary:
        "What waits on the person; with send, posted through the notify adapter as their approval",
      tag: "system",
      body: SendDigestRequest,
      ok: {
        status: 200,
        schema: { type: "object", required: ["title", "body", "lines"] },
        description: "The digest, with sent or notSent",
      },
      errors: [400],
    },
  },
  "/api/across": {
    get: {
      id: "listAcross",
      summary:
        "One view across every open change: findings, tasks, stories, tests, requests or releases",
      tag: "views",
      params: [
        q("view", {
          type: "string",
          enum: ["findings", "tasks", "stories", "tests", "requests", "releases"],
        }),
      ],
      ok: {
        status: 200,
        schema: { type: "object", required: ["view", "changes", "rows"] },
        description: "OK",
      },
      errors: [400],
    },
  },
  "/api/changes/{changeId}/mappings": {
    get: {
      id: "getMappingGrid",
      summary:
        "The change's field mappings per hop, next to the catalog's FieldMapping records for the same interface",
      tag: "views",
      params: [p("changeId")],
      ok: { status: 200, schema: { type: "object", required: ["hops"] }, description: "OK" },
      errors: [404],
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
  "/api/setup": {
    get: {
      id: "getSetup",
      summary: "The setup checklist until the catalog is accepted, with a plain fix for each step",
      tag: "system",
      ok: {
        status: 200,
        schema: { type: "object", required: ["steps", "baselined"] },
        description: "OK",
      },
    },
  },
  "/api/doctor": {
    get: {
      id: "getDoctor",
      summary:
        "What this machine needs for Atticus (Node, Git, OpenSpec, proxy, TLS, disk, assistant), each with a fix; never a secret",
      tag: "system",
      params: [
        q(
          "fresh",
          { type: "string", enum: ["1"] },
          "Check again instead of the last five minutes' result",
        ),
      ],
      ok: {
        status: 200,
        schema: { type: "object", required: ["checks", "ok"] },
        description: "OK",
      },
    },
  },
  "/api/baseline": {
    post: {
      id: "acceptBaseline",
      summary:
        "Accept the as-is catalog as the baseline (catalog/baseline.yaml), as the signed-in person",
      tag: "system",
      body: BaselineRequest,
      ok: { status: 200, schema: { type: "object" }, description: "Accepted" },
      errors: [400, 403, 422],
    },
  },
  "/api/guide/{system}": {
    get: {
      id: "getGuide",
      summary: "A system's guide, generated from the catalog, with what it doesn't know yet",
      tag: "views",
      params: [p("system")],
      ok: {
        status: 200,
        schema: { type: "object", required: ["system", "markdown", "gaps"] },
        description: "OK",
      },
      errors: [400, 404],
    },
  },
  "/api/triage/{itemId}/decide": {
    post: {
      id: "decideTriage",
      summary: "Choose a triage item's option as the signed-in person; writes a curated decision",
      tag: "views",
      params: [p("itemId")],
      body: TriageDecideRequest,
      ok: { status: 200, schema: { type: "object" }, description: "Decided" },
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
  "/api/diagram/{view}/graph": {
    get: {
      id: "getDiagramGraph",
      summary: "A catalog view's groups, nodes and edges, for the app's canvas",
      tag: "views",
      params: [
        p("view", {
          schema: { type: "string", enum: ["context", "container", "data", "event"] },
        }),
        q("focus", str, "The system, for the container view"),
      ],
      ok: {
        status: 200,
        schema: {
          type: "object",
          required: ["view"],
          properties: { view: { type: "object" } },
        },
        description: "OK",
      },
      errors: [400, 422],
    },
  },
  "/api/graph/node/{id}": {
    get: {
      id: "getGraphNode",
      summary:
        "A node of the estate hierarchy with its children (one level, lazy) and its edges to siblings and outside; the root is estate (ADR 0081)",
      tag: "views",
      params: [
        p("id", { description: "estate, or <kind>:<record id>, e.g. system:ledger" }),
        q(
          "lens",
          { type: "string", enum: [...GRAPH_LENSES] },
          "Which part of the model to show (default architecture)",
        ),
        q("depth", { type: "integer", minimum: 1, maximum: 3 }, "Levels of children (default 1)"),
        q(
          "all",
          { type: "string", enum: ["1"] },
          "Every 'uses' edge, not the transitive reduction",
        ),
      ],
      ok: { status: 200, schema: "GraphNodeView", description: "OK" },
      errors: [400, 404, 422],
    },
  },
  "/api/graph/focus/{id}": {
    get: {
      id: "getGraphFocus",
      summary: "A node and its direct neighbours, with the edges between them (ADR 0081)",
      tag: "views",
      params: [p("id"), q("lens", { type: "string", enum: [...GRAPH_LENSES] }, "Default data")],
      ok: { status: 200, schema: "GraphFocusView", description: "OK" },
      errors: [400, 404, 422],
    },
  },
  "/api/graph/layout/{viewKey}": {
    get: {
      id: "getViewLayout",
      summary:
        "A view's kept arrangement (diagrams/layouts/<view-key>.yaml); saved is false when there is none",
      tag: "views",
      params: [p("viewKey", { description: "<lens>.<node>, e.g. architecture.system-ledger" })],
      ok: { status: 200, schema: "ViewLayoutResult", description: "OK" },
      errors: [400, 422],
    },
    put: {
      id: "putViewLayout",
      summary:
        "Keep this arrangement: writes diagrams/layouts/<view-key>.yaml in the metarepo, as the signed-in person",
      tag: "views",
      params: [p("viewKey")],
      body: PutLayoutRequest,
      ok: { status: 200, schema: "ViewLayoutResult", description: "Kept" },
      errors: [400],
    },
  },
  "/api/ask": {
    get: {
      id: "ask",
      summary:
        "Answer a plain-language question from the catalog; the query used is always returned",
      tag: "catalog",
      params: [q("q", str, "The question, e.g. who calls ledger-api?")],
      ok: {
        status: 200,
        schema: { type: "object", required: ["question", "action", "query", "explanation"] },
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
  "/api/incident/{id}": {
    get: {
      id: "getIncident",
      summary:
        "Incident mode: a failing record's blast radius, the owners to call, what watches it and recent nearby changes (read-only, from the last scan)",
      tag: "catalog",
      params: [p("id")],
      ok: {
        status: 200,
        schema: { type: "object", required: ["id", "affected", "call", "recentChanges"] },
        description: "OK",
      },
      errors: [404],
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
  "/api/repos/branches": {
    get: {
      id: "listRepoBranches",
      summary:
        "Each repo's default branch (the manifest's and the remote's), its named branches, the commit the baseline was read from, and its branches scanned beside it (ADR 0123)",
      tag: "workspace",
      ok: { status: 200, schema: "RepoBranchesList", description: "OK" },
    },
  },
  "/api/repos/compare": {
    get: {
      id: "compareBranch",
      summary:
        "What a branch scanned beside the baseline changes against it, for the repos it read: records added, removed and changed (ADR 0123)",
      tag: "workspace",
      params: [{ ...q("branch"), required: true }],
      ok: { status: 200, schema: "BranchCompare", description: "OK" },
      errors: [400, 404],
    },
  },
  "/api/repos/{repoId}/branches": {
    put: {
      id: "editRepoBranches",
      summary:
        "Set a repo's default branch and named branches in its manifest, keeping the rest of the file and its comments; commit it in a pull request (ADR 0123)",
      tag: "workspace",
      params: [p("repoId")],
      body: EditRepoBranchesRequest,
      ok: { status: 200, schema: { type: "object" }, description: "Written" },
      errors: [400, 404],
    },
  },
  "/api/repos/{repoId}/description": {
    put: {
      id: "editRepoDescription",
      summary:
        "Say what a repo is in one line, confirm the draft your assistant wrote, or drop it; written to the manifest, which you commit in a pull request (ADR 0128)",
      tag: "workspace",
      params: [p("repoId")],
      body: EditRepoDescriptionRequest,
      ok: { status: 200, schema: { type: "object" }, description: "Written" },
      errors: [400, 404],
    },
  },
  "/api/specs": {
    get: {
      id: "listSpecs",
      summary: "The repos with a spec, and how many flows each has (ADR 0092)",
      tag: "views",
      ok: { status: 200, schema: "SpecList", description: "OK" },
    },
  },
  "/api/specs/{repo}": {
    get: {
      id: "getSpec",
      summary: "A repo's flows: what starts each, its steps and how many are confirmed (ADR 0092)",
      tag: "views",
      params: [p("repo")],
      ok: { status: 200, schema: "SpecView", description: "OK" },
      errors: [400, 404],
    },
  },
  "/api/specs/{repo}/flows/{flowId}": {
    get: {
      id: "getFlow",
      summary:
        "One flow, with the flows its call-outs start and the flows that call it, from specs/estate.yaml (ADR 0092)",
      tag: "views",
      params: [p("repo"), p("flowId")],
      ok: { status: 200, schema: "FlowView", description: "OK" },
      errors: [400, 404],
    },
  },
  "/api/changes/{changeId}/target-flows": {
    get: {
      id: "listTargetFlows",
      summary:
        "The change's target flows: each flow it adds, changes or removes, with counts (ADR 0095)",
      tag: "changes",
      params: [p("changeId")],
      ok: { status: 200, schema: "TargetFlowList", description: "OK" },
      errors: [400, 404],
    },
  },
  "/api/changes/{changeId}/inputs": {
    get: {
      id: "listChangeInputs",
      summary:
        "The files attached to a change: what each is, who attached it and when, and how it is cited (ADR 0113)",
      tag: "changes",
      params: [p("changeId")],
      ok: { status: 200, schema: "ChangeInputList", description: "OK" },
      errors: [400, 404],
    },
    post: {
      id: "attachChangeInput",
      summary:
        "Attach a file to a change (its bytes in base64): copied into its inputs/, read and cited by its steps, as data (ADR 0113)",
      tag: "changes",
      params: [p("changeId")],
      body: AttachFileRequest,
      ok: { status: 201, schema: "AttachResult", description: "Attached, or refused with why" },
      errors: [400, 404, 413, 422],
    },
  },
  "/api/changes/{changeId}/prototypes": {
    get: {
      id: "listChangePrototypes",
      summary:
        "The prototypes attached to a change, each compared again with the estate: every call its UI makes to its BFF and its BFF makes to a mock, as exists, changes, new or vendor, cited (ADR 0133)",
      tag: "changes",
      params: [p("changeId")],
      ok: { status: 200, schema: "ChangePrototypeList", description: "OK" },
      errors: [400, 404],
    },
  },
  "/api/questions/{id}/targets": {
    get: {
      id: "getQuestionTargets",
      summary:
        "The Another repo… picker of a targets question: every repo of the manifest (read or not), every system of the profiles and every team in roles.yaml",
      tag: "questions",
      params: [p("id")],
      ok: { status: 200, schema: "TargetPickList", description: "OK" },
      errors: [404, 422],
    },
  },
  "/api/questions/{id}/evidence": {
    get: {
      id: "getQuestionEvidence",
      summary:
        "The lines around each line a question cites, from the repo's base clone or the metarepo, so a person answers looking at the code",
      tag: "questions",
      params: [p("id")],
      ok: { status: 200, schema: "QuestionEvidenceList", description: "OK" },
      errors: [404],
    },
  },
  "/api/past-changes": {
    get: {
      id: "listPastChanges",
      summary:
        "The archived changes nearest a new change's title or brief, by meaning where the embedding model is on and by words where it isn't, to start from one (WP7.6)",
      tag: "changes",
      params: [q("text"), q("change"), q("limit", { type: "integer" })],
      ok: { status: 200, schema: "SimilarChanges", description: "OK" },
      errors: [400, 404],
    },
  },
  "/api/changes/{changeId}/like": {
    post: {
      id: "attachPastChange",
      summary:
        "Attach an archived change to a change as an example its steps read, as data (WP7.6)",
      tag: "changes",
      params: [p("changeId")],
      body: AttachPastChangeRequest,
      ok: { status: 201, schema: "AttachPastChangeResult", description: "Attached" },
      errors: [400, 404, 422],
    },
  },
  "/api/changes/{changeId}/cockpit": {
    get: {
      id: "getChangeCockpit",
      summary:
        "One change at a glance: where it is, the next step with its slash command, what blocks it, each stage's progress, the risk, and each repo's change branch and base",
      tag: "changes",
      params: [p("changeId")],
      ok: { status: 200, schema: "ChangeCockpit", description: "OK" },
      errors: [400, 404],
    },
  },
  "/api/changes/{changeId}/inputs/{name}/promote": {
    post: {
      id: "promoteChangeInput",
      summary:
        "Copy a file attached to a change into general knowledge (inputs/inbox/); the change keeps its copy (ADR 0122)",
      tag: "changes",
      params: [p("changeId"), p("name")],
      ok: { status: 200, schema: "PromoteResult", description: "Copied" },
      errors: [400, 404, 422],
    },
  },
  "/api/changes/{changeId}/map": {
    get: {
      id: "getChangeMap",
      summary:
        "The change's picture: the components, entries and tables its target flows touch, marked new, modify or retire (ADR 0108)",
      tag: "changes",
      params: [p("changeId")],
      ok: { status: 200, schema: "ChangeMap", description: "OK" },
      errors: [400, 404],
    },
  },
  "/api/changes/{changeId}/impact": {
    get: {
      id: "getChangeImpact",
      summary:
        "The change's impact, as designed: who each entry or table it breaks is called or used by, the fields that stop crossing and the gateway routes to update, each with its owner; a guessed link may break (ADR 0144)",
      tag: "changes",
      params: [p("changeId")],
      ok: { status: 200, schema: "ChangeImpact", description: "OK" },
      errors: [400, 404],
    },
  },
  "/api/changes/{changeId}/estimate": {
    get: {
      id: "getChangeEstimate",
      summary:
        "The change's estimate: its size from the target flows, the org pack's ranges summed, the drivers with their sources (ADR 0109)",
      tag: "changes",
      params: [p("changeId")],
      ok: { status: 200, schema: "ChangeEstimate", description: "OK" },
      errors: [400, 404],
    },
  },
  "/api/changes/{changeId}/conformance": {
    get: {
      id: "getChangeConformance",
      summary:
        "Does the code do what the design says: the newest check of each repo's branch against the change's target flows, with what is missing, still there or unexpected and where (ADR 0114)",
      tag: "changes",
      params: [p("changeId")],
      ok: { status: 200, schema: "ChangeConformance", description: "OK" },
      errors: [400, 404],
    },
  },
  "/api/changes/{changeId}/target-flows/{flowId}": {
    get: {
      id: "getTargetFlow",
      summary:
        "One target flow beside today's: each step marked same, changed, added or removed (ADR 0095)",
      tag: "changes",
      params: [p("changeId"), p("flowId")],
      ok: { status: 200, schema: "TargetFlowView", description: "OK" },
      errors: [400, 404],
    },
  },
  "/api/cites": {
    get: {
      id: "getCites",
      summary:
        "Each line of one file that a spec flow or a catalog record cites, with what cites it (ADR 0094)",
      tag: "views",
      params: [
        q("repo", str, "The code's repo, as citations name it"),
        q("path", str, "The file's path in that repo, as citations name it"),
      ],
      ok: { status: 200, schema: "CiteList", description: "OK" },
      errors: [400],
    },
  },
  "/api/onboarding": {
    get: {
      id: "getOnboarding",
      summary:
        "Each manifest repo with its clone, scan settings and last scan's counts, and the knowledge sources (ADR 0084)",
      tag: "workspace",
      ok: { status: 200, schema: "OnboardingView", description: "OK" },
    },
  },
  "/api/trust": {
    get: {
      id: "getTrust",
      summary:
        "How far to trust each repo's map: its facts, the verifier's report (kept, rejected, coverage, unknown files), the facts' commit against the checkout's, and whether its catalog records come from the facts or the readers (ADR 0124)",
      tag: "workspace",
      ok: { status: 200, schema: "TrustView", description: "OK" },
    },
  },
  "/api/trust/fresh": {
    get: {
      id: "getTrustFresh",
      summary:
        "Which repos' clones have moved past their facts' commit, most stale first: per repo the facts' commit and the clone's, the files changed that the facts cite, the facts to read again and carried, and the command to run; local git only (ADR 0141)",
      tag: "workspace",
      ok: { status: 200, schema: "FreshView", description: "OK" },
    },
  },
  "/api/facts/{repo}": {
    get: {
      id: "getRepoFacts",
      summary:
        "A repo's facts as the Map cites them: each with its line and quote, who made and checked it, the fields a person may correct and any correction on file; the open questions about the repo (ADR 0124)",
      tag: "workspace",
      params: [p("repo")],
      ok: { status: 200, schema: "RepoFactsView", description: "OK" },
      errors: [400],
    },
  },
  "/api/facts/{repo}/corrections": {
    post: {
      id: "correctFact",
      summary:
        "Mark a fact wrong or correct its claim: a line in facts/<repo>.corrections.jsonl, which atticus verify applies every time it runs. Returns the git command that commits the file and the verify command",
      tag: "workspace",
      params: [p("repo")],
      body: FactCorrectionRequest,
      ok: { status: 200, schema: "FactCorrectionResult", description: "Recorded" },
      errors: [400, 404, 422],
    },
  },
  "/api/facts/{repo}/preview": {
    get: {
      id: "previewVerifyWrite",
      summary:
        "After a correction: the commands to run (atticus verify <repo> --write, then the git steps with the exact files) and what that write will change in the facts and the catalog (links moved, added, removed; facts dropped or edited), computed in-process without writing (ADR 0149)",
      tag: "workspace",
      params: [p("repo"), q("fact", str, "The fact corrected, for the branch and commit message")],
      ok: { status: 200, schema: "VerifyPreviewView", description: "OK" },
      errors: [400, 404],
    },
  },
  "/api/facts/{repo}/audit": {
    get: {
      id: "drawAudit",
      summary:
        "A repo's sample audit drawn as atticus verify audit draws it (the same seed, the same sample): each item with its cited lines and any answer on file, and the precision so far. Writes nothing (ADR 0149)",
      tag: "workspace",
      params: [
        p("repo"),
        q("seed", str, "The seed; default <repo>@<commit>"),
        q("size", { type: "integer" }, "How many facts and how many links; default 10"),
      ],
      ok: { status: 200, schema: "AuditSampleView", description: "OK" },
      errors: [400],
    },
    post: {
      id: "answerAudit",
      summary:
        "Answer items of a draw right, wrong or unsure (with a note): written to facts/<repo>.audit.yaml by the same functions as atticus verify audit. Returns the precision and the git command (ADR 0149)",
      tag: "workspace",
      params: [p("repo")],
      body: AuditAnswerRequest,
      ok: { status: 200, schema: "AuditAnswerResult", description: "Recorded" },
      errors: [400, 404, 422],
    },
  },
  "/api/contracts": {
    get: {
      id: "getContracts",
      summary:
        "The contract check on every link: the payload on both sides of each REST call, gateway hop, topic and call to an outside system, compared from the field facts and the specs on file; each mismatch and unconfirmed difference with both lines (ADR 0164)",
      tag: "views",
      ok: { status: 200, schema: "ContractsView", description: "OK" },
    },
  },
  "/api/outside": {
    get: {
      id: "getOutsideSystems",
      summary:
        "The systems outside the estate (vendors and other teams): who calls each, the operations its intaken spec publishes, the calls that match nothing in it, its open questions, and how to add a spec (ADR 0149)",
      tag: "views",
      ok: { status: 200, schema: "OutsideView", description: "OK" },
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
  "/api/changes/{changeId}/critic": {
    post: {
      id: "runCritic",
      summary:
        "Run the critic: rule checks, and AI lenses handed to the assistant unless AI is off",
      tag: "findings",
      params: [p("changeId")],
      body: RunCriticRequest,
      ok: { status: 200, schema: { type: "object", required: ["ai", "round"] }, description: "OK" },
      errors: [400, 404, 422],
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
  "/api/runs": {
    get: {
      id: "listModelRuns",
      summary:
        "Every model run, newest first: its step, round, state and whether it was answered (ADR 0106)",
      tag: "ai",
      params: [
        q("change", str, "Only the runs of this change or step"),
        q("limit", { type: "integer", minimum: 1 }, "At most this many (default 200)"),
      ],
      ok: { status: 200, schema: "RunList", description: "OK" },
      errors: [400],
    },
    post: {
      id: "startStep",
      summary:
        "Start an AI step on the server with runtime.yaml's model, as a job (ADR 0106); 409 when no model is configured",
      tag: "ai",
      body: StartStepRequest,
      ok: {
        status: 202,
        schema: { type: "object", required: ["jobId", "model"] },
        description: "Started",
      },
      errors: [400, 409],
    },
  },
  "/api/runs/{runId}/transcript": {
    get: {
      id: "getRunTranscript",
      summary: "What a run was asked and answered, and the problems handed back to it (ADR 0106)",
      tag: "ai",
      params: [p("runId")],
      ok: { status: 200, schema: "RunTranscript", description: "OK" },
      errors: [404],
    },
  },
  "/api/history": {
    get: {
      id: "listPromptHistory",
      summary:
        "The prompts people sent their assistant and the responses they got, as turns, newest first, and whether recording is on (ADR 0110)",
      tag: "ai",
      params: [
        q("change", str, "Only the turns about this change"),
        q("session", str, "Only this session's turns"),
        q("q", str, "Only the turns whose text, command, change or session has every word"),
        q("limit", { type: "integer", minimum: 1 }, "At most this many turns (default 200)"),
      ],
      ok: { status: 200, schema: "HistoryList", description: "OK" },
      errors: [400],
    },
  },
  "/api/history/{historyId}": {
    get: {
      id: "getPromptHistoryRecord",
      summary: "One prompt or response, and its pair (ADR 0110)",
      tag: "ai",
      params: [p("historyId")],
      ok: { status: 200, schema: "HistoryEntry", description: "OK" },
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
      summary: "Org-pack conformance, rule layers, waivers and override rates",
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
  // ADR 0121: the AI tab.
  "/api/settings/ai": {
    get: {
      id: "getAiSettings",
      summary:
        "How AI runs here: one line for what runs a step, on or off, the modes, the assistants by name, the providers and their settings, the configured model, and whether its key variable is set (by name)",
      tag: "run",
      ok: { status: 200, schema: { type: "object" }, description: "OK" },
    },
    put: {
      id: "putAiSettings",
      summary:
        "Write the AI settings to runtime.yaml: checked against the Runtime schema, keeping what it doesn't change; refuses anything that looks like a key",
      tag: "run",
      body: z.record(z.string(), z.unknown()),
      ok: { status: 200, schema: { type: "object" }, description: "OK" },
      errors: [422],
    },
  },
  "/api/settings/ai/test": {
    post: {
      id: "testAiProvider",
      summary:
        "Ask the configured model provider one short question with nothing of the estate in it, and say whether it answered",
      tag: "run",
      ok: { status: 200, schema: { type: "object" }, description: "OK" },
      errors: [409],
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
  "/api/release/{changeId}/plan": {
    get: {
      id: "getDeploymentPlan",
      summary:
        "The deployment plan: deploy order across repos with why, rollback, request waits, release sections and the forecast",
      tag: "release",
      params: [p("changeId")],
      ok: { status: 200, schema: { type: "object" }, description: "OK" },
      errors: [404, 422],
    },
  },
  "/api/release/{changeId}/forecast": {
    get: {
      id: "getReleaseForecast",
      summary:
        "Forecast ready-to-release day from lead times and the initiative's plan, with the target",
      tag: "release",
      params: [p("changeId")],
      ok: { status: 200, schema: { type: "object" }, description: "OK" },
      errors: [404, 422],
    },
  },
  "/api/release/{changeId}/evidence": {
    get: {
      id: "getEvidencePack",
      summary: "The evidence pack as one Markdown document, and every file with its sha-256",
      tag: "release",
      params: [p("changeId")],
      ok: {
        status: 200,
        schema: {
          type: "object",
          required: ["markdown", "files"],
          properties: {
            markdown: str,
            files: {
              type: "array",
              items: {
                type: "object",
                properties: { path: str, sha256: str, bytes: { type: "integer" } },
              },
            },
          },
        },
        description: "OK",
      },
      errors: [404, 422],
    },
  },
  "/api/release/{changeId}/notes": {
    get: {
      id: "getReleaseNotes",
      summary: "Release notes for business or technical readers, generated without AI",
      tag: "release",
      params: [p("changeId"), q("audience", { type: "string", enum: ["business", "technical"] })],
      ok: {
        status: 200,
        schema: { type: "object", properties: { markdown: str } },
        description: "OK",
      },
      errors: [400, 404, 422],
    },
  },
  "/api/release/{changeId}/security": {
    get: {
      id: "getSecurityReview",
      summary:
        "Security review draft: auth, classifications, data crossing boundaries, vendors, secrets, findings and sign-off",
      tag: "release",
      params: [p("changeId")],
      ok: {
        status: 200,
        schema: { type: "object", properties: { markdown: str } },
        description: "OK",
      },
      errors: [404, 422],
    },
  },
  "/api/release/{changeId}/outcomes": {
    post: {
      id: "recordOutcome",
      summary: "Record a measured outcome of a released change, as the signed-in person",
      tag: "release",
      params: [p("changeId")],
      body: RecordOutcomeRequest,
      ok: { status: 200, schema: { type: "object" }, description: "Recorded" },
      errors: [400, 404, 422],
    },
  },
  "/api/outcomes": {
    get: {
      id: "listOutcomes",
      summary: "The brief's success measures per change and the values recorded after release",
      tag: "release",
      params: [q("change")],
      ok: { status: 200, schema: {}, description: "OK" },
      errors: [404, 422],
    },
  },
  "/api/questions": {
    get: {
      id: "listQuestions",
      summary:
        "The questions to people in questions/ (ADR 0078), in the order to ask them (ADR 0140): what a change in flight rests on first, then the answers that join the most calls",
      tag: "questions",
      params: [
        q(
          "state",
          { type: "string", enum: ["open", "answered", "retired"] },
          "Only questions in this state",
        ),
        q(
          "mine",
          { type: "string", enum: ["true"] },
          "Only the questions of the teams the person is on (roles.yaml, ADR 0140)",
        ),
      ],
      ok: { status: 200, schema: "QuestionList", description: "OK" },
      errors: [400],
    },
  },
  "/api/questions/{id}": {
    get: {
      id: "getQuestion",
      summary: "One question: its options, evidence, proposed scope and answer",
      tag: "questions",
      params: [p("id")],
      ok: { status: 200, schema: "Question", description: "OK" },
      errors: [404],
    },
  },
  "/api/questions/{id}/answer": {
    post: {
      id: "answerQuestion",
      summary:
        "Write the signed-in person's answer to questions/<id>.yaml (and a repo type's skill file); returns the command to run next",
      tag: "questions",
      params: [p("id")],
      body: AnswerQuestionRequest,
      ok: { status: 200, schema: "AnsweredQuestion", description: "Answered" },
      errors: [400, 404, 422],
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
  // ADR 0102: knowledge managed in the metarepo (ADR 0101), in the app.
  "/api/knowledge/sources": {
    get: {
      id: "listKnowledgeSources",
      summary:
        "The wikis in sources.yaml with their tags, owner, git ref, path and checkout, and each one's newest snapshot",
      tag: "knowledge",
      ok: { status: 200, schema: "KnowledgeSourceList", description: "OK" },
    },
    post: {
      id: "addKnowledgeSource",
      summary:
        "atticus sources add: check a wiki and write its entry into sources.yaml (save), or return the entry to add",
      tag: "knowledge",
      body: AddSourceRequest,
      ok: { status: 200, schema: "CommandOutput", description: "Added, or the entry to add" },
      errors: [400, 422],
    },
  },
  "/api/knowledge/sources/{sourceId}/sync": {
    post: {
      id: "syncKnowledgeSource",
      summary:
        "atticus sources sync --source: read one wiki (a git wiki is cloned or fetched) into a dated snapshot",
      tag: "knowledge",
      params: [p("sourceId")],
      ok: { status: 200, schema: "CommandOutput", description: "Synced; code 1 has problems" },
      errors: [400, 404, 422],
    },
  },
  "/api/knowledge/scan": {
    get: {
      id: "getKnowledgeScan",
      summary:
        "What the last knowledge scan read and changed (scan.yaml), and the reviews to check again",
      tag: "knowledge",
      ok: { status: 200, schema: "KnowledgeScanView", description: "OK" },
    },
  },
  "/api/knowledge/documents": {
    get: {
      id: "listDocuments",
      summary:
        "The files in the metarepo's inputs/: what each is, the systems it names, whether the knowledge source read it (or why not), and the items that quote it (ADR 0122)",
      tag: "knowledge",
      ok: { status: 200, schema: "DocumentList", description: "OK" },
    },
    post: {
      id: "addDocument",
      summary:
        "Add a file to general knowledge (its bytes in base64): copied into inputs/inbox/ as it is; the same bytes already in inputs/ are refused (ADR 0122)",
      tag: "knowledge",
      body: AttachFileRequest,
      ok: { status: 201, schema: "AddDocumentResult", description: "Added, or refused with why" },
      errors: [400, 413, 422],
    },
  },
  "/api/knowledge/items": {
    get: {
      id: "listKnowledgeItems",
      summary:
        "The knowledge items as people reviewed them, rejected ones included and marked, with the fields each may have corrected",
      tag: "knowledge",
      params: [
        q("kind", { type: "string", enum: [...KNOWLEDGE_KINDS] }, "Only items of this kind"),
        q("tag", str, "Only items with this tag (a source kind, a framework or a page tag)"),
      ],
      ok: { status: 200, schema: "KnowledgeItemList", description: "OK" },
      errors: [400],
    },
  },
  "/api/knowledge/items/{itemId}/review": {
    post: {
      id: "reviewKnowledgeItem",
      summary:
        "Verify, correct or reject a knowledge item as the signed-in person: writes knowledge/reviews/<id>.yaml",
      tag: "knowledge",
      params: [p("itemId")],
      body: ReviewItemRequest,
      ok: { status: 200, schema: "ReviewedItem", description: "Reviewed" },
      errors: [400, 404, 422],
    },
  },
  "/api/knowledge/search": {
    get: {
      id: "searchWikis",
      summary:
        "The plain search of every snapshot page for a term or phrase (no AI), with the AI step to copy",
      tag: "knowledge",
      params: [q("q", str, "The term or phrase"), q("source", str, "Only this source's snapshot")],
      ok: { status: 200, schema: "WikiSearchResult", description: "OK" },
      errors: [400, 404],
    },
  },
  "/api/knowledge/finds": {
    get: {
      id: "listFinds",
      summary: "The saved searches of the wikis (knowledge/finds), newest first, with candidates",
      tag: "knowledge",
      ok: { status: 200, schema: "SavedFindList", description: "OK" },
    },
  },
  "/api/knowledge/finds/{slug}": {
    get: {
      id: "getFind",
      summary: "One saved search: the pages it matched and its candidates, new or already known",
      tag: "knowledge",
      params: [p("slug")],
      ok: { status: 200, schema: "SavedFindView", description: "OK" },
      errors: [400, 404],
    },
  },
  "/api/knowledge/finds/{slug}/keep": {
    post: {
      id: "keepFound",
      summary:
        "Keep a candidate as a knowledge item of the kind chosen, verified (or corrected) by the signed-in person",
      tag: "knowledge",
      params: [p("slug")],
      body: KeepCandidateRequest,
      ok: { status: 200, schema: "KeptCandidate", description: "Kept" },
      errors: [400, 404, 422],
    },
  },
  "/api/changes/{changeId}/needs": {
    get: {
      id: "getChangeNeeds",
      summary:
        "What the change needs from the organisation (needs.yaml), each with its item's review, or the step to find them",
      tag: "changes",
      params: [p("changeId")],
      ok: { status: 200, schema: "ChangeNeedsView", description: "OK" },
      errors: [400, 404],
    },
  },
  "/api/changes/{changeId}/needs/{itemId}": {
    post: {
      id: "markChangeNeed",
      summary:
        "Mark a need done (with a note), not needed (with why) or open again, as the signed-in person",
      tag: "changes",
      params: [p("changeId"), p("itemId")],
      body: MarkNeedRequest,
      ok: { status: 200, schema: "MarkedNeed", description: "Marked" },
      errors: [400, 404, 422],
    },
  },
  "/api/changes/{changeId}/stages/{stage}": {
    get: {
      id: "getStageReview",
      summary:
        "A stage tab's critic findings (the latest round of its gate) with their options and comments, the stage's questions, and the command to run next (ADR 0087, ADR 0124)",
      tag: "changes",
      params: [p("changeId"), p("stage", { schema: { type: "string", enum: [...STAGE_TABS] } })],
      ok: { status: 200, schema: "StageReviewView", description: "OK" },
      errors: [400, 404],
    },
  },
  "/api/changes/{changeId}/stages/{stage}/comments": {
    post: {
      id: "commentOnFinding",
      summary:
        "A person's comment on a finding: written as a question they answered (questions/), listed in the stage's loop file, so the stage's next run hands it to the drafter. Returns the git command and the stage's command",
      tag: "changes",
      params: [p("changeId"), p("stage", { schema: { type: "string", enum: [...STAGE_TABS] } })],
      body: StageCommentRequest,
      ok: { status: 200, schema: "StageCommentResult", description: "Written" },
      errors: [400, 404, 409, 422],
    },
  },
  "/api/changes/{changeId}/knowledge": {
    get: {
      id: "getChangeKnowledge",
      summary:
        "The org knowledge that applies to the change (knowledge.yaml): each item with why its stages picked it and a person's status, and the near-misses (ADR 0124)",
      tag: "changes",
      params: [p("changeId")],
      ok: { status: 200, schema: "ChangeKnowledgeView", description: "OK" },
      errors: [400, 404, 422],
    },
  },
  "/api/changes/{changeId}/knowledge/{itemId}": {
    post: {
      id: "setChangeKnowledge",
      summary:
        "Confirm or exclude an item (or a near-miss) in the change's knowledge.yaml; an excluded item stays out of every later stage. Returns the git command that commits the file",
      tag: "changes",
      params: [p("changeId"), p("itemId")],
      body: SetChangeKnowledgeRequest,
      ok: { status: 200, schema: "SetChangeKnowledgeResult", description: "Set" },
      errors: [400, 404, 422],
    },
  },
  "/api/orgpack/draft": {
    get: {
      id: "getOrgPackDraft",
      summary:
        "The org pack drafted from the wikis: each platform's proposed systems (proposals/orgpack), verified or not",
      tag: "orgpack",
      ok: { status: 200, schema: "OrgPackDraftView", description: "OK" },
    },
    post: {
      id: "draftOrgPack",
      summary: "atticus orgpack draft: draft a platform profile's systems from the knowledge items",
      tag: "orgpack",
      body: DraftOrgPackRequest,
      ok: { status: 200, schema: "OrgPackDraftView", description: "Drafted" },
      errors: [400, 422],
    },
  },
  "/api/orgpack/draft/{platform}/accept": {
    post: {
      id: "acceptOrgPackDraft",
      summary:
        "atticus orgpack accept --only: put the picked systems into profile.yaml; what is taken leaves the draft",
      tag: "orgpack",
      params: [p("platform")],
      body: AcceptOrgPackRequest,
      ok: { status: 200, schema: "AcceptedOrgPack", description: "Accepted" },
      errors: [400, 404, 422],
    },
  },
};

const ERROR_TEXT: Record<number, string> = {
  400: "The request is invalid",
  401: "Missing or wrong session token",
  403: "You can't do this; the problem says who can",
  404: "Not found",
  409: "Conflict: the file changed since you read it, or the state doesn't allow this",
  413: "Too large: the upload is over the limit the problem names",
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
    HierNode,
    HierEdge,
    HierJoin,
    GraphNodeView,
    GraphFocusView,
    ViewLayoutResult,
    Impact,
    Coverage,
    Job,
    JobAccepted,
    ChangeSummary,
    ChangeDetail,
    ArtifactContent,
    Task,
    RunView,
    RunList,
    RunTranscript,
    HistoryList,
    HistoryEntry,
    RepoView,
    OnboardingView,
    SpecList,
    SpecView,
    FlowView,
    CiteList,
    TargetFlowList,
    TargetFlowView,
    ChangeMap,
    ChangeEstimate,
    ChangeImpact,
    ChangeInput,
    ChangeInputList,
    AttachResult,
    ChangePrototypeList,
    DocumentList,
    AddDocumentResult,
    RepoBranchesList,
    BranchCompare,
    ChangeCockpit,
    SimilarChanges,
    AttachPastChangeResult,
    QuestionEvidenceList,
    TargetPickList,
    PromoteResult,
    ChangeConformance,
    OrgPackView,
    Health,
    Finding,
    ChangeRepos,
    LiveEvent,
    Question,
    QuestionList,
    AnsweredQuestion,
    KnowledgeSourceList,
    CommandOutput,
    KnowledgeScanView,
    KnowledgeItemList,
    ReviewedItem,
    WikiSearchResult,
    SavedFindList,
    SavedFindView,
    KeptCandidate,
    ChangeNeedsView,
    MarkedNeed,
    TrustView,
    FreshView,
    ChangeKnowledgeView,
    KnowledgeConflictView,
    SetChangeKnowledgeResult,
    RepoFactsView,
    FactCorrectionResult,
    VerifyPreviewView,
    AuditSampleView,
    AuditAnswerResult,
    OutsideView,
    ContractsView,
    StageReviewView,
    StageCommentResult,
    OrgPackDraftView,
    AcceptedOrgPack,
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
      "questions",
      "knowledge",
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
