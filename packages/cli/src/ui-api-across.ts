import {
  loadOrgPack,
  orgPackDirOf,
  type CatalogRecord,
  type ChangeLifecycle,
  type Finding,
  type ManualStep,
} from "@maycombhq/core";
import { fileStepStore } from "@maycombhq/adapters";
import { changeFolder, changeReport, changeStore, liveHandoff } from "@maycombhq/changes";
import {
  readChangeFiles,
  readRound,
  readStoryIndex,
  reviewedGates,
  roundsOf,
} from "@maycombhq/naysayer";
import { fieldNames, readDeltas } from "@maycombhq/planner";
import { readServiceRequests } from "@maycombhq/release";
import { readChangeTasks, readStory } from "@maycombhq/speckit";
import { traceMatrix } from "@maycombhq/testgen";
import { badRequest, notFound, strParam, type Router, type ServerContext } from "@maycombhq/server";
import { catalogRecords } from "./site-commands.js";

/**
 * Views across every open change (ADR 0048): findings, tasks, stories, tests, service requests
 * and releases as one list each, so a lead sees the whole portfolio without opening each change.
 * Also the field-mapping grid of one change, next to what the catalog already maps. Everything
 * here reads the metarepo's files; nothing writes.
 */

export const ACROSS_VIEWS = [
  "findings",
  "tasks",
  "stories",
  "tests",
  "requests",
  "releases",
] as const;
export type AcrossView = (typeof ACROSS_VIEWS)[number];

export interface AcrossRow {
  change: string;
  changeTitle: string;
  changeState: string;
  [field: string]: unknown;
}

async function openChanges(root: string): Promise<ChangeLifecycle[]> {
  return (await changeStore(root).list())
    .filter((c) => c.state !== "archived")
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function latestFindings(root: string, change: string): Promise<Finding[]> {
  const out: Finding[] = [];
  for (const gate of await reviewedGates(root, change)) {
    const rounds = await roundsOf(root, change, gate);
    if (rounds.length)
      out.push(
        ...(await readRound(root, change, gate, rounds.at(-1)!)).findings.map((f) => f.finding),
      );
  }
  return out;
}

const SEVERITY_ORDER = ["blocking", "gap", "risk", "idea"];
const AT_RELEASE = new Set(["release-ready", "released", "post-release-review"]);

/** One view's rows across every open change, in a stable order. */
export async function acrossRows(root: string, view: AcrossView): Promise<AcrossRow[]> {
  const changes = await openChanges(root);
  const rows: AcrossRow[] = [];
  const op = view === "requests" ? await loadOrgPack(orgPackDirOf(root)) : undefined;
  const steps: ManualStep[] =
    view === "requests"
      ? await fileStepStore(root)
          .list({ system: "service-desk" })
          .catch(() => [])
      : [];
  for (const c of changes) {
    const base = { change: c.id, changeTitle: c.title, changeState: c.state };
    const dir = changeFolder(root, c.id);
    switch (view) {
      case "findings":
        for (const f of await latestFindings(root, c.id))
          rows.push({
            ...base,
            id: f.id,
            gate: f.gate,
            lens: f.lens,
            severity: f.severity,
            state: f.state,
            summary: f.summary,
            artifact: f.artifact,
          });
        break;
      case "tasks":
        for (const t of readChangeTasks(await readChangeFiles(dir)))
          rows.push({
            ...base,
            id: t.id,
            repo: t.repo,
            description: t.title,
            done: t.done,
            ...(t.stories[0] ? { story: t.stories[0] } : {}),
          });
        break;
      case "stories": {
        const files = await readChangeFiles(dir);
        for (const s of readStoryIndex(files)) {
          const story = readStory(files, s.id);
          rows.push({
            ...base,
            id: s.id,
            title: s.title,
            repos: s.repos,
            dependsOn: s.dependsOn,
            written: !!story,
            criteria: story?.criteria.length ?? 0,
          });
        }
        break;
      }
      case "tests": {
        const m = await traceMatrix(root, c.id).catch(() => undefined);
        if (!m) break;
        const reqRows = m.rows.filter((r) => r.requirement);
        rows.push({
          ...base,
          requirements: m.requirements.length,
          tested: reqRows.filter((r) => r.tests.length > 0).length,
          rows: reqRows.length,
          stories: m.stories.length,
          gaps: m.gaps.length,
          topGaps: m.gaps.slice(0, 3).map((g) => g.summary),
        });
        break;
      }
      case "requests":
        for (const r of await readServiceRequests(
          dir,
          await readChangeFiles(dir),
          op!.serviceRequests,
          steps.filter((s) => s.change === c.id),
          [],
        ))
          rows.push({
            ...base,
            heading: r.heading,
            requestType: r.requestType,
            record: r.record,
            state: r.state,
            missing: r.missing,
            ...(r.leadTimeDays !== undefined ? { leadTimeDays: r.leadTimeDays } : {}),
            ...(r.number ? { number: r.number } : {}),
          });
        break;
      case "releases": {
        const rep = await changeReport(root, c.id);
        const h = liveHandoff(c);
        rows.push({
          ...base,
          atRelease: AT_RELEASE.has(c.state),
          ...(rep.phase ? { phase: rep.phase } : {}),
          ...(rep.next ? { next: rep.next } : {}),
          nextStep: rep.nextStep,
          risk: rep.risk.level,
          blockers: rep.blockers.length,
          ...(h ? { handoff: { phase: h.phase, pr: h.pr.url, state: h.state } } : {}),
        });
        break;
      }
    }
  }
  if (view === "findings")
    rows.sort(
      (a, b) =>
        Number(a.state !== "open") - Number(b.state !== "open") ||
        SEVERITY_ORDER.indexOf(String(a.severity)) - SEVERITY_ORDER.indexOf(String(b.severity)) ||
        a.change.localeCompare(b.change),
    );
  if (view === "releases") rows.sort((a, b) => Number(b.atRelease) - Number(a.atRelease));
  return rows;
}

// ------------------------------------------------------------------ field mappings

export interface MappingHop {
  heading: string;
  line: number;
  /** The section says the hop's mapping doesn't change. */
  noChange: boolean;
  note?: string;
  rows: { line: number; source: string; target: string; rule: string; whenMissing: string }[];
  /** The catalog's FieldMapping records for this hop's interface: what is mapped today. */
  asIs: { id: string; interface: string; source: string; target: string; transform?: string }[];
  /**
   * The change's file the hop was read from: `mappings.md` on a change that has one, or
   * `target-flows/<flow>.yaml` on a change taken through the stages (ADR 0129 §2.3). Optional
   * and additive, so an app or editor that doesn't read it is unaffected.
   */
  from?: string;
}

/** "GET /accounts/{id}/limit" and "/accounts/:id/limit" become the same key. */
const pathKey = (s: string) =>
  s
    .toLowerCase()
    .replace(/\{[^}]*\}|:[a-z0-9_]+/g, "{}")
    .replace(/\/+$/, "")
    .trim();

