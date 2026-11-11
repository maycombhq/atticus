import { factIdPart, type Fact, type FactOf } from "@maycombhq/core";

/**
 * Build coordinates (ADR 0192): what a Maven pom or a Gradle build says a component publishes
 * (its group and name) and what it builds on (its dependencies), each with its line. A small
 * deterministic reader of the two formats, no XML or Groovy parser: the verifier checks an
 * `artifact` or `dependency` fact against it, so a claim must be the project's own coordinates,
 * or a real dependency, on the very line it cites; and the cross-check lists the coordinates a
 * read build file writes that no kept fact records. Nothing here becomes a fact.
 *
 * Addendum (beta.25): a pom is read as one text with its line offsets kept, so a tag written over
 * several lines (the namespaced `<project xmlns=… xsi:schemaLocation=…>` a Spring Initializr or
 * Maven archetype pom starts with), a comment and a CDATA section are read wherever they break;
 * a `${property}` is resolved from the pom's `<properties>` and its `<parent>`. A Gradle build
 * is read with its blocks (`dependencies { }`, `dependencyManagement { }`, `subprojects { }`...),
 * so only a line directly in a project's `dependencies { }` declares a dependency; a multi-project
 * build's subprojects publish under the names `settings.gradle` includes them by. A build file
 * in a module's folder is that module's (`buildModuleOf`).
 *
 * Review of beta.25: a module is a component only when repos.manifest.yaml lists it; a repo whose
 * manifest entry lists no modules ships as one component, its manifest's, whatever folders its
 * build has (never a component named for a folder). A module's parent pom is found through its
 * `<relativePath>`, a pom whose `<modules>` lists it (`../cards-api` too), or `../pom.xml`, and a
 * `${property}` resolves through the parents' `<properties>` as well. A root Gradle build's
 * `subprojects { dependencies { } }` line is each subproject's dependency. What is read from a
 * build file's lines is held per lines array, so a 3,000-dependency pom is read once.
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
  /** Beta.25: the project's `<modules>` (a profile's too), as written. */
  modules: At[];
  /** Beta.25: the project's own `<properties>`, by name, each with its line. */
  properties: Map<string, At>;
  /**
   * Review of beta.25: the `<parent>`'s `<relativePath>` as written; `""` for `<relativePath/>`
   * (look the parent up in a repository, never in the folders).
   */
  parentRelativePath?: At;
}

/**
 * A pom: `pom.xml`, `*.pom`, and (beta.25) a parent pom named for what it is (`shared-pom.xml`,
 * `parent-pom.xml`, `parent.pom.xml`), the name a `<relativePath>` gives one beside its modules.
 */
const POM = /(^|\/)([^/]*[-_.])?pom\.xml$|\.pom$/i;
/** Review of beta.25: poms a plugin generates (the shade and flatten plugins'), never written by hand. */
const GENERATED_POM = /(^|\/)(dependency-reduced-pom\.xml|\.flattened-pom\.xml)$/i;
const GRADLE_BUILD = /(^|\/)build\.gradle(\.kts)?$/i;
const GRADLE_SETTINGS = /(^|\/)settings\.gradle(\.kts)?$/i;
/** Beta.25: a Gradle version catalog, `gradle/libs.versions.toml` (or another in `gradle/`). */
const VERSION_CATALOG = /(^|\/)gradle\/([\w-]+)\.versions\.toml$/i;
const slash = (p: string) => p.replace(/\\/g, "/");

export const isPomFile = (p: string) => POM.test(slash(p)) && !GENERATED_POM.test(slash(p));
export const isGradleBuildFile = (p: string) => GRADLE_BUILD.test(slash(p));
export const isGradleSettingsFile = (p: string) => GRADLE_SETTINGS.test(slash(p));
export const isVersionCatalogFile = (p: string) => VERSION_CATALOG.test(slash(p));
export const isGradleFile = (p: string) =>
  isGradleBuildFile(p) || isGradleSettingsFile(p) || isVersionCatalogFile(p);
export const isBuildFile = (p: string) => isPomFile(p) || isGradleFile(p);

/**
 * Review of beta.25: a pom by its name (`isPomFile`), or a parent pom another pom of the files
 * names by its `<relativePath>` (`parent/parent.xml`), as `pomFilesNamed` lists them.
 */
export const isPomFileIn = (p: string, named: ReadonlySet<string> | undefined) =>
  isPomFile(p) || (!!named?.has(slash(p)) && !GENERATED_POM.test(slash(p)));
/** A build file (`isBuildFile`), or a parent pom a `<relativePath>` names (`isPomFileIn`). */
export const isBuildFileIn = (p: string, named: ReadonlySet<string> | undefined) =>
  isBuildFile(p) || isPomFileIn(p, named);

/** A coordinate as the facts schema takes it: resolved, no URL, no interpolation. */
const COORDINATE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

interface Frame {
  name: string;
  /** The leaves written inside it (an element with text and no element in it). */
  leaves: Map<string, At>;
  children: boolean;
  text: string;
  textLine: number;
}

type XmlToken =
  | { type: "open" | "close" | "self"; name: string; line: number }
  | { type: "text"; value: string; line: number };

/** The 1-based line of each offset of `text`, from the offsets lines start at. */
function lineIndex(text: string): (offset: number) => number {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/**
 * A pom's text as tokens, each with the line it starts on (a text's: its first non-blank
 * character's). Comments, processing instructions and declarations are left out wherever they
 * break; a CDATA section is text (its content, the markup stripped); a tag's attributes may span
 * lines and hold a quoted `>`.
 */
function xmlTokens(text: string): XmlToken[] {
  const lineAt = lineIndex(text);
  const out: XmlToken[] = [];
  const pushText = (from: number, to: number, value = text.slice(from, to)) => {
    const lead = value.length - value.trimStart().length;
    if (value.trim()) out.push({ type: "text", value: value.trim(), line: lineAt(from + lead) });
  };
  let i = 0;
  let textFrom = 0;
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt < 0) break;
    if (text.startsWith("<!--", lt)) {
      pushText(textFrom, lt);
      const end = text.indexOf("-->", lt + 4);
      i = textFrom = end < 0 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith("<![CDATA[", lt)) {
      pushText(textFrom, lt);
      const end = text.indexOf("]]>", lt + 9);
      const stop = end < 0 ? text.length : end;
      pushText(lt + 9, stop);
      i = textFrom = end < 0 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith("<?", lt) || text.startsWith("<!", lt)) {
      pushText(textFrom, lt);
      const end = text.indexOf(text.startsWith("<?", lt) ? "?>" : ">", lt + 2);
      i = textFrom = end < 0 ? text.length : end + (text.startsWith("<?", lt) ? 2 : 1);
      continue;
    }
    const m = /^<(\/?)([A-Za-z_][\w.:-]*)/.exec(text.slice(lt, lt + 200));
    if (!m) {
      i = lt + 1;
      continue;
    }
    // The tag's end: the first `>` outside a quoted attribute value.
    let j = lt + m[0].length;
    let quote = "";
    for (; j < text.length; j++) {
      const c = text[j]!;
      if (quote) {
        if (c === quote) quote = "";
      } else if (c === '"' || c === "'") quote = c;
      else if (c === ">") break;
    }
    pushText(textFrom, lt);
    const close = m[1] === "/";
    const self = !close && text[j - 1] === "/";
    out.push({ type: close ? "close" : self ? "self" : "open", name: m[2]!, line: lineAt(lt) });
    i = textFrom = j + 1;
  }
  pushText(textFrom, text.length);
  return out;
}

const leaf = (frame: Frame, name: string) => frame.leaves.get(name);

/**
 * A pom's coordinates, dependencies, modules and properties, read from its lines as one text:
 * comments left out, CDATA read as its text, a tag split over lines read whole.
 */
