import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, relative, sep } from "node:path";
import { parse } from "yaml";
import {
  changeBranch,
  ChecklistPack,
  Finding,
  normalizePath,
  taskBranch,
  type ChecklistRule,
  type RecordOf,
} from "@maycombhq/core";
import { loadPlanContext, type PlanContext } from "@maycombhq/planner";
import { readChangeRepos, type GitRunner } from "@maycombhq/workspace";
import { TestgenError } from "./errors.js";
import { readManifests, type ManifestFile } from "./generate.js";
import { writeGateRound, type RoundWrite } from "./rounds.js";
import { endpointFor } from "./spec.js";
import { loadStory, type StoryContext } from "./story.js";
import { repoPlace } from "./targets.js";
import { slug } from "./words.js";

/**
 * Traceability: requirement (spec scenario) → story → acceptance criterion → test (generated,
 * from the change's test manifests, or found in the repos: test files that name a story id, a
 * scenario or an endpoint path the change touches) → code (files each story's tasks changed:
 * Run with AI records and git diffs of the task branches, through an injectable git runner) →
 * catalog records → feature. Gaps become C3 findings on the built-in `trace` gate, so the
 * lifecycle and the critic read them like any other gate. Files and git only; no AI.
 */

export const TRACE_GATE = "trace";

export interface TraceRequirement {
  file: string;
  line: number;
  requirement: string;
  scenario?: string;
  /** "<file>:<line>" of the scenario, or of the requirement when it has none. */
  key: string;
}

export interface TraceTest {
  kind: "generated" | "found";
  /** Metarepo-relative path. */
  path: string;
  repo?: string;
  /** Generated: the case ids the file holds. */
  cases?: string[];
  /** Found: what the file names. */
  refs?: { stories: string[]; scenarios: string[]; endpoints: string[] };
}

export interface TraceRow {
  requirement?: TraceRequirement;
  story?: string;
  criterion?: { n: number; text: string };
  tests: TraceTest[];
  code: string[];
  records: string[];
  features: string[];
}

export type TraceGapKind =
  | "requirement-without-story"
  | "story-without-test"
  | "test-without-requirement"
  | "endpoint-without-test";

export interface TraceGap {
  kind: TraceGapKind;
  subject: string;
  summary: string;
  artifact: string;
  locator: { line?: number; heading?: string; record?: string };
  evidence: Finding["evidence"];
}

export interface TraceMatrix {
  change: string;
  requirements: TraceRequirement[];
  stories: string[];
  rows: TraceRow[];
  gaps: TraceGap[];
  /** Test files found in the repos that name something of this change. */
  found: TraceTest[];
  problems: string[];
}

export interface TraceOptions {
  /** Runs git for the task branches' diffs; default none (only Run with AI records are read). */
  git?: GitRunner;
}

const TEST_FILE =
  /(^|\/)(src\/test|tests?|__tests__|spec|specs|e2e)\/|\.(test|spec)\.[a-z]+$|Tests?\.(java|kt|cs|py|go|scala)$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$|\.feature$/;
const SKIP = new Set([
  "node_modules",
  ".git",
  "target",
  "build",
  "dist",
  ".gradle",
  ".idea",
  ".atticus",
]);
const posix = (p: string) => p.split(sep).join("/");
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function walk(dir: string, rel = "", out: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(join(dir, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!SKIP.has(e.name)) await walk(dir, p, out);
    } else if (e.isFile() && TEST_FILE.test(p)) out.push(p);
  }
  return out;
}

/** A regex for an endpoint path in test code: parameters in any style, then a boundary. */
function pathPattern(path: string): RegExp {
  const segs = normalizePath(path).split("/").filter(Boolean);
  const body = segs.map((s) => (s === "{}" ? "[^/\"'`\\s?]+" : escape(s))).join("/");
  return new RegExp(`/${body}(?=["'\`?\\s)]|$)`, "m");
}