function hopKey(heading: string): { method?: string; path: string } {
  const m = /^\s*(get|post|put|patch|delete|head|options)\s+(\S+)/i.exec(heading);
  return m ? { method: m[1]!.toUpperCase(), path: pathKey(m[2]!) } : { path: pathKey(heading) };
}

export async function mappingGrid(
  root: string,
  change: string,
  records?: CatalogRecord[],
): Promise<{ change: string; hops: MappingHop[]; catalogMappings: number }> {
  const files = await readChangeFiles(changeFolder(root, change));
  const doc = files.docs.get("mappings.md");
  const all = records ?? (await catalogRecords(root));
  const mappings = all.filter((r) => r.kind === "FieldMapping") as Extract<
    CatalogRecord,
    { kind: "FieldMapping" }
  >[];
  const interfaces = all.filter((r) => r.kind === "Interface") as Extract<
    CatalogRecord,
    { kind: "Interface" }
  >[];
  const hops: MappingHop[] = [];
  for (const s of doc?.sections.filter((x) => x.level === 2) ?? []) {
    const body = doc!.lines.slice(s.line, s.end).join("\n");
    const table = doc!.tables.find((t) => t.line > s.line && t.line <= s.end);
    const cell = (r: Record<string, string>, ...names: string[]) =>
      names.map((n) => r[n]).find((v) => v !== undefined) ?? "";
    const rows = (table?.rows ?? []).map((r) => ({
      line: r.line,
      source: cell(r.cells, "source field", "source"),
      target: cell(r.cells, "target field", "target"),
      rule: cell(r.cells, "rule or transformation", "transform", "rule"),
      whenMissing: cell(r.cells, "when missing or invalid", "when missing"),
    }));
    const k = hopKey(s.heading);
    const ifIds = new Set(
      interfaces
        .filter(
          (i) =>
            pathKey(i.normalizedPath) === k.path &&
            (!k.method || !i.method || i.method.toUpperCase() === k.method),
        )
        .map((i) => i.id),
    );
    const noChange = /no mapping change/i.test(body);
    const note = noChange
      ? body
          .replace(/\s+/g, " ")
          .replace(/^.*?no mapping change\.?\s*/i, "")
          .trim()
      : undefined;
    hops.push({
      heading: s.heading,
      line: s.line,
      noChange,
      ...(note ? { note } : {}),
      rows,
      asIs: asIsFor(mappings, ifIds),
      from: "mappings.md",
    });
  }
  // An Atticus 2 change has no mappings.md: its fields are in the architecture stage's target
  // flows (ADR 0129 §2.3). Read there only when mappings.md gave nothing, so a change that has
  // the file reads exactly as before.
  if (!hops.length)
    hops.push(...(await hopsFromTargetFlows(changeFolder(root, change), mappings, interfaces)));
  return { change, hops, catalogMappings: mappings.length };
}

