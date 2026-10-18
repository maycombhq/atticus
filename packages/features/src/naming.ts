import { parse } from "yaml";
import { z } from "zod";
import {
  AgentDefinition,
  toCanonicalYaml,
  type CatalogRecord,
  type OrgPack,
  type RunSummary,
} from "@maycombhq/core";
import { buildContextPack, toRunSummary, type AiRuntime, type SourceInput } from "@maycombhq/ai";
import type { Capability, FeatureNameProposal } from "./detect.js";
import { FlowGraph } from "./graph.js";

/**
 * Naming with AI, outside the scan (ADR 0031): the `feature-namer` agent proposes a name, a
 * one-paragraph description and tags for each detected feature from its evidence. Atticus's
 * instructions are trusted; the features' evidence is wrapped as data. A proposal must cite
 * record ids from the feature it names; one that cites none of them is discarded. Proposals
 * stay `inferred` until a person confirms them (`atticus feature name`).
 */

export const FEATURE_NAMER = "feature-namer";

/** The org pack's `feature-namer` agent, or the built-in default. */
export function featureNamerAgent(orgPack?: Pick<OrgPack, "agents" | "runtime">): AgentDefinition {
  const own = orgPack?.agents.find((a) => a.id === FEATURE_NAMER);
  if (own) return own;
  return AgentDefinition.parse({
    schemaVersion: 1,
    id: FEATURE_NAMER,
    role: "architect",
    description:
      "Proposes a name, a one-paragraph description and tags for each feature Atticus found in code, from its evidence only.",
    inputs: ["catalog-slice"],
    // C5 has no output kind for catalog proposals; a feature name seeds a capability spec.
    outputArtifact: "specs",
    tokenBudget: orgPack?.runtime.budgets.defaultTokens ?? 150_000,
    allowedRuntimes: ["hand-off", "model", "headless-claude-code", "mock", "replay"],
  });
}

const INSTRUCTIONS = `# Feature namer

You name features Atticus found in an estate's code. Each feature below is a data block: its id, the provisional name Atticus derived from path segments and class names, where it starts (entry points) and what its flows reach. For each feature propose:

- name: two to five words a product owner would use, in sentence case;
- description: one paragraph, what the feature does for its users, only from the evidence;
- tags: up to five lower-case words for the business area;
- evidence: the record ids from that feature's block your proposal relies on.

Use only what the blocks show. Don't invent systems, users or behaviour. A proposal that cites no record id from its feature is discarded.

Write YAML and nothing else:

features:
  - id: <feature id>
    name: <name>
    description: <one paragraph>
    tags: [<tag>, ...]
    evidence: [<record id>, ...]`;

const Proposal = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).optional(),
  tags: z.array(z.coerce.string()).default([]),
  evidence: z.array(z.coerce.string()).default([]),
});

export interface NamingRun {
  agent: string;
  features: string[];
  state: "ran" | "failed";
  reason?: string;
  promptSha256?: string;
  summary?: RunSummary;
}

export interface NameFeaturesOptions {
  orgPack?: Pick<OrgPack, "agents" | "runtime" | "pack">;
  /** Features per run (one context pack each). Default 20. */
  batchSize?: number;
  /** Highest classification sent. Default: internal. */
  maxClassification?: string;
  now?: Date;
}

export interface NameFeaturesResult {
  proposals: FeatureNameProposal[];
  discarded: { feature?: string; reason: string }[];
  runs: NamingRun[];
}

const what = (g: FlowGraph, id: string): string => {
  const e = g.endpoints.get(id);
  if (e)
    return e.endpointType === "event-topic"
      ? `topic ${e.pathOrTopic}, published by ${e.component}`
      : `${e.method ? `${e.method} ` : ""}${e.pathOrTopic} on ${e.component}`;
  const i = g.interfaces.get(id);
  if (i)
    return i.sync === "async"
      ? `event ${i.normalizedPath} from ${i.from} to ${i.to}`
      : `${i.from} calls ${i.to}${i.method ? ` ${i.method}` : ""} ${i.normalizedPath}`;
  const s = g.settings.get(id);
  if (s) return `schedule ${s.key} = ${s.valueOrRef} on ${s.component}`;
  const c = g.components.get(id);
  if (c) return `${c.type} component ${c.id} (system ${c.system})`;
  const r = g.records.get(id);
  return r ? `${r.kind} ${r.id}` : id;
};

/** The data block for one feature: only facts from the catalog, with where they were read. */
function block(f: Capability, g: FlowGraph): string {
  const code = (id: string) =>
    (g.records.get(id)?.evidence ?? [])
      .filter((e) => e.path)
      .map((e) => `${e.repo ? `${e.repo}:` : ""}${e.path}${e.line ? `:${e.line}` : ""}`);
  return toCanonicalYaml(
    {
      id: f.id,
      provisionalName: f.name,
      entryPoints: f.entryPoints.map((id) => ({ id, what: what(g, id), code: code(id) })),
      reaches: f.records
        .filter((id) => !f.entryPoints.includes(id))
        .map((id) => ({ id, what: what(g, id) })),
    },
    ["id", "provisionalName", "entryPoints", "reaches", "what", "code"],
  ).trimEnd();
}

