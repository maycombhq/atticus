import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import type { RecordOf } from "@maycombhq/core";
import {
  normalizePath,
  parseDoc,
  readSnowDrafts,
  sectionLines,
  type Doc,
} from "@maycombhq/naysayer";
import { loadPlanContext, type PlanContext } from "./context.js";
import { coverage } from "./words.js";

/**
 * The story bar (plan, M3 exit), measured on the change's stories as they are on disk (so a
 * person's edits count): every gap is covered in the stories or raised by the critic; at least
 * 90% of stories pass the definition of ready with wording-only edits; no story names a
 * system, repo, interface or operation that is in neither the catalog nor the change's design.
 *
 * Definition of ready: the org pack's `testStrategy.definitionOfReady` items, each mapped to a
 * deterministic check by what it talks about (who and outcome, acceptance criteria, systems
 * and repos, dependencies, tests); an item no check covers is listed for a person. A failed
 * check is structural (the story isn't ready); the rubric (title length, placeholders, vague
 * outcomes) is wording only and never fails a story.
 */

export type DorCheck = "who" | "traced" | "criteria" | "systems" | "depends" | "tests";

export interface StoryReport {
  id: string;
  path: string;
  ready: boolean;
  /** Structural problems: the story isn't ready until they are fixed. */
  problems: string[];
  /** Wording-only remarks (rubric). */
  wording: string[];
  /** Names in the story found in neither the catalog nor the design. */
  invented: string[];
}

export interface GapReport {
  id: string;
  what: string;
  coveredBy?: "story" | "critic";
  by?: string;
  covered: boolean;
}

export interface StoryBarResult {
  change: string;
  stories: StoryReport[];
  ready: { passed: number; total: number; rate: number; min: number };
  dor: { item: string; checks: DorCheck[] }[];
  gaps: GapReport[];
  invented: string[];
  /** Eval only: where the stories differ from the expected outline. */
  outline: string[];
  /** Eval only: seeded plan problems that came back. */
  regressions: string[];
  met: boolean;
}

// ------------------------------------------------------------------ eval set

