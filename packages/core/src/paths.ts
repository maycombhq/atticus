/**
 * `@maycombhq/core/paths`: how the join normalises an HTTP path or a topic, with no imports, so
 * the app (a browser bundle that takes nothing else of core at run time) matches a call's path to
 * a link's exactly as the join made the link (review of beta.24). The same export as the
 * package's own (`@maycombhq/core`).
 */

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

/**
 * ADR 0210 part 5: a budget limit in words ("40 sessions a day"), here for the same reason (no
 * imports): the app's AI tab and the command line say a limit alike.
 */
export const limitWords = (l: { per: string; sessions?: number; tokens?: number }) =>
  [l.sessions && plural(l.sessions, "session"), l.tokens && plural(l.tokens, "token")]
    .filter(Boolean)
    .join(" and ") + ` a ${l.per}`;
const plural = (x: number, w: string) => `${x.toLocaleString("en-US")} ${w}${x === 1 ? "" : "s"}`;

/**
 * ADR 0210 part 4: the words of Apply's pairing, here for the same reason (no imports): the
 * command line's lines after Apply and the app's Decided by AI (`COPY.applyPairs`) say them alike.
 */
export const PAIR_WORDS = {
  what: "Apply's pairing",
  line: (paired: number, loose: number) =>
    `Paired ${paired} ${paired === 1 ? "call" : "calls"}; ${loose} left loose.`,
  withdrew: (n: number) =>
    `Withdrew ${n} AI ${n === 1 ? "pairing" : "pairings"} whose lines changed.`,
  dropped: (call: string, entry: string, why: string) => `Dropped ${call} → ${entry}: ${why}`,
  loose: (call: string) => `Left loose: ${call}`,
  notSent: "the call wasn't sent: no entry could serve it",
  notCandidate: "the entry isn't one of the call's candidates",
  notCallLine: "it doesn't cite the call's line",
  notEntryLine: "it doesn't cite the entry's line",
  gone: "the call or the entry is no longer in the facts this Apply writes",
  failed: (why: string) => `The pairing session failed: ${why}`,
  aiOff: "AI is off (runtime.yaml ai): the loose calls stay listed.",
  off: "runtime.yaml apply.pair is off: the loose calls stay listed.",
  noRuntime: "No runtime here may decide (runtime.yaml modes): the loose calls stay listed.",
  handOff:
    "Under hand-off Apply pairs nothing: the loose calls stay listed, and Connect's Match pairs them.",
  session: "Inside an assistant's session nothing is paired (ADR 0115).",
} as const;
