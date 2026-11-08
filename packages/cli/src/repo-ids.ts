/**
 * F5: repo ids that don't drift. Two manifest entries for one repo (`forge-deposits-api` and
 * `forge_deposits-api_1-0`) split its facts from what `atticus next` asks for. What makes two
 * entries look like one repo: the same clone URL, or ids equal once letter case, `_` and `-`, and
 * a version suffix (`_1-0`, `-v2`, `-1.0`) are set aside. A warning and a hint, never a refusal:
 * two repos may well differ only in a version.
 */

import { isInPlace } from "@maycombhq/workspace";

/** An id with case, `_` and `-`, and a trailing version set aside. */
export function repoIdKey(id: string): string {
  return id
    .toLowerCase()
    .replace(/_/g, "-")
    .replace(/(?:[-.]v?\d+)+$/, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * A clone URL as compared: no scheme, user, `.git` or trailing slash, an ssh `host:path` read as
 * `host/path`, in lower case. Undefined for a folder of this metarepo (`.`, `./x`, `.\x`,
 * `../x`), which names no clone.
 */
export function cloneUrlKey(url: string): string | undefined {
  const u = url.trim();
  if (!u || isInPlace(u) || /^\.\.[\\/]/.test(u)) return undefined;
  return u
    .replace(/[/\\]+$/, "")
    .replace(/\.git$/i, "")
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/^[^@/]+@/, "")
    .replace(/^([^/:]+):(?!\d+\/)/, "$1/")
    .toLowerCase();
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
