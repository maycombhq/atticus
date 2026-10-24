/**
 * Citations: does a line say what a fact or a flow step claims (ADR 0089), does a quote match a
 * line once the model's small rewrites are forgiven (ADR 0103), and what must never be quoted
 * (ADR 0124). Pure functions; the verifier and the spec check both use them.
 */

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const PARAM = /^(\{[^}]*\}|:[^/]+|<[^>]+>|\$\{[^}]*\})$/;
const PARAM_RE = "(?:\\{[^}]*\\}|:[A-Za-z_]\\w*|<[^>]+>|\\$\\{[^}]*\\})";

/** A field as compared: the last dotted part, lower case, without _ - or spaces. */
export const fieldKey = (f: string) =>
  f
    .split(".")
    .pop()!
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

/**
 * Whether a line names a route: the path, or its tail once leading segments are dropped (a
 * class-level prefix sits elsewhere), with at least one plain segment left. Parameters match
 * in any style ({id}, :id, <id>, ${id}), and a parameter at the end may be left off the line
 * (a path built as `base + "/v1/rates/" + pair`).
 */
export function lineNamesRoute(line: string, path: string): boolean {
  const segs = path.split(/[?#]/, 1)[0]!.split("/").filter(Boolean);
  // A root route ("/"), or one of parameters only ("/{id}"), has no plain segment to look for:
  // it is named by its literal in quotes, parameters in any style.
  if (!segs.some((s) => !PARAM.test(s))) {
    const body = segs.map((s) => (PARAM.test(s) ? PARAM_RE : escape(s))).join("/");
    if (new RegExp(`["'\`]/${body}/?["'\`]`).test(line)) return true;
    // a front end's root route: Angular's `path: ''`, React Router's `index: true`
    if (!segs.length && /\bpath:\s*(['"`])\1|\bindex:\s*true\b/.test(line)) return true;
    // the last parameter concatenated in code: `base + "/" + productId`
    const head = segs
      .slice(0, -1)
      .map(() => PARAM_RE)
      .join("/");
    return (
      segs.length > 0 && new RegExp(`["'\`]/${head ? `${head}/` : ""}["'\`]\\s*\\+`).test(line)
    );
  }
  for (let k = 0; k < segs.length; k++) {
    const tail = segs.slice(k);
    if (!tail.some((s) => !PARAM.test(s))) break;
    // after a slash, or at the start of a literal written without one (`[HttpPost("upload")]`)
    const re = new RegExp(
      `(?:/|["'\`])${tail.map((s) => (PARAM.test(s) ? PARAM_RE : escape(s))).join("/")}(?![A-Za-z0-9_-])`,
      "i",
    );
    if (re.test(line)) return true;
    // the trailing parameter concatenated in code: `"/v1/rates/" + pair`
    const last = tail[tail.length - 1]!;
    if (PARAM.test(last) && tail.length > 1) {
      const head = tail.slice(0, -1);
      const re2 = new RegExp(
        `/${head.map((s) => (PARAM.test(s) ? PARAM_RE : escape(s))).join("/")}/?["'\`]`,
        "i",
      );
      if (re2.test(line)) return true;
    }
  }
  return false;
}

/** Whether a line names a word (a table, a topic): case aside, not inside a longer word. */
export const lineNamesWord = (line: string, word: string) => {
  // A boundary is needed only where the word itself ends in a word character: `foo(` may be
  // followed by anything, `foo` not by another letter.
  const w = word.trim();
  if (!w) return false;
  const before = /^[A-Za-z0-9_]/.test(w) ? "(^|[^A-Za-z0-9_])" : "";
  const after = /[A-Za-z0-9_]$/.test(w) ? "($|[^A-Za-z0-9_])" : "";
  return new RegExp(`${before}${escape(w)}${after}`, "i").test(line);
};

/** Whether a line names a field, letter case and _ or - aside (first_name matches firstName). */
export const lineNamesField = (line: string, field: string) => {
  const k = fieldKey(field);
  return (
    k.length > 0 &&
    line
      .toLowerCase()
      .replace(/[^a-z0-9]/g, " ")
      .replace(/ /g, "")
      .includes(k)
  );
};

export interface Claim {
  kind: "route" | "word" | "field";
  value: string;
}

export const lineNamesClaim = (line: string, c: Claim) =>
  c.kind === "route"
    ? lineNamesRoute(line, c.value)
    : c.kind === "word"
      ? lineNamesWord(line, c.value)
      : lineNamesField(line, c.value);

/**
 * Whether the claim is on the cited line (1-based) or within `window` lines either side: an
 * annotation often sits on the line above its handler, and a path may wrap.
 */
export function claimOnLines(
  lines: readonly string[],
  line: number,
  claim: Claim,
  window = 1,
): boolean {
  const from = Math.max(1, line - window);
  const to = Math.min(lines.length, line + window);
  for (let i = from; i <= to; i++) if (lineNamesClaim(lines[i - 1] ?? "", claim)) return true;
  return false;
}

/**
 * A quote as compared (ADR 0103): whitespace folded, CRLF to LF, curly quotes straightened,
 * single quotes for double, end punctuation and a trailing semicolon or comma forgiven.
 */
export function normalizeQuote(q: string): string {
  return q
    .replace(/\r\n?/g, "\n")
    .replace(/[‘’‚]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[;,.]+$/, "")
    .trim();
}

/** Whether a quote is the line, starts it, or sits inside it, after normalisation. */
export function quoteMatches(line: string, quote: string | undefined): boolean {
  if (!quote) return true;
  const q = normalizeQuote(quote).replace(/"/g, "'");
  if (q === "") return true;
  const l = normalizeQuote(line).replace(/"/g, "'");
  // A quote the verifier stored redacted matches its line again: what came before <redacted>.
  const at = q.indexOf("<redacted>");
  if (at >= 0) return at === 0 || l.includes(q.slice(0, at).trimEnd());
  return l === q || l.startsWith(q) || l.includes(q);
}

const BINARY =
  /\.(png|jpe?g|gif|webp|ico|pdf|zip|jar|war|ear|gz|tgz|7z|exe|dll|so|dylib|class|wasm|woff2?|ttf|otf|mp[34]|mov|avi|bin|dat)$/i;
const NOTEBOOK = /\.ipynb$/i;
const MINIFIED = /(\.min\.(js|css)|[-.]bundle\.js|\.map)$/i;

/** A quote is not required from a binary, a notebook, a minified file, or a very long line. */
export function quoteNotRequired(path: string, line: string): boolean {
  return BINARY.test(path) || NOTEBOOK.test(path) || MINIFIED.test(path) || line.length > 1000;
}

const SECRET_PATH = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)secrets?\//i,
  /(^|\/)credentials?(\.|$)/i,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /(^|\/)id_(rsa|ed25519|ecdsa|dsa)(\.|$)/i,
];

/** Paths whose lines are never quoted into a map. */
export function isSecretPath(path: string): boolean {
  const p = path.replace(/\\/g, "/");
  return SECRET_PATH.some((re) => re.test(p));
}

const SECRET_KEY =
  /(password|passwd|pwd|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?secret|credential)/i;
const PLACEHOLDER = /^(\$\{|\{\{|env:|vault:|secret:|ref:|<)/;
// The key's last part ends in a secret word (ClientSecret, db.password, "api_key"), so TokenUrl
// and AccessTokenLifetime aren't secrets.
const KEY_VALUE =
  /^(\s*[-"']?\s*)([A-Za-z0-9_.:-]*?(?:password|passwd|pwd|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|credentials?))(["']?\s*[:=]\s*)(.+)$/i;

/**
 * Redact a line that carries a secret-looking key with a literal value; a placeholder or a
 * reference (`${X}`, `env:X`, `vault:...`) stays, as does a line that names no such key.
 * A private-key block is redacted whole.
 */
export function redactSecrets(line: string): string {
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(line)) return "<redacted>";
  if (!SECRET_KEY.test(line)) return line;
  const m = KEY_VALUE.exec(line);
  if (!m) return line;
  const value = m[4]!.trim();
  if (PLACEHOLDER.test(value)) return line;
  return `${m[1]}${m[2]}${m[3]}<redacted>`;
}

/**
 * Whether a path put together in code is named by its lines (ADR 0124 addendum A4): every plain
 * part of the path (its segments, a dotted segment's pieces: `BasketApi.Basket/GetBasket`) is
 * written on one of the lines, case aside, at the start of a word or of an identifier
 * (`account` in `AccountController`). Parameters need not be written.
 */
/**
 * Whether `/` is a conventional route's default action: a default route is declared
 * (`MapDefaultControllerRoute`, or a template like `{controller=Home}/{action=Index}`) and the
 * lines name that controller's class and that action.
 */
function defaultActionAt(lines: readonly string[], path: string): boolean {
  if (path.split(/[?#]/, 1)[0]!.replace(/\/+/g, "") !== "") return false;
  const text = lines.join("\n");
  if (!/MapDefaultControllerRoute|\{controller=\w+\}/.test(text)) return false;
  const controller = /\{controller=(\w+)\}/.exec(text)?.[1] ?? "Home";
  const action = /\{action=(\w+)\}/.exec(text)?.[1] ?? "Index";
  return (
    new RegExp(`\\b${controller}Controller\\b`).test(text) &&
    new RegExp(`\\b${action}\\s*\\(`).test(text)
  );
}

export function partsNamePath(lines: readonly string[], path: string): boolean {
  const parts = path
    .split(/[?#]/, 1)[0]!
    .split("/")
    .filter((s) => s && !PARAM.test(s))
    .flatMap((s) => s.split("."))
    .filter(Boolean);
  if (!parts.length)
    return lines.some((l) => lineNamesRoute(l, path)) || defaultActionAt(lines, path);
  // A slugified segment (`my-account`) is the name written without its hyphens (`MyAccount`).
  return parts.every((p) =>
    [p, p.replace(/-/g, "")].some((q) =>
      lines.some((l) =>
        new RegExp(`(^|[^A-Za-z0-9]|(?<=[a-z0-9])(?=[A-Z]))${escape(q)}`, "i").test(l),
      ),
    ),
  );
}
