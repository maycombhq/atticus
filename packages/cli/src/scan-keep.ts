import { cmpText, recordPath, type CatalogRecord } from "@maycombhq/core";

/**
 * Beta.26 review: what a scan keeps of the catalog it replaces. The built-in readers are a
 * cross-check beside the assistant's facts (CLAUDE.md rule 4, ADR 0124 §3), never the path to
 * accuracy, so what they can't see is never theirs to remove:
 *
 * - a record of a repo this scan didn't read (not cloned here, a clone it couldn't read, or not
 *   among the repos it was asked for) is kept as it was, a link to such a repo too;
 * - a record projected from verified facts is kept while the readers stand in for its repo (its
 *   facts on file but not usable this time: not verified yet, or of a commit that can't be
 *   compared), and the readers' record of the same kind and id never replaces it; what the
 *   readers find besides is added beside it.
 *
 * Once a repo is read from its facts, the facts decide what goes (a changed file invalidates only
 * what cites it). A repo taken out of the manifest loses its records. Records without a repo
 * (documents, people's decisions, the glossary) are made again by every scan and aren't kept here.
 */
export interface KeepInput {
  /** The catalog as it was. */
  before: readonly CatalogRecord[];
  /** What this scan made. */
  scanned: readonly CatalogRecord[];
  /** The manifest's repos. */
  manifest: readonly string[];
  /** The repos this scan read. */
  read: readonly string[];
  /** Repos read whose records came from the readers though facts are on file for them. */
  standIn: readonly string[];
}

export interface Kept {
  records: CatalogRecord[];
  /** The manifest's repos this scan didn't read, that records were kept for. */
  unread: string[];
  /** Records kept for those repos. */
  keptUnread: number;
  /** Records from verified facts kept while the readers stood in. */
  keptFacts: number;
}

type Ev = { source?: string; repo?: string; by?: string };

const evidenceOf = (r: CatalogRecord): Ev[] =>
  Array.isArray((r as { evidence?: unknown }).evidence) ? (r as { evidence: Ev[] }).evidence : [];

/** The repos a record rests on: its evidence's, and its own `repo` (a component's). */
export function reposOf(r: CatalogRecord): Set<string> {
  const out = new Set<string>();
  for (const e of evidenceOf(r)) if (typeof e.repo === "string" && e.repo) out.add(e.repo);
  const own = (r as { repo?: unknown }).repo;
  if (typeof own === "string" && own) out.add(own);
  return out;
}

/**
 * Projected from the assistant's facts: evidence in a repo with who read it (`by`), which the
 * built-in readers never write; a person's (`manual`) or the AI's decision (`ai`) is not a fact.
 */
export function fromFacts(r: CatalogRecord): boolean {
  return evidenceOf(r).some(
    (e) => typeof e.by === "string" && !!e.repo && e.source !== "manual" && e.source !== "ai",
  );
}

export function keepWhatTheReadersCantSee(i: KeepInput): Kept {
  const read = new Set(i.read);
  const unread = new Set(i.manifest.filter((r) => !read.has(r)));
  const standIn = new Set(i.standIn.filter((r) => read.has(r)));
  const out = new Map(i.scanned.map((r) => [recordPath(r), r]));
  const unreadUsed = new Set<string>();
  let keptUnread = 0;
  let keptFacts = 0;
  for (const b of i.before) {
    const repos = [...reposOf(b)];
    if (!repos.length) continue;
    const facts = fromFacts(b);
    const onUnread = repos.filter((r) => unread.has(r));
    const held = onUnread.length > 0 || (facts && repos.some((r) => standIn.has(r)));
    if (!held) continue;
    const at = recordPath(b);
    const now = out.get(at);
    if (now) {
      // The scan made it too: the earlier one stays only when nothing this scan read made it
      // (every repo it rests on unread), or it is the facts' and the scan's is the readers'.
      const blind = repos.every((r) => unread.has(r));
      const overFacts =
        facts && !fromFacts(now) && repos.every((r) => unread.has(r) || standIn.has(r));
      if (!blind && !overFacts) continue;
      if (JSON.stringify(now) === JSON.stringify(b)) continue;
    }
    out.set(at, b);
    if (onUnread.length) {
      keptUnread++;
      for (const r of onUnread) unreadUsed.add(r);
    } else keptFacts++;
  }
  const records = [...out.values()].sort((a, b) =>
    a.kind === b.kind ? cmpText(a.id, b.id) : cmpText(a.kind, b.kind),
  );
  return {
    records,
    unread: [...unreadUsed].sort(cmpText),
    keptUnread,
    keptFacts,
  };
}
