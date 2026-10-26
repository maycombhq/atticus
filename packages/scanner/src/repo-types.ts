import { isScalar, LineCounter, parseAllDocuments } from "yaml";
import {
  REPO_TYPE_SCHEMA_VERSION,
  SCAN_SETTINGS_SCHEMA_VERSION,
  type FingerprintSignal,
  type PrefixRule,
  type RepoType,
  type ScanSettings,
} from "@maycombhq/core";
import { PREFIX_CONVENTIONS } from "@maycombhq/extractors";
import { globToRegExp, type RepoHandle } from "@maycombhq/sdk";

/**
 * Repo types (ADR 0077): match a repo against the organisation's known types by fingerprint,
 * resolve a type's scan-settings template against one repo, and draft a new type from a repo.
 * All deterministic: files present, lines that match, nothing guessed. Every signal found
 * cites the file (or file:line) that shows it.
 */

/** At or above this share of a type's weight, a match is clear: reuse the type. */
export const CLEAR_MATCH = 0.7;
/** At or above this share (and below clear), a match is partial: reuse and extend. */
export const PARTIAL_MATCH = 0.4;
/** Two types within this share of each other, both at least partial, are a tie: ask. */
export const TIE_MARGIN = 0.1;

/** Most files read for one signal, and the longest line tested, so a scan stays bounded. */
const MAX_FILES_PER_SIGNAL = 2000;
const MAX_LINE = 2000;
const MAX_EVIDENCE = 3;

export interface SignalResult {
  kind: FingerprintSignal["kind"];
  /** What the signal looks for, in a few words. */
  label: string;
  weight: number;
  required: boolean;
  found: boolean;
  /** Up to three files (or file:line) that show it. */
  evidence: string[];
}

export interface TypeMatch {
  type: string;
  name: string;
  /** The share of the type's weight found, 0 to 1, two decimals. */
  score: number;
  got: number;
  total: number;
  /** A required signal is missing, so the type can't match whatever the score. */
  ruledOut: boolean;
  signals: SignalResult[];
}

export type MatchVerdict = "clear" | "partial" | "none" | "tie";

export interface RepoTypeMatches {
  verdict: MatchVerdict;
  /** The matched type, for a clear or partial match. */
  best?: string;
  /** The types that tie, for a tie. */
  tied?: string[];
  /** Every type, best first. */
  matches: TypeMatch[];
  /**
   * The type the repo's description names (ADR 0128), when it names one of the org pack's types
   * and the fingerprints don't settle it: a tie it leans, or a suggestion where nothing matched.
   * The words it was read from are given, so a person sees why. Never a match on its own: the
   * fingerprints are read from the files, and the verdict stays a tie or none.
   */
  fromDescription?: { type: string; words: string };
}

const SKIP = /(^|\/)(node_modules|\.git|target|bin|obj|dist|build|\.atticus|vendor)\//;

/** The repo's files, once, sorted, and each file's lines when a signal needs them. */
class RepoFiles {
  private files?: string[];
  private lines = new Map<string, string[] | null>();
  constructor(readonly repo: RepoHandle) {}

  async all(): Promise<string[]> {
    if (!this.files) {
      const out: string[] = [];
      for await (const f of this.repo.listFiles(["**/*"])) if (!SKIP.test(f)) out.push(f);
      this.files = out.sort();
    }
    return this.files;
  }

  async matching(globs: readonly string[]): Promise<string[]> {
    const res = globs.map(globToRegExp);
    return (await this.all()).filter((f) => res.some((re) => re.test(f)));
  }

  async linesOf(path: string): Promise<string[] | null> {
    if (!this.lines.has(path)) {
      const text = await this.repo.readText(path).catch(() => undefined);
      this.lines.set(path, text === undefined ? null : text.replace(/\r\n?/g, "\n").split("\n"));
    }
    return this.lines.get(path)!;
  }

  /** The first lines (path:line) in files matching `globs` that pass `test`, up to `max`. */
  async lineHits(
    globs: readonly string[],
    test: (line: string) => boolean,
    max = MAX_EVIDENCE,
  ): Promise<string[]> {
    const hits: string[] = [];
    for (const f of (await this.matching(globs)).slice(0, MAX_FILES_PER_SIGNAL)) {
      const lines = await this.linesOf(f);
      if (!lines) continue;
      const i = lines.findIndex((l) => l.length <= MAX_LINE && test(l));
      if (i >= 0) hits.push(`${f}:${i + 1}`);
      if (hits.length >= max) break;
    }
    return hits;
  }
}

