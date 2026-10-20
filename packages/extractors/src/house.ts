import type { CatalogRecord } from "@maycombhq/core";
import { defineExtractor } from "@maycombhq/sdk";
import { Evaluator, SourceFile, type Arg, type SrcCall } from "./backends/shared.js";
import { componentOf, looseEnd, restEndpoint } from "./facts.js";
import type { SourceLang } from "./lang/source-tree.js";
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

/**
 * String constants a repo's JS/TS code declares, as NAME and Object.KEY → value:
 * `export const PAY = "/v2"`, `export const Services = { BFF: "web-bff" }`. A name defined twice
 * with different values is left out.
 */
class JsConstants {
  private readonly seen = new Map<string, string | null>();
  get(name: string): string | undefined {
    return this.seen.get(name) ?? undefined;
  }
  private put(k: string, v: string) {
    const prev = this.seen.get(k);
    this.seen.set(k, prev === undefined || prev === v ? v : null);
  }
  add(src: SourceFile) {
    if (src.lang !== "js") return;
    for (const [name, list] of src.assigns)
      for (const a of list) {
        if (!src.is(a.at - 1, "const", "id")) continue;
        // `as const` (or any `as T`) doesn't change the value.
        const to = src.is(a.to - 2, "as", "id") ? a.to - 2 : a.to;
        const v = literal(src, a.from, to);
        if (v !== undefined) this.put(name, v);
        else if (src.is(a.from, "{") && src.pairs[a.from] === to - 1)
          // Each `KEY: "value"` directly inside the object.
          for (let k = a.from + 1; k < to - 1; k++) {
            const key = src.tok(k)!;
            if (src.is(k, "{") || src.is(k, "[") || src.is(k, "(")) k = src.pairs[k]!;
            else if (
              key.t === "id" &&
              src.is(k + 1, ":") &&
              (src.is(k - 1, "{") || src.is(k - 1, ",")) &&
              (src.is(k + 3, ",") || k + 3 === to - 1)
            ) {
              const fv = literal(src, k + 2, k + 3);
              if (fv !== undefined) this.put(`${name}.${key.v}`, fv);
            }
          }
      }
  }
}

/** A plain string literal (no interpolation) filling exactly [from, to). */
function literal(src: SourceFile, from: number, to: number): string | undefined {
  const t = src.tok(from);
  return to === from + 1 && t?.t === "str" && !t.interp && !t.v.includes("$") ? t.v : undefined;
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
    const files: string[] = [];
    for await (const p of repo.listFiles(this.claims)) if (!SKIP.test(p)) files.push(p);
    // Every file gives its constants; only files importing a model's package are kept.
    const repoConstants = new JsConstants();
    const users = new Map<string, SourceFile>();
    for (const path of files) {
      const src = await SourceFile.parse(path, await repo.readText(path), langOf(path)!);
      repoConstants.add(src);
      if (models.some((m) => m.packages.some((p) => src.imported(p)))) users.set(path, src);
    }
    const values = modelValues(models);
    const known = (name: string) => repoConstants.get(name) ?? values.get(name)?.value;

    for (const [path, src] of users) {
      const lang = langOf(path)!;
      const used = models.filter((m) => m.packages.some((p) => src.imported(p)));
      if (used.length === 0) continue;
      const component = componentOf(repo, ctx, path);
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
        (!e.from || src.imported(e.from));
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
