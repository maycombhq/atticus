import { parse } from "yaml";
import { z } from "zod";
import { AgentDefinition, toCanonicalYaml, type OrgPack, type RunSummary } from "@maycombhq/core";
import {
  buildContextPack,
  toRunSummary,
  type AiRuntime,
  type Run,
  type SourceInput,
} from "@maycombhq/ai";
import { allCases, type ApiCase, type TestModel } from "./model.js";
import { camel, oneLine } from "./words.js";

/**
 * Names only (the brief's "AI only for scenario prose and test data naming"): the org pack's
 * `test-writer` agent (contract C5) words the Gherkin scenario titles and test names and names
 * the test data. Everything else in the model is decided already; the model goes in as data,
 * and a name for an id the model doesn't have is discarded. Without an answer, the
 * deterministic titles are used.
 */

export const TEST_WRITER = "test-writer";

export function testWriter(orgPack?: Pick<OrgPack, "agents" | "runtime">): AgentDefinition {
  const own = orgPack?.agents.find((a) => a.id === TEST_WRITER);
  if (own) return own;
  return AgentDefinition.parse({
    schemaVersion: 1,
    id: TEST_WRITER,
    role: "qa",
    description:
      "Names the scenarios, test cases and test data of tests Atticus generates from a story, in plain words.",
    inputs: ["stories", "specs", "catalog-slice"],
    outputArtifact: "code",
    tokenBudget: orgPack?.runtime.budgets.defaultTokens ?? 150_000,
    allowedRuntimes: ["hand-off", "model", "headless-claude-code", "mock", "replay"],
  });
}

const INSTRUCTIONS = `# Test writer

Atticus has generated the tests for one story; their structure, steps, requests and checks are decided. You only name things, in plain, short English:

- scenarios: a title for each Gherkin scenario, at most 80 characters, saying what is checked;
- cases: a test name for each test case, at most 80 characters, starting with a verb;
- data: a name for each piece of test data, two to five words, saying what it is (it becomes a variable name).

Use only what the material says. Don't add cases or change what they check. Write YAML and nothing else:

scenarios:
  - id: <scenario id, exactly as given>
    name: <title>
cases:
  - id: <case id, exactly as given>
    name: <test name>
data:
  - id: <data id, exactly as given>
    name: <data name>`;

export interface NamingResult {
  by: "ai" | "fallback";
  discarded: { id?: string; reason: string }[];
  run?: RunSummary;
  waiting?: string;
  promptSha256?: string;
}

/** What the test writer sees: ids and what each one is, as YAML. */
export function namingMaterial(m: TestModel): string {
  const cases = allCases(m);
  const data = new Map<string, string>();
  for (const c of cases)
    if (c.type === "api" && c.data && !data.has(c.data.id))
      data.set(
        c.data.id,
        `request body for ${c.method} ${c.path}: ${JSON.stringify(c.request.body)}`,
      );
  return toCanonicalYaml(
    {
      story: { id: m.story.id, title: m.story.title },
      scenarios: cases
        .filter((c) => c.type === "acceptance")
        .map((c) => ({
          id: c.id,
          given: c.given,
          when: c.when,
          then: c.then,
          ...(c.trace?.name ? { specScenario: c.trace.name } : {}),
        })),
      cases: cases.filter((c) => c.type !== "acceptance").map((c) => ({ id: c.id, what: c.title })),
      data: [...data].map(([id, what]) => ({ id, what })),
    },
    ["story", "scenarios", "cases", "data", "id", "title", "given", "when", "then", "what"],
  ).trimEnd();
}

const Named = z.object({ id: z.string().min(1), name: z.string().min(1) });
const Answer = z.object({
  scenarios: z.array(z.unknown()).default([]),
  cases: z.array(z.unknown()).default([]),
  data: z.array(z.unknown()).default([]),
});