function requirementsOf(ctx: PlanContext): TraceRequirement[] {
  const out: TraceRequirement[] = [];
  for (const r of ctx.requirements) {
    if (!r.scenarios.length)
      out.push({ file: r.file, line: r.line, requirement: r.name, key: `${r.file}:${r.line}` });
    for (const s of r.scenarios)
      out.push({
        file: r.file,
        line: s.line,
        requirement: r.name,
        scenario: s.name,
        key: `${r.file}:${s.line}`,
      });
  }
  return out;
}

async function storyIds(dir: string): Promise<string[]> {
  return (await readdir(join(dir, "stories")).catch(() => [] as string[]))
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""))
    .sort();
}

/** Files each story's tasks changed: task-run.yaml `changed`, then the task branch's diff. */
async function codeOf(
  ctx: PlanContext,
  story: StoryContext,
  dirOf: (repo: string) => string | undefined,
  git: GitRunner | undefined,
  problems: string[],
  notStarted: Set<string>,
): Promise<string[]> {
  const out = new Set<string>();
  for (const t of story.tasks) {
    const text = await readFile(join(ctx.dir, "tasks", t.id, "task-run.yaml"), "utf8").catch(
      () => undefined,
    );
    if (text) {
      const run = parse(text) as { changed?: unknown; repo?: unknown };
      for (const f of Array.isArray(run.changed) ? run.changed : [])
        out.add(`${t.repo}:${String(f)}`);
    }
    const dir = dirOf(t.repo);
    if (!git || !dir || !existsSync(join(dir, ".git"))) continue;
    try {
      const r = await git(
        [
          "diff",
          "--name-only",
          `${changeBranch(ctx.change.id)}...${taskBranch(ctx.change.id, t.id)}`,
        ],
        dir,
      );
      for (const f of r.stdout
        .split("\n")
        .map((x) => x.trim())
        .filter(Boolean))
        out.add(`${t.repo}:${f}`);
    } catch (e) {
      // A task whose branch doesn't exist yet hasn't been started: that is not a problem.
      const branch = `refs/heads/${taskBranch(ctx.change.id, t.id)}`;
      const exists = await git(["rev-parse", "--verify", "--quiet", branch], dir).then(
        () => true,
        () => false,
      );
      if (exists)
        problems.push(
          `${t.repo}: no diff for task ${t.id} (${(e as Error).message.split("\n")[0]})`,
        );
      else if (!text) notStarted.add(`${t.repo} ${t.id}`);
    }
  }
  return [...out].sort();
}

