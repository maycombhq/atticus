import { dirname, posix } from "node:path";
import type { RepoHandle } from "@maycombhq/sdk";
import type Parser from "web-tree-sitter";
import { grammarOf } from "../lang/source-tree.js";
import { useSyntaxTree } from "../lang/syntax.js";

/**
 * HTTP helpers a JavaScript or TypeScript repo writes for itself (ADR 0069): a function whose
 * parameter flows into the URL of `fetch`, `axios.<verb>` or `http.<verb>`, directly or through
 * another such helper, is a wrapper; a call to it whose arguments make the URL whole is a
 * request, read from code. `post(path)` → `http(\`/api/${path}\`, { method: "POST" })` →
 * `fetch(BASE + path, init)` makes `post("reports")` a `POST /api/reports`. A leading base
 * the build sets (`BASE`, `import.meta.env.X`) is dropped when the rest is a path. Helpers are
 * followed across files through relative imports. Calls straight to fetch and axios with a
 * written URL are the frontend reader's own; this reads only calls through helpers.
 */

type Expr =
  | { k: "str"; v: string }
  | { k: "tpl"; parts: (string | Expr)[] }
  | { k: "cat"; l: Expr; r: Expr }
  | { k: "id"; name: string }
  | { k: "obj"; fields: Record<string, Expr> }
  | { k: "other" };

type Callee = { k: "id"; name: string } | { k: "member"; obj: string; prop: string };

interface CallFact {
  callee: Callee;
  args: Expr[];
  line: number;
  /** The named function the call is in, or -1 at the top level. */
  fn: number;
}

interface FileFacts {
  path: string;
  functions: { name: string; params: string[] }[];
  calls: CallFact[];
  /** Local name → the file and name it is imported from (`*` for a namespace import). */
  imports: Map<string, { spec: string; name: string }>;
  /** Top-level constants with a written string value. */
  consts: Map<string, string>;
}

// ------------------------------------------------------------------ reading a tree

const FUNCTION_VALUES = new Set(["arrow_function", "function_expression", "function"]);

function exprOf(n: Parser.SyntaxNode | null | undefined): Expr {
  if (!n) return { k: "other" };
  switch (n.type) {
    case "string":
      return { k: "str", v: n.text.slice(1, -1) };
    case "template_string": {
      const parts: (string | Expr)[] = [];
      let at = n.startIndex + 1;
      for (const s of n.namedChildren) {
        if (s.type !== "template_substitution") continue;
        parts.push(n.text.slice(at - n.startIndex, s.startIndex - n.startIndex));
        parts.push(exprOf(s.namedChildren[0]));
        at = s.endIndex;
      }
      parts.push(n.text.slice(at - n.startIndex, n.text.length - 1));
      return { k: "tpl", parts };
    }
    case "binary_expression": {
      const op = n.childForFieldName("operator")?.text;
      if (op !== "+") return { k: "other" };
      return {
        k: "cat",
        l: exprOf(n.childForFieldName("left")),
        r: exprOf(n.childForFieldName("right")),
      };
    }
    case "parenthesized_expression":
    case "await_expression":
    case "as_expression":
    case "non_null_expression":
      return exprOf(n.namedChildren[0]);
    case "identifier":
      return { k: "id", name: n.text };
    case "member_expression":
      return { k: "id", name: n.text.replace(/\?\./g, ".") };
    case "object": {
      const fields: Record<string, Expr> = {};
      for (const p of n.namedChildren) {
        if (p.type === "pair") {
          const key = p.childForFieldName("key");
          const name = key?.type === "string" ? key.text.slice(1, -1) : key?.text;
          if (name) fields[name] = exprOf(p.childForFieldName("value"));
        } else if (p.type === "shorthand_property_identifier")
          fields[p.text] = { k: "id", name: p.text };
      }
      return { k: "obj", fields };
    }
    default:
      return { k: "other" };
  }
}

function paramsOf(fn: Parser.SyntaxNode): string[] {
  const single = fn.childForFieldName("parameter");
  if (single) return [single.text];
  const list = fn.childForFieldName("parameters");
  if (!list) return [];
  return list.namedChildren.map((p) => {
    const id =
      p.type === "identifier"
        ? p
        : (p.childForFieldName("pattern") ?? p.childForFieldName("left") ?? p.namedChildren[0]);
    return id?.type === "identifier" ? id.text : "";
  });
}

