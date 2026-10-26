import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  combine,
  createRuntime,
  formatOf,
  screenAbsorbed,
  screenDiagramXml,
  screenOfficeXml,
  screenText,
  type AiRuntime,
  type CreateRuntimeOptions,
  type Screening,
} from "@maycombhq/ai";
import { loadOrgPack, orgPackDirOf, stateDirOf } from "@maycombhq/core";
import {
  compareReports,
  findRepoRoot,
  listReports,
  loadDatasets,
  readQuality,
  runEvals,
  saveReport,
  writeQuality,
  type EvalMode,
} from "@maycombhq/evals";
import { readDocument, readZip } from "@maycombhq/ingestors";
import type { Output } from "./commands.js";
import { table } from "./table.js";

/**
 * atticus eval run|report: the AI eval harness. atticus defences scan: what the
 * ingested-content defences say about files. Exit 0 ok, 1 problems (failed cases, risky
 * content), 2 usage.
 */

export interface EvalDeps {
  now?: () => Date;
  /** Model providers for live mode (plugins); never used in tests. */
  providers?: CreateRuntimeOptions["providers"];
  /** A live runtime built by the caller instead of runtime.yaml (tests pass a mock). */
  liveRuntime?: (agent: string) => AiRuntime | Promise<AiRuntime>;
  /** The Atticus checkout holding the built-in datasets' fixtures. */
  repoRoot?: string;
  env?: Record<string, string | undefined>;
}

const MODES: EvalMode[] = ["mock", "replay", "live"];

/** atticus eval run [--agent a]... [--mode mock|replay|live] [--runs n] [--json] */
export async function evalRun(
  root: string,
  o: { agent?: string | string[]; mode?: string; runs?: number; json?: boolean },
  io: Output,
  deps: EvalDeps = {},
): Promise<number> {
  const mode = (o.mode ?? "mock") as EvalMode;
  if (!MODES.includes(mode)) {
    io.err(`--mode is one of ${MODES.join(", ")}.`);
    return 2;
  }
  if (o.runs !== undefined && (!Number.isInteger(o.runs) || o.runs < 1)) {
    io.err("--runs is a whole number of at least 1.");
    return 2;
  }
  const env = deps.env ?? process.env;
  let liveRuntime = deps.liveRuntime;
  if (mode === "live" && !liveRuntime) {
    if (env.CI) {
      io.err("Live evals call a real model, so they never run in CI. Use --mode replay there.");
      return 2;
    }
    const op = await loadOrgPack(orgPackDirOf(root));
    try {
      const rt = await createRuntime(op, {
        mode: "model",
        root,
        ...(deps.providers ? { providers: deps.providers } : {}),
      });
      liveRuntime = () => rt;
    } catch (e) {
      io.err(
        `${(e as Error).message} Live evals need a model provider in runtime.yaml (adapters.model).`,
      );
      return 2;
    }
  }
  const repoRoot = deps.repoRoot ?? findRepoRoot();
  const ds = await loadDatasets({
    ...(repoRoot ? { repoRoot } : {}),
    orgPackDir: orgPackDirOf(root),
  });
  for (const p of ds.problems) io.err(p);
  for (const u of ds.unavailable) io.err(`Left out: ${u}.`);
  const agents = o.agent === undefined ? undefined : Array.isArray(o.agent) ? o.agent : [o.agent];
  const known = new Set(ds.cases.map((c) => c.agent));
  const unknown = (agents ?? []).filter((a) => !known.has(a));
  if (unknown.length) {
    io.err(
      `No eval cases for ${unknown.join(", ")}. Agents with cases: ${[...known].sort().join(", ")}.`,
    );
    return 2;
  }
  const previous = (await listReports(root)).filter((r) => r.mode === mode).at(-1);
  const report = await runEvals({
    cases: ds.cases,
    mode,
    ...(o.runs ? { runs: o.runs } : {}),
    ...(agents ? { agents } : {}),
    ...(liveRuntime ? { liveRuntime } : {}),
    repoRoot: repoRoot ?? root,
    ...(deps.now ? { now: deps.now } : {}),
  });
  const path = await saveReport(root, report);
  await writeQuality(root, (deps.now ?? (() => new Date()))());
  const cmp = previous ? compareReports(previous, report) : undefined;
  const failed = report.results.filter((r) => !r.pass);
  if (o.json) {
    io.out(
      JSON.stringify(
        { report, comparison: cmp ?? null, file: relative(root, path).split(sep).join("/") },
        null,
        2,
      ),
    );
    return failed.length || (report.liveBar && !report.liveBar.pass) ? 1 : 0;
  }
  io.out(
    `Eval run ${report.runId} (${mode}, ${report.runs} run${report.runs === 1 ? "" : "s"} per case):`,
  );
  for (const l of table(
    ["AGENT", "CASES", "PASSED", "RUNS", "PASS RATE"],
    report.agents.map((a) => [
      a.agent,
      String(a.cases),
      String(a.passed),
      String(a.runs),
      `${Math.round(a.passRate * 100)}%`,
    ]),
  ))
    io.out(l);
  for (const f of failed)
    io.out(
      `FAIL ${f.agent}/${f.case} run ${f.run}: ${
        f.error ??
        f.grades
          .filter((g) => !g.pass)
          .map((g) => `${g.grader}${g.notes.length ? ` (${g.notes.slice(0, 3).join("; ")})` : ""}`)
          .join(", ")
      }`,
    );
  for (const s of report.skipped) io.out(`Skipped ${s.agent}/${s.case}: ${s.reason}.`);
  if (report.liveBar)
    io.out(
      `Live bar (${report.liveBar.min} of ${report.liveBar.runs} runs): ${report.liveBar.pass ? "met" : "not met"}${
        report.liveBar.pass
          ? ""
          : ` (${report.liveBar.cases
              .filter((c) => !c.ok)
              .map((c) => `${c.agent}/${c.case} ${c.passed} of ${c.runs}`)
              .join(", ")})`
      }.`,
    );
  if (cmp?.regressed.length)
    io.out(`Regressed since ${previous!.runId}: ${cmp.regressed.join(", ")}.`);
  if (cmp?.fixed.length) io.out(`Fixed since ${previous!.runId}: ${cmp.fixed.join(", ")}.`);
  io.out(`Saved ${relative(root, path).split(sep).join("/")}.`);
  return failed.length || (report.liveBar && !report.liveBar.pass) ? 1 : 0;
}