export function pomCoordinates(lines: readonly string[]): PomCoordinates {
  const held = POMS.get(lines);
  if (held) return held;
  const out = readPom(lines);
  POMS.set(lines, out);
  return out;
}

/** Review of beta.25: a pom's reading, held per lines array (every fact citing it reads it once). */
const POMS = new WeakMap<readonly string[], PomCoordinates>();

function readPom(lines: readonly string[]): PomCoordinates {
  const out: PomCoordinates = { dependencies: [], modules: [], properties: new Map() };
  const text = lines
    .map((l, i) => {
      const t = l.endsWith("\r") ? l.slice(0, -1) : l;
      return i === 0 && t.charCodeAt(0) === 0xfeff ? t.slice(1) : t;
    })
    .join("\n");
  const stack: Frame[] = [];
  const names = () => stack.map((f) => f.name);
  for (const t of xmlTokens(text)) {
    const top = stack[stack.length - 1];
    if (t.type === "text") {
      if (top && !top.text) {
        top.text = t.value;
        top.textLine = t.line;
      }
      continue;
    }
    if (t.type !== "close") {
      if (top) top.children = true;
      if (t.type === "self") {
        // `<relativePath/>`: the parent is looked up in a repository, not in the folders
        if (t.name === "relativePath" && top?.name === "parent")
          top.leaves.set("relativePath", { value: "", line: t.line });
        continue;
      }
      stack.push({ name: t.name, leaves: new Map(), children: false, text: "", textLine: t.line });
      continue;
    }
    // a close tag: pop to the element it closes (a stray close is ignored)
    const at = names().lastIndexOf(t.name);
    if (at < 0) continue;
    while (stack.length > at + 1) stack.pop();
    const done = stack.pop()!;
    const parent = stack[stack.length - 1];
    const value =
      !done.children && done.text ? { value: done.text, line: done.textLine } : undefined;
    if (value && parent) parent.leaves.set(done.name, value);
    const path = [...names(), done.name];
    if (done.name === "dependency") {
      const g = leaf(done, "groupId");
      const a = leaf(done, "artifactId");
      const v = leaf(done, "version");
      const s = leaf(done, "scope");
      out.dependencies.push({
        ...(g ? { group: g } : {}),
        ...(a ? { artifact: a } : {}),
        ...(v ? { version: v } : {}),
        ...(s ? { scope: s } : {}),
        managed: path.includes("dependencyManagement"),
        plugin: path.includes("plugin") || path.includes("extension"),
      });
    } else if (done.name === "module" && value && path[0] === "project") {
      const p = path.join("/");
      if (p === "project/modules/module" || p === "project/profiles/profile/modules/module")
        out.modules.push(value);
    } else if (done.name === "properties" && path.length === 2 && path[0] === "project") {
      for (const [k, v] of done.leaves) out.properties.set(k, v);
    } else if (done.name === "parent" && path.length === 2 && path[0] === "project") {
      if (leaf(done, "groupId")) out.parentGroup = leaf(done, "groupId")!;
      if (leaf(done, "artifactId")) out.parentArtifact = leaf(done, "artifactId")!;
      if (leaf(done, "version")) out.parentVersion = leaf(done, "version")!;
      if (leaf(done, "relativePath")) out.parentRelativePath = leaf(done, "relativePath")!;
    } else if (done.name === "project" && path.length === 1) {
      if (leaf(done, "groupId")) out.group = leaf(done, "groupId")!;
      if (leaf(done, "artifactId")) out.artifact = leaf(done, "artifactId")!;
      if (leaf(done, "version")) out.version = leaf(done, "version")!;
    }
  }
  return out;
}

const PROPERTY = /^\$\{([^}]+)\}$/;

/** A pom read, and its path in the repo. */
export interface PomIn {
  file: string;
  pom: PomCoordinates;
}

/** A line of a build file: where a value a fact rests on is written. */
export interface LineAt {
  file: string;
  line: number;
}

/**
 * A pom value with a `${property}` resolved (ADR 0192: coordinates are written resolved, and the
 * line that writes the value is cited): the project's own coordinates (`project.groupId`), its
 * parent's (`project.parent.groupId`), or a `<properties>` entry of the pom or (review of
 * beta.25) of a parent pom (`parents`, nearest first), a property of a property followed a few
 * steps. `via` is the `<properties>` lines it resolves through (in `file`, the pom's own path, or
 * a parent's), which a fact must cite in `cite.with`; the project's and its `<parent>`'s own
 * coordinates are elements the verifier reads itself, so their lines needn't be (a careful reader
 * of `<groupId>${project.groupId}</groupId>` cites that line). `missing` names a property neither
 * the pom nor a parent of it sets.
 */
export function resolvePomValue(
  at: At,
  pom: PomCoordinates,
  o: { file?: string; parents?: readonly PomIn[] } = {},
  depth = 0,
): { value: string; line: number; via?: LineAt[] } | { missing: string } {
  const m = PROPERTY.exec(at.value.trim());
  if (!m) return { value: at.value, line: at.line };
  const key = m[1]!.trim();
  const own: Record<string, At | undefined> = {
    "project.groupId": pom.group ?? pom.parentGroup,
    "pom.groupId": pom.group ?? pom.parentGroup,
    groupId: pom.group ?? pom.parentGroup,
    "project.artifactId": pom.artifact,
    "pom.artifactId": pom.artifact,
    artifactId: pom.artifact,
    "project.version": pom.version ?? pom.parentVersion,
    "pom.version": pom.version ?? pom.parentVersion,
    "project.parent.groupId": pom.parentGroup,
    "parent.groupId": pom.parentGroup,
    "project.parent.artifactId": pom.parentArtifact,
    "parent.artifactId": pom.parentArtifact,
    "project.parent.version": pom.parentVersion,
    "parent.version": pom.parentVersion,
  };
  const builtin = Object.hasOwn(own, key);
  let to: { at: At; file: string } | undefined;
  if (builtin) {
    const b = own[key];
    if (b) to = { at: b, file: o.file ?? "" };
  } else {
    const mine = pom.properties.get(key);
    if (mine) to = { at: mine, file: o.file ?? "" };
    else
      for (const p of o.parents ?? []) {
        const theirs = p.pom.properties.get(key);
        if (theirs) {
          to = { at: theirs, file: p.file };
          break;
        }
      }
  }
  // One that resolves to itself, or past a few steps, is left unresolved.
  if (!to || to.at === at || depth > 4) return { missing: key };
  const next = resolvePomValue(to.at, pom, o, depth + 1);
  if ("missing" in next) return next;
  const via = [...(builtin ? [] : [{ file: to.file, line: to.at.line }]), ...(next.via ?? [])];
  return { value: next.value, line: at.line, ...(via.length ? { via } : {}) };
}

/** A `<relativePath>` or `<module>`'s target pom from the folder of the pom that writes it. */
function pomTarget(dir: string, rel: string): string {
  const to = joinDir(dir, rel.trim());
  if (/\.(xml|pom)$/i.test(rel.trim())) return to;
  return to ? `${to}/pom.xml` : "pom.xml";
}

/**
 * Review of beta.25: the files of `files` that a pom's `<relativePath>` names as its parent and
 * that no name says is a pom (`parent/parent.xml`), a parent's parent too. Held per files array.
 */
export function pomFilesNamed(files: readonly string[], linesOf: LinesOf): Set<string> {
  const held = NAMED.get(files);
  if (held) return held;
  const all = new Set(files.map(slash));
  const out = new Set<string>();
  let next = files.map(slash).filter(isPomFile);
  for (let round = 0; round < 5 && next.length; round++) {
    const found: string[] = [];
    for (const f of next) {
      const lines = linesOf(f);
      const rel = lines ? pomCoordinates(lines).parentRelativePath?.value.trim() : undefined;
      if (!rel) continue;
      const to = pomTarget(dirOf(f), rel);
      if (all.has(to) && !isPomFile(to) && !out.has(to) && !GENERATED_POM.test(to)) {
        out.add(to);
        found.push(to);
      }
    }
    next = found;
  }
  NAMED.set(files, out);
  return out;
}
const NAMED = new WeakMap<readonly string[], Set<string>>();

