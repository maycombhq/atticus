import { parse } from "yaml";
import { z } from "zod";
import { AgentDefinition, changesRelOf, toCanonicalYaml } from "@maycombhq/core";
import {
  buildContextPack,
  toRunSummary,
  type AiRuntime,
  type Run,
  type SourceInput,
} from "@maycombhq/ai";
import type { RunSummary } from "@maycombhq/core";
import type { PlanContext } from "./context.js";
import type { PlanSkeleton, StorySkeleton } from "./skeleton.js";

/**
 * The prose of the stories, written by the org pack's story-writer agent (contract C5) on top
 * of the deterministic skeleton: title, who it is for, what they want and why, and the
 * Given/When/Then wording of each criterion. The skeleton and the artifacts go in as data,
 * never instructions; the agent can't add stories, links, systems or repos, and anything it
 * returns for a story id the skeleton doesn't have is discarded. Without an answer for a
 * story, plain prose is made from the skeleton and the story is marked for a person to word.
 */

export interface Criterion {
  given: string;
  when: string;
  then: string;
  /** The spec scenario it comes from, as `<file>:<line>`. */
  trace?: string;
}

export interface StoryProse {
  title: string;
  asA: string;
  iWant: string;
  soThat: string;
  criteria: Criterion[];
  notes?: string;
  /** Where the prose came from. */
  by: "ai" | "fallback";
}

export const STORY_WRITER = "story-writer";

/** The org pack's story writer, or a built-in one. */
export function storyWriter(ctx: PlanContext): AgentDefinition {
  const own = ctx.lifecycle.orgPack.agents.find((a) => a.id === STORY_WRITER);
  if (own) return own;
  return AgentDefinition.parse({
    schemaVersion: 1,
    id: STORY_WRITER,
    role: "business-analyst",
    description:
      "Writes user stories with Given/When/Then acceptance criteria that trace to the brief and the spec scenarios.",
    inputs: ["brief", "proposal", "specs", "design", "catalog-slice"],
    outputArtifact: "stories",
    tokenBudget: ctx.lifecycle.orgPack.runtime.budgets.defaultTokens,
    allowedRuntimes: ["hand-off", "model", "headless-claude-code", "mock", "replay"],
  });
}

const FORMAT = `Write the prose for each story below, in YAML, and nothing else:

stories:
  - id: <the story id, exactly as given>
    title: <a short title, at most 80 characters, starting with a verb>
    asA: <who it is for: a role, such as Portal customer or support agent>
    iWant: <what they want, in their words>
    soThat: <the outcome they get>
    criteria:
      - given: <the situation>
        when: <what happens>
        then: <what can be seen or checked>
        trace: <the scenario's file:line, when it comes from one>
    notes: <optional: anything a developer should know, from the material>

Rules:
- Write one criterion for every scenario listed for a story; stories without scenarios get criteria from their interfaces, mappings and data changes.
- Name only systems, components, repos, interfaces and operations that appear in the material. Don't invent any.
- Don't answer the open questions: they stay open for the people named.
- Plain, short English. No placeholders such as TBD.`;

function instructions(ctx: PlanContext): string {
  return [
    "# Story writer",
    "",
    `You write the user stories for change ${ctx.change.id} (${ctx.change.title}), a ${ctx.type.name.toLowerCase()}. The stories, their links, systems, repos, tests and open questions are already decided (the story plan below); you write their prose.`,
    "",
    FORMAT,
  ].join("\n");
}

