/**
 * A small Java (and Kotlin-ish) reader for annotation-driven frameworks: it tokenises the
 * source, skips comments, and finds annotations, the declarations they sit on, the
 * enclosing types, and method calls with literal arguments. It does not type-check or
 * resolve imports; extractors only need what is written in the file, with line numbers.
 */

export type Token =
  | { t: "id"; v: string; line: number }
  | { t: "str"; v: string; line: number }
  | { t: "num"; v: string; line: number }
  | { t: "p"; v: string; line: number };

export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  let line = 1;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r" || c === "\f") {
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") line++;
        i++;
      }
      i += 2;
      continue;
    }
    if (c === '"') {
      // Text block """...""" or ordinary string.
      if (src.startsWith('"""', i)) {
        const start = line;
        i += 3;
        let v = "";
        while (i < n && !src.startsWith('"""', i)) {
          if (src[i] === "\n") line++;
          v += src[i];
          i++;
        }
        i += 3;
        out.push({ t: "str", v, line: start });
        continue;
      }
      i++;
      let v = "";
      while (i < n && src[i] !== '"' && src[i] !== "\n") {
        if (src[i] === "\\" && i + 1 < n) {
          const e = src[i + 1]!;
          v += e === "n" ? "\n" : e === "t" ? "\t" : e;
          i += 2;
          continue;
        }
        v += src[i];
        i++;
      }
      i++;
      out.push({ t: "str", v, line });
      continue;
    }
    if (c === "'") {
      i++;
      let v = "";
      while (i < n && src[i] !== "'" && src[i] !== "\n") {
        v += src[i] === "\\" ? src[++i] : src[i];
        i++;
      }
      i++;
      out.push({ t: "str", v, line });
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(src[j]!)) j++;
      out.push({ t: "id", v: src.slice(i, j), line });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[0-9A-Za-z_.]/.test(src[j]!)) j++;
      out.push({ t: "num", v: src.slice(i, j), line });
      i = j;
      continue;
    }
    out.push({ t: "p", v: c, line });
    i++;
  }
  return out;
}

/** An annotation attribute value: a string (concatenated literals), a list, or a bare name. */
export type AnnValue = string | string[];

export interface Annotation {
  /** Simple name, without package: "GetMapping". */
  name: string;
  /** Attributes; a single unnamed value is stored as "value". */
  attrs: Record<string, AnnValue>;
  /**
   * For attributes whose value has a bare name in it (a constant such as ApiPaths.CARDS, not a
   * string literal): the value with each name shown as ${Name}, e.g. "/v2${ApiPaths.CARDS}".
   * A name's value isn't known here, so what it makes is a loose end, never a verified fact.
   */
  named?: Record<string, AnnValue>;
  /**
   * Set when a framework model added this annotation for a house one (ADR 0054): which model,
   * and whether what it says was learned from code or bytecode (else facts it makes are inferred).
   */
  from?: { model: string; verified: boolean };
  line: number;
}

export type DeclKind =
  "class" | "interface" | "enum" | "record" | "annotation-type" | "method" | "field";

export interface Decl {
  kind: DeclKind;
  name: string;
  line: number;
  annotations: Annotation[];
  /** For types: the simple names after extends and implements. */
  supertypes: string[];
  /** The enclosing type declaration, if any. */
  parent?: Decl;
}

export interface Call {
  /** "rest.postForObject" or "send" */
  receiver?: string;
  method: string;
  /** Literal string arguments in order (non-literals are undefined). */
  args: (string | undefined)[];
  /**
   * Every argument as written, with what isn't a string literal shown as ${...}:
   * `base + PAY` → "${base}${PAY}". What a loose end can say about a call it can't resolve.
   */
  shown: string[];
  line: number;
  /** The method declaration the call sits in. */
  inMethod?: Decl;
  inType?: Decl;
}

export interface JavaFile {
  packageName?: string;
  /** Imported names, as written: "org.springframework.web.client.RestTemplate", "x.Y.*". */
  imports: string[];
  decls: Decl[];
  calls: Call[];
}

const TYPE_KW: Record<string, DeclKind> = {
  class: "class",
  interface: "interface",
  enum: "enum",
  record: "record",
};
const MODIFIERS = new Set([
  "public",
  "protected",
  "private",
  "static",
  "final",
  "abstract",
  "default",
  "synchronized",
  "native",
  "transient",
  "volatile",
  "strictfp",
  "sealed",
  "non-sealed",
  "open",
  "override",
  "suspend",
  "data",
  "fun",
  "val",
  "var",
]);

const LITERAL_NAMES = new Set(["true", "false", "null"]);

/**
 * Read a value inside annotation parentheses: "a" + "b", {"x","y"}, Name.CONST, 42, true.
 * `shown` is the value with each bare name as ${Name}, when there is one.
 */
