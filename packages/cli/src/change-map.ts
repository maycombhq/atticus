import { stat } from "node:fs/promises";
import { join } from "node:path";
import { changeStore } from "@maycombhq/changes";
import {
  changesDirOf,
  changesRelOf,
  readRepoSpec,
  specRepos,
  type Api,
  type CatalogRecord,
} from "@maycombhq/core";
import {
  changeView,
  toDrawio,
  toMermaid,
  type ChangeFlowIn,
  type FlowView,
} from "@maycombhq/diagrams";
import {
  mergeDelta,
  readDeltas,
  TARGET_DIR,
  type FlowDelta,
  type MergedFlow,
} from "@maycombhq/planner";
import { callOf, CODE_HAS, componentOfRepo, quickViewOf, type QuickView } from "./change-quick.js";
import { loadRepos } from "@maycombhq/workspace";
import type { Output } from "./commands.js";
import { loadCatalog } from "./diagram-commands.js";

/**
 * A change's picture (ADR 0108): its target flows merged with today's, drawn as the components,
 * entries and tables they touch, each marked + new, ◇ modify or ✕ retire. It reads files only.
 * The command, the API, the app and the MCP tool all draw it from here.
 */

export interface ChangeMap {
  view: FlowView;
  title: string;
  source: string;
  flows: number;
  problems: string[];
  /** ADR 0206: a change with no target flow, drawn from design.md's rows or tasks.md's repos. */
  from?: "design" | "tasks";
  /** How many rows of In the code it is drawn from, and how many (operations) aren't drawn. */
  rows?: number;
  notDrawn?: number;
}

/**
 * ADR 0206: a quick change's rows as the flows `changeView` draws, in memory only (never written
 * as target flows): one a repo's component, its calls and publishes as added steps, its stores as
 * stores, a topic it listens to as a line from the topic. A part is new only when the change
 * plans it (requirements.md's Planned, or a repo of tasks.md no manifest or record has).
 */
export function quickFlows(
  q: QuickView,
  records: readonly CatalogRecord[],
  known: (id: string) => boolean,
): ChangeFlowIn[] {
  const flows = new Map<string, ChangeFlowIn>();
  const flowOf = (component: string, planned: boolean) => {
    const f = flows.get(component) ?? {
      flow: `quick.${component}`,
      name: component,
      component,
      change: planned ? ("new" as const) : ("modify" as const),
      steps: [],
    };
    flows.set(component, f);
    return f;
  };
  const isPlanned = (id: string) => q.planned.has(id) || !known(id);
  const tables = new Set(records.filter((r) => r.kind === "Table").map((r) => r.id));
  if (q.from === "tasks") {
    for (const repo of q.repos)
      flowOf(componentOfRepo(records, repo), isPlanned(repo)).steps.push({
        mark: "added",
        kind: "task",
      });
    return [...flows.values()];
  }
  for (const r of q.rows.filter((x) => CODE_HAS.has(x.has))) {
    const comp = componentOfRepo(records, r.repo);
    const f = flowOf(comp, isPlanned(r.repo));
    if (r.has === "calls") {
      const { target, entry } = callOf(r.what);
      const to = componentOfRepo(records, target);
      f.steps.push({
        mark: "added",
        kind: "call-out",
        to: { component: to, entry, ...(isPlanned(target) ? { new: true } : {}) },
      });
    } else if (r.has === "publishes")
      f.steps.push({ mark: "added", kind: "publish", to: { component: r.what, entry: r.what } });
    else if (r.has === "listens")
      flowOf(r.what, false).steps.push({
        mark: "added",
        kind: "publish",
        to: { component: comp, entry: r.what },
      });
    else if (r.has === "table" || r.has === "column" || r.has === "migration") {
      const table = r.has === "column" ? r.what.slice(0, r.what.lastIndexOf(".")) : r.what;
      if (r.has === "migration") f.steps.push({ mark: "added", kind: "store" });
      else
        f.steps.push({
          mark: "added",
          kind: "store",
          store: {
            table,
            columns: r.has === "column" ? [r.what.slice(r.what.lastIndexOf(".") + 1)] : [],
            ...(tables.has(table) ? {} : { new: true }),
          },
        });
    } else f.steps.push({ mark: "added", kind: "entry" });
  }
  return [...flows.values()];
}

/** A change's target flows merged with today's, and what reading them needs (ADR 0108, 0109). */
export interface TargetFlows {
  title: string;
  /** The target-flow folder, relative to the metarepo. */
  source: string;
  merged: MergedFlow[];
  /** The target flows as the change folder has them. */
  deltas: FlowDelta[];
  problems: string[];
  records: CatalogRecord[];
  /** Every component today's specs name, catalog or not. */
  known: Set<string>;
  /** ADR 0193: components whose every flow today the change removes (retired or absorbed). */
  retired: Set<string>;
}

