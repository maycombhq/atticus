import type Parser from "web-tree-sitter";
import type { ParseCache } from "@maycombhq/sdk";
import { syntaxLanguageOf, useSyntaxTree, type SyntaxLanguage } from "./syntax.js";

/**
 * The generic-tier call layer read from syntax trees (ADR 0060): for C#, Python, Go and
 * JavaScript/TypeScript (JSX and TSX too), one file's tokens (the tree's leaves, without
 * comments, each string literal one token with its value), its calls with their arguments,
 * its simple assignments and its imports. Everything is taken from the tree while it is
 * alive and kept as plain data, so the tree is freed straight away.
 *
 * Interpolated strings (Python f-strings, C# $"...", JS template literals) keep their
 * expressions written as `${expr}` in the value, and each expression is read too, so later
 * steps can resolve or name them.
 */

export type SourceLang = "csharp" | "python" | "go" | "js";

export interface SrcTok {
  /** id: identifier or keyword; str: string literal; lit: other literal (number, char, regex); p: punctuation. */
  t: "id" | "str" | "lit" | "p";
  v: string;
  line: number;
  /** For strings that interpolate expressions. */
  interp?: true;
  /** An interpolated string's pieces: literal text, and each expression as read. */
  parts?: (string | SourceRead)[];
}

export interface RawArg {
  name?: string;
  from: number;
  to: number;
}

export interface RawCall {
  callee: string;
  name: string;
  recv: string;
  start: number;
  open: number;
  close: number;
  line: number;
  args: RawArg[];
  /** Index (in `calls`) of the call this one is chained on. */
  chained?: number;
  isNew: boolean;
  decorator: boolean;
  generics: string[];
}

export interface RawAssign {
  name: string;
  /** Token index of the target's first token. */
  at: number;
  from: number;
  to: number;
  /** At the top level of the file (Python module level). */
  top: boolean;
}

/** One import: a module (`"express"`, `fx_rates.rates`, `Confluent.Kafka`, `net/http`) and the names it binds. */
export interface ImportDecl {
  spec: string;
  line: number;
  /** Local name and what it names: "default", "*" (the module itself) or an exported name. */
  names: { local: string; name: string }[];
}

export interface SourceRead {
  toks: SrcTok[];
  calls: RawCall[];
  assigns: RawAssign[];
  imports: ImportDecl[];
}

type Node = Parser.SyntaxNode;

/** The grammar a file is parsed with: JS by its extension (TS, TSX, or JavaScript with JSX). */
export function grammarOf(path: string, lang: SourceLang): SyntaxLanguage {
  if (lang === "csharp") return "c_sharp";
  if (lang === "python" || lang === "go") return lang;
  const byName = syntaxLanguageOf(path);
  return byName === "javascript" || byName === "tsx" || byName === "typescript"
    ? byName
    : "typescript";
}

/**
 * Parse a file and read it. The tree is the scan's shared one with a parse cache (ADR 0067),
 * else parsed here and freed before this returns.
 */
export async function readSourceFile(
  path: string,
  text: string,
  lang: SourceLang,
  cache?: ParseCache,
): Promise<SourceRead> {
  return useSyntaxTree(
    grammarOf(path, lang),
    text,
    (tree) => readSource(tree.rootNode, text, lang),
    { cache, path },
  );
}

// ---------------------------------------------------------------- node kinds

const STRINGS: Record<SourceLang, Set<string>> = {
  js: new Set(["string", "template_string"]),
  python: new Set(["string"]),
  csharp: new Set([
    "string_literal",
    "verbatim_string_literal",
    "raw_string_literal",
    "interpolated_string_expression",
  ]),
  go: new Set(["interpreted_string_literal", "raw_string_literal"]),
};
const isString = (n: Node, lang: SourceLang) => n.isNamed && STRINGS[lang].has(n.type);
/** Literals kept as one token: regexes, characters and runes, JSX text. */
const ONE_TOKEN = new Set(["regex", "character_literal", "rune_literal", "jsx_text"]);
const INTERPOLATIONS = new Set(["template_substitution", "interpolation"]);

