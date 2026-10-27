import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import {
  loadOrgPack,
  parseRecord,
  recordPath,
  serializeRecord,
  type CatalogRecord,
} from "@maycombhq/core";
import { syncSources, writeSnapshots } from "@maycombhq/knowledge";
import {
  estateOf,
  FlowDelta,
  selectTaskKnowledge,
  taskKnowledgeInput,
  type DeltaStory,
  type Estate,
  type TaskKnowledge,
  type TaskKnowledgeInput,
} from "@maycombhq/planner";
import { writeWikiEstate } from "@maycombhq/synth";

/**
 * Each task's knowledge across 12 wikis, measured (ADR 0132). The invented Forge shop
 * (fixtures/many-wikis): 12 sources (two standards, two platforms, two frameworks, five teams,
 * one reference), its planted pages, and a change of 14 tasks whose expected pages were written
 * by hand before any code (expected.yaml), with adversarial cases: a stale standard against a
 * current team page, an approved exception, a deprecated page, a page mirrored in two wikis, a
 * copy drifted from its original, restricted pages, and a GCP page against a task that creates a
 * new GCP component and against tasks that don't. Run on the planted pages alone and with the
 * generator's filler (4,800 pages at scale 1).
 *
 * Before: no source's authority, scope or page status (sources.yaml as version 2 read it). After:
 * all of them. Per task:
 * - **recall**: of the items the task needs, the share it lists;
 * - **precision**: of what it lists (less what is allowed either way), the share it needs;
 * - **never**: what it lists that it must not (out of scope, restricted, a mirror);
 * - **leads**: of the topics whose leading page is expected, the share led by that page and
 *   never by a page that must not lead;
 * - **suggested**: of the disagreements whose suggested page is expected, the share suggested so.
 */

interface Expected {
  title: string;
  needed: string[];
  allowed?: string[];
  never?: string[];
  lead?: Record<string, string>;
  notLead?: string[];
  before?: [string, string][];
  conflicts?: Record<string, { suggested: string; signal: string; mayBeOutOfDate?: boolean }>;
}

export type ManyWikisMode = "before" | "after";

export interface ManyWikisRow {
  case: string;
  task: string;
  mode: ManyWikisMode;
  needed: number;
  listed: number;
  /** Listed, less what is allowed either way: what precision is counted on. */
  counted: number;
  recall: number;
  precision: number;
  missing: string[];
  extra: string[];
  never: string[];
  leads: { right: number; of: number; wrong: string[] };
  suggested: { right: number; of: number; wrong: string[] };
  order: { right: number; of: number };
}

export interface ManyWikisRun {
  case: string;
  pages: number;
  rows: ManyWikisRow[];
  /** Milliseconds: writing the estate, the sync, and each mode's selection for all 14 tasks. */
  ms: { write: number; sync: number; before: number; after: number };
}

const NOW = "2026-10-20T08:00:00Z";
const r2 = (n: number) => Math.round(n * 100) / 100;

