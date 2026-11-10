import type { Fact, FactOf } from "@maycombhq/core";

/**
 * Build coordinates (ADR 0192): what a Maven pom or a Gradle build says a component publishes
 * (its group and name) and what it builds on (its dependencies), each with its line. A small
 * deterministic reader of the two formats, line by line, no XML or Groovy parser: the verifier
 * checks an `artifact` or `dependency` fact against it, so a claim must be the project's own
 * coordinates, or a real dependency, on the very line it cites; and the cross-check lists the
 * coordinates a read build file writes that no kept fact records. Nothing here becomes a fact.
 */

/** A value as a build file writes it, and its line (1-based). */
export interface At {
  value: string;
  line: number;
}

/** One `<dependency>` block of a pom: its leaves, and where it sits. */
export interface PomDependency {
  group?: At;
  artifact?: At;
  version?: At;
  scope?: At;
  /** Under `<dependencyManagement>`: a version pinned, no dependency. */
  managed: boolean;
  /** Under a `<plugin>`: the plugin's own class path, not the component's. */
  plugin: boolean;
}

export interface PomCoordinates {
  /** The project's own `<groupId>`, `<artifactId>` and `<version>`. */
  group?: At;
  artifact?: At;
  version?: At;
  /** Its `<parent>`'s, which a module inherits its group and version from. */
  parentGroup?: At;
  parentArtifact?: At;
  parentVersion?: At;
  dependencies: PomDependency[];
}

const POM = /(^|\/)pom\.xml$|\.pom$/i;
const GRADLE_BUILD = /(^|\/)build\.gradle(\.kts)?$/i;
const GRADLE_SETTINGS = /(^|\/)settings\.gradle(\.kts)?$/i;

export const isPomFile = (p: string) => POM.test(p.replace(/\\/g, "/"));
export const isGradleFile = (p: string) =>
  GRADLE_BUILD.test(p.replace(/\\/g, "/")) || GRADLE_SETTINGS.test(p.replace(/\\/g, "/"));
export const isBuildFile = (p: string) => isPomFile(p) || isGradleFile(p);

const TAG = /<(\/?)([A-Za-z_][\w.:-]*)([^>]*?)(\/?)>/g;

interface Frame {
  name: string;
  /** The leaves written inside it (an element with text and no element in it). */
  leaves: Map<string, At>;
  children: boolean;
  text: string;
  textLine: number;
}

/** A pom's coordinates and dependencies, read from its lines; comments and CDATA left out. */
export function pomCoordinates(lines: readonly string[]): PomCoordinates {
  const out: PomCoordinates = { dependencies: [] };
  const stack: Frame[] = [];
  let inComment = false;
  const names = () => stack.map((f) => f.name);
  lines.forEach((raw, i) => {
    const n = i + 1;
    // comments may span lines: what they hold is left out
    let line = "";
    let rest = raw;
    while (rest.length) {
      if (inComment) {
        const end = rest.indexOf("-->");
        if (end < 0) break;
        rest = rest.slice(end + 3);
        inComment = false;
        continue;
      }
      const start = rest.indexOf("<!--");
      if (start < 0) {
        line += rest;
        break;
      }
      line += rest.slice(0, start);
      rest = rest.slice(start + 4);
      inComment = true;
    }
    let last = 0;
    for (const m of line.matchAll(TAG)) {
      const text = line.slice(last, m.index);
      last = m.index! + m[0].length;
      const top = stack[stack.length - 1];
      if (top && text.trim() && !top.text) {
        top.text = text.trim();
        top.textLine = n;
      }
      if (m[2]!.startsWith("?") || m[0].startsWith("<!")) continue;
      const close = m[1] === "/";
      const selfClosing = m[4] === "/";
      if (!close) {
        if (top) top.children = true;
        if (selfClosing) continue;
        stack.push({ name: m[2]!, leaves: new Map(), children: false, text: "", textLine: n });
        continue;
      }
      // a close tag: pop to the element it closes (a stray close is ignored)
      const at = names().lastIndexOf(m[2]!);
      if (at < 0) continue;
      while (stack.length > at + 1) stack.pop();
      const done = stack.pop()!;
      const parent = stack[stack.length - 1];
      if (!done.children && done.text && parent)
        parent.leaves.set(done.name, { value: done.text, line: done.textLine });
      const path = [...names(), done.name];
      if (done.name === "dependency") {
        out.dependencies.push({
          ...(done.leaves.get("groupId") ? { group: done.leaves.get("groupId")! } : {}),
          ...(done.leaves.get("artifactId") ? { artifact: done.leaves.get("artifactId")! } : {}),
          ...(done.leaves.get("version") ? { version: done.leaves.get("version")! } : {}),
          ...(done.leaves.get("scope") ? { scope: done.leaves.get("scope")! } : {}),
          managed: path.includes("dependencyManagement"),
          plugin: path.includes("plugin") || path.includes("extension"),
        });
      } else if (done.name === "parent" && path.length === 2 && path[0] === "project") {
        if (done.leaves.get("groupId")) out.parentGroup = done.leaves.get("groupId")!;
        if (done.leaves.get("artifactId")) out.parentArtifact = done.leaves.get("artifactId")!;
        if (done.leaves.get("version")) out.parentVersion = done.leaves.get("version")!;
      } else if (done.name === "project" && path.length === 1) {
        if (done.leaves.get("groupId")) out.group = done.leaves.get("groupId")!;
        if (done.leaves.get("artifactId")) out.artifact = done.leaves.get("artifactId")!;
        if (done.leaves.get("version")) out.version = done.leaves.get("version")!;
      }
    }
    const top = stack[stack.length - 1];
    const tail = line.slice(last);
    if (top && tail.trim() && !top.text) {
      top.text = tail.trim();
      top.textLine = n;
    }
  });
  return out;
}