/** Apply the test writer's answer to the model; returns what was discarded. */
export function applyNames(m: TestModel, output: string): NamingResult["discarded"] {
  const discarded: NamingResult["discarded"] = [];
  let data: unknown;
  try {
    data = parse(output.replace(/^```(?:ya?ml)?\s*\n|\n```\s*$/g, ""));
  } catch (e) {
    return [{ reason: `the answer isn't YAML: ${(e as Error).message.split("\n")[0]}` }];
  }
  const a = Answer.safeParse(data);
  if (!a.success) return [{ reason: "the answer has no scenarios, cases or data lists" }];
  const cases = allCases(m);
  const byId = new Map(cases.map((c) => [c.id, c]));
  const apply = (
    list: unknown[],
    ok: (id: string) => boolean,
    set: (id: string, name: string) => void,
  ) => {
    for (const raw of list) {
      const n = Named.safeParse(raw);
      if (!n.success) {
        discarded.push({ reason: "an entry without an id and a name" });
        continue;
      }
      const name = oneLine(n.data.name, 100);
      if (!ok(n.data.id)) {
        discarded.push({ id: n.data.id, reason: "no such id in the generated tests" });
        continue;
      }
      if (!name) {
        discarded.push({ id: n.data.id, reason: "an empty name" });
        continue;
      }
      set(n.data.id, name);
    }
  };
  apply(
    a.data.scenarios,
    (id) => byId.get(id)?.type === "acceptance",
    (id, name) => {
      for (const c of cases) if (c.id === id) c.name = name;
    },
  );
  apply(
    a.data.cases,
    (id) => !!byId.get(id) && byId.get(id)!.type !== "acceptance",
    (id, name) => {
      for (const c of cases) if (c.id === id) c.name = name;
    },
  );
  const dataIds = new Set(cases.flatMap((c) => (c.type === "api" && c.data ? [c.data.id] : [])));
  apply(
    a.data.data,
    (id) => dataIds.has(id),
    (id, name) => {
      for (const c of cases)
        if (c.type === "api" && c.data?.id === id) c.data = { id, name: camel(name, 40) };
    },
  );
  return discarded;
}

/** Fill every name not set yet with its deterministic title (data: <operation>Request). */
export function fallbackNames(m: TestModel): void {
  for (const c of allCases(m)) {
    if (!c.name) c.name = c.title;
    if (c.type === "api" && c.data && !c.data.name)
      (c as ApiCase).data = { id: c.data.id, name: camel(`${c.method} ${c.path} request`, 40) };
  }
}

export async function nameTests(
  m: TestModel,
  o: {
    runtime?: AiRuntime;
    orgPack?: Pick<OrgPack, "agents" | "runtime" | "pack">;
    now: Date;
    resume?: string;
  },
): Promise<NamingResult> {
  if (!o.runtime) {
    fallbackNames(m);
    return { by: "fallback", discarded: [] };
  }
  const agent = testWriter(o.orgPack);
  const levels = o.orgPack?.pack?.classification ?? [
    "public",
    "internal",
    "confidential",
    "restricted",
  ];
  const sources: SourceInput[] = [
    {
      id: "instructions",
      kind: "instruction",
      origin: "atticus/testgen",
      text: INSTRUCTIONS,
      classification: "public",
      trusted: true,
    },
    {
      id: "tests",
      kind: "artifact",
      origin: `atticus tests generate ${m.story.id} (deterministic)`,
      text: namingMaterial(m),
      classification: "internal",
      priority: 100,
    },
  ];
  const pack = buildContextPack({
    change: m.change,
    agent: agent.id,
    budget: o.orgPack?.runtime.budgets.perAgent[agent.id] ?? agent.tokenBudget,
    sources,
    levels,
    maxClassification: levels.includes("internal") ? "internal" : levels[0]!,
    now: o.now,
  });
  let run: Run;
  if (o.resume) run = await o.runtime.result(o.resume);
  else {
    const prepared = await o.runtime.prepare({
      change: m.change,
      agent,
      pack,
      outputPath: `tests/${m.story.id}/names.yaml`,
    });
    run = await o.runtime.run(prepared.runId);
  }
  if (run.state === "waiting" || run.state === "prepared") {
    fallbackNames(m);
    return {
      by: "fallback",
      discarded: [],
      waiting: run.runId,
      promptSha256: pack.manifest.promptSha256,
    };
  }
  if (run.output === undefined || run.state === "failed" || run.state === "cancelled") {
    fallbackNames(m);
    return {
      by: "fallback",
      discarded: [
        { reason: `the test writer ${run.state}: ${run.errors.join("; ") || "no output"}` },
      ],
      run: toRunSummary(run),
      promptSha256: pack.manifest.promptSha256,
    };
  }
  const discarded = applyNames(m, run.output);
  fallbackNames(m);
  return { by: "ai", discarded, run: toRunSummary(run), promptSha256: pack.manifest.promptSha256 };
}
