import type { Fact, FactOf } from "@maycombhq/core";

/**
 * What a repo is built on (ADR 0124 addendum A-framework): the declarations Atticus knows, the
 * rule topics a framework turns on, the shape of fact a framework's patterns produce (so a repo
 * that declares one and shows none of them is a question for a person), and the house
 * dependencies Atticus doesn't know, each a prompt to learn it as a C6 framework file (ADR 0054).
 *
 * The named knowledge lives here, not in core: core never branches on a framework's name.
 * Everything here reads the facts and the org pack's own words; nothing opens a file.
 */

/** A framework fact, for short. */
export type FrameworkFact = FactOf<"framework">;

/**
 * The frameworks whose rules the reading protocol has a part for (ADR 0124 addendum A-framework):
 * a batch's prompt carries the parts of the frameworks its repo declares. The same words as
 * `FRAMEWORK_TOPICS` in @maycombhq/assistant-files, where the rules are; a test holds them equal.
 */
export const FRAMEWORKS = [
  "spring",
  "aspnet",
  "express",
  "nest",
  "angular",
  "react",
  "vue",
  "next",
  "quarkus",
  "django",
  "rails",
  "laravel",
  "house",
] as const;
export type FrameworkTopic = (typeof FRAMEWORKS)[number];

/** What a framework's own patterns put in the facts, when the reader finds its entry points. */
export type FrameworkShape = "rest" | "screen" | "batch-job" | "store";

interface Known {
  /** The name a framework fact must give. */
  name: string;
  /** The rules it turns on; none when the protocol has no part for it. */
  topic?: FrameworkTopic;
  /** What its patterns produce, for the missed-read check; none when Atticus can't be sure. */
  shape?: FrameworkShape;
}

/**
 * What a declaration in a build file means: a Maven artifact, an npm package, an MSBuild SDK, a
 * PyPI distribution, a RubyGem, a Composer package. A key ending in `*` matches a declaration
 * that starts with it, so `spring-boot-starter-web` and `spring-boot-starter-data-jpa` are both
 * Spring Boot. Matched on the declaration alone, letter case aside: a group or scope is dropped
 * first (`io.quarkus:quarkus-rest`, `@angular/core`), and so is a version suffix a lock-free
 * declaration writes (`django==5.1.1`).
 */
const KNOWN: readonly (readonly [string, Known])[] = [
  // Java and Kotlin
  ["spring-boot*", { name: "spring-boot", topic: "spring", shape: "rest" }],
  // the annotation a Spring Boot app's main class carries, which a reader may cite instead
  ["@springbootapplication", { name: "spring-boot", topic: "spring", shape: "rest" }],
  ["spring-webmvc", { name: "spring", topic: "spring", shape: "rest" }],
  ["spring-webflux", { name: "spring", topic: "spring", shape: "rest" }],
  ["spring-web", { name: "spring", topic: "spring", shape: "rest" }],
  ["spring-data-rest*", { name: "spring-data-rest", topic: "spring", shape: "rest" }],
  ["spring-context", { name: "spring", topic: "spring" }],
  ["spring-core", { name: "spring", topic: "spring" }],
  ["hibernate-core", { name: "hibernate", topic: "spring", shape: "store" }],
  ["quarkus-bom", { name: "quarkus", topic: "quarkus" }],
  ["quarkus-rest*", { name: "quarkus", topic: "quarkus", shape: "rest" }],
  ["quarkus-resteasy*", { name: "quarkus", topic: "quarkus", shape: "rest" }],
  ["quarkus*", { name: "quarkus", topic: "quarkus" }],
  ["micronaut-http-server*", { name: "micronaut", shape: "rest" }],
  ["micronaut*", { name: "micronaut" }],
  // .NET
  ["microsoft.net.sdk.web", { name: "asp.net", topic: "aspnet", shape: "rest" }],
  ["microsoft.aspnetcore*", { name: "asp.net", topic: "aspnet", shape: "rest" }],
  ["microsoft.entityframeworkcore*", { name: "entity-framework", topic: "aspnet", shape: "store" }],
  // Node
  ["express", { name: "express", topic: "express", shape: "rest" }],
  ["@nestjs/core", { name: "nest", topic: "nest", shape: "rest" }],
  ["nestjs/core", { name: "nest", topic: "nest", shape: "rest" }],
  ["@angular/core", { name: "angular", topic: "angular", shape: "screen" }],
  ["angular/core", { name: "angular", topic: "angular", shape: "screen" }],
  ["react", { name: "react", topic: "react", shape: "screen" }],
  ["vue", { name: "vue", topic: "vue", shape: "screen" }],
  ["next", { name: "next", topic: "next" }],
  ["svelte", { name: "svelte" }],
  ["typeorm", { name: "typeorm", topic: "express", shape: "store" }],
  ["@prisma/client", { name: "prisma", topic: "express", shape: "store" }],
  ["prisma/client", { name: "prisma", topic: "express", shape: "store" }],
  // Python
  ["django", { name: "django", topic: "django", shape: "rest" }],
  ["djangorestframework", { name: "django-rest-framework", topic: "django", shape: "rest" }],
  ["flask", { name: "flask", shape: "rest" }],
  ["fastapi", { name: "fastapi", shape: "rest" }],
  ["celery", { name: "celery", topic: "django", shape: "batch-job" }],
  // Ruby
  ["rails", { name: "rails", topic: "rails", shape: "rest" }],
  ["sidekiq", { name: "sidekiq", topic: "rails", shape: "batch-job" }],
  ["devise", { name: "devise", topic: "rails" }],
  // PHP
  ["laravel/framework", { name: "laravel", topic: "laravel", shape: "rest" }],
  ["laravel", { name: "laravel", topic: "laravel", shape: "rest" }],
];

