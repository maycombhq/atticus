import { normalizePath, redactSecrets, type Fact } from "@maycombhq/core";
import { DEFAULT_READ_RULES, type ReadRules } from "./conventions.js";
import { readOpenApiDocument } from "@maycombhq/extractors";

/**
 * R1: the lines the reader skipped, the cross-check ADR 0124 promised. Plain text patterns that
 * read any language, with no parser per stack, find the strings that look like a path
 * (`/api/v1/accounts/{id}`), a URL (`https://host/x`) or a topic (`forge.accounts.created`, or a
 * name with a separator where the line says topic, queue, channel, destination or exchange).
 * Comments, import lines, asset and file-system paths, XML namespaces and placeholders are not
 * candidates. Verify lists those no kept fact cites (its line, or the line either side) and no
 * fact names elsewhere, for the reader to check. It decides; nothing here becomes a fact, and
 * nothing here rejects one.
 */

export type SkippedKind = "path" | "url" | "topic";

/** A string on a line that looks like a path, a URL or a topic. */
export interface Candidate {
  line: number;
  kind: SkippedKind;
  value: string;
  /** The line, trimmed, at most 200 characters. */
  text: string;
}

/** A candidate no kept fact cites or names: `file:line`, what it is, and the line. */
export interface SkippedLine {
  cite: string;
  kind: SkippedKind;
  value: string;
  text: string;
}

/** A reviewed glob (`<repo>.reviewed.jsonl`) whose files write a path, URL or topic. */
export interface ReviewedHolds {
  path: string;
  why: string;
  /** How many lines of its files do. */
  count: number;
  /** The first five. */
  skipped: SkippedLine[];
  message: string;
}

/** An operation a repo's OpenAPI or Swagger spec declares that no kept entry covers. */
export interface SpecOpUncovered {
  spec: string;
  /** Upper case. */
  method: string;
  /** As the spec writes it (Swagger 2's basePath in front). */
  path: string;
  operationId?: string;
  /** `spec:line` of the method. */
  cite: string;
  message: string;
}

/**
 * Folders whose strings aren't the product's: generated code, build output and vendored copies,
 * the org pack's `notReadFolders` (ADR 0147). Tests, fixtures and the rest coverage doesn't count
 * are already left out (`isSourceFile`), and so is what the org pack excludes.
 */
export function notReadForSkipped(path: string, rules: ReadRules = DEFAULT_READ_RULES): boolean {
  return rules.notRead.test(path);
}

/** A line that is all comment: `//`, `/*`, `*`, `#` (not a C# directive), `<!--` or SQL's `-- `. */
export const isCommentLine = (l: string) =>
  /^\s*(\/\/|\/\*|\*|<!--|-- |#(?!\s*(region|endregion|if|elif|else|endif|define|undef|pragma|nullable|include|import)\b)(?!!))/.test(
    l,
  );

