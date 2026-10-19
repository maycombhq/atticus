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
  line: number;
  /** The method declaration the call sits in. */
  inMethod?: Decl;
  inType?: Decl;
}

export interface JavaFile {
  packageName?: string;
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

/** Read a value inside annotation parentheses: "a" + "b", {"x","y"}, Name.CONST, 42, true. */
function readValue(tk: Token[], i: number): { v: AnnValue; i: number } {
  const tok = tk[i];
  if (tok?.t === "p" && tok.v === "{") {
    const items: string[] = [];
    i++;
    while (i < tk.length && !(tk[i]!.t === "p" && tk[i]!.v === "}")) {
      // A ")" before the "}" closes the annotation: the list was never closed.
      if (tk[i]!.t === "p" && tk[i]!.v === ")") return { v: items, i };
      if (tk[i]!.t === "p" && tk[i]!.v === ",") {
        i++;
        continue;
      }
      const r = readValue(tk, i);
      if (typeof r.v === "string") items.push(r.v);
      else items.push(...r.v);
      // Always move on, even past a token that is no value (a stray "]").
      i = Math.max(r.i, i + 1);
    }
    return { v: items, i: i + 1 };
  }
  let v = "";
  let depth = 0;
  while (i < tk.length) {
    const t = tk[i]!;
    if (t.t === "p" && (t.v === "(" || t.v === "[")) depth++;
    if (t.t === "p" && (t.v === ")" || t.v === "]")) {
      if (depth === 0) break;
      depth--;
    }
    if (depth === 0 && t.t === "p" && (t.v === "," || t.v === "}")) break;
    if (t.t === "str") v += t.v;
    else if (t.t === "id" || t.t === "num") v += t.v;
    else if (t.t === "p" && t.v === ".") v += ".";
    i++;
  }
  return { v, i };
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
      // Always move on, even past a token that is no value (a stray "}" or "]"). An empty value
      // (`x = )`) stops on the ")" or ",", which the loop handles.
      const stop = tk[r.i]?.t === "p" && (tk[r.i]!.v === ")" || tk[r.i]!.v === ",");
      j = r.i > j || stop ? r.i : j + 1;
    }
    j++;
  }
  return { a: { name, attrs, line: nameTok.line }, i: j };
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
    if (t.t === "id" && t.v === "package" && depth === 0 && !packageName) {
      let name = "";
      let j = i + 1;
      while (j < tk.length && !(tk[j]!.t === "p" && tk[j]!.v === ";"))
        name += (tk[j++] as { v: string }).v;
      packageName = name;
      i = j;
      continue;
    }
    if (t.t === "id" && t.v === "import" && depth === 0) {
      while (i < tk.length && !(tk[i]!.t === "p" && tk[i]!.v === ";")) i++;
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
        let j = i + 2;
        let pd = 0;
        let cur: string | undefined = "";
        let literalOnly = true;
        for (; j < tk.length; j++) {
          const x = tk[j]!;
          if (x.t === "p" && (x.v === "(" || x.v === "{" || x.v === "[")) pd++;
          if (x.t === "p" && (x.v === ")" || x.v === "}" || x.v === "]")) {
            if (pd === 0) break;
            pd--;
          }
          if (pd === 0 && x.t === "p" && x.v === ",") {
            args.push(literalOnly && cur !== "" ? cur : undefined);
            cur = "";
            literalOnly = true;
            continue;
          }
          if (pd === 0 && x.t === "str") cur += x.v;
          else if (pd === 0 && x.t === "p" && x.v === "+") continue;
          else literalOnly = false;
        }
        if (cur !== "" || args.length > 0) args.push(literalOnly && cur !== "" ? cur : undefined);
        const inMethod = currentMethod();
        const inType = currentType();
        calls.push({
          ...(receiver ? { receiver } : {}),
          method: t.v,
          args,
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
  return { ...(packageName ? { packageName } : {}), decls, calls };
}

/** A string attribute (the first item if it's a list). */
export function attr(a: Annotation | undefined, name = "value"): string | undefined {
  const v = a?.attrs[name];
  return Array.isArray(v) ? v[0] : v;
}

/** A list attribute (a single string becomes a one-item list). */
export function attrs(a: Annotation | undefined, name = "value"): string[] {
  const v = a?.attrs[name];
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

export function findAnnotation(d: Decl | undefined, ...names: string[]): Annotation | undefined {
  return d?.annotations.find((a) => names.includes(a.name));
}
