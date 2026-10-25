import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { readDraftPairs, type DraftCapture, type DraftPair } from "./drafted.js";

/**
 * H3: how much people changed what Atticus drafted, per merged change and stage, and whether
 * that falls over time. Deterministic: read from the kept pairs (`stage/<stage>.drafted/` and
 * `.merged/`, H1), never from the Git host or a model. H2 reads the same pairs to put the
 * closest past corrections in a new draft's prompt.
 */

export const LEARN_SCHEMA_VERSION = 1;

/** One line-level edit script: equal, removed (draft only) and added (merged only) lines. */
type Op = { op: "=" | "-" | "+"; line: string };

/** The largest table the exact diff builds; beyond it lines are matched as multisets. */
const MAX_CELLS = 4_000_000;

const lines = (text: string | undefined): string[] => {
  if (text === undefined || text === "") return [];
  const ls = text.replace(/\r\n/g, "\n").split("\n");
  if (ls[ls.length - 1] === "") ls.pop();
  return ls;
};

/** A longest-common-subsequence line diff (deterministic, ties prefer removals first). */
export function lineDiff(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  if (n * m > MAX_CELLS) {
    const left = new Map<string, number>();
    for (const l of b) left.set(l, (left.get(l) ?? 0) + 1);
    const out: Op[] = [];
    for (const l of a) {
      const k = left.get(l) ?? 0;
      if (k > 0) {
        left.set(l, k - 1);
        out.push({ op: "=", line: l });
      } else out.push({ op: "-", line: l });
    }
    for (const [l, k] of left) for (let i = 0; i < k; i++) out.push({ op: "+", line: l });
    return out;
  }
  const w = m + 1;
  const t = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      t[i * w + j] =
        a[i] === b[j]
          ? t[(i + 1) * w + j + 1]! + 1
          : Math.max(t[(i + 1) * w + j]!, t[i * w + j + 1]!);
  const out: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: "=", line: a[i]! });
      i++;
      j++;
    } else if (t[(i + 1) * w + j]! >= t[i * w + j + 1]!) out.push({ op: "-", line: a[i++]! });
    else out.push({ op: "+", line: b[j++]! });
  }
  while (i < n) out.push({ op: "-", line: a[i++]! });
  while (j < m) out.push({ op: "+", line: b[j++]! });
  return out;
}

/** A run of edits between equal lines: what the draft said and what the team changed it to. */
export interface Hunk {
  /** The draft's line number the hunk starts at, from 1. */
  at: number;
  drafted: string[];
  merged: string[];
}

export function hunksOf(drafted: string | undefined, merged: string | undefined): Hunk[] {
  const out: Hunk[] = [];
  let cur: Hunk | undefined;
  let line = 1;
  for (const o of lineDiff(lines(drafted), lines(merged))) {
    if (o.op === "=") {
      cur = undefined;
      line++;
      continue;
    }
    if (!cur) out.push((cur = { at: line, drafted: [], merged: [] }));
    if (o.op === "-") {
      cur.drafted.push(o.line);
      line++;
    } else cur.merged.push(o.line);
  }
  return out;
}

export interface LineCounts {
  drafted: number;
  merged: number;
  /** Lines only the merged file has (beyond those paired with a removed line). */
  added: number;
  /** Lines only the draft had (beyond those paired with an added line). */
  removed: number;
  /** A removed line and an added line in the same place, counted once. */
  changed: number;
}

export function countLines(drafted: string | undefined, merged: string | undefined): LineCounts {
  let added = 0;
  let removed = 0;
  let changed = 0;
  for (const h of hunksOf(drafted, merged)) {
    const c = Math.min(h.drafted.length, h.merged.length);
    changed += c;
    removed += h.drafted.length - c;
    added += h.merged.length - c;
  }
  return { drafted: lines(drafted).length, merged: lines(merged).length, added, removed, changed };
}

// ---- stories ------------------------------------------------------------------------------

interface StoryRead {
  title: string;
  statement: string;
  criteria: string[];
  fields: string[];
  sections: Map<string, string>;
}

const norm = (s: string) =>
  s
    .trim()
    .replace(/\s+\((Entry|Validation|Error|Checks?|Outcome)[^)]*\)\s*$/i, "")
    .replace(/[.\s]+$/, "")
    .replace(/\s+/g, " ");

