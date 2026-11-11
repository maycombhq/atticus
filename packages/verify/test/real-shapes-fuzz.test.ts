import { describe, expect, it } from "vitest";
import { gradleDependencyOn, pomCoordinates, type GradleDependency } from "../src/index.js";

/**
 * Property tests for the build-coordinates reader (ADR 0192) on the shapes public builds take
 * (`fixtures/real-shapes/README.md`): a pom or a Gradle line is generated from a model, written
 * out with the quirks real files have (indentation in spaces or tabs, CRLF, a BOM, an XML
 * declaration, comments over one line or several, a leaf's text on a line of its own, spaces
 * before a tag's `>`, attributes in any order, elements in any order, a trailing comment or
 * closure), and the reader must give back the model, with each value's line. A small seeded
 * generator rather than a library (fast-check isn't a dependency of the workspace): every run
 * draws the same cases, and a failure names its seed.
 *
 * Where today's reader misses a shape, the property is `it.fails` with the bug in one line, and
 * every case it draws has the shape, so the fix flips the test.
 */

/** mulberry32: a small seeded PRNG, enough to draw cases from. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  return {
    int,
    bool: (p = 0.5) => next() < p,
    pick: <T>(xs: readonly T[]) => xs[int(xs.length)]!,
    shuffle: <T>(xs: readonly T[]) => {
      const out = [...xs];
      for (let i = out.length - 1; i > 0; i--) {
        const j = int(i + 1);
        [out[i], out[j]] = [out[j]!, out[i]!];
      }
      return out;
    },
  };
}
type Rng = ReturnType<typeof rng>;
const CASES = 150;
const SEEDS = Array.from({ length: CASES }, (_, i) => 0x5eed0000 + i);

const GROUPS = [
  "forge.ledger",
  "forge.rates",
  "com.northwind.pay",
  "org.springframework.boot",
  "io.forge-x.core",
];
const NAMES = [
  "ledger-api",
  "rates-core",
  "northwind-pay-client",
  "spring-boot-starter-web",
  "forge_audit",
  "x",
];
const VERSIONS = [
  "1.2.0",
  "0.4.0-SNAPSHOT",
  "${project.version}",
  "${forge-rates.version}",
  "[1.0,2.0)",
];

// --- poms ---------------------------------------------------------------------------------

type Section = "dependencies" | "managed" | "plugin" | "profile";
interface Dep {
  group: string;
  artifact: string;
  version?: string;
  scope?: string;
  section: Section;
}
interface Pom {
  group?: string;
  artifact: string;
  version?: string;
  parent?: { group: string; artifact: string; version: string };
  deps: Dep[];
}
interface Shape {
  /** The `<project>` start tag's attributes over several lines, `>` maybe on its own line. */
  splitProject: boolean;
  /** A `<description>` whose CDATA holds a `<dependency>`. */
  cdata: boolean;
}

function drawPom(r: Rng): Pom {
  const deps: Dep[] = Array.from({ length: r.int(6) }, () => ({
    group: r.pick(GROUPS),
    artifact: r.pick(NAMES),
    ...(r.bool() ? { version: r.pick(VERSIONS) } : {}),
    ...(r.bool(0.4) ? { scope: r.pick(["compile", "runtime", "test", "provided", "import"]) } : {}),
    section: r.pick(["dependencies", "dependencies", "managed", "plugin", "profile"] as const),
  }));
  const parent = r.bool(0.7)
    ? { group: r.pick(GROUPS), artifact: r.pick(NAMES), version: r.pick(VERSIONS) }
    : undefined;
  return {
    ...(parent && r.bool(0.4) ? {} : { group: r.pick(GROUPS) }),
    artifact: r.pick(NAMES),
    ...(r.bool(0.8) ? { version: r.pick(VERSIONS) } : {}),
    ...(parent ? { parent } : {}),
    deps,
  };
}

interface Written {
  lines: string[];
  /** The line each value was written on, by its role. */
  at: Map<string, number>;
  /** The dependencies in the order written, each with its leaves' lines. */
  deps: { dep: Dep; group: number; artifact: number; version?: number; scope?: number }[];
}