/** For each folder a pom's `<modules>` lists (`../cards-api` too), the pom that lists it. */
function moduleParentsOf(files: readonly string[], linesOf: LinesOf): Map<string, string> {
  const held = LISTED.get(files);
  if (held) return held;
  const named = pomFilesNamed(files, linesOf);
  const out = new Map<string, string>();
  for (const f of files.map(slash).sort()) {
    if (!isPomFileIn(f, named)) continue;
    const lines = linesOf(f);
    if (!lines) continue;
    for (const m of pomCoordinates(lines).modules) {
      const dir = dirOf(pomTarget(dirOf(f), m.value));
      if (!out.has(dir)) out.set(dir, f);
    }
  }
  LISTED.set(files, out);
  return out;
}
const LISTED = new WeakMap<readonly string[], Map<string, string>>();

/**
 * Review of beta.25: a pom's parent poms in the repo, nearest first: the file its `<parent>`'s
 * `<relativePath>` names, else a pom whose `<modules>` lists its folder (`../cards-api` from a
 * sibling `parent/` folder too), else `../pom.xml`; each only when its own `<artifactId>` is the
 * one the `<parent>` names (a Spring Boot starter parent is no file of the repo).
 * `<relativePath/>` says the parent is in a repository: none.
 */
export function pomParents(file: string, linesOf: LinesOf, files?: readonly string[]): PomIn[] {
  const out: PomIn[] = [];
  const seen = new Set([slash(file)]);
  let at = slash(file);
  let lines = linesOf(at);
  for (let n = 0; n < 6 && lines; n++) {
    const pom = pomCoordinates(lines);
    if (!pom.parentArtifact) break;
    const rel = pom.parentRelativePath?.value.trim();
    if (rel === "") break;
    const dir = dirOf(at);
    const candidates = rel
      ? [pomTarget(dir, rel)]
      : [
          ...(files ? [moduleParentsOf(files, linesOf).get(dir)] : []),
          ...(dir ? [pomTarget(dir, "..")] : []),
        ];
    const want = pom.parentArtifact.value.trim();
    let found: PomIn | undefined;
    for (const c of candidates) {
      if (!c || seen.has(c)) continue;
      const ls = linesOf(c);
      if (!ls) continue;
      const theirs = pomCoordinates(ls);
      const name = theirs.artifact?.value.trim();
      if (name !== undefined && !PROPERTY.test(name) && !PROPERTY.test(want) && name !== want)
        continue;
      found = { file: c, pom: theirs };
      break;
    }
    if (!found) break;
    out.push(found);
    seen.add(found.file);
    at = found.file;
    lines = linesOf(at);
  }
  return out;
}

// ------------------------------------------------------------------------------------- Gradle

/** A Gradle dependency declaration on one line. */
export interface GradleDependency {
  configuration: string;
  group: string;
  name: string;
  version?: string;
  /** What the configuration means, as a pom's `<scope>` would say it. */
  scope: "compile" | "runtime" | "provided" | "test" | "import";
}

/**
 * A line's configuration: `implementation`, or (review of beta.25) a Kotlin script's string one,
 * `"implementation"(...)`, which a configuration a plugin adds without an accessor is written as.
 * Groups: the quoted name (2), else the bare one (3).
 */
const CONFIGURATION = `(?:(["'])([A-Za-z]\\w*)\\1\\s*(?=\\()|([A-Za-z]\\w*))`;
/** `implementation 'g:a:v'`, `api("g:a:v")`, `testImplementation(platform("g:a:v"))`. */
const GRADLE_DEP = new RegExp(
  `^\\s*${CONFIGURATION}\\s*\\(?\\s*(?:(platform|enforcedPlatform)\\s*\\(\\s*)?(['"])([^'"\\s]+)\\5`,
);
/** `implementation group: 'g', name: 'a', version: 'v'`. */
const GRADLE_MAP_DEP = new RegExp(
  `^\\s*${CONFIGURATION}\\s*\\(?\\s*group\\s*[:=]\\s*(['"])([^'"]+)\\4\\s*,\\s*name\\s*[:=]\\s*(['"])([^'"]+)\\6(?:\\s*,\\s*version\\s*[:=]\\s*(['"])([^'"]+)\\8)?`,
);
/** Words a line can start with that take a quoted string and are no configuration. */
const NOT_A_CONFIGURATION = new Set([
  "id",
  "apply",
  "plugin",
  "include",
  "includeBuild",
  "classpath",
  "group",
  "version",
  "url",
  "uri",
  "dependency",
  "dependencySet",
  "entry",
  "mavenBom",
  "imports",
  "force",
  "exclude",
  "module",
  "substitute",
  "because",
  "strictly",
  "require",
  "prefer",
  "reject",
  "alias",
  "from",
  "maven",
  "mainClass",
  "println",
  "description",
]);

/**
 * Beta.25: configurations a build tool's plugin adds for its own class path (a linter, a coverage
 * agent, a compiler plugin): what they name runs the tool, never ships in the component.
 */
const TOOL_CONFIGURATIONS: ReadonlySet<string> = new Set([
  "checkstyle",
  "pmd",
  "spotbugs",
  "spotbugsPlugins",
  "spotbugsSlf4j",
  "jacocoAgent",
  "jacocoAnt",
  "detekt",
  "detektPlugins",
  "ktlint",
  "ktlintRuleset",
  "codenarc",
  "errorprone",
  "pitest",
]);

