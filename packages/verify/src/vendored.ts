import { globToRegExp } from "@maycombhq/sdk";

/**
 * Projects inside a repo that aren't part of its build (ADR 0124 addendum A-big2): a library
 * cloned into a reference folder, or a library's source copied in with its LICENSE. The estimate
 * proposes them as vendored (read-plan.ts); a person accepts each in the org pack. Conservative:
 * a module of the build, a workspace package, or a folder of the repo's own packages is never
 * proposed, and without the files' text a project with its own build file isn't either.
 */

/** A licence file, as a project's own. */
export const LICENSE_FILE = /^(LICEN[CS]E|COPYING)([._-][^/]*)?$/i;
/** A build file: a project of its own. */
export const BUILD_FILE =
  /^(pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|package\.json|go\.mod|Cargo\.toml|pyproject\.toml|setup\.py|setup\.cfg|composer\.json|Gemfile|[^/]+\.(csproj|vbproj|fsproj|sln))$/i;
/** Build files that list the modules a build includes. */
const AGGREGATOR =
  /^(pom\.xml|settings\.gradle(\.kts)?|package\.json|pnpm-workspace\.yaml|lerna\.json|Cargo\.toml|go\.work)$/;

const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const under = (path: string, dir: string) => !dir || path.startsWith(`${dir}/`);
const quoted = (s: string) => [...s.matchAll(/["']([^"'\n]+)["']/g)].map((m) => m[1]!);
/** A module path as written (`./libs/x/`, `:libs:x`) as a folder relative to the build file. */
const clean = (m: string) =>
  m
    .trim()
    .replace(/^\.\//, "")
    .replace(/\/pom\.xml$/, "")
    .replace(/\/+$/, "");

/** The JSON value of a file, or undefined when it isn't JSON. */
function json(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/**
 * The folders a build file includes as modules, repo-relative (a workspace entry may be a glob):
 * Maven's `<module>`, Gradle's `include`, `includeBuild` and `projectDir`, npm and yarn
 * `workspaces`, pnpm's `packages:`, lerna's `packages`, Cargo's workspace `members` and go.work's
 * `use`. Any other file includes none.
 */
export function buildModules(path: string, text: string): string[] {
  const name = nameOf(path);
  const dir = dirOf(path);
  let found: string[] = [];
  if (name === "pom.xml")
    found = [...text.matchAll(/<module>\s*([^<]+?)\s*<\/module>/g)].map((m) => m[1]!);
  else if (/^settings\.gradle(\.kts)?$/.test(name)) {
    const calls = /\binclude(Build|Flat)?\b\s*(\(([^)]*)\)|((?:\s*["'][^"'\n]+["']\s*,?)+))/g;
    for (const m of text.matchAll(calls))
      for (const q of quoted(m[3] ?? m[4] ?? ""))
        found.push(m[1] === "Build" ? q : q.replace(/^:/, "").replace(/:/g, "/"));
    for (const m of text.matchAll(/projectDir\s*=\s*(?:file|new\s+File)\s*\(([^)]*)\)/g)) {
      const q = quoted(m[1]!);
      if (q.length) found.push(q[q.length - 1]!);
    }
  } else if (name === "package.json") {
    const w = (json(text) as { workspaces?: unknown } | undefined)?.workspaces;
    found = Array.isArray(w) ? strings(w) : strings((w as { packages?: unknown })?.packages);
  } else if (name === "lerna.json")
    found = strings((json(text) as { packages?: unknown } | undefined)?.packages);
  else if (name === "pnpm-workspace.yaml") {
    let inPackages = false;
    for (const line of text.split(/\r?\n/)) {
      if (/^packages:\s*$/.test(line)) inPackages = true;
      else if (/^\S/.test(line)) inPackages = false;
      else if (inPackages) {
        const m = /^\s*-\s*["']?([^"'#]+?)["']?\s*(#.*)?$/.exec(line);
        if (m) found.push(m[1]!);
      }
    }
  } else if (name === "Cargo.toml") {
    const m = /\[workspace\][^[]*?members\s*=\s*\[([^\]]*)\]/s.exec(text);
    if (m) found = quoted(m[1]!);
  } else if (name === "go.work") {
    for (const m of text.matchAll(/^\s*use\s*(\(([^)]*)\)|(\S+))/gm))
      found.push(...(m[2] ? m[2].split(/\s+/).filter(Boolean) : [m[3]!]));
  }
  return found
    .filter((m) => !m.startsWith("!"))
    .map(clean)
    .filter(Boolean)
    .map((m) => (dir ? `${dir}/${m}` : m));
}

const JAVA_LIKE = /\.(java|kt|kts|scala|groovy)$/i;
const DOTNET = /\.(cs|vb|fs)$/i;
/** The first two parts of a dotted name, lower case: `org.northwind.codec` is `org.northwind`. */
const rootOf = (name: string) => name.split(".").slice(0, 2).join(".").toLowerCase();