/** The story plan as the agent sees it: everything decided, as YAML. */
export function planText(skeleton: PlanSkeleton): string {
  const rows = skeleton.stories.map((s) => ({
    id: s.id,
    source: s.source,
    ...(s.requirement
      ? {
          requirement: `${s.requirement.name} (${s.requirement.file}:${s.requirement.line})`,
          scenarios: s.scenarios.map((sc) => ({
            name: sc.name,
            trace: `${s.requirement!.file}:${sc.line}`,
            when: sc.when.join(" "),
            then: sc.then.join(" "),
          })),
        }
      : {}),
    interfaces: s.interfaces.map(
      (i) =>
        `${i.id === "new" ? "new" : i.id}: ${i.caller} → ${i.callee} ${i.operation} (${i.status})`,
    ),
    records: s.records,
    systems: s.systems,
    repos: s.repos,
    dependsOn: s.dependsOn,
    openQuestions: s.openQuestions.map((q) => q.text),
    ...(s.trace ? { tracesTo: `${s.trace.path}:${s.trace.line}: ${s.trace.text}` } : {}),
    material: s.material,
  }));
  return toCanonicalYaml({ stories: rows }, [
    "stories",
    "id",
    "source",
    "requirement",
    "scenarios",
    "name",
    "trace",
    "when",
    "then",
  ]).trimEnd();
}

/** The context pack for the story writer: instructions trusted, everything else data. */
export function storyPack(
  ctx: PlanContext,
  skeleton: PlanSkeleton,
  agent: AgentDefinition,
  now: Date,
) {
  const doc = (rel: string) => ctx.files.docs.get(rel)?.raw;
  const sources: SourceInput[] = [
    {
      id: "instructions",
      kind: "instruction",
      origin: "atticus",
      text: instructions(ctx),
      classification: "public",
      trusted: true,
    },
    {
      id: "story-plan",
      kind: "artifact",
      origin: "atticus plan (deterministic)",
      text: planText(skeleton),
      classification: "internal",
      priority: 100,
    },
  ];
  const add = (rel: string, priority: number) => {
    const text = doc(rel);
    if (text)
      sources.push({
        id: rel,
        kind: "artifact",
        origin: `${changesRelOf(ctx.root)}/${ctx.change.id}/${rel}`,
        text,
        classification: "internal",
        priority,
      });
  };
  add("brief.md", 90);
  add("proposal.md", 80);
  for (const d of [...ctx.files.docs.keys()].filter((k) => k.startsWith("specs/"))) add(d, 85);
  add("ux.md", 60);
  add("design.md", 50);
  const levels = ctx.lifecycle.orgPack.pack?.classification ?? [
    "public",
    "internal",
    "confidential",
    "restricted",
  ];
  return buildContextPack({
    change: ctx.change.id,
    agent: agent.id,
    budget: agent.tokenBudget,
    sources,
    levels,
    maxClassification: levels.includes("internal") ? "internal" : levels[0]!,
    now,
  });
}

const AiCriterion = z.object({
  given: z.string().min(1),
  when: z.string().min(1),
  then: z.string().min(1),
  trace: z.coerce.string().optional(),
});
const AiStory = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  asA: z.string().min(1),
  iWant: z.string().min(1),
  soThat: z.string().min(1),
  criteria: z.array(AiCriterion).default([]),
  notes: z.string().optional(),
});
const AiOutput = z.object({ stories: z.array(z.unknown()).default([]) });

export interface ProseResult {
  prose: Map<string, StoryProse>;
  discarded: { id?: string; reason: string }[];
  run?: RunSummary;
  /** Set when the run hands off to the person's assistant and hasn't produced yet. */
  waiting?: { runId: string; prompt?: string };
  promptSha256?: string;
}

const strip = (s: string) => s.trim().replace(/\s+/g, " ").replace(/[.]+$/, "");