/** A Gradle dependency declaration on one line. */
export interface GradleDependency {
  configuration: string;
  group: string;
  name: string;
  version?: string;
  /** What the configuration means, as a pom's `<scope>` would say it. */
  scope: "compile" | "runtime" | "provided" | "test" | "import";
}

const QUOTED = `(['"])([^'"\\s]+)\\`;
/** `implementation 'g:a:v'`, `api("g:a:v")`, `testImplementation(platform("g:a:v"))`. */
const GRADLE_DEP = new RegExp(
  `^\\s*([A-Za-z][\\w]*)\\s*\\(?\\s*(?:(platform|enforcedPlatform)\\s*\\(\\s*)?${QUOTED}3`,
);
/** `implementation group: 'g', name: 'a', version: 'v'`. */
const GRADLE_MAP_DEP =
  /^\s*([A-Za-z]\w*)\s*\(?\s*group\s*[:=]\s*(['"])([^'"]+)\2\s*,\s*name\s*[:=]\s*(['"])([^'"]+)\4(?:\s*,\s*version\s*[:=]\s*(['"])([^'"]+)\6)?/;
const NOT_A_CONFIGURATION = new Set(["id", "apply", "plugin", "include", "classpath", "group"]);

function scopeOfConfiguration(c: string, platform: boolean): GradleDependency["scope"] {
  if (platform) return "import";
  if (/^test/i.test(c)) return "test";
  if (/^(compileOnly|annotationProcessor|kapt|compileOnlyApi)$/i.test(c)) return "provided";
  if (/^runtimeOnly$/i.test(c)) return "runtime";
  return "compile";
}

/** The dependency a Gradle build line declares, or undefined when it declares none. */
export function gradleDependencyOn(line: string): GradleDependency | undefined {
  const map = GRADLE_MAP_DEP.exec(line);
  if (map && !NOT_A_CONFIGURATION.has(map[1]!))
    return {
      configuration: map[1]!,
      group: map[3]!,
      name: map[5]!,
      ...(map[7] ? { version: map[7] } : {}),
      scope: scopeOfConfiguration(map[1]!, false),
    };
  const m = GRADLE_DEP.exec(line);
  if (!m || NOT_A_CONFIGURATION.has(m[1]!)) return undefined;
  const parts = m[4]!.split(":");
  if (parts.length < 2 || !parts[0] || !parts[1]) return undefined;
  return {
    configuration: m[1]!,
    group: parts[0],
    name: parts[1],
    ...(parts[2] ? { version: parts[2] } : {}),
    scope: scopeOfConfiguration(m[1]!, !!m[2]),
  };
}