/** The catalog's FieldMapping records on one hop's interfaces: what is mapped today. */
const asIsFor = (
  mappings: Extract<CatalogRecord, { kind: "FieldMapping" }>[],
  ifIds: Set<string>,
): MappingHop["asIs"] =>
  mappings
    .filter((m) => ifIds.has(m.interface))
    .map((m) => ({
      id: m.id,
      interface: m.interface,
      source: m.sourceField,
      target: m.targetField,
      ...(m.transform ? { transform: m.transform } : {}),
    }));

/**
 * The hops of a change taken through the stages, from `target-flows/<flow>.yaml` (ADR 0129
 * §2.3). A step that moves data is a hop: a call out or publish is headed by the entry it
 * reaches, so the catalog's Interfaces still match it by method and path; a read, write or
 * lookup by its table. Each field the step sends, returns or reads is a row, mapped to the name
 * it is stored or sent as (`fields.as`), with how it is worked out (`fields.derived`) as the
 * rule. A step that moves no data (a branch, a validate) is not a hop. Nothing is guessed: a
 * change with neither file gets no hops, and the page says so in its own words.
 */
async function hopsFromTargetFlows(
  dir: string,
  mappings: Extract<CatalogRecord, { kind: "FieldMapping" }>[],
  interfaces: Extract<CatalogRecord, { kind: "Interface" }>[],
): Promise<MappingHop[]> {
  const { deltas } = await readDeltas(dir);
  const hops: MappingHop[] = [];
  for (const d of deltas) {
    let at = 0;
    for (const s of d.steps) {
      at += 1;
      const heading = s.to ? s.to.entry : s.store ? s.store.table : undefined;
      if (!heading) continue;
      const as = s.fields?.as ?? {};
      const derived = s.fields?.derived ?? {};
      const names = fieldNames(s.fields);
      if (!names.length) continue;
      const k = hopKey(heading);
      const ifIds = new Set(
        interfaces
          .filter(
            (i) =>
              pathKey(i.normalizedPath) === k.path &&
              (!k.method || !i.method || i.method.toUpperCase() === k.method),
          )
          .map((i) => i.id),
      );
      hops.push({
        heading,
        line: at,
        noChange: false,
        rows: names.map((name, i) => ({
          line: i + 1,
          source: name,
          target: as[name] ?? name,
          rule: derived[name] ?? "",
          whenMissing: "",
        })),
        asIs: asIsFor(mappings, ifIds),
        from: `target-flows/${d.flow}.yaml`,
      });
    }
  }
  return hops;
}

export function uiAcrossRoutes(r: Router, ctx: ServerContext): Router {
  const { root } = ctx;
  return r
    .add("GET", "/api/across", async ({ query }) => {
      const view = strParam(query, "view") ?? "";
      if (!(ACROSS_VIEWS as readonly string[]).includes(view))
        throw badRequest(`Say which view: ?view= one of ${ACROSS_VIEWS.join(", ")}.`);
      const rows = await acrossRows(root, view as AcrossView);
      return {
        status: 200,
        body: { view, changes: (await openChanges(root)).length, rows },
      };
    })
    .add("GET", "/api/changes/{changeId}/mappings", async ({ params }) => {
      try {
        await changeStore(root).read(params.changeId!);
      } catch {
        throw notFound(`There is no change ${params.changeId}.`);
      }
      return { status: 200, body: await mappingGrid(root, params.changeId!) };
    });
}