export async function traceMatrix(
  root: string,
  changeId: string,
  o: TraceOptions = {},
): Promise<TraceMatrix> {
  const ctx = await loadPlanContext(root, changeId, { requireApprovedDesign: false }).catch(
    (e: Error) => {
      throw new TestgenError("not-found", e.message);
    },
  );
  const problems: string[] = [];
  const notStarted = new Set<string>();
  const requirements = requirementsOf(ctx);
  const stories: StoryContext[] = [];
  for (const id of await storyIds(ctx.dir)) stories.push(await loadStory(ctx, id));
  const { manifests, problems: mp } = await readManifests(ctx.dir);
  problems.push(...mp);
  const manifestOf = new Map<string, ManifestFile>(manifests.map((m) => [m.story, m]));
  const changeRepos = await readChangeRepos(root, changeId);

  // ---- tests found in the repos
  const repos = new Set<string>([
    ...(changeRepos?.repos.map((r) => r.id) ?? []),
    ...stories.flatMap((s) => s.repos),
  ]);
  const generatedPaths = new Set(manifests.flatMap((m) => m.files.map((f) => f.path)));
  const restHops = ctx.hops.filter((h) => h.method && h.path?.startsWith("/"));
  const scenarioNames = requirements.filter(
    (r) => r.scenario && r.scenario.split(/\s+/).length >= 2,
  );
  const found: TraceTest[] = [];
  const dirs = new Map<string, string>();
  for (const repo of [...repos].sort()) {
    const seen = new Set<string>();
    const places = [
      ...new Set(
        stories
          .filter((s) => s.repos.includes(repo) || s.tasks.some((t) => t.repo === repo))
          .map((s) => repoPlace(ctx, s, repo, changeRepos))
          .filter((p) => p.dir)
          .map((p) => p.dir!),
      ),
    ];
    const fallback = repoPlace(
      ctx,
      { tasks: [] } as unknown as StoryContext,
      repo,
      changeRepos,
    ).dir;
    if (fallback && !places.includes(fallback)) places.push(fallback);
    if (places[0]) dirs.set(repo, places[0]);
    for (const dir of places) {
      for (const rel of await walk(dir)) {
        if (seen.has(rel)) continue;
        seen.add(rel);
        const path = posix(relative(root, join(dir, rel)));
        if (generatedPaths.has(path)) continue;
        const text = await readFile(join(dir, rel), "utf8").catch(() => "");
        if (text.length > 512 * 1024) continue;
        const refs = {
          stories: stories
            .filter((s) => new RegExp(`\\b${escape(s.id)}\\b`).test(text))
            .map((s) => s.id),
          scenarios: scenarioNames
            .filter((r) => text.toLowerCase().includes(r.scenario!.toLowerCase()))
            .map((r) => r.key),
          endpoints: [
            ...new Set(
              restHops
                .filter((h) => pathPattern(h.path!).test(text))
                .map((h) => `${h.method} ${h.path}`),
            ),
          ],
        };
        if (refs.stories.length || refs.scenarios.length || refs.endpoints.length)
          found.push({ kind: "found", path, repo, refs });
      }
    }
  }

  // ---- rows
  const capabilities = ctx.records.filter(
    (r): r is RecordOf<"Capability"> => r.kind === "Capability",
  );
  const rows: TraceRow[] = [];
  const gaps: TraceGap[] = [];
  const coveredReqs = new Set<string>();
  for (const s of stories) {
    const m = manifestOf.get(s.id);
    const gen = (m?.files ?? []).map((f) => ({
      kind: "generated" as const,
      path: f.path,
      repo: f.repo,
      cases: f.cases,
    }));
    const records = [
      ...new Set([
        ...s.hops.flatMap((h) => {
          const ep = endpointFor(ctx, h);
          const i = /^if-/.test(h.id) && ctx.get("Interface", h.id) ? [h.id] : [];
          return [
            ...i,
            ...(ep ? [ep.id] : []),
            ...(!i.length && !ep ? [`new: ${h.caller} → ${h.callee} ${h.operation.trim()}`] : []),
          ];
        }),
        ...s.data.map((d) => (ctx.get("Table", d.tableId) ? d.tableId : `new: table ${d.tableId}`)),
      ]),
    ];
    const ids = new Set(records);
    const features = capabilities
      .filter((c) => [...c.entryPoints, ...c.records].some((r) => ids.has(r)))
      .map((c) => c.id)
      .sort();
    const code = await codeOf(ctx, s, (r) => dirs.get(r), o.git, problems, notStarted);
    const storyFound = found.filter((f) => f.refs!.stories.includes(s.id));
    for (const c of s.criteria) {
      const req = c.trace
        ? requirements.find((r) => r.key === `${c.trace!.file}:${c.trace!.line}`)
        : undefined;
      if (req) coveredReqs.add(req.key);
      const caseId = `acceptance.c${c.n}`;
      // The criterion's scenario, and the API cases that check it (an error it names).
      const linked = new Set(
        (m?.cases ?? [])
          .filter((x) => x.id === caseId || (x.type !== "acceptance" && x.criterion === c.n))
          .map((x) => x.id),
      );
      const tests = [
        ...gen.filter((g) => g.cases.some((x) => linked.has(x))),
        ...found.filter(
          (f) => (req && f.refs!.scenarios.includes(req.key)) || f.refs!.stories.includes(s.id),
        ),
      ];
      rows.push({
        ...(req ? { requirement: req } : {}),
        story: s.id,
        criterion: { n: c.n, text: c.text },
        tests,
        code,
        records,
        features,
      });
    }
    if (s.tracesTo)
      for (const r of requirements.filter(
        (x) => x.key === s.tracesTo || `${x.file}:${x.line}` === s.tracesTo,
      ))
        coveredReqs.add(r.key);
    const other = gen.filter(
      (g) => !g.cases.every((x) => x.startsWith("acceptance.")) || !s.criteria.length,
    );
    if (other.length || !s.criteria.length)
      rows.push({ story: s.id, tests: other, code, records, features });

    // Gaps about the story.
    const hasTest =
      gen.length > 0 ||
      storyFound.length > 0 ||
      found.some((f) =>
        f.refs!.scenarios.some((k) =>
          s.criteria.some((c) => c.trace && `${c.trace.file}:${c.trace.line}` === k),
        ),
      );
    if (!hasTest)
      gaps.push({
        kind: "story-without-test",
        subject: s.id,
        summary: `Story ${s.id} has no test: none generated and none in its repos names it.`,
        artifact: s.path,
        locator: { heading: s.title },
        evidence: [{ source: "artifact", path: s.path, line: 1 }],
      });
    const traced = s.criteria.some((c) => c.trace) || !!s.tracesTo;
    if (gen.length && !traced)
      gaps.push({
        kind: "test-without-requirement",
        subject: s.id,
        summary: `The tests of ${s.id} trace to no requirement: its criteria match no spec scenario.`,
        artifact: s.path,
        locator: { heading: s.title },
        evidence: [{ source: "artifact", path: s.path, line: 1 }],
      });
  }
  for (const r of requirements)
    if (!coveredReqs.has(r.key)) {
      rows.push({ requirement: r, tests: [], code: [], records: [], features: [] });
      gaps.push({
        kind: "requirement-without-story",
        subject: r.key,
        summary: `${r.scenario ? `Scenario "${r.scenario}" of requirement "${r.requirement}"` : `Requirement "${r.requirement}"`} has no story.`,
        artifact: r.file,
        locator: { line: r.line },
        evidence: [{ source: "artifact", path: r.file, line: r.line }],
      });
    }
  for (const f of found)
    if (!f.refs!.stories.length && !f.refs!.scenarios.length)
      gaps.push({
        kind: "test-without-requirement",
        subject: f.path,
        summary: `${f.path.split("/").pop()} in ${f.repo} tests ${f.refs!.endpoints.join(", ")} but names no story or spec scenario.`,
        artifact: "tests",
        locator: { heading: f.path },
        evidence: [{ source: "code", repo: f.repo, path: f.path }],
      });

  // Endpoints the change adds or changes, with no API or contract test.
  for (const h of restHops.filter((x) => /^planned-(new|modify)$/.test(x.status))) {
    const p = normalizePath(h.path!);
    const generated = manifests.some((m) =>
      m.cases.some(
        (c) =>
          (c.type === "api" || c.type === "contract") &&
          c.method === h.method &&
          c.path &&
          normalizePath(c.path) === p,
      ),
    );
    const inRepo = found.some((f) => f.refs!.endpoints.includes(`${h.method} ${h.path}`));
    if (generated || inRepo) continue;
    gaps.push({
      kind: "endpoint-without-test",
      subject: `${h.caller}-${h.callee}-${h.method}-${h.path}`,
      summary: `${h.method} ${h.path} (${h.caller} to ${h.callee}, ${h.status}) has no API or contract test.`,
      artifact: "interfaces.md",
      locator: { line: h.line },
      evidence: [{ source: "artifact", path: "interfaces.md", line: h.line }],
    });
  }

  if (notStarted.size)
    problems.push(`Not started yet (no task branch): ${[...notStarted].sort().join(", ")}.`);
  return {
    change: ctx.change.id,
    requirements,
    stories: stories.map((s) => s.id),
    rows,
    gaps: gaps.sort((a, b) => a.kind.localeCompare(b.kind) || a.subject.localeCompare(b.subject)),
    found,
    problems,
  };
}

