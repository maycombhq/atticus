import { stringify } from "yaml";

/**
 * A small, safe reader for Go `text/template` as Helm uses it (ADR 0064). A tokenizer splits
 * the text into literal text and `{{ }}` actions, a parser builds the action tree (pipelines,
 * `if`/`else`, `range`, `with`, `define`, `template`), and an evaluator runs it over plain data.
 * Only a fixed set of functions is known; anything else (`tpl`, `lookup`, `.Files`,
 * `.Capabilities`, `sha256sum`, ...) evaluates to UNKNOWN. An unknown value in output text
 * becomes a marker the caller removes after parsing, so a field is left out, never guessed. A
 * condition or range that can't be evaluated makes the whole template unreadable
 * (`TemplateUnreadable`): which objects it gives depends on it.
 */

export const UNKNOWN: unique symbol = Symbol("unknown");
export type Val = unknown;

/** What an unknown value prints as. The caller drops any scalar or key containing it. */
export const UNKNOWN_MARK = "ATTICUS-UNKNOWN-VALUE";

export class TemplateUnreadable extends Error {
  constructor(
    message: string,
    /** Offset in the template text where reading stopped, when known. */
    readonly pos?: number,
  ) {
    super(message);
  }
}

// ------------------------------------------------------------------ tokens

type Tok =
  | { k: "str"; v: string }
  | { k: "num"; v: number }
  | { k: "bool"; v: boolean }
  | { k: "nil" }
  | { k: "field"; path: string[] } // `.a.b`; `.` alone has an empty path
  | { k: "var"; name: string; path: string[] } // `$`, `$x`, `$x.a`
  | { k: "id"; v: string }
  | { k: "punct"; v: "|" | "(" | ")" | "," | ":=" | "=" };

interface RawItem {
  kind: "text" | "action";
  text: string;
  /** Offset of the text (or of the action's `{{`) in the template. */
  pos: number;
  toks?: Tok[];
}

const isSpace = (c: string | undefined) => c === " " || c === "\t" || c === "\n" || c === "\r";
const isIdStart = (c: string | undefined) => !!c && /[A-Za-z_]/.test(c);
const isIdChar = (c: string | undefined) => !!c && /[A-Za-z0-9_]/.test(c);
const isDigit = (c: string | undefined) => !!c && c >= "0" && c <= "9";

/** Split a template into text and tokenised actions, applying `{{-` and `-}}` trimming. */
export function lex(src: string): RawItem[] {
  const items: RawItem[] = [];
  let i = 0;
  let trimNext = false;
  while (i < src.length) {
    const open = src.indexOf("{{", i);
    let text = src.slice(i, open < 0 ? src.length : open);
    let textPos = i;
    if (trimNext) {
      const before = text.length;
      text = text.replace(/^[ \t\r\n]+/, "");
      textPos += before - text.length;
      trimNext = false;
    }
    if (open < 0) {
      if (text) items.push({ kind: "text", text, pos: textPos });
      break;
    }
    let j = open + 2;
    if (src[j] === "-" && isSpace(src[j + 1])) {
      text = text.replace(/[ \t\r\n]+$/, "");
      j += 1;
    }
    if (text) items.push({ kind: "text", text, pos: textPos });
    // A comment: {{/* ... */}}
    let k = j;
    while (isSpace(src[k])) k++;
    if (src.startsWith("/*", k)) {
      const end = src.indexOf("*/", k + 2);
      if (end < 0) throw new TemplateUnreadable("unclosed comment", open);
      let m = end + 2;
      while (isSpace(src[m])) m++;
      if (src[m] === "-" && src.startsWith("}}", m + 1)) {
        trimNext = true;
        m += 1;
      }
      if (!src.startsWith("}}", m)) throw new TemplateUnreadable("unclosed comment", open);
      i = m + 2;
      continue;
    }
    const { toks, end, trim } = lexAction(src, j, open);
    trimNext = trim;
    items.push({ kind: "action", text: src.slice(open, end), pos: open, toks });
    i = end;
  }
  return items;
}