function readFacts(root: Parser.SyntaxNode, path: string): FileFacts {
  const facts: FileFacts = {
    path,
    functions: [],
    calls: [],
    imports: new Map(),
    consts: new Map(),
  };
  for (const imp of root.descendantsOfType("import_statement")) {
    const src = imp.childForFieldName("source");
    if (!src) continue;
    const spec = src.text.slice(1, -1);
    for (const s of imp.descendantsOfType("import_specifier")) {
      const name = s.childForFieldName("name")?.text;
      const alias = s.childForFieldName("alias")?.text;
      if (name) facts.imports.set(alias ?? name, { spec, name });
    }
    for (const ns of imp.descendantsOfType("namespace_import")) {
      const id = ns.namedChildren.find((c) => c.type === "identifier");
      if (id) facts.imports.set(id.text, { spec, name: "*" });
    }
  }
  const walk = (n: Parser.SyntaxNode, fn: number) => {
    let here = fn;
    if (n.type === "function_declaration" || n.type === "generator_function_declaration") {
      const name = n.childForFieldName("name")?.text;
      if (name) {
        facts.functions.push({ name, params: paramsOf(n) });
        here = facts.functions.length - 1;
      }
    } else if (n.type === "variable_declarator") {
      const name = n.childForFieldName("name");
      const value = n.childForFieldName("value");
      if (name?.type === "identifier" && value && FUNCTION_VALUES.has(value.type)) {
        facts.functions.push({ name: name.text, params: paramsOf(value) });
        here = facts.functions.length - 1;
      } else if (name?.type === "identifier" && value && fn === -1) {
        const v = exprOf(value);
        if (v.k === "str") facts.consts.set(name.text, v.v);
        if (v.k === "tpl" && v.parts.length === 1)
          facts.consts.set(name.text, v.parts[0] as string);
      }
    } else if (n.type === "call_expression") {
      const f = n.childForFieldName("function");
      const args = n.childForFieldName("arguments");
      let callee: Callee | undefined;
      if (f?.type === "identifier") callee = { k: "id", name: f.text };
      else if (f?.type === "member_expression") {
        const prop = f.childForFieldName("property")?.text;
        const obj = f.childForFieldName("object")?.text.replace(/^this\./, "");
        if (prop && obj) callee = { k: "member", obj, prop };
      }
      if (callee && args?.type === "arguments")
        facts.calls.push({
          callee,
          args: args.namedChildren.map((a) => exprOf(a)),
          line: n.startPosition.row + 1,
          fn: here,
        });
    }
    for (const c of n.namedChildren) walk(c, here);
  };
  walk(root, -1);
  return facts;
}

// ------------------------------------------------------------------ URLs as parts

type Part = { t: "lit"; v: string } | { t: "param"; i: number } | { t: "var"; name: string };
type Method = { t: "lit"; v: string } | { t: "param"; i: number; key?: string };
interface Wrapper {
  url: Part[];
  method: Method;
  /** Where the helper makes its call, for a helper nothing in the repo calls. */
  at?: { path: string; line: number; params: string[]; written: boolean };
}

const VERBS = new Set(["get", "post", "put", "delete", "patch", "head"]);

/** An expression as URL parts, in terms of the enclosing function's parameters. */
function partsOf(e: Expr, params: string[], consts: Map<string, string>): Part[] {
  switch (e.k) {
    case "str":
      return [{ t: "lit", v: e.v }];
    case "tpl":
      return e.parts.flatMap((p) =>
        typeof p === "string"
          ? p
            ? [{ t: "lit" as const, v: p }]
            : []
          : partsOf(p, params, consts),
      );
    case "cat":
      return [...partsOf(e.l, params, consts), ...partsOf(e.r, params, consts)];
    case "id": {
      const i = params.indexOf(e.name);
      if (i >= 0) return [{ t: "param", i }];
      const c = consts.get(e.name);
      return c !== undefined ? [{ t: "lit", v: c }] : [{ t: "var", name: e.name }];
    }
    default:
      return [{ t: "var", name: "value" }];
  }
}

