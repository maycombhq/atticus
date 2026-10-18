import type { CatalogRecord } from "@maycombhq/core";
import type { RepoHandle, ScanContext } from "@maycombhq/sdk";
import { componentOf, evidence, looseEnd, restEndpoint, type LooseEndKind } from "../facts.js";
import { lexSource, type SourceLang, type SrcTok } from "../lang/lexer.js";

/**
 * Shared machinery for the generic-tier backend extractors (.NET, Python, Go, Node): a
 * token-level view of one source file (calls with their arguments, simple assignments), a
 * string evaluator that resolves constants and config, a route-prefix graph, path and URL
 * joining, file filters and the component gap rule.
 */

// ------------------------------------------------------------------ files

const SKIP_DIRS =
  /(^|\/)(node_modules|vendor|bin|obj|dist|build|out|target|\.venv|venv|site-packages|__pycache__|testdata|coverage|\.git)\//;
const TEST_PATHS = [
  /(^|\/)(tests?|__tests__|spec|specs|e2e|__mocks__)\//,
  /_test\.go$/,
  /(^|\/)test_[^/]*\.py$/,
  /_test\.py$/,
  /(^|\/)conftest\.py$/,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /(^|\/)[^/]*\.(Unit|Integration|Functional|Acceptance)?Tests?(\.[^/]*)?\//,
];

/** True for files a backend extractor never reads: dependencies, build output and tests. */
export function skipPath(path: string): boolean {
  return SKIP_DIRS.test(path) || TEST_PATHS.some((re) => re.test(path));
}

export async function listSources(repo: RepoHandle, globs: string[]): Promise<string[]> {
  const out: string[] = [];
  for await (const p of repo.listFiles(globs)) if (!skipPath(p)) out.push(p);
  return out;
}

export const dirOf = (path: string) => (path.includes("/") ? path.replace(/\/[^/]*$/, "") : "");

export interface EnvValue {
  value: string;
  file: string;
  line: number;
}

/** Variables from `.env` files (`.env` first, then `.env.example` for anything missing). */
export async function dotenv(repo: RepoHandle): Promise<Map<string, EnvValue>> {
  const out = new Map<string, EnvValue>();
  const files: string[] = [];
  for await (const p of repo.listFiles([".env", "**/.env", ".env.example", "**/.env.example"]))
    if (!skipPath(p)) files.push(p);
  files.sort(
    (a, b) =>
      Number(a.endsWith(".example")) - Number(b.endsWith(".example")) ||
      a.split("/").length - b.split("/").length ||
      a.localeCompare(b),
  );
  for (const f of files) {
    (await repo.readText(f)).split(/\r?\n/).forEach((raw, i) => {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*?)\s*$/.exec(raw);
      if (!m || out.has(m[1]!)) return;
      let v = m[2]!;
      if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
      else v = v.replace(/\s+#.*$/, "");
      out.set(m[1]!, { value: v, file: f, line: i + 1 });
    });
  }
  return out;
}

// ------------------------------------------------------------------ calls and assignments

export interface Arg {
  /** Keyword (Python `name=`) or named (C# `name:`) argument. */
  name?: string;
  /** Token range [from, to). */
  from: number;
  to: number;
}

export interface SrcCall {
  /** The callee as written, dotted: "app.MapGet", "self.client.get". */
  callee: string;
  /** Last segment: "MapGet". */
  name: string;
  /** Everything before the last segment ("" when none or when chained). */
  recv: string;
  /** First token of the callee. */
  start: number;
  open: number;
  close: number;
  /** Line of the callee's name. */
  line: number;
  args: Arg[];
  /** The call this one is chained on: `x(...).name(...)`. */
  chained?: SrcCall;
  isNew: boolean;
  decorator: boolean;
  /** Type names inside `<...>` before the parenthesis: `AddHttpClient<LedgerClient>(`. */
  generics: string[];
}

/** Identifiers that may stand right before a call on the same line. */
const CALL_PREFIX = new Set([
  "return",
  "await",
  "new",
  "throw",
  "yield",
  "in",
  "of",
  "case",
  "else",
  "typeof",
  "not",
  "and",
  "or",
  "if",
  "elif",
  "while",
  "assert",
  "with",
  "go",
  "defer",
  "del",
  "is",
  "void",
  "delete",
  "default",
  "select",
  "where",
  "when",
  "do",
  "lambda",
  "from",
]);
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
const TYPEISH = new Set([".", ",", "?", "[", "]", "<", ">", "*", "&"]);

const CONTINUES = new Set([".", "?.", "+", "-", "*", "/", "?", "??", "||", "&&", ":", "=>", ","]);

