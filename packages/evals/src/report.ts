import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { stateDirOf } from "@maycombhq/core";
import type { AgentSummary, CaseResult, EvalReport, LiveBar } from "./types.js";

/**
 * Reports, the live bar, regressions and the AI-quality summary. Results are files under the
 * metarepo's state folder: `.evals/runs/<run-id>/report.json` for each run, and
 * `.evals/quality.json`, the summary the M4 "AI quality" view reads (latest result per agent,
 * the live bar where a live run exists, and regressions against the run before).
 */

export const evalsDirOf = (root: string) => join(stateDirOf(root), ".evals");

/** Pass counts per agent. */
export function summarise(results: readonly CaseResult[]): AgentSummary[] {
  const agents = [...new Set(results.map((r) => r.agent))].sort();
  return agents.map((agent) => {
    const rs = results.filter((r) => r.agent === agent);
    const passed = rs.filter((r) => r.pass).length;
    return {
      agent,
      cases: new Set(rs.map((r) => r.case)).size,
      passed,
      runs: rs.length,
      passRate: rs.length ? Math.round((passed / rs.length) * 1000) / 1000 : 0,
    };
  });
}

/**
 * The live bar for AI-graded exits (the plan: "each AI-graded exit passes in at least 4 of 5
 * live runs"): every AI-graded case must have exactly `runs` results, at least `min` of them
 * passing. Cases with fewer runs fail the bar: a bar can't be met on fewer runs.
 */
export function passesLiveBar(
  results: readonly CaseResult[],
  o: { runs: number; min: number } = { runs: 5, min: 4 },
): LiveBar {
  const ai = results.filter((r) => r.aiGraded);
  const keys = [...new Set(ai.map((r) => `${r.agent}\u0000${r.case}`))].sort();
  const cases = keys.map((k) => {
    const [agent, c] = k.split("\u0000") as [string, string];
    const rs = ai.filter((r) => r.agent === agent && r.case === c);
    const passed = rs.filter((r) => r.pass).length;
    return { case: c, agent, runs: rs.length, passed, ok: rs.length === o.runs && passed >= o.min };
  });
  return { runs: o.runs, min: o.min, pass: cases.length > 0 && cases.every((c) => c.ok), cases };
}

export interface Comparison {
  /** Cases that passed in the earlier report and fail now. */
  regressed: string[];
  /** Cases that failed before and pass now. */
  fixed: string[];
  added: string[];
  removed: string[];
  agents: { agent: string; before: number; after: number; delta: number }[];
}

const caseKey = (r: CaseResult) => `${r.agent}/${r.case}`;

/** A case passes in a report when most of its runs pass (all of them for a single run). */
function caseStates(report: EvalReport): Map<string, boolean> {
  const by = new Map<string, boolean[]>();
  for (const r of report.results) by.set(caseKey(r), [...(by.get(caseKey(r)) ?? []), r.pass]);
  return new Map([...by].map(([k, v]) => [k, v.filter(Boolean).length * 2 > v.length]));
}

/** What changed between two runs. */
export function compareReports(before: EvalReport, after: EvalReport): Comparison {
  const a = caseStates(before);
  const b = caseStates(after);
  const sort = (xs: string[]) => xs.sort();
  const sa = new Map(before.agents.map((x) => [x.agent, x.passRate]));
  const sb = new Map(after.agents.map((x) => [x.agent, x.passRate]));
  const agents = [...new Set([...sa.keys(), ...sb.keys()])].sort().map((agent) => {
    const x = sa.get(agent) ?? 0;
    const y = sb.get(agent) ?? 0;
    return { agent, before: x, after: y, delta: Math.round((y - x) * 1000) / 1000 };
  });
  return {
    regressed: sort([...b].filter(([k, v]) => !v && a.get(k) === true).map(([k]) => k)),
    fixed: sort([...b].filter(([k, v]) => v && a.get(k) === false).map(([k]) => k)),
    added: sort([...b.keys()].filter((k) => !a.has(k))),
    removed: sort([...a.keys()].filter((k) => !b.has(k))),
    agents,
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rename(`${path}.tmp`, path);
}

export async function saveReport(root: string, report: EvalReport): Promise<string> {
  const path = join(evalsDirOf(root), "runs", report.runId, "report.json");
  await writeJson(path, report);
  return path;
}

/** Every saved report, oldest first. */
export async function listReports(root: string): Promise<EvalReport[]> {
  const dir = join(evalsDirOf(root), "runs");
  const out: EvalReport[] = [];
  for (const id of (await readdir(dir).catch(() => [] as string[])).sort()) {
    try {
      out.push(JSON.parse(await readFile(join(dir, id, "report.json"), "utf8")) as EvalReport);
    } catch {
      // a run that didn't finish writing
    }
  }
  return out.sort((x, y) =>
    x.startedAt < y.startedAt ? -1 : x.startedAt > y.startedAt ? 1 : x.runId < y.runId ? -1 : 1,
  );
}

export interface QualityAgent {
  agent: string;
  lastRunAt: string;
  lastRun: string;
  mode: EvalReport["mode"];
  cases: number;
  passRate: number;
  /** From the newest live run of this agent, when there is one. */
  liveBar?: { runs: number; min: number; pass: boolean; at: string };
  /** Cases that regressed against the previous run of the same mode. */
  regressed: string[];
}

export interface QualitySummary {
  schemaVersion: 1;
  updatedAt: string;
  agents: QualityAgent[];
}

/** The AI-quality summary from every saved report: newest result per agent. */
export function qualityOf(reports: readonly EvalReport[], updatedAt: string): QualitySummary {
  const agents = new Map<string, QualityAgent>();
  for (const [i, r] of reports.entries()) {
    const prev = [...reports.slice(0, i)].reverse().find((x) => x.mode === r.mode);
    const cmp = prev ? compareReports(prev, r) : undefined;
    for (const a of r.agents) {
      const cur = agents.get(a.agent);
      const live =
        r.mode === "live" && r.liveBar
          ? {
              runs: r.liveBar.runs,
              min: r.liveBar.min,
              pass: r.liveBar.cases.filter((c) => c.agent === a.agent).every((c) => c.ok),
              at: r.finishedAt,
            }
          : cur?.liveBar;
      agents.set(a.agent, {
        agent: a.agent,
        lastRunAt: r.finishedAt,
        lastRun: r.runId,
        mode: r.mode,
        cases: a.cases,
        passRate: a.passRate,
        ...(live ? { liveBar: live } : {}),
        regressed: (cmp?.regressed ?? []).filter((k) => k.startsWith(`${a.agent}/`)),
      });
    }
  }
  return {
    schemaVersion: 1,
    updatedAt,
    agents: [...agents.values()].sort((x, y) => (x.agent < y.agent ? -1 : 1)),
  };
}

export async function writeQuality(
  root: string,
  now: Date,
): Promise<{ path: string; summary: QualitySummary }> {
  const summary = qualityOf(await listReports(root), now.toISOString().replace(/\.\d{3}Z$/, "Z"));
  const path = join(evalsDirOf(root), "quality.json");
  await writeJson(path, summary);
  return { path, summary };
}

export async function readQuality(root: string): Promise<QualitySummary | undefined> {
  try {
    return JSON.parse(
      await readFile(join(evalsDirOf(root), "quality.json"), "utf8"),
    ) as QualitySummary;
  } catch {
    return undefined;
  }
}