/** `group = 'g'` in a Gradle build, or `group "g"`. */
export function gradleGroupOn(line: string): string | undefined {
  return /^\s*(?:project\.)?group\s*=?\s*(['"])([^'"]+)\1\s*$/.exec(line)?.[2];
}

/** The project name a Gradle line sets: `rootProject.name`, `archivesBaseName`, `archivesName`. */
export function gradleNameOn(line: string): string | undefined {
  return /^\s*(?:rootProject\.name|archivesBaseName|(?:base\.)?archivesName(?:\.set)?)\s*[=(]?\s*(['"])([^'"]+)\1\s*\)?\s*$/.exec(
    line,
  )?.[2];
}

type Coordinates = FactOf<"artifact"> | FactOf<"dependency">;
type LinesOf = (path: string) => readonly string[] | undefined;

const PROJECT_GROUP = /^\$\{(project\.|pom\.)?groupId\}$/;

/** Whether `line` of `file` is the cite's own line or one of its `cite.with` parts. */
const citedLine = (f: Fact, file: string, line: number) =>
  (f.cite.file === file && f.cite.line === line) ||
  (f.cite.with ?? []).some((p) => p.file === file && p.line === line);

/**
 * Why an artifact or dependency fact doesn't follow from the build file it cites, or undefined
 * when it does (ADR 0192). The cited line must write the name the fact claims, as the project's
 * own coordinates (an artifact) or a dependency's (a dependency, never a dependency-management
 * entry or a plugin's); the line that writes the group must be cited too, and say the same; a
 * dependency's scope must be the one declared.
 */
export function buildCoordinatesProblem(f: Coordinates, linesOf: LinesOf): string | undefined {
  const file = f.cite.file;
  const label = `${f.kind} ${f.id}`;
  const lines = linesOf(file);
  if (!lines) return undefined; // the line check says the file is missing
  const where = `${file}:${f.cite.line}`;
  if (isPomFile(file)) return pomProblem(f, label, where, pomCoordinates(lines));
  if (isGradleFile(file)) return gradleProblem(f, label, where, lines, linesOf);
  return `${label} cites ${file}, which is no build file Atticus reads coordinates from: cite the pom.xml, build.gradle or settings.gradle line that writes them`;
}

function pomProblem(
  f: Coordinates,
  label: string,
  where: string,
  pom: PomCoordinates,
): string | undefined {
  const line = f.cite.line;
  const file = f.cite.file;
  if (f.kind === "artifact") {
    if (pom.artifact?.line !== line) {
      const dep = pom.dependencies.find((d) => d.artifact?.line === line);
      const what = dep
        ? `a dependency's <artifactId> (${dep.artifact!.value})`
        : pom.parentArtifact?.line === line
          ? `the <parent>'s <artifactId> (${pom.parentArtifact.value})`
          : "not the project's own <artifactId>";
      return `${label} says ${where} is the coordinates the build publishes, and that line is ${what}${pom.artifact ? `: the project's own is at line ${pom.artifact.line}` : ""}`;
    }
    if (pom.artifact.value !== f.name)
      return `${label} names "${f.name}", and ${where} writes the project's artifactId as "${pom.artifact.value}"`;
    const group = pom.group ?? pom.parentGroup;
    if (!group)
      return `${label} names group "${f.group}", and ${file} writes no groupId of the project or its <parent>`;
    if (group.value !== f.group)
      return `${label} names group "${f.group}", and ${file}:${group.line} writes "${group.value}"${pom.group ? "" : " (the <parent>'s, which the project inherits)"}`;
    if (!citedLine(f, file, group.line))
      return `${label}: the group is written at ${file}:${group.line}${pom.group ? "" : " (the <parent>'s)"}; cite that line in cite.with`;
    return undefined;
  }
  const dep = pom.dependencies.find((d) => d.artifact?.line === line);
  if (!dep) {
    const what =
      pom.artifact?.line === line
        ? "the project's own <artifactId>"
        : pom.parentArtifact?.line === line
          ? "the <parent>'s <artifactId>"
          : "no dependency's <artifactId>";
    return `${label} says ${where} declares a dependency, and that line is ${what}: cite the <artifactId> line of the <dependency> in <dependencies>`;
  }
  if (dep.managed)
    return `${label} cites ${where}, a <dependencyManagement> entry, which only pins a version: cite the dependency where <dependencies> declares it`;
  if (dep.plugin)
    return `${label} cites ${where}, a dependency of a build plugin, not of the component: leave it out`;
  if (dep.artifact!.value !== f.name)
    return `${label} names "${f.name}", and ${where} declares "${dep.artifact!.value}"`;
  if (!dep.group) return `${label}: the <dependency> at ${where} writes no <groupId>`;
  const ownGroup = pom.group ?? pom.parentGroup;
  const group = PROJECT_GROUP.test(dep.group.value) ? ownGroup : dep.group;
  if (!group || group.value !== f.group)
    return `${label} names group "${f.group}", and the <dependency> at ${where} writes "${dep.group.value}"${group && group !== dep.group ? ` (${group.value})` : ""}`;
  if (!citedLine(f, file, dep.group.line))
    return `${label}: the dependency's group is written at ${file}:${dep.group.line}; cite that line in cite.with`;
  const declared = dep.scope?.value ?? "compile";
  if (declared !== (f.scope ?? "compile"))
    return `${label} says scope ${f.scope ?? "compile"}, and the <dependency> at ${where} declares ${declared}${dep.scope ? ` (${file}:${dep.scope.line})` : ""}`;
  return undefined;
}

function gradleProblem(
  f: Coordinates,
  label: string,
  where: string,
  lines: readonly string[],
  linesOf: LinesOf,
): string | undefined {
  const text = lines[f.cite.line - 1] ?? "";
  if (f.kind === "dependency") {
    const d = gradleDependencyOn(text);
    if (!d)
      return `${label} says ${where} declares a dependency, and that line declares none: cite the line in dependencies { } that names it`;
    if (d.group !== f.group || d.name !== f.name)
      return `${label} names "${f.group}:${f.name}", and ${where} declares "${d.group}:${d.name}"`;
    if (d.scope !== (f.scope ?? "compile"))
      return `${label} says scope ${f.scope ?? "compile"}, and ${where} declares it with ${d.configuration} (${d.scope})`;
    return undefined;
  }
  const name = gradleNameOn(text);
  if (name === undefined)
    return `${label} says ${where} is the coordinates the build publishes, and that line sets no project name: cite rootProject.name in settings.gradle, or archivesBaseName`;
  if (name !== f.name) return `${label} names "${f.name}", and ${where} sets "${name}"`;
  const parts = [{ file: f.cite.file, line: f.cite.line }, ...(f.cite.with ?? [])];
  const groups = parts.flatMap((p) => {
    const g = gradleGroupOn(linesOf(p.file)?.[p.line - 1] ?? "");
    return g === undefined ? [] : [{ ...p, group: g }];
  });
  if (!groups.length)
    return `${label}: no line it cites sets the group; cite the build.gradle line that does (group = '${f.group}') in cite.with`;
  const g = groups[0]!;
  if (g.group !== f.group)
    return `${label} names group "${f.group}", and ${g.file}:${g.line} sets "${g.group}"`;
  return undefined;
}

/** Coordinates a read build file writes that no kept fact records (the cross-check). */
export interface BuildUnrecorded {
  /** `file:line` of the name's line. */
  cite: string;
  kind: "artifact" | "dependency";
  /** `group:name`, as the file writes them. */
  coordinates: string;
}

/**
 * The project coordinates and dependencies the given build files write that no kept artifact or
 * dependency fact cites (ADR 0192): a note for the reader, never a rejection. Only the build
 * files a kept fact cites are looked at, so a read made before the rule is topped up, not
 * flooded; a pom's management entries and plugins' dependencies are no dependencies.
 */
export function buildUnrecorded(
  files: readonly string[],
  linesOf: LinesOf,
  kept: readonly Fact[],
): BuildUnrecorded[] {
  const cited = new Set(
    kept
      .filter((f) => f.kind === "artifact" || f.kind === "dependency")
      .map((f) => `${f.cite.file}:${f.cite.line}`),
  );
  const out: BuildUnrecorded[] = [];
  const add = (file: string, line: number, kind: BuildUnrecorded["kind"], c: string) => {
    if (!cited.has(`${file}:${line}`)) out.push({ cite: `${file}:${line}`, kind, coordinates: c });
  };
  for (const file of [...files].sort()) {
    const lines = linesOf(file);
    if (!lines) continue;
    if (isPomFile(file)) {
      const pom = pomCoordinates(lines);
      const group = pom.group ?? pom.parentGroup;
      if (pom.artifact)
        add(file, pom.artifact.line, "artifact", `${group?.value ?? "?"}:${pom.artifact.value}`);
      for (const d of pom.dependencies)
        if (!d.managed && !d.plugin && d.artifact)
          add(file, d.artifact.line, "dependency", `${d.group?.value ?? "?"}:${d.artifact.value}`);
    } else if (GRADLE_BUILD.test(file.replace(/\\/g, "/"))) {
      lines.forEach((l, i) => {
        const d = gradleDependencyOn(l);
        if (d && d.scope !== "import") add(file, i + 1, "dependency", `${d.group}:${d.name}`);
      });
    }
  }
  return out;
}