/** What a story file says, as the planner renders it: title, statement, criteria, fields, sections. */
export function readStory(text: string): StoryRead {
  const ls = lines(text);
  const sections = new Map<string, string>();
  let title = "";
  let statement = "";
  let section = "";
  let body: string[] = [];
  const close = () => {
    if (section) sections.set(section, body.join("\n").trim());
  };
  for (const l of ls) {
    if (!title && /^# /.test(l)) {
      title = l.slice(2).trim();
      continue;
    }
    const h = /^## (.+)$/.exec(l);
    if (h) {
      close();
      section = h[1]!.trim();
      body = [];
      continue;
    }
    if (!section && !statement && /^As an? /.test(l)) statement = l.trim();
    if (section) body.push(l);
  }
  close();
  const bullets = (s: string | undefined, indent: RegExp) =>
    (s ?? "")
      .split("\n")
      .filter((l) => indent.test(l))
      .map((l) => norm(l.replace(indent, "")));
  let criteria = bullets(sections.get("Acceptance criteria"), /^- /);
  if (!criteria.length) {
    // No story-level list: the tasks' own criteria.
    const tasks = sections.get("Tasks") ?? "";
    let inCriteria = false;
    for (const l of tasks.split("\n")) {
      if (/^- Acceptance criteria:/.test(l)) inCriteria = true;
      else if (/^- /.test(l) || /^#/.test(l)) inCriteria = false;
      else if (inCriteria && /^ {2}- /.test(l)) criteria.push(norm(l.replace(/^ {2}- /, "")));
    }
  }
  criteria = [...new Set(criteria.filter(Boolean))];
  const fields = new Set<string>();
  for (const l of (sections.get("Tasks") ?? "").split("\n")) {
    const f = /^- Fields: (.+)$/.exec(l);
    if (f)
      for (const x of f[1]!.split(",")) if (x.trim() && x.trim() !== "none") fields.add(x.trim());
  }
  // The interface and data tables: the Field column, and the Column column.
  for (const name of ["Interface changes", "Data changes"]) {
    let col = -1;
    for (const l of (sections.get(name) ?? "").split("\n")) {
      if (!l.startsWith("|")) {
        col = -1;
        continue;
      }
      const cells = l
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim());
      if (cells.every((c) => /^-+$/.test(c))) continue;
      const head = cells.findIndex((c) => c === "Field" || c === "Column");
      if (head >= 0) {
        col = head;
        continue;
      }
      if (col >= 0 && cells[col]) fields.add(cells[col]!);
    }
  }
  return { title, statement, criteria, fields: [...fields].sort(), sections };
}

export interface StoryMeasure {
  id: string;
  file: string;
  status: "same" | "edited" | "added" | "removed";
  criteria: { added: string[]; removed: string[] };
  fields: { added: string[]; removed: string[] };
  /** The parts whose words changed: "title", "statement" and section names. */
  changed: string[];
}