function lexAction(src: string, start: number, open: number) {
  const toks: Tok[] = [];
  let i = start;
  const name = () => {
    const s = i;
    while (isIdChar(src[i])) i++;
    return src.slice(s, i);
  };
  const chain = (): string[] => {
    const path: string[] = [];
    while (src[i] === "." && isIdStart(src[i + 1])) {
      i++;
      path.push(name());
    }
    return path;
  };
  for (;;) {
    while (isSpace(src[i])) i++;
    if (i >= src.length) throw new TemplateUnreadable("unclosed action", open);
    if (src[i] === "-" && src.startsWith("}}", i + 1) && isSpace(src[i - 1]))
      return { toks, end: i + 3, trim: true };
    if (src.startsWith("}}", i)) return { toks, end: i + 2, trim: false };
    const c = src[i]!;
    if (c === '"') {
      let s = "";
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\n") throw new TemplateUnreadable("unterminated string", open);
        if (src[i] === "\\") {
          const e = src[i + 1];
          s += e === "n" ? "\n" : e === "t" ? "\t" : e === "r" ? "\r" : (e ?? "");
          i += 2;
        } else s += src[i++];
      }
      if (src[i] !== '"') throw new TemplateUnreadable("unterminated string", open);
      i++;
      toks.push({ k: "str", v: s });
    } else if (c === "`") {
      const end = src.indexOf("`", i + 1);
      if (end < 0) throw new TemplateUnreadable("unterminated string", open);
      toks.push({ k: "str", v: src.slice(i + 1, end) });
      i = end + 1;
    } else if (c === "." && !isDigit(src[i + 1])) {
      if (isIdStart(src[i + 1])) toks.push({ k: "field", path: chain() });
      else {
        i++;
        toks.push({ k: "field", path: [] });
      }
    } else if (c === "$") {
      i++;
      const n = name();
      toks.push({ k: "var", name: n, path: chain() });
    } else if (isDigit(c) || ((c === "-" || c === "+" || c === ".") && isDigit(src[i + 1]))) {
      const s = i;
      i++;
      while (/[0-9.eExXa-fA-F_+-]/.test(src[i] ?? "") && !src.startsWith("}}", i)) {
        if ((src[i] === "-" || src[i] === "+") && !/[eE]/.test(src[i - 1] ?? "")) break;
        i++;
      }
      const v = Number(src.slice(s, i).replace(/_/g, ""));
      if (Number.isNaN(v)) throw new TemplateUnreadable("bad number", open);
      toks.push({ k: "num", v });
    } else if (isIdStart(c)) {
      const n = name();
      if (n === "true" || n === "false") toks.push({ k: "bool", v: n === "true" });
      else if (n === "nil") toks.push({ k: "nil" });
      else toks.push({ k: "id", v: n });
    } else if (src.startsWith(":=", i)) {
      toks.push({ k: "punct", v: ":=" });
      i += 2;
    } else if (c === "|" || c === "(" || c === ")" || c === "," || c === "=") {
      toks.push({ k: "punct", v: c });
      i++;
      // `(...).field` is not read.
      if (c === ")" && src[i] === "." && isIdStart(src[i + 1]))
        throw new TemplateUnreadable("field of a parenthesised value", open);
    } else throw new TemplateUnreadable(`unexpected character ${JSON.stringify(c)}`, open);
  }
}

// ------------------------------------------------------------------ tree

type Arg =
  | { a: "lit"; v: Val }
  | { a: "field"; path: string[] }
  | { a: "var"; name: string; path: string[] }
  | { a: "fn"; name: string }
  | { a: "pipe"; pipe: Pipe };

interface Pipe {
  decl?: string[];
  assign?: boolean;
  cmds: Arg[][];
}

type Node =
  | { n: "text"; text: string; pos: number }
  | { n: "out"; pipe: Pipe; pos: number }
  | { n: "if"; branches: { cond: Pipe; body: Node[] }[]; otherwise?: Node[]; pos: number }
  | { n: "range"; pipe: Pipe; body: Node[]; otherwise?: Node[]; pos: number }
  | { n: "with"; pipe: Pipe; body: Node[]; otherwise?: Node[]; pos: number }
  | { n: "template"; name: string; pipe?: Pipe; pos: number };