/** A method from an `init` object (`{ method: "POST" }`), or the parameter it comes from. */
function methodIn(e: Expr | undefined, params: string[]): Method | undefined {
  if (!e) return undefined;
  if (e.k === "obj") {
    const m = e.fields.method;
    if (!m) return undefined;
    if (m.k === "str") return { t: "lit", v: m.v.toUpperCase() };
    if (m.k === "id" && params.includes(m.name)) return { t: "param", i: params.indexOf(m.name) };
    return undefined;
  }
  if (e.k === "id" && params.includes(e.name))
    return { t: "param", i: params.indexOf(e.name), key: "method" };
  return undefined;
}

// ------------------------------------------------------------------ the pass

const JS_FILE = /\.(m?js|jsx|ts|tsx|vue)$/;
const SKIP = /(^|\/)(node_modules|dist|build|coverage|__tests__)\/|\.(test|spec|d)\.[jt]sx?$/;

export interface WrapperRequest {
  method: string;
  url: string;
  path: string;
  line: number;
}

/**
 * Every request a repo's JS and TS code makes through its own helpers. `scriptOf` turns a
 * file's text into the script to parse (a Vue SFC's `<script>`).
 */
export async function wrapperRequests(
  repo: RepoHandle,
  paths: readonly string[],
  scriptOf: (path: string, text: string) => string = (_p, t) => t,
): Promise<WrapperRequest[]> {
  const texts = new Map<string, string>();
  for (const p of paths) if (JS_FILE.test(p) && !SKIP.test(p)) texts.set(p, await repo.readText(p));
  const facts = new Map<string, FileFacts>();
  const read = async (p: string) => {
    if (facts.has(p)) return;
    const text = scriptOf(p, texts.get(p)!);
    facts.set(
      p,
      await useSyntaxTree(grammarOf(p, "js"), text, (t) => readFacts(t.rootNode, p), {
        cache: repo.parseCache,
        path: p,
      }),
    );
  };
  // Files that can define a helper name a client; then the files that name a helper.
  for (const [p, t] of texts) if (/\b(fetch|axios|http)\b/.test(t)) await read(p);
  const wrappers = new Map<string, Wrapper>(); // "<file>#<name>"
  const resolveImport = (from: string, spec: string): string | undefined => {
    if (!spec.startsWith(".")) return undefined;
    const base = posix.normalize(posix.join(dirname(from).split("\\").join("/"), spec));
    const tries = [
      base,
      base.replace(/\.js$/, ".ts"),
      base.replace(/\.js$/, ".tsx"),
      ...[".js", ".ts", ".jsx", ".tsx", ".mjs", "/index.js", "/index.ts"].map((x) => base + x),
    ];
    return tries.find((t) => texts.has(t));
  };
  const target = (f: FileFacts, c: Callee): { file: string; name: string } | undefined => {
    if (c.k === "id") {
      if (f.functions.some((x) => x.name === c.name)) return { file: f.path, name: c.name };
      const imp = f.imports.get(c.name);
      const file = imp && imp.name !== "*" ? resolveImport(f.path, imp.spec) : undefined;
      return file ? { file, name: imp!.name } : undefined;
    }
    const imp = f.imports.get(c.obj);
    const file = imp?.name === "*" ? resolveImport(f.path, imp.spec) : undefined;
    return file ? { file, name: c.prop } : undefined;
  };
  // What a call asks for, in terms of the enclosing function's parameters.
  const asked = (f: FileFacts, c: CallFact): Wrapper | undefined => {
    const params = c.fn >= 0 ? f.functions[c.fn]!.params : [];
    const sinkVerb =
      c.callee.k === "member" &&
      VERBS.has(c.callee.prop) &&
      /(^|\.)(axios|http)$/.test(c.callee.obj)
        ? c.callee.prop.toUpperCase()
        : undefined;
    if ((c.callee.k === "id" && c.callee.name === "fetch") || sinkVerb) {
      if (!c.args[0]) return undefined;
      return {
        url: partsOf(c.args[0], params, f.consts),
        method: sinkVerb
          ? { t: "lit", v: sinkVerb }
          : (methodIn(c.args[1], params) ?? { t: "lit", v: "GET" }),
      };
    }
    const t = target(f, c.callee);
    const w = t && wrappers.get(`${t.file}#${t.name}`);
    if (!w) return undefined;
    const url = w.url.flatMap((p) =>
      p.t === "param" ? (c.args[p.i] ? partsOf(c.args[p.i]!, params, f.consts) : []) : [p],
    );
    let method: Method;
    if (w.method.t === "lit") method = w.method;
    else {
      const a = c.args[w.method.i];
      const m = w.method.key
        ? methodIn(a, params)
        : a?.k === "str"
          ? ({ t: "lit", v: a.v.toUpperCase() } as const)
          : a?.k === "id" && params.includes(a.name)
            ? ({ t: "param", i: params.indexOf(a.name) } as const)
            : undefined;
      method = m ?? { t: "lit", v: "GET" };
    }
    return { url, method };
  };
  // Helpers until nothing new is found: one calling another is found on a later round.
  for (let round = 0; round < 6; round++) {
    let grew = false;
    for (const f of facts.values())
      for (const c of f.calls) {
        if (c.fn < 0) continue;
        const key = `${f.path}#${f.functions[c.fn]!.name}`;
        if (wrappers.has(key)) continue;
        const a = asked(f, c);
        if (a && a.url.some((p) => p.t === "param")) {
          wrappers.set(key, {
            ...a,
            at: {
              path: f.path,
              line: c.line,
              params: f.functions[c.fn]!.params,
              // fetch("/x/${id}") itself: the frontend reader reads it already.
              written:
                ((c.callee.k === "id" && c.callee.name === "fetch") ||
                  (c.callee.k === "member" && /(^|\.)(axios|http)$/.test(c.callee.obj))) &&
                (c.args[0]?.k === "str" || c.args[0]?.k === "tpl"),
            },
          });
          grew = true;
        }
      }
    // Files that name a helper found so far may call it.
    const names = new Set([...wrappers.keys()].map((k) => k.split("#")[1]!));
    for (const [p, t] of texts)
      if (!facts.has(p) && [...names].some((n) => t.includes(n))) {
        await read(p);
        grew = true;
      }
    if (!grew) break;
  }
  const out: WrapperRequest[] = [];
  const shown = (parts: Part[], params: string[] = []): string | undefined => {
    const ps = [...parts];
    // A base the build sets (an env value, a config constant) leads; the rest is the path.
    while (ps[0]?.t === "var" && ps.length > 1) ps.shift();
    const url = ps
      .map((p) =>
        p.t === "lit"
          ? p.v
          : p.t === "param"
            ? `{${params[p.i] || "value"}}`
            : `{${p.name.split(".").pop()!.replace(/\W/g, "")}}`,
      )
      .join("")
      .replace(/([^:])\/{2,}/g, "$1/");
    return /^(\/|https?:)/.test(url) ? url : undefined;
  };
  // Requests: calls through a helper whose URL is whole.
  for (const f of facts.values())
    for (const c of f.calls) {
      if (c.callee.k === "id" && c.callee.name === "fetch") continue;
      if (c.callee.k === "member" && /(^|\.)(axios|http)$/.test(c.callee.obj)) continue;
      const a = asked(f, c);
      if (!a || a.method.t !== "lit" || a.url.some((p) => p.t === "param")) continue;
      const url = shown(a.url);
      if (url) out.push({ method: a.method.v, url, path: f.path, line: c.line });
    }
  // A helper nothing here calls (an API module's exported function) is the request it
  // makes, its parameters the path's: `statement(id)` gives GET /api/statements/{id}.
  const called = new Set<string>();
  for (const f of facts.values())
    for (const c of f.calls) {
      const t = target(f, c.callee);
      if (t) called.add(`${t.file}#${t.name}`);
    }
  for (const [key, w] of wrappers) {
    if (called.has(key) || !w.at || w.at.written || w.method.t !== "lit") continue;
    const url = shown(w.url, w.at.params);
    if (url) out.push({ method: w.method.v, url, path: w.at.path, line: w.at.line });
  }
  return out.sort((x, y) => x.path.localeCompare(y.path) || x.line - y.line);
}
