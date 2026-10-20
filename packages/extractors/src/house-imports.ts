import type { FrameworkModel } from "@maycombhq/core";
import type { RepoHandle } from "@maycombhq/sdk";
import type { SourceLang } from "./lang/source-tree.js";

/**
 * What a repo imports and what it declares itself, by language, for telling which house
 * frameworks an estate builds on (ADR 0055, 0066). Files only, deterministic: the import lines
 * of each source file, the packages and namespaces its own code declares, and its package.json
 * names. Used by `atticus frameworks survey` and by the scan, which names house frameworks no
 * model covers. Nothing here says what a framework means.
 */

export type SurveyLang = SourceLang | "java";

export const LANG_OF: readonly [RegExp, SurveyLang][] = [
  [/\.(m?[jt]sx?|cjs|cts|mts)$/i, "js"],
  [/\.cs$/i, "csharp"],
  [/\.py$/i, "python"],
  [/\.go$/i, "go"],
  [/\.(java|kt)$/i, "java"],
];

/** Generated, vendored and test files: not what a repo's own code imports. */
export const SOURCE_SKIP =
  /(^|\/)(node_modules|dist|build|coverage|target|bin|obj|vendor|\.venv|\.git)\/|\.(test|spec|d)\.[jt]sx?$|(^|\/)src\/test\//;

export const SOURCE_GLOBS: readonly string[] = [
  "js",
  "jsx",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "mts",
  "cts",
  "cs",
  "py",
  "go",
  "java",
  "kt",
].map((e) => `**/*.${e}`);

/** Modules every estate imports that are never a house framework. */
const KNOWN =
  /^(node:|react($|[-/])|react-dom|next($|\/)|vue|@angular\/|express$|axios$|lodash|rxjs|zod$|vitest|jest|@testing-library\/|java\.|javax\.|jakarta\.|kotlin\.|kotlinx\.|org\.springframework|org\.junit|org\.slf4j|lombok|com\.fasterxml|System($|\.)|Microsoft\.|typing$|os$|sys$|json$|re$|datetime$|logging$|requests$|flask$|fastapi$|django|pydantic|fmt$|net\/|encoding\/|context$|errors$|strings$|time$|os$|github\.com\/stretchr)/;
const BUILTIN_JS = new Set([
  "fs",
  "path",
  "os",
  "url",
  "http",
  "https",
  "crypto",
  "util",
  "events",
  "stream",
  "child_process",
  "assert",
]);

/** A module no estate owns: relative, a runtime built-in or a well-known library. */
export const isWellKnownModule = (mod: string) =>
  mod.startsWith(".") || mod.startsWith("/") || BUILTIN_JS.has(mod) || KNOWN.test(mod);

export interface ImportLine {
  module: string;
  names: string[];
}

/** What a file imports, by language: each module and the names taken from it. */
export function importsInText(text: string, lang: SurveyLang): ImportLine[] {
  const out: ImportLine[] = [];
  const names = (s: string) =>
    s
      .split(",")
      .map((n) =>
        n
          .trim()
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/)
          .pop()!
          .trim(),
      )
      .filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));
  if (lang === "js") {
    for (const m of text.matchAll(/\bimport\s+([^;]*?)\s+from\s+["']([^"']+)["']/g)) {
      const clause = m[1]!;
      const n: string[] = [];
      const braces = /\{([^}]*)\}/.exec(clause);
      if (braces) n.push(...names(braces[1]!));
      const star = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause);
      if (star) n.push(star[1]!);
      const def = /^\s*([A-Za-z_$][\w$]*)\s*(,|$)/.exec(clause);
      if (def && def[1] !== "type") n.push(def[1]!);
      out.push({ module: m[2]!, names: n });
    }
    for (const m of text.matchAll(
      /\b(?:const|let|var)\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*require\(\s*["']([^"']+)["']\s*\)/g,
    ))
      out.push({
        module: m[2]!,
        names: m[1]!.startsWith("{") ? names(m[1]!.slice(1, -1).replace(/:\s*/g, " as ")) : [m[1]!],
      });
  } else if (lang === "python") {
    for (const m of text.matchAll(/^\s*from\s+([\w.]+)\s+import\s+\(?([^)\n]*)\)?/gm))
      out.push({ module: m[1]!, names: names(m[2]!) });
    for (const m of text.matchAll(/^\s*import\s+([\w.]+)(?:\s+as\s+(\w+))?/gm))
      out.push({ module: m[1]!, names: [m[2] ?? m[1]!.split(".").pop()!] });
  } else if (lang === "csharp") {
    for (const m of text.matchAll(/^\s*using\s+(?:static\s+)?([\w.]+)\s*;/gm))
      out.push({ module: m[1]!, names: [] });
  } else if (lang === "go") {
    const block = /\bimport\s*\(([^)]*)\)/.exec(text)?.[1] ?? "";
    const single = [...text.matchAll(/\bimport\s+(\w+\s+)?"([^"]+)"/g)].map(
      (m) => `${m[1] ?? ""}"${m[2]!}"`,
    );
    for (const line of [...block.split("\n"), ...single]) {
      const m = /^\s*(\w+)?\s*"([^"]+)"/.exec(line);
      if (m) out.push({ module: m[2]!, names: [m[1] ?? m[2]!.split("/").pop()!] });
    }
  } else {
    for (const m of text.matchAll(/^\s*import\s+(?!static\b)([\w.]+)\.([A-Z]\w*)\s*;?\s*$/gm))
      out.push({ module: m[1]!, names: [m[2]!] });
  }
  return out;
}

