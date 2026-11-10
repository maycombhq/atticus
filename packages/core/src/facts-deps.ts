import { factIdPart } from "./facts.js";
import type { FactEnd, JoinRepo } from "./facts-join.js";
import type { DependencyScope, Fact, FactOf } from "./schema/facts.js";

/**
 * The estate's build dependencies (ADR 0192): a component's `dependency` fact that names the
 * coordinates (group and name) another component's `artifact` fact publishes is a "depends on"
 * link from the one to the other, with a cited line at both ends: the dependency's in the
 * depending build file, the published coordinates' in the library's. Matching is by those
 * coordinates alone, letter case aside: no group prefix, naming convention or repo type says
 * what is the organisation's own; what some repo of the estate publishes is.
 *
 * - A dependency on coordinates nobody in the estate publishes (a vendor SDK, an open-source
 *   library) draws nothing and asks nothing: it is counted in `outside`.
 * - A test-scoped dependency draws nothing (`test`): it builds the tests, not the component.
 * - Coordinates two components publish draw nothing either: they are `ambiguous`, for a person.
 * - A component's dependency on its own coordinates draws nothing.
 *
 * The library's own calls are the library's: nothing here touches a call, and nothing of the
 * library is given to the components that depend on it. Pure: the same facts give the same
 * links, whatever order the repos come in.
 */

/** One end of a "depends on" link: its fact, and every line the claim rests on (`file:line`). */
export interface DependencyEnd extends FactEnd {
  lines: string[];
}

export interface DependencyLink {
  /** The dependency fact, in the component that builds on the library. */
  from: DependencyEnd;
  /** The artifact fact, in the library's component, that publishes the coordinates. */
  to: DependencyEnd;
  group: string;
  name: string;
  /** The dependency's declared scope, when it says one other than compile. */
  scope?: DependencyScope;
  /** The version the dependency declares, when it says one. */
  version?: string;
}

/** Coordinates two or more components of the estate publish: nothing is drawn to either. */
export interface AmbiguousCoordinates {
  group: string;
  name: string;
  by: FactEnd[];
}

export interface DependencyJoinResult {
  links: DependencyLink[];
  ambiguous: AmbiguousCoordinates[];
  /** Dependencies on coordinates nobody in the estate publishes: drawn as nothing. */
  outside: number;
  /** Test-scoped dependencies on the estate's own coordinates: drawn as nothing. */
  test: number;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const coordinates = (f: { group: string; name: string }) =>
  `${f.group.trim().toLowerCase()}:${f.name.trim().toLowerCase()}`;

function endOf(repo: string, component: string, f: Fact): DependencyEnd {
  const at = `${f.cite.file}:${f.cite.line}`;
  const lines = [at];
  for (const p of f.cite.with ?? []) {
    const l = `${p.file}:${p.line}`;
    if (!lines.includes(l)) lines.push(l);
  }
  return { repo, fact: f.id, component, at, lines };
}

export function joinDependencies(input: { repos: readonly JoinRepo[] }): DependencyJoinResult {
  const repos = [...input.repos].sort((x, y) => cmp(x.repo, y.repo));
  const componentOf = (r: JoinRepo, f: Fact) => factIdPart(f.component ?? r.component ?? r.repo);
  const byId = (x: Fact, y: Fact) => cmp(x.id, y.id);

  // What the estate publishes, by coordinates: every component that says it does.
  const published = new Map<string, DependencyEnd[]>();
  for (const r of repos)
    for (const f of [...r.facts].sort(byId)) {
      if (f.kind !== "artifact") continue;
      const k = coordinates(f);
      const end = endOf(r.repo, componentOf(r, f), f);
      const list = published.get(k) ?? [];
      // the same component saying it twice (two reads of one pom) is one publisher
      if (!list.some((e) => e.repo === end.repo && e.component === end.component)) list.push(end);
      published.set(k, list);
    }

  const ambiguous: AmbiguousCoordinates[] = [];
  const facts = new Map<string, FactOf<"artifact">>();
  for (const r of repos)
    for (const f of r.facts) if (f.kind === "artifact") facts.set(`${r.repo}\u0000${f.id}`, f);
  for (const [, ends] of [...published.entries()].sort(([a], [b]) => cmp(a, b))) {
    if (ends.length < 2) continue;
    const f = facts.get(`${ends[0]!.repo}\u0000${ends[0]!.fact}`)!;
    ambiguous.push({
      group: f.group,
      name: f.name,
      by: ends.map(({ repo, fact, component, at }) => ({ repo, fact, component, at })),
    });
  }

  const links: DependencyLink[] = [];
  const seen = new Set<string>();
  let outside = 0;
  let test = 0;
  for (const r of repos)
    for (const f of [...r.facts].sort(byId)) {
      if (f.kind !== "dependency") continue;
      const to = published.get(coordinates(f));
      if (!to) {
        outside++;
        continue;
      }
      if (to.length !== 1) continue;
      if (f.scope === "test") {
        test++;
        continue;
      }
      // An `import` scope is a BOM a dependency-management block brings in: no dependency.
      if (f.scope === "import") continue;
      const from = endOf(r.repo, componentOf(r, f), f);
      const lib = to[0]!;
      if (from.repo === lib.repo && from.component === lib.component) continue;
      const key = `${from.repo}\u0000${from.component}\u0000${lib.repo}\u0000${lib.component}\u0000${coordinates(f)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const pub = facts.get(`${lib.repo}\u0000${lib.fact}`)!;
      links.push({
        from,
        to: lib,
        group: pub.group,
        name: pub.name,
        ...(f.scope && f.scope !== "compile" ? { scope: f.scope } : {}),
        ...(f.version ? { version: f.version } : {}),
      });
    }
  links.sort(
    (a, b) =>
      cmp(a.from.component, b.from.component) ||
      cmp(a.to.component, b.to.component) ||
      cmp(a.from.repo, b.from.repo) ||
      cmp(a.from.fact, b.from.fact),
  );
  return { links, ambiguous, outside, test };
}

/** The id a "depends on" link is known by, for a view's join: stable across reads of one pom. */
export const dependencyLinkId = (l: Pick<DependencyLink, "from" | "to">): string =>
  `depends-on:${l.from.repo}/${l.from.component}>${l.to.repo}/${l.to.component}`;