function readValue(tk: Token[], i: number): { v: AnnValue; i: number; shown?: AnnValue } {
  const tok = tk[i];
  if (tok?.t === "p" && tok.v === "{") {
    const items: string[] = [];
    const shownItems: string[] = [];
    let named = false;
    const add = (r: { v: AnnValue; shown?: AnnValue }) => {
      const v = typeof r.v === "string" ? [r.v] : r.v;
      items.push(...v);
      if (r.shown !== undefined) named = true;
      const sh = r.shown ?? r.v;
      shownItems.push(...(typeof sh === "string" ? [sh] : sh));
    };
    const done = (at: number) =>
      named ? { v: items, i: at, shown: shownItems } : { v: items, i: at };
    i++;
    while (i < tk.length && !(tk[i]!.t === "p" && tk[i]!.v === "}")) {
      // A ")" before the "}" closes the annotation: the list was never closed.
      if (tk[i]!.t === "p" && tk[i]!.v === ")") return done(i);
      if (tk[i]!.t === "p" && tk[i]!.v === ",") {
        i++;
        continue;
      }
      const r = readValue(tk, i);
      add(r);
      // Always move on, even past a token that is no value (a stray "]").
      i = Math.max(r.i, i + 1);
    }
    return done(i + 1);
  }
  let v = "";
  let shown = "";
  let inName = false;
  let named = false;
  const closeName = () => {
    if (inName) shown += "}";
    inName = false;
  };
  let depth = 0;
  while (i < tk.length) {
    const t = tk[i]!;
    if (t.t === "p" && (t.v === "(" || t.v === "[")) depth++;
    if (t.t === "p" && (t.v === ")" || t.v === "]")) {
      if (depth === 0) break;
      depth--;
    }
    if (depth === 0 && t.t === "p" && (t.v === "," || t.v === "}")) break;
    if (t.t === "str") {
      closeName();
      v += t.v;
      shown += t.v;
    } else if (t.t === "num" || (t.t === "id" && LITERAL_NAMES.has(t.v) && !inName)) {
      closeName();
      v += t.v;
      shown += t.v;
    } else if (t.t === "id") {
      if (!inName) shown += "${";
      inName = true;
      named = true;
      v += t.v;
      shown += t.v;
    } else if (t.t === "p" && t.v === ".") {
      v += ".";
      shown += ".";
    } else closeName();
    i++;
  }
  closeName();
  return named ? { v, i, shown } : { v, i };
}

function readAnnotation(tk: Token[], i: number): { a: Annotation; i: number } | undefined {
  // tk[i] is "@"
  const nameTok = tk[i + 1];
  if (!nameTok || nameTok.t !== "id" || nameTok.v === "interface") return undefined;
  let name = nameTok.v;
  let j = i + 2;
  while (tk[j]?.t === "p" && tk[j]!.v === "." && tk[j + 1]?.t === "id") {
    name = tk[j + 1]!.v; // keep the simple name
    j += 2;
  }
  const attrs: Record<string, AnnValue> = {};
  const named: Record<string, AnnValue> = {};
  if (tk[j]?.t === "p" && tk[j]!.v === "(") {
    j++;
    while (j < tk.length && !(tk[j]!.t === "p" && tk[j]!.v === ")")) {
      if (tk[j]!.t === "p" && tk[j]!.v === ",") {
        j++;
        continue;
      }
      let key = "value";
      if (tk[j]!.t === "id" && tk[j + 1]?.t === "p" && tk[j + 1]!.v === "=") {
        key = (tk[j] as { v: string }).v;
        j += 2;
      }
      const r = readValue(tk, j);
      attrs[key] = r.v;
      if (r.shown !== undefined) named[key] = r.shown;
      // Always move on, even past a token that is no value (a stray "}" or "]"). An empty value
      // (`x = )`) stops on the ")" or ",", which the loop handles.
      const stop = tk[r.i]?.t === "p" && (tk[r.i]!.v === ")" || tk[r.i]!.v === ",");
      j = r.i > j || stop ? r.i : j + 1;
    }
    j++;
  }
  const a: Annotation = { name, attrs, line: nameTok.line };
  if (Object.keys(named).length > 0) a.named = named;
  return { a, i: j };
}

/**
 * Parse a Java source file into declarations (with their annotations and enclosing type)
 * and method calls. Good enough for annotation-driven frameworks; generics, lambdas and
 * nested parentheses are skipped over rather than understood.
 */