/** A Java, Kotlin, Scala, Groovy or .NET file's package root, from its `package` or `namespace`. */
export function packageRoot(path: string, text: string): string | undefined {
  const re = JAVA_LIKE.test(path)
    ? /^\s*package\s+([A-Za-z_][\w.]*)/m
    : DOTNET.test(path)
      ? /^\s*namespace\s+([A-Za-z_][\w.]*)/m
      : undefined;
  const m = re?.exec(text);
  return m ? rootOf(m[1]!) : undefined;
}

/** The files the packages of a set of files are read from, at most this many. */
const PACKAGE_SAMPLE = 2_000;

/**
 * The package roots of these files: a Java-like or .NET file's `package` or `namespace` (read),
 * and a Python file's top package folder (the outermost of a run of folders with `__init__.py`).
 */
function packageRoots(
  paths: readonly string[],
  inits: ReadonlySet<string>,
  read: (path: string) => string | undefined,
): Set<string> {
  const roots = new Set<string>();
  let readCount = 0;
  for (const p of paths) {
    if (/\.py$/i.test(p)) {
      let d = dirOf(p);
      let top: string | undefined;
      while (d && inits.has(d)) {
        top = d;
        d = dirOf(d);
      }
      if (top) roots.add(nameOf(top).toLowerCase());
    } else if ((JAVA_LIKE.test(p) || DOTNET.test(p)) && readCount < PACKAGE_SAMPLE) {
      readCount++;
      const r = packageRoot(p, read(p) ?? "");
      if (r) roots.add(r);
    }
  }
  return roots;
}

const listed = (names: readonly string[], max = 3) =>
  names.length > max
    ? `${names.slice(0, max).join(", ")} and ${names.length - max} more`
    : names.join(", ");

/** A folder proposed as vendored, with why in a person's words and the file it rests on. */
export interface VendoredProject {
  dir: string;
  why: string;
  /** Its LICENSE, `path:1`. */
  at: string;
}

/**
 * The vendored projects of a repo, from every file in it (`all`, source or not) and, when given,
 * their text:
 * - a non-root folder with its own LICENSE or COPYING and its own build file (setup.py,
 *   pyproject.toml, pom.xml, package.json, build.gradle and the like) that no build file above it
 *   includes as a module (Maven `<modules>`, Gradle settings, npm, yarn or pnpm workspaces, lerna,
 *   Cargo, go.work). Without the text, the modules can't be read and none is proposed;
 * - a non-root folder with its own LICENSE and no build file (a source tree copied in), unless its
 *   packages are the repo's own: proposed saying so when they differ, and as before (check before
 *   accepting) when the packages can't be told.
 * In path order; a folder inside another may be listed too (the proposals take the outermost).
 */
export function vendoredProjects(
  all: readonly string[],
  read?: (path: string) => string | undefined,
): VendoredProject[] {
  const files = [...all].sort(byPath);
  const licenses = new Map<string, string>();
  const builds = new Map<string, string[]>();
  for (const p of files) {
    const d = dirOf(p);
    if (LICENSE_FILE.test(nameOf(p)) && !licenses.has(d)) licenses.set(d, p);
    if (BUILD_FILE.test(nameOf(p))) builds.set(d, [...(builds.get(d) ?? []), nameOf(p)]);
  }
  const modules: { from: string; re: RegExp }[] = [];
  if (read)
    for (const p of files)
      if (AGGREGATOR.test(nameOf(p)))
        for (const m of buildModules(p, read(p) ?? ""))
          modules.push({ from: dirOf(p), re: globToRegExp(m) });
  const included = (dir: string) =>
    modules.some((m) => m.from !== dir && under(dir, m.from) && m.re.test(dir));

  const nested: VendoredProject[] = [];
  const copied: string[] = [];
  for (const [dir, license] of licenses) {
    if (!dir) continue;
    const own = builds.get(dir);
    if (!own) copied.push(dir);
    else if (read && !included(dir))
      nested.push({
        dir,
        at: `${license}:1`,
        why: `a project of its own (${[nameOf(license), ...own].sort(byPath).join(", ")}) that the repo's build doesn't include as a module: vendored third-party code? Check before accepting`,
      });
  }

  // The repo's own packages: of every file outside the folders that may be vendored.
  const out: VendoredProject[] = [...nested];
  if (copied.length) {
    const inits = new Set(files.filter((p) => nameOf(p) === "__init__.py").map(dirOf));
    const apart = [...copied, ...nested.map((n) => n.dir)];
    const text = read ?? (() => undefined);
    const mine = packageRoots(
      files.filter((p) => !apart.some((d) => under(p, d))),
      inits,
      text,
    );
    for (const dir of copied) {
      const theirs = packageRoots(
        files.filter((p) => under(p, dir)),
        inits,
        text,
      );
      const shared = [...theirs].some((r) => mine.has(r));
      if (shared) continue;
      const known = theirs.size > 0 && mine.size > 0;
      out.push({
        dir,
        at: `${licenses.get(dir)!}:1`,
        why: known
          ? `its own LICENSE and no build file, and its packages (${listed([...theirs].sort(byPath))}) aren't the repo's own (${listed([...mine].sort(byPath))}): a vendored copy of third-party code? Check before accepting`
          : "its own LICENSE and no build file: a vendored copy of third-party code? Check before accepting",
      });
    }
  }
  return out.sort((a, b) => byPath(a.dir, b.dir));
}