/** The words of a build-file line: names of packages, artifacts and modules. */
const words = (line: string) => line.split(/[^A-Za-z0-9_.@/-]+/).filter(Boolean);
const nameTest = (names: readonly string[]) => {
  const tests = names.map((n) =>
    n.endsWith("*") ? (w: string) => w.startsWith(n.slice(0, -1)) : (w: string) => w === n,
  );
  return (line: string) => words(line).some((w) => tests.some((t) => t(w)));
};

function label(s: FingerprintSignal): string {
  switch (s.kind) {
    case "build-file":
      return `build file ${s.globs.join(" or ")}`;
    case "dependency":
      return `dependency ${s.names.join(" or ")}`;
    case "marker":
      return `marker /${s.pattern}/ in ${s.in.join(", ")}`;
    case "layout":
      return `files in ${s.globs.join(" or ")}`;
  }
}

async function evidenceFor(s: FingerprintSignal, files: RepoFiles): Promise<string[]> {
  switch (s.kind) {
    case "build-file":
    case "layout":
      return (await files.matching(s.globs)).slice(0, MAX_EVIDENCE);
    case "dependency":
      return files.lineHits(s.in, nameTest(s.names));
    case "marker": {
      const re = new RegExp(s.pattern);
      return files.lineHits(s.in, (l) => re.test(l));
    }
  }
}

async function scoreType(t: RepoType, files: RepoFiles): Promise<TypeMatch> {
  const signals: SignalResult[] = [];
  for (const s of t.fingerprint) {
    const evidence = await evidenceFor(s, files);
    signals.push({
      kind: s.kind,
      label: label(s),
      weight: s.weight,
      required: s.required,
      found: evidence.length > 0,
      evidence,
    });
  }
  const total = signals.reduce((n, s) => n + s.weight, 0);
  const got = signals.filter((s) => s.found).reduce((n, s) => n + s.weight, 0);
  return {
    type: t.id,
    name: t.name,
    score: Math.round((got * 100) / total) / 100,
    got,
    total,
    ruledOut: signals.some((s) => s.required && !s.found),
    signals,
  };
}

/**
 * The org pack's type a description names (ADR 0128): its id, or its name, as words of the
 * description. Matched on whole words, longest name first, so "gateway" doesn't beat "api
 * gateway"; nothing when the description names none or names two.
 */
function typeFromWords(
  description: string | undefined,
  types: readonly RepoType[],
): { type: string; words: string } | undefined {
  const text = (description ?? "").toLowerCase();
  if (!text) return undefined;
  const hits: { type: string; words: string }[] = [];
  for (const t of types)
    for (const words of [t.name.toLowerCase(), t.id.replace(/[-_.]+/g, " ")])
      if (words.length > 2 && new RegExp(`(^|[^a-z0-9])${escapeRe(words)}([^a-z0-9]|$)`).test(text))
        hits.push({ type: t.id, words });
  const ids = new Set(hits.map((h) => h.type));
  if (ids.size !== 1) return undefined;
  return [...hits].sort((a, b) => b.words.length - a.words.length)[0];
}

/**
 * Score every type's fingerprint against the repo, best first, and say what to do: a clear
 * match (reuse the type), partial (reuse and extend), none (a new type) or a tie (ask).
 */
export async function matchRepoType(
  repo: RepoHandle,
  types: readonly RepoType[],
  o: { description?: string } = {},
): Promise<RepoTypeMatches> {
  const files = new RepoFiles(repo);
  const matches: TypeMatch[] = [];
  for (const t of types) matches.push(await scoreType(t, files));
  const pct = (m: TypeMatch) => Math.round(m.score * 100);
  matches.sort(
    (a, b) =>
      Number(a.ruledOut) - Number(b.ruledOut) || pct(b) - pct(a) || a.type.localeCompare(b.type),
  );
  const said = typeFromWords(o.description, types);
  const eligible = matches.filter((m) => !m.ruledOut && pct(m) >= PARTIAL_MATCH * 100);
  const top = eligible[0];
  if (!top) return { verdict: "none", matches, ...(said ? { fromDescription: said } : {}) };
  const tied = eligible.filter((m) => pct(top) - pct(m) < TIE_MARGIN * 100);
  if (tied.length > 1) {
    const ids = tied.map((m) => m.type);
    return {
      verdict: "tie",
      tied: ids,
      matches,
      // Only a tie among the types that actually tie is leaned: the description never introduces
      // a type the fingerprints ruled out or never reached.
      ...(said && ids.includes(said.type) ? { fromDescription: said } : {}),
    };
  }
  return {
    verdict: pct(top) >= CLEAR_MATCH * 100 ? "clear" : "partial",
    best: top.type,
    matches,
  };
}

