import { createHash } from "node:crypto";

/**
 * Normalise an HTTP path or topic so the same interface found in different places
 * (caller code, gateway route, callee controller) gets the same identity.
 *
 * - path parameters in any style ({id}, :id, <id>, ${id}) become "{}"
 * - query strings and fragments are dropped
 * - repeated and trailing slashes are removed; a leading slash is ensured for paths
 * - topics (no leading slash in the input and no "/" at all) are returned trimmed
 */
export function normalizePath(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "") return "";
  // Round 47: a parameter's constraint and optional marker go first (`{id:int?}`,
  // `{slug:regex(^[a-z]+$)}`), so a `?` or `#` inside braces isn't read as a query string.
  const withoutQuery = stripParamConstraints(trimmed).split(/[?#]/, 1)[0] ?? "";
  const isPath = withoutQuery.startsWith("/") || withoutQuery.includes("/");
  if (!isPath) return withoutQuery;
  const segments = withoutQuery
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => (/^(\{[^}]*\}|:[^/]+|<[^>]+>|\$\{[^}]*\})$/.test(s) ? "{}" : s));
  return "/" + segments.join("/");
}

/**
 * A path with each `{...}` parameter cut to its name: what follows the first `:`, `?` or `=` in
 * braces nested inside a constraint (`{code:regex(^\\d{3}$)}`) are matched, not cut at the first `}`.
 * braces nested inside a constraint (`{code:regex(^\\d{{3}}$)}`) are matched, not cut at the first `}`.
 * An unclosed `{` leaves the rest as written.
 */
export function stripParamConstraints(path: string): string {
  let out = "";
  let i = 0;
  while (i < path.length) {
    const ch = path[i]!;
    if (ch !== "{") {
      out += ch;
      i++;
      continue;
    }
    let depth = 0;
    let j = i;
    for (; j < path.length; j++) {
      if (path[j] === "{") depth++;
      else if (path[j] === "}" && --depth === 0) break;
    }
    if (j >= path.length) {
      out += path.slice(i);
      break;
    }
    const inner = path.slice(i + 1, j);
    out += "{" + (/^[^:?=]*/.exec(inner)?.[0] ?? "") + "}";
    i = j + 1;
  }
  return out;
}

/** Code-unit string order, the same in every locale (`localeCompare` is not: ICU orders `_`/`-`
 * and, in `da`, `aa` differently), for every sort that feeds records, ids, hashes or a merge. */
export function cmpText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * `cmpText`, but a run of digits is compared as a number (`a.ts:9` before `a.ts:10`): what
 * `localeCompare(b, "en", { numeric: true })` was used for, without ICU.
 */
export function cmpNatural(a: string, b: string): number {
  const pa = a.split(/(\d+)/);
  const pb = b.split(/(\d+)/);
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const x = pa[i]!;
    const y = pb[i]!;
    if (x === y) continue;
    // Odd pieces are digit runs (split with a capture group alternates text and digits).
    if (i % 2 === 1) {
      const nx = x.replace(/^0+(?=\d)/, "");
      const ny = y.replace(/^0+(?=\d)/, "");
      if (nx.length !== ny.length) return nx.length - ny.length;
      if (nx !== ny) return cmpText(nx, ny);
      continue;
    }
    return cmpText(x, y);
  }
  return pa.length !== pb.length ? pa.length - pb.length : cmpText(a, b);
}

/**
 * Stable interface id: a hash of caller, callee, method and normalised path, so the same
 * edge seen by several extractors merges into one Interface record.
 */
export function interfaceId(
  from: string,
  to: string,
  method: string | undefined,
  path: string,
): string {
  const key = [from, to, (method ?? "").toUpperCase(), normalizePath(path)].join("|");
  return "if-" + createHash("sha256").update(key, "utf8").digest("hex").slice(0, 16);
}

/** Lowercase slug suitable as a record id, built from free text such as a system name. */
export function slugify(text: string): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  const out = slug.slice(0, 120);
  return /[a-z0-9]/.test(out) ? out : unnamedId(text);
}

/**
 * Round 47: a name with no Latin letter or digit in it (`注文`, `Заказы`, `...`) slugs to
 * nothing, so every such name used to become the same `unnamed` and their records merged.
 * It gets `unnamed-<short hash of the name>` instead: stable, and different per name. Blank
 * text stays `unnamed`.
 */
export function unnamedId(text: string): string {
  const name = text.normalize("NFC").trim();
  if (name === "") return "unnamed";
  return "unnamed-" + createHash("sha256").update(name, "utf8").digest("hex").slice(0, 8);
}
