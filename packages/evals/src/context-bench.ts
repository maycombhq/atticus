import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import {
  deserializeRecord,
  loadOrgPack,
  orgPackDirOf,
  parseRecord,
  recordPath,
  serializeRecord,
  zip,
  type CatalogRecord,
} from "@maycombhq/core";
import {
  openIndex,
  type CatalogIndex,
  type ContextInput,
  type ContextSelection,
  type SelectOptions,
} from "@maycombhq/index";
import {
  MockModelProvider,
  MockRuntime,
  ModelRuntime,
  type AiRequest,
  type AiRuntime,
} from "@maycombhq/ai";
import { readKnowledge } from "@maycombhq/knowledge";
import {
  architectureStage,
  contextToolsFor,
  endpointKey,
  featureStage,
  findNeeds,
  loadEstate,
  storiesStage,
  type ContextStep,
} from "@maycombhq/planner";

/**
 * The context engine's eval (ADR 0107 point 6). Each step that used to send a whole list runs
 * on the Forge fixtures twice, with the whole lists and with the engine, at the org pack's
 * budget and at a tight one (the room the whole list needs, halved). A mock assistant answers;
 * the eval reads the first prompt the step built and scores the context in it:
 *
 * - **recall**: of the records a correct answer needs (from the golden answers: the fraud
 *   check's approved placement and target flow, the requests the stories stage must suggest,
 *   the transfer limit's change.yaml and story outline), the share the prompt's context names;
 * - **precision**: of the records the context names, the share a correct answer needs;
 * - **tokens**: the whole prompt, and the context in it.
 *
 * A step is switched to the engine by default only where its recall is at least the whole
 * list's, on every case and budget.
 */

export type ContextMode = "whole lists" | "engine" | "engine + tools";

export interface ContextRow {
  step: ContextStep;
  /** The fixture and change. */
  case: string;
  budget: "org pack" | "tight";
  /** engine + tools: the engine's pack, and the context tools a scripted model calls. */
  mode: ContextMode;
  /** The tool calls the model made (engine + tools). */
  toolCalls?: number;
  needed: number;
  sent: number;
  recall: number;
  precision: number;
  /** The whole prompt's tokens. */
  tokens: number;
  /** The context's tokens: the lists or the selection. */
  contextTokens: number;
  /** Needed records the context didn't name. */
  missing: string[];
}