export type TemplateNode = Node;

export interface Template {
  nodes: Node[];
  defines: Map<string, Node[]>;
}

/** Parse a template. Throws TemplateUnreadable on syntax this reader doesn't know. */
export function parseTemplate(src: string): Template {
  const items = lex(src);
  const defines = new Map<string, Node[]>();
  let i = 0;

  const pipeOf = (toks: Tok[], pos: number): Pipe => {
    let t = toks;
    let decl: string[] | undefined;
    let assign = false;
    // `$a := ...`, `$a, $b := ...`, `$a = ...`
    const assignAt = t.findIndex((x) => x.k === "punct" && (x.v === ":=" || x.v === "="));
    if (
      assignAt > 0 &&
      t.slice(0, assignAt).every((x) => x.k === "var" || (x.k === "punct" && x.v === ","))
    ) {
      decl = t.slice(0, assignAt).flatMap((x) => (x.k === "var" ? [x.name] : []));
      assign = (t[assignAt] as { v: string }).v === "=";
      t = t.slice(assignAt + 1);
    }
    let p = 0;
    const parsePipe = (stopAtParen: boolean): Pipe => {
      const cmds: Arg[][] = [];
      let cmd: Arg[] = [];
      while (p < t.length) {
        const x = t[p]!;
        if (x.k === "punct" && x.v === ")") {
          if (!stopAtParen) throw new TemplateUnreadable("unbalanced parenthesis", pos);
          break;
        }
        p++;
        if (x.k === "punct" && x.v === "|") {
          if (cmd.length === 0) throw new TemplateUnreadable("empty command", pos);
          cmds.push(cmd);
          cmd = [];
        } else if (x.k === "punct" && x.v === "(") {
          const inner = parsePipe(true);
          if (!(t[p]?.k === "punct" && (t[p] as { v: string }).v === ")"))
            throw new TemplateUnreadable("unbalanced parenthesis", pos);
          p++;
          cmd.push({ a: "pipe", pipe: inner });
        } else if (x.k === "punct") throw new TemplateUnreadable(`unexpected ${x.v}`, pos);
        else if (x.k === "str" || x.k === "num" || x.k === "bool") cmd.push({ a: "lit", v: x.v });
        else if (x.k === "nil") cmd.push({ a: "lit", v: null });
        else if (x.k === "field") cmd.push({ a: "field", path: x.path });
        else if (x.k === "var") cmd.push({ a: "var", name: x.name, path: x.path });
        else cmd.push({ a: "fn", name: x.v });
      }
      if (cmd.length === 0) throw new TemplateUnreadable("empty command", pos);
      cmds.push(cmd);
      return { cmds };
    };
    const pipe = parsePipe(false);
    if (p !== t.length) throw new TemplateUnreadable("unbalanced parenthesis", pos);
    return { ...(decl ? { decl, assign } : {}), cmds: pipe.cmds };
  };

  const keyword = (it: RawItem) =>
    it.kind === "action" && it.toks![0]?.k === "id" ? (it.toks![0] as { v: string }).v : undefined;

  /** Parse nodes until one of `stops` (else, end); returns the stopping item. */
  const parseList = (stops: Set<string>): { nodes: Node[]; stop?: RawItem } => {
    const nodes: Node[] = [];
    while (i < items.length) {
      const it = items[i++]!;
      if (it.kind === "text") {
        nodes.push({ n: "text", text: it.text, pos: it.pos });
        continue;
      }
      const toks = it.toks!;
      const kw = keyword(it);
      if (kw && stops.has(kw)) return { nodes, stop: it };
      if (toks.length === 0) throw new TemplateUnreadable("empty action", it.pos);
      if (kw === "if" || kw === "with" || kw === "range") {
        nodes.push(parseBlock(kw, it));
      } else if (kw === "define" || kw === "block") {
        const nameTok = toks[1];
        if (nameTok?.k !== "str") throw new TemplateUnreadable(`${kw} without a name`, it.pos);
        const body = parseList(new Set(["end"]));
        if (!body.stop) throw new TemplateUnreadable(`${kw} without end`, it.pos);
        defines.set(nameTok.v, body.nodes);
        if (kw === "block")
          nodes.push({
            n: "template",
            name: nameTok.v,
            ...(toks.length > 2 ? { pipe: pipeOf(toks.slice(2), it.pos) } : {}),
            pos: it.pos,
          });
      } else if (kw === "template") {
        const nameTok = toks[1];
        if (nameTok?.k !== "str") throw new TemplateUnreadable("template without a name", it.pos);
        nodes.push({
          n: "template",
          name: nameTok.v,
          ...(toks.length > 2 ? { pipe: pipeOf(toks.slice(2), it.pos) } : {}),
          pos: it.pos,
        });
      } else if (kw === "else" || kw === "end") {
        throw new TemplateUnreadable(`unexpected ${kw}`, it.pos);
      } else if (kw === "break" || kw === "continue") {
        throw new TemplateUnreadable(`${kw} is not read`, it.pos);
      } else nodes.push({ n: "out", pipe: pipeOf(toks, it.pos), pos: it.pos });
    }
    return { nodes };
  };

  const parseBlock = (kw: "if" | "with" | "range", it: RawItem): Node => {
    const branches: { cond: Pipe; body: Node[] }[] = [];
    let cond = pipeOf(it.toks!.slice(1), it.pos);
    let otherwise: Node[] | undefined;
    for (;;) {
      const r = parseList(new Set(["else", "end"]));
      if (!r.stop) throw new TemplateUnreadable(`${kw} without end`, it.pos);
      branches.push({ cond, body: r.nodes });
      if (keyword(r.stop) === "end") break;
      const rest = r.stop.toks!.slice(1);
      if (rest[0]?.k === "id" && rest[0].v === "if" && kw === "if") {
        cond = pipeOf(rest.slice(1), r.stop.pos);
        continue;
      }
      if (rest.length > 0) throw new TemplateUnreadable("else with a condition", r.stop.pos);
      const e = parseList(new Set(["end"]));
      if (!e.stop) throw new TemplateUnreadable(`${kw} without end`, it.pos);
      otherwise = e.nodes;
      break;
    }
    if (kw === "if") return { n: "if", branches, ...(otherwise ? { otherwise } : {}), pos: it.pos };
    return {
      n: kw,
      pipe: branches[0]!.cond,
      body: branches[0]!.body,
      ...(otherwise ? { otherwise } : {}),
      pos: it.pos,
    };
  };

  const top = parseList(new Set());
  return { nodes: top.nodes, defines };
}