async function records(root: string, dir: string, file: string): Promise<CatalogRecord[]> {
  const out: CatalogRecord[] = [];
  for (const r of parse(readFileSync(file, "utf8")) as unknown[]) {
    const p = parseRecord(r);
    if (!p.ok) throw new Error(`bad fixture record in ${file}: ${JSON.stringify(p.issues)}`);
    const f = join(root, dir, recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
    out.push(p.record);
  }
  return out;
}

/** The fixture's stories and target flows as the stories stage holds them, each task's input. */
export function manyWikisInputs(
  change: {
    stories: (Omit<DeltaStory, "tasks"> & { tasks: Record<string, unknown>[] })[];
    targetFlows: Record<string, unknown>[];
  },
  estate: Estate,
): TaskKnowledgeInput[] {
  return change.stories.flatMap((s) =>
    s.tasks.map((t, n) => {
      const task = {
        story: s.id,
        repo: s.repo,
        flow: s.flow,
        position: n + 1,
        fields: [],
        evidence: [],
        ...t,
      } as unknown as DeltaStory["tasks"][number];
      const found = change.targetFlows.find((d) => d.flow === s.flow);
      return taskKnowledgeInput(
        { ...s, tasks: [] } as DeltaStory,
        task,
        found ? FlowDelta.parse(found) : undefined,
        estate,
      );
    }),
  );
}

/** What a task lists, and every page each entry shows (source/page and source/page#section). */
function shown(ks: TaskKnowledge[]) {
  const ids = ks.map((k) => k.id);
  const pages = new Set<string>();
  for (const k of ks)
    for (const p of [k.page, ...k.alsoOn])
      if (p) {
        pages.add(`${p.source}/${p.page}`);
        pages.add(`${p.source}/${p.page}#${p.section}`);
      }
  return { ids, pages, all: new Set([...ids, ...ks.flatMap((k) => k.sameAs ?? [])]) };
}

function row(
  name: string,
  task: string,
  mode: ManyWikisMode,
  e: Expected,
  ks: TaskKnowledge[],
): ManyWikisRow {
  const s = shown(ks);
  const allowed = new Set(e.allowed ?? []);
  const need = new Set(e.needed);
  const hit = e.needed.filter((x) => s.all.has(x));
  const counted = s.ids.filter((x) => !allowed.has(x));
  const extra = counted.filter(
    (x) => !need.has(x) && !ks.find((k) => k.id === x)?.sameAs?.some((y) => need.has(y)),
  );
  const never = (e.never ?? []).filter((x) => s.all.has(x) || s.pages.has(x));
  const leads = { right: 0, of: 0, wrong: [] as string[] };
  for (const [id, page] of Object.entries(e.lead ?? {})) {
    leads.of++;
    const k = ks.find((x) => x.id === id || x.sameAs?.includes(id));
    const at = k?.page ? `${k.page.source}/${k.page.page}` : undefined;
    if (at === page && !(e.notLead ?? []).includes(at)) leads.right++;
    else leads.wrong.push(`${id} led by ${at ?? "nothing"}`);
  }
  for (const p of e.notLead ?? [])
    if (ks.some((k) => k.page && `${k.page.source}/${k.page.page}` === p)) {
      leads.of++;
      leads.wrong.push(`${p} leads`);
    }
  const suggested = { right: 0, of: 0, wrong: [] as string[] };
  for (const [id, c] of Object.entries(e.conflicts ?? {})) {
    suggested.of++;
    const k = ks.find((x) => x.id === id);
    const got = k?.conflicts[0];
    const ok =
      !!got?.suggested?.startsWith(`${c.suggested}, by ${c.signal}`) &&
      (!c.mayBeOutOfDate || /may be out of date/.test(got.suggested));
    if (ok) suggested.right++;
    else suggested.wrong.push(`${id}: ${got?.suggested ?? (k ? "none suggested" : "not listed")}`);
  }
  const order = { right: 0, of: 0 };
  for (const [a, b] of e.before ?? []) {
    const ia = s.ids.indexOf(a);
    const ib = s.ids.indexOf(b);
    if (ia < 0 || ib < 0) continue;
    order.of++;
    if (ia < ib) order.right++;
  }
  return {
    case: name,
    task,
    mode,
    needed: e.needed.length,
    listed: s.ids.length,
    counted: counted.length,
    recall: e.needed.length ? r2(hit.length / e.needed.length) : 1,
    precision: counted.length ? r2((counted.length - extra.length) / counted.length) : 1,
    missing: e.needed.filter((x) => !s.all.has(x)),
    extra,
    never,
    leads,
    suggested,
    order,
  };
}

/**
 * Write the estate (planted pages, and filler at `scale`), sync it, read the items and the scan's
 * report, and select each task's knowledge before and after. Nothing reaches a model.
 */
export async function runManyWikisBench(
  fixtures: string,
  o: { scale?: number; name?: string } = {},
): Promise<ManyWikisRun> {
  const fx = join(fixtures, "many-wikis");
  const name =
    o.name ?? (o.scale ? `12 sources, filler at scale ${o.scale}` : "12 sources, planted pages");
  const root = await mkdtemp(join(tmpdir(), "atticus-many-wikis-bench-"));
  let t = performance.now();
  await writeWikiEstate(root, { fixtures, scale: o.scale ?? 0 });
  const recs = await records(root, "catalog/generated", join(fx, "catalog.yaml"));
  const write = performance.now() - t;
  const op = await loadOrgPack(join(root, "org-pack"));
  if (op.problems.length) throw new Error(JSON.stringify(op.problems));
  t = performance.now();
  const s = await syncSources({ root, orgPack: op, now: NOW });
  await writeSnapshots({ root, orgPack: op, sync: s, takenAt: NOW });
  const sync = performance.now() - t;
  await records(root, "knowledge/items", join(fx, "knowledge.yaml"));
  await cp(join(fx, "scan.yaml"), join(root, "knowledge/scan.yaml"));
  const change = parse(readFileSync(join(fx, "change.yaml"), "utf8"));
  const expected = parse(readFileSync(join(fx, "expected.yaml"), "utf8")) as {
    tasks: Record<string, Expected>;
  };
  const inputs = manyWikisInputs(change, estateOf(recs, []));
  const rows: ManyWikisRow[] = [];
  const ms = { write, sync, before: 0, after: 0 };
  // After first: it builds the index both modes then read.
  for (const mode of ["after", "before"] as const) {
    t = performance.now();
    const got = await selectTaskKnowledge(root, change.change, inputs, {
      now: NOW,
      ...(mode === "before" ? { standing: false } : {}),
    });
    ms[mode] = performance.now() - t;
    for (const i of inputs)
      rows.push(row(name, i.task, mode, expected.tasks[i.task]!, got.byTask.get(i.task) ?? []));
  }
  rows.sort(
    (a, b) =>
      a.task.localeCompare(b.task, undefined, { numeric: true }) || a.mode.localeCompare(b.mode),
  );
  return { case: name, pages: s.pages.length, rows, ms };
}

/** Recall, precision and the checks over every task of a run, by mode. */
export function manyWikisTotals(run: ManyWikisRun, mode: ManyWikisMode) {
  const rows = run.rows.filter((r) => r.mode === mode);
  const needed = rows.reduce((n, r) => n + r.needed, 0);
  const found = rows.reduce((n, r) => n + (r.needed - r.missing.length), 0);
  const counted = rows.reduce((n, r) => n + r.counted, 0);
  const extra = rows.reduce((n, r) => n + r.extra.length, 0);
  const sum = (f: (r: ManyWikisRow) => { right: number; of: number }) =>
    rows.reduce((a, r) => ({ right: a.right + f(r).right, of: a.of + f(r).of }), {
      right: 0,
      of: 0,
    });
  return {
    recall: needed ? r2(found / needed) : 1,
    precision: counted ? r2((counted - extra) / counted) : 1,
    never: rows.reduce((n, r) => n + r.never.length, 0),
    leads: sum((r) => r.leads),
    suggested: sum((r) => r.suggested),
    order: sum((r) => r.order),
  };
}

export function renderManyWikisTable(runs: ManyWikisRun[]): string {
  const lines = [
    "## Knowledge per task across 12 wikis (ADR 0132)",
    "",
    "The invented Forge shop's 12 sources and a change of 14 tasks, the expected pages written by hand before the code (fixtures/many-wikis/expected.yaml). Before: no source's authority, scope or page status. After: all of them. Recall: the share of the items a task needs that it lists. Precision: the share of what it lists, less what is allowed either way, that it needs. Never: listed though it must not be (out of scope, restricted, a mirror). Leads: topics led by the expected page. Suggested: disagreements whose suggested page and signal are the expected ones.",
    "",
    "| Run | Selection | Recall | Precision | Never | Leads | Suggested | Order |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const run of runs)
    for (const mode of ["before", "after"] as const) {
      const t = manyWikisTotals(run, mode);
      lines.push(
        `| ${run.case} (${run.pages} pages) | ${mode} | ${t.recall.toFixed(2)} | ${t.precision.toFixed(2)} | ${t.never} | ${t.leads.right} / ${t.leads.of} | ${t.suggested.right} / ${t.suggested.of} | ${t.order.right} / ${t.order.of} |`,
      );
    }
  lines.push(
    "",
    "Per task:",
    "",
    "| Run | Task | Selection | Recall | Precision | Missing | Not needed | Never | Wrong lead or suggestion |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const run of runs)
    for (const r of run.rows)
      lines.push(
        `| ${run.case} | ${r.task} | ${r.mode} | ${r.recall.toFixed(2)} | ${r.precision.toFixed(2)} | ${r.missing.join(", ") || "none"} | ${r.extra.length ? `${r.extra.length}: ${r.extra.slice(0, 4).join(", ")}${r.extra.length > 4 ? ", …" : ""}` : "none"} | ${r.never.join(", ") || "none"} | ${[...r.leads.wrong, ...r.suggested.wrong].join("; ") || "none"} |`,
      );
  lines.push("");
  return lines.join("\n");
}