/** Writes a pom from its model with random real-world quirks, recording every value's line. */
function writePom(r: Rng, pom: Pom, shape: Shape): Written {
  const out: string[] = [];
  const at = new Map<string, number>();
  const unit = r.pick(["  ", "    ", "\t"]);
  const ind = (n: number) => unit.repeat(n);
  const push = (s: string) => out.push(s);
  const noise = (depth: number) => {
    const k = r.int(10);
    if (k === 0) push("");
    else if (k === 1) push(`${ind(depth)}<!-- a note -->`);
    else if (k === 2) {
      push(`${ind(depth)}<!--`);
      push(
        `${ind(depth)}  <dependency><groupId>forge.gone</groupId><artifactId>commented-out</artifactId></dependency>`,
      );
      push(`${ind(depth)}-->`);
    }
  };
  /** A leaf; its value's line is recorded under `role`. */
  const leaf = (depth: number, tag: string, value: string, role?: string) => {
    const open = r.bool(0.1) ? `<${tag} >` : `<${tag}>`;
    const close = r.bool(0.1) ? `</${tag} >` : `</${tag}>`;
    const trail = r.bool(0.15) ? " <!-- why -->" : "";
    if (r.bool(0.12)) {
      // the value on a line of its own (a formatter's long value)
      push(`${ind(depth)}${open}`);
      push(`${ind(depth + 1)}${value}`);
      if (role) at.set(role, out.length);
      push(`${ind(depth)}${close}${trail}`);
    } else {
      push(`${ind(depth)}${open}${value}${close}${trail}`);
      if (role) at.set(role, out.length);
    }
  };
  if (r.bool())
    push(`<?xml version="1.0" encoding="UTF-8"${r.bool() ? ' standalone="yes"' : ""}?>`);
  if (r.bool(0.3)) {
    push("<!--");
    push("    Licensed under the Apache License, Version 2.0. <groupId>not.this</groupId>");
    push("-->");
  }
  const attrs = r.shuffle([
    'xmlns="http://maven.apache.org/POM/4.0.0"',
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
    'xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd"',
  ]);
  if (shape.splitProject) {
    const own = r.bool();
    push(`<project ${attrs[0]}`);
    for (const a of attrs.slice(1, own ? undefined : -1)) push(`${" ".repeat(9)}${a}`);
    if (own) push(">");
    else push(`${" ".repeat(9)}${attrs[attrs.length - 1]}>`);
  } else push(r.bool(0.2) ? "<project>" : `<project ${attrs.join(" ")}>`);
  const blocks: (() => void)[] = [];
  blocks.push(() => leaf(1, "modelVersion", "4.0.0"));
  if (pom.parent) {
    const p = pom.parent;
    blocks.push(() => {
      push(`${ind(1)}<parent>`);
      for (const k of r.shuffle(["g", "a", "v", "rel"])) {
        if (k === "g") leaf(2, "groupId", p.group, "parentGroup");
        if (k === "a") leaf(2, "artifactId", p.artifact, "parentArtifact");
        if (k === "v") leaf(2, "version", p.version, "parentVersion");
        if (k === "rel" && r.bool())
          push(
            `${ind(2)}${r.bool() ? "<relativePath/>" : "<relativePath>../pom.xml</relativePath>"}`,
          );
      }
      push(`${ind(1)}</parent>`);
    });
  }
  if (pom.group) blocks.push(() => leaf(1, "groupId", pom.group!, "group"));
  blocks.push(() => leaf(1, "artifactId", pom.artifact, "artifact"));
  if (pom.version) blocks.push(() => leaf(1, "version", pom.version!, "version"));
  if (shape.cdata)
    blocks.push(() => {
      push(`${ind(1)}<description><![CDATA[`);
      push(
        `${ind(2)}Use it as <dependency><groupId>forge.prose</groupId><artifactId>in-cdata</artifactId></dependency>.`,
      );
      push(`${ind(1)}]]></description>`);
    });
  const written: Written["deps"] = [];
  const depBlock = (depth: number, d: Dep) => {
    push(`${ind(depth)}<dependency>`);
    const lines: Partial<Record<"group" | "artifact" | "version" | "scope", number>> = {};
    for (const k of r.shuffle(["group", "artifact", "version", "scope"] as const)) {
      const v =
        k === "group"
          ? d.group
          : k === "artifact"
            ? d.artifact
            : k === "version"
              ? d.version
              : d.scope;
      if (v === undefined) continue;
      const tag = k === "group" ? "groupId" : k === "artifact" ? "artifactId" : k;
      leaf(depth + 1, tag, v, "dep");
      lines[k] = at.get("dep")!;
      noise(depth + 1);
    }
    if (r.bool(0.2)) {
      push(`${ind(depth + 1)}<exclusions>`);
      push(`${ind(depth + 2)}<exclusion>`);
      leaf(depth + 3, "groupId", "forge.excluded");
      leaf(depth + 3, "artifactId", "excluded");
      push(`${ind(depth + 2)}</exclusion>`);
      push(`${ind(depth + 1)}</exclusions>`);
    }
    push(`${ind(depth)}</dependency>`);
    written.push({
      dep: d,
      group: lines.group!,
      artifact: lines.artifact!,
      version: lines.version,
      scope: lines.scope,
    });
  };
  const of = (s: Section) => pom.deps.filter((d) => d.section === s);
  if (of("managed").length)
    blocks.push(() => {
      push(`${ind(1)}<dependencyManagement>`);
      push(`${ind(2)}<dependencies>`);
      for (const d of of("managed")) depBlock(3, d);
      push(`${ind(2)}</dependencies>`);
      push(`${ind(1)}</dependencyManagement>`);
    });
  if (of("dependencies").length)
    blocks.push(() => {
      push(`${ind(1)}<dependencies>`);
      for (const d of of("dependencies")) {
        depBlock(2, d);
        noise(2);
      }
      push(`${ind(1)}</dependencies>`);
    });
  if (of("profile").length)
    blocks.push(() => {
      push(`${ind(1)}<profiles>`);
      push(`${ind(2)}<profile>`);
      leaf(3, "id", "it");
      push(`${ind(3)}<dependencies>`);
      for (const d of of("profile")) depBlock(4, d);
      push(`${ind(3)}</dependencies>`);
      push(`${ind(2)}</profile>`);
      push(`${ind(1)}</profiles>`);
    });
  if (of("plugin").length)
    blocks.push(() => {
      push(`${ind(1)}<build>`);
      push(`${ind(2)}<plugins>`);
      push(`${ind(3)}<plugin>`);
      leaf(4, "groupId", "org.apache.maven.plugins");
      leaf(4, "artifactId", "maven-checkstyle-plugin");
      push(`${ind(4)}<dependencies>`);
      for (const d of of("plugin")) depBlock(5, d);
      push(`${ind(4)}</dependencies>`);
      push(`${ind(3)}</plugin>`);
      push(`${ind(2)}</plugins>`);
      push(`${ind(1)}</build>`);
    });
  // the model's own elements in any order a hand-written pom has them
  for (const b of r.shuffle(blocks)) {
    b();
    noise(1);
  }
  push("</project>");
  return { lines: out, at, deps: written };
}