// ------------------------------------------------------------------ output

/** Rendered text with, for each output line, the template line it came from. */
export class Output {
  private parts: { text: string; pos: number; literal: boolean }[] = [];
  push(text: string, pos: number, literal: boolean) {
    if (text) this.parts.push({ text, pos, literal });
  }
  text(): string {
    return this.parts.map((p) => p.text).join("");
  }
  /** lines[i] is the 1-based template line of output line i + 1. */
  lines(src: string): number[] {
    const starts: number[] = [0];
    for (let i = 0; i < src.length; i++) if (src[i] === "\n") starts.push(i + 1);
    const lineOf = (pos: number) => {
      let lo = 0;
      let hi = starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid]! <= pos) lo = mid;
        else hi = mid - 1;
      }
      return lo + 1;
    };
    const out: number[] = [];
    let pending = true;
    for (const p of this.parts) {
      if (pending) {
        out.push(lineOf(p.pos));
        pending = false;
      }
      for (let i = 0; i < p.text.length; i++)
        if (p.text[i] === "\n") {
          if (i + 1 < p.text.length) out.push(lineOf(p.literal ? p.pos + i + 1 : p.pos));
          else pending = true;
        }
    }
    return out;
  }
}

// ------------------------------------------------------------------ values

const isMap = (v: Val): v is Record<string, Val> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