// ---------- the settings template on one repo

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** The value a prefix rule reads in one file, with its line, or undefined. */
async function readRule(
  rule: PrefixRule,
  path: string,
  files: RepoFiles,
): Promise<{ value: string; line: number } | undefined> {
  const lines = await files.linesOf(path);
  if (!lines) return undefined;
  if (rule.pattern !== undefined) {
    const re = new RegExp(rule.pattern);
    for (const [i, l] of lines.entries()) {
      if (l.length > MAX_LINE) continue;
      const m = re.exec(l);
      if (m) return { value: (m[1] ?? m[0]).trim(), line: i + 1 };
    }
    return undefined;
  }
  const key = rule.key!;
  if (/\.ya?ml$/i.test(path)) {
    const counter = new LineCounter();
    const text = lines.join("\n");
    for (const doc of parseAllDocuments(text, { lineCounter: counter })) {
      if (!("getIn" in doc)) continue;
      for (const node of [doc.getIn(key.split("."), true), doc.get(key, true)]) {
        if (isScalar(node) && node.range && node.value !== null && node.value !== undefined)
          return { value: String(node.value), line: counter.linePos(node.range[0]).line };
      }
    }
    return undefined;
  }
  const re = new RegExp(`^\\s*${escapeRe(key)}\\s*[=:]\\s*(.*?)\\s*$`);
  for (const [i, l] of lines.entries()) {
    const m = re.exec(l);
    if (m) return { value: m[1]!, line: i + 1 };
  }
  return undefined;
}

/** "/notes-api/" or "notes-api" to "/notes-api"; undefined for "/", "" or a placeholder. */
function asPrefix(value: string): string | undefined {
  if (/[${}]/.test(value)) return undefined;
  const p = `/${value.trim().replace(/^\/+/, "").replace(/\/+$/, "")}`;
  return p !== "/" && /^\/[^\s?#]*$/.test(p) ? p : undefined;
}

/**
 * The scan settings (ADR 0075) a type's template gives one repo: each folder to leave out that
 * the repo has, and each prefix rule's value where the repo sets it, cited so the citation
 * check confirms it. A rule the repo doesn't set gives nothing.
 */
export async function resolveSettingsTemplate(
  t: RepoType,
  repo: RepoHandle,
  repoId: string,
): Promise<ScanSettings> {
  const files = new RepoFiles(repo);
  const out: ScanSettings = {
    schemaVersion: SCAN_SETTINGS_SCHEMA_VERSION,
    repo: repoId,
    exclude: [],
    prefixes: [],
    clients: [],
  };
  for (const e of t.settings.exclude) {
    const first = (await files.matching([e.path]))[0];
    if (first) out.exclude.push({ path: e.path, why: e.why, at: `${first}:1` });
  }
  for (const rule of t.settings.prefixes) {
    // application.properties before application-dev.properties: the shortest name first.
    const candidates = (await files.matching(rule.files)).sort(
      (a, b) => a.length - b.length || a.localeCompare(b),
    );
    for (const f of candidates) {
      const hit = await readRule(rule, f, files);
      if (!hit) continue;
      const prefix = asPrefix(hit.value);
      const line = (await files.linesOf(f))?.[hit.line - 1] ?? "";
      if (prefix && hit.value && line.includes(hit.value))
        out.prefixes.push({
          paths: rule.paths,
          prefix,
          why: rule.why,
          at: `${f}:${hit.line}`,
          value: hit.value,
        });
      break;
    }
  }
  return out;
}

// ---------- drafting a type from a repo

const BUILD_FILES: { name: string; glob: string; re: RegExp }[] = [
  ["pom.xml", "pom.xml"],
  ["build.gradle", "build.gradle"],
  ["build.gradle.kts", "build.gradle.kts"],
  ["package.json", "package.json"],
  ["*.csproj", "*.csproj"],
  ["pyproject.toml", "pyproject.toml"],
  ["requirements.txt", "requirements.txt"],
  ["go.mod", "go.mod"],
  ["Cargo.toml", "Cargo.toml"],
  ["Gemfile", "Gemfile"],
  ["composer.json", "composer.json"],
].map(([name, glob]) => ({ name: name!, glob: glob!, re: globToRegExp(`**/${glob!}`) }));

const PACKAGE_NAME = /^[A-Za-z0-9_.@/-]+$/;

/** Dependency names a build file declares, in the order written. */
function declaredDependencies(path: string, text: string): string[] {
  const out: string[] = [];
  const all = (re: RegExp, g = 1) => {
    for (const m of text.matchAll(re)) if (m[g]) out.push(m[g]!.trim());
  };
  if (path.endsWith("pom.xml")) {
    for (const block of text.matchAll(/<(parent|dependency|plugin)>([\s\S]*?)<\/\1>/g)) {
      const a = /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/.exec(block[2]!);
      if (a) out.push(a[1]!);
    }
  } else if (/build\.gradle(\.kts)?$/.test(path)) {
    all(/['"]([\w.-]+):([\w.-]+)(?::[^'"]*)?['"]/g, 2);
  } else if (path.endsWith("package.json")) {
    try {
      const j = JSON.parse(text) as Record<string, Record<string, string> | undefined>;
      const deps = Object.keys(j.dependencies ?? {});
      out.push(...(deps.length ? deps : Object.keys(j.devDependencies ?? {})));
    } catch {
      // not JSON: nothing declared
    }
  } else if (path.endsWith(".csproj")) {
    all(/<PackageReference\s+Include="([^"]+)"/g);
  } else if (path.endsWith("requirements.txt")) {
    all(/^\s*([A-Za-z0-9_.-]+)/gm);
  } else if (path.endsWith("go.mod")) {
    all(/^\s*(?:require\s+)?([\w.-]+\.[\w.-]+\/[\w./-]+)\s+v/gm);
  }
  return out;
}

