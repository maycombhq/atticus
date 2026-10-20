import type { FrameworkModel } from "@maycombhq/core";
import {
  importsInText,
  isWellKnownModule,
  LANG_OF,
  SOURCE_GLOBS,
  SOURCE_SKIP,
  SourceFile,
  type SurveyLang,
} from "@maycombhq/extractors";
import { createParseCache, type ParseCache, type RepoHandle } from "@maycombhq/sdk";

/**
 * A deterministic survey of how an estate's repos use house frameworks, in any language, for
 * an assistant drafting framework models (ADR 0055): which house modules they import, which
 * of those a model already covers, and how the imported names are called or annotated, with
 * a sample line each. Nothing here guesses what a call means; that is the assistant's job,
 * checked by the model's own tests.
 */

export type { SurveyLang };

export interface SurveyUse {
  /** `useApi(...)`, `lantern.call(...)`, `@InternalApi`, `BankHttp.exchange(...)`. */
  use: string;
  count: number;
  repos: string[];
  sample: { repo: string; path: string; line: number; text: string };
}

export interface ModuleSurvey {
  module: string;
  language: SurveyLang;
  repos: string[];
  files: number;
  /** The model whose packages cover this module, if one does. */
  modelled?: string;
  /** Names imported from it. */
  names: string[];
  uses: SurveyUse[];
}

export interface FrameworkSurvey {
  repos: string[];
  /** House modules, most used first. */
  modules: ModuleSurvey[];
}

const isHouse = (mod: string, prefixes: string[]) =>
  prefixes.length > 0
    ? prefixes.some((p) => mod === p || mod.startsWith(p))
    : !isWellKnownModule(mod);

const shown = (line: string) => {
  const t = line.trim();
  return t.length > 160 ? `${t.slice(0, 157)}...` : t;
};

/** How a file uses the names it imports from one module. */
async function usesIn(
  text: string,
  path: string,
  lang: SurveyLang,
  names: string[],
  cache?: ParseCache,
): Promise<{ use: string; line: number }[]> {
  const out: { use: string; line: number }[] = [];
  if (lang === "java") {
    // Comments are blanked, keeping lines, so a name in a comment isn't a use.
    text = text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (c) => c.replace(/[^\n]/g, " "));
    const set = new Set(names);
    for (const m of text.matchAll(/@([A-Z]\w*)/g))
      if (set.has(m[1]!)) out.push({ use: `@${m[1]!}`, line: lineAt(text, m.index) });
    // Fields and locals of an imported type, then calls on them.
    const vars = new Map<string, string>();
    for (const m of text.matchAll(/\b([A-Z]\w*)(?:<[^>]*>)?\s+([a-z]\w*)\s*[;=,)]/g))
      if (set.has(m[1]!)) vars.set(m[2]!, m[1]!);
    for (const m of text.matchAll(/\b([a-z]\w*)\.([a-z]\w*)\s*\(/g)) {
      const t = vars.get(m[1]!);
      if (t) out.push({ use: `${t}.${m[2]!}(...)`, line: lineAt(text, m.index) });
    }
    for (const m of text.matchAll(/\b([A-Z]\w*)\.([a-z]\w*)\s*\(/g))
      if (set.has(m[1]!)) out.push({ use: `${m[1]!}.${m[2]!}(...)`, line: lineAt(text, m.index) });
    return out;
  }
  let src: SourceFile;
  try {
    src = await SourceFile.parse(path, text, lang, cache);
  } catch {
    return out;
  }
  const set = new Set(names);
  for (const c of src.calls) {
    if (c.isNew || c.decorator) continue;
    const head = c.callee.split(".")[0]!;
    // C# imports a namespace, not names: keep the calls that pass a string.
    const csharp = lang === "csharp" && c.args.some((a) => src.toks[a.from]?.t === "str");
    if (set.has(head) || set.has(c.name) || csharp)
      out.push({ use: `${c.callee}(...)`, line: c.line });
  }
  for (const c of src.calls)
    if (c.decorator && (set.has(c.callee.split(".")[0]!) || set.has(c.name)))
      out.push({ use: `@${c.callee}(...)`, line: c.line });
  return out;
}