const truthy = (v: Val): boolean => {
  if (v === UNKNOWN) throw new TemplateUnreadable("a condition depends on an unknown value");
  if (v === null || v === undefined || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (isMap(v)) return Object.keys(v).length > 0;
  return true;
};

const empty = (v: Val) => !truthy(v);

/** Go's %v of a value, as Helm prints it; UNKNOWN when this reader can't print it exactly. */
function show(v: Val): string | typeof UNKNOWN {
  if (v === UNKNOWN) return UNKNOWN;
  if (v === null || v === undefined) return ""; // Helm prints a missing value as nothing.
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    // Helm reads values as float64: 1e6 and up print in exponent form. Not reproduced here.
    if (!Number.isFinite(v) || Math.abs(v) >= 1e6 || (v !== 0 && Math.abs(v) < 1e-4))
      return UNKNOWN;
    return String(v);
  }
  return UNKNOWN; // maps and lists print in Go syntax nobody writes into YAML on purpose
}

const text = (v: Val): string | typeof UNKNOWN => show(v);

function toYaml(v: Val): string | typeof UNKNOWN {
  const bad = (x: Val): boolean =>
    x === UNKNOWN ||
    (Array.isArray(x) ? x.some(bad) : isMap(x) ? Object.values(x).some(bad) : false);
  if (bad(v)) return UNKNOWN;
  if (v === null || v === undefined) return "null";
  return stringify(v, { lineWidth: 0 }).replace(/\n$/, "");
}

const indentText = (n: number, s: string) =>
  s
    .split("\n")
    .map((l) => " ".repeat(n) + l)
    .join("\n");

type Fn = (args: Val[], ev: Evaluator) => Val;

const known =
  (f: (...args: Val[]) => Val): Fn =>
  (args) =>
    args.some((a) => a === UNKNOWN) ? UNKNOWN : f(...args);

const strArg = (v: Val) => {
  const s = text(v);
  return s;
};

const num = (v: Val): number | undefined =>
  typeof v === "number" ? v : typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : undefined;

function sprintf(fmt: string, args: Val[]): string | typeof UNKNOWN {
  let out = "";
  let ai = 0;
  for (let i = 0; i < fmt.length; i++) {
    const c = fmt[i]!;
    if (c !== "%") {
      out += c;
      continue;
    }
    const verb = fmt[++i];
    if (verb === "%") {
      out += "%";
      continue;
    }
    const a = args[ai++];
    if (verb === "s" || verb === "v" || verb === "d") {
      const s = show(a);
      if (s === UNKNOWN) return UNKNOWN;
      if (verb === "d" && num(a) === undefined) return UNKNOWN;
      out += s;
    } else if (verb === "q") {
      const s = show(a);
      if (s === UNKNOWN) return UNKNOWN;
      out += JSON.stringify(s);
    } else return UNKNOWN;
  }
  return ai === args.length ? out : UNKNOWN;
}