export interface Assignment {
  /** Token index of the target's first token. */
  at: number;
  from: number;
  to: number;
}

/**
 * One source file as tokens, with bracket pairs, calls and simple assignments
 * (`NAME = expr`, `const NAME = expr`, `name := expr`, `const string NAME = "..."`).
 */
export class SourceFile {
  readonly toks: SrcTok[];
  readonly pairs: Int32Array;
  readonly calls: SrcCall[] = [];
  readonly assigns = new Map<string, Assignment[]>();
  private readonly byOpen = new Map<number, SrcCall>();
  private readonly byStart = new Map<number, SrcCall>();
  private readonly chainedBy = new Map<SrcCall, SrcCall>();

  constructor(
    readonly path: string,
    readonly text: string,
    readonly lang: SourceLang,
  ) {
    this.toks = lexSource(text, lang);
    this.pairs = matchBrackets(this.toks);
    this.findCalls();
    this.findAssignments();
  }

  tok(i: number): SrcTok | undefined {
    return this.toks[i];
  }
  is(i: number, v: string, t: SrcTok["t"] = "p"): boolean {
    const k = this.toks[i];
    return !!k && k.t === t && k.v === v;
  }
  callAtOpen(i: number) {
    return this.byOpen.get(i);
  }
  callAtStart(i: number) {
    return this.byStart.get(i);
  }
  /** The call chained on c: for `a.b(...).c(...)`, next(b) is c. */
  next(c: SrcCall): SrcCall | undefined {
    return this.chainedBy.get(c);
  }
  /** The single string literal of an argument, if the argument is exactly one. */
  str(a: Arg | undefined): string | undefined {
    if (!a || a.to - a.from !== 1) return undefined;
    const t = this.toks[a.from]!;
    return t.t === "str" && !t.interp ? t.v : undefined;
  }
  /** All string literals in a token range (for lists like `["GET", "POST"]`). */
  strings(from: number, to: number): { v: string; line: number }[] {
    const out: { v: string; line: number }[] = [];
    for (let k = from; k < to; k++) {
      const t = this.toks[k]!;
      if (t.t === "str" && !t.interp) out.push({ v: t.v, line: t.line });
    }
    return out;
  }
  arg(c: SrcCall, index: number, name?: string): Arg | undefined {
    if (name) {
      const named = c.args.find((a) => a.name === name);
      if (named) return named;
    }
    return c.args.filter((a) => !a.name)[index];
  }
  /** Dotted identifier text for a token range made only of ids and dots, else undefined. */
  dotted(from: number, to: number): string | undefined {
    let s = "";
    for (let k = from; k < to; k++) {
      const t = this.toks[k]!;
      const even = (k - from) % 2 === 0;
      if (even ? t.t !== "id" : !(t.t === "p" && (t.v === "." || t.v === "?."))) return undefined;
      s += even ? t.v : ".";
    }
    return (to - from) % 2 === 1 ? s : undefined;
  }
  /**
   * The variable a call's result is assigned to: `x = f()`, `const x = f()`, `x := f()`,
   * `var x = new F()`, `self.x = f()`, Python `with f() as x`. Chains count from their root.
   */
  assignedTo(c: SrcCall): string | undefined {
    let root = c;
    while (root.chained) root = root.chained;
    if (this.is(c.close + 1, "as", "id") && this.tok(c.close + 2)?.t === "id")
      return this.tok(c.close + 2)!.v;
    let s = root.start;
    while (
      s > 0 &&
      (["await", "new", "yield"].includes(this.tok(s - 1)?.v ?? "") || this.is(s - 1, "&"))
    )
      s--;
    if (!(this.is(s - 1, "=") || this.is(s - 1, ":="))) return undefined;
    let e = s - 1;
    let b = e - 1;
    while (b >= 0 && this.tok(b)?.t === "id" && (this.is(b - 1, ".") || this.is(b - 1, "?.")))
      b -= 2;
    let name = this.dotted(b, e);
    // Typed declarations: `const x: Foo = ...`, `x: Foo = ...`.
    if (name && this.is(b - 1, ":") && this.tok(b - 2)?.t === "id") {
      e = b - 1;
      b = e - 1;
      name = this.tok(b)!.v;
    }
    // Go `a, err := ...`: the first name.
    while (this.lang === "go" && this.is(b - 1, ",") && this.tok(b - 2)?.t === "id") {
      b -= 2;
      name = this.tok(b)!.v;
    }
    return name;
  }
  /**
   * The value range of `key: value` directly inside the braces opened at `open` (a JS
   * object literal or a Go composite literal). Keys may be identifiers or strings.
   */
  field(open: number, key: string): Arg | undefined {
    const close = this.pairs[open]!;
    if (close < 0) return undefined;
    let depth = 0;
    for (let k = open + 1; k < close; k++) {
      const t = this.toks[k]!;
      if (t.t === "p" && "([{".includes(t.v)) depth++;
      else if (t.t === "p" && ")]}".includes(t.v)) depth--;
      else if (
        depth === 0 &&
        (t.t === "id" || t.t === "str") &&
        t.v === key &&
        this.is(k + 1, ":") &&
        (k === open + 1 || this.is(k - 1, ","))
      ) {
        let end = k + 2;
        let d = 0;
        for (; end < close; end++) {
          const u = this.toks[end]!;
          if (u.t === "p" && "([{".includes(u.v)) d++;
          else if (u.t === "p" && ")]}".includes(u.v)) d--;
          else if (d === 0 && u.t === "p" && u.v === ",") break;
        }
        return { from: k + 2, to: end };
      }
    }
    return undefined;
  }
  /** The innermost `{...}` around token i, as [open, close]; the whole file when none. */
  blockOf(i: number): [number, number] {
    for (let k = i - 1; k >= 0; k--)
      if (this.is(k, "{") && this.pairs[k]! > i) return [k, this.pairs[k]!];
    return [-1, Number.MAX_SAFE_INTEGER];
  }
  /** End (exclusive) of the expression starting at `from`. */
  exprEnd(from: number): number {
    let depth = 0;
    let k = from;
    for (; k < this.toks.length; k++) {
      const t = this.toks[k]!;
      if (t.t === "p") {
        if ("([{".includes(t.v)) depth++;
        else if (")]}".includes(t.v)) {
          if (depth === 0) break;
          depth--;
        } else if (depth === 0 && (t.v === ";" || (t.v === "," && this.lang !== "python"))) break;
      }
      if (
        depth === 0 &&
        k > from &&
        this.lang !== "csharp" &&
        t.line > this.toks[k - 1]!.line &&
        !CONTINUES.has(t.v) &&
        !CONTINUES.has(this.toks[k - 1]!.v)
      )
        break;
    }
    return k;
  }

