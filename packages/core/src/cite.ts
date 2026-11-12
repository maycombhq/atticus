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

/** Whether a path names a binary file by its extension (an image, an archive, a font, a build). */
export function isBinaryPath(path: string): boolean {
  return BINARY.test(path);
}

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

/**
 * Paths whose lines are never quoted into a map. Each part is read as NTFS opens it (review round
 * 46): a stream's name after `:` (`.env::$DATA` is `.env`) and trailing dots and spaces dropped.
 */
export function isSecretPath(path: string): boolean {
  const p = path
    .replace(/\\/g, "/")
    .split("/")
    .map((x) => x.replace(/:.*$/, "").replace(/[. ]+$/, ""))
    .join("/");
  return SECRET_PATH.some((re) => re.test(p));
}

const SECRET_KEY =
  /(password|passwd|pwd|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?secret|credential)/i;
const PLACEHOLDER = /^(\$\{|\{\{|env:|vault:|secret:|ref:|<)/;
// The key's last part ends in a secret word (ClientSecret, db.password, "api_key"), so TokenUrl
// and AccessTokenLifetime aren't secrets.
const KEY_VALUE =
  /^(\s*[-"']?\s*)([A-Za-z0-9_.:-]*?(?:password|passwd|pwd|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|credentials?))(["']?\s*[:=]\s*)(.+)$/i;

const SECRET_WORDS =
  "(?:password|passwd|pwd|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|credentials?)";
// Review round 47: a secret-looking key anywhere on the line (a declaration, a JSON member, an
// argument), an optional type (`apiKey: String`), `=` (not `==`), `:`, `:=` or `=>`, then a
// quoted literal.
const KEY_LITERAL = new RegExp(
  `((?:^|[^A-Za-z0-9_.$-])[A-Za-z0-9_.$-]*?${SECRET_WORDS}["'\`]?\\]?(?:\\s*:\\s*[A-Za-z_][\\w.<>?\\[\\]]*(?=\\s*=))?\\s*(?::=|=>|=(?!=)|:(?!:))\\s*)(["'\`])((?:(?!\\2)[^\\\\]|\\\\.)+)\\2`,
  "i",
);
// A setter given a literal: setPassword("x"), withApiKey('x').
const SETTER_LITERAL = new RegExp(
  `(\\b(?:set|with)[A-Za-z0-9_]*?${SECRET_WORDS}\\s*\\(\\s*)(["'\`])((?:(?!\\2)[^\\\\]|\\\\.)+)\\2`,
  "i",
);
// An unquoted value after a key in a shell export, a command-line flag, a query string or a
// connection string: export DB_PASSWORD=x, --password=x, ?password=x, ;Password=x;
const KEY_BARE = new RegExp(
  `((?:\\bexport\\s+|--|[?&;])[A-Za-z0-9_.-]*?${SECRET_WORDS}\\s*=\\s*)([^\\s&;"'\`]+)`,
  "gi",
);
// A URL's password: scheme://user:password@host.
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)([^\s@/]+)(?=@)/gi;
const BEARER = /\b(Bearer\s+)([A-Za-z0-9._~+/-]{16,}=*)/g;
const BASIC = /\b(Basic\s+)((?=[A-Za-z0-9+/]*[0-9+/=])[A-Za-z0-9+/]{12,}={0,2})/g;
// Well-known token shapes, whatever names them: GitHub, Stripe, AWS access key ids, Slack,
// Google API keys and JWTs.
const TOKEN_SHAPES = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];

/**
 * Beta.27 review: the well-known token prefixes, whatever follows them (TOKEN_SHAPES want the
 * whole token, so a token cut short or typed in part passes them): a Git host's personal, project
 * and deploy tokens, a package registry's, a model hub's, a payment provider's secret, restricted,
 * publishable and webhook keys, a chat workspace's bot, user and app tokens, a cloud's access key
 * ids, API keys and OAuth access tokens, a JWT's header, a mail service's key, a point-of-sale
 * provider's access and secret keys, a telephony provider's API key and account ids, a data
 * platform's token, a storage account's key in a connection string, a shared access signature,
 * and a bearer or Basic authorization. One list: a run's title (run-log.ts) drops a word with one.
 */
export const TOKEN_PREFIXES: readonly RegExp[] = [
  /\bgh[pousr]_/,
  /\bgithub_pat_/,
  /\bgl(?:pat|ptt|dt|rt|cbt|imt|soat|ffct|agent)-/,
  /\bnpm_/,
  /\bpypi-/,
  /\bhf_/,
  /\b(?:sk|rk|pk)[-_]/,
  /\bwhsec_/,
  /\bxox[abeprs]-/,
  /\bxapp-/,
  /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[0-9A-Z]{4}/,
  /\bAIza/,
  /\beyJ/,
  /\bya29\./,
  /\bshp(?:at|ss|ca|pa)_/,
  /\bdop_v1_/,
  /\bSG\./,
  /\bsq0(?:atp|csp|idp)-/,
  /\bEAAA[A-Za-z0-9]/,
  /\bSK[0-9a-fA-F]{8}/,
  /\bAC[0-9a-f]{8}/,
  /\bdapi[0-9a-f]{8}/,
  /AccountKey=/i,
  /SharedAccessSignature|[?&]sig=/i,
  /\bBearer\s/i,
  /\bBasic\s/i,
];

/** Whether a text holds one of TOKEN_PREFIXES anywhere (beta.27 review). */
export const hasTokenPrefix = (text: string): boolean => TOKEN_PREFIXES.some((re) => re.test(text));
/**
 * Whether a text holds a secret by its shape alone, whatever names it (beta.24 review): a URL's
 * password (`jdbc:postgresql://user:pass@host`), a bearer or Basic token or one of the well-known token
 * shapes `redactSecrets` takes out. A reference (`${X}`, `env:X`) in the password's place is none.
 * `basic: false` leaves the Basic token out, as beta.24 released the check: the facts schema
 * keeps it so (the verifier and Trust's secrets check take the Basic token).
 */
export function hasSecretShape(text: string, o: { basic?: boolean } = {}): boolean {
  for (const m of text.matchAll(URL_CREDENTIALS)) if (!refersOnly(m[2]!)) return true;
  if (new RegExp(BEARER.source).test(text)) return true;
  // Beta.25 review: a Basic authorization value (`Basic dXNlcjpw…`) is a user and password.
  if (o.basic !== false && new RegExp(BASIC.source).test(text)) return true;
  return TOKEN_SHAPES.some((re) => new RegExp(re.source).test(text));
}

/**
 * Beta.27 re-review: a text with what hasSecretShape finds in it masked (`***`, keeping what names
 * it): a URL's password, a bearer or Basic token, the well-known token shapes. A run's log line
 * goes through it, so an echoed error ("Can't read <root>/AKIA…") never keeps a key.
 */
export function maskSecretShapes(text: string, mask = "***"): string {
  let out = text.replace(URL_CREDENTIALS, (all, head: string, pass: string) =>
    refersOnly(pass) ? all : `${head}${mask}`,
  );
  out = out.replace(BEARER, `$1${mask}`).replace(BASIC, `$1${mask}`);
  for (const re of TOKEN_SHAPES) out = out.replace(re, mask);
  return out;
}

/**
 * Review of beta.24: whether a key is itself a secret, so naming its line by it would show one: a
 * well-known token shape (an access key id written as a credentials file's key), a run of 24 hex
 * digits or more (a random id, a digest), a run of 16 letters and digits or more that switches
 * between them as a random token does (`q7Xf3Kd9…`), or (round 4) 32 characters or more of one
 * piece (no `_`, `-` or `.`) in base64's or hex's alphabet, digits and letters both, or 32
 * characters or more of base64url's alphabet with digits and both cases.
 * A key of words, however abbreviated (`MSSQL_SA_PWD_2019`, `x509Certificate2Path`), is shown.
 * Beta.27: here in core (it was the verifier's), so a run's title drops a value shaped so too.
 */
export function keyIsSecret(key: string): boolean {
  if (hasSecretShape(key)) return true;
  for (const run of key.match(/[0-9a-f]{24,}|[0-9A-F]{24,}/g) ?? [])
    if (/\d/.test(run) && /[a-f]/i.test(run)) return true;
  const digitsAndLetters = /\d/.test(key) && /[A-Za-z]/.test(key);
  if (key.length >= 32 && /^[A-Za-z0-9+/=]+$/.test(key) && digitsAndLetters) return true;
  // base64url (a JWT's parts, many API tokens): `-` and `_` too, so digits and both cases.
  if (
    key.length >= 32 &&
    /^[A-Za-z0-9_-]+$/.test(key) &&
    /\d/.test(key) &&
    /[a-z]/.test(key) &&
    /[A-Z]/.test(key)
  )
    return true;
  if (key.length < 16 || !/^[A-Za-z0-9+/=]+$/.test(key) || !/\d/.test(key)) return false;
  const kind = (c: string) => (/\d/.test(c) ? 0 : /[a-z]/.test(c) ? 1 : 2);
  let switches = 0;
  for (let i = 1; i < key.length; i++) if (kind(key[i]!) !== kind(key[i - 1]!)) switches++;
  return switches >= key.length / 2;
}

/** A value that only refers to a secret: `${X}`, `{{ x }}`, `env:X`, `vault:...`, `<...>`. */
const placeholder = (v: string) => PLACEHOLDER.test(v.trim().replace(/^["'`]/, ""));
const refersOnly = (v: string) => placeholder(v) || /^[$%{]/.test(v);

/**
 * Redact the secrets on a line, keeping what names them: a value after a secret-looking key
 * (at the line's start, whatever the value; anywhere on it, a quoted literal), a setter's
 * literal, a URL's password, a bearer or basic token and well-known token shapes. A
 * placeholder or a reference (`${X}`, `env:X`, `vault:...`) stays, as does code that only names
 * a secret word (`if (password == null)`, `tokenizer.next()`). A private-key block is redacted
 * whole. A key's value is redacted to the end of the line.
 */
export function redactSecrets(line: string): string {
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(line)) return "<redacted>";
  let out = line;
  if (SECRET_KEY.test(out)) {
    const m = KEY_VALUE.exec(out);
    if (m && !placeholder(m[4]!)) out = `${m[1]}${m[2]}${m[3]}<redacted>`;
    for (const re of [KEY_LITERAL, SETTER_LITERAL]) {
      const k = re.exec(out);
      if (k && !placeholder(k[3]!)) out = `${out.slice(0, k.index)}${k[1]}<redacted>`;
    }
    out = out.replace(KEY_BARE, (all, key: string, v: string) =>
      refersOnly(v) || v === "<redacted>" ? all : `${key}<redacted>`,
    );
  }
  out = out.replace(URL_CREDENTIALS, (all, head: string, pass: string) =>
    refersOnly(pass) ? all : `${head}<redacted>`,
  );
  out = out.replace(BEARER, "$1<redacted>").replace(BASIC, "$1<redacted>");
  for (const re of TOKEN_SHAPES) out = out.replace(re, "<redacted>");
  return out;
}

const SECRET_IDENT = new RegExp(`[A-Za-z0-9_]*${SECRET_WORDS}[A-Za-z0-9_]*`, "i");
const OPAQUE_LITERAL = /(["'`])([^\s"'`]{8,})\1/g;

/**
 * Whether a quote redaction left as it is still holds what looks like a secret: an identifier
 * with a secret word and an opaque quoted literal (8 or more characters with letters and digits,
 * no spaces, not a path, URL or placeholder) on the same line, e.g.
 * `creds.put(PASSWORD_KEY, "Xk9fQ2mZ7p")`. Code that only names a secret word
 * (`passwordEncoder.encode(x)`, `getToken("Authorization")`) doesn't.
 */
export function quoteHoldsSecret(quote: string): boolean {
  if (!SECRET_IDENT.test(quote)) return false;
  for (const m of quote.matchAll(OPAQUE_LITERAL)) {
    const v = m[2]!;
    if (/^[/.#$%{<]/.test(v) || v.includes("://") || placeholder(v)) continue;
    if (/[A-Za-z]/.test(v) && /[0-9]/.test(v)) return true;
  }
  return false;
}

/**
 * Whether a path put together in code is named by its lines (ADR 0124 addendum A4): every plain
 * part of the path (its segments, a dotted segment's pieces: `BasketApi.Basket/GetBasket`) is
 * written on one of the lines, case aside, at the start of a word or of an identifier
 * (`account` in `AccountController`). Parameters need not be written.
 */
/**
 * Whether `/` is a conventional route's default action: a default route is declared
 * (`MapDefaultControllerRoute`, a template like `{controller=Home}/{action=Index}`, or MVC 5's
 * `defaults: new { controller = "Home", action = "Index" }`) and the
 * lines name that controller's class and that action.
 */
function defaultActionAt(lines: readonly string[], path: string): boolean {
  if (path.split(/[?#]/, 1)[0]!.replace(/\/+/g, "") !== "") return false;
  const text = lines.join("\n");
  const mvc5 = /defaults:\s*new\s*\{[^}]*\}/.exec(text)?.[0];
  if (!/MapDefaultControllerRoute|\{controller=\w+\}/.test(text) && !mvc5) return false;
  const controller =
    /\{controller=(\w+)\}/.exec(text)?.[1] ??
    (mvc5 ? /controller\s*=\s*"(\w+)"/.exec(mvc5)?.[1] : undefined) ??
    "Home";
  const action =
    /\{action=(\w+)\}/.exec(text)?.[1] ??
    (mvc5 ? /action\s*=\s*"(\w+)"/.exec(mvc5)?.[1] : undefined) ??
    "Index";
  return (
    new RegExp(`\\b${controller}Controller\\b`).test(text) &&
    new RegExp(`\\b${action}\\s*\\(`).test(text)
  );
}

// Beta.24 review: `-` joins a word (`forge-remote`), so no piece of it comes from another line.
const WORD_SEP = "[:._/#\\s]";

/**
 * Whether a word claim is put together from `cite.with` parts (ADR 0124 addendum A-derived): a
 * rake task's `namespace:task`, a key a helper prefixes (`${prefix}_conferenceCache`). Each part's
 * value must be in the claim as a whole piece (bounded by the claim's start or end, a separator
 * `: . _ / #`, or another part; `-` joins a word), and whatever is left between the parts,
 * separators aside, must be written on the cited lines: at least one piece, so the cited lines
 * name some of the word. The parts' own lines are checked by the caller.
 */
export function partsBuildWord(
  claim: string,
  parts: readonly string[],
  lines: readonly string[],
): boolean {
  if (!parts.length) return false;
  let s = claim.trim();
  for (const raw of parts) {
    const v = raw.trim();
    if (!v) return false;
    const before = new RegExp(`^${WORD_SEP}`).test(v) ? "" : `(?<=^|${WORD_SEP}|\\u0000)`;
    const after = new RegExp(`${WORD_SEP}$`).test(v) ? "" : `(?=$|${WORD_SEP}|\\u0000)`;
    const re = new RegExp(`${before}${escape(v)}${after}`, "i");
    if (!re.test(s)) return false;
    s = s.replace(re, "\u0000");
  }
  const edge = new RegExp(`^${WORD_SEP}+|${WORD_SEP}+$`, "g");
  const rest = s
    .split("\u0000")
    .map((p) => p.replace(edge, ""))
    .filter(Boolean);
  // Beta.24 review: parts that are the whole word leave the cited lines naming nothing of it.
  return rest.length > 0 && rest.every((p) => lines.some((l) => lineNamesWord(l, p)));
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
