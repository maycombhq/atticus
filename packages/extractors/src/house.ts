import type { CatalogRecord } from "@maycombhq/core";
import { defineExtractor, type RepoHandle } from "@maycombhq/sdk";
import { Evaluator, SourceFile, type Arg, type SrcCall } from "./backends/shared.js";
import { componentOf, looseEnd, restEndpoint } from "./facts.js";
import type { SourceLang } from "./lang/lexer.js";
import { modelValues } from "./frameworks.js";

/**
 * House frameworks in any language (ADR 0055): a framework model's `calls` and `routes`
 * applied to JavaScript and TypeScript (JSX and TSX too), C#, Python and Go, through the call
 * layer the backend extractors share. Only files that import one of a model's packages are
 * read; arguments are evaluated as the backends do, names are filled from the repo's own
 * constants and the model's, and what can't be known is shown as ${name}. Java and Kotlin
 * are the Spring extractor's (annotations and clients).
 */

const LANG_OF: [RegExp, SourceLang][] = [
  [/\.(m?[jt]sx?|cjs|cts|mts)$/i, "js"],
  [/\.cs$/i, "csharp"],
  [/\.py$/i, "python"],
  [/\.go$/i, "go"],
];
const SKIP =
  /(^|\/)(node_modules|dist|build|coverage|__tests__|bin|obj|vendor|\.venv)\/|\.(test|spec|d)\.[jt]sx?$/;

/** The language of a source file, by its name. */
const langOf = (path: string) => LANG_OF.find(([re]) => re.test(path))?.[1];

/** Does the file import (use, require) this module? */
function imports(text: string, mod: string): boolean {
  const m = mod.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(from\\s+["']${m}(?:/[^"']*)?["']|require\\(\\s*["']${m}(?:/[^"']*)?["']\\)|^\\s*(?:import|using|from)\\s+${m}\\b|"${m}(?:/[^"]*)?")`,
    "m",
  ).test(text);
}

/**
 * String constants a repo's JS/TS code exports, as NAME and Object.KEY → value:
 * `export const PAY = "/v2"`, `export const Services = { BFF: "web-bff" }`. A name defined twice
 * with different values is left out.
 */
async function jsConstants(repo: RepoHandle, files: string[]): Promise<Map<string, string>> {
  const seen = new Map<string, string | null>();
  const put = (k: string, v: string) => {
    const prev = seen.get(k);
    seen.set(k, prev === undefined || prev === v ? v : null);
  };
  for (const path of files) {
    if (langOf(path) !== "js") continue;
    const text = await repo.readText(path);
    for (const m of text.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*["'`]([^"'`$]*)["'`]/g))
      put(m[1]!, m[2]!);
    for (const m of text.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*\{([^{}]*)\}/g))
      for (const f of m[2]!.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*["'`]([^"'`$]*)["'`]/g))
        put(`${m[1]!}.${f[1]!}`, f[2]!);
  }
  return new Map([...seen].filter((e): e is [string, string] => e[1] !== null));
}

/** Express-style `:id` and `{id}` both read as {id}. */
const pathParams = (p: string) => p.replace(/:([A-Za-z_]\w*)/g, "{$1}");

export const houseExtractor = defineExtractor({
  id: "house-frameworks",
  version: "1.0.0",
  claims: [
    "**/*.js",
    "**/*.jsx",
    "**/*.mjs",
    "**/*.cjs",
    "**/*.ts",
    "**/*.tsx",
    "**/*.mts",
    "**/*.cts",
    "**/*.cs",
    "**/*.py",
    "**/*.go",
  ],
  async *scan(repo, ctx) {
    const models = (ctx.frameworks ?? []).filter((m) => m.calls.length + m.routes.length > 0);
    if (models.length === 0) return;
    const component = componentOf(repo, ctx);
    const files: string[] = [];
    for await (const p of repo.listFiles(this.claims)) if (!SKIP.test(p)) files.push(p);
    const repoConstants = await jsConstants(repo, files);
    const values = modelValues(models);
    const known = (name: string) => repoConstants.get(name) ?? values.get(name)?.value;

    for (const path of files) {
      const lang = langOf(path)!;
      const text = await repo.readText(path);
      const used = models.filter((m) => m.packages.some((p) => imports(text, p)));
      if (used.length === 0) continue;
      const src = new SourceFile(path, text, lang);
      const ev = new Evaluator(src, { name: (dotted) => known(dotted) });
      /** One part of a call: its argument (or a property of it) evaluated, or a fixed value. */
      const part = (
        c: SrcCall,
        p: { arg: number; key?: string } | { value: string } | undefined,
      ) => {
        if (!p) return undefined;
        if ("value" in p) return p.value;
        let a: Arg | undefined = src.arg(c, p.arg);
        if (a && p.key) a = src.is(a.from, "{") ? src.field(a.from, p.key) : undefined;
        if (!a) return undefined;
        const v = ev.arg(a);
        if (v !== undefined) return v;
        const name = src.dotted(a.from, a.to);
        return name ? (known(name) ?? `\${${name}}`) : undefined;
      };
      const matches = (
        c: SrcCall,
        e: { function: string; receiver?: string; language?: string; from?: string },
      ) =>
        c.name === e.function &&
        (!e.language || e.language === lang) &&
        (!e.receiver || c.recv === e.receiver || c.recv.endsWith(`.${e.receiver}`)) &&
        (!e.from || imports(text, e.from));
      const out: CatalogRecord[] = [];
      for (const m of used) {
        for (const r of m.routes)
          for (const c of src.calls.filter((x) => matches(x, r))) {
            const method = (part(c, r.httpMethod) ?? "ANY").toUpperCase();
            const p = part(c, r.path);
            if (!p) continue;
            const verified = r.source.kind === "code" || r.source.kind === "bytecode";
            out.push(
              restEndpoint(
                repo,
                component,
                method,
                pathParams(p),
                { source: "code", path, line: c.line, side: "callee" },
                verified ? {} : { confidence: "inferred" },
              ),
            );
          }
        for (const k of m.calls)
          for (const c of src.calls.filter((x) => matches(x, k))) {
            const p = part(c, k.path);
            if (!p) continue;
            let target = p;
            if (k.service) {
              const id = part(c, k.service) ?? "";
              const base =
                values.get(id)?.value ??
                (/^https?:\/\//.test(id) ? id : `\${${id.replace(/^\$\{(.*)\}$/, "$1")}}`);
              target = `${base.replace(/\/$/, "")}/${p.replace(/^\//, "")}`;
            }
            const raw =
              k.kind === "http-call"
                ? `${(part(c, k.httpMethod) ?? "ANY").toUpperCase()} ${pathParams(target)}`
                : target;
            out.push(
              looseEnd(repo, ctx, k.kind, raw, {
                source: "code",
                path,
                line: c.line,
                side:
                  k.kind === "event-subscribe" || k.kind === "mq-subscribe" ? "callee" : "caller",
              }),
            );
          }
      }
      if (out.length === 0)
        ctx.warn(
          `uses ${used.map((m) => m.name).join(", ")} but no call to it was read here`,
          path,
        );
      yield* out;
    }
  },
});