// ------------------------------------------------------------------ findings

const RULES_FILE = fileURLToPath(new URL("../rules/trace.yaml", import.meta.url));

export async function loadTraceRules(): Promise<Map<string, ChecklistRule>> {
  const pack = ChecklistPack.parse(parse(await readFile(RULES_FILE, "utf8")));
  return new Map(pack.rules.map((r) => [r.id, r]));
}

const FIX: Record<TraceGapKind, string> = {
  "requirement-without-story":
    "Plan a story for the scenario (atticus plan stories), or take the scenario out of the spec.",
  "story-without-test":
    "Generate its tests (atticus tests generate) or write one that names the story or its scenarios.",
  "endpoint-without-test":
    "Link the interface to a story and generate its API and contract tests, or write a test that calls it.",
  "test-without-requirement":
    "Trace the story to a spec scenario, add the requirement to the spec, or remove the test.",
};

/** The gaps as C3 findings on the trace gate (round 1; the round writer numbers them). */
export async function traceFindings(m: TraceMatrix, now: string): Promise<Finding[]> {
  const rules = await loadTraceRules();
  return m.gaps.map((g) => {
    const rule = rules.get(`trace.${g.kind}`)!;
    return Finding.parse({
      schemaVersion: 1,
      id: `${g.kind}-${slug(g.subject)}`.slice(0, 120).replace(/-+$/, ""),
      kind: "issue",
      change: m.change,
      gate: TRACE_GATE,
      round: 1,
      rule: rule.id,
      layer: rule.layer,
      lens: rule.lens,
      severity: rule.severity,
      artifact: g.artifact,
      locator: g.locator,
      summary: g.summary.length <= 200 ? g.summary : `${g.summary.slice(0, 197)}...`,
      why: rule.description ?? rule.title,
      fix: { text: FIX[g.kind] },
      evidence: g.evidence,
      waivable: false,
      state: "open",
      createdAt: now,
    });
  });
}