/** The bytes a checkout holds: LF or CRLF, a BOM or not; split as a reader handed raw text does. */
function asRead(r: Rng, lines: string[]): string[] {
  const eol = r.bool(0.3) ? "\r\n" : "\n";
  const text = (r.bool(0.2) ? "\uFEFF" : "") + lines.join(eol) + eol;
  return text.split("\n");
}

function expectRead(seed: number, shape: Shape) {
  const r = rng(seed);
  const pom = drawPom(r);
  const w = writePom(r, pom, shape);
  const got = pomCoordinates(asRead(r, w.lines));
  const v = (value: string | undefined, role: string) =>
    value === undefined ? undefined : { value, line: w.at.get(role) };
  const want = {
    group: v(pom.group, "group"),
    artifact: v(pom.artifact, "artifact"),
    version: v(pom.version, "version"),
    parentGroup: v(pom.parent?.group, "parentGroup"),
    parentArtifact: v(pom.parent?.artifact, "parentArtifact"),
    parentVersion: v(pom.parent?.version, "parentVersion"),
    dependencies: w.deps.map(({ dep, group, artifact, version, scope }) => ({
      group: { value: dep.group, line: group },
      artifact: { value: dep.artifact, line: artifact },
      ...(dep.version !== undefined ? { version: { value: dep.version, line: version } } : {}),
      ...(dep.scope !== undefined ? { scope: { value: dep.scope, line: scope } } : {}),
      managed: dep.section === "managed",
      plugin: dep.section === "plugin",
    })),
  };
  const plain = JSON.parse(
    JSON.stringify({ ...got, dependencies: [...got.dependencies].sort(byLine) }),
  );
  const wanted = JSON.parse(
    JSON.stringify({ ...want, dependencies: [...want.dependencies].sort(byLine) }),
  );
  expect(plain, `seed ${seed}\n${w.lines.join("\n")}`).toEqual(wanted);
}
const byLine = (a: { artifact?: { line?: number } }, b: { artifact?: { line?: number } }) =>
  (a.artifact?.line ?? 0) - (b.artifact?.line ?? 0);

