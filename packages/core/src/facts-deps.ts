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

/**
 * Review of beta.25: one dependency fact a link rests on, with the coordinates it names (a link
 * between two components holds every coordinate one builds on of the other's: `kit-api` and
 * `kit-core` of component `kit` are one arrow).
 */
export interface DependencyFactEnd extends DependencyEnd {
  group: string;
  name: string;
  version?: string;
  /** Its scope, when not compile. */
  scope?: DependencyScope;
}

export interface DependencyLink {
  /** The dependency fact, in the component that builds on the library (the first by id). */
  from: DependencyEnd;
  /**
   * Beta.25: every dependency fact the link rests on, `from` first, each with its lines: two
   * module poms of one component, a `<profile>`'s copy, `implementation` and `runtimeOnly` of the
   * same coordinates, and (review of beta.25) every other coordinate of the same library
   * component, each with its coordinates. The link goes only once each of them is wrong.
   */
  facts?: (DependencyEnd &
    Partial<Pick<DependencyFactEnd, "group" | "name" | "version" | "scope">>)[];
  /** The artifact fact, in the library's component, that publishes the coordinates. */
  to: DependencyEnd;
  /**
   * Review of beta.25: every artifact fact of the library's component a dependency on the link
   * names, `to` first (one per coordinate).
   */
  published?: DependencyEnd[];
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

/** A cited file's folder, `/` separated. */
const dirOf = (file: string) => {
  const f = file.replace(/\\/g, "/");
  return f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "";
};
const normDir = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");

/**
 * The component a build fact belongs to: its own `component`, else the manifest's module whose
 * folder holds (or is under) the build file it cites (beta.25), else the repo's.
 */
function buildComponentOf(r: JoinRepo, f: Fact): string {
  if (f.component) return f.component;
  // A dependency cited on a Gradle version catalog's entry is the module's whose build line names
  // its alias (`cite.with`'s build.gradle(.kts) line).
  const catalog = /(^|\/)gradle\/[\w-]+\.versions\.toml$/i.test(f.cite.file.replace(/\\/g, "/"));
  const build = catalog
    ? (f.cite.with ?? []).find((p) => /(^|[/\\])build\.gradle(\.kts)?$/i.test(p.file))?.file
    : f.cite.file;
  const dir = dirOf(build ?? f.cite.file);
  const mod = [...(r.moduleDirs ?? [])]
    .map((m) => ({ ...m, path: normDir(m.path) }))
    .filter((m) => m.path && (dir === m.path || dir.startsWith(`${m.path}/`)))
    .sort((a, b) => b.path.length - a.path.length)[0];
  return mod?.component ?? r.component ?? r.repo;
}

export function joinDependencies(input: { repos: readonly JoinRepo[] }): DependencyJoinResult {
  const repos = [...input.repos].sort((x, y) => cmp(x.repo, y.repo));
  const componentOf = (r: JoinRepo, f: Fact) => factIdPart(buildComponentOf(r, f));
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
  const seen = new Map<string, DependencyLink>();
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
      const pub = facts.get(`${lib.repo}\u0000${lib.fact}`)!;
      const fact: DependencyFactEnd = {
        ...from,
        group: pub.group,
        name: pub.name,
        ...(f.version ? { version: f.version } : {}),
        ...(f.scope && f.scope !== "compile" ? { scope: f.scope } : {}),
      };
      // Review of beta.25: one link per pair of components, whatever coordinates it rests on, so
      // a view's join (known by the pair) never stands for one coordinate and hides another.
      const key = `${from.repo}\u0000${from.component}\u0000${lib.repo}\u0000${lib.component}`;
      const twin = seen.get(key);
      if (twin) {
        // Beta.25: the same dependency on another line, or another coordinate of the library, is
        // on the link too, so marking one wrong never leaves the link standing on another unseen.
        twin.facts!.push(fact);
        if (!twin.published!.some((p) => p.repo === lib.repo && p.fact === lib.fact))
          twin.published!.push(lib);
        continue;
      }
      const link: DependencyLink = {
        from,
        facts: [fact],
        to: lib,
        published: [lib],
        group: pub.group,
        name: pub.name,
        ...(f.scope && f.scope !== "compile" ? { scope: f.scope } : {}),
        ...(f.version ? { version: f.version } : {}),
      };
      seen.set(key, link);
      links.push(link);
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

/**
 * The id a "depends on" link is known by, for a view's join: stable across reads of one pom, and
 * (review of beta.25) one per pair of components, as the join makes one link per pair.
 */
export const dependencyLinkId = (l: Pick<DependencyLink, "from" | "to">): string =>
  `depends-on:${l.from.repo}/${l.from.component}>${l.to.repo}/${l.to.component}`;