  private findCalls() {
    const toks = this.toks;
    const byClose = new Map<number, SrcCall>();
    for (let k = 0; k < toks.length; k++) {
      if (!(toks[k]!.t === "p" && toks[k]!.v === "(")) continue;
      let j = k - 1;
      let generics: string[] = [];
      if (this.is(j, ">")) {
        const lt = this.genericStart(j);
        if (lt === undefined || this.tok(lt - 1)?.t !== "id") continue;
        generics = toks
          .slice(lt + 1, j)
          .filter((t) => t.t === "id")
          .map((t) => t.v);
        j = lt - 1;
      }
      const nameTok = toks[j];
      if (!nameTok || nameTok.t !== "id" || NOT_CALLEE.has(nameTok.v)) continue;
      let start = j;
      let chained: SrcCall | undefined;
      let opaque = false;
      for (;;) {
        const dot = toks[start - 1];
        if (!dot || dot.t !== "p" || (dot.v !== "." && dot.v !== "?.")) break;
        let b = start - 2;
        if (this.is(b, "!")) b--;
        const prev = toks[b];
        if (prev?.t === "id") {
          start = b;
          continue;
        }
        if (prev && this.is(b, ")") && byClose.has(b)) chained = byClose.get(b);
        // A method on a string literal ("...".format(...)): kept, with no receiver name.
        else if (prev?.t !== "str") opaque = true;
        break;
      }
      if (opaque) continue;
      const before = toks[start - 1];
      const sameLine = before && before.line === toks[start]!.line;
      if (!chained && before && sameLine) {
        if (before.t === "id" && !CALL_PREFIX.has(before.v)) continue; // a declaration
        if (this.is(start - 1, "]")) continue; // `string[] Name(`
        if (this.is(start - 1, ">") && (this.lang === "csharp" || this.lang === "js")) {
          const lt = this.genericStart(start - 1);
          if (lt !== undefined && this.tok(lt - 1)?.t === "id") continue; // `Task<T> Name(`
        }
        if (this.lang === "go" && this.is(start - 1, ")")) {
          const o = this.pairs[start - 1]!;
          if (o >= 0 && this.is(o - 1, "func", "id")) continue; // `func (s *S) Name(`
        }
      }
      const close = this.pairs[k]!;
      if (close < 0) continue;
      const names: string[] = [];
      for (let x = start; x <= j; x += 2) names.push(toks[x]!.v);
      const call: SrcCall = {
        callee: names.join("."),
        name: nameTok.v,
        recv: names.slice(0, -1).join("."),
        start,
        open: k,
        close,
        line: nameTok.line,
        args: this.splitArgs(k, close),
        ...(chained ? { chained } : {}),
        isNew: !chained && !!before && before.t === "id" && before.v === "new",
        decorator: !chained && this.is(start - 1, "@"),
        generics,
      };
      this.calls.push(call);
      byClose.set(close, call);
      this.byOpen.set(k, call);
      if (chained) this.chainedBy.set(chained, call);
      if (!chained) this.byStart.set(start, call);
    }
  }