function lineAt(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/**
 * Survey repos for house framework use. `prefixes` names the house's own modules (`@tide/`,
 * `tide.`, `Tide.`); without them every import that isn't relative or well known counts.
 */
export async function surveyFrameworks(
  repos: RepoHandle[],
  o: { prefixes?: string[]; models?: FrameworkModel[]; top?: number } = {},
): Promise<FrameworkSurvey> {
  const prefixes = o.prefixes ?? [];
  const models = o.models ?? [];
  const mods = new Map<
    string,
    {
      language: SurveyLang;
      repos: Set<string>;
      files: number;
      names: Set<string>;
      uses: Map<string, { count: number; repos: Set<string>; sample: SurveyUse["sample"] }>;
    }
  >();
  for (const repo of repos) {
    // A file importing several house modules is parsed once (ADR 0067); freed after each repo.
    const own = repo.parseCache ? undefined : createParseCache();
    const cache = repo.parseCache ?? own;
    try {
      for await (const path of repo.listFiles(SOURCE_GLOBS)) {
        if (SOURCE_SKIP.test(path)) continue;
        const lang = LANG_OF.find(([re]) => re.test(path))?.[1];
        if (!lang) continue;
        const text = await repo.readText(path);
        const lines = text.split(/\r?\n/);
        for (const imp of importsInText(text, lang)) {
          if (!isHouse(imp.module, prefixes)) continue;
          const key = `${lang}\u0000${imp.module}`;
          const m = mods.get(key) ?? {
            language: lang,
            repos: new Set<string>(),
            files: 0,
            names: new Set<string>(),
            uses: new Map(),
          };
          m.repos.add(repo.name);
          m.files++;
          for (const n of imp.names) m.names.add(n);
          for (const u of await usesIn(text, path, lang, imp.names, cache)) {
            const e = m.uses.get(u.use) ?? {
              count: 0,
              repos: new Set<string>(),
              sample: { repo: repo.name, path, line: u.line, text: shown(lines[u.line - 1] ?? "") },
            };
            e.count++;
            e.repos.add(repo.name);
            m.uses.set(u.use, e);
          }
          mods.set(key, m);
        }
      }
    } finally {
      own?.dispose();
    }
  }
  const modelOf = (mod: string) =>
    models.find((m) =>
      m.packages.some((p) => mod === p || mod.startsWith(`${p}.`) || mod.startsWith(`${p}/`)),
    )?.name;
  const modules: ModuleSurvey[] = [...mods].map(([key, m]) => {
    const module = key.split("\u0000")[1]!;
    const modelled = modelOf(module);
    return {
      module,
      language: m.language,
      repos: [...m.repos].sort(),
      files: m.files,
      ...(modelled ? { modelled } : {}),
      names: [...m.names].sort(),
      uses: [...m.uses]
        .map(([use, e]) => ({ use, count: e.count, repos: [...e.repos].sort(), sample: e.sample }))
        .sort((a, b) => b.count - a.count || (a.use < b.use ? -1 : 1))
        .slice(0, 20),
    };
  });
  modules.sort(
    (a, b) =>
      b.repos.length - a.repos.length ||
      b.files - a.files ||
      (a.module < b.module ? -1 : a.module > b.module ? 1 : 0),
  );
  return {
    repos: repos.map((r) => r.name).sort(),
    modules: modules.slice(0, o.top ?? 25),
  };
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The survey as text for a person or an assistant. */
export function formatFrameworkSurvey(s: FrameworkSurvey): string[] {
  const out: string[] = [];
  if (s.modules.length === 0) {
    out.push(
      `No house modules are imported in ${plural(s.repos.length, "repo")}. Give your house prefixes with --package (for example @tide/,tide.).`,
    );
    return out;
  }
  for (const m of s.modules) {
    out.push(
      `${m.module} (${m.language}): ${plural(m.files, "file")} in ${plural(m.repos.length, "repo")}${m.modelled ? `, modelled by ${m.modelled}` : ", not modelled"}`,
    );
    if (m.names.length) out.push(`  imports: ${m.names.join(", ")}`);
    for (const u of m.uses)
      out.push(
        `  ${u.use} x${u.count} in ${plural(u.repos.length, "repo")}, e.g. ${u.sample.repo}/${u.sample.path}:${u.sample.line}: ${u.sample.text}`,
      );
  }
  return out;
}