function measureStory(file: string, d: string | undefined, m: string | undefined): StoryMeasure {
  const id = file.replace(/^stories\//, "").replace(/\.md$/, "");
  const a = d === undefined ? undefined : readStory(d);
  const b = m === undefined ? undefined : readStory(m);
  const status = d === m ? "same" : !a ? "added" : !b ? "removed" : "edited";
  const minus = (x: string[], y: string[]) => x.filter((v) => !y.includes(v));
  const changed: string[] = [];
  if (a && b) {
    if (a.title !== b.title) changed.push("title");
    if (a.statement !== b.statement) changed.push("statement");
    for (const s of [...new Set([...a.sections.keys(), ...b.sections.keys()])])
      if ((a.sections.get(s) ?? "") !== (b.sections.get(s) ?? "")) changed.push(s);
  }
  return {
    id,
    file,
    status,
    criteria: {
      added: minus(b?.criteria ?? [], a?.criteria ?? []),
      removed: minus(a?.criteria ?? [], b?.criteria ?? []),
    },
    fields: {
      added: minus(b?.fields ?? [], a?.fields ?? []),
      removed: minus(a?.fields ?? [], b?.fields ?? []),
    },
    changed,
  };
}

const isStoryFile = (p: string) => p.startsWith("stories/") && p.endsWith(".md");

// ---- the report ---------------------------------------------------------------------------

export interface FileMeasure extends LineCounts {
  path: string;
  status: "same" | "edited" | "added" | "removed";
}

export interface StageMeasure {
  stage: string;
  phase: string;
  pr: number;
  /** When the merge happened: the merge commit's date, else when Atticus saw it merged. */
  mergedAt: string;
  drafted: { commit?: string; from: string };
  merged: { commit: string };
  files: FileMeasure[];
  stories: StoryMeasure[];
  totals: LineCounts & {
    /** Lines touched (added + removed + changed) over the larger of the drafted and merged line counts. */
    editRate: number;
    files: number;
    filesEdited: number;
  };
}

export interface TrendPoint {
  change: string;
  stage: string;
  mergedAt: string;
  editRate: number;
}

export interface Trend {
  points: TrendPoint[];
  /** Mean edit rate of the earlier and the later half (the middle point of an odd count is in neither). */
  earlier?: number;
  later?: number;
  /** falling: the later half needed at least TREND_STEP fewer edits; too-few: under TREND_MIN points. */
  direction: "falling" | "rising" | "flat" | "too-few";
}

export interface LearnReport {
  schemaVersion: typeof LEARN_SCHEMA_VERSION;
  changes: { change: string; stages: StageMeasure[] }[];
  /** Merged hand-offs whose pair isn't complete: the merge isn't in the clone, or the draft is gone. */
  pending: {
    change: string;
    stage: string;
    pr: number;
    state: DraftCapture["state"];
    note: string;
  }[];
  trend: { overall: Trend; byStage: Record<string, Trend> };
}

/** At least this many merged stages before a trend is named. */
export const TREND_MIN = 3;
/** The difference in edit rate between the halves that counts as falling or rising. */
export const TREND_STEP = 0.02;

const round = (x: number) => Math.round(x * 10_000) / 10_000;

export function measurePair(p: DraftPair): StageMeasure {
  const c = p.capture;
  const paths = [...new Set([...p.drafted.keys(), ...p.merged.keys()])].sort();
  const files: FileMeasure[] = paths.map((path) => {
    const d = p.drafted.get(path);
    const m = p.merged.get(path);
    const status =
      d === m ? "same" : d === undefined ? "added" : m === undefined ? "removed" : "edited";
    return { path, status, ...countLines(d, m) };
  });
  const sum = (k: keyof LineCounts) => files.reduce((n, f) => n + f[k], 0);
  const t = {
    drafted: sum("drafted"),
    merged: sum("merged"),
    added: sum("added"),
    removed: sum("removed"),
    changed: sum("changed"),
  };
  return {
    stage: c.stage,
    phase: c.phase,
    pr: c.pr.number,
    mergedAt: c.merged?.at ?? c.mergedAt,
    drafted: { from: c.drafted.from, ...(c.drafted.commit ? { commit: c.drafted.commit } : {}) },
    merged: { commit: c.merged?.commit ?? "" },
    files,
    stories: paths
      .filter(isStoryFile)
      .map((f) => measureStory(f, p.drafted.get(f), p.merged.get(f))),
    totals: {
      ...t,
      editRate: round((t.added + t.removed + t.changed) / Math.max(1, t.drafted, t.merged)),
      files: files.length,
      filesEdited: files.filter((f) => f.status !== "same").length,
    },
  };
}

const byTime = (a: { mergedAt: string; change: string; stage: string }, b: typeof a) =>
  a.mergedAt.localeCompare(b.mergedAt) ||
  a.change.localeCompare(b.change) ||
  a.stage.localeCompare(b.stage);

export function trendOf(points: TrendPoint[]): Trend {
  const ps = [...points].sort(byTime);
  if (ps.length < TREND_MIN) return { points: ps, direction: "too-few" };
  const half = Math.floor(ps.length / 2);
  const mean = (xs: TrendPoint[]) => round(xs.reduce((n, x) => n + x.editRate, 0) / xs.length);
  const earlier = mean(ps.slice(0, half));
  const later = mean(ps.slice(ps.length - half));
  const d = later - earlier;
  return {
    points: ps,
    earlier,
    later,
    direction: d <= -TREND_STEP ? "falling" : d >= TREND_STEP ? "rising" : "flat",
  };
}

export function learnFromPairs(pairs: DraftPair[]): LearnReport {
  const changes = new Map<string, StageMeasure[]>();
  const pending: LearnReport["pending"] = [];
  for (const p of pairs) {
    const c = p.capture;
    if (c.state !== "captured") {
      pending.push({
        change: c.change,
        stage: c.stage,
        pr: c.pr.number,
        state: c.state,
        note: c.note ?? "",
      });
      continue;
    }
    const list = changes.get(c.change) ?? [];
    list.push(measurePair(p));
    changes.set(c.change, list);
  }
  const out = [...changes]
    .map(([change, stages]) => ({
      change,
      stages: stages.sort(
        (a, b) => a.mergedAt.localeCompare(b.mergedAt) || a.stage.localeCompare(b.stage),
      ),
    }))
    .sort(
      (a, b) =>
        a.stages[0]!.mergedAt.localeCompare(b.stages[0]!.mergedAt) ||
        a.change.localeCompare(b.change),
    );
  const points = out.flatMap((c) =>
    c.stages.map((s) => ({
      change: c.change,
      stage: s.stage,
      mergedAt: s.mergedAt,
      editRate: s.totals.editRate,
    })),
  );
  const byStage: Record<string, Trend> = {};
  for (const s of [...new Set(points.map((p) => p.stage))].sort())
    byStage[s] = trendOf(points.filter((p) => p.stage === s));
  return {
    schemaVersion: LEARN_SCHEMA_VERSION,
    changes: out,
    pending: pending.sort(
      (a, b) => a.change.localeCompare(b.change) || a.stage.localeCompare(b.stage),
    ),
    trend: { overall: trendOf(points), byStage },
  };
}

/** The report from the pairs kept in the metarepo. */
export async function learnReport(root: string): Promise<LearnReport> {
  return learnFromPairs(await readDraftPairs(root));
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const day = (iso: string) => iso.slice(0, 10);

function trendLine(name: string, t: Trend): string {
  if (t.direction === "too-few")
    return `  ${name}: ${t.points.length} merged so far; a trend needs ${TREND_MIN}.`;
  const words = { falling: "falling", rising: "rising", flat: "flat" }[t.direction];
  return `  ${name}: ${pct(t.earlier!)} of lines edited in the earlier half, ${pct(t.later!)} in the later half, over ${t.points.length} merged: ${words}.`;
}

/** The report in plain words. */
export function formatLearn(r: LearnReport): string[] {
  const out: string[] = [];
  const stages = r.changes.reduce((n, c) => n + c.stages.length, 0);
  if (!stages && !r.pending.length)
    return [
      "No merged hand-off has a kept draft yet. When a stage's hand-off PR merges, atticus change sync keeps what Atticus drafted beside what merged (stage/<stage>.drafted/ and .merged/).",
    ];
  out.push(
    `How much people changed Atticus's drafts, from ${stages} merged hand-off${stages === 1 ? "" : "s"} in ${r.changes.length} change${r.changes.length === 1 ? "" : "s"}:`,
  );
  for (const c of r.changes) {
    out.push("", c.change);
    for (const s of c.stages) {
      const t = s.totals;
      out.push(
        `  ${s.stage} (PR #${s.pr}, merged ${day(s.mergedAt)}): ${t.added + t.removed + t.changed} of ${Math.max(t.drafted, t.merged)} lines edited (${pct(t.editRate)}); ${t.filesEdited} of ${t.files} files`,
      );
      for (const f of s.files.filter((x) => x.status !== "same"))
        out.push(`    ${f.path} (${f.status}): +${f.added} -${f.removed} ~${f.changed}`);
      for (const st of s.stories.filter((x) => x.status !== "same")) {
        const c = st.criteria;
        const bits = [
          c.added.length || c.removed.length
            ? `criteria +${c.added.length} -${c.removed.length}`
            : "",
          st.fields.added.length ? `fields added: ${st.fields.added.join(", ")}` : "",
          st.fields.removed.length ? `fields removed: ${st.fields.removed.join(", ")}` : "",
          st.changed.length ? `changed: ${st.changed.join(", ")}` : "",
        ].filter(Boolean);
        out.push(`    story ${st.id} (${st.status}): ${bits.join("; ") || "reworded"}`);
      }
    }
  }
  out.push("", "Trend (share of lines people edited, by merge date):");
  out.push(trendLine("all stages", r.trend.overall));
  for (const [s, t] of Object.entries(r.trend.byStage)) out.push(trendLine(s, t));
  if (r.pending.length) {
    out.push("", "Not counted yet:");
    for (const p of r.pending) out.push(`  ${p.change} ${p.stage} (PR #${p.pr}): ${p.note}`);
  }
  return out;
}

// ---- H2: the closest past pairs -----------------------------------------------------------

/** What a change touches, for finding past pairs like it. */
export interface Touches {
  repos: string[];
  tables: string[];
  flows: string[];
  systems: string[];
  entry?: string;
}

const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))].sort();