const FUNCS: Record<string, Fn> = {
  default: (args) => {
    if (args.length !== 2) return UNKNOWN;
    const [d, v] = args;
    if (v === UNKNOWN) return UNKNOWN;
    return empty(v) ? d : v;
  },
  quote: known((...args) => {
    const parts: string[] = [];
    for (const a of args) {
      if (a === null || a === undefined) continue;
      const s = show(a);
      if (s === UNKNOWN) return UNKNOWN;
      parts.push(JSON.stringify(s));
    }
    return parts.join(" ");
  }),
  squote: known((...args) => {
    const parts: string[] = [];
    for (const a of args) {
      if (a === null || a === undefined) continue;
      const s = show(a);
      if (s === UNKNOWN) return UNKNOWN;
      parts.push(`'${s}'`);
    }
    return parts.join(" ");
  }),
  upper: known((s) => mapStr(s, (x) => x.toUpperCase())),
  lower: known((s) => mapStr(s, (x) => x.toLowerCase())),
  trim: known((s) => mapStr(s, (x) => x.trim())),
  toString: known((s) => strArg(s)),
  trunc: known((n, s) => {
    const k = num(n);
    if (k === undefined) return UNKNOWN;
    return mapStr(s, (x) => (k >= 0 ? x.slice(0, k) : x.slice(Math.max(0, x.length + k))));
  }),
  trimSuffix: known((suf, s) =>
    mapStr(s, (x) => {
      const t = show(suf);
      return typeof t === "string" && t && x.endsWith(t) ? x.slice(0, -t.length) : x;
    }),
  ),
  trimPrefix: known((pre, s) =>
    mapStr(s, (x) => {
      const t = show(pre);
      return typeof t === "string" && x.startsWith(t) ? x.slice(t.length) : x;
    }),
  ),
  replace: known((from, to, s) => {
    const f = show(from);
    const t = show(to);
    if (f === UNKNOWN || t === UNKNOWN) return UNKNOWN;
    return mapStr(s, (x) => (f ? x.split(f).join(t) : x));
  }),
  contains: known((sub, s) => {
    const a = show(sub);
    const b = show(s);
    return a === UNKNOWN || b === UNKNOWN ? UNKNOWN : b.includes(a);
  }),
  hasPrefix: known((pre, s) => {
    const a = show(pre);
    const b = show(s);
    return a === UNKNOWN || b === UNKNOWN ? UNKNOWN : b.startsWith(a);
  }),
  hasSuffix: known((suf, s) => {
    const a = show(suf);
    const b = show(s);
    return a === UNKNOWN || b === UNKNOWN ? UNKNOWN : b.endsWith(a);
  }),
  printf: known((fmt, ...args) => (typeof fmt === "string" ? sprintf(fmt, args) : UNKNOWN)),
  print: known((...args) => {
    const parts = args.map(show);
    return parts.includes(UNKNOWN) ? UNKNOWN : parts.join("");
  }),
  toYaml: known((v) => toYaml(v)),
  nindent: known((n, s) => {
    const k = num(n);
    const t = show(s);
    return k === undefined || t === UNKNOWN ? UNKNOWN : `\n${indentText(k, t)}`;
  }),
  indent: known((n, s) => {
    const k = num(n);
    const t = show(s);
    return k === undefined || t === UNKNOWN ? UNKNOWN : indentText(k, t);
  }),
  not: known((v) => !truthy(v)),
  and: (args) => {
    let last: Val = true;
    for (const a of args) {
      if (a === UNKNOWN) return UNKNOWN;
      if (!truthy(a)) return a;
      last = a;
    }
    return last;
  },
  or: (args) => {
    let last: Val = false;
    for (const a of args) {
      if (a === UNKNOWN) return UNKNOWN;
      if (truthy(a)) return a;
      last = a;
    }
    return last;
  },
  eq: known((a, ...rest) => rest.some((b) => same(a, b))),
  ne: known((a, b) => !same(a, b)),
  empty: known((v) => empty(v)),
  hasKey: known((m, k) => (isMap(m) && typeof k === "string" ? k in m : UNKNOWN)),
  required: known((_msg, v) => (v === null || v === undefined || v === "" ? UNKNOWN : v)),
  list: known((...args) => args),
  dict: known((...args) => {
    if (args.length % 2 !== 0) return UNKNOWN;
    const out: Record<string, Val> = {};
    for (let i = 0; i < args.length; i += 2) {
      if (typeof args[i] !== "string") return UNKNOWN;
      out[args[i] as string] = args[i + 1];
    }
    return out;
  }),
  ternary: known((a, b, c) => (truthy(c) ? a : b)),
  coalesce: (args) => {
    for (const a of args) {
      if (a === UNKNOWN) return UNKNOWN;
      if (!empty(a)) return a;
    }
    return null;
  },
  int: known((v) => {
    const n = typeof v === "number" ? Math.trunc(v) : num(v);
    return n === undefined ? UNKNOWN : n;
  }),
  len: known((v) =>
    typeof v === "string" || Array.isArray(v)
      ? v.length
      : isMap(v)
        ? Object.keys(v).length
        : UNKNOWN,
  ),
  index: known((v, ...keys) => {
    let cur: Val = v;
    for (const k of keys) {
      if (Array.isArray(cur) && typeof k === "number") cur = cur[k];
      else if (isMap(cur) && typeof k === "string") cur = cur[k];
      else return UNKNOWN;
    }
    return cur ?? null;
  }),
  include: (args, ev) => {
    if (args.length !== 2 || typeof args[0] !== "string") return UNKNOWN;
    return ev.include(args[0], args[1]);
  },
};