/** Common names that say nothing about the kind of repo. */
const PLAIN_ANNOTATIONS = new Set([
  "Override",
  "Deprecated",
  "SuppressWarnings",
  "FunctionalInterface",
  "SafeVarargs",
  "Test",
  "JvmStatic",
]);

/** The top names by the number of files they're in, ties by name. */
function top(counts: Map<string, number>, n: number): string[] {
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([k]) => k);
}

/** Test code says how a repo is tested, not what kind of repo it is. */
const TEST_FILE =
  /(^|\/)(test|tests|__tests__|src\/test)\/|\.(spec|test)\.[jt]sx?$|Tests?\.(java|kt|cs)$/;

async function draftMarkers(files: RepoFiles): Promise<FingerprintSignal[]> {
  const out: FingerprintSignal[] = [];
  const source = async (globs: readonly string[]) =>
    (await files.matching(globs)).filter((f) => !TEST_FILE.test(f)).slice(0, MAX_FILES_PER_SIGNAL);
  const marker = (pattern: string, globs: string[]): FingerprintSignal => ({
    kind: "marker",
    pattern,
    in: globs,
    weight: 2,
    required: false,
  });
  // Class-level annotations (Java, Kotlin) and attributes (C#): the framework's marks.
  for (const [globs, re] of [
    [["**/*.java"], /^\s*@([A-Z][A-Za-z0-9_]*)/],
    [["**/*.kt"], /^\s*@([A-Z][A-Za-z0-9_]*)/],
    [["**/*.cs"], /^\s*\[([A-Z][A-Za-z0-9_]*)[(\]]/],
  ] as const) {
    const counts = new Map<string, number>();
    for (const f of await source(globs)) {
      const lines = (await files.linesOf(f)) ?? [];
      const seen = new Set<string>();
      lines.forEach((l, i) => {
        const m = re.exec(l);
        if (!m || PLAIN_ANNOTATIONS.has(m[1]!)) return;
        const next = lines.slice(i + 1, i + 20).find((x) => x.trim() !== "" && !re.test(x)) ?? "";
        if (/\b(class|interface|record|enum|object)\b/.test(next)) seen.add(m[1]!);
      });
      for (const s of seen) counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    for (const name of top(counts, 3))
      out.push(marker(globs[0] === "**/*.cs" ? `\\[${name}\\b` : `@${name}\\b`, [...globs]));
  }
  // Packages imported from in TypeScript and JavaScript.
  const js = ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"];
  const counts = new Map<string, number>();
  for (const f of await source(js)) {
    if (f.endsWith(".d.ts")) continue;
    const seen = new Set<string>();
    for (const l of (await files.linesOf(f)) ?? []) {
      const m = /\bfrom\s+["']([^"'./][^"']*)["']/.exec(l);
      if (!m) continue;
      const parts = m[1]!.split("/");
      const pkg = m[1]!.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
      if (!pkg.startsWith("node:")) seen.add(pkg);
    }
    for (const s of seen) counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  for (const pkg of top(counts, 3)) out.push(marker(`from ["']${escapeRe(pkg)}(/[^"']*)?["']`, js));
  return out;
}

const LAYOUTS = [
  "src/main/java/**",
  "src/main/kotlin/**",
  "src/main/resources/**",
  "src/app/**",
  "app/**",
  "src/**",
  "lib/**",
  "cmd/**",
  "internal/**",
  "public/**",
];

/**
 * Draft a repo type from one repo, for a person to edit: its build files, the dependencies
 * they declare, the framework markers its code carries and its folder layout as the
 * fingerprint, and the prefix rules of the conventions it shows (PREFIX_CONVENTIONS). Undefined
 * when the repo shows nothing to fingerprint.
 */
export async function draftRepoType(repo: RepoHandle, id: string): Promise<RepoType | undefined> {
  const files = new RepoFiles(repo);
  const all = await files.all();
  const fingerprint: FingerprintSignal[] = [];

  const builds = all.filter((f) => BUILD_FILES.some((b) => b.re.test(f))).slice(0, 20);
  const buildGlobs: string[] = [];
  for (const b of BUILD_FILES) {
    const hits = builds.filter((f) => b.re.test(f));
    if (hits.length === 0) continue;
    buildGlobs.push(hits.some((f) => !f.includes("/")) ? b.glob : `**/${b.glob}`);
  }
  if (buildGlobs.length)
    fingerprint.push({ kind: "build-file", globs: buildGlobs, weight: 2, required: true });

  const deps = new Map<string, Set<string>>();
  for (const f of builds) {
    const text = ((await files.linesOf(f)) ?? []).join("\n");
    const glob = buildGlobs.find((g) => globToRegExp(g).test(f));
    for (const d of declaredDependencies(f, text)) {
      if (!PACKAGE_NAME.test(d) || d === repo.name) continue;
      if (!deps.has(d)) deps.set(d, new Set());
      if (glob) deps.get(d)!.add(glob);
    }
  }
  for (const [name, globs] of [...deps].slice(0, 6))
    fingerprint.push({
      kind: "dependency",
      names: [name],
      in: globs.size ? [...globs] : [...buildGlobs],
      weight: 2,
      required: false,
    });

  fingerprint.push(...(await draftMarkers(files)));

  const layouts: string[] = [];
  for (const g of LAYOUTS) {
    if (layouts.length >= 3) break;
    if (g === "src/**" && layouts.some((l) => l.startsWith("src/"))) continue;
    if ((await files.matching([g])).length) layouts.push(g);
  }
  for (const g of layouts)
    fingerprint.push({ kind: "layout", globs: [g], weight: 1, required: false });

  if (fingerprint.length === 0) return undefined;

  // Prefix rules from the conventions the extractors know (ADR 0035 keeps them out of here).
  const prefixes: PrefixRule[] = [];
  for (const c of PREFIX_CONVENTIONS) {
    const seen = c.lineIncludes
      ? (await files.lineHits(c.files, (l) => l.includes(c.lineIncludes!), 1)).length > 0
      : (await files.matching(c.files)).length > 0;
    if (!seen) continue;
    const src = c.paths.filter((g) => layouts.includes(g));
    prefixes.push({
      ...(c.rule.key ? { key: c.rule.key } : {}),
      ...(c.rule.pattern ? { pattern: c.rule.pattern } : {}),
      files: c.files,
      paths: src.length ? src : ["**"],
      why: c.rule.why,
    } as PrefixRule);
  }

  return {
    schemaVersion: REPO_TYPE_SCHEMA_VERSION,
    id,
    name: id,
    description: `Drafted from ${repo.name} by atticus repo-type new. Say what kind of repo this is, and keep only the signals every repo of the kind has.`,
    fingerprint,
    settings: { exclude: [], prefixes },
    skills: [],
  };
}
