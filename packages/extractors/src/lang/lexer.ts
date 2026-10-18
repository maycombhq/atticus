/**
 * A small, tolerant tokenizer for C#, Python, Go and JavaScript/TypeScript, used by the
 * backend extractors instead of a full parser (no native modules, so scans run anywhere).
 * It gets the parts that matter for reading routes and calls right: comments are skipped,
 * every string form of the language is read as one token (so a route written inside a
 * comment or a string is never mistaken for code), and line numbers are kept.
 *
 * Interpolated strings (Python f-strings, C# $"...", JS template literals) keep their
 * expressions written as `${expr}`, so later steps can resolve or name them.
 */

export type SourceLang = "csharp" | "python" | "go" | "js";

export interface SrcTok {
  /** id: identifier or keyword; str: string literal; lit: other literal (number, char, regex); p: punctuation. */
  t: "id" | "str" | "lit" | "p";
  v: string;
  line: number;
  /** For strings that interpolate expressions. */
  interp?: true;
}

const MULTI = [
  "===",
  "!==",
  "...",
  "=>",
  ":=",
  "??",
  "?.",
  "||",
  "&&",
  "==",
  "!=",
  "<=",
  ">=",
  "::",
  "->",
  "**",
  "+=",
  "-=",
];

const JS_REGEX_AFTER_KEYWORD = new Set([
  "return",
  "typeof",
  "case",
  "do",
  "else",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "yield",
  "await",
]);

const ID_START = /[A-Za-z_$À-￿]/;
const ID_PART = /[A-Za-z0-9_$À-￿]/;