  /** For a `>` at index j, the index of the matching `<` when the span looks like type arguments. */
  private genericStart(j: number): number | undefined {
    let depth = 0;
    for (let k = j; k >= 0 && j - k < 40; k--) {
      const t = this.toks[k]!;
      if (t.t === "p") {
        if (t.v === ">") depth++;
        else if (t.v === "<") {
          depth--;
          if (depth === 0) return k;
        } else if (!TYPEISH.has(t.v)) return undefined;
      } else if (t.t !== "id") return undefined;
    }
    return undefined;
  }

  private splitArgs(open: number, close: number): Arg[] {
    const args: Arg[] = [];
    if (close === open + 1) return args;
    let from = open + 1;
    let depth = 0;
    const finish = (to: number) => {
      if (to <= from) return;
      const t0 = this.toks[from]!;
      const t1 = this.toks[from + 1];
      const named =
        t0.t === "id" &&
        t1?.t === "p" &&
        ((t1.v === "=" && this.lang === "python") || (t1.v === ":" && this.lang === "csharp")) &&
        from + 2 < to;
      args.push(named ? { name: t0.v, from: from + 2, to } : { from, to });
    };
    for (let k = open + 1; k < close; k++) {
      const t = this.toks[k]!;
      if (t.t !== "p") continue;
      if ("([{".includes(t.v)) depth++;
      else if (")]}".includes(t.v)) depth--;
      else if (t.v === "," && depth === 0) {
        finish(k);
        from = k + 1;
      }
    }
    finish(close);
    return args;
  }

  private findAssignments() {
    const toks = this.toks;
    const stack: { ch: string; block: boolean }[] = [];
    for (let k = 0; k < toks.length; k++) {
      const t = toks[k]!;
      if (t.t === "p" && "([{".includes(t.v)) {
        stack.push({ ch: t.v, block: t.v === "(" && /^(const|var)$/.test(toks[k - 1]?.v ?? "") });
        continue;
      }
      if (t.t === "p" && ")]}".includes(t.v)) {
        stack.pop();
        continue;
      }
      if (!(t.t === "p" && (t.v === "=" || t.v === ":="))) continue;
      const top = stack[stack.length - 1];
      if (top && top.ch === "(" && !top.block) continue;
      if (top && top.ch === "[") continue;
      let b = k - 1;
      if (toks[b]?.t !== "id") continue;
      while (toks[b - 2]?.t === "id" && (this.is(b - 1, ".") || this.is(b - 1, "?."))) b -= 2;
      const name = this.dotted(b, k);
      if (!name) continue;
      const end = this.exprEnd(k + 1);
      if (end <= k + 1) continue;
      const list = this.assigns.get(name) ?? [];
      list.push({ at: b, from: k + 1, to: end });
      this.assigns.set(name, list);
    }
  }
}

function matchBrackets(toks: SrcTok[]): Int32Array {
  const pairs = new Int32Array(toks.length).fill(-1);
  const stack: number[] = [];
  const open: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  toks.forEach((t, k) => {
    if (t.t !== "p") return;
    if (t.v === "(" || t.v === "[" || t.v === "{") stack.push(k);
    else if (open[t.v]) {
      // Tolerant: drop unmatched openers until the right kind is found.
      for (let s = stack.length - 1; s >= 0; s--) {
        if (toks[stack[s]!]!.v === open[t.v]) {
          pairs[k] = stack[s]!;
          pairs[stack[s]!] = k;
          stack.length = s;
          break;
        }
      }
    }
  });
  return pairs;
}

// ------------------------------------------------------------------ evaluation

export interface EvalHooks {
  /** Value of a dotted name not assigned in this file (env access, config, other files). */
  name?(dotted: string, at: number): string | undefined;
  /** Value of `recv["key"]`. */
  index?(recv: string, key: string): string | undefined;
  /** Value of a call expression, or undefined to fall back to the shared rules. */
  call?(c: SrcCall, ev: Evaluator): string | undefined;
}