/** A line that imports: its strings name modules, not routes. */
const IMPORT_LINE =
  /^\s*(import|export\s+[^=]*\bfrom\b|from\s+\S+\s+import|package|using|require|#\s*include|@import|@use|use|library)\b/;
const IMPORT_CALL = /\brequire\s*\(|\bimport\s*\(|\bfrom\s+["'`]/;
/** XML namespaces and schema locations: URLs that name a vocabulary, never a call. */
const NAMESPACE_LINE = /\bxmlns(:\w+)?\s*=|schemaLocation\s*=|<!DOCTYPE|^\s*<\?xml/i;

const URL_RE = /\b(?:https?|wss?|grpcs?|amqps?):\/\/[^\s"'`<>()[\],;\\|^]+/gi;
/** Hosts whose URLs name a standard, a licence or a schema. */
const STANDARD_HOST =
  /^(www\.)?(w3\.org|json-schema\.org|maven\.apache\.org|apache\.org|springframework\.org|java\.sun\.com|xmlns\.jcp\.org|purl\.org|opensource\.org|gnu\.org|schema\.org|schemas\.[^/]+|xmlns\.[^/]+|ietf\.org|tools\.ietf\.org|creativecommons\.org)$/i;
const FS_ROOT =
  /^\/(usr|etc|var|tmp|bin|sbin|opt|home|dev|proc|sys|lib|lib64|mnt|root|Users|private|Library|System|Applications|Volumes)(\/|$)/;
const FILE_EXT =
  /\.(m?js|cjs|jsx|tsx?|css|scss|less|png|jpe?g|gif|svg|ico|webp|bmp|woff2?|ttf|eot|otf|map|jar|war|ear|class|so|dll|exe|sh|bat|ps1|py|rb|txt|log|pem|crt|key|lock|ya?ml|properties|conf|ini|env|md|mp[34]|wav|pdf|zip|gz|tar)$/i;
const PATH_SEG = "[A-Za-z0-9_.~{}$:<>*%@+=-]+";
/** A path, perhaps after a placeholder for its base (`${base}`, `%s`, `{base}`). */
const PATH_RE = new RegExp(`^(?:\\$\\{[^}]+\\}|%s|\\{[A-Za-z_]+\\})?((?:\\/${PATH_SEG})+\\/?)$`);
/** The last parts that make a dotted string a file or a host, and first parts that make it a package or a framework's key. */
const NOT_TOPIC_LAST = new Set(
  "com org net io dev app ai co uk de fr in jp us eu example internal local localhost test cloud corp lan svc java kt scala cs ts js json xml yml yaml properties html htm txt md sql proto csv log jar dll exe sh py rb go class png svg gif jpg css".split(
    " ",
  ),
);
const NOT_TOPIC_FIRST = new Set(
  "com org net io java javax jakarta android androidx kotlin kotlinx scala sun microsoft system google apache spring springframework management server logging hibernate jdk www".split(
    " ",
  ),
);
const DOTTED_TOPIC = /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*){2,}$/;
const SEPARATED_NAME = /^[A-Za-z][A-Za-z0-9_]*([._:-][A-Za-z0-9_]+)+$/;
const QUOTED = /(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
const KEY_VALUE = /^\s*-?\s*["']?([A-Za-z0-9_.\-[\]]+)["']?\s*[:=]\s*([^\s"'#]+)\s*$/;
const ELEMENT_TEXT = /<([A-Za-z][\w:.-]*)[^>]*>([^<\s]+)<\/\1>/g;

/** A line's words, lowercased: split at non-letters and at camelCase capitals (as P2 does). */
const wordsOf = (line: string) =>
  line
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
const TOPIC_WORDS = new Set([
  "topic",
  "topics",
  "queue",
  "queues",
  "channel",
  "channels",
  "destination",
  "destinations",
  "exchange",
  "exchanges",
]);
const topicContext = (line: string) => {
  const w = wordsOf(line);
  return w.some((x) => TOPIC_WORDS.has(x)) || w.join(" ").includes("routing key");
};

/** A URL as listed: trailing punctuation off, and any password in it redacted. */
const cleanUrl = (u: string) =>
  u.replace(/[.:]+$/, "").replace(/^([a-z0-9+.-]+:\/\/)[^/@\s]+@/i, "$1<redacted>@");
const hostOf = (u: string) => /^[a-z0-9+.-]+:\/\/([^/:?#]+)/i.exec(u)?.[1] ?? "";

/** The path a string writes, or undefined when it writes none worth checking. */
function pathOf(s: string): string | undefined {
  const m = PATH_RE.exec(s);
  if (!m) return undefined;
  const p = m[1]!;
  if (p.length < 2 || p.includes("//") || !/[A-Za-z]/.test(p)) return undefined;
  if (FS_ROOT.test(p) || FILE_EXT.test(p)) return undefined;
  return p;
}

function topicOf(s: string, context: boolean): string | undefined {
  if (DOTTED_TOPIC.test(s)) {
    const parts = s.split(".");
    if (!NOT_TOPIC_LAST.has(parts.at(-1)!) && !NOT_TOPIC_FIRST.has(parts[0]!)) return s;
  }
  if (context && SEPARATED_NAME.test(s) && !FILE_EXT.test(s)) {
    const last = s.split(".").at(-1)!;
    if (!s.includes(".") || !NOT_TOPIC_LAST.has(last)) return s;
  }
  return undefined;
}

/** The line with its comments taken out; `inBlock` carries a block comment across lines. */
function codeOf(raw: string, state: { block?: "c" | "xml" }): string {
  let s = raw;
  let out = "";
  for (;;) {
    if (state.block) {
      const close = state.block === "c" ? "*/" : "-->";
      const i = s.indexOf(close);
      if (i < 0) return out;
      s = s.slice(i + close.length);
      state.block = undefined;
    }
    // a block opens at the line's start or after a space, so `"/api/*"` opens none
    const m = /(^|\s)(\/\*|<!--)/.exec(s);
    if (!m) return out + s;
    out += s.slice(0, m.index + m[1]!.length);
    s = s.slice(m.index + m[0].length);
    state.block = m[2] === "/*" ? "c" : "xml";
  }
}

/** Every path, URL and topic string a file's lines write outside comments and imports. */
export function candidatesIn(path: string, lines: readonly string[]): Candidate[] {
  const out: Candidate[] = [];
  const state: { block?: "c" | "xml" } = {};
  lines.forEach((raw, i) => {
    const wasBlock = state.block !== undefined;
    let code = codeOf(raw, state);
    if (!code.trim()) return;
    if (!wasBlock && isCommentLine(raw)) return;
    if (IMPORT_LINE.test(code) || IMPORT_CALL.test(code) || NAMESPACE_LINE.test(code)) return;
    // a trailing comment: `//` or `#` after a space (a URL's `://` has a colon before it)
    code = code.replace(/(^|[\s;,)}])\/\/.*$/, "$1").replace(/\s#\s.*$/, "");
    const seen = new Set<string>();
    const text = redactSecrets(cleanUrlIn(raw.trim())).slice(0, 200);
    const add = (kind: SkippedKind, value: string) => {
      const key = `${kind} ${value}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ line: i + 1, kind, value, text });
    };
    const context = topicContext(code);
    const urls: string[] = [];
    for (const m of code.matchAll(URL_RE)) {
      const u = cleanUrl(m[0]);
      if (!STANDARD_HOST.test(hostOf(u))) add("url", u);
      urls.push(m[0]);
    }
    const strings = [...code.matchAll(QUOTED)].map((m) => m[2]!);
    const kv = KEY_VALUE.exec(code);
    if (kv) strings.push(kv[2]!);
    for (const m of code.matchAll(ELEMENT_TEXT)) strings.push(m[2]!);
    for (const s of strings) {
      if (urls.some((u) => s.includes(u) || u.includes(s))) continue;
      const p = pathOf(s);
      if (p) {
        add("path", p);
        continue;
      }
      const t = topicOf(s, context);
      if (t) add("topic", t);
    }
  });
  return out;
}
const cleanUrlIn = (line: string) =>
  line.replace(/\b([a-z0-9+.-]+:\/\/)[^/@\s"'`]+@/gi, "$1<redacted>@");

/** A path compared as the join does: parameters of any spelling as `{}`. */
const normPath = (p: string) => normalizePath(p.replace(/(^|\/)%[sd](?=\/|$)/g, "$1{}"));

/** What the kept facts cite and name, for telling a skipped line from one they account for. */
export interface FactsIndex {
  /** `file:line` of every cite, part, step, error, authCite, scope and caller. */
  at: Set<string>;
  /** Every string the facts hold, lowercased. */
  strings: string[];
  /** The paths among them, normalised, each with a `/` at its end. */
  paths: string[];
}

export function indexFacts(facts: readonly Fact[]): FactsIndex {
  const at = new Set<string>();
  const strings = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === "string") {
      if (v.length >= 3) strings.add(v);
      return;
    }
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o.file === "string" && typeof o.line === "number") at.add(`${o.file}:${o.line}`);
      Object.values(o).forEach(walk);
    }
  };
  facts.forEach(walk);
  const paths = new Set<string>();
  for (const s of strings) {
    if (/\s/.test(s)) continue;
    const u = /^[a-z0-9+.-]+:\/\/[^/]+(\/.*)?$/i.exec(s);
    const p = u ? u[1] : s.includes("/") ? s : undefined;
    if (p && p.length > 1) paths.add(`${normPath(p)}/`);
  }
  return { at, strings: [...strings].map((s) => s.toLowerCase()), paths: [...paths] };
}

/** Whether the kept facts account for a candidate: they cite its line, or name its value. */
export function factsCover(file: string, c: Candidate, ix: FactsIndex): boolean {
  if ([c.line - 1, c.line, c.line + 1].some((n) => ix.at.has(`${file}:${n}`))) return true;
  if (c.kind === "path") {
    const p = `${normPath(c.value)}/`;
    return ix.paths.some((f) => f.includes(p));
  }
  const v = c.value.toLowerCase().replace(/\/+$/, "");
  return ix.strings.some((s) => s.includes(v));
}

export const skippedOf = (file: string, c: Candidate): SkippedLine => ({
  cite: `${file}:${c.line}`,
  kind: c.kind,
  value: c.value,
  text: c.text,
});

/** An OpenAPI or Swagger file, by its first lines; read only then. */
const SPEC_MARK = /^\s*["']?(openapi|swagger)["']?\s*:/m;
const SPEC_EXT = /\.(ya?ml|json)$/i;

/**
 * The operations a spec declares that no kept entry covers, with the spec reader the extractor
 * and intake share (`readOpenApiDocument`, ADR 0130); undefined when the file is no spec. An
 * entry covers an operation when it cites the operation's lines, or has its method (or none) and
 * its path, with or without the server's path in front, or ends with it (a context path before).
 */
export function specOpsUncoveredIn(
  file: string,
  text: string,
  facts: readonly Fact[],
): SpecOpUncovered[] | undefined {
  if (!SPEC_EXT.test(file) || !SPEC_MARK.test(text.slice(0, 4000))) return undefined;
  let doc;
  try {
    doc = readOpenApiDocument(text);
  } catch {
    return undefined;
  }
  if (!doc || !doc.operations.length) return undefined;
  const server = (() => {
    const s = doc.servers[0];
    if (!s) return "";
    const p = /^[a-z0-9+.-]+:\/\/[^/]+(\/.*)?$/i.exec(s)?.[1] ?? (s.startsWith("/") ? s : "");
    return p.replace(/\/+$/, "");
  })();
  const entries = facts.filter((f) => f.kind === "entry");
  const atLines = new Set<string>();
  for (const e of entries) for (const k of indexFacts([e]).at) atLines.add(k);
  const out: SpecOpUncovered[] = [];
  for (const op of doc.operations) {
    const lines = [op.methodLine, op.line].filter((n): n is number => n !== undefined);
    if (lines.some((n) => [n - 1, n, n + 1].some((x) => atLines.has(`${file}:${x}`)))) continue;
    const method = op.method.toUpperCase();
    const own = normPath(op.path);
    const full = normPath(`${server}${op.path}`);
    const covered = entries.some((e) => {
      if (e.method && e.method.toUpperCase() !== method) return false;
      const p = normPath(e.path);
      return (
        p === own || p === full || p.endsWith(own) || (p.split("/").length > 2 && own.endsWith(p))
      );
    });
    if (covered) continue;
    const opId = (op.node as { get?: (k: string) => unknown } | undefined)?.get?.("operationId");
    const line = op.methodLine ?? op.line ?? 1;
    out.push({
      spec: file,
      method,
      path: op.path,
      ...(typeof opId === "string" ? { operationId: opId } : {}),
      cite: `${file}:${line}`,
      message: `${file}:${line} declares ${method} ${op.path}${typeof opId === "string" ? ` (${opId})` : ""}, which no entry covers`,
    });
  }
  return out;
}

/** How many skipped lines a reviewed glob's note shows. */
export const REVIEWED_HOLDS_SHOWN = 5;

export function reviewedHoldsOf(
  r: { path: string; why: string; line?: number },
  skipped: readonly SkippedLine[],
): ReviewedHolds {
  const n = skipped.length;
  const first = skipped.slice(0, 3).map((s) => `${s.cite} (${s.value})`);
  return {
    path: r.path,
    why: r.why,
    count: n,
    skipped: skipped.slice(0, REVIEWED_HOLDS_SHOWN),
    message: `${r.line !== undefined ? `line ${r.line}: ` : ""}${r.path} is reviewed as holding nothing to record, but ${n} ${n === 1 ? "line in it writes" : "lines in it write"} a path, URL or topic: ${first.join(", ")}${n > 3 ? ` and ${n - 3} more` : ""}`,
  };
}