/** Parse the agent's answer against the skeleton. */
export function parseProse(skeleton: PlanSkeleton, output: string): Omit<ProseResult, "run"> {
  const prose = new Map<string, StoryProse>();
  const discarded: ProseResult["discarded"] = [];
  let data: unknown;
  try {
    data = parse(output.replace(/^```(?:ya?ml)?\n|```\s*$/g, ""));
  } catch (e) {
    return {
      prose,
      discarded: [{ reason: `the answer isn't YAML: ${(e as Error).message.split("\n")[0]}` }],
    };
  }
  const top = AiOutput.safeParse(data);
  if (!top.success) return { prose, discarded: [{ reason: "the answer has no stories list" }] };
  const ids = new Set(skeleton.stories.map((s) => s.id));
  for (const raw of top.data.stories) {
    const r = AiStory.safeParse(raw);
    const id = (raw as { id?: unknown })?.id;
    if (!r.success) {
      discarded.push({
        ...(typeof id === "string" ? { id } : {}),
        reason: `incomplete: ${r.error.issues.map((i) => i.path.join(".")).join(", ")}`,
      });
      continue;
    }
    if (!ids.has(r.data.id)) {
      discarded.push({ id: r.data.id, reason: "no story in the plan has this id" });
      continue;
    }
    prose.set(r.data.id, {
      title: strip(r.data.title),
      asA: strip(r.data.asA).replace(/^an?\s+/i, ""),
      iWant: strip(r.data.iWant).replace(/^to\s+/i, "to "),
      soThat: strip(r.data.soThat),
      criteria: r.data.criteria.map((c) => ({
        given: strip(c.given).replace(/^given\s+/i, ""),
        when: strip(c.when).replace(/^when\s+/i, ""),
        then: strip(c.then).replace(/^then\s+/i, ""),
        ...(c.trace ? { trace: c.trace } : {}),
      })),
      ...(r.data.notes ? { notes: r.data.notes.trim() } : {}),
      by: "ai",
    });
  }
  return { prose, discarded };
}

/** Plain prose from the skeleton alone, for a story the agent didn't answer. */
export function fallbackProse(ctx: PlanContext, s: StorySkeleton): StoryProse {
  const sys = s.systems.map((x) => ctx.systemName(x));
  const title =
    s.requirement?.name ??
    (s.hops[0]
      ? `${s.hops[0].status === "planned-new" ? "Add" : "Change"} ${s.hops[0].operation} from ${s.hops[0].caller} to ${s.hops[0].callee}`
      : s.data[0]
        ? `Change ${s.data[0].table} in ${s.data[0].store}`
        : s.key);
  const criteria: Criterion[] = s.scenarios.map((sc) => ({
    given: sc.name.toLowerCase(),
    when: sc.when.join(" and "),
    then: sc.then.join(" and "),
    trace: `${s.requirement!.file}:${sc.line}`,
  }));
  return {
    title,
    asA: `user of ${sys.join(" and ") || "the system"}`,
    iWant: (s.trace?.text ?? title).replace(/^Requirement:\s*/, "").toLowerCase(),
    soThat: "the change delivers what the brief asks for",
    criteria,
    by: "fallback",
  };
}

/** Run the story writer and merge its prose with the skeleton. */
export async function writeProse(
  ctx: PlanContext,
  skeleton: PlanSkeleton,
  o: { runtime?: AiRuntime; now: Date; resume?: string },
): Promise<ProseResult> {
  if (!o.runtime) return { prose: new Map(), discarded: [] };
  const agent = storyWriter(ctx);
  const pack = storyPack(ctx, skeleton, agent, o.now);
  let run: Run;
  if (o.resume) run = await o.runtime.result(o.resume);
  else {
    const prepared = await o.runtime.prepare({
      change: ctx.change.id,
      agent,
      pack,
      outputPath: "stories.md",
    });
    run = await o.runtime.run(prepared.runId);
  }
  if (run.state === "waiting" || run.state === "prepared")
    return {
      prose: new Map(),
      discarded: [],
      waiting: { runId: run.runId },
      promptSha256: pack.manifest.promptSha256,
    };
  if (run.output === undefined || run.state === "failed" || run.state === "cancelled")
    return {
      prose: new Map(),
      discarded: [
        { reason: `the story writer ${run.state}: ${run.errors.join("; ") || "no output"}` },
      ],
      run: toRunSummary(run),
      promptSha256: pack.manifest.promptSha256,
    };
  return {
    ...parseProse(skeleton, run.output),
    run: toRunSummary(run),
    promptSha256: pack.manifest.promptSha256,
  };
}