/** Unresolved environment variables and config keys are written `${NAME}` (as Spring's are). */
export const unresolved = (name: string) => "${" + name + "}";

/**
 * Evaluates string expressions: literals, concatenation with `+`, interpolation, `??`, `||`
 * and Python `or` fallbacks, constants assigned in the file, and whatever the language's
 * hooks know (environment variables, config keys). Parts it can't know become `{name}`,
 * so `"/accounts/" + id` reads `/accounts/{id}`. Returns undefined when nothing in the
 * expression is a known string.
 */
export class Evaluator {
  private readonly visiting = new Set<number>();

  constructor(
    readonly file: SourceFile,
    readonly hooks: EvalHooks = {},
  ) {}

  arg(a: Arg | undefined): string | undefined {
    return a ? this.value(a.from, a.to) : undefined;
  }

  value(from: number, to: number): string | undefined {
    return this.eval(from, to)?.v;
  }

  /** Value of a name as seen at token `at`: the nearest assignment before it, else hooks. */
  lookup(name: string, at: number): string | undefined {
    const list = this.file.assigns.get(name);
    if (list) {
      const before = list.filter((a) => a.at < at);
      const a = before[before.length - 1] ?? list[0]!;
      if (!this.visiting.has(a.at) && this.visiting.size < 12) {
        this.visiting.add(a.at);
        try {
          const v = this.value(a.from, a.to);
          if (v !== undefined) return v;
        } finally {
          this.visiting.delete(a.at);
        }
      }
    }
    return this.hooks.name?.(name, at);
  }

  private eval(from: number, to: number): { v: string; known: boolean } | undefined {
    const f = this.file;
    // Trim wrappers that don't change the value.
    for (;;) {
      if (to <= from) return undefined;
      if (f.is(to - 1, "!") || f.is(to - 1, ";")) to--;
      else if (f.is(from, "await", "id") || (f.is(from, "new", "id") && f.callAtStart(from + 1)))
        from++;
      else if (f.is(to - 2, "as", "id") && f.tok(to - 1)?.t === "id") to -= 2;
      else if (f.is(from, "(") && f.pairs[from] === to - 1) {
        from++;
        to--;
      } else break;
    }
    // Fallbacks: a ?? b, a || b, a or b.
    const alt = this.splitTop(from, to, (t) =>
      t.t === "p" ? t.v === "??" || t.v === "||" : f.lang === "python" && t.v === "or",
    );
    if (alt.length > 1) {
      // The first alternative that is fully known wins; else the first that says anything.
      let fallback: { v: string; known: boolean } | undefined;
      for (const [a, b] of alt) {
        const r = this.eval(a, b);
        if (r && !r.v.includes("${")) return r;
        fallback ??= r;
      }
      return fallback;
    }
    const parts = this.splitTop(from, to, (t) => t.t === "p" && t.v === "+");
    let known = false;
    let out = "";
    for (const [a, b] of parts) {
      const r = this.part(a, b);
      if (!r) return undefined;
      known ||= r.known;
      out += r.v;
    }
    return known ? { v: out, known } : undefined;
  }

  private part(from: number, to: number): { v: string; known: boolean } | undefined {
    const f = this.file;
    const t0 = f.tok(from)!;
    if (to - from === 1 && t0.t === "str")
      return { v: t0.interp ? this.interpolate(t0.v, from) : t0.v, known: true };
    // Python "…".format(a, b)
    if (
      t0.t === "str" &&
      f.is(from + 1, ".") &&
      f.is(from + 2, "format", "id") &&
      f.is(from + 3, "(") &&
      f.pairs[from + 3] === to - 1
    ) {
      const c = f.callAtOpen(from + 3);
      const pos = (c?.args ?? []).filter((x) => !x.name);
      let n = 0;
      const v = t0.v.replace(/\{([A-Za-z_0-9]*)\}/g, (_w, key: string) => {
        const a =
          key === ""
            ? pos[n++]
            : /^\d+$/.test(key)
              ? pos[Number(key)]
              : c?.args.find((x) => x.name === key);
        return a ? (this.value(a.from, a.to) ?? `{${lastId(f, a.from, a.to)}}`) : `{${key}}`;
      });
      return { v, known: true };
    }
    const call = f.callAtStart(from);
    let tail = call;
    while (tail) {
      const next = f.next(tail);
      if (!next || next.close >= to) break;
      tail = next;
    }
    if (tail && tail.close === to - 1) {
      const v = this.callValue(tail);
      if (v !== undefined) return { v, known: true };
    }
    const dotted = f.dotted(from, to);
    if (dotted !== undefined) {
      const v = this.lookup(dotted, from);
      if (v !== undefined) return { v, known: true };
    }
    // recv["key"]
    if (f.is(to - 1, "]") && f.pairs[to - 1] === to - 3 && f.tok(to - 2)?.t === "str") {
      const recv = f.dotted(from, to - 3);
      if (recv !== undefined) {
        const v = this.hooks.index?.(recv, f.tok(to - 2)!.v);
        if (v !== undefined) return { v, known: true };
      }
    }
    const id = lastId(f, from, to);
    return id ? { v: `{${id}}`, known: false } : undefined;
  }