/** A tool's configuration a Gradle line starts with (`checkstyle "g:a:v"`), else undefined. */
export function gradleToolConfigurationOn(line: string): string | undefined {
  const c = /^\s*(["']?)([A-Za-z]\w*)\1\s*[\s(]/.exec(line)?.[2];
  return c && TOOL_CONFIGURATIONS.has(c) ? c : undefined;
}

/**
 * Configurations of tests: `testImplementation`, a test suite's or source set's
 * (`integrationTestImplementation`, `functionalTestRuntimeOnly`), `testFixturesApi`...
 */
const TEST_CONFIGURATION =
  /^(test|testFixtures|\w+Test)(Implementation|Api|CompileOnly|RuntimeOnly|Compile|Runtime|AnnotationProcessor|CompileClasspath|RuntimeClasspath)$/;

function scopeOfConfiguration(c: string, platform: boolean): GradleDependency["scope"] {
  if (platform) return "import";
  if (TEST_CONFIGURATION.test(c)) return "test";
  if (
    /^(compileOnly|annotationProcessor|kapt|ksp|compileOnlyApi|providedCompile|providedRuntime)$/.test(
      c,
    )
  )
    return "provided";
  // Spring Boot's developmentOnly (devtools) is on bootRun's class path only, as an Initializr
  // pom's `<scope>runtime</scope><optional>true</optional>` is: never compiled against.
  if (/^(runtimeOnly|runtime|developmentOnly|testAndDevelopmentOnly)$/.test(c)) return "runtime";
  return "compile";
}

/**
 * The dependency a Gradle build line declares, or undefined when it declares none: the line
 * alone, its block aside (`gradleDependencyAt` says whether the block is a project's
 * `dependencies { }`). The group and name must be coordinates as the schema takes them, so a
 * `url 'https://...'` or a `"$group:x"` declares none.
 */
export function gradleDependencyOn(line: string): GradleDependency | undefined {
  if (gradleToolConfigurationOn(line)) return undefined;
  const map = GRADLE_MAP_DEP.exec(line);
  const mapConf = map ? (map[2] ?? map[3]!) : "";
  if (map && !NOT_A_CONFIGURATION.has(mapConf)) {
    if (!COORDINATE.test(map[5]!) || !COORDINATE.test(map[7]!)) return undefined;
    return {
      configuration: mapConf,
      group: map[5]!,
      name: map[7]!,
      ...(map[9] ? { version: map[9] } : {}),
      scope: scopeOfConfiguration(mapConf, false),
    };
  }
  const m = GRADLE_DEP.exec(line);
  const conf = m ? (m[2] ?? m[3]!) : "";
  if (!m || NOT_A_CONFIGURATION.has(conf)) return undefined;
  const parts = m[6]!.split(":");
  if (parts.length < 2 || !COORDINATE.test(parts[0]!) || !COORDINATE.test(parts[1]!))
    return undefined;
  return {
    configuration: conf,
    group: parts[0]!,
    name: parts[1]!,
    ...(parts[2] ? { version: parts[2] } : {}),
    scope: scopeOfConfiguration(conf, !!m[4]),
  };
}

/**
 * The blocks each line of a Gradle build starts in, outermost first: `dependencies`,
 * `subprojects`, `project(:x)` (a `project(':x') { }` block, its path without quotes),
 * `dependencyManagement`... Strings and comments are left out (a brace in them opens nothing);
 * a block opened by a brace on its own line is named by the line before.
 */
export function gradleBlocks(lines: readonly string[]): string[][] {
  const held = BLOCKS.get(lines);
  if (held) return held;
  const out = readBlocks(lines);
  BLOCKS.set(lines, out);
  return out;
}

/** Review of beta.25: a Gradle build's blocks, held per lines array. */
const BLOCKS = new WeakMap<readonly string[], string[][]>();

function readBlocks(lines: readonly string[]): string[][] {
  const out: string[][] = [];
  const stack: string[] = [];
  let triple = "";
  let block = false;
  let previous = "";
  for (const raw of lines) {
    out.push([...stack]);
    let code = "";
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i]!;
      if (block) {
        if (raw.startsWith("*/", i)) {
          block = false;
          i++;
        }
        continue;
      }
      if (triple) {
        if (raw.startsWith(triple, i)) {
          code += triple;
          i += 2;
          triple = "";
        }
        continue;
      }
      if (raw.startsWith("//", i)) break;
      if (raw.startsWith("/*", i)) {
        block = true;
        i++;
        continue;
      }
      if (raw.startsWith("'''", i) || raw.startsWith('"""', i)) {
        triple = raw.slice(i, i + 3);
        code += triple;
        i += 2;
        continue;
      }
      if (c === "'" || c === '"') {
        // a one-line string: kept as written (a block's name may hold one), its braces aside
        let j = i + 1;
        for (; j < raw.length && raw[j] !== c; j++) if (raw[j] === "\\") j++;
        code += raw.slice(i, j + 1).replace(/[{}]/g, " ");
        i = j;
        continue;
      }
      if (c === "{") {
        const before = code.trim() || previous;
        const m = /([A-Za-z_][\w.]*)\s*(?:\(\s*([^()]*?)\s*\))?\s*(?:\w+\s*->\s*)?$/.exec(before);
        const name = m?.[1] ?? "";
        stack.push(name === "project" && m?.[2] ? `project(${m[2].replace(/['"]/g, "")})` : name);
        code = "";
        continue;
      }
      if (c === "}") {
        stack.pop();
        code = "";
        continue;
      }
      code += c;
    }
    if (code.trim()) previous = code.trim();
  }
  return out;
}

/** Blocks a project's configuration is written in: the build's top level, or for its projects. */
const PROJECT_BLOCK = (b: string) =>
  b === "subprojects" || b === "allprojects" || /^project\(:?[^)]*\)$/.test(b);
/** The project path a `project(:x)` block names, `:x` → `x`, `:a:b` → `a:b`. */
const projectOf = (b: string) => /^project\(:?([^)]*)\)$/.exec(b)?.[1];

/**
 * The dependency line `line` (1-based) of a Gradle build declares, with the project block it is
 * in, or why it declares none: only a line directly in a project's `dependencies { }` (at the top
 * level, or in `subprojects`, `allprojects` or `project(':x')`) declares a dependency, never one
 * in `dependencyManagement`, `constraints`, `buildscript`, `resolutionStrategy` or `repositories`.
 */
export function gradleDependencyAt(
  lines: readonly string[],
  line: number,
  blocks: readonly string[][] = gradleBlocks(lines),
):
  { dependency: GradleDependency; project?: string; all?: boolean } | { none: string } | undefined {
  const d = gradleDependencyOn(lines[line - 1] ?? "");
  if (!d) return undefined;
  const at = projectDependenciesAt(blocks, line);
  return "none" in at ? at : { dependency: d, ...at };
}

/**
 * Whether line `line` (1-based) sits directly in a project's `dependencies { }`, and which
 * project's (a root build's `project(':x') { }`, or every project's under `subprojects` or
 * `allprojects`), or the blocks it is in instead.
 */
function projectDependenciesAt(
  blocks: readonly string[][],
  line: number,
): { project?: string; all?: boolean } | { none: string } {
  const stack = blocks[line - 1] ?? [];
  const outer = stack.slice(0, -1);
  if (stack[stack.length - 1] !== "dependencies" || !outer.every(PROJECT_BLOCK)) {
    const inside = stack.filter((b) => !PROJECT_BLOCK(b)).join(" { ");
    return { none: inside ? `${inside} { }` : "no dependencies { } block" };
  }
  const proj = outer.map(projectOf).find((x) => x !== undefined);
  return {
    ...(proj !== undefined ? { project: proj } : {}),
    ...(outer.some((b) => b === "subprojects" || b === "allprojects") ? { all: true } : {}),
  };
}

// ------------------------------------------------------------------------- version catalogs

/** A `[libraries]` entry of a Gradle version catalog (beta.25). */
export interface CatalogLibrary {
  /** The alias as the catalog writes it (`forge-ledger-api`). */
  alias: string;
  /** What a build names it by after the catalog's name (`forge.ledger.api`). */
  accessor: string;
  group: string;
  name: string;
  /** A version written on the entry (`version = "1.2.0"`, or the string's third part). */
  version?: string;
  /** The `[versions]` entry its `version.ref` names. */
  versionRef?: string;
}

