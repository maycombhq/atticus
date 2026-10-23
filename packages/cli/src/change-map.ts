import { stat } from "node:fs/promises";
import { join } from "node:path";
import { changeStore } from "@maycombhq/changes";
import { changesDirOf, changesRelOf, readRepoSpec, specRepos, type Api } from "@maycombhq/core";
import { changeView, toDrawio, toMermaid, type FlowView } from "@maycombhq/diagrams";
import { mergeDelta, readDeltas, TARGET_DIR } from "@maycombhq/planner";
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
}

/** The change's picture; undefined when there is no such change. */
export async function changeMapOf(root: string, change: string): Promise<ChangeMap | undefined> {
  const dir = join(changesDirOf(root), change);
  if (!(await stat(join(dir, "change.yaml")).catch(() => undefined))) return undefined;
  const title = await changeStore(root)
    .read(change)
    .then((c) => c.title)
    .catch(() => change);
  const { deltas, problems } = await readDeltas(dir);
  const repos = new Set(await specRepos(root));
  const specs = new Map<string, Awaited<ReturnType<typeof readRepoSpec>>>();
  const merged = [];
  for (const d of deltas) {
    if (repos.has(d.repo) && !specs.has(d.repo))
      specs.set(d.repo, await readRepoSpec(root, d.repo));
    const m = mergeDelta(
      d,
      specs.get(d.repo)?.flows.find((f) => f.id === d.flow),
    );
    problems.push(...m.problems);
    merged.push(m);
  }
  // Catalog problems are the catalog's to report; the picture draws what reads.
  const { records } = await loadCatalog(root, { out: () => undefined, err: () => undefined });
  const source = `${changesRelOf(root)}/${change}/${TARGET_DIR}`;
  // Every component today's specs name is known, catalog or not.
  const known = new Set<string>();
  for (const repo of repos) {
    const spec = specs.get(repo) ?? (await readRepoSpec(root, repo));
    for (const f of spec.flows) known.add(f.component);
  }
  return {
    view: changeView(records, { id: change, title, source }, merged, known),
    title,
    source,
    flows: deltas.length,
    problems,
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
  if (!m.flows) {
    io.err(
      `${change} has no target flows yet, so there is nothing to draw: the architecture stage writes them (atticus change architecture ${change}).`,
    );
    return 1;
  }
  io.out((format === "drawio" ? toDrawio(m.view) : toMermaid(m.view)).replace(/\n$/, ""));
  return 0;
}