describe("the pom reader on generated real-world poms", () => {
  it("reads every value at its line: any indentation, CRLF, BOM, comments, split leaves, element order", () => {
    for (const seed of SEEDS) expectRead(seed, { splitProject: false, cdata: false });
  });

  // known bug: a <project> start tag whose attributes run over several lines is never opened, so the project's and its <parent>'s coordinates are lost
  it.fails(
    "reads every value when the <project> start tag spans lines (attributes in any order)",
    () => {
      for (const seed of SEEDS) expectRead(seed, { splitProject: true, cdata: false });
    },
  );

  // known bug: a CDATA section is read as markup, so a <dependency> in a <description>'s CDATA becomes a dependency
  it.fails("reads no dependency out of a CDATA section", () => {
    for (const seed of SEEDS) expectRead(seed, { splitProject: false, cdata: true });
  });
});

// --- Gradle lines ---------------------------------------------------------------------------

const CONFIGS: Record<string, GradleDependency["scope"]> = {
  implementation: "compile",
  api: "compile",
  compileOnly: "provided",
  annotationProcessor: "provided",
  runtimeOnly: "runtime",
  testImplementation: "test",
  testRuntimeOnly: "test",
  testCompileOnly: "test",
};

interface GradleCase {
  line: string;
  want: GradleDependency;
}

/** A dependency line in one of the notations public builds use, with random spacing and tails. */
function drawGradle(
  r: Rng,
  configs: readonly string[],
  scopeOf: (c: string) => GradleDependency["scope"],
): GradleCase {
  const configuration = r.pick(configs);
  const group = r.pick(GROUPS);
  const name = r.pick(NAMES);
  const version = r.bool(0.7)
    ? r.pick(["1.2.0", "0.4.0-SNAPSHOT", "${ledgerVersion}", "2.+"])
    : undefined;
  const q = r.pick(["'", '"']);
  const coords = `${group}:${name}${version ? `:${version}` : ""}`;
  const sp = () => r.pick(["", " ", "  "]);
  const platform = r.bool(0.1);
  const notation = r.pick(["groovy", "paren", "kotlin-map", "groovy-map"] as const);
  let body: string;
  if (platform) {
    const fn = r.pick(["platform", "enforcedPlatform"]);
    body = r.bool()
      ? `${configuration}(${fn}(${q}${coords}${q}))`
      : `${configuration} ${fn}(${q}${coords}${q})`;
  } else if (notation === "groovy") body = `${configuration} ${q}${coords}${q}`;
  else if (notation === "paren") body = `${configuration}${sp()}(${sp()}${q}${coords}${q}${sp()})`;
  else if (notation === "kotlin-map")
    body = `${configuration}(group = "${group}", name = "${name}"${version ? `, version = "${version}"` : ""})`;
  else
    body = `${configuration} group: '${group}', name: '${name}'${version ? `, version: '${version}'` : ""}`;
  const lead = r.pick(["", "  ", "    ", "\t", "\t\t"]);
  const tail = r.pick(["", "", " ", " // pinned by the platform", " {", "\r"]);
  return {
    line: `${lead}${body}${tail}`,
    want: {
      configuration,
      group,
      name,
      ...(version ? { version } : {}),
      scope: platform ? "import" : scopeOf(configuration),
    },
  };
}

describe("the Gradle line reader on generated real-world lines", () => {
  it("reads every notation's configuration, coordinates and scope, whatever the spacing and tail", () => {
    for (const seed of SEEDS) {
      const c = drawGradle(rng(seed), Object.keys(CONFIGS), (k) => CONFIGS[k]!);
      expect(gradleDependencyOn(c.line), `seed ${seed}: ${JSON.stringify(c.line)}`).toEqual(c.want);
    }
  });

  // known bug: only a configuration starting `test` is test-scoped, so a custom source set's (integrationTest, functionalTest, testFixtures-free) reads as compile
  it.fails("reads a custom test source set's configurations as test scope", () => {
    const configs = [
      "integrationTestImplementation",
      "integrationTestRuntimeOnly",
      "functionalTestImplementation",
    ];
    for (const seed of SEEDS) {
      const c = drawGradle(rng(seed), configs, () => "test");
      if (c.want.scope === "import") continue;
      expect(gradleDependencyOn(c.line), `seed ${seed}: ${JSON.stringify(c.line)}`).toEqual(c.want);
    }
  });

  it("reads no dependency from a line that declares none", () => {
    for (const line of [
      "    id 'java'",
      '  id("org.springframework.boot") version "3.5.11"',
      "    apply plugin: 'io.spring.dependency-management'",
      "    implementation project(':rates-core')",
      "  api(projects.okhttp)",
      "  implementation(libs.forge.ledger.api)",
      "    classpath 'org.springframework.boot:spring-boot-gradle-plugin:3.5.11'",
      "include 'rates-core', 'rates-service'",
      "    group = 'forge.rates'",
      '        java.srcDir "src/integrationTest/java"',
    ])
      expect(gradleDependencyOn(line), line).toBeUndefined();
  });
});
