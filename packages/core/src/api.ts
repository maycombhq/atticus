import { z } from "zod";
import { RunState, RunSummary, RuntimeKind } from "./schema/ai.js";
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
import { ChangeArtifact, Phase } from "./schema/orgpack.js";
import { Finding, FindingAction, Lens, Severity } from "./schema/review.js";
import { Question, QuestionScopeLevel } from "./schema/question.js";
import { ChangeRepos, ManifestRepo } from "./schema/workspace.js";

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
 */
export const API_VERSION = "2.10.0";
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
export const OnboardingRepo = z.object({
  id: RecordId,
  platform: RecordId,
  type: RecordId,
  owner: RecordId,
  /** The manifest file that lists it, relative to the metarepo. */
  manifest: z.string(),
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
});

/** ADR 0078: answer a question with one of its options or in the person's own words. */
export const AnswerQuestionRequest = z.strictObject({
  option: z.number().int().min(1).optional(),
  text: z.string().trim().min(1).optional(),
  /** The scope the person confirms; default the one proposed. */
  scope: QuestionScopeLevel.optional(),
  /** The repo type, when a repo question is widened to its type. */
  repoType: RecordId.optional(),
});

/** ADR 0078: the answered question, the command to run next and, for a repo type, its skill file. */
export const AnsweredQuestion = z.object({
  question: Question,
  rerun: z.string(),
  skill: z.object({ path: z.string(), written: z.boolean() }).optional(),
});

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
      summary: "The questions to people in questions/ (ADR 0078), oldest first",
      tag: "questions",
      params: [
        q(
          "state",
          { type: "string", enum: ["open", "answered", "retired"] },
          "Only questions in this state",
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