  private callValue(c: SrcCall): string | undefined {
    const hooked = this.hooks.call?.(c, this);
    if (hooked !== undefined) return hooked;
    const f = this.file;
    const a0 = f.arg(c, 0);
    if (["str", "String", "Uri", "URL", "string"].includes(c.callee) && c.args.length === 1)
      return this.arg(a0);
    if (c.callee === "Uri" && c.isNew) return this.arg(a0);
    if (
      c.callee === "fmt.Sprintf" ||
      c.callee === "string.Format" ||
      c.callee === "String.format"
    ) {
      const fmt = this.arg(a0);
      if (fmt === undefined) return undefined;
      const rest = c.args.slice(1);
      let n = 0;
      if (c.callee === "string.Format")
        return fmt.replace(/\{(\d+)[^}]*\}/g, (_w, i: string) => {
          const a = rest[Number(i)];
          return a ? (this.arg(a) ?? `{${lastId(f, a.from, a.to)}}`) : "{}";
        });
      return fmt.replace(/%[-+# 0-9.]*[svdqfx]/g, () => {
        const a = rest[n++];
        return a ? (this.arg(a) ?? `{${lastId(f, a.from, a.to)}}`) : "{}";
      });
    }
    if (c.name === "urljoin" && c.args.length === 2) {
      const base = this.arg(a0);
      const rel = this.arg(f.arg(c, 1));
      return base !== undefined && rel !== undefined ? joinUrl(base, rel) : undefined;
    }
    return undefined;
  }

  private interpolate(text: string, at: number): string {
    return text.replace(/\$\{((?:[^{}]|\{[^{}]*\})*)\}/g, (_w, expr: string) => {
      const sub = new SourceFile(this.file.path, expr, this.file.lang);
      const ev = new Evaluator(sub, {
        name: (n) => this.lookup(n, at),
        ...(this.hooks.index ? { index: this.hooks.index } : {}),
        ...(this.hooks.call ? { call: this.hooks.call } : {}),
      });
      const v = sub.toks.length ? ev.value(0, sub.toks.length) : undefined;
      if (v !== undefined) return v;
      const ids = sub.toks.filter((t) => t.t === "id");
      return `{${ids[ids.length - 1]?.v ?? ""}}`;
    });
  }

  private splitTop(from: number, to: number, sep: (t: SrcTok) => boolean): [number, number][] {
    const out: [number, number][] = [];
    let depth = 0;
    let a = from;
    for (let k = from; k < to; k++) {
      const t = this.file.tok(k)!;
      if (t.t === "p" && "([{".includes(t.v)) depth++;
      else if (t.t === "p" && ")]}".includes(t.v)) depth--;
      else if (depth === 0 && sep(t)) {
        out.push([a, k]);
        a = k + 1;
      }
    }
    out.push([a, to]);
    return out;
  }
}

function lastId(f: SourceFile, from: number, to: number): string | undefined {
  for (let k = to - 1; k >= from; k--) {
    const t = f.tok(k)!;
    if (t.t === "id" && !["await", "new", "as", "this", "self"].includes(t.v)) return t.v;
  }
  return undefined;
}

// ------------------------------------------------------------------ paths and URLs

/**
 * Join route segments: one slash between parts, a leading slash, no trailing slash except
 * for the root. An absolute URL in a later part replaces what came before.
 */
export function joinPath(...parts: (string | undefined)[]): string {
  let out = "";
  for (const p of parts) {
    if (!p) continue;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) out = p;
    else out = `${out.replace(/\/+$/, "")}/${p.replace(/^\/+/, "")}`;
  }
  out = out.replace(/\/+$/, "");
  if (out === "") return "/";
  return out.startsWith("/") || /^[a-z][a-z0-9+.-]*:\/\//i.test(out) ? out : `/${out}`;
}