const isComment = (n: Node) => n.type.includes("comment") || n.type === "hash_bang_line";
/** C# preprocessor lines (#region, #if, #pragma...): not code. */
const isDirective = (n: Node) =>
  n.isNamed &&
  ((n.type.endsWith("_directive") && !CODE_DIRECTIVES.has(n.type)) || n.type.startsWith("preproc"));
/** C# declarations the grammar also calls directives. */
const CODE_DIRECTIVES = new Set(["using_directive", "extern_alias_directive"]);

const ID = /^[A-Za-z_$À-￿][A-Za-z0-9_$À-￿]*$/;
const isIdText = (s: string) => ID.test(s);

const CALLS: Record<SourceLang, Set<string>> = {
  js: new Set(["call_expression", "new_expression"]),
  python: new Set(["call"]),
  csharp: new Set(["invocation_expression", "object_creation_expression", "attribute"]),
  go: new Set(["call_expression"]),
};
const NEW = new Set(["new_expression", "object_creation_expression"]);
/** Member access in each grammar: [node type, object field, member field]. */
const MEMBERS: Record<string, [string, string]> = {
  member_expression: ["object", "property"],
  attribute: ["object", "attribute"],
  selector_expression: ["operand", "field"],
  member_access_expression: ["expression", "name"],
  qualified_name: ["qualifier", "name"],
};

/** Names never read as a call: keywords that take parentheses, and print. */
const NOT_CALLEE = new Set([
  "if",
  "for",
  "foreach",
  "while",
  "switch",
  "catch",
  "using",
  "lock",
  "return",
  "function",
  "def",
  "class",
  "elif",
  "in",
  "not",
  "and",
  "or",
  "await",
  "typeof",
  "sizeof",
  "nameof",
  "func",
  "with",
  "assert",
  "fixed",
  "checked",
  "unchecked",
  "super",
  "import",
  "print",
]);

// ---------------------------------------------------------------- reading