/** A catalog's `[versions]`, each a plain string (`forge-ledger = "1.2.0"`) with its line. */
export function catalogVersions(lines: readonly string[]): Map<string, At> {
  const out = new Map<string, At>();
  let section = "";
  lines.forEach((raw, i) => {
    const l = raw.replace(/\r$/, "");
    const s = /^\s*\[\s*([^\]]+?)\s*\]\s*(#.*)?$/.exec(l);
    if (s) return void (section = s[1]!);
    if (section !== "versions") return;
    const m = /^\s*(["']?)([A-Za-z][\w.-]*)\1\s*=\s*(["'])([^"']+)\3\s*(#.*)?$/.exec(l);
    if (m) out.set(m[2]!, { value: m[4]!, line: i + 1 });
  });
  return out;
}

/** The catalog's name a build's accessor starts with: the file's (`libs.versions.toml` → `libs`). */
export const catalogNameOf = (file: string): string | undefined =>
  VERSION_CATALOG.exec(slash(file))?.[2];

/** Gradle's accessor of an alias: `-`, `_` and `.` all separate its parts. */
const accessorOf = (alias: string) => alias.replace(/[-_.]+/g, ".");

/**
 * The library a version catalog's line `line` (1-based) declares in `[libraries]`, or undefined:
 * `alias = "g:a:v"`, `alias = { module = "g:a", version.ref = "x" }` or
 * `alias = { group = "g", name = "a", version = "v" }`.
 */
export function catalogLibraryAt(
  lines: readonly string[],
  line: number,
): CatalogLibrary | undefined {
  let section = "";
  for (let i = 0; i < line && i < lines.length; i++) {
    const m = /^\s*\[\s*([^\]]+?)\s*\]\s*(#.*)?$/.exec((lines[i] ?? "").replace(/\r$/, ""));
    if (m) section = m[1]!;
  }
  if (section !== "libraries") return undefined;
  const text = (lines[line - 1] ?? "").replace(/\r$/, "");
  const m = /^\s*(["']?)([A-Za-z][\w.-]*)\1\s*=\s*(.+)$/.exec(text);
  if (!m) return undefined;
  const alias = m[2]!;
  const body = m[3]!.replace(/\s+#.*$/, "").trim();
  const str = (key: string) =>
    new RegExp(`(?:^|[{,\\s])${key.replace(".", "\\.")}\\s*=\\s*(["'])([^"']+)\\1`).exec(body)?.[2];
  let group: string | undefined;
  let name: string | undefined;
  let version: string | undefined;
  const whole = /^(["'])([^"']+)\1$/.exec(body);
  if (whole) [group, name, version] = whole[2]!.split(":");
  else if (body.startsWith("{")) {
    const module = str("module");
    if (module) [group, name] = module.split(":");
    else {
      group = str("group");
      name = str("name");
    }
    version = str("version");
  }
  const versionRef = body.startsWith("{") ? str("version.ref") : undefined;
  if (!group || !name || !COORDINATE.test(group) || !COORDINATE.test(name)) return undefined;
  return {
    alias,
    accessor: accessorOf(alias),
    group,
    name,
    ...(version ? { version } : {}),
    ...(versionRef ? { versionRef } : {}),
  };
}

/** A Gradle line declaring a dependency by a catalog's alias: `implementation(libs.forge.ledger.api)`. */
export interface GradleCatalogUse {
  configuration: string;
  /** The catalog's name (`libs`). */
  catalog: string;
  /** The accessor after it (`forge.ledger.api`). */
  accessor: string;
  scope: GradleDependency["scope"];
}

/** The catalog alias a Gradle build line declares a dependency by, or undefined. */
export function gradleCatalogUseOn(line: string): GradleCatalogUse | undefined {
  const m = new RegExp(
    `^\\s*${CONFIGURATION}\\s*\\(?\\s*(?:(platform|enforcedPlatform)\\s*\\(\\s*)?([A-Za-z]\\w*)\\.([A-Za-z][\\w.]*?)\\s*\\)?\\s*\\)?\\s*(?:\\{.*)?(?:\\/\\/.*)?\\r?$`,
  ).exec(line);
  const conf = m ? (m[2] ?? m[3]!) : "";
  if (!m || NOT_A_CONFIGURATION.has(conf) || TOOL_CONFIGURATIONS.has(conf)) return undefined;
  // a bundle is several libraries, a plugin or a version no dependency
  if (/^(bundles|plugins|versions)\./.test(m[6]!) || m[5] === "project") return undefined;
  return {
    configuration: conf,
    catalog: m[5]!,
    accessor: m[6]!,
    scope: scopeOfConfiguration(conf, !!m[4]),
  };
}

/** `group = 'g'` in a Gradle build, or `group "g"`, or `allprojects { group = 'g' }` on one line. */
export function gradleGroupOn(line: string): string | undefined {
  return /^\s*(?:(?:allprojects|subprojects)\s*\{\s*)?(?:project\.)?group\s*=?\s*(['"])([^'"]+)\1\s*\}?\s*$/.exec(
    line,
  )?.[2];
}

/** The project name a Gradle line sets: `rootProject.name`, `archivesBaseName`, `archivesName`. */
export function gradleNameOn(line: string): string | undefined {
  return /^\s*(?:rootProject\.name|archivesBaseName|(?:base\.)?archivesName(?:\.set)?)\s*[=(]?\s*(['"])([^'"]+)\1\s*\)?\s*$/.exec(
    line,
  )?.[2];
}

/** A subproject a settings.gradle line names: its path (`a:b`) and the name it publishes under. */
export interface GradleProject {
  path: string;
  name: string;
  /** `project(':x').name = 'y'`: the line renames it. */
  renamed?: boolean;
}

/** The subprojects a settings.gradle line includes (`include 'a', ':b:c'`, `include(":a")`), or renames. */
export function gradleProjectsOn(line: string): GradleProject[] {
  const rename = /^\s*project\s*\(\s*(['"]):?([^'"]+)\1\s*\)\.name\s*=\s*(['"])([^'"]+)\3\s*$/.exec(
    line,
  );
  if (rename) return [{ path: rename[2]!, name: rename[4]!, renamed: true }];
  const inc = /^\s*include\s*\(?\s*((?:(['"])[^'"]+\2\s*,?\s*)+)\)?\s*$/.exec(line);
  if (!inc) return [];
  return [...inc[1]!.matchAll(/(['"]):?([^'"]+)\1/g)].map((m) => ({
    path: m[2]!,
    name: m[2]!.split(":").pop()!,
  }));
}

/** A subproject settings.gradle includes or renames, with the line that names it (1-based). */
export interface GradleProjectAt extends GradleProject {
  line: number;
}

/**
 * Review of beta.25: every subproject settings.gradle(.kts) includes, an `include` over several
 * lines too (Kotlin's `include(\n ":a",\n ":b"\n)`, Groovy's `include 'a',\n 'b'`), each with
 * the line its name is on, and every `project(':x').name = 'y'` rename. Held per lines array.
 */
export function gradleProjects(lines: readonly string[]): GradleProjectAt[] {
  const held = PROJECTS.get(lines);
  if (held) return held;
  const out: GradleProjectAt[] = [];
  let open: "" | "paren" | "comma" = "";
  const names = (text: string, line: number) => {
    for (const m of text.matchAll(/(['"]):?([^'"]+)\1/g))
      out.push({ path: m[2]!, name: m[2]!.split(":").pop()!, line });
  };
  lines.forEach((raw, i) => {
    const code = raw.replace(/\r$/, "").replace(/\s\/\/.*$|^\s*\/\/.*$/, "");
    if (open) {
      names(code, i + 1);
      if (open === "paren" ? code.includes(")") : !/,\s*$/.test(code)) open = "";
      return;
    }
    const rename = gradleProjectsOn(code);
    if (rename.length && rename[0]!.renamed) return void out.push({ ...rename[0]!, line: i + 1 });
    const inc = /^\s*include(?!\w)\s*(\(?)\s*(.*)$/.exec(code);
    if (!inc) return;
    names(inc[2]!, i + 1);
    if (inc[1] === "(" && !inc[2]!.includes(")")) open = "paren";
    else if (inc[1] !== "(" && /,\s*$/.test(inc[2]!)) open = "comma";
  });
  PROJECTS.set(lines, out);
  return out;
}
const PROJECTS = new WeakMap<readonly string[], GradleProjectAt[]>();

/** A subproject's folder (`a:b` → `a/b`), or the one settings.gradle sets for it. */
function projectDirs(settings: readonly string[] | undefined): Map<string, string> {
  const dirs = new Map<string, string>();
  for (const l of settings ?? []) {
    const m =
      /^\s*project\s*\(\s*(['"]):?([^'"]+)\1\s*\)\.projectDir\s*=\s*(?:file\s*\(|new\s+File\s*\(\s*(?:settingsDir|rootDir)\s*,)\s*(['"])([^'"]+)\3\s*\)\s*$/.exec(
        l,
      );
    if (m) dirs.set(m[2]!, normDir(m[4]!));
  }
  return dirs;
}

// ------------------------------------------------------------------------------------- modules

type Coordinates = FactOf<"artifact"> | FactOf<"dependency">;
type LinesOf = (path: string) => readonly string[] | undefined;

const normDir = (p: string) =>
  slash(p)
    .replace(/^\.\//, "")
    .replace(/\/(pom\.xml|build\.gradle(\.kts)?)$/i, "")
    .replace(/\/+$/, "");
const dirOf = (file: string) => {
  const f = slash(file);
  return f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "";
};
const joinDir = (base: string, rel: string) => {
  const parts = base ? base.split("/") : [];
  for (const s of normDir(rel).split("/")) {
    if (!s || s === ".") continue;
    if (s === "..") parts.pop();
    else parts.push(s);
  }
  return parts.join("/");
};
const settingsOf = (linesOf: LinesOf) => {
  for (const f of ["settings.gradle", "settings.gradle.kts"]) {
    const l = linesOf(f);
    if (l) return { file: f, lines: l };
  }
  return undefined;
};

/** The module of the repo a build file is the build of (ADR 0192 addendum). */
export interface BuildModule {
  /** Its folder in the repo (`""` for the repo's own component). */
  path: string;
  /**
   * The component its facts belong to: the manifest module's, else the repo's own. Left out on a
   * root Gradle build's `subprojects { }` line that is several components' dependency (`every`).
   */
  component?: string;
  /** The names a fact may give it: the component's, or each component `every` line is of. */
  names: string[];
  /**
   * Where it was read: a module repos.manifest.yaml lists, or (review of beta.25) the repo's own
   * component, which every build file is of when the manifest lists no module of the repo.
   */
  from: "manifest" | "repo";
  /** Review of beta.25: a root build's `subprojects { }` line, each of `names`' dependency. */
  every?: true;
}

/**
 * The build line a coordinates fact rests on for its module: its own, or for a dependency cited on
 * a version catalog's entry (beta.25), the first Gradle build line in `cite.with` (the alias's).
 */
function buildLineOf(f: Coordinates): { file: string; line: number } | undefined {
  if (!isVersionCatalogFile(f.cite.file)) return f.cite;
  return (f.cite.with ?? []).find((p) => isGradleBuildFile(p.file));
}

/** A repo's settings.gradle and its subprojects' folders, read once per lines-reading function. */
interface GradleEnv {
  settings?: { file: string; lines: readonly string[] };
  dirs: Map<string, string>;
  projects: GradleProjectAt[];
}
const ENVS = new WeakMap<LinesOf, GradleEnv>();
function gradleEnvOf(linesOf: LinesOf): GradleEnv {
  const held = ENVS.get(linesOf);
  if (held) return held;
  const settings = settingsOf(linesOf);
  const env: GradleEnv = {
    ...(settings ? { settings } : {}),
    dirs: projectDirs(settings?.lines),
    projects: settings ? gradleProjects(settings.lines) : [],
  };
  ENVS.set(linesOf, env);
  return env;
}
const projectDirOf = (env: GradleEnv, project: string) =>
  env.dirs.get(project) ?? project.replace(/:/g, "/");

/** A Gradle subproject's path from the line it's cited on, in settings.gradle or a root build. */
function gradleProjectOf(
  f: Coordinates,
  at: { file: string; line: number },
  linesOf: LinesOf,
): string | undefined {
  const lines = linesOf(at.file);
  if (!lines) return undefined;
  if (isGradleSettingsFile(at.file)) {
    const ps = gradleProjects(lines).filter((p) => p.line === at.line);
    return ps.find((p) => p.name === f.name)?.path ?? (ps.length === 1 ? ps[0]!.path : undefined);
  }
  if (f.kind === "dependency" && isGradleBuildFile(at.file)) {
    const d = projectDependenciesAt(gradleBlocks(lines), at.line);
    return "project" in d ? d.project : undefined;
  }
  return undefined;
}

/**
 * The module a coordinates fact's build file is the build of (review of beta.25): the module of
 * repos.manifest.yaml whose folder holds the file (or, for a Gradle subproject named in
 * settings.gradle or a root build's `project(':x') { }`, the subproject's folder), else the repo's
 * own component (`repoComponent`, the manifest's). A repo whose manifest entry lists no modules
 * ships as that one component, every build file in it its own: a component is never made from a
 * folder's name, so a multi-module build that ships as one service is drawn as that service. A
 * root Gradle build's `subprojects { dependencies { } }` (or `allprojects`) line is each
 * project's: one component when they are all of one, else `every` with each of their names.
 * Undefined when neither the manifest's modules nor the repo's component is known.
 */
export function buildModuleOf(
  f: Coordinates,
  linesOf: LinesOf,
  modules: readonly { path: string; component: string }[] = [],
  repoComponent?: string,
): BuildModule | undefined {
  const listed = modules
    .map((m) => ({ path: normDir(m.path), component: m.component }))
    .filter((m) => m.path)
    .sort((a, b) => b.path.length - a.path.length);
  const repo = (): BuildModule | undefined =>
    repoComponent
      ? { path: "", component: repoComponent, names: [repoComponent], from: "repo" }
      : undefined;
  const of = (dir: string): BuildModule | undefined => {
    const m = listed.find((x) => dir === x.path || dir.startsWith(`${x.path}/`));
    return m
      ? { path: m.path, component: m.component, names: [m.component], from: "manifest" }
      : repo();
  };
  const at = buildLineOf(f);
  if (!at) return repo();
  if (!listed.length) return repo();
  const env = gradleEnvOf(linesOf);
  // A root build's subprojects { } or allprojects { } dependency: every project's it is in.
  if (f.kind === "dependency" && isGradleBuildFile(at.file) && dirOf(at.file) === "") {
    const lines = linesOf(at.file);
    const stack = lines ? (gradleBlocks(lines)[at.line - 1] ?? []) : [];
    const sub = stack.includes("subprojects");
    const all = stack.includes("allprojects");
    if ((sub || all) && !stack.some((b) => projectOf(b) !== undefined)) {
      const dirs = env.projects.length
        ? env.projects.filter((p) => !p.renamed).map((p) => projectDirOf(env, p.path))
        : listed.map((m) => m.path);
      const mods = [...(all ? [""] : []), ...dirs].flatMap((d) => {
        const m = of(d);
        return m ? [m] : [];
      });
      const names = [...new Set(mods.map((m) => m.component!))].sort();
      if (names.length === 1) return mods.find((m) => m.component === names[0])!;
      if (names.length > 1) return { path: "", names, from: "manifest", every: true };
      return repo();
    }
  }
  const project = gradleProjectOf(f, at, linesOf);
  return of(project !== undefined ? projectDirOf(env, project) : dirOf(at.file));
}

/**
 * Why a coordinates fact's `component` isn't the module whose build file it cites, or undefined
 * when it is, or when the file is no module's (ADR 0192 addendum). A fact that names none is
 * given the manifest module's (`buildModuleOf(...).component`) by the verifier, or is the repo's.
 */
export function buildModuleProblem(
  f: Coordinates,
  mod: BuildModule | undefined,
): string | undefined {
  if (!mod) return undefined;
  if (mod.every) {
    const names = mod.names.join(", ");
    if (f.component === undefined)
      return `${f.kind} ${f.id} cites ${f.cite.file}:${f.cite.line}, a dependency every subproject's build takes (components ${names}): write one dependency fact for each, each naming its component`;
    const c = factIdPart(f.component);
    if (mod.names.some((n) => factIdPart(n) === c)) return undefined;
    return `${f.kind} ${f.id} names component "${f.component}", and ${f.cite.file}:${f.cite.line} is a dependency of every subproject (components ${names}): name one of them`;
  }
  if (f.component === undefined) return undefined;
  const c = factIdPart(f.component);
  if (mod.names.some((n) => factIdPart(n) === c)) return undefined;
  if (mod.from === "repo")
    return `${f.kind} ${f.id} names component "${f.component}", and ${f.cite.file} is a build file of ${mod.component} (repos.manifest.yaml lists no module of the repo there, so it ships as ${mod.component}): a module is a component only when the manifest lists it; name ${mod.component}, or leave component out`;
  return `${f.kind} ${f.id} names component "${f.component}", and ${f.cite.file} is the build file of module ${mod.component} (${mod.path}/, repos.manifest.yaml's modules): a dependency belongs to the module whose build file declares it; name ${mod.component}, or leave component out`;
}

// ------------------------------------------------------------------------------------- checks

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
export function buildCoordinatesProblem(
  f: Coordinates,
  linesOf: LinesOf,
  /**
   * Review of beta.25: the repo's files, so a parent pom is found through a `<modules>` list
   * (`../cards-api`) and a pom a `<relativePath>` names (`parent/parent.xml`) is read as one.
   */
  files?: readonly string[],
): string | undefined {
  const file = f.cite.file;
  const label = `${f.kind} ${f.id}`;
  const lines = linesOf(file);
  if (!lines) return undefined; // the line check says the file is missing
  const where = `${file}:${f.cite.line}`;
  const named = files ? pomFilesNamed(files, linesOf) : undefined;
  if (isPomFileIn(file, named))
    return pomProblem(f, label, where, {
      file,
      pom: pomCoordinates(lines),
      parents: pomParents(file, linesOf, files),
    });
  if (isGradleFile(file)) return gradleProblem(f, label, where, lines, linesOf);
  return `${label} cites ${file}, which is no build file Atticus reads coordinates from: cite the pom.xml, build.gradle or settings.gradle line that writes them`;
}

/**
 * A pom value resolved, the line that writes it cited, or what is wrong: `what` says the value
 * in words (`the project's <groupId>`).
 */
/** A pom being checked: its path, its reading and its parent poms in the repo (nearest first). */
interface PomContext {
  file: string;
  pom: PomCoordinates;
  parents: readonly PomIn[];
}

function pomValue(
  f: Coordinates,
  label: string,
  file: string,
  at: At,
  ctx: PomContext,
  what: string,
): { value: string } | { problem: string } {
  const r = resolvePomValue(at, ctx.pom, { file: ctx.file, parents: ctx.parents });
  if ("missing" in r)
    return {
      problem: `${label}: ${what} at ${file}:${at.line} is \${${r.missing}}, which no <properties> entry or <parent> of ${file}${ctx.parents.length ? ` or of its parent poms (${ctx.parents.map((p) => p.file).join(", ")})` : ""} sets: Atticus can't say what it resolves to`,
    };
  const uncited = (r.via ?? []).find((l) => !citedLine(f, l.file, l.line));
  if (uncited !== undefined)
    return {
      problem: `${label}: ${what} at ${file}:${at.line} is ${at.value}, written as "${r.value}" through ${uncited.file}:${uncited.line}; cite that line in cite.with`,
    };
  return { value: r.value };
}

/** A pom's dependency whose `<artifactId>` is on a line, found by the line (held per pom). */
const DEPS = new WeakMap<PomCoordinates, Map<number, PomDependency>>();
function dependencyOnLine(pom: PomCoordinates, line: number): PomDependency | undefined {
  let byLine = DEPS.get(pom);
  if (!byLine) {
    byLine = new Map();
    for (const d of pom.dependencies)
      if (d.artifact && !byLine.has(d.artifact.line)) byLine.set(d.artifact.line, d);
    DEPS.set(pom, byLine);
  }
  return byLine.get(line);
}

/**
 * A pom's declared scope as the facts schema takes it: Maven's `system` (a jar from a path on the
 * machine, compiled against and never packaged) is recorded as `provided`, which is how it is
 * drawn (review of beta.25: the facts schema stays at version 5).
 */
export const pomScopeOf = (declared: string | undefined): string =>
  declared === undefined ? "compile" : declared.trim() === "system" ? "provided" : declared.trim();

function pomProblem(
  f: Coordinates,
  label: string,
  where: string,
  ctx: PomContext,
): string | undefined {
  const pom = ctx.pom;
  const line = f.cite.line;
  const file = f.cite.file;
  if (f.kind === "artifact") {
    if (pom.artifact?.line !== line) {
      const dep = dependencyOnLine(pom, line);
      const what = dep
        ? `a dependency's <artifactId> (${dep.artifact!.value})`
        : pom.parentArtifact?.line === line
          ? `the <parent>'s <artifactId> (${pom.parentArtifact.value})`
          : "not the project's own <artifactId>";
      return `${label} says ${where} is the coordinates the build publishes, and that line is ${what}${pom.artifact ? `: the project's own is at line ${pom.artifact.line}` : ""}`;
    }
    const name = pomValue(f, label, file, pom.artifact, ctx, "the project's <artifactId>");
    if ("problem" in name) return name.problem;
    if (name.value !== f.name)
      return `${label} names "${f.name}", and ${where} writes the project's artifactId as "${name.value}"`;
    const at = pom.group ?? pom.parentGroup;
    if (!at)
      return `${label} names group "${f.group}", and ${file} writes no groupId of the project or its <parent>`;
    const inherited = pom.group ? "" : " (the <parent>'s, which the project inherits)";
    const group = pomValue(f, label, file, at, ctx, `the group${inherited}`);
    if ("problem" in group) return group.problem;
    if (group.value !== f.group)
      return `${label} names group "${f.group}", and ${file}:${at.line} writes "${group.value}"${inherited}`;
    if (!citedLine(f, file, at.line))
      return `${label}: the group is written at ${file}:${at.line}${pom.group ? "" : " (the <parent>'s)"}; cite that line in cite.with`;
    return undefined;
  }
  const dep = dependencyOnLine(pom, line);
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
  const name = pomValue(f, label, file, dep.artifact!, ctx, "the dependency's <artifactId>");
  if ("problem" in name) return name.problem;
  if (name.value !== f.name)
    return `${label} names "${f.name}", and ${where} declares "${name.value}"`;
  if (!dep.group) return `${label}: the <dependency> at ${where} writes no <groupId>`;
  const group = pomValue(f, label, file, dep.group, ctx, "the dependency's <groupId>");
  if ("problem" in group) return group.problem;
  if (group.value !== f.group)
    return `${label} names group "${f.group}", and the <dependency> at ${where} writes "${dep.group.value}"${group.value !== dep.group.value ? ` (${group.value})` : ""}`;
  if (!citedLine(f, file, dep.group.line))
    return `${label}: the dependency's group is written at ${file}:${dep.group.line}; cite that line in cite.with`;
  const declared = pomScopeOf(dep.scope?.value);
  if (declared !== (f.scope ?? "compile"))
    return `${label} says scope ${f.scope ?? "compile"}, and the <dependency> at ${where} declares ${dep.scope?.value.trim() === "system" ? "system, which is recorded as provided" : declared}${dep.scope ? ` (${file}:${dep.scope.line})` : ""}`;
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
  const file = f.cite.file;
  if (f.kind === "dependency" && isVersionCatalogFile(file))
    return catalogProblem(f, label, where, lines, linesOf);
  if (f.kind === "dependency") {
    const at = isGradleBuildFile(file) ? gradleDependencyAt(lines, f.cite.line) : undefined;
    const tool = gradleToolConfigurationOn(text);
    if (!at && tool)
      return `${label} cites ${where}, the ${tool} tool's own configuration: what it names runs the tool, and is no dependency of the component`;
    if (!at)
      return `${label} says ${where} declares a dependency, and that line declares none: cite the line in dependencies { } that names it`;
    if ("none" in at)
      return `${label} cites ${where}, which is in ${at.none}, not a project's dependencies { }: a version pinned, a constraint or the build's own class path is no dependency of the component`;
    const d = at.dependency;
    if (d.group !== f.group || d.name !== f.name)
      return `${label} names "${f.group}:${f.name}", and ${where} declares "${d.group}:${d.name}"`;
    if (d.scope !== (f.scope ?? "compile"))
      return `${label} says scope ${f.scope ?? "compile"}, and ${where} declares it with ${d.configuration} (${d.scope})`;
    return undefined;
  }
  // The project the name is of: the root (rootProject.name, a root build's archivesBaseName) or
  // a subproject (settings.gradle's include or project(':x').name, its own build's archivesBaseName).
  let project: string | undefined;
  if (isGradleSettingsFile(file)) {
    const root = gradleNameOn(text);
    if (root !== undefined) {
      if (root !== f.name) return `${label} names "${f.name}", and ${where} sets "${root}"`;
    } else {
      const all = gradleProjects(lines);
      const ps = all.filter((x) => x.line === f.cite.line);
      if (!ps.length)
        return `${label} says ${where} is the coordinates the build publishes, and that line sets no project name: cite rootProject.name, an include, or a project(':x').name line`;
      const p = ps.find((x) => x.name === f.name);
      if (!p)
        return `${label} names "${f.name}", and ${where} names ${ps.map((x) => `"${x.name}"`).join(", ")}`;
      const renamed = all.find((x) => x.renamed && x.path === p.path);
      if (!p.renamed && renamed)
        return `${label} names "${f.name}", and ${file}:${renamed.line} names that project "${renamed.name}": cite that line`;
      project = p.path;
    }
  } else {
    const name = gradleNameOn(text);
    if (name === undefined)
      return `${label} says ${where} is the coordinates the build publishes, and that line sets no project name: cite rootProject.name in settings.gradle, or archivesBaseName`;
    if (name !== f.name) return `${label} names "${f.name}", and ${where} sets "${name}"`;
    const dir = dirOf(file);
    if (dir) {
      const dirs = projectDirs(settingsOf(linesOf)?.lines);
      project = [...dirs].find(([, d]) => d === dir)?.[0] ?? dir.replace(/\//g, ":");
    }
  }
  // The group: a line it cites that sets it for that project — the root build's top level or
  // allprojects { }, a subproject's own build, or the root's subprojects { } or project(':x') { }.
  const dirs = projectDirs(settingsOf(linesOf)?.lines);
  const ownDir = project === undefined ? "" : (dirs.get(project) ?? project.replace(/:/g, "/"));
  const parts = [{ file, line: f.cite.line }, ...(f.cite.with ?? [])];
  const groups = parts.flatMap((p) => {
    const ls = linesOf(p.file);
    const g = gradleGroupOn(ls?.[p.line - 1] ?? "");
    if (g === undefined || !ls || !isGradleBuildFile(p.file)) return [];
    const stack = gradleBlocks(ls)[p.line - 1] ?? [];
    const pDir = dirOf(p.file);
    const applies =
      pDir === ownDir && pDir !== ""
        ? stack.length === 0
        : pDir === "" &&
          (stack.length === 0
            ? project === undefined
            : stack.length === 1 &&
              (stack[0] === "allprojects" ||
                (project !== undefined &&
                  (stack[0] === "subprojects" || projectOf(stack[0]!) === project))));
    return [{ ...p, group: g, applies }];
  });
  const g = groups.find((x) => x.applies);
  if (!g) {
    const other = groups[0];
    if (other)
      return `${label}: ${other.file}:${other.line} sets the group of another project than ${f.name}; cite the line that sets ${f.name}'s (group = '${f.group}') in cite.with`;
    return `${label}: no line it cites sets the group; cite the build.gradle line that does (group = '${f.group}') in cite.with`;
  }
  if (g.group !== f.group)
    return `${label} names group "${f.group}", and ${g.file}:${g.line} sets "${g.group}"`;
  return undefined;
}

/**
 * Beta.25: a dependency cited on a version catalog's `[libraries]` entry: the entry must give the
 * coordinates claimed, and a line `cite.with` names must declare it by its alias directly in a
 * project's `dependencies { }` (`implementation(libs.forge.ledger.api)`), with the scope claimed.
 */
function catalogProblem(
  f: FactOf<"dependency">,
  label: string,
  where: string,
  lines: readonly string[],
  linesOf: LinesOf,
): string | undefined {
  const lib = catalogLibraryAt(lines, f.cite.line);
  if (!lib)
    return `${label} cites ${where}, which is no [libraries] entry of the version catalog: cite the entry that gives its coordinates`;
  if (lib.group !== f.group || lib.name !== f.name)
    return `${label} names "${f.group}:${f.name}", and ${where} gives ${lib.alias} as "${lib.group}:${lib.name}"`;
  // The version: the entry's own, or the [versions] entry its version.ref names (the catalog's
  // own structure, read here, as a pom's <parent> is).
  if (f.version !== undefined) {
    const v =
      lib.version ??
      (lib.versionRef ? catalogVersions(lines).get(lib.versionRef)?.value : undefined);
    if (v !== f.version)
      return `${label} says version ${f.version}, and ${where} gives ${v === undefined ? "no version Atticus can read" : `"${v}"`}${lib.versionRef ? ` (version.ref = "${lib.versionRef}")` : ""}`;
  }
  const catalog = catalogNameOf(f.cite.file)!;
  const use = `${catalog}.${lib.accessor}`;
  let problem: string | undefined;
  for (const p of f.cite.with ?? []) {
    if (!isGradleBuildFile(p.file)) continue;
    const ls = linesOf(p.file);
    const u = ls ? gradleCatalogUseOn(ls[p.line - 1] ?? "") : undefined;
    if (!ls || !u || u.catalog !== catalog || u.accessor !== lib.accessor) continue;
    const at = projectDependenciesAt(gradleBlocks(ls), p.line);
    if ("none" in at) {
      problem ??= `${label}: ${p.file}:${p.line} is in ${at.none}, not a project's dependencies { }: a version pinned, a constraint or the build's own class path is no dependency of the component`;
      continue;
    }
    if (u.scope !== (f.scope ?? "compile")) {
      problem ??= `${label} says scope ${f.scope ?? "compile"}, and ${p.file}:${p.line} declares it with ${u.configuration} (${u.scope})`;
      continue;
    }
    return undefined;
  }
  return (
    problem ??
    `${label}: ${where} is the catalog's entry, which only names the library; cite the build line in dependencies { } that declares it (${use}) in cite.with`
  );
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
 * flooded; a pom's management entries and plugins' dependencies are no dependencies, nor is a
 * Gradle line outside a project's `dependencies { }`.
 */
export function buildUnrecorded(
  files: readonly string[],
  linesOf: LinesOf,
  kept: readonly Fact[],
  /** Review of beta.25: the repo's files, for the parent poms a `<relativePath>` names. */
  all?: readonly string[],
): BuildUnrecorded[] {
  const named = all ? pomFilesNamed(all, linesOf) : undefined;
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
    if (isPomFileIn(file, named)) {
      const pom = pomCoordinates(lines);
      const parents = pomParents(file, linesOf, all);
      const said = (at: At | undefined) => {
        if (!at) return "?";
        const r = resolvePomValue(at, pom, { file, parents });
        return "value" in r ? r.value : at.value;
      };
      if (pom.artifact)
        add(
          file,
          pom.artifact.line,
          "artifact",
          `${said(pom.group ?? pom.parentGroup)}:${said(pom.artifact)}`,
        );
      for (const d of pom.dependencies)
        if (!d.managed && !d.plugin && d.artifact)
          add(file, d.artifact.line, "dependency", `${said(d.group)}:${said(d.artifact)}`);
    } else if (isGradleBuildFile(file)) {
      const blocks = gradleBlocks(lines);
      lines.forEach((_, i) => {
        const at = gradleDependencyAt(lines, i + 1, blocks);
        if (at && "dependency" in at && at.dependency.scope !== "import")
          add(file, i + 1, "dependency", `${at.dependency.group}:${at.dependency.name}`);
      });
    }
  }
  return out;
}