/** Write the gaps as a round on the trace gate (only when something changed). */
export async function writeTraceFindings(
  root: string,
  m: TraceMatrix,
  now: string,
): Promise<RoundWrite> {
  return writeGateRound(root, m.change, TRACE_GATE, await traceFindings(m, now), now);
}

// ------------------------------------------------------------------ exports

function cells(r: TraceRow): string[] {
  return [
    r.requirement
      ? `${r.requirement.requirement} (${r.requirement.file}:${r.requirement.line})`
      : "",
    r.requirement?.scenario ?? "",
    r.story ?? "",
    r.criterion ? `${r.criterion.n}. ${r.criterion.text}` : r.story ? "(story)" : "",
    r.tests.map((t) => `${t.path}${t.kind === "found" ? " (found)" : ""}`).join("; "),
    r.code.join("; "),
    r.records.join("; "),
    r.features.join("; "),
  ];
}

const HEAD = [
  "Requirement",
  "Scenario",
  "Story",
  "Criterion",
  "Tests",
  "Code",
  "Records",
  "Features",
];

export function matrixMarkdown(m: TraceMatrix): string {
  const md = (s: string) => s.replace(/\|/g, "\\|") || " ";
  const lines = [
    `# Traceability: ${m.change}`,
    "",
    `| ${HEAD.join(" | ")} |`,
    `| ${HEAD.map(() => "---").join(" | ")} |`,
    ...m.rows.map((r) => `| ${cells(r).map(md).join(" | ")} |`),
    "",
    m.gaps.length ? "## Gaps" : "No gaps.",
    ...(m.gaps.length ? ["", ...m.gaps.map((g) => `- ${g.kind}: ${g.summary}`)] : []),
  ];
  return `${lines.join("\n")}\n`;
}

export function matrixCsv(m: TraceMatrix): string {
  const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return `${[HEAD.map((h) => h.toLowerCase()), ...m.rows.map(cells)].map((r) => r.map(q).join(",")).join("\n")}\n`;
}