const NOW = new Date("2026-10-21T09:00:00Z");
/** The catalog files of a root, read. */
async function readCatalog(root: string): Promise<{ records: CatalogRecord[] }> {
  const records: CatalogRecord[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const f = join(d, e.name);
      if (e.isDirectory()) await walk(f);
      else if (e.name.endsWith(".yaml")) {
        const r = deserializeRecord(await readFile(f, "utf8"));
        if (r.ok) records.push(r.record);
      }
    }
  };
  await walk(join(root, "catalog"));
  return { records };
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function writeRecords(root: string, dir: string, file: string): Promise<void> {
  for (const r of parse(readFileSync(file, "utf8")) as Record<string, unknown>[]) {
    const p = parseRecord({ schemaVersion: 1, status: "current", ...r });
    if (!p.ok) throw new Error(`bad fixture record ${String(r.id)}`);
    const f = join(root, dir, recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
}

/** fixtures/stages as a metarepo: the two-repo shop, its flows, knowledge items and changes. */
async function shopRoot(
  fx: string,
  root: string,
  o: { placed?: boolean; targets?: boolean } = {},
): Promise<string> {
  await mkdir(join(root, "org-pack"), { recursive: true });
  await writeRecords(root, "catalog/generated", join(fx, "specs/catalog.yaml"));
  await writeRecords(root, "catalog/generated", join(fx, "stages/catalog-extra.yaml"));
  await writeRecords(root, "knowledge/items", join(fx, "stages/knowledge.yaml"));
  await cp(join(fx, "stages/specs"), join(root, "specs"), { recursive: true });
  await cp(join(fx, "stages/changes"), join(root, "openspec/changes"), { recursive: true });
  const dir = join(root, "openspec/changes/add-fraud-check");
  if (o.placed)
    await cp(join(fx, "context/changes/add-fraud-check/feature.yaml"), join(dir, "feature.yaml"));
  if (o.targets)
    await cp(join(fx, "context/expected/target-flows"), join(dir, "target-flows"), {
      recursive: true,
    });
  return root;
}

/** fixtures/forge with fixtures/forge-change: the transfer limit at its approved design. */
async function forgeRoot(fx: string, root: string): Promise<string> {
  await cp(join(fx, "forge/metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
  await cp(join(fx, "forge-change/org-pack"), join(root, "org-pack"), { recursive: true });
  await writeRecords(root, "catalog/generated", join(fx, "forge/expected/scan.yaml"));
  const dir = join(root, "openspec/changes/add-transfer-limit");
  await cp(join(fx, "forge-change/openspec/changes/add-transfer-limit"), dir, { recursive: true });
  return root;
}

/** Set the org pack's default token budget (runtime.yaml), keeping the rest of the file. */
async function setBudget(root: string, tokens: number): Promise<void> {
  const f = join(orgPackDirOf(root), "runtime.yaml");
  const text = await readFile(f, "utf8").catch(
    () => "schemaVersion: 1\nassistants: { allowed: [copilot], default: copilot }\n",
  );
  const data = (parse(text) ?? {}) as Record<string, unknown>;
  data.budgets = { ...((data.budgets as object) ?? {}), defaultTokens: tokens };
  await writeFile(f, stringify(data));
}

interface Capture {
  prompt: string;
  totalTokens: number;
  sources: { id: string; tokens: number }[];
  /** What the tools gave back to the step's first run (engine + tools). */
  tools?: { text: string; tokens: number; calls: number };
}

/** How a case's step gets its assistant: a mock, or a scripted model with the context tools. */
type Assistant = (agent: RegExp, answer: string, seen: Capture[]) => AiRuntime;

/** A mock assistant that keeps the first prompt of the step's own agent. */
function assistant(agent: RegExp, answer: string, seen: Capture[]) {
  return new MockRuntime(
    (req: AiRequest) => {
      if (req.agent.id.endsWith("-critic") || !agent.test(req.agent.id)) return "findings: []";
      seen.push({
        prompt: req.pack.prompt,
        totalTokens: req.pack.manifest.totalTokens,
        sources: req.pack.manifest.sources.map((s) => ({ id: s.id, tokens: s.tokens })),
      });
      return answer;
    },
    { now: () => NOW },
  );
}

/** The ids a tool or a pack line names: "- Kind id:" in a search, "left out for room: a, b". */
const leftOutIn = (prompt: string): string[] =>
  [...prompt.matchAll(/left out for room \(name one by id if you need it\): ([^\n]+?)\.(?:\n|$)/g)]
    .flatMap((m) => m[1]!.replace(/ and \d+ more$/, "").split(", "))
    .map((s) => s.trim())
    .filter(Boolean);
const hitsIn = (text: string): string[] =>
  [...text.matchAll(/^- [A-Za-z]+ (\S+): /gm)].map((m) => m[1]!);
const titleIn = (prompt: string): string | undefined =>
  /<atticus-data [^>]*>\n#\s+([^\n]+)/.exec(prompt)?.[1]?.trim();

/**
 * The scripted model of the tools mode (ADR 0107 addendum): what a model that looks up what its
 * pack lacks does, the same on every run. Round 1: show up to six ids the pack says it left out
 * for room, and search the change's title. Round 2: show up to five search hits the pack and
 * the first round didn't have. Then it answers with the golden answer. Its calls run through
 * the real context tools against the case's index, and every call is in the run's record.
 */
function toolAssistant(root: string): Assistant {
  return (agent, answer, seen) => {
    let first: Capture | undefined;
    const provider = new MockModelProvider(
      "scripted-model",
      () => answer,
      (input, round) => {
        const step = agent.test(/^You are the (\S+) agent/.exec(input.system)?.[1] ?? "");
        if (!step) return { text: "findings: []" };
        const prompt = input.messages[0]?.role === "user" ? input.messages[0].text : "";
        const results = input.messages.flatMap((m) => (m.role === "tool" ? m.results : []));
        if (first && first.prompt === prompt && results.length) {
          first.tools = {
            text: results.map((r) => r.text).join("\n"),
            tokens: results.reduce((n, r) => n + Math.ceil(r.text.length / 4), 0),
            calls: results.length,
          };
        }
        if (input.final) return { text: answer };
        if (round === 1) {
          const shows = leftOutIn(prompt)
            .slice(0, 6)
            .map((id) => ({ name: "show", input: { id } }));
          const title = titleIn(prompt);
          const calls = [
            ...shows,
            ...(title ? [{ name: "search", input: { text: title, limit: 8 } }] : []),
          ];
          return calls.length ? { calls } : { text: answer };
        }
        if (round === 2) {
          const asked = new Set(leftOutIn(prompt));
          const hits = hitsIn(results.map((r) => r.text).join("\n"))
            .filter((id) => !asked.has(id) && !prompt.includes(id))
            .slice(0, 5);
          if (hits.length) return { calls: hits.map((id) => ({ name: "show", input: { id } })) };
        }
        return { text: answer };
      },
    );
    return new (class extends ModelRuntime {
      override async prepare(req: AiRequest) {
        if (!first && agent.test(req.agent.id)) {
          first = {
            prompt: req.pack.prompt,
            totalTokens: req.pack.manifest.totalTokens,
            sources: req.pack.manifest.sources.map((s) => ({ id: s.id, tokens: s.tokens })),
          };
          seen.push(first);
        }
        return super.prepare(req);
      }
    })(provider, { now: () => NOW, tools: () => contextToolsFor(root) });
  };
}

interface Case {
  step: ContextStep;
  name: string;
  /** Build a fresh root for one run. */
  root(fx: string, root: string): Promise<string>;
  /** Run the step once; the first prompt is captured. */
  run(root: string, engine: boolean, seen: Capture[], make: Assistant): Promise<void>;
  /** The data blocks that are the step's context (the lists the engine replaces). */
  context: RegExp;
  /** The records a correct answer needs. */
  needed(fx: string, root: string): Promise<string[]>;
}

const DATA =
  /<atticus-data id="([^"]*)" kind="[^"]*" origin="[^"]*">\n([\s\S]*?)\n<\/atticus-data>/g;

/** The record ids a text names: whole ids, not a part of a longer one. */
function idsIn(text: string, universe: string[]): Set<string> {
  const out = new Set<string>();
  for (const id of universe)
    if (new RegExp(`(?<![\\w.-])${esc(id)}(?![\\w-]|\\.\\w)`).test(text)) out.add(id);
  return out;
}

/** Every id the step could be sent: catalog records, flows and knowledge items. */
async function universeOf(root: string): Promise<string[]> {
  const records = (await readCatalog(root)).records as CatalogRecord[];
  const e = await loadEstate(root, records);
  const k = await readKnowledge(root);
  return [...new Set([...e.ids, ...k.items.map((i) => i.id)])].sort();
}

const requestsNeeded = (fx: string) =>
  [
    ...readFileSync(join(fx, "stages/expected/requests.md"), "utf8").matchAll(
      /Knowledge item: ([\w.-]+),/g,
    ),
  ]
    .map((m) => m[1]!)
    .sort();

/** Systems a golden text names by name or id, as a person reading it would. */
function systemsNamed(text: string, records: CatalogRecord[]): string[] {
  return records
    .filter((r) => r.kind === "System")
    .filter((r) =>
      [r.id, (r as { name?: string }).name ?? r.id].some((n) =>
        new RegExp(`(?<![\\w-])${esc(n)}(?![\\w-])`, "i").test(text),
      ),
    )
    .map((r) => r.id);
}

const CASES: Case[] = [
  {
    step: "needs",
    name: "shop: add-fraud-check",
    root: (fx, r) => shopRoot(fx, r, { placed: true, targets: true }),
    run: async (root, engine, seen, make) => {
      await findNeeds(root, "add-fraud-check", {
        runtime: make(/^needs-finder$/, "needs: []\nnot_needed: []\n", seen),
        orgPack: await loadOrgPack(orgPackDirOf(root)),
        now: NOW,
        maxAttempts: 1,
        context: { engine },
      });
    },
    // The ids left out for room are named, not sent: not context.
    context: /^(item-|ctx-(?!left-out$))/,
    needed: async (fx) => requestsNeeded(fx),
  },
  {
    step: "feature",
    name: "shop: add-fraud-check",
    root: (fx, r) => shopRoot(fx, r),
    run: async (root, engine, seen, make) => {
      const golden = readFileSync(join(root, "../placed.yaml"), "utf8");
      await featureStage(root, "add-fraud-check", {
        runtime: make(/^feature-placer$/, golden, seen),
        now: NOW,
        context: { engine },
      });
    },
    context: /^estate-index$/,
    needed: async (fx, root) => {
      const g = parse(
        readFileSync(join(fx, "context/changes/add-fraud-check/feature.yaml"), "utf8"),
      ) as {
        features: { id: string }[];
        flows: { id: string }[];
        summary: string;
        gaps: { what: string }[];
      };
      const records = (await readCatalog(root)).records as CatalogRecord[];
      return [
        ...g.features.map((f) => f.id),
        ...g.flows.map((f) => f.id),
        ...systemsNamed([g.summary, ...g.gaps.map((x) => x.what)].join("\n"), records),
      ].sort();
    },
  },
  {
    step: "feature",
    name: "forge: add-transfer-limit",
    root: (fx, r) => forgeRoot(fx, r),
    run: async (root, engine, seen, make) => {
      await featureStage(root, "add-transfer-limit", {
        runtime: make(
          /^feature-placer$/,
          "summary: A daily limit on transfers.\nfeatures: []\nflows: []\nnewFlows: []\ngaps: []\n",
          seen,
        ),
        now: NOW,
        context: { engine },
      });
    },
    context: /^estate-index$/,
    needed: async (fx, root) => {
      // change.yaml's systems and tables, and the endpoints the story outline's operations call.
      const c = parse(
        readFileSync(
          join(fx, "forge-change/openspec/changes/add-transfer-limit/change.yaml"),
          "utf8",
        ),
      ) as { systems: string[]; touches: { tables: string[] } };
      const s = parse(readFileSync(join(fx, "forge-change/expected/stories.yaml"), "utf8")) as {
        stories: { operations: string[]; records: string[] }[];
      };
      const records = (await readCatalog(root)).records as (CatalogRecord &
        Record<string, unknown>)[];
      const ops = new Set(s.stories.flatMap((x) => x.operations).map(endpointKey));
      const endpoints = records
        .filter(
          (r) =>
            r.kind === "Endpoint" &&
            typeof r.method === "string" &&
            ops.has(endpointKey(`${r.method} ${String(r.pathOrTopic)}`)),
        )
        .map((r) => r.id);
      return [
        ...new Set([
          ...c.systems,
          ...c.touches.tables,
          ...s.stories.flatMap((x) => x.records),
          ...endpoints,
        ]),
      ].sort();
    },
  },
  {
    step: "architecture",
    name: "shop: add-fraud-check",
    root: (fx, r) => shopRoot(fx, r, { placed: true }),
    run: async (root, engine, seen, make) => {
      const delta = readFileSync(join(root, "../target.yaml"), "utf8");
      await architectureStage(root, "add-fraud-check", {
        runtime: make(/^flow-architect$/, `flows:\n${indent(delta)}`, seen),
        now: NOW,
        context: { engine },
      });
    },
    context: /^(estate-index|patterns)$/,
    needed: async (fx) => {
      const d = parse(
        readFileSync(
          join(fx, "context/expected/target-flows/forge-orders.place-order.yaml"),
          "utf8",
        ),
      ) as { flow: string; steps: { to?: { component: string }; store?: { table: string } }[] };
      return [
        ...new Set([
          d.flow,
          ...d.steps
            .flatMap((s) => [s.to?.component, s.store?.table])
            .filter((x): x is string => !!x),
        ]),
      ].sort();
    },
  },
  {
    step: "stories",
    name: "shop: add-fraud-check",
    root: (fx, r) => shopRoot(fx, r, { placed: true, targets: true }),
    run: async (root, engine, seen, make) => {
      await storiesStage(root, "add-fraud-check", {
        runtime: make(/^story-writer-flows$/, "stories: []\nrequests: []\n", seen),
        now: NOW,
        context: { engine },
      });
    },
    context: /^processes$/,
    needed: async (fx) => requestsNeeded(fx),
  },
];

/** "- a\n  b" for a YAML list item: the delta file as the answer's one flow. */
function indent(yaml: string): string {
  const body = yaml
    .split("\n")
    .filter((l) => !l.startsWith("#"))
    .join("\n")
    .trimEnd();
  return body
    .split("\n")
    .map((l, i) => (i === 0 ? `  - ${l}` : `    ${l}`))
    .join("\n");
}

async function once(
  c: Case,
  fx: string,
  mode: ContextMode,
  budget?: number,
): Promise<{ capture: Capture; root: string }> {
  const engine = mode !== "whole lists";
  const parent = await mkdtemp(join(tmpdir(), "atticus-context-eval-"));
  const root = await c.root(fx, join(parent, "metarepo"));
  // The golden answers the mock assistant gives, beside the root (not inside it).
  const placed = parse(
    readFileSync(join(fx, "context/changes/add-fraud-check/feature.yaml"), "utf8"),
  ) as Record<string, unknown>;
  for (const k of ["schemaVersion", "change", "entry", "conflicts", "questions"]) delete placed[k];
  await writeFile(join(root, "../placed.yaml"), stringify(placed));
  await writeFile(
    join(root, "../target.yaml"),
    readFileSync(join(fx, "context/expected/target-flows/forge-orders.place-order.yaml"), "utf8"),
  );
  if (budget !== undefined) await setBudget(root, budget);
  const seen: Capture[] = [];
  // Only the first prompt is scored: how the step goes on from the mock's answer doesn't matter.
  const make = mode === "engine + tools" ? toolAssistant(root) : assistant;
  await c.run(root, engine, seen, make).catch((e: Error) => {
    if (!seen[0]) throw e;
  });
  if (!seen[0]) throw new Error(`${c.step} (${c.name}) built no prompt`);
  return { capture: seen[0], root };
}

function score(
  c: Case,
  cap: Capture,
  needed: string[],
  universe: string[],
): Omit<ContextRow, "step" | "case" | "budget" | "mode"> {
  let text = "";
  for (const m of cap.prompt.matchAll(DATA)) if (c.context.test(m[1]!)) text += `${m[2]!}\n`;
  // With tools, what the model looked up is context too.
  if (cap.tools) text += `${cap.tools.text}\n`;
  const sent = idsIn(text, universe);
  const hit = needed.filter((n) => sent.has(n));
  const contextTokens =
    cap.sources.filter((s) => c.context.test(s.id)).reduce((n, s) => n + s.tokens, 0) +
    (cap.tools?.tokens ?? 0);
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    needed: needed.length,
    sent: sent.size,
    recall: needed.length ? r2(hit.length / needed.length) : 1,
    precision: sent.size ? r2(hit.length / sent.size) : 0,
    tokens: cap.totalTokens + (cap.tools?.tokens ?? 0),
    contextTokens,
    missing: needed.filter((n) => !sent.has(n)),
    ...(cap.tools ? { toolCalls: cap.tools.calls } : {}),
  };
}

export interface ContextBenchOptions {
  /** The repo's fixtures folder. */
  fixtures: string;
  /** Only these steps. */
  steps?: ContextStep[];
}

export async function runContextBench(o: ContextBenchOptions): Promise<ContextRow[]> {
  const rows: ContextRow[] = [];
  // The temp folders sit in their own parent so the golden answers can go beside each root.
  for (const c of CASES.filter((x) => !o.steps || o.steps.includes(x.step))) {
    const base = await once(c, o.fixtures, "whole lists");
    const universe = await universeOf(base.root);
    const needed = await c.needed(o.fixtures, base.root);
    const listTokens = base.capture.sources
      .filter((s) => c.context.test(s.id))
      .reduce((n, s) => n + s.tokens, 0);
    // Tight: the whole prompt less half the room the lists take.
    const tight = base.capture.totalTokens - Math.ceil(listTokens / 2);
    for (const budget of ["org pack", "tight"] as const)
      for (const mode of ["whole lists", "engine", "engine + tools"] as const) {
        const cap =
          budget === "org pack" && mode === "whole lists"
            ? base.capture
            : (await once(c, o.fixtures, mode, budget === "tight" ? tight : undefined)).capture;
        rows.push({ step: c.step, case: c.name, budget, mode, ...score(c, cap, needed, universe) });
      }
  }
  return rows;
}

/**
 * The steps whose engine recall is at least the whole lists' on every case and budget: the
 * ones the engine replaces the whole list in, by default.
 */
export function engineSwitches(rows: ContextRow[]): Record<ContextStep, boolean> {
  const out = {} as Record<ContextStep, boolean>;
  for (const r of rows.filter((x) => x.mode === "engine")) {
    const whole = rows.find(
      (x) =>
        x.mode === "whole lists" && x.step === r.step && x.case === r.case && x.budget === r.budget,
    )!;
    out[r.step] = (out[r.step] ?? true) && r.recall >= whole.recall;
  }
  return out;
}

/**
 * Whether tools hold a step's recall with the tight pack (ADR 0107 addendum): the engine with
 * tools at the tight budget recalls at least what the engine alone does at the org pack's, on
 * every case. Only then may the step's pack start smaller when tools are there.
 */
export function toolsHold(rows: ContextRow[]): Record<ContextStep, boolean> {
  const out = {} as Record<ContextStep, boolean>;
  for (const r of rows.filter((x) => x.mode === "engine + tools" && x.budget === "tight")) {
    const full = rows.find(
      (x) =>
        x.mode === "engine" && x.step === r.step && x.case === r.case && x.budget === "org pack",
    )!;
    out[r.step] = (out[r.step] ?? true) && r.recall >= full.recall;
  }
  return out;
}

/** The eval as a Markdown page: the table, and which steps use the engine by default. */
export function renderContextTable(rows: ContextRow[]): string {
  const sw = engineSwitches(rows);
  const tools = toolsHold(rows);
  const lines = [
    "<!-- Written by packages/evals/scripts/write-context-eval.mjs from runContextBench (ADR 0107 point 6). Don't edit: run the script again. -->",
    "# The context engine's eval",
    "",
    "Each step that sent a whole list, run on the Forge fixtures with the whole lists, with the context engine, and with the engine and its read-only tools, at the org pack's budget and at a tight one (the whole prompt less half the room the lists take). Recall: the share of the records a correct answer needs (from the golden answers) that the context names. Precision: the share of the records the context names that a correct answer needs. Tokens: the whole prompt, then the context in it; with tools, both count what the tools gave back.",
    "",
    "With tools (ADR 0107 addendum) the model is a scripted mock, the same on every run, whose calls run through the real context tools against the case's index: it shows up to six ids the pack says it left out for room and searches the change's title, then shows up to five search hits the pack didn't have, then answers. Its recall is what a model that looks up what its pack lacks can reach; a real model may call fewer tools, or others. Its tokens are the first prompt and what the tools gave back; each round sends the conversation again, so a provider counts more.",
    "",
    "| Step | Case | Budget | Context | Recall | Precision | Sent / needed | Tokens | Context tokens | Tool calls | Missing |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map(
      (r) =>
        `| ${r.step} | ${r.case} | ${r.budget} | ${r.mode} | ${r.recall.toFixed(2)} | ${r.precision.toFixed(2)} | ${r.sent} / ${r.needed} | ${r.tokens} | ${r.contextTokens} | ${r.mode === "engine + tools" ? (r.toolCalls ?? 0) : "-"} | ${r.missing.join(", ") || "none"} |`,
    ),
    "",
    "A step uses the engine by default only where its recall is at least the whole lists' on every case and budget:",
    "",
    ...(Object.keys(sw) as ContextStep[]).map(
      (s) => `- ${s}: ${sw[s] ? "the engine" : "the whole lists (the engine's recall is lower)"}`,
    ),
    "",
    "With tools, a step's pack may start smaller only where the engine with tools at the tight budget recalls at least what the engine alone does at the org pack's, on every case:",
    "",
    ...(Object.keys(tools) as ContextStep[]).map((s) => {
      const sum = (mode: ContextMode, budget: ContextRow["budget"]) =>
        rows
          .filter((r) => r.step === s && r.mode === mode && r.budget === budget)
          .reduce((n, r) => n + r.tokens, 0);
      const withTools = sum("engine + tools", "tight");
      const full = sum("engine", "org pack");
      return `- ${s}: ${tools[s] ? "recall holds with the tight pack and tools" : "recall doesn't hold"}; ${withTools} tokens in all with tools against ${full} for the engine's full pack, so ${tools[s] && withTools < full ? "a smaller pack saves tokens" : "the pack stays as it is"}`;
    }),
    "",
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------- retrieval cases (ADR 0116)

/**
 * The harder cases (ADR 0116, fixtures/retrieval): about sixty inputs a step could get, run
 * straight through `selectContext` on two roots, in each retrieval mode, at a normal and a
 * tight budget. A case names what its context must hold: record or node ids, or a sentence
 * (a document's or a wiki section's words) that must be in what is sent. The groups: words of a
 * camelCase name, paraphrase, a glossary synonym, two links from what is named, similar records
 * of other systems, a fact only in a document, a sentence deep in a long wiki section, exact
 * names, and inputs nothing answers.
 *
 * - **recall**: the share of what the case needs that the context holds (in full or in one line);
 * - **precision**: the share of what was picked that the case needs;
 * - **MRR**: 1 / the rank of the first needed pick (0 when none is picked);
 * - **tokens**: what the selection takes.
 *
 * A mode is a step's default only where its recall is at least the lexical engine's on every
 * case and budget.
 */

/**
 * The modes: "words" (the words only: no identifier words, no synonyms), "+split" (an
 * identifier's words too), "lexical" (and the other names of what the input names: the engine
 * with no model), then the model's expansion, its rerank, and a local embedding model's
 * similarity, each on top of the lexical engine.
 */
export type RetrievalMode =
  "words" | "+split" | "lexical" | "+expansion" | "+rerank" | "+embeddings";
export const RETRIEVAL_MODES: RetrievalMode[] = [
  "words",
  "+split",
  "lexical",
  "+expansion",
  "+rerank",
  "+embeddings",
];

/** The modes that are layers of the lexical engine, measured to show what each adds. */
const LAYERS: RetrievalMode[] = ["words", "+split"];

export type RetrievalGroup =
  | "identifier"
  | "paraphrase"
  | "synonym"
  | "multi-hop"
  | "distractor"
  | "document"
  | "long-wiki"
  | "exact"
  | "no-answer";

export interface RetrievalCase {
  id: string;
  group: RetrievalGroup;
  root: "forge" | "shop";
  title?: string;
  text: string;
  /** Ids, or a sentence that must be in the context. */
  needed: (string | { text: string })[];
}

export interface RetrievalRow {
  case: string;
  group: RetrievalGroup;
  mode: RetrievalMode;
  budget: "normal" | "tight";
  needed: number;
  found: number;
  recall: number;
  precision: number;
  mrr: number;
  /** What the selection took. */
  tokens: number;
  picked: number;
  /** The rank (from 1) of the first needed pick, or 0. */
  rank: number;
  missing: string[];
}

/** The budgets: a step's usual room for context, and a tight one. */
export const RETRIEVAL_BUDGETS = { normal: 3000, tight: 600 } as const;

const needleOf = (n: string | { text: string }) => (typeof n === "string" ? n : n.text);
const fold = (s: string) => s.replace(/\s+/g, " ").toLowerCase();

export function readRetrievalCases(fx: string): RetrievalCase[] {
  return parse(readFileSync(join(fx, "retrieval/cases.yaml"), "utf8")) as RetrievalCase[];
}

/** The forge root: the scan's catalog, the retrieval extras, distractors, the wiki and a document. */
export async function retrievalForgeRoot(fx: string, root: string): Promise<string> {
  await cp(join(fx, "forge/metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
  await writeRecords(root, "catalog/generated", join(fx, "forge/expected/scan.yaml"));
  await writeRecords(root, "catalog/generated", join(fx, "retrieval/catalog-extra.yaml"));
  await writeRecords(root, "catalog/generated", join(fx, "retrieval/distractors.yaml"));
  await writeRecords(root, "catalog/curated", join(fx, "retrieval/curated.yaml"));
  await cp(join(fx, "retrieval/knowledge"), join(root, "knowledge"), { recursive: true });
  const parts: { name: string; data: Uint8Array }[] = [];
  const walk = async (d: string, rel: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const f = join(d, e.name);
      if (e.isDirectory()) await walk(f, `${rel}${e.name}/`);
      else parts.push({ name: `${rel}${e.name}`, data: await readFile(f) });
    }
  };
  await walk(join(fx, "retrieval/documents/settlement-runbook-docx"), "");
  parts.sort((a, b) => (a.name < b.name ? -1 : 1));
  await mkdir(join(root, "inputs/documents"), { recursive: true });
  await writeFile(
    join(root, "inputs/documents/settlement-runbook.docx"),
    zip(parts, new Date(2026, 8, 15, 12, 0, 0)),
  );
  return root;
}

/** The shop root: fixtures/stages with fixtures/context laid over it, as the index tests have it. */
export async function retrievalShopRoot(fx: string, root: string): Promise<string> {
  const plain = async (dir: string, file: string) => {
    for (const r of parse(readFileSync(file, "utf8")) as unknown[]) {
      const p = parseRecord(r);
      if (!p.ok) throw new Error(`bad fixture record in ${file}`);
      const f = join(root, dir, recordPath(p.record));
      await mkdir(dirname(f), { recursive: true });
      await writeFile(f, serializeRecord(p.record));
    }
  };
  await mkdir(join(root, "org-pack"), { recursive: true });
  await writeRecords(root, "catalog/generated", join(fx, "specs/catalog.yaml"));
  await writeRecords(root, "catalog/generated", join(fx, "stages/catalog-extra.yaml"));
  await plain("knowledge/items", join(fx, "stages/knowledge.yaml"));
  await plain("knowledge/items", join(fx, "context/knowledge.yaml"));
  await cp(join(fx, "stages/specs"), join(root, "specs"), { recursive: true });
  await cp(join(fx, "context/org-pack"), join(root, "org-pack"), { recursive: true });
  await cp(join(fx, "context/knowledge"), join(root, "knowledge"), { recursive: true });
  await cp(join(fx, "context/questions"), join(root, "questions"), { recursive: true });
  return root;
}

/** How a mode selects: the index it opens, and the input and options it selects with. */
export interface RetrievalModeRun {
  open(root: string): Promise<CatalogIndex>;
  input?(c: RetrievalCase, ix: CatalogIndex): Promise<ContextInput> | ContextInput;
  options?(c: RetrievalCase): Partial<SelectOptions>;
}

/** The modes built so far; a mode without a run is listed as not built. */
export type RetrievalModes = Partial<Record<RetrievalMode, RetrievalModeRun>>;

export function defaultRetrievalModes(): RetrievalModes {
  const open = (root: string) => openIndex(root);
  return {
    words: { open, options: () => ({ lexical: { split: false, synonyms: false } }) },
    "+split": { open, options: () => ({ lexical: { split: true, synonyms: false } }) },
    lexical: { open },
  };
}

/** What each pick put in the context, in pick order: full detail, or its one line. */
function pickTexts(s: ContextSelection): string[] {
  const full = s.sources.filter((x) => x.id !== "ctx-lines").map((x) => x.text);
  const lines = (s.sources.find((x) => x.id === "ctx-lines")?.text ?? "").split("\n").slice(1);
  let fi = 0;
  let li = 0;
  return s.picked.map((p) => (p.level === "full" ? (full[fi++] ?? "") : (lines[li++] ?? "")));
}

export function scoreSelection(
  c: RetrievalCase,
  s: ContextSelection,
): Omit<RetrievalRow, "case" | "group" | "mode" | "budget"> {
  const texts = pickTexts(s);
  const hits = (n: string | { text: string }, i: number) =>
    typeof n === "string"
      ? s.picked[i]!.id === n || s.picked[i]!.id.startsWith(`${n}#`)
      : fold(texts[i]!).includes(fold(n.text));
  const foundAt = c.needed.map((n) => s.picked.findIndex((_, i) => hits(n, i)));
  const found = foundAt.filter((i) => i >= 0).length;
  const usefulPicks = s.picked.filter((_, i) => c.needed.some((n) => hits(n, i))).length;
  const first = Math.min(...foundAt.filter((i) => i >= 0).map((i) => i + 1), Infinity);
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    needed: c.needed.length,
    found,
    recall: c.needed.length ? r2(found / c.needed.length) : 1,
    precision: s.picked.length ? r2(usefulPicks / s.picked.length) : c.needed.length ? 0 : 1,
    mrr: Number.isFinite(first) ? r2(1 / first) : 0,
    tokens: s.tokens,
    picked: s.picked.length,
    rank: Number.isFinite(first) ? first : 0,
    missing: c.needed.filter((_, i) => foundAt[i]! < 0).map(needleOf),
  };
}

export interface RetrievalBenchOptions {
  fixtures: string;
  /** The modes to run. Default: the ones built (defaultRetrievalModes). */
  modes?: RetrievalModes;
  /** Only these cases. */
  cases?: string[];
}

export async function runRetrievalBench(o: RetrievalBenchOptions): Promise<RetrievalRow[]> {
  const fx = o.fixtures;
  const parent = await mkdtemp(join(tmpdir(), "atticus-retrieval-eval-"));
  const roots = {
    forge: await retrievalForgeRoot(fx, join(parent, "forge")),
    shop: await retrievalShopRoot(fx, join(parent, "shop")),
  };
  const cases = readRetrievalCases(fx).filter((c) => !o.cases || o.cases.includes(c.id));
  const modes = o.modes ?? defaultRetrievalModes();
  const rows: RetrievalRow[] = [];
  for (const mode of RETRIEVAL_MODES) {
    const m = modes[mode];
    if (!m) continue;
    const open = new Map<string, CatalogIndex>();
    try {
      for (const c of cases) {
        let ix = open.get(c.root);
        if (!ix) open.set(c.root, (ix = await m.open(roots[c.root])));
        const input: ContextInput = m.input
          ? await m.input(c, ix)
          : { text: c.text, ...(c.title ? { title: c.title } : {}) };
        for (const budget of ["normal", "tight"] as const) {
          const s = ix.selectContext(input, {
            budget: RETRIEVAL_BUDGETS[budget],
            ...(m.options?.(c) ?? {}),
          });
          rows.push({ case: c.id, group: c.group, mode, budget, ...scoreSelection(c, s) });
        }
      }
    } finally {
      for (const ix of open.values()) ix.close();
    }
  }
  return rows;
}

/** Per mode, whether its recall is at least the lexical engine's on every case and budget. */
export function retrievalSwitches(rows: RetrievalRow[]): Partial<Record<RetrievalMode, boolean>> {
  const out: Partial<Record<RetrievalMode, boolean>> = {};
  const lexical = new Map(
    rows.filter((r) => r.mode === "lexical").map((r) => [`${r.case}|${r.budget}`, r.recall]),
  );
  for (const r of rows.filter((x) => x.mode !== "lexical" && !LAYERS.includes(x.mode)))
    out[r.mode] = (out[r.mode] ?? true) && r.recall >= (lexical.get(`${r.case}|${r.budget}`) ?? 0);
  return out;
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** The retrieval cases as Markdown: per group and mode, then per case. */
export function renderRetrievalTable(rows: RetrievalRow[], notes: string[] = []): string {
  const built = RETRIEVAL_MODES.filter((m) => rows.some((r) => r.mode === m));
  const notBuilt = RETRIEVAL_MODES.filter((m) => !built.includes(m));
  const groups = [...new Set(rows.map((r) => r.group))];
  const sw = retrievalSwitches(rows);
  const cell = (rs: RetrievalRow[]) => {
    const answered = rs.filter((r) => r.needed > 0);
    return answered.length
      ? `${avg(answered.map((r) => r.recall)).toFixed(2)} / ${avg(answered.map((r) => r.precision)).toFixed(2)} / ${avg(answered.map((r) => r.mrr)).toFixed(2)}`
      : `${avg(rs.map((r) => r.picked)).toFixed(1)} picked`;
  };
  const lines = [
    "## Retrieval cases (ADR 0116)",
    "",
    `${new Set(rows.map((r) => r.case)).size} inputs from \`fixtures/retrieval/cases.yaml\`, run straight through \`selectContext\` on two roots: the Forge scan with 208 look-alike records of eight other systems, three glossary terms and their curated aliases, a long wiki page and a Word runbook in \`inputs/\`; and the shop with its wiki and knowledge items. Budgets: ${RETRIEVAL_BUDGETS.normal} tokens (normal) and ${RETRIEVAL_BUDGETS.tight} (tight). Each cell is recall / precision / MRR, averaged over the group's cases; for inputs nothing answers it is how many records were picked anyway.`,
    "",
    ...notes,
    ...(notes.length ? [""] : []),
    `| Group | Cases | ${built.flatMap((m) => [`${m} normal`, `${m} tight`]).join(" | ")} |`,
    `| --- | --- | ${built.flatMap(() => ["---", "---"]).join(" | ")} |`,
    ...[...groups, "all"].map((g) => {
      const rs = rows.filter((r) => g === "all" || r.group === g);
      const n = new Set(rs.filter((r) => g !== "all" || r.needed > 0).map((r) => r.case)).size;
      return `| ${g} | ${n} | ${built
        .flatMap((m) =>
          (["normal", "tight"] as const).map((b) =>
            cell(rs.filter((r) => r.mode === m && r.budget === b && (g !== "all" || r.needed > 0))),
          ),
        )
        .join(" | ")} |`;
    }),
    "",
    ...(notBuilt.length ? [`Not built yet: ${notBuilt.join(", ")}.`, ""] : []),
    "A mode becomes a step's default only where its recall is at least the lexical engine's on every case and budget:",
    "",
    ...built
      .filter((m) => m !== "lexical" && !LAYERS.includes(m))
      .map(
        (m) =>
          `- ${m}: ${sw[m] ? "recall holds on every case" : "recall drops on some case, so it stays off"}`,
      ),
    ...(built.every((m) => m === "lexical" || LAYERS.includes(m))
      ? ["- only the lexical engine is built"]
      : []),
    "",
    "### Per case (normal budget): the rank of the first needed pick, 0 when it isn't picked",
    "",
    `| Case | Group | ${built.join(" | ")} | Missing (lexical) |`,
    `| --- | --- | ${built.map(() => "---").join(" | ")} | --- |`,
    ...[...new Set(rows.map((r) => r.case))].map((id) => {
      const rs = rows.filter((r) => r.case === id && r.budget === "normal");
      const first = rs.find((r) => r.mode === "lexical");
      return `| ${id} | ${rs[0]!.group} | ${built
        .map((m) => {
          const r = rs.find((x) => x.mode === m);
          return r ? (r.needed ? String(r.rank) : `${r.picked} picked`) : "-";
        })
        .join(" | ")} | ${first?.missing.join(", ") || "none"} |`;
    }),
    "",
  ];
  return lines.join("\n");
}

/** Both halves of the eval, as docs/evidence/context-eval.md has them. */
export interface ContextEval {
  steps: ContextRow[];
  retrieval: RetrievalRow[];
  /** Said above the retrieval table: what each mode replays. */
  notes: string[];
}

export async function runContextEval(fixtures: string): Promise<ContextEval> {
  const steps = await runContextBench({ fixtures });
  const retrieval = await runRetrievalBench({ fixtures });
  return {
    steps,
    retrieval,
    notes: [
      "Before ADR 0116 (the engine of ADR 0107 point 3: BM25 sums, whole wiki sections, no documents; measured at commit 464b758), all answered cases scored 0.72 / 0.03 / 0.28 at the normal budget and 0.49 / 0.06 / 0.27 at the tight one.",
    ],
  };
}

export function renderContextEval(e: ContextEval): string {
  return `${renderContextTable(e.steps)}\n${renderRetrievalTable(e.retrieval, e.notes)}`;
}