function same(a: Val, b: Val): boolean {
  if (typeof a === "number" && typeof b === "number") return a === b;
  return a === b || ((a === null || a === undefined) && (b === null || b === undefined));
}

function mapStr(s: Val, f: (x: string) => string): Val {
  const t = show(s);
  return t === UNKNOWN ? UNKNOWN : f(t);
}

// ------------------------------------------------------------------ evaluator

export interface EvalOptions {
  /** Every named template (`define`) known to this chart and its parent. */
  defines: Map<string, Node[]>;
  /** Called with the path, from `.Values`, of every value a template reads. */
  onValuesRead?: (path: (string | number)[]) => void;
  /** Paths from `.Values` of the objects inside it (registered by the caller). */
  valuePaths?: WeakMap<object, (string | number)[]>;
}

type Scope = Map<string, Val>[];

export class Evaluator {
  private depth = 0;
  constructor(private readonly opts: EvalOptions) {}

  /** Render the nodes with `dot` as `.` and `$`. */
  render(nodes: Node[], dot: Val, out: Output): void {
    this.exec(nodes, dot, [new Map([["", dot]])], out);
  }

  include(name: string, dot: Val): Val {
    const body = this.opts.defines.get(name);
    if (!body) return UNKNOWN;
    if (++this.depth > 50) throw new TemplateUnreadable("templates include each other too deeply");
    try {
      const out = new Output();
      this.exec(body, dot, [new Map([["", dot]])], out);
      const t = out.text();
      return t.includes(UNKNOWN_MARK) ? UNKNOWN : t;
    } finally {
      this.depth--;
    }
  }

  private exec(nodes: Node[], dot: Val, scope: Scope, out: Output): void {
    for (const node of nodes) {
      try {
        this.node(node, dot, scope, out);
      } catch (e) {
        if (e instanceof TemplateUnreadable && e.pos === undefined)
          throw new TemplateUnreadable(e.message, node.pos);
        throw e;
      }
    }
  }

  private node(node: Node, dot: Val, scope: Scope, out: Output): void {
    switch (node.n) {
      case "text":
        out.push(node.text, node.pos, true);
        return;
      case "out": {
        const v = this.pipe(node.pipe, dot, scope);
        if (node.pipe.decl) return; // a declaration prints nothing
        const s = show(v);
        out.push(s === UNKNOWN ? UNKNOWN_MARK : s, node.pos, false);
        return;
      }
      case "template": {
        const arg = node.pipe ? this.pipe(node.pipe, dot, scope) : null;
        const v = this.include(node.name, arg);
        const s = show(v);
        out.push(s === UNKNOWN ? UNKNOWN_MARK : s, node.pos, false);
        return;
      }
      case "if": {
        for (const b of node.branches) {
          const inner: Scope = [...scope, new Map()];
          if (truthy(this.pipe(b.cond, dot, inner))) {
            this.exec(b.body, dot, inner, out);
            return;
          }
        }
        if (node.otherwise) this.exec(node.otherwise, dot, [...scope, new Map()], out);
        return;
      }
      case "with": {
        const inner: Scope = [...scope, new Map()];
        const v = this.pipe(node.pipe, dot, inner);
        if (truthy(v)) this.exec(node.body, v, inner, out);
        else if (node.otherwise) this.exec(node.otherwise, dot, [...scope, new Map()], out);
        return;
      }
      case "range": {
        const decl = node.pipe.decl;
        const v = this.pipe({ cmds: node.pipe.cmds }, dot, scope);
        if (v === UNKNOWN) throw new TemplateUnreadable("a range over an unknown value");
        const entries: [Val, Val][] = Array.isArray(v)
          ? v.map((x, i) => [i, x])
          : isMap(v)
            ? Object.keys(v)
                .sort()
                .map((k) => [k, v[k]])
            : typeof v === "number" && Number.isInteger(v)
              ? Array.from({ length: Math.max(0, v) }, (_, i) => [i, i])
              : v === null || v === undefined
                ? []
                : (() => {
                    throw new TemplateUnreadable("a range over a value that isn't a list or map");
                  })();
        if (entries.length === 0) {
          if (node.otherwise) this.exec(node.otherwise, dot, [...scope, new Map()], out);
          return;
        }
        for (const [k, x] of entries) {
          const inner: Scope = [...scope, new Map()];
          if (decl?.length === 1) inner.at(-1)!.set(decl[0]!, x);
          if (decl && decl.length >= 2) {
            inner.at(-1)!.set(decl[0]!, k);
            inner.at(-1)!.set(decl[1]!, x);
          }
          this.exec(node.body, x, inner, out);
        }
        return;
      }
    }
  }