export function lexSource(src: string, lang: SourceLang): SrcTok[] {
  const out: SrcTok[] = [];
  const n = src.length;
  let i = 0;
  let line = 1;

  const push = (t: SrcTok["t"], v: string, at: number, interp = false) =>
    out.push(interp ? { t, v, line: at, interp: true } : { t, v, line: at });

  /** Read an interpolation body starting after `{` (or `${`), up to the matching `}`. */
  const readInterpolation = (): string => {
    let depth = 0;
    let expr = "";
    while (i < n) {
      const c = src[i]!;
      if (c === "\n") line++;
      if (c === "{") depth++;
      else if (c === "}") {
        if (depth === 0) {
          i++;
          return expr;
        }
        depth--;
      } else if (c === '"' || c === "'" || c === "`") {
        // A nested string inside the expression: copy it through untouched.
        const q = c;
        expr += c;
        i++;
        while (i < n && src[i] !== q) {
          if (src[i] === "\\") {
            expr += src[i]!;
            i++;
          }
          if (src[i] === "\n") line++;
          expr += src[i] ?? "";
          i++;
        }
        expr += src[i] ?? "";
        i++;
        continue;
      }
      expr += c;
      i++;
    }
    return expr;
  };

  const escape = (e: string) =>
    e === "n" ? "\n" : e === "t" ? "\t" : e === "r" ? "\r" : e === "0" ? "\0" : e;

  // ---- language-specific string readers; each starts with i on the opening quote
  const readPython = (prefix: string) => {
    const start = line;
    const raw = /r/i.test(prefix);
    const f = /f/i.test(prefix);
    const q = src[i]!;
    const triple = src.startsWith(q.repeat(3), i);
    i += triple ? 3 : 1;
    let v = "";
    while (i < n) {
      const c = src[i]!;
      if (triple ? src.startsWith(q.repeat(3), i) : c === q) {
        i += triple ? 3 : 1;
        break;
      }
      if (c === "\n") {
        if (!triple) break;
        line++;
      }
      if (c === "\\" && i + 1 < n) {
        if (src[i + 1] === "\n") line++;
        v += raw ? c + src[i + 1]! : escape(src[i + 1]!);
        i += 2;
        continue;
      }
      if (f && c === "{") {
        if (src[i + 1] === "{") {
          v += "{";
          i += 2;
          continue;
        }
        i++;
        const expr = readInterpolation();
        v += "${" + stripFormatSpec(expr, "python") + "}";
        continue;
      }
      if (f && c === "}" && src[i + 1] === "}") {
        v += "}";
        i += 2;
        continue;
      }
      v += c;
      i++;
    }
    push("str", v, start, f);
  };

  const readCSharp = (prefix: string) => {
    const start = line;
    const interp = prefix.includes("$");
    const verbatim = prefix.includes("@");
    if (src.startsWith('"""', i)) {
      let q = 0;
      while (src[i + q] === '"') q++;
      const close = '"'.repeat(q);
      i += q;
      let v = "";
      while (i < n && !src.startsWith(close, i)) {
        const c = src[i]!;
        if (c === "\n") line++;
        if (interp && c === "{") {
          i++;
          v += "${" + stripFormatSpec(readInterpolation(), "csharp") + "}";
          continue;
        }
        v += c;
        i++;
      }
      i += q;
      push("str", v, start, interp);
      return;
    }
    i++;
    let v = "";
    while (i < n) {
      const c = src[i]!;
      if (c === '"') {
        if (verbatim && src[i + 1] === '"') {
          v += '"';
          i += 2;
          continue;
        }
        i++;
        break;
      }
      if (c === "\n") {
        if (!verbatim) break;
        line++;
      }
      if (!verbatim && c === "\\" && i + 1 < n) {
        v += escape(src[i + 1]!);
        i += 2;
        continue;
      }
      if (interp && c === "{") {
        if (src[i + 1] === "{") {
          v += "{";
          i += 2;
          continue;
        }
        i++;
        v += "${" + stripFormatSpec(readInterpolation(), "csharp") + "}";
        continue;
      }
      if (interp && c === "}" && src[i + 1] === "}") {
        v += "}";
        i += 2;
        continue;
      }
      v += c;
      i++;
    }
    push("str", v, start, interp);
  };

  /** Ordinary quoted string with backslash escapes ("..." or '...'), single line. */
  const readQuoted = () => {
    const start = line;
    const q = src[i]!;
    i++;
    let v = "";
    while (i < n && src[i] !== q) {
      const c = src[i]!;
      if (c === "\n") break;
      if (c === "\\" && i + 1 < n) {
        if (src[i + 1] === "\n") line++;
        else v += escape(src[i + 1]!);
        i += 2;
        continue;
      }
      v += c;
      i++;
    }
    if (src[i] === q) i++;
    push("str", v, start);
  };

  const readTemplate = () => {
    const start = line;
    i++;
    let v = "";
    let interp = false;
    while (i < n && src[i] !== "`") {
      const c = src[i]!;
      if (c === "\n") line++;
      if (c === "\\" && i + 1 < n) {
        v += escape(src[i + 1]!);
        i += 2;
        continue;
      }
      if (c === "$" && src[i + 1] === "{") {
        i += 2;
        interp = true;
        v += "${" + readInterpolation() + "}";
        continue;
      }
      v += c;
      i++;
    }
    i++;
    push("str", v, start, interp);
  };

  const regexAllowed = (): boolean => {
    const prev = out[out.length - 1];
    if (!prev) return true;
    if (prev.t === "p") return !")]}".includes(prev.v);
    if (prev.t === "id") return JS_REGEX_AFTER_KEYWORD.has(prev.v);
    return false;
  };

  while (i < n) {
    const c = src[i]!;
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r" || c === "\f" || c === "\v" || c === "﻿") {
      i++;
      continue;
    }
    // ---- comments
    const lineComment =
      lang === "python"
        ? c === "#"
        : (c === "/" && src[i + 1] === "/") ||
          (lang === "csharp" &&
            c === "#" &&
            /^[ \t]*$/.test(src.slice(src.lastIndexOf("\n", i - 1) + 1, i))) ||
          (lang === "js" && i === 0 && c === "#" && src[1] === "!");
    if (lineComment) {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (lang !== "python" && c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") line++;
        i++;
      }
      i += 2;
      continue;
    }
    // ---- strings
    if (lang === "python") {
      const m = /^(?:[rRbBuUfF]|[rR][bBfF]|[bBfF][rR])?(?=['"])/.exec(src.slice(i, i + 3));
      if (m && (m[0] === "" || !ID_PART.test(src[i - 1] ?? ""))) {
        i += m[0].length;
        readPython(m[0]);
        continue;
      }
    } else if (lang === "csharp") {
      const m = /^(?:\$+@?|@\$+|@)?(?=")/.exec(src.slice(i, i + 6));
      if (m) {
        i += m[0].length;
        readCSharp(m[0]);
        continue;
      }
      if (c === "'") {
        const start = line;
        i++;
        let v = "";
        while (i < n && src[i] !== "'" && src[i] !== "\n") {
          if (src[i] === "\\") v += src[i++];
          v += src[i++] ?? "";
        }
        i++;
        push("lit", v, start);
        continue;
      }
    } else if (lang === "go") {
      if (c === '"') {
        readQuoted();
        continue;
      }
      if (c === "`") {
        const start = line;
        i++;
        let v = "";
        while (i < n && src[i] !== "`") {
          if (src[i] === "\n") line++;
          v += src[i++];
        }
        i++;
        push("str", v, start);
        continue;
      }
      if (c === "'") {
        const start = line;
        i++;
        let v = "";
        while (i < n && src[i] !== "'" && src[i] !== "\n") {
          if (src[i] === "\\") v += src[i++];
          v += src[i++] ?? "";
        }
        i++;
        push("lit", v, start);
        continue;
      }
    } else {
      if (c === '"' || c === "'") {
        readQuoted();
        continue;
      }
      if (c === "`") {
        readTemplate();
        continue;
      }
      if (c === "/" && regexAllowed()) {
        const start = line;
        let j = i + 1;
        let inClass = false;
        while (j < n && src[j] !== "\n") {
          const d = src[j]!;
          if (d === "\\") j++;
          else if (d === "[") inClass = true;
          else if (d === "]") inClass = false;
          else if (d === "/" && !inClass) break;
          j++;
        }
        if (src[j] === "/") {
          j++;
          while (j < n && /[a-z]/i.test(src[j]!)) j++;
          push("lit", src.slice(i, j), start);
          i = j;
          continue;
        }
      }
    }
    // ---- identifiers, numbers, punctuation
    if (ID_START.test(c) || (lang === "csharp" && c === "@" && ID_START.test(src[i + 1] ?? ""))) {
      let j = i + 1;
      while (j < n && ID_PART.test(src[j]!)) j++;
      push("id", src.slice(c === "@" ? i + 1 : i, j), line);
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      let j = i + 1;
      while (j < n && /[0-9A-Za-z_.]/.test(src[j]!)) j++;
      push("lit", src.slice(i, j), line);
      i = j;
      continue;
    }
    const multi = MULTI.find((m) => src.startsWith(m, i));
    if (multi && !(multi === "?." && /[0-9]/.test(src[i + 2] ?? ""))) {
      push("p", multi, line);
      i += multi.length;
      continue;
    }
    push("p", c, line);
    i++;
  }
  return out;
}

/** Drop a format spec or conversion from an interpolation: `{x:N2}`, `{x!r}`, `{x,10}`. */
function stripFormatSpec(expr: string, lang: "python" | "csharp"): string {
  let depth = 0;
  for (let k = 0; k < expr.length; k++) {
    const c = expr[k]!;
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (depth === 0) {
      if (lang === "python" && c === "!" && expr[k + 1] !== "=") return expr.slice(0, k).trim();
      if (c === ":" && !expr.includes("?") && !expr.includes("lambda"))
        return expr.slice(0, k).trim();
      if (lang === "csharp" && c === "," && !expr.includes("(")) return expr.slice(0, k).trim();
    }
  }
  return expr.trim();
}