/** What a kept pair touched, read off its merged files (else drafted) and its change.yaml. */
export async function pairTouches(root: string, p: DraftPair): Promise<Touches> {
  const files = p.merged.size ? p.merged : p.drafted;
  const repos: string[] = [];
  const tables: string[] = [];
  const flows: string[] = [];
  const systems: string[] = [];
  let entry: string | undefined;
  const yaml = (t: string): Record<string, unknown> | undefined => {
    try {
      const v = parse(t) as unknown;
      return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  };
  const arr = (v: unknown): Record<string, unknown>[] =>
    Array.isArray(v)
      ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
      : [];
  for (const [path, text] of files) {
    if (path === "feature.yaml") {
      const d = yaml(text);
      if (typeof d?.entry === "string") entry = d.entry;
      for (const f of arr(d?.flows))
        if (typeof f.id === "string") {
          flows.push(f.id);
          if (f.id.includes(".")) repos.push(f.id.slice(0, f.id.indexOf(".")));
        }
      for (const f of arr(d?.newFlows)) if (typeof f.repo === "string") repos.push(f.repo);
    } else if (path.startsWith("target-flows/") && path.endsWith(".yaml")) {
      const d = yaml(text);
      if (typeof d?.repo === "string") repos.push(d.repo);
      if (typeof d?.flow === "string") flows.push(d.flow);
      for (const s of arr(d?.steps)) {
        const st = s.store as Record<string, unknown> | undefined;
        if (st && typeof st.table === "string") tables.push(st.table);
      }
    } else if (path.startsWith("stories/") && path.endsWith(".md")) {
      const sys = /^## Systems and repos\n\n(.+)$/m.exec(text);
      if (sys) repos.push(...sys[1]!.split(",").map((s) => s.trim()));
      for (const m of text.matchAll(/^- Store: ([^:\s]+):/gm)) tables.push(m[1]!);
      for (const m of text.matchAll(/^target-flows\/([^\s]+)\.yaml/gm)) flows.push(m[1]!);
    }
  }
  const change = yaml(
    await readFile(join(root, ...p.folder.split("/"), "change.yaml"), "utf8").catch(() => ""),
  );
  const touches = (change?.touches ?? {}) as Record<string, unknown>;
  for (const r of Array.isArray(touches.repos) ? touches.repos : [])
    if (typeof r === "string") repos.push(r);
  for (const t of Array.isArray(touches.tables) ? touches.tables : [])
    if (typeof t === "string") tables.push(t);
  for (const s of Array.isArray(change?.systems) ? change.systems : [])
    if (typeof s === "string") systems.push(s);
  return {
    repos: uniq(repos),
    tables: uniq(tables),
    flows: uniq(flows),
    systems: uniq(systems),
    ...(entry ? { entry } : {}),
  };
}

export interface PastCorrection {
  change: string;
  /** The change folder the pair is kept in, relative to the metarepo root. */
  folder: string;
  stage: string;
  pr: number;
  mergedAt: string;
  /** What it shares with the new change, in words: "repo forge-orders", "table …", "entry brief". */
  shares: string[];
  score: number;
  files: { path: string; status: string; hunks: Hunk[] }[];
}

/**
 * The closest past pairs of a stage (H2): same stage, from other changes, with an edit, sharing
 * a repo, table, flow, system or entry with what the new change touches; most shared first, then
 * the most recent. At most `max` (2).
 */
export async function pastCorrections(
  root: string,
  q: { stage: string; change: string; touches: Touches; max?: number },
): Promise<PastCorrection[]> {
  const pairs = (await readDraftPairs(root)).filter(
    (p) =>
      p.capture.state === "captured" &&
      p.capture.stage === q.stage &&
      p.capture.change !== q.change,
  );
  const out: PastCorrection[] = [];
  for (const p of pairs) {
    const files = [...new Set([...p.drafted.keys(), ...p.merged.keys()])]
      .sort()
      .map((path) => {
        const d = p.drafted.get(path);
        const m = p.merged.get(path);
        const status =
          d === m ? "same" : d === undefined ? "added" : m === undefined ? "removed" : "edited";
        return { path, status, hunks: status === "same" ? [] : hunksOf(d, m) };
      })
      .filter((f) => f.hunks.length > 0);
    if (!files.length) continue;
    const t = await pairTouches(root, p);
    const shares: string[] = [];
    const share = (kind: string, xs: string[], ys: string[]) => {
      for (const x of xs) if (ys.includes(x)) shares.push(`${kind} ${x}`);
    };
    share("repo", q.touches.repos, t.repos);
    share("table", q.touches.tables, t.tables);
    share("flow", q.touches.flows, t.flows);
    share("system", q.touches.systems, t.systems);
    const strong = shares.length;
    if (q.touches.entry && t.entry === q.touches.entry) shares.push(`entry ${t.entry}`);
    if (!shares.length) continue;
    out.push({
      change: p.capture.change,
      folder: p.folder,
      stage: p.capture.stage,
      pr: p.capture.pr.number,
      mergedAt: p.capture.merged?.at ?? p.capture.mergedAt,
      shares,
      // A shared repo, table, flow or system counts for more than the same kind of entry.
      score: strong * 2 + (shares.length - strong),
      files,
    });
  }
  return out
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.mergedAt.localeCompare(a.mergedAt) ||
        a.change.localeCompare(b.change),
    )
    .slice(0, q.max ?? 2);
}