/** The change's target flows; undefined when there is no such change. */
export async function targetFlowsOf(
  root: string,
  change: string,
): Promise<TargetFlows | undefined> {
  const dir = join(changesDirOf(root), change);
  if (!(await stat(join(dir, "change.yaml")).catch(() => undefined))) return undefined;
  const title = await changeStore(root)
    .read(change)
    .then((c) => c.title)
    .catch(() => change);
  const { deltas, problems } = await readDeltas(dir);
  const repos = new Set(await specRepos(root));
  const specs = new Map<string, Awaited<ReturnType<typeof readRepoSpec>>>();
  const merged: MergedFlow[] = [];
  for (const d of deltas) {
    if (repos.has(d.repo) && !specs.has(d.repo))
      specs.set(d.repo, await readRepoSpec(root, d.repo, { cacheRoot: root }));
    const m = mergeDelta(
      d,
      specs.get(d.repo)?.flows.find((f) => f.id === d.flow),
    );
    problems.push(...m.problems);
    merged.push(m);
  }
  // Catalog problems are the catalog's to report; the picture draws what reads.
  const { records } = await loadCatalog(root, { out: () => undefined, err: () => undefined });
  const known = new Set<string>();
  const kept = new Set<string>();
  const removed = new Set(deltas.filter((d) => d.change === "remove").map((d) => d.flow));
  const gone = new Set<string>();
  for (const repo of repos) {
    const spec = specs.get(repo) ?? (await readRepoSpec(root, repo, { cacheRoot: root }));
    for (const f of spec.flows) {
      known.add(f.component);
      (removed.has(f.id) ? gone : kept).add(f.component);
    }
  }
  const retired = new Set([...gone].filter((c) => !kept.has(c)));
  return {
    title,
    source: `${changesRelOf(root)}/${change}/${TARGET_DIR}`,
    merged,
    deltas,
    problems,
    records,
    known,
    retired,
  };
}

/** The change's picture; undefined when there is no such change. */
export async function changeMapOf(root: string, change: string): Promise<ChangeMap | undefined> {
  const t = await targetFlowsOf(root, change);
  if (!t) return undefined;
  const q = t.merged.length ? undefined : await quickViewOf(root, change);
  if (q) {
    // A repo a manifest lists is known, read or not: only what the change plans is new.
    const listed = await loadRepos(root).then(
      (rs) => rs.map((r) => r.id),
      () => [] as string[],
    );
    const known = new Set([
      ...t.known,
      ...listed,
      ...t.records.flatMap((r) => [
        r.id,
        ...((r as { repo?: string }).repo ? [(r as { repo?: string }).repo!] : []),
      ]),
    ]);
    const flows = quickFlows(q, t.records, (id) => known.has(id));
    const notDrawn = q.rows.filter((r) => !CODE_HAS.has(r.has)).length;
    return {
      view: changeView(t.records, { id: change, title: t.title, source: q.source }, flows, t.known),
      title: t.title,
      source: q.source,
      flows: 0,
      from: q.from,
      rows: q.rows.length,
      ...(notDrawn ? { notDrawn } : {}),
      problems: [
        ...t.problems,
        ...(q.from === "tasks"
          ? [
              "design.md doesn't say what the code will have yet, so no line is drawn: its ## In the code does.",
            ]
          : []),
      ],
    };
  }
  return {
    view: changeView(
      t.records,
      { id: change, title: t.title, source: t.source },
      t.merged,
      t.known,
      t.retired,
    ),
    title: t.title,
    source: t.source,
    flows: t.merged.length,
    problems: t.problems,
  };
}

/** The API's body: the picture, and the same as Mermaid. */
export function changeMapBody(change: string, m: ChangeMap): Api.ChangeMapT {
  return {
    change,
    title: m.title,
    source: m.source,
    groups: m.view.groups,
    nodes: m.view.nodes,
    edges: m.view.edges,
    mermaid: toMermaid(m.view),
    flows: m.flows,
    ...(m.from ? { from: m.from, rows: m.rows ?? 0 } : {}),
    problems: m.problems,
  };
}

/**
 * atticus change map <change> [--format mermaid|drawio] [--json]: the change's picture. Exit 0
 * drawn (or any JSON answer), 1 when the change has no target flows yet, 2 when there is no
 * such change.
 */
export async function changeMapCommand(
  root: string,
  change: string,
  o: { format?: string; json?: boolean },
  io: Output,
): Promise<number> {
  const format = o.format ?? "mermaid";
  if (format !== "mermaid" && format !== "drawio") {
    io.err(`Unknown format "${format}": use mermaid or drawio.`);
    return 2;
  }
  const m = await changeMapOf(root, change);
  if (!m) {
    io.err(`There is no change ${change}.`);
    return 2;
  }
  if (o.json) {
    // As JSON a change with no target flows yet is an answer (flows: 0), not a failure.
    io.out(JSON.stringify(changeMapBody(change, m), null, 2));
    return 0;
  }
  for (const p of m.problems) io.err(p);
  if (m.from === "design")
    io.err(
      `Drawn from design.md's In the code (${m.rows} row${m.rows === 1 ? "" : "s"}), not from target flows: ${change} is a quick change.${m.notDrawn ? ` ${m.notDrawn} row${m.notDrawn === 1 ? " is" : "s are"} deployment or a person's work, not drawn.` : ""}`,
    );
  if (!m.flows && !m.from) {
    io.err(
      `${change} has no target flows yet, so there is nothing to draw: the architecture stage writes them (atticus change architecture ${change}).`,
    );
    return 1;
  }
  io.out((format === "drawio" ? toDrawio(m.view) : toMermaid(m.view)).replace(/\n$/, ""));
  return 0;
}