/** atticus eval report [--json]: the AI-quality summary (latest result per agent, live bar, regressions). */
export async function evalReport(root: string, o: { json?: boolean }, io: Output): Promise<number> {
  const q = await readQuality(root);
  if (!q) {
    io.out(
      "No eval runs yet. Run atticus eval run (mock or replay), or --mode live with a configured model.",
    );
    return 0;
  }
  if (o.json) {
    io.out(JSON.stringify(q, null, 2));
    return q.agents.some((a) => a.regressed.length || a.liveBar?.pass === false) ? 1 : 0;
  }
  for (const l of table(
    ["AGENT", "LAST RUN", "MODE", "CASES", "PASS RATE", "LIVE BAR", "REGRESSED"],
    q.agents.map((a) => [
      a.agent,
      a.lastRunAt,
      a.mode,
      String(a.cases),
      `${Math.round(a.passRate * 100)}%`,
      a.liveBar
        ? `${a.liveBar.pass ? "met" : "not met"} (${a.liveBar.min}/${a.liveBar.runs})`
        : "no live run",
      a.regressed.join(", ") || "-",
    ]),
  ))
    io.out(l);
  return q.agents.some((a) => a.regressed.length || a.liveBar?.pass === false) ? 1 : 0;
}

// ------------------------------------------------------------------ defences scan

const TEXT =
  /\.(md|markdown|txt|text|html?|ya?ml|json|csv|java|kt|ts|tsx|js|jsx|mjs|py|go|cs|rb|sql|sh|properties|xml|feature|mmd|gherkin)$/i;
const INSTRUCTION_FILE =
  /(^|\/)(\.github\/(prompts|agents|chatmodes|instructions)\/|\.claude\/|\.cursor\/|prompts\/)|\.(prompt|agent|chatmode|instructions)\.md$|(^|\/)(AGENTS|CLAUDE|copilot-instructions)\.md$/i;

export interface ScannedFile {
  path: string;
  risk: Screening["risk"];
  /** What Atticus does with it in an AI step. */
  action: string;
  reason: string;
  rules: string[];
  signals: {
    rule: string;
    line: number;
    excerpt: string;
    hidden?: boolean;
    encoded?: boolean;
    obfuscated?: boolean;
  }[];
}

const ACTION: Record<Screening["risk"], string> = {
  high: "quarantined: left out of every AI step until a person cleans it",
  medium: "kept as data, suspicious lines marked",
  low: "kept as data, invisible characters removed",
  none: "kept as data",
};