/** What one repo imports (module to language) and the packages and namespaces it declares. */
export interface RepoImports {
  repo: string;
  modules: Map<string, SurveyLang>;
  /** Its own Java/Kotlin packages, C# namespaces and package.json names. */
  declared: Set<string>;
}

/** Read a repo's imports and declarations. Files only. */
export async function repoImports(repo: RepoHandle): Promise<RepoImports> {
  const modules = new Map<string, SurveyLang>();
  const declared = new Set<string>();
  for await (const path of repo.listFiles([...SOURCE_GLOBS, "**/package.json"])) {
    if (SOURCE_SKIP.test(path)) continue;
    const text = await repo.readText(path);
    if (path.endsWith("package.json")) {
      try {
        const name = (JSON.parse(text) as { name?: unknown }).name;
        if (typeof name === "string" && name) declared.add(name);
      } catch {
        // a package.json that doesn't parse declares nothing
      }
      continue;
    }
    const lang = LANG_OF.find(([re]) => re.test(path))?.[1];
    if (!lang) continue;
    if (lang === "java") {
      const pkg = /^\s*package\s+([\w.]+)\s*;?\s*$/m.exec(text)?.[1];
      if (pkg) declared.add(pkg);
    } else if (lang === "csharp") {
      for (const m of text.matchAll(/^\s*namespace\s+([\w.]+)/gm)) declared.add(m[1]!);
    }
    for (const imp of importsInText(text, lang))
      if (!isWellKnownModule(imp.module) && !modules.has(imp.module)) modules.set(imp.module, lang);
  }
  return { repo: repo.name, modules, declared };
}

/** Top-level names that are a country or a kind of organisation, not the organisation. */
const DOMAIN_ROOT = new Set([
  "com",
  "org",
  "net",
  "io",
  "co",
  "uk",
  "us",
  "de",
  "fr",
  "nl",
  "ch",
  "au",
  "ca",
  "gov",
  "edu",
]);

/** The organisation's part of a dotted name: tide in tide.cards, com.tidewater in com.tidewater.cards. */
const orgRoot = (name: string) => {
  const parts = name.split(".");
  return DOMAIN_ROOT.has(parts[0]!.toLowerCase()) && parts.length > 1
    ? `${parts[0]}.${parts[1]}`
    : parts[0]!;
};

/** A framework's name from its module: tide.platform → tide-platform, @tide/lantern → tide-lantern. */
export const frameworkNameOf = (module: string) =>
  module
    .replace(/^@/, "")
    .replace(/[./]+/g, "-")
    .replace(/[^A-Za-z0-9-]+/g, "-")
    .toLowerCase();

/** Whether a model's packages cover a module. */
export const modelCovers = (m: Pick<FrameworkModel, "packages">, module: string) =>
  m.packages.some(
    (p) =>
      module === p ||
      module.startsWith(`${p}.`) ||
      module.startsWith(`${p}/`) ||
      (p.endsWith("/") && module.startsWith(p)),
  );

/** A house framework the estate imports that no model covers. */
export interface UnmodelledFramework {
  /** The framework, as a module prefix: tide.platform, @tide/lantern. */
  framework: string;
  /** A name for its model: tide-platform. */
  name: string;
  language: SurveyLang;
  /** Repos that import it and don't declare it themselves. */
  repos: string[];
  /** Its modules they import. */
  modules: string[];
}

/**
 * House frameworks the estate builds on with no model (ADR 0066): a module in the
 * organisation's own namespace (the roots of the packages, namespaces and npm scopes its repos
 * declare) that at least `minRepos` repos import without declaring it, grouped by framework
 * (the namespace root and the next part, tide.platform; an npm package, @tide/lantern), that
 * no model's packages cover. Most used first.
 */
export function unmodelledFrameworks(
  repos: readonly RepoImports[],
  models: readonly Pick<FrameworkModel, "packages">[],
  o: { minRepos?: number } = {},
): UnmodelledFramework[] {
  const roots = new Set<string>();
  for (const r of repos)
    for (const d of r.declared) {
      if (d.startsWith("@")) roots.add(d.split("/")[0]!);
      else if (d.includes(".")) roots.add(orgRoot(d));
    }
  const groups = new Map<
    string,
    { language: SurveyLang; repos: Set<string>; modules: Set<string> }
  >();
  for (const r of repos)
    for (const [mod, language] of r.modules) {
      let key: string | undefined;
      if (mod.startsWith("@")) {
        const [scope, pkg] = mod.split("/");
        if (roots.has(scope!) && pkg) key = `${scope}/${pkg}`;
      } else if (language === "java" || language === "csharp" || language === "python") {
        const root = orgRoot(mod);
        const rest = mod.slice(root.length + 1).split(".")[0];
        if (roots.has(root) && rest) key = `${root}.${rest}`;
      }
      if (!key) continue;
      // The repo's own code isn't a framework it builds on.
      if ([...r.declared].some((d) => d === key || d.startsWith(`${key}.`) || d === mod)) continue;
      if (models.some((m) => modelCovers(m, mod) || modelCovers(m, key))) continue;
      const g = groups.get(key) ?? { language, repos: new Set(), modules: new Set() };
      g.repos.add(r.repo);
      g.modules.add(mod);
      groups.set(key, g);
    }
  return [...groups]
    .filter(([, g]) => g.repos.size >= (o.minRepos ?? 2))
    .map(([framework, g]) => ({
      framework,
      name: frameworkNameOf(framework),
      language: g.language,
      repos: [...g.repos].sort(),
      modules: [...g.modules].sort(),
    }))
    .sort(
      (a, b) =>
        b.repos.length - a.repos.length ||
        (a.framework < b.framework ? -1 : a.framework > b.framework ? 1 : 0),
    );
}
