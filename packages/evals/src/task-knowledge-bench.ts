import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { MockRuntime, type AiRequest } from "@maycombhq/ai";
import { selectFor, smallStage, taskContext } from "@maycombhq/planner";

/**
 * Each task's knowledge, measured (ADR 0124 addendum B-task-knowledge): on the invented Forge
 * fixtures, a small change's task through the fast path, the knowledge `atticus task context`
 * lists for it against the items the task needs, before (patterns and decisions only, 1,500
 * tokens, everything the search found kept) and now (every kind, kept by what the task changes).
 *
 * - **recall**: of the items the task needs, the share it lists;
 * - **precision**: of what it lists, the share the task needs.
 */

export interface TaskKnowledgeCase {
  name: string;
  /** The fixture folder under fixtures/stages: the change, its answer, its knowledge. */
  dir: string;
  change: string;
  task: string;
  /** The items the task needs. */
  needed: string[];
  /**
   * Other fixture folders under fixtures/stages whose knowledge (and snapshots) is added as
   * distractors: items about other things the task must not list ("." is fixtures/stages).
   */
  distractors?: string[];
}

/** Every other knowledge fixture of the stages: requests, vendor patterns, SSO, API times. */
const ALL = [".", "wiki", "small", "sso"];

export const TASK_KNOWLEDGE_CASES: TaskKnowledgeCase[] = [
  {
    name: "sso: add-sso",
    dir: "sso",
    change: "add-sso",
    task: "1.1",
    needed: ["sso-setup", "sso-token-claims"],
  },
  {
    name: "small: return-order-time",
    dir: "small",
    change: "return-order-time",
    task: "1.1",
    needed: ["api-times-utc"],
  },
  {
    name: "sso, with every other wiki item",
    dir: "sso",
    change: "add-sso",
    task: "1.1",
    needed: ["sso-setup", "sso-token-claims"],
    distractors: ALL.filter((d) => d !== "sso"),
  },
  {
    name: "small, with every other wiki item",
    dir: "small",
    change: "return-order-time",
    task: "1.1",
    needed: ["api-times-utc"],
    distractors: ALL.filter((d) => d !== "small"),
  },
];

export type TaskKnowledgeMode = "before" | "per task";

export interface TaskKnowledgeRow {
  case: string;
  task: string;
  mode: TaskKnowledgeMode;
  needed: number;
  listed: number;
  recall: number;
  precision: number;
  missing: string[];
  extra: string[];
}

const NOW = new Date("2026-10-24T09:00:00Z");

async function records(root: string, dir: string, file: string): Promise<void> {
  for (const r of parse(readFileSync(file, "utf8")) as unknown[]) {
    const p = parseRecord(r);
    if (!p.ok) throw new Error(`bad fixture record in ${file}: ${JSON.stringify(p.issues)}`);
    const f = join(root, dir, recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
}

/** The shop's estate with the case's knowledge, snapshot and scan, its change planned. */
async function caseRoot(fixtures: string, c: TaskKnowledgeCase): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-task-knowledge-"));
  const fx = join(fixtures, "stages", c.dir);
  await mkdir(join(root, "org-pack"), { recursive: true });
  await records(root, "catalog/generated", join(fixtures, "specs/catalog.yaml"));
  await records(root, "catalog/generated", join(fixtures, "stages/catalog-extra.yaml"));
  for (const d of c.distractors ?? []) {
    const dx = join(fixtures, "stages", d);
    await records(root, "knowledge/items", join(dx, "knowledge.yaml"));
    await cp(join(dx, "snapshots"), join(root, "knowledge/snapshots"), { recursive: true }).catch(
      () => undefined,
    );
  }
  await records(root, "knowledge/items", join(fx, "knowledge.yaml"));
  await cp(join(fx, "snapshots"), join(root, "knowledge/snapshots"), { recursive: true }).catch(
    () => undefined,
  );
  await cp(join(fx, "scan.yaml"), join(root, "knowledge/scan.yaml")).catch(() => undefined);
  await cp(join(fixtures, "stages/specs"), join(root, "specs"), { recursive: true });
  await cp(join(fx, c.change), join(root, "openspec/changes", c.change), { recursive: true });
  const answer = readFileSync(join(fx, "answer.yaml"), "utf8");
  const runtime = new MockRuntime(
    (req: AiRequest) => (req.agent.id.endsWith("-critic") ? "findings: []" : answer),
    { now: () => NOW },
  );
  const r = await smallStage(root, c.change, { runtime, now: NOW });
  if (r.state !== "done") throw new Error(`${c.name}: the fast path didn't finish (${r.state})`);
  return root;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

function row(c: TaskKnowledgeCase, mode: TaskKnowledgeMode, listed: string[]): TaskKnowledgeRow {
  const need = new Set(c.needed);
  const hit = listed.filter((x) => need.has(x));
  return {
    case: c.name,
    task: c.task,
    mode,
    needed: c.needed.length,
    listed: listed.length,
    recall: c.needed.length ? r2(hit.length / c.needed.length) : 1,
    precision: listed.length ? r2(hit.length / listed.length) : 0,
    missing: c.needed.filter((x) => !listed.includes(x)),
    extra: listed.filter((x) => !need.has(x)),
  };
}

export async function runTaskKnowledgeBench(fixtures: string): Promise<TaskKnowledgeRow[]> {
  const out: TaskKnowledgeRow[] = [];
  for (const c of TASK_KNOWLEDGE_CASES) {
    const root = await caseRoot(fixtures, c);
    const ctx = await taskContext(root, c.change, c.task);
    // Before: the task context's selection as it was (ADR 0113): the same words, patterns and
    // decisions only, 1,500 tokens, everything picked kept.
    const before = await selectFor(
      root,
      {
        text: [
          ctx.task.title,
          ctx.step?.what ?? "",
          (ctx.step?.fields ?? []).join(" "),
          ctx.step?.target ?? "",
          ctx.step?.store ?? "",
          ctx.story?.text ?? "",
        ].join("\n"),
        title: ctx.task.title,
        ids: ctx.flow ? [ctx.flow.id, ctx.flow.id.split(".")[0]!] : [],
      },
      {
        budget: 1500,
        kinds: ["Pattern", "Decision"],
        groups: ["knowledge"],
        exclude: [c.change],
      },
    );
    out.push(
      row(
        c,
        "before",
        (before.selection?.picked ?? []).map((p) => p.id),
      ),
    );
    out.push(
      row(
        c,
        "per task",
        ctx.knowledge.map((k) => k.id),
      ),
    );
  }
  return out;
}

export function renderTaskKnowledgeTable(rows: TaskKnowledgeRow[]): string {
  const lines = [
    "## Knowledge per task (ADR 0124 addendum B-task-knowledge)",
    "",
    "Each case is a small change on the invented Forge fixtures, planned through the fast path; the row is what `atticus task context` lists for its task. Before: patterns and decisions only, 1,500 tokens, everything the search found kept (the task context of ADR 0113). Per task: every kind (how-tos and runbooks, standards, processes, requests, patterns, decisions), kept by what the task changes. Recall: the share of the items the task needs that it lists. Precision: the share of what it lists that the task needs.",
    "",
    "| Case | Task | Selection | Recall | Precision | Listed / needed | Missing | Not needed |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const r of rows)
    lines.push(
      `| ${r.case} | ${r.task} | ${r.mode} | ${r.recall.toFixed(2)} | ${r.precision.toFixed(2)} | ${r.listed} / ${r.needed} | ${r.missing.join(", ") || "none"} | ${r.extra.join(", ") || "none"} |`,
    );
  lines.push("");
  return lines.join("\n");
}