/** Read the code under `root` (a file, or one interpolated expression). */
export function readSource(root: Node, text: string, lang: SourceLang): SourceRead {
  const toks: SrcTok[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  const push = (tok: SrcTok, from: number, to: number) => {
    toks.push(tok);
    starts.push(from);
    ends.push(to);
  };
  const line = (n: Node) => n.startPosition.row + 1;

  // ---- tokens: the leaves, strings whole
  let skipUntil = -1;
  const leaves = (n: Node) => {
    if (n.endIndex <= skipUntil || isComment(n) || (lang === "csharp" && isDirective(n))) return;
    if (
      lang === "csharp" &&
      (n.childCount === 0 || isString(n, lang)) &&
      n.startIndex >= skipUntil &&
      text.startsWith('"""', n.startIndex)
    ) {
      // C# 11 raw strings: the bundled grammar predates them, so the literal is read here.
      const end = rawStringEnd(text, n.startIndex);
      push(
        { t: "str", v: rawStringValue(text, n.startIndex, end), line: line(n) },
        n.startIndex,
        end,
      );
      skipUntil = end;
      return;
    }
    if (n.startIndex < skipUntil && n.childCount === 0) return;
    if (isString(n, lang)) {
      push(stringToken(n, text, lang), n.startIndex, n.endIndex);
      return;
    }
    if ((n.isNamed && ONE_TOKEN.has(n.type)) || n.childCount === 0) {
      const v = n.text;
      if (v.trim() === "") return; // Go's newline terminators
      if (n.isNamed && ONE_TOKEN.has(n.type))
        push({ t: "lit", v: litValue(n), line: line(n) }, n.startIndex, n.endIndex);
      else if (/^\.?[0-9]/.test(v)) push({ t: "lit", v, line: line(n) }, n.startIndex, n.endIndex);
      else if (lang === "csharp" && v.startsWith("@") && isIdText(v.slice(1)))
        push({ t: "id", v: v.slice(1), line: line(n) }, n.startIndex, n.endIndex);
      else push({ t: isIdText(v) ? "id" : "p", v, line: line(n) }, n.startIndex, n.endIndex);
      return;
    }
    for (const c of n.children) leaves(c);
  };
  leaves(root);

  /** Token index of a node's first token. */
  const first = (n: Node) => lowerBound(starts, n.startIndex);
  /** Token index just past a node's last token. */
  const end = (n: Node) => lowerBound(ends, n.endIndex + 1);
  const is = (k: number, v: string) => toks[k]?.t === "p" && toks[k]!.v === v;

  // Brackets, and the innermost open bracket around each token.
  const encl = new Int32Array(toks.length).fill(-1);
  {
    const stack: number[] = [];
    toks.forEach((t, k) => {
      encl[k] = stack[stack.length - 1] ?? -1;
      if (t.t !== "p") return;
      if (t.v === "(" || t.v === "[" || t.v === "{") stack.push(k);
      else if (t.v === ")" || t.v === "]" || t.v === "}") {
        const want = t.v === ")" ? "(" : t.v === "]" ? "[" : "{";
        for (let s = stack.length - 1; s >= 0; s--)
          if (toks[stack[s]!]!.v === want) {
            stack.length = s;
            break;
          }
      }
    });
  }

  // ---- walk the tree once for calls, assignments and imports (never into strings)
  const callNodes: Node[] = [];
  const assigns: RawAssign[] = [];
  const imports: ImportDecl[] = [];
  const visit = (n: Node) => {
    if (isComment(n) || isString(n, lang) || (lang === "csharp" && isDirective(n))) return;
    if (CALLS[lang].has(n.type)) callNodes.push(n);
    assignment(n, lang, (target, value, top) => {
      const name = target ? dottedOf(target) : undefined;
      if (!name || !value) return;
      const from = first(value);
      const to = end(value);
      const eq = from - 1;
      if (to <= from || !(is(eq, "=") || is(eq, ":="))) return;
      // As before: not an argument (`f(a = 1)`), a condition or a subscript.
      const o = encl[eq]!;
      if (o >= 0 && is(o, "[")) return;
      if (o >= 0 && is(o, "(") && !["const", "var"].includes(toks[o - 1]?.v ?? "")) return;
      assigns.push({ name, at: first(target!), from, to, top });
    });
    imports.push(...importsOf(n, lang, text));
    for (const c of n.children) visit(c);
  };
  visit(root);

  // ---- calls, in the order of their parentheses
  type Pending = { node: Node; open: number };
  const pending: Pending[] = [];
  for (const node of callNodes) {
    const args = argsOf(node);
    if (!args) continue;
    pending.push({ node, open: first(args) });
  }
  pending.sort((a, b) => a.open - b.open);
  const calls: RawCall[] = [];
  const byNode = new Map<number, number>();
  for (const { node, open } of pending) {
    const args = argsOf(node)!;
    const close = end(args) - 1;
    if (!is(open, "(") || !is(close, ")")) continue;
    const head = calleeOf(node, lang);
    if (!head) continue;
    const { segs, chainedOn, generics } = head;
    const nameNode = segs[segs.length - 1]!;
    if (NOT_CALLEE.has(nameNode.text)) continue;
    const chained = chainedOn ? byNode.get(chainedOn.id) : undefined;
    if (chainedOn && chained === undefined) continue;
    const names = segs.map((s) => s.text);
    const call: RawCall = {
      callee: names.join("."),
      name: names[names.length - 1]!,
      recv: names.slice(0, -1).join("."),
      start: first(segs[0]!),
      open,
      close,
      line: line(nameNode),
      args: argList(args, open, close, lang, first, end),
      ...(chained !== undefined ? { chained } : {}),
      isNew: chained === undefined && NEW.has(node.type),
      decorator: chained === undefined && node.parent?.type === "decorator",
      generics: generics
        ? toks
            .slice(first(generics), end(generics))
            .filter((t) => t.t === "id")
            .map((t) => t.v)
        : [],
    };
    byNode.set(node.id, calls.length);
    calls.push(call);
  }

  assigns.sort((a, b) => a.from - b.from);
  return { toks, calls, assigns, imports };
}

function lowerBound(xs: number[], v: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid]! < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ---------------------------------------------------------------- calls

function argsOf(n: Node): Node | undefined {
  if (n.type === "attribute")
    return n.namedChildren.find((c) => c.type === "attribute_argument_list");
  if (n.type === "object_creation_expression")
    return n.namedChildren.find((c) => c.type === "argument_list");
  const a = n.childForFieldName("arguments");
  if (!a) return undefined;
  // A tagged template (gql`...`) is not a call with arguments.
  return a.type === "template_string" ? undefined : a;
}

/** The callee as dotted segments (leftmost first), the call it is chained on, and type arguments. */
function calleeOf(
  n: Node,
  lang: SourceLang,
): { segs: Node[]; chainedOn?: Node; generics?: Node } | undefined {
  let fn: Node | null;
  let generics: Node | undefined;
  if (n.type === "attribute") fn = n.childForFieldName("name");
  else if (n.type === "new_expression") {
    fn = n.childForFieldName("constructor");
    generics = n.childForFieldName("type_arguments") ?? undefined;
  } else if (n.type === "object_creation_expression") fn = n.childForFieldName("type");
  else {
    fn = n.childForFieldName("function");
    generics = n.childForFieldName("type_arguments") ?? undefined;
  }
  // The bundled grammars bind `await f<T>(x)` and C# `await x?.F()` as a call of `await f`.
  if (fn?.type === "await_expression") fn = fn.namedChildren.find((c) => !isComment(c)) ?? null;
  const segs: Node[] = [];
  let chainedOn: Node | undefined;
  while (fn) {
    if (fn.childCount === 0) {
      if (!isIdText(fn.text)) return undefined;
      segs.unshift(fn);
      break;
    }
    if (fn.type === "generic_name") {
      if (segs.length === 0)
        generics = fn.namedChildren.find((c) => c.type === "type_argument_list");
      const id = fn.namedChildren.find((c) => c.type === "identifier");
      if (!id) return undefined;
      segs.unshift(id);
      break;
    }
    const member = MEMBERS[fn.type];
    if (member) {
      let prop = fn.childForFieldName(member[1]);
      if (prop?.type === "generic_name") {
        if (segs.length === 0)
          generics = prop.namedChildren.find((c) => c.type === "type_argument_list");
        prop = prop.namedChildren.find((c) => c.type === "identifier") ?? null;
      }
      if (!prop || prop.childCount > 0 || !isIdText(prop.text)) return undefined;
      // `a?.(x)`: the parenthesis follows `?.`, not a name.
      if (segs.length === 0 && lang === "js" && n.child(n.childCount - 2)?.type === "?.")
        return undefined;
      segs.unshift(prop);
      fn = fn.childForFieldName(member[0]);
      continue;
    }
    if (fn.type === "conditional_access_expression" && segs.length === 0) {
      // C# `x?.Name(...)`
      const binding = fn.namedChildren.find((c) => c.type === "member_binding_expression");
      const name = binding?.childForFieldName("name") ?? binding?.namedChildren.at(-1);
      if (!name || !isIdText(name.text)) return undefined;
      segs.unshift(name.type === "generic_name" ? name.namedChildren[0]! : name);
      let cond = fn.childForFieldName("condition") ?? fn.namedChildren[0] ?? null;
      if (cond?.type === "await_expression") cond = cond.namedChildren[0] ?? null;
      fn = cond;
      continue;
    }
    if (fn.type === "non_null_expression" && segs.length > 0) {
      fn = fn.namedChildren[0] ?? null;
      continue;
    }
    if (segs.length > 0 && (CALLS[lang].has(fn.type) || NEW.has(fn.type))) {
      chainedOn = fn;
      break;
    }
    // A method on a string literal ("...".format(...)): kept, with no receiver name.
    if (segs.length > 0 && isString(fn, lang)) break;
    return undefined;
  }
  if (segs.length === 0) return undefined;
  return { segs, ...(chainedOn ? { chainedOn } : {}), ...(generics ? { generics } : {}) };
}

function argList(
  args: Node,
  open: number,
  close: number,
  lang: SourceLang,
  first: (n: Node) => number,
  end: (n: Node) => number,
): RawArg[] {
  if (!/argument_list$|^arguments$/.test(args.type))
    return close > open + 1 ? [{ from: open + 1, to: close }] : []; // f(x for x in y)
  const out: RawArg[] = [];
  for (const a of args.namedChildren) {
    if (isComment(a)) continue;
    const from = first(a);
    const to = end(a);
    if (to <= from) continue;
    if (a.type === "keyword_argument" && lang === "python") {
      const name = a.childForFieldName("name");
      const value = a.childForFieldName("value");
      if (name && value) {
        out.push({ name: name.text, from: first(value), to });
        continue;
      }
    }
    if (a.type === "argument" || a.type === "attribute_argument") {
      const nc = a.namedChildren.find((c) => c.type === "name_colon");
      const value = a.namedChildren.at(-1);
      const name = nc?.namedChildren.find((c) => c.type === "identifier");
      if (nc && name && value && value.type !== "name_colon") {
        out.push({ name: name.text, from: first(value), to });
        continue;
      }
    }
    out.push({ from, to });
  }
  return out;
}

// ---------------------------------------------------------------- assignments

/** `x`, `a.b.c`, `this.x`, `self.x` as dotted text; anything else undefined. */
function dottedOf(n: Node): string | undefined {
  if (n.childCount === 0) {
    const v = n.text.startsWith("@") ? n.text.slice(1) : n.text;
    return isIdText(v) ? v : undefined;
  }
  const member = MEMBERS[n.type];
  if (!member) return undefined;
  const obj = n.childForFieldName(member[0]);
  const prop = n.childForFieldName(member[1]);
  if (!obj || !prop) return undefined;
  const a = dottedOf(obj);
  const b = dottedOf(prop);
  return a && b ? `${a}.${b}` : undefined;
}

/** Report the simple assignments a node makes: target, value, and whether at the top level. */
function assignment(
  n: Node,
  lang: SourceLang,
  add: (target: Node | null, value: Node | null, top: boolean) => void,
) {
  const field = (f: string) => n.childForFieldName(f);
  switch (lang) {
    case "js":
      if (n.type === "variable_declarator") add(field("name"), field("value"), false);
      else if (n.type === "assignment_expression") add(field("left"), field("right"), false);
      else if (n.type === "public_field_definition" || n.type === "field_definition")
        add(field("property") ?? field("name"), field("value"), false);
      else if (n.type === "enum_assignment") add(field("name"), field("value"), false);
      return;
    case "python":
      if (n.type === "assignment") {
        const right = field("right");
        if (right?.type === "assignment") return; // a = b = x: the innermost is read
        const top = n.parent?.type === "expression_statement" && n.parent.parent?.type === "module";
        add(field("left"), right, top);
      } else if (n.type === "named_expression") add(field("name"), field("value"), false);
      return;
    case "csharp":
      if (n.type === "variable_declarator") {
        const id = n.namedChildren.find((c) => c.type === "identifier");
        const eq = n.namedChildren.find((c) => c.type === "equals_value_clause");
        if (id && eq) add(id, eq.namedChildren.at(-1) ?? null, false);
      } else if (n.type === "assignment_expression") {
        const op = n.namedChildren.find((c) => c.type === "assignment_operator");
        if (!op || op.text === "=") add(field("left"), field("right"), false);
      } else if (n.type === "enum_member_declaration") add(field("name"), field("value"), false);
      return;
    case "go": {
      let left: Node[];
      let right: Node[];
      if (n.type === "const_spec" || n.type === "var_spec") {
        left = n.namedChildren.filter((c) => c.type === "identifier");
        right = field("value")?.namedChildren ?? [];
      } else if (
        n.type === "short_var_declaration" ||
        (n.type === "assignment_statement" && field("operator")?.text === "=")
      ) {
        left = field("left")?.namedChildren ?? [];
        right = field("right")?.namedChildren ?? [];
      } else return;
      right = right.filter((c) => !isComment(c));
      if (left.length !== right.length) return;
      left.forEach((l, i) => add(l, right[i]!, false));
      return;
    }
  }
}

// ---------------------------------------------------------------- imports

function importsOf(n: Node, lang: SourceLang, text: string): ImportDecl[] {
  const line = n.startPosition.row + 1;
  const str = (s: Node | null | undefined) => (s ? stringToken(s, text, lang).v : undefined);
  switch (lang) {
    case "js": {
      if (n.type === "import_statement" || n.type === "export_statement") {
        const spec = str(n.childForFieldName("source"));
        if (spec === undefined) return [];
        const names: ImportDecl["names"] = [];
        const clause = n.namedChildren.find((c) => c.type === "import_clause");
        for (const c of clause?.namedChildren ?? []) {
          if (c.type === "identifier") names.push({ local: c.text, name: "default" });
          else if (c.type === "namespace_import") {
            const id = c.namedChildren.find((x) => x.type === "identifier");
            if (id) names.push({ local: id.text, name: "*" });
          } else if (c.type === "named_imports")
            for (const s of c.namedChildren) {
              if (s.type !== "import_specifier") continue;
              const name = s.childForFieldName("name");
              const alias = s.childForFieldName("alias");
              if (name) names.push({ local: (alias ?? name).text, name: name.text });
            }
        }
        return [{ spec, line, names }];
      }
      if (n.type === "call_expression") {
        const fn = n.childForFieldName("function");
        const args = n.childForFieldName("arguments");
        const only = args?.namedChildren.filter((c) => !isComment(c)) ?? [];
        if (
          (fn?.text === "require" || fn?.type === "import") &&
          only.length === 1 &&
          only[0]!.type === "string"
        )
          return [{ spec: str(only[0])!, line, names: [] }];
      }
      return [];
    }
    case "python": {
      if (n.type === "import_statement") {
        // One declaration per module: `import a.b` binds a, `import a.b as c` binds c.
        return n.namedChildren.flatMap((c) => {
          if (c.type === "dotted_name")
            return [{ spec: c.text, line, names: [{ local: c.text.split(".")[0]!, name: "*" }] }];
          if (c.type === "aliased_import") {
            const mod = c.childForFieldName("name")?.text;
            const alias = c.childForFieldName("alias")?.text;
            return mod && alias ? [{ spec: mod, line, names: [{ local: alias, name: "*" }] }] : [];
          }
          return [];
        });
      }
      if (n.type === "import_from_statement") {
        const mod = n.childForFieldName("module_name");
        if (!mod) return [];
        const names: ImportDecl["names"] = [];
        for (const c of n.namedChildren) {
          if (c.id === mod.id) continue;
          if (c.type === "dotted_name") names.push({ local: c.text, name: c.text });
          else if (c.type === "aliased_import") {
            const name = c.childForFieldName("name")?.text;
            const alias = c.childForFieldName("alias")?.text;
            if (name && alias) names.push({ local: alias, name });
          }
        }
        return [{ spec: mod.text.replace(/\s+/g, ""), line, names }];
      }
      return [];
    }
    case "csharp": {
      if (n.type !== "using_directive") return [];
      const names = n.namedChildren.filter(
        (c) => c.type === "qualified_name" || c.type === "identifier",
      );
      const target = names.at(-1);
      return target ? [{ spec: target.text, line, names: [] }] : [];
    }
    case "go": {
      if (n.type !== "import_spec") return [];
      const spec = str(n.childForFieldName("path"));
      const alias = n.childForFieldName("name")?.text;
      return spec === undefined
        ? []
        : [{ spec, line, names: alias ? [{ local: alias, name: "*" }] : [] }];
    }
  }
}

// ---------------------------------------------------------------- strings

const escape = (e: string) =>
  e === "n" ? "\n" : e === "t" ? "\t" : e === "r" ? "\r" : e === "0" ? "\0" : e;

function litValue(n: Node): string {
  const t = n.text;
  if (n.type === "character_literal" || n.type === "rune_literal") return t.slice(1, -1);
  return t;
}

/** A string literal as one token: its value with escapes decoded, interpolations as `${expr}`. */
function stringToken(n: Node, text: string, lang: SourceLang): SrcTok {
  const raw = n.text;
  let p = 0;
  while (p < raw.length && /[A-Za-z@$]/.test(raw[p]!)) p++;
  const prefix = raw.slice(0, p);
  const qc = raw[p] ?? '"';
  const q = lang === "python" && raw.startsWith(qc.repeat(3), p) ? 3 : 1;
  const close = raw.length - q >= p + q && raw.endsWith(qc.repeat(q)) ? raw.length - q : raw.length;
  const base = n.startIndex;
  const kind = {
    raw: (lang === "python" && /r/i.test(prefix)) || (lang === "go" && qc === "`") || false,
    verbatim: lang === "csharp" && prefix.includes("@"),
    braces: (lang === "python" && /f/i.test(prefix)) || (lang === "csharp" && prefix.includes("$")),
    template: lang === "js" && qc === "`",
  };
  const decode = (s: string) => decodeString(s, lang, kind);
  const subs = n.children.filter((c) => INTERPOLATIONS.has(c.type));
  let v = "";
  const parts: (string | SourceRead)[] = [];
  let pos = base + p + q;
  for (const s of subs) {
    const lit = decode(text.slice(pos, s.startIndex));
    v += lit;
    if (lit) parts.push(lit);
    const expr = s.namedChildren.find(
      (c) =>
        !isComment(c) &&
        !/^(type_conversion|format_specifier|interpolation_\w+_clause)$/.test(c.type),
    );
    const shown = lang === "js" ? s.text.slice(2, -1) : (expr?.text ?? "").trim();
    v += "${" + shown + "}";
    parts.push(
      expr ? readSource(expr, text, lang) : { toks: [], calls: [], assigns: [], imports: [] },
    );
    pos = s.endIndex;
  }
  const tail = decode(text.slice(pos, base + close));
  v += tail;
  if (tail) parts.push(tail);
  const interp = lang === "js" ? subs.length > 0 : kind.braces;
  const line = n.startPosition.row + 1;
  return interp ? { t: "str", v, line, interp: true, parts } : { t: "str", v, line };
}

function decodeString(
  s: string,
  lang: SourceLang,
  kind: { raw: boolean; verbatim: boolean; braces: boolean; template: boolean },
): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (kind.braces && (c === "{" || c === "}") && s[i + 1] === c) {
      out += c;
      i++;
    } else if (kind.verbatim) {
      if (c === '"' && s[i + 1] === '"') i++;
      out += c;
    } else if (c === "\\" && i + 1 < s.length && !(kind.raw && lang === "go")) {
      const e = s[i + 1]!;
      if (kind.raw) out += c + e;
      else if (e === "\n" && lang !== "python" && !kind.template) {
        // a line continuation inside a quoted string
      } else out += escape(e);
      i++;
    } else out += c;
  }
  return out;
}

/** End (exclusive) of a C# raw string literal starting at `at` (a run of three or more quotes). */
function rawStringEnd(text: string, at: number): number {
  let q = 0;
  while (text[at + q] === '"') q++;
  const close = text.indexOf('"'.repeat(q), at + q);
  return close < 0 ? text.length : close + q;
}

function rawStringValue(text: string, at: number, end: number): string {
  let q = 0;
  while (text[at + q] === '"') q++;
  return text.slice(at + q, Math.max(at + q, end - q));
}