async function screenFile(full: string, rel: string): Promise<Screening | undefined> {
  const bytes = new Uint8Array(await readFile(full));
  if (/\.(docx|pptx|xlsx)$/i.test(rel)) {
    const parts: Screening[] = [];
    try {
      const zip = readZip(bytes);
      for (const n of zip.names.filter((x) =>
        /^(word\/document|word\/(header|footer)\d*|ppt\/slides\/slide\d+|ppt\/notesSlides\/notesSlide\d+)\.xml$/.test(
          x,
        ),
      ))
        parts.push(screenOfficeXml(zip.text(n) ?? ""));
    } catch {
      // not a readable archive: the document reader says so below
    }
    const doc = readDocument(rel, bytes);
    parts.push(
      screenText(doc.text.sections.map((s) => `${s.heading}\n${s.text}`).join("\n"), {
        format: "office",
      }),
    );
    return combine(...parts);
  }
  if (/\.pdf$/i.test(rel)) {
    const doc = readDocument(rel, bytes);
    return screenText(doc.text.sections.map((s) => `${s.heading}\n${s.text}`).join("\n"), {
      format: "pdf",
    });
  }
  if (
    /\.drawio$/i.test(rel) ||
    (/\.xml$/i.test(rel) && new TextDecoder().decode(bytes.slice(0, 200)).includes("<mxfile"))
  )
    return screenDiagramXml(new TextDecoder().decode(bytes));
  if (!TEXT.test(rel) || bytes.includes(0)) return undefined;
  const text = new TextDecoder().decode(bytes);
  if (INSTRUCTION_FILE.test(rel)) {
    const f = screenAbsorbed([{ id: rel, path: rel, text }])[0]!;
    return {
      risk: f.risk,
      score: 0,
      signals: f.signals,
      rules: [...new Set(f.signals.map((s) => s.rule))],
      reason: f.reason,
    };
  }
  return screenText(text, { format: formatOf("document", rel) });
}

/**
 * atticus defences scan [path] [--json] [--all]: scan a file or folder (default: inputs/ and
 * the wiki folders in sources.yaml) and report risky content: what was found, where, and what
 * Atticus does with the file in an AI step. Prompt and agent files (another team's, before
 * absorb) are flagged only when they try to change Atticus's rules or hide content.
 */
export async function defencesScan(
  root: string,
  path: string | undefined,
  o: { json?: boolean; all?: boolean },
  io: Output,
): Promise<number> {
  const targets: string[] = [];
  if (path) targets.push(isAbsolute(path) ? path : join(root, path));
  else {
    targets.push(join(stateDirOf(root), "inputs"));
    try {
      const op = await loadOrgPack(orgPackDirOf(root));
      for (const w of op.sources.wikis)
        if (w.type === "markdown-folder") targets.push(join(orgPackDirOf(root), w.location));
    } catch {
      // no org pack: inputs only
    }
  }
  const files: { full: string; rel: string }[] = [];
  for (const t of targets) {
    let info;
    try {
      info = await stat(t);
    } catch {
      if (path) {
        io.err(`${path} doesn't exist.`);
        return 2;
      }
      continue;
    }
    const walk = async (d: string) => {
      for (const e of (await readdir(d, { withFileTypes: true })).sort((a, b) =>
        a.name < b.name ? -1 : 1,
      )) {
        if (e.name === ".git" || e.name === "node_modules") continue;
        const full = join(d, e.name);
        if (e.isDirectory()) await walk(full);
        else files.push({ full, rel: relative(root, full).split(sep).join("/") });
      }
    };
    if (info.isDirectory()) await walk(t);
    else files.push({ full: t, rel: relative(root, t).split(sep).join("/") });
  }
  const out: ScannedFile[] = [];
  let skipped = 0;
  for (const f of files) {
    const s = await screenFile(f.full, f.rel).catch(() => undefined);
    if (!s) {
      skipped++;
      continue;
    }
    out.push({
      path: f.rel,
      risk: s.risk,
      action: ACTION[s.risk],
      reason: s.reason,
      rules: s.rules,
      signals: s.signals.map((x) => ({
        rule: x.rule,
        line: x.line,
        excerpt: x.excerpt,
        ...(x.hidden ? { hidden: true } : {}),
        ...(x.encoded ? { encoded: true } : {}),
        ...(x.obfuscated ? { obfuscated: true } : {}),
      })),
    });
  }
  const risky = out.filter((f) => f.risk === "medium" || f.risk === "high");
  if (o.json) {
    io.out(
      JSON.stringify(
        { files: o.all ? out : out.filter((f) => f.risk !== "none"), scanned: out.length, skipped },
        null,
        2,
      ),
    );
    return risky.length ? 1 : 0;
  }
  const shown = o.all ? out : out.filter((f) => f.risk !== "none");
  if (shown.length)
    for (const l of table(
      ["RISK", "FILE", "WHAT ATTICUS DOES", "WHY"],
      shown.map((f) => [f.risk, f.path, f.action, f.reason]),
    ))
      io.out(l);
  for (const f of risky)
    for (const s of f.signals.slice(0, 5))
      io.out(
        `  ${f.path}:${s.line} ${s.rule}${s.hidden ? " (hidden)" : s.encoded ? " (encoded)" : s.obfuscated ? " (disguised)" : ""}: ${s.excerpt}`,
      );
  io.out(
    `Scanned ${out.length} file${out.length === 1 ? "" : "s"}${skipped ? ` (${skipped} not text or documents)` : ""}: ${risky.filter((f) => f.risk === "high").length} high, ${risky.filter((f) => f.risk === "medium").length} medium.`,
  );
  return risky.length ? 1 : 0;
}