/** A declaration as it is matched: group or scope dropped, version suffix dropped, lower case. */
export function declarationKey(declared: string): string {
  const d = declared.trim().toLowerCase();
  // a Maven or Gradle coordinate keeps its artifact: `group:artifact` and `group:artifact:version`
  const parts = d.split(":");
  const colon = parts.length > 1 ? (parts[1] ?? d) : d;
  // a requirement or a gem line (`django==5.1.1`, `rails ~> 7.1`) keeps its name
  const name = colon.split(/[=<>~!,\s[]/)[0] ?? colon;
  return name.replace(/^['"]|['"]$/g, "");
}

/** The framework a declaration names, or undefined when Atticus doesn't know it. */
export function frameworkOf(declared: string): Known | undefined {
  const key = declarationKey(declared);
  if (!key) return undefined;
  // an npm scope is part of the name (`@angular/core`), so try the whole thing first
  for (const [pattern, known] of KNOWN) {
    const star = pattern.endsWith("*");
    const p = star ? pattern.slice(0, -1) : pattern;
    if (star ? key.startsWith(p) : key === p) return known;
  }
  return undefined;
}

/**
 * Why a framework fact's `name` doesn't follow from the line it cites, or undefined when it
 * does. The declaration on the cited line is checked by the line check like any other claim;
 * this says whether the name the reader gives is the one that declaration means.
 *
 * Atticus knows the declaration: the name must be the one it gives it. Atticus doesn't (a house
 * starter, a platform library, a framework newer than this table): the name must be the
 * declaration itself, letter case, a group or scope and a version suffix aside, so a reader
 * can't put a name of its own on an artifact nobody here can read.
 */
export function frameworkNameProblem(f: FrameworkFact): string | undefined {
  const known = frameworkOf(f.cite.value);
  const name = f.name.trim().toLowerCase();
  if (known) {
    return name === known.name
      ? undefined
      : `names the framework "${f.name}", but ${f.cite.file}:${f.cite.line} declares ${f.cite.value}, which is ${known.name}`;
  }
  const key = declarationKey(f.cite.value);
  if (declarationKey(name) === key || name === key) return undefined;
  return `names the framework "${f.name}", which ${f.cite.file}:${f.cite.line} doesn't declare: it declares ${f.cite.value}, and Atticus doesn't know that one, so name it as the build file writes it (${key})`;
}

/** The framework facts of these facts, in id order. */
export const frameworkFacts = (facts: readonly Fact[]): FrameworkFact[] =>
  facts
    .filter((f): f is FrameworkFact => f.kind === "framework")
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/**
 * The rule topics a repo's framework facts turn on, in `FRAMEWORKS` order. Undefined when the
 * facts name no framework at all: nothing is known yet, so a prompt carries every framework's
 * rules, exactly as a file whose path can't say its kind gets every kind's (`fileKinds`).
 */
export function frameworkTopics(facts: readonly Fact[]): FrameworkTopic[] | undefined {
  const fws = frameworkFacts(facts);
  if (!fws.length) return undefined;
  const topics = new Set<FrameworkTopic>();
  for (const f of fws) {
    const known = frameworkOf(f.cite.value);
    // A house framework or one Atticus doesn't know: its own rule part, which tells the reader
    // that a house annotation may hide a route and to record the framework rather than guess.
    if (!known?.topic) topics.add("house");
    else topics.add(known.topic);
  }
  return FRAMEWORKS.filter((t) => topics.has(t));
}

/**
 * The rule topics a repo's type suggests (`repos.manifest.yaml`, the types of ADR 0077 and
 * `detectRepoType`), for the first batch of a first read, when no fact of the repo says yet what
 * it is built on. A hint from the manifest, never a fact: a framework fact read from a build
 * file replaces it, and nothing is written anywhere from it — it only decides which rules a
 * prompt carries. A type nobody here maps gives none.
 */
export function frameworkTopicsOfType(type: string | undefined): FrameworkTopic[] {
  const t = (type ?? "").trim().toLowerCase();
  const topics: readonly FrameworkTopic[] =
    t === "spring-boot" || t === "java"
      ? ["spring"]
      : t === "dotnet"
        ? ["aspnet"]
        : t === "frontend"
          ? ["angular", "react", "vue", "next"]
          : t === "node"
            ? ["express", "nest", "next", "react"]
            : t === "python"
              ? ["django"]
              : [];
  return FRAMEWORKS.filter((x) => topics.includes(x));
}

/**
 * A framework a repo declares whose patterns none of its facts show (ADR 0124 addendum
 * A-framework): a note and a question for a person, never a rejection. Usually it means the
 * reader missed the real entry points.
 */
export interface FrameworkGap {
  /** The framework fact's id and name. */
  id: string;
  framework: string;
  /** Where it is declared, `file:line`. */
  cite: string;
  /** The shape of fact its patterns produce and none of the facts holds. */
  expected: FrameworkShape;
  /** The question, in the words `atticus verify` and the map print. */
  question: string;
}

const SHAPE_WORDS: Record<FrameworkShape, string> = {
  rest: "no REST entry",
  screen: "no screen entry",
  "batch-job": "no batch-job entry",
  store: "no table it reads or writes",
};

const SHAPE_ASK: Record<FrameworkShape, string> = {
  rest: "which routes it serves",
  screen: "which screens it has",
  "batch-job": "which jobs it runs",
  store: "which tables it reads and writes",
};

const holdsShape = (facts: readonly Fact[], shape: FrameworkShape): boolean =>
  facts.some((f) =>
    shape === "store"
      ? f.kind === "store"
      : f.kind === "entry" && f.entryType === (shape === "rest" ? "rest" : shape),
  );

/**
 * The frameworks these facts declare whose patterns the facts show none of, in id order.
 *
 * Kept to what the facts support: a gap is raised only for a framework Atticus knows the shape
 * of, and only when the facts hold something else of the repo — a repo nobody has read yet is
 * not a repo whose entry points were missed. A house framework, or one Atticus doesn't know,
 * raises none: nothing here can say what its patterns look like until it is learned.
 */
export function frameworkGaps(facts: readonly Fact[]): FrameworkGap[] {
  const fws = frameworkFacts(facts);
  if (!fws.length) return [];
  if (!facts.some((f) => f.kind !== "framework")) return [];
  const out: FrameworkGap[] = [];
  for (const f of fws) {
    const shape = frameworkOf(f.cite.value)?.shape;
    if (!shape || holdsShape(facts, shape)) continue;
    out.push({
      id: f.id,
      framework: f.name,
      cite: `${f.cite.file}:${f.cite.line}`,
      expected: shape,
      question: `${f.repo} declares ${f.name} at ${f.cite.file}:${f.cite.line}, and its facts have ${SHAPE_WORDS[shape]}. Were its entry points missed, or does this repo really have none? Read it again for ${SHAPE_ASK[shape]}, or say it has none.`,
    });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * A framework a repo declares that Atticus can't read: neither one it knows nor one the org pack
 * teaches it (a C6 framework file, ADR 0054). Its annotations, base classes and wrapper clients
 * mean something no reader here can see, so it is learned, not guessed at as ordinary code.
 */
export interface FrameworkToLearn {
  id: string;
  /** The name as the build file declares it, which is the C6 file's name. */
  framework: string;
  cite: string;
  /** `atticus frameworks learn <name> --from <repo>`. */
  command: string;
  why: string;
}

/**
 * The frameworks of these facts that nothing can read yet, in id order. `known` is what the org
 * pack's framework files already cover (ADR 0054): each file's `name` and its `artifacts`
 * (`group:artifact[:version]`), matched as a declaration is — letter case, group and version
 * aside — so a repo whose starter is already taught raises nothing.
 */
/**
 * An Apigee bundle written as a framework fact: a proxy (`<APIProxy>`, under `apiproxy/`) or a
 * shared flow (`<SharedFlowBundle>`, under `sharedflowbundle/` or `sharedflows/`). Map reads
 * these as the gateway's routes, auth, scopes and callers (ADR 0124 addenda A-gateway,
 * A-gateway2); there is nothing to learn, so none is offered.
 */
export function isApigeeBundle(f: Pick<Fact, "cite"> & { name?: string }): boolean {
  const file = f.cite.file.replace(/\\/g, "/").toLowerCase();
  const said = `${f.cite.value} ${f.cite.quote ?? ""}`;
  return (
    /<\s*(APIProxy|SharedFlowBundle)\b/i.test(said) ||
    /^(apiproxy|sharedflowbundle)$/i.test(f.cite.value.trim()) ||
    /(^|\/)(apiproxy|sharedflowbundle|sharedflows)\//.test(file)
  );
}

export function frameworksToLearn(
  facts: readonly Fact[],
  known: readonly string[] = [],
): FrameworkToLearn[] {
  const have = new Set(known.map(declarationKey));
  return frameworkFacts(facts)
    .filter(
      (f) =>
        !isApigeeBundle(f) &&
        !frameworkOf(f.cite.value) &&
        !have.has(declarationKey(f.name)) &&
        !have.has(declarationKey(f.cite.value)),
    )
    .map((f) => ({
      id: f.id,
      framework: f.name,
      cite: `${f.cite.file}:${f.cite.line}`,
      command: `atticus frameworks learn ${f.name} --from ${f.repo}`,
      why: `${f.repo} is built on ${f.name} (${f.cite.file}:${f.cite.line}), which Atticus can't read: teach it once and every repo of the house that uses it is read with it.`,
    }));
}
