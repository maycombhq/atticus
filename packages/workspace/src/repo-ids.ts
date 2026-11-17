/**
 * F5: repo ids that don't drift. Two manifest entries for one repo (`forge-deposits-api` and
 * `forge_deposits-api_1-0`) split its facts from what `atticus next` asks for. What makes two
 * entries look like one repo: the same clone URL, or ids equal once letter case, `_` and `-`, and
 * a version suffix (`_1-0`, `-v2`, `-1.0`) are set aside. A warning and a hint, never a refusal:
 * two repos may well differ only in a version.
 */

import { isInPlace } from "./manager.js";

/** An id with case, `_` and `-`, and a trailing version set aside. */
export function repoIdKey(id: string): string {
  return id
    .toLowerCase()
    .replace(/_/g, "-")
    .replace(/(?:[-.]v?\d+)+$/, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The port a scheme uses when none is written: the same server with or without it. */
const DEFAULT_PORT: Record<string, string> = { ssh: "22", https: "443", http: "80" };

/** One part of a path with its percent-encoding read; kept as written when it isn't one. */
function decoded(part: string): string {
  try {
    const d = decodeURIComponent(part);
    // An encoded slash is part of a name, never a folder: such a part stays as written.
    return /[/\\]/.test(d) ? part : d;
  } catch {
    return part;
  }
}

/**
 * A clone URL as compared: no scheme, user, `.git` or trailing slash, an ssh `host:path` read as
 * `host/path`, in lower case. Undefined for a folder of this metarepo (`.`, `./x`, `.\x`,
 * `../x`), which names no clone.
 *
 * ADR 0199 (the review, N3): repos discover leaves a folder unread when a manifest lists its
 * clone URL, so one repo written two ways must compare the same, and no two repos may: `\\` is
 * `/` (a Windows path), each part's percent-encoding is read (`Forge%20Payments`), and a
 * scheme's own default port is no port (`ssh://host:22/x` is `host:x`; any other port is another
 * server). Nothing else is guessed: what one Git host calls the same repo under two addresses
 * (its https and its ssh form, an older host name) is that host's knowledge, an adapter's, and
 * isn't here (ADR 0035).
 */
export function cloneUrlKey(url: string): string | undefined {
  const u = url.trim();
  if (!u || isInPlace(u) || /^\.\.[\\/]/.test(u)) return undefined;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(u)?.[1]?.toLowerCase();
  let k = u
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/^[^@/]+@/, "");
  const port = scheme ? DEFAULT_PORT[scheme] : undefined;
  if (port) k = k.replace(new RegExp(`^([^/:]+):${port}(?=/|$)`), "$1");
  k = k
    .replace(/^([^/:]+):(?!\d+\/)/, "$1/")
    .split("/")
    .map(decoded)
    .join("/")
    .toLowerCase();
  return k;
}

/** A listed repo a new entry looks like, and why. */
export interface NearRepo {
  id: string;
  why: string;
}

export const SAME_ID_WHY =
  "its id is the same once case, '_' and '-', and a version suffix are set aside";

/** The listed repos an entry looks like (not the entry itself): same clone URL, or a near id. */
export function nearRepos(
  entry: { id: string; url?: string },
  listed: readonly { id: string; url?: string }[],
): NearRepo[] {
  const key = repoIdKey(entry.id);
  const url = entry.url ? cloneUrlKey(entry.url) : undefined;
  const out: NearRepo[] = [];
  for (const r of listed) {
    if (r.id === entry.id) continue;
    if (url && r.url && cloneUrlKey(r.url) === url)
      out.push({ id: r.id, why: "it has the same clone URL" });
    else if (key && repoIdKey(r.id) === key) out.push({ id: r.id, why: SAME_ID_WHY });
  }
  return out;
}