/** Parse one run's output into proposals for the features it was given; drop the rest with why. */
export function parseNamerOutput(
  output: string,
  features: readonly Capability[],
  meta: { agent: string; at: string; runId?: string },
): { proposals: FeatureNameProposal[]; discarded: { feature?: string; reason: string }[] } {
  const discarded: { feature?: string; reason: string }[] = [];
  let data: unknown;
  try {
    data = parse(output.replace(/^```(?:ya?ml)?\s*\n|\n```\s*$/g, ""));
  } catch (e) {
    return {
      proposals: [],
      discarded: [{ reason: `the output is not YAML: ${(e as Error).message.split("\n")[0]}` }],
    };
  }
  const list = Array.isArray(data) ? data : (data as { features?: unknown } | null)?.features;
  if (!Array.isArray(list))
    return { proposals: [], discarded: [{ reason: "the output has no features list" }] };
  const byId = new Map(features.map((f) => [f.id, f]));
  const done = new Set<string>();
  const proposals: FeatureNameProposal[] = [];
  for (const raw of list) {
    const p = Proposal.safeParse(raw);
    const id =
      typeof (raw as { id?: unknown })?.id === "string" ? (raw as { id: string }).id : undefined;
    if (!p.success) {
      discarded.push({
        ...(id ? { feature: id } : {}),
        reason: `not a proposal: ${p.error.issues[0]?.path.join(".")} ${p.error.issues[0]?.message}`,
      });
      continue;
    }
    const f = byId.get(p.data.id);
    if (!f) {
      discarded.push({
        feature: p.data.id,
        reason: `${p.data.id} isn't one of the features it was given`,
      });
      continue;
    }
    if (done.has(f.id)) {
      discarded.push({ feature: f.id, reason: "a second proposal for the same feature" });
      continue;
    }
    const known = new Set([...f.entryPoints, ...f.records]);
    const evidence = [...new Set(p.data.evidence.filter((e) => known.has(e)))];
    if (!evidence.length) {
      discarded.push({
        feature: f.id,
        reason: "it cites no record id from the feature's evidence",
      });
      continue;
    }
    const tags = [
      ...new Set(
        p.data.tags
          .map((t) => t.trim().toLowerCase().replace(/\s+/g, "-"))
          .filter((t) => /^[a-z0-9][a-z0-9-]*$/.test(t)),
      ),
    ].slice(0, 5);
    done.add(f.id);
    proposals.push({
      feature: f.id,
      name: p.data.name,
      ...(p.data.description ? { description: p.data.description } : {}),
      tags,
      evidence,
      agent: meta.agent,
      at: meta.at,
      ...(meta.runId ? { runId: meta.runId } : {}),
    });
  }
  return { proposals, discarded };
}

/** Ask the feature namer for names of the features no person has named yet. */
export async function nameFeatures(
  features: readonly Capability[],
  records: readonly CatalogRecord[],
  runtime: AiRuntime,
  o: NameFeaturesOptions = {},
): Promise<NameFeaturesResult> {
  const agent = featureNamerAgent(o.orgPack);
  const g = new FlowGraph(records);
  const todo = [...features]
    .filter((f) => f.namedBy !== "person")
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const size = Math.max(1, o.batchSize ?? 20);
  const levels = o.orgPack?.pack?.classification ?? [
    "public",
    "internal",
    "confidential",
    "restricted",
  ];
  const now = o.now ?? new Date();
  const at = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const budget = o.orgPack?.runtime.budgets.perAgent[agent.id] ?? agent.tokenBudget;
  const out: NameFeaturesResult = { proposals: [], discarded: [], runs: [] };
  for (let i = 0; i < todo.length; i += size) {
    const batch = todo.slice(i, i + size);
    const ids = batch.map((f) => f.id);
    const sources: SourceInput[] = [
      {
        id: "0-instructions",
        kind: "instruction",
        origin: "atticus/features",
        text: INSTRUCTIONS,
        classification: "public",
        trusted: true,
      },
      ...batch.map((f) => ({
        id: f.id,
        kind: "catalog" as const,
        origin: `catalog/generated/capability/${f.id}.yaml`,
        text: block(f, g),
        classification: "internal",
        priority: 10,
      })),
    ];
    try {
      const pack = buildContextPack({
        change: "features",
        agent: agent.id,
        budget,
        sources,
        levels,
        maxClassification:
          o.maxClassification ?? (levels.includes("internal") ? "internal" : levels.at(-1)!),
        now,
      });
      const sent = batch.filter((f) => pack.manifest.sources.some((s) => s.id === f.id));
      for (const f of batch.filter((x) => !sent.includes(x)))
        out.discarded.push({
          feature: f.id,
          reason: "left out of the context pack (budget or classification)",
        });
      const prepared = await runtime.prepare({
        change: "features",
        agent,
        pack,
        outputPath: "catalog/proposals/feature-names.yaml",
      });
      const run = await runtime.run(prepared.runId);
      const summary = toRunSummary(run);
      const base = {
        agent: agent.id,
        features: ids,
        promptSha256: pack.manifest.promptSha256,
        summary,
      };
      if (run.state !== "validated" || run.output === undefined) {
        out.runs.push({
          ...base,
          state: "failed",
          reason: run.errors.join("; ") || `the run ended ${run.state}`,
        });
        continue;
      }
      const parsed = parseNamerOutput(run.output, sent, { agent: agent.id, at, runId: run.runId });
      out.proposals.push(...parsed.proposals);
      out.discarded.push(...parsed.discarded);
      out.runs.push({ ...base, state: "ran" });
    } catch (e) {
      out.runs.push({
        agent: agent.id,
        features: ids,
        state: "failed",
        reason: (e as Error).message,
      });
    }
  }
  return out;
}
