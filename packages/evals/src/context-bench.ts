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
  type CatalogRecord,
} from "@maycombhq/core";
import { MockRuntime, type AiRequest } from "@maycombhq/ai";
import { readKnowledge } from "@maycombhq/knowledge";
import {
  architectureStage,
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

export interface ContextRow {
  step: ContextStep;
  /** The fixture and change. */
  case: string;
  budget: "org pack" | "tight";
  mode: "whole lists" | "engine";
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
}

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

interface Case {
  step: ContextStep;
  name: string;
  /** Build a fresh root for one run. */
  root(fx: string, root: string): Promise<string>;
  /** Run the step once; the first prompt is captured. */
  run(root: string, engine: boolean, seen: Capture[]): Promise<void>;
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
    run: async (root, engine, seen) => {
      await findNeeds(root, "add-fraud-check", {
        runtime: assistant(/^needs-finder$/, "needs: []\nnot_needed: []\n", seen),
        orgPack: await loadOrgPack(orgPackDirOf(root)),
        now: NOW,
        maxAttempts: 1,
        context: { engine },
      });
    },
    context: /^(item-|ctx-)/,
    needed: async (fx) => requestsNeeded(fx),
  },
  {
    step: "feature",
    name: "shop: add-fraud-check",
    root: (fx, r) => shopRoot(fx, r),
    run: async (root, engine, seen) => {
      const golden = readFileSync(join(root, "../placed.yaml"), "utf8");
      await featureStage(root, "add-fraud-check", {
        runtime: assistant(/^feature-placer$/, golden, seen),
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
    run: async (root, engine, seen) => {
      await featureStage(root, "add-transfer-limit", {
        runtime: assistant(
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
    run: async (root, engine, seen) => {
      const delta = readFileSync(join(root, "../target.yaml"), "utf8");
      await architectureStage(root, "add-fraud-check", {
        runtime: assistant(/^flow-architect$/, `flows:\n${indent(delta)}`, seen),
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
    run: async (root, engine, seen) => {
      await storiesStage(root, "add-fraud-check", {
        runtime: assistant(/^story-writer-flows$/, "stories: []\nrequests: []\n", seen),
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
  engine: boolean,
  budget?: number,
): Promise<{ capture: Capture; root: string }> {
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
  await c.run(root, engine, seen).catch((e: Error) => {
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
  const sent = idsIn(text, universe);
  const hit = needed.filter((n) => sent.has(n));
  const contextTokens = cap.sources
    .filter((s) => c.context.test(s.id))
    .reduce((n, s) => n + s.tokens, 0);
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    needed: needed.length,
    sent: sent.size,
    recall: needed.length ? r2(hit.length / needed.length) : 1,
    precision: sent.size ? r2(hit.length / sent.size) : 0,
    tokens: cap.totalTokens,
    contextTokens,
    missing: needed.filter((n) => !sent.has(n)),
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
    const base = await once(c, o.fixtures, false);
    const universe = await universeOf(base.root);
    const needed = await c.needed(o.fixtures, base.root);
    const listTokens = base.capture.sources
      .filter((s) => c.context.test(s.id))
      .reduce((n, s) => n + s.tokens, 0);
    // Tight: the whole prompt less half the room the lists take.
    const tight = base.capture.totalTokens - Math.ceil(listTokens / 2);
    for (const budget of ["org pack", "tight"] as const)
      for (const mode of ["whole lists", "engine"] as const) {
        const cap =
          budget === "org pack" && mode === "whole lists"
            ? base.capture
            : (await once(c, o.fixtures, mode === "engine", budget === "tight" ? tight : undefined))
                .capture;
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

/** The eval as a Markdown page: the table, and which steps use the engine by default. */
export function renderContextTable(rows: ContextRow[]): string {
  const sw = engineSwitches(rows);
  const lines = [
    "<!-- Written by packages/evals/scripts/write-context-eval.mjs from runContextBench (ADR 0107 point 6). Don't edit: run the script again. -->",
    "# The context engine's eval",
    "",
    "Each step that sent a whole list, run on the Forge fixtures with the whole lists and with the context engine, at the org pack's budget and at a tight one (the whole prompt less half the room the lists take). Recall: the share of the records a correct answer needs (from the golden answers) that the context names. Precision: the share of the records the context names that a correct answer needs. Tokens: the whole prompt, then the context in it.",
    "",
    "| Step | Case | Budget | Context | Recall | Precision | Sent / needed | Tokens | Context tokens | Missing |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map(
      (r) =>
        `| ${r.step} | ${r.case} | ${r.budget} | ${r.mode} | ${r.recall.toFixed(2)} | ${r.precision.toFixed(2)} | ${r.sent} / ${r.needed} | ${r.tokens} | ${r.contextTokens} | ${r.missing.join(", ") || "none"} |`,
    ),
    "",
    "A step uses the engine by default only where its recall is at least the whole lists' on every case and budget:",
    "",
    ...(Object.keys(sw) as ContextStep[]).map(
      (s) => `- ${s}: ${sw[s] ? "the engine" : "the whole lists (the engine's recall is lower)"}`,
    ),
    "",
  ];
  return lines.join("\n");
}
