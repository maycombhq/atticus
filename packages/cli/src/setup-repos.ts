import { RecordId } from "@maycombhq/core";
import { cloneUrlKey } from "@maycombhq/workspace";
import { idFromUrl } from "./repo-commands.js";

/**
 * ADR 0190: adding repos in the app. What a person pastes (one clone URL a line, or ~40 at once,
 * as a browser shows them) is read into clone URLs the manifest can hold, each with the id
 * `atticus repo add` would give it; a found repo the manifests list already (the same clone URL)
 * is left out, and an id another repo has is made its own with `-2`, `-3` (as repos discover does
 * since review round 50). Nothing here writes: the person sees the list, ticks what goes in, then
 * the manifest is written through core's addManifestRepos and proposed for review.
 */

/** A repo the app would add, as the person sees it before the manifest is written. */
export interface PlannedRepo {
  id: string;
  /** The clone URL the manifest gets. */
  url: string;
  /** What the person gave, when the URL was normalised from it. */
  given?: string;
  type: string;
  defaultBranch?: string;
  /** The id it would have had, and why it got another. */
  renamed?: { from: string; why: string };
  /** How the type was read, when it was (a clone on this machine, or repos discover). */
  detected?: { signals: string[]; confidence: string };
}

export interface ReposPlan {
  repos: PlannedRepo[];
  /** Given, but listed in a manifest already (the same clone URL): left out. */
  listed: { url: string; id: string }[];
  /** Given, but not a clone URL or a folder Atticus can use, with why. */
  refused: { given: string; why: string }[];
}

/**
 * A clone URL as the manifest keeps it: no credentials (`user:token@`, Git's credential manager
 * supplies them), no query or fragment a browser link has (`.../_git/forge-ledger?path=/src`), no
 * trailing slash; an ssh URL's user is how it signs in, and is kept. Quotes and angle brackets a
 * mail or chat put around it go.
 */
export function normaliseCloneUrl(given: string): string {
  let u = given.trim().replace(/^[<"'(]+|[>"',;)]+$/g, "");
  if (/^https?:\/\//i.test(u)) {
    u = u.replace(/^(https?:\/\/)[^/@]*@/i, "$1").replace(/[?#].*$/, "");
    u = u.replace(/\/+$/, "");
  }
  return u;
}

/** The clone URLs in pasted text: one a line, or several on a line split by spaces or commas. */
export function pastedUrls(text: string): string[] {
  return text
    .split(/[\r\n]+/)
    .flatMap((l) => l.trim().split(/[\s,;]+/))
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#"));
}

/** A candidate, before clashes are settled: from a pasted URL or from repos discover. */
export interface Candidate {
  given: string;
  url: string;
  id: string;
  type?: string;
  defaultBranch?: string;
  detected?: { signals: string[]; confidence: string };
}

/**
 * The candidates against what the manifests list: the same clone URL listed is left out (once),
 * an id that is taken is made its own (`-2`), an id that can't be one is refused, saying why.
 */
export function planRepos(
  candidates: readonly Candidate[],
  listed: readonly { id: string; url?: string }[],
): ReposPlan {
  const plan: ReposPlan = { repos: [], listed: [], refused: [] };
  const byUrl = new Map<string, string>();
  for (const r of listed) {
    const k = r.url ? cloneUrlKey(r.url) : undefined;
    if (k) byUrl.set(k, r.id);
  }
  const taken = new Set(listed.map((r) => r.id));
  const seen = new Set<string>();
  for (const c of candidates) {
    const key = cloneUrlKey(c.url) ?? c.url;
    if (seen.has(key)) continue;
    seen.add(key);
    const there = byUrl.get(key);
    if (there) {
      plan.listed.push({ url: c.url, id: there });
      continue;
    }
    if (!RecordId.safeParse(c.id).success) {
      plan.refused.push({
        given: c.given,
        why: `${c.id || "it"} can't be a repo id (lowercase letters, digits, '.', '_' and '-')`,
      });
      continue;
    }
    let id = c.id;
    let renamed: PlannedRepo["renamed"];
    if (taken.has(id)) {
      for (let n = 2; taken.has(id); n++) id = `${c.id}-${n}`;
      renamed = {
        from: c.id,
        why: listed.some((r) => r.id === c.id)
          ? `the manifest lists ${c.id} already, with another clone URL`
          : `another repo here is ${c.id} too`,
      };
    }
    taken.add(id);
    plan.repos.push({
      id,
      url: c.url,
      ...(c.given.trim() !== c.url ? { given: c.given.trim() } : {}),
      type: c.type ?? "unknown",
      ...(c.defaultBranch ? { defaultBranch: c.defaultBranch } : {}),
      ...(renamed ? { renamed } : {}),
      ...(c.detected ? { detected: c.detected } : {}),
    });
  }
  return plan;
}

/** A pasted URL as a candidate: normalised, with the id repo add would give it. */
export function candidateOf(given: string): Candidate {
  const url = normaliseCloneUrl(given);
  return { given, url, id: idFromUrl(url) };
}