/** Base URL plus a request path, as clients concatenate them; absolute paths win. */
export function joinUrl(base: string | undefined, path: string): string {
  if (!base || /^[a-z][a-z0-9+.-]*:\/\//i.test(path) || path.startsWith("${")) return path;
  if (path === "") return base;
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/** A database URL without credentials or query parameters: `scheme://host:port/db`. */
export function cleanDbUrl(url: string): string | undefined {
  const m = /^([a-z][a-z0-9+.-]*:\/\/)(?:[^@/?#]*@)?([^/?#]*)([^?#]*)/i.exec(url.trim());
  if (!m || !m[2]) return undefined;
  return `${m[1]!.toLowerCase()}${m[2]}${m[3]}`;
}

/**
 * A connection string as a database URL without credentials: URLs are cleaned, and
 * key=value strings (`Host=db;Port=5432;Database=x`, `host=db dbname=x`) are rebuilt as
 * `scheme://host:port/database`. Undefined when no host is named.
 */
export function connectionUrl(raw: string, scheme: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw.trim())) return cleanDbUrl(raw);
  const kv = new Map<string, string>();
  for (const part of raw.includes(";") ? raw.split(";") : raw.split(/\s+/)) {
    const i = part.indexOf("=");
    if (i > 0)
      kv.set(part.slice(0, i).trim().toLowerCase().replace(/\s+/g, ""), part.slice(i + 1).trim());
  }
  let host =
    kv.get("host") ??
    kv.get("server") ??
    kv.get("datasource") ??
    kv.get("address") ??
    kv.get("addr") ??
    kv.get("networkaddress");
  if (!host) return undefined;
  host = host.replace(/^tcp:/i, "");
  let port = kv.get("port");
  const comma = /^([^,]+),\s*(\d+)$/.exec(host);
  if (comma) {
    host = comma[1]!;
    port ??= comma[2];
  }
  const db = kv.get("database") ?? kv.get("initialcatalog") ?? kv.get("dbname");
  return `${scheme}://${host}${port ? `:${port}` : ""}${db ? `/${db}` : ""}`;
}

/** Route prefixes through routers, groups, blueprints and mounts. */
export class RouteGraph {
  private readonly own = new Map<string, string>();
  private readonly edges = new Map<string, { parent: string; seg: string; replace: boolean }[]>();

  node(id: string, own = ""): string {
    if (!this.own.has(id)) this.own.set(id, own);
    return id;
  }
  has(id: string): boolean {
    return this.own.has(id);
  }
  setOwn(id: string, own: string) {
    this.own.set(id, own);
  }
  /** child's prefix = parent's prefix + seg + child's own segment (or seg alone when it replaces it). */
  edge(child: string, parent: string, seg = "", replace = false) {
    this.node(child);
    const list = this.edges.get(child) ?? [];
    if (!list.some((e) => e.parent === parent && e.seg === seg && e.replace === replace))
      list.push({ parent, seg, replace });
    this.edges.set(child, list);
  }
  prefixes(id: string, seen: ReadonlySet<string> = new Set()): string[] {
    const own = this.own.get(id) ?? "";
    const list = this.edges.get(id) ?? [];
    if (list.length === 0 || seen.has(id) || seen.size > 16) return [joinPath(own)];
    const next = new Set(seen).add(id);
    const out = new Set<string>();
    for (const e of list)
      for (const p of this.prefixes(e.parent, next))
        out.add(joinPath(p, e.seg, e.replace ? "" : own));
    return [...out];
  }
}

/** Variables naming routers, with the token span where each name means that router. */
export class Scopes {
  private readonly defs: { name: string; node: string; from: number; to: number }[] = [];
  define(name: string, node: string, from: number, to = Number.MAX_SAFE_INTEGER) {
    this.defs.push({ name, node, from, to });
  }
  lookup(name: string, at: number): string | undefined {
    let best: { from: number; node: string } | undefined;
    for (const d of this.defs)
      if (d.name === name && d.from <= at && at <= d.to && (!best || d.from >= best.from)) best = d;
    return best?.node;
  }
}

// ------------------------------------------------------------------ records

/** Emits records once each, so the runner never sees the same id twice from one extractor. */
export class Emitter {
  private readonly seen = new Set<string>();
  readonly out: CatalogRecord[] = [];
  constructor(
    readonly repo: RepoHandle,
    readonly ctx: ScanContext,
  ) {}
  private add(r: CatalogRecord) {
    const key = `${r.kind}/${r.id}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.out.push(r);
  }
  endpoint(method: string, path: string, file: string, line: number) {
    this.add(
      restEndpoint(this.repo, componentOf(this.repo, this.ctx), method, path, {
        source: "code",
        path: file,
        line,
        side: "callee",
      }),
    );
  }
  call(method: string, url: string, file: string, line: number) {
    this.loose("http-call", `${method.toUpperCase()} ${url}`, file, line, "caller");
  }
  loose(
    kind: LooseEndKind,
    raw: string,
    file: string,
    line: number,
    side: "caller" | "callee",
    source: "code" | "config" = "code",
  ) {
    this.add(looseEnd(this.repo, this.ctx, kind, raw, { source, path: file, line, side }));
  }
  record(r: CatalogRecord) {
    this.add(r);
  }
  has(kind: string, raw: string): boolean {
    return this.out.some(
      (r) =>
        r.kind === "Unresolved" &&
        (r as unknown as { unresolvedKind: string; raw: string }).unresolvedKind === kind &&
        (r as unknown as { raw: string }).raw === raw,
    );
  }
}

// ------------------------------------------------------------------ component gap

// These mirror the generic component extractor in ../more.ts (root build files, then source
// under src/). A backend extractor names the component only where that one finds nothing.
const COMPONENT_BUILD_FILES = [
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "package.json",
  "go.mod",
  "pyproject.toml",
  "requirements.txt",
  "*.csproj",
  "forge.yaml",
];
const COMPONENT_SOURCES = [
  "src/**/*.java",
  "src/**/*.kt",
  "src/**/*.ts",
  "src/**/*.js",
  "src/**/*.py",
  "src/**/*.go",
  "src/**/*.cs",
];
const NOT_COMPONENTS = new Set(["gateway", "event-config", "infra", "library", "docs"]);

export type BackendLang = "dotnet" | "go" | "node" | "python";
const GAP_ORDER: BackendLang[] = ["dotnet", "go", "node", "python"];

export const SERVER_PACKAGES = [
  "express",
  "fastify",
  "@nestjs/core",
  "@nestjs/common",
  "koa",
  "@koa/router",
  "koa-router",
  "@hapi/hapi",
  "hapi",
  "restify",
];

/** package.json files (outside node_modules) whose dependencies include a server framework. */
export async function serverPackages(repo: RepoHandle): Promise<string[]> {
  const out: string[] = [];
  for await (const p of repo.listFiles(["package.json", "**/package.json"])) {
    if (skipPath(p)) continue;
    let deps: Record<string, unknown> = {};
    try {
      const json = JSON.parse(await repo.readText(p)) as { dependencies?: Record<string, unknown> };
      deps = json.dependencies ?? {};
    } catch {
      continue;
    }
    if (SERVER_PACKAGES.some((d) => d in deps)) out.push(p);
  }
  return out;
}

async function first(repo: RepoHandle, globs: string[]): Promise<string | undefined> {
  for await (const p of repo.listFiles(globs)) if (!skipPath(p)) return p;
  return undefined;
}

async function gapMarker(lang: BackendLang, repo: RepoHandle): Promise<string | undefined> {
  switch (lang) {
    case "dotnet":
      return (await first(repo, ["**/*.csproj"])) ?? (await first(repo, ["*.sln", "**/*.sln"]));
    case "go":
      return first(repo, ["**/go.mod"]);
    case "node":
      return (await serverPackages(repo))[0];
    case "python":
      return first(repo, [
        "**/setup.py",
        "**/setup.cfg",
        "**/pyproject.toml",
        "**/Pipfile",
        "**/requirements*.txt",
        "**/manage.py",
      ]);
  }
}

/**
 * The Component for this repo, when the generic component extractor would emit none (no
 * build file at the root and no source under src/) and this language is the first backend
 * language with a project file here. This way every repo gets exactly one Component.
 */
export async function componentGap(
  lang: BackendLang,
  repo: RepoHandle,
  ctx: ScanContext,
): Promise<CatalogRecord | undefined> {
  if (ctx.repoType && NOT_COMPONENTS.has(ctx.repoType)) return undefined;
  for await (const _ of repo.listFiles([...COMPONENT_BUILD_FILES, ...COMPONENT_SOURCES]))
    return undefined;
  for (const l of GAP_ORDER) {
    const marker = await gapMarker(l, repo);
    if (!marker) continue;
    if (l !== lang) return undefined;
    const id = componentOf(repo, ctx);
    return {
      schemaVersion: 1,
      kind: "Component",
      id,
      status: "current",
      confidence: "verified",
      system: ctx.system ?? id,
      repo: repo.name,
      type: ctx.repoType ?? "unknown",
      evidence: [evidence(repo, { source: "config", path: marker })],
    } as unknown as CatalogRecord;
  }
  return undefined;
}