export const StoryEval = z.object({
  change: z.string(),
  minReadyRate: z.number().min(0).max(1).default(0.9),
  stories: z
    .array(
      z.object({
        id: z.string(),
        source: z.string().optional(),
        traces: z.string().optional(),
        systems: z.array(z.string()).default([]),
        repos: z.array(z.string()).default([]),
        operations: z.array(z.string()).default([]),
        records: z.array(z.string()).default([]),
        minCriteria: z.number().int().min(0).default(1),
        tests: z.array(z.string()).optional(),
        dependsOn: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  notPlanned: z.array(z.object({ operation: z.string(), callee: z.string() })).default([]),
  snow: z.array(z.object({ template: z.string(), record: z.string() })).default([]),
  gaps: z
    .array(
      z.object({
        id: z.string(),
        coveredBy: z.enum(["story", "critic"]),
        rule: z.string().optional(),
        record: z.string().optional(),
        artifact: z.string().optional(),
        story: z.string().optional(),
        mentions: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  fixed: z
    .array(
      z.object({
        id: z.string(),
        rule: z.string(),
        artifact: z.string().optional(),
        summaryStartsWith: z.string().optional(),
      }),
    )
    .default([]),
});
export type StoryEval = z.infer<typeof StoryEval>;

// ------------------------------------------------------------------ reading stories

export interface ParsedStory {
  id: string;
  path: string;
  doc: Doc;
  title?: string;
  who?: { asA: string; iWant: string; soThat: string };
  criteria: string[];
  traces?: string;
  systems: string[];
  repos: string[];
  tests: string[];
  dependsOn?: string[];
  interfaces: { id: string; caller?: string; callee?: string; operation?: string }[];
  records: string[];
  text: string;
}

const section = (doc: Doc, re: RegExp) =>
  doc.sections.find((s) => s.level === 2 && re.test(s.heading));
const body = (doc: Doc, re: RegExp) => {
  const s = section(doc, re);
  return s ? sectionLines(doc, s).map((l) => l.text) : undefined;
};
const bullets = (lines: string[] = []) =>
  lines.map((l) => /^\s*[-*]\s+(.*)$/.exec(l)?.[1]?.trim()).filter((x): x is string => !!x);
const list = (s: string) =>
  s
    .split(/[,;]/)
    .map((x) => x.trim())
    .filter((x) => x && !/^(none|nothing)\.?$/i.test(x));

export function parseStory(path: string, text: string): ParsedStory {
  const doc = parseDoc(path, text);
  const id = path.replace(/^stories\//, "").replace(/\.md$/, "");
  const h1 = doc.sections.find((s) => s.level === 1);
  const firstH2 = doc.sections.find((s) => s.level === 2);
  const intro = h1
    ? doc.lines.slice(h1.line, firstH2 ? firstH2.line - 1 : doc.lines.length).join(" ")
    : "";
  const w = /\bas an?\s+(.+?)\s*,?\s+i want\s+(.+?)\s*,?\s+so that\s+(.+?)\s*$/i.exec(
    intro.replace(/\s+/g, " ").trim(),
  );
  const sysLine = (body(doc, /^systems and repos$/i) ?? []).join(" ");
  const m = /^(.*?)(?:\((.*)\))?\s*$/.exec(sysLine);
  const links = bullets(body(doc, /^links$/i));
  const interfaces = links.flatMap((l) => {
    const x = /^Interface\s+(\S+):\s*(\S+)\s*→\s*(\S+)\s+([A-Z]+\s+\S+)/.exec(l);
    return x
      ? [{ id: x[1]!.replace(/[()]/g, ""), caller: x[2]!, callee: x[3]!, operation: x[4]! }]
      : [];
  });
  const records = links.flatMap((l) => {
    const x = /^Record\s+([a-z0-9][a-z0-9._-]*)/.exec(l);
    return x ? [x[1]!.replace(/[.:]$/, "")] : [];
  });
  const dep = body(doc, /^depends on$/i);
  return {
    id,
    path,
    doc,
    ...(h1 ? { title: h1.heading } : {}),
    ...(w ? { who: { asA: w[1]!, iWant: w[2]!, soThat: w[3]! } } : {}),
    criteria: bullets(body(doc, /acceptance criteria/i)),
    ...(body(doc, /^traces to$/i)?.[0] ? { traces: body(doc, /^traces to$/i)![0]!.trim() } : {}),
    systems: list(m?.[1] ?? ""),
    repos: list(m?.[2] ?? ""),
    tests: list((body(doc, /^tests$/i) ?? []).join(" ")),
    ...(dep ? { dependsOn: list(dep.join(" ")) } : {}),
    interfaces,
    records,
    text: doc.lines.join("\n"),
  };
}

export async function readStories(dir: string): Promise<ParsedStory[]> {
  const out: ParsedStory[] = [];
  for (const f of (await readdir(join(dir, "stories")).catch(() => [] as string[]))
    .filter((x) => x.endsWith(".md"))
    .sort())
    out.push(parseStory(`stories/${f}`, await readFile(join(dir, "stories", f), "utf8")));
  return out;
}

// ------------------------------------------------------------------ definition of ready

const GWT = /\bgiven\b[\s\S]*\bwhen\b[\s\S]*\bthen\b/i;
const TEST_TYPES = new Set([
  "unit",
  "contract",
  "integration",
  "e2e",
  "regression",
  "performance",
  "security",
  "accessibility",
  "data-migration",
]);

/** Which deterministic checks a definition-of-ready item asks for. */
export function dorChecks(item: string): DorCheck[] {
  const k = item.toLowerCase();
  const out: DorCheck[] = [];
  if (/\bwho\b|for whom|\buser\b|outcome|value|brief|trace/.test(k)) out.push("who", "traced");
  if (/acceptance|given|criteria/.test(k)) out.push("criteria");
  if (/system|repo/.test(k)) out.push("systems");
  if (/depend/.test(k)) out.push("depends");
  if (/\btest/.test(k)) out.push("tests");
  return out;
}

interface Known {
  systems: Set<string>;
  repos: Set<string>;
  names: Set<string>;
  operations: Set<string>;
  interfaces: Set<string>;
  records: Set<string>;
  hops: { caller: string; callee: string; op: string }[];
}

function knownNames(ctx: PlanContext, storyIds: string[]): Known {
  const op = (method: string, path: string) => `${method.toUpperCase()} ${normalizePath(path)}`;
  const profile = ctx.lifecycle.orgPack.profiles.flatMap((p) => p.profile?.systems ?? []);
  const systems = new Set([
    ...ctx.records.filter((r) => r.kind === "System").map((r) => r.id),
    ...profile.map((s) => s.id),
  ]);
  const names = new Set<string>([
    ...ctx.records.map((r) => r.id),
    ...storyIds,
    ...systems,
    ...ctx.knownRepos,
  ]);
  const operations = new Set<string>();
  for (const r of ctx.records) {
    if (r.kind === "Endpoint") {
      const e = r as RecordOf<"Endpoint">;
      if (e.method && e.pathOrTopic) operations.add(op(e.method, e.pathOrTopic));
    }
    if (r.kind === "Interface") {
      const i = r as RecordOf<"Interface">;
      if (i.method && i.normalizedPath) operations.add(op(i.method, i.normalizedPath));
    }
  }
  const hops = ctx.hops.map((h) => ({
    caller: h.caller,
    callee: h.callee,
    op: h.method && h.path ? op(h.method, h.path) : h.operation,
  }));
  for (const h of ctx.hops) {
    names.add(h.caller);
    names.add(h.callee);
    if (h.method && h.path) operations.add(op(h.method, h.path));
    for (const n of ctx.notes(h))
      for (const g of n.text.matchAll(/\bgw-[a-z0-9-]+\b/g)) names.add(g[0]);
  }
  const records = new Set([
    ...ctx.records.filter((r) => r.kind === "Table" || r.kind === "Column").map((r) => r.id),
    ...ctx.data.map((d) => d.tableId),
  ]);
  for (const d of ctx.data) {
    names.add(d.store);
    names.add(d.tableId);
  }
  return {
    systems,
    repos: ctx.knownRepos,
    names,
    operations,
    interfaces: new Set(ctx.records.filter((r) => r.kind === "Interface").map((r) => r.id)),
    records,
    hops,
  };
}

const COMPONENT_LIKE =
  /(?<![\w-])[a-z][a-z0-9]*(?:-[a-z0-9]+)*-(?:api|svc|service|bff|ui|db|job|engine|gateway|app|worker)(?![\w-])/g;
const OPERATION = /\b(GET|POST|PUT|PATCH|DELETE|HEAD)\s+(\/[^\s,;)]*)/g;

function invented(s: ParsedStory, known: Known): string[] {
  const out = new Set<string>();
  for (const x of s.systems) if (!known.systems.has(x)) out.add(`system ${x}`);
  for (const x of s.repos) if (!known.repos.has(x)) out.add(`repo ${x}`);
  for (const r of s.records) if (!known.records.has(r)) out.add(`record ${r}`);
  for (const i of s.interfaces) {
    if (i.id !== "new" && !known.interfaces.has(i.id)) out.add(`interface ${i.id}`);
    if (i.id === "new") {
      const [m, p] = (i.operation ?? "").split(/\s+/);
      const opKey = m && p ? `${m.toUpperCase()} ${normalizePath(p)}` : "";
      if (!known.hops.some((h) => h.caller === i.caller && h.callee === i.callee && h.op === opKey))
        out.add(`interface ${i.caller} → ${i.callee} ${i.operation}`);
    }
  }
  const prose = s.doc.lines.join("\n").replace(/<!--[\s\S]*?-->/g, "");
  for (const m of prose.matchAll(COMPONENT_LIKE)) if (!known.names.has(m[0])) out.add(m[0]);
  for (const m of prose.matchAll(OPERATION)) {
    const key = `${m[1]} ${normalizePath(m[2]!.replace(/[.:]+$/, ""))}`;
    if (!known.operations.has(key)) out.add(`${m[1]} ${m[2]}`);
  }
  return [...out].sort();
}

function checkStory(
  ctx: PlanContext,
  s: ParsedStory,
  checks: Set<DorCheck>,
  known: Known,
): StoryReport {
  const problems: string[] = [];
  const wording: string[] = [];
  if (checks.has("who") && !s.who) problems.push("no As a … I want … so that … line");
  if (checks.has("traced")) {
    const m = s.traces ? /^(\S+?):(\d+)/.exec(s.traces) : null;
    const doc = m ? ctx.files.docs.get(m[1]!) : undefined;
    if (!m) problems.push("doesn't trace to the brief, proposal or a spec");
    else if (!doc || Number(m[2]) > doc.lines.length)
      problems.push(`traces to ${s.traces}, which isn't in the change`);
  }
  if (checks.has("criteria")) {
    const gwt = s.criteria.filter((c) => GWT.test(c));
    if (gwt.length === 0) problems.push("no acceptance criteria in Given/When/Then form");
    for (const c of s.criteria.filter((x) => !GWT.test(x)))
      wording.push(`criterion not in Given/When/Then form: ${c.slice(0, 60)}`);
  }
  if (checks.has("systems")) {
    if (s.systems.length === 0) problems.push("names no system");
    if (s.repos.length === 0) problems.push("names no repo");
  }
  if (checks.has("depends") && !s.dependsOn) problems.push('no "Depends on" section');
  if (checks.has("tests")) {
    if (s.tests.length === 0) problems.push("names no test kinds");
    for (const t of s.tests) if (!TEST_TYPES.has(t)) problems.push(`unknown test kind ${t}`);
  }
  const bad = invented(s, known);
  if (bad.length)
    problems.push(`names what neither the catalog nor the design has: ${bad.join(", ")}`);
  // Rubric: wording only.
  if (!s.title) wording.push("no title");
  else {
    if (s.title.length > 80) wording.push("title is over 80 characters");
    if (/^as an?\b/i.test(s.title))
      wording.push("title is the story sentence; give it a short title");
  }
  if (/\b(TBD|TODO|FIXME)\b|\?\?\?/.test(s.text))
    wording.push("has a placeholder (TBD, TODO or ???)");
  if (s.who && s.who.soThat.split(/\s+/).length < 3) wording.push("the outcome is vague");
  return { id: s.id, path: s.path, ready: problems.length === 0, problems, wording, invented: bad };
}

// ------------------------------------------------------------------ critic findings

interface RaisedFinding {
  rule: string;
  kind: string;
  severity: string;
  artifact: string;
  records: string[];
  summary: string;
  question?: string;
}

/** Findings of the newest round at every gate in the change's review folder. */
export async function newestFindings(dir: string): Promise<RaisedFinding[]> {
  const out: RaisedFinding[] = [];
  const base = join(dir, "review");
  for (const gate of (await readdir(base).catch(() => [] as string[])).sort()) {
    const rounds = (await readdir(join(base, gate)).catch(() => [] as string[]))
      .filter((r) => /^\d+$/.test(r))
      .sort((a, b) => Number(a) - Number(b));
    const last = rounds.at(-1);
    if (!last) continue;
    for (const f of (await readdir(join(base, gate, last)))
      .filter((x) => /\.ya?ml$/.test(x))
      .sort()) {
      let d: Record<string, unknown>;
      try {
        d = parse(await readFile(join(base, gate, last, f), "utf8")) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (!d || typeof d.rule !== "string") continue;
      const loc = (d.locator ?? {}) as { record?: string };
      const ev = (Array.isArray(d.evidence) ? d.evidence : []) as { record?: string }[];
      out.push({
        rule: d.rule,
        kind: String(d.kind ?? ""),
        severity: String(d.severity ?? ""),
        artifact: String(d.artifact ?? ""),
        records: [loc.record, ...ev.map((e) => e.record)].filter((x): x is string => !!x),
        summary: String(d.summary ?? ""),
        ...(typeof (d.question as { text?: unknown })?.text === "string"
          ? { question: (d.question as { text: string }).text }
          : {}),
      });
    }
  }
  return out;
}

// ------------------------------------------------------------------ the bar

const MIN_READY = 0.9;

export async function storyBar(
  root: string,
  changeId: string,
  o: { eval?: StoryEval } = {},
): Promise<StoryBarResult> {
  const ctx = await loadPlanContext(root, changeId, { requireApprovedDesign: false });
  const stories = await readStories(ctx.dir);
  const items = ctx.lifecycle.orgPack.testStrategy.definitionOfReady;
  const dor = items.map((item) => ({ item, checks: dorChecks(item) }));
  const checks = new Set<DorCheck>(["who", "criteria", ...dor.flatMap((d) => d.checks)]);
  const known = knownNames(
    ctx,
    stories.map((s) => s.id),
  );
  const reports = stories.map((s) => checkStory(ctx, s, checks, known));
  const passed = reports.filter((r) => r.ready).length;
  const min = o.eval?.minReadyRate ?? MIN_READY;
  const rate = reports.length ? passed / reports.length : 0;
  const findings = await newestFindings(ctx.dir);

  const gaps: GapReport[] = [];
  const outline: string[] = [];
  const regressions: string[] = [];
  if (o.eval) {
    const ev = o.eval;
    for (const g of ev.gaps) {
      if (g.coveredBy === "critic") {
        const f = findings.find(
          (x) =>
            x.rule === g.rule &&
            (!g.record || x.records.includes(g.record)) &&
            (!g.artifact || x.artifact === g.artifact),
        );
        gaps.push({
          id: g.id,
          what: `${g.rule}${g.record ? ` on ${g.record}` : ""}`,
          coveredBy: "critic",
          covered: !!f,
          ...(f ? { by: f.summary } : {}),
        });
      } else {
        const s = stories.find((x) => x.id === g.story);
        const ok = !!s && g.mentions.every((m) => s.text.toLowerCase().includes(m.toLowerCase()));
        gaps.push({
          id: g.id,
          what: `story ${g.story} mentions ${g.mentions.join(", ")}`,
          coveredBy: "story",
          covered: ok,
          ...(ok ? { by: g.story! } : {}),
        });
      }
    }
    for (const e of ev.stories) {
      const s = stories.find((x) => x.id === e.id);
      if (!s) {
        outline.push(`${e.id}: missing`);
        continue;
      }
      const same = (what: string, want: string[], got: string[]) => {
        if (JSON.stringify([...want].sort()) !== JSON.stringify([...got].sort()))
          outline.push(`${e.id}: ${what} ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
      };
      same("systems", e.systems, s.systems);
      same("repos", e.repos, s.repos);
      same("records", e.records, s.records);
      same(
        "operations",
        e.operations,
        s.interfaces.map((i) => i.operation ?? ""),
      );
      if (e.tests) same("tests", e.tests, s.tests);
      same("depends on", e.dependsOn, s.dependsOn ?? []);
      if (e.traces && !s.traces?.startsWith(e.traces))
        outline.push(`${e.id}: traces to ${s.traces ?? "nothing"}, expected ${e.traces}`);
      const gwt = s.criteria.filter((c) => GWT.test(c)).length;
      if (gwt < e.minCriteria)
        outline.push(`${e.id}: ${gwt} criteria, expected at least ${e.minCriteria}`);
    }
    for (const s of stories)
      if (!ev.stories.some((e) => e.id === s.id))
        outline.push(`${s.id}: not in the expected outline`);
    const index = ctx.files.docs.get("stories.md")?.raw ?? "";
    for (const n of ev.notPlanned)
      if (!index.includes(n.operation) || !index.includes(n.callee))
        outline.push(`stories.md doesn't say why ${n.operation} to ${n.callee} isn't planned`);
    const drafts = readSnowDrafts(ctx.files);
    const templates = ctx.lifecycle.orgPack.serviceRequests;
    for (const w of ev.snow) {
      const t = templates.find((x) => x.id === w.template);
      const names = t ? [t.name, t.requestType, t.id].map((x) => x.toLowerCase()) : [w.template];
      if (
        !drafts.some(
          (d) =>
            names.some((n) => d.heading.toLowerCase().includes(n)) && d.text.includes(w.record),
        )
      )
        outline.push(`snow.md has no ${w.template} draft for ${w.record}`);
    }
    for (const x of ev.fixed) {
      const back = findings.filter(
        (f) =>
          f.rule === x.rule &&
          (!x.artifact || f.artifact.startsWith(x.artifact)) &&
          (!x.summaryStartsWith || f.summary.startsWith(x.summaryStartsWith)),
      );
      for (const f of back) regressions.push(`${x.id}: ${f.artifact}: ${f.summary}`);
    }
  } else {
    // Without an eval set: the open questions of the brief and proposal, and the critic's gaps.
    for (const q of ctx.questions) {
      const inStory = stories.find((s) => coverage(q.text, s.text) >= 0.6);
      const byCritic = findings.find(
        (f) => coverage(q.text, `${f.summary} ${f.question ?? ""}`) >= 0.6,
      );
      gaps.push({
        id: `${q.file}:${q.line}`,
        what: q.text,
        covered: !!inStory || !!byCritic,
        ...(inStory
          ? { coveredBy: "story" as const, by: inStory.id }
          : byCritic
            ? { coveredBy: "critic" as const, by: byCritic.summary }
            : {}),
      });
    }
    for (const f of findings.filter((x) => x.kind === "knowledge-gap"))
      gaps.push({
        id: `${f.rule}${f.records[0] ? `:${f.records[0]}` : ""}`,
        what: f.summary,
        coveredBy: "critic",
        covered: true,
        by: f.rule,
      });
  }
  const inventedAll = [...new Set(reports.flatMap((r) => r.invented.map((x) => `${r.id}: ${x}`)))];
  const met =
    reports.length > 0 &&
    rate >= min &&
    gaps.every((g) => g.covered) &&
    inventedAll.length === 0 &&
    outline.length === 0 &&
    regressions.length === 0;
  return {
    change: ctx.change.id,
    stories: reports,
    ready: { passed, total: reports.length, rate, min },
    dor,
    gaps,
    invented: inventedAll,
    outline,
    regressions,
    met,
  };
}

/** Read an eval file (expected/stories.yaml). */
export async function readStoryEval(path: string): Promise<StoryEval> {
  return StoryEval.parse(parse(await readFile(path, "utf8")));
}