export function parseJava(src: string): JavaFile {
  const tk = tokenize(src);
  const decls: Decl[] = [];
  const calls: Call[] = [];
  const imports: string[] = [];
  let packageName: string | undefined;
  /** Stack of [decl, brace depth at which its body opened]. */
  const stack: { decl: Decl; depth: number }[] = [];
  let depth = 0;
  let pending: Annotation[] = [];
  let parenDepth = 0;

  const currentType = () => [...stack].reverse().find((s) => s.decl.kind !== "method")?.decl;
  const currentMethod = () => {
    const top = stack.at(-1);
    return top?.decl.kind === "method" ? top.decl : undefined;
  };

  for (let i = 0; i < tk.length; i++) {
    const t = tk[i]!;
    // package and import end at ";" (Java) or at the end of the line (Kotlin has no ";").
    const endsHere = (j: number) =>
      j >= tk.length || (tk[j]!.t === "p" && tk[j]!.v === ";") || tk[j]!.line !== t.line;
    if (t.t === "id" && t.v === "package" && depth === 0 && !packageName) {
      let name = "";
      let j = i + 1;
      while (!endsHere(j)) name += (tk[j++] as { v: string }).v;
      packageName = name;
      i = tk[j]?.t === "p" && tk[j]!.v === ";" ? j : j - 1;
      continue;
    }
    if (t.t === "id" && t.v === "import" && depth === 0) {
      let name = "";
      let j = i + 1;
      if (tk[j]?.t === "id" && (tk[j] as { v: string }).v === "static") j++;
      while (!endsHere(j)) name += (tk[j++] as { v: string }).v;
      if (name) imports.push(name);
      i = tk[j]?.t === "p" && tk[j]!.v === ";" ? j : j - 1;
      continue;
    }
    if (t.t === "p" && t.v === "@") {
      const r = readAnnotation(tk, i);
      if (r) {
        pending.push(r.a);
        i = r.i - 1;
        continue;
      }
      // @interface: an annotation type declaration
      if (
        tk[i + 1]?.t === "id" &&
        (tk[i + 1] as { v: string }).v === "interface" &&
        tk[i + 2]?.t === "id"
      ) {
        const d: Decl = {
          kind: "annotation-type",
          name: (tk[i + 2] as { v: string }).v,
          line: tk[i + 2]!.line,
          annotations: pending,
          supertypes: [],
          ...(currentType() ? { parent: currentType()! } : {}),
        };
        decls.push(d);
        pending = [];
        i += 2;
        continue;
      }
    }
    if (t.t === "p" && t.v === "(") parenDepth++;
    if (t.t === "p" && t.v === ")") parenDepth = Math.max(0, parenDepth - 1);

    // Type declarations.
    if (t.t === "id" && TYPE_KW[t.v] && tk[i + 1]?.t === "id" && parenDepth === 0) {
      const d: Decl = {
        kind: TYPE_KW[t.v]!,
        name: (tk[i + 1] as { v: string }).v,
        line: tk[i + 1]!.line,
        annotations: pending,
        supertypes: [],
        ...(currentType() ? { parent: currentType()! } : {}),
      };
      pending = [];
      let j = i + 2;
      let collecting = false;
      while (j < tk.length && !(tk[j]!.t === "p" && (tk[j]!.v === "{" || tk[j]!.v === ";"))) {
        const x = tk[j]!;
        if (x.t === "id" && (x.v === "extends" || x.v === "implements")) collecting = true;
        else if (
          collecting &&
          x.t === "id" &&
          /^[A-Z]/.test(x.v) &&
          !(tk[j - 1]?.t === "p" && tk[j - 1]!.v === "<")
        )
          d.supertypes.push(x.v);
        j++;
      }
      decls.push(d);
      if (tk[j]?.v === "{") {
        depth++;
        stack.push({ decl: d, depth });
      }
      i = j;
      continue;
    }

    // Method declarations: [modifiers] Type name ( ... ) [throws ...] { or ;
    if (
      t.t === "id" &&
      tk[i + 1]?.t === "p" &&
      tk[i + 1]!.v === "(" &&
      parenDepth === 0 &&
      currentType() &&
      !currentMethod()
    ) {
      const prev = tk[i - 1];
      const isDecl =
        prev &&
        (prev.t === "id" || (prev.t === "p" && (prev.v === ">" || prev.v === "]"))) &&
        !["new", "return", "throw", "else"].includes((prev as { v: string }).v);
      if (isDecl) {
        // Find the matching ")" then "{" or ";".
        let j = i + 1;
        let pd = 0;
        for (; j < tk.length; j++) {
          if (tk[j]!.t === "p" && tk[j]!.v === "(") pd++;
          if (tk[j]!.t === "p" && tk[j]!.v === ")" && --pd === 0) break;
        }
        let k = j + 1;
        while (
          k < tk.length &&
          !(tk[k]!.t === "p" && (tk[k]!.v === "{" || tk[k]!.v === ";" || tk[k]!.v === "="))
        )
          k++;
        const d: Decl = {
          kind: "method",
          name: t.v,
          line: t.line,
          annotations: pending,
          supertypes: [],
          parent: currentType()!,
        };
        pending = [];
        decls.push(d);
        if (tk[k]?.v === "{") {
          depth++;
          stack.push({ decl: d, depth });
          i = k;
        } else {
          i = k;
        }
        continue;
      }
    }

    // Field declarations with annotations: [annotations] Type name [= ...];
    if (
      pending.length > 0 &&
      t.t === "id" &&
      tk[i + 1]?.t === "p" &&
      (tk[i + 1]!.v === ";" || tk[i + 1]!.v === "=") &&
      currentType() &&
      !currentMethod() &&
      !MODIFIERS.has(t.v)
    ) {
      decls.push({
        kind: "field",
        name: t.v,
        line: t.line,
        annotations: pending,
        supertypes: [],
        parent: currentType()!,
      });
      pending = [];
      continue;
    }

    // Method calls: [receiver .] name ( args )
    if (
      t.t === "id" &&
      tk[i + 1]?.t === "p" &&
      tk[i + 1]!.v === "(" &&
      (currentMethod() || stack.length > 0)
    ) {
      const prev = tk[i - 1];
      const receiver =
        prev?.t === "p" && prev.v === "." && tk[i - 2]?.t === "id"
          ? (tk[i - 2] as { v: string }).v
          : undefined;
      if (!(prev?.t === "id" && ["new", "class", "interface"].includes(prev.v))) {
        const args: (string | undefined)[] = [];
        const shown: string[] = [];
        let j = i + 2;
        let pd = 0;
        let cur: string | undefined = "";
        let literalOnly = true;
        // The shown form: literals as text, any other run of tokens as ${...}.
        let sh = "";
        let run = "";
        const endRun = () => {
          if (run) sh += `\${${run}}`;
          run = "";
        };
        const endArg = () => {
          endRun();
          args.push(literalOnly && cur !== "" ? cur : undefined);
          shown.push(sh);
          cur = "";
          sh = "";
          literalOnly = true;
        };
        for (; j < tk.length; j++) {
          const x = tk[j]!;
          if (x.t === "p" && (x.v === "(" || x.v === "{" || x.v === "[")) pd++;
          if (x.t === "p" && (x.v === ")" || x.v === "}" || x.v === "]")) {
            if (pd === 0) break;
            pd--;
          }
          if (pd === 0 && x.t === "p" && x.v === ",") {
            endArg();
            continue;
          }
          if (pd === 0 && x.t === "str") {
            cur += x.v;
            endRun();
            sh += x.v;
          } else if (pd === 0 && x.t === "p" && x.v === "+") {
            endRun();
            continue;
          } else {
            literalOnly = false;
            run += x.t === "str" ? JSON.stringify(x.v) : x.v;
          }
        }
        if (cur !== "" || run !== "" || sh !== "" || args.length > 0) endArg();
        const inMethod = currentMethod();
        const inType = currentType();
        calls.push({
          ...(receiver ? { receiver } : {}),
          method: t.v,
          args,
          shown,
          line: t.line,
          ...(inMethod ? { inMethod } : {}),
          ...(inType ? { inType } : {}),
        });
      }
    }

    if (t.t === "p" && t.v === "{") depth++;
    if (t.t === "p" && t.v === "}") {
      if (stack.length > 0 && stack.at(-1)!.depth === depth) stack.pop();
      depth = Math.max(0, depth - 1);
    }
    if (t.t === "p" && t.v === ";") {
      // Annotations followed by something we didn't model (e.g. a local variable) are dropped.
      if (pending.length > 0 && currentMethod()) pending = [];
    }
  }
  return { ...(packageName ? { packageName } : {}), imports, decls, calls };
}

/** A string attribute (the first item if it's a list). */
export function attr(a: Annotation | undefined, name = "value"): string | undefined {
  const v = a?.attrs[name];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * A list attribute as written, with each bare name shown as ${Name}: what a constant makes when
 * its value isn't known. `named` says whether there was one.
 */
export function attrsShown(
  a: Annotation | undefined,
  name = "value",
): { values: string[]; named: boolean } {
  const v = a?.named?.[name];
  if (v === undefined) return { values: attrs(a, name), named: false };
  return { values: Array.isArray(v) ? v : [v], named: true };
}

/** A list attribute (a single string becomes a one-item list). */
export function attrs(a: Annotation | undefined, name = "value"): string[] {
  const v = a?.attrs[name];
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

export function findAnnotation(d: Decl | undefined, ...names: string[]): Annotation | undefined {
  return d?.annotations.find((a) => names.includes(a.name));
}