  private lookupVar(name: string, scope: Scope): Val {
    for (let i = scope.length - 1; i >= 0; i--) if (scope[i]!.has(name)) return scope[i]!.get(name);
    throw new TemplateUnreadable(`undefined variable $${name}`);
  }

  private pipe(p: Pipe, dot: Val, scope: Scope): Val {
    let v: Val = undefined;
    let first = true;
    for (const cmd of p.cmds) {
      v = this.command(cmd, dot, scope, first ? undefined : { v });
      first = false;
    }
    if (p.decl) {
      if (p.assign) {
        for (const name of p.decl) {
          const s = [...scope].reverse().find((m) => m.has(name));
          if (!s) throw new TemplateUnreadable(`undefined variable $${name}`);
          s.set(name, v);
        }
      } else if (p.decl.length === 1) scope.at(-1)!.set(p.decl[0]!, v);
      else throw new TemplateUnreadable("two variables outside range");
    }
    return v;
  }

  private command(cmd: Arg[], dot: Val, scope: Scope, piped?: { v: Val }): Val {
    const head = cmd[0]!;
    if (head.a === "fn") {
      const args = cmd.slice(1).map((a) => this.arg(a, dot, scope));
      if (piped) args.push(piped.v);
      const f = FUNCS[head.name];
      return f ? f(args, this) : UNKNOWN;
    }
    if (cmd.length > 1 || piped) {
      // A method call on a value (`.Files.Get "x"`, `.Capabilities.APIVersions.Has "x"`).
      return UNKNOWN;
    }
    return this.arg(head, dot, scope);
  }

  private arg(a: Arg, dot: Val, scope: Scope): Val {
    switch (a.a) {
      case "lit":
        return a.v;
      case "pipe":
        return this.pipe(a.pipe, dot, scope);
      case "fn": {
        const f = FUNCS[a.name];
        return f ? f([], this) : UNKNOWN;
      }
      case "field":
        return this.walk(dot, a.path);
      case "var":
        return this.walk(this.lookupVar(a.name, scope), a.path);
    }
  }

  /** `.a.b` on a value: a missing key is nil; a key of nothing is unknown (Helm fails there). */
  private walk(start: Val, path: string[]): Val {
    let cur = start;
    const paths = this.opts.valuePaths;
    let vpath = isObjLike(cur) ? paths?.get(cur) : undefined;
    for (const k of path) {
      if (cur === UNKNOWN) return UNKNOWN;
      if (!isMap(cur)) return UNKNOWN;
      cur = Object.prototype.hasOwnProperty.call(cur, k) ? cur[k] : null;
      vpath = vpath ? [...vpath, k] : undefined;
      if (isObjLike(cur) && paths?.has(cur)) vpath = paths.get(cur);
    }
    if (vpath && path.length > 0 && cur !== null && cur !== undefined)
      this.opts.onValuesRead?.(vpath);
    return cur;
  }
}

const isObjLike = (v: Val): v is object => v !== null && typeof v === "object";

/** Drop every scalar and key that holds the unknown marker: left out, never guessed. */
export function dropUnknown(v: unknown): unknown {
  if (typeof v === "string") return v.includes(UNKNOWN_MARK) ? undefined : v;
  if (Array.isArray(v)) return v.map(dropUnknown); // keep indices, so line lookups still match
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (k.includes(UNKNOWN_MARK)) continue;
      const y = dropUnknown(x);
      if (y !== undefined) out[k] = y;
    }
    return out;
  }
  return v;
}
