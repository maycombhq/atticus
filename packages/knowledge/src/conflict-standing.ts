import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { authorityRank, type PageStanding } from "@maycombhq/core";
import type { ConflictOwner } from "./conflict-owner.js";
import type { KnowledgeConflict, PageRef } from "./knowledge-scan.js";
import { readMarkdown } from "./markdown.js";
import { readManifest, snapshotCopyPath, snapshotDates } from "./snapshot.js";
import {
  authorityWords,
  exceptionTo,
  pageStandingOf,
  scopeWords,
  type SourceSettings,
} from "./standing.js";

/**
 * Which page of a disagreement to suggest, by what the pages are worth (ADR 0132), read when the
 * conflict is shown, so a change to sources.yaml applies at once and an older scan's report is
 * read the same way. In order, the first that tells the pages apart:
 *
 * 1. status: one page is current and the others are deprecated, superseded or archived;
 * 2. exception: a less authoritative page records an approved exception (an ADR, waiver or
 *    exception id, or "approved by") to the other page, naming it: it is suggested within its
 *    source's scope, and the other page outside it (`otherwise`);
 * 3. authority: one page's standing is above every other's (a standard over a team's page); a
 *    standard not updated within its source's review months is said to be possibly out of date.
 *
 * Otherwise the scan's own signal stands (conflict-owner.ts). Every one is a suggestion: a
 * person still decides, and a fact verified from code still settles it first.
 */

/** What is read of one page of a conflict: its standing, title and text. */
interface PageInfo extends PageRef {
  standing: PageStanding;
  title?: string;
  text: string;
}

export type PageReader = (p: PageRef) => Promise<PageInfo | undefined>;

/** A reader of single pages from each source's newest snapshot, its manifests kept. */
export function snapshotPageReader(
  root: string,
  settings: SourceSettings,
  now?: string,
): PageReader {
  const manifests = new Map<
    string,
    Promise<{ date: string; m: Awaited<ReturnType<typeof readManifest>> } | undefined>
  >();
  const manifest = (source: string) => {
    if (!manifests.has(source))
      manifests.set(
        source,
        (async () => {
          const date = (await snapshotDates(root, source))[0];
          return date ? { date, m: await readManifest(root, source, date) } : undefined;
        })(),
      );
    return manifests.get(source)!;
  };
  const pages = new Map<string, Promise<PageInfo | undefined>>();
  return (p) => {
    const key = `${p.source}/${p.page}`;
    if (!pages.has(key))
      pages.set(
        key,
        (async () => {
          const s = await manifest(p.source);
          const e = s?.m?.pages.find((x) => x.page === p.page);
          if (!s || !e) return undefined;
          const path = snapshotCopyPath(root, p.source, s.date, e);
          const text = await readFile(join(root, ...path.split("/")), "utf8").catch(
            () => undefined,
          );
          if (text === undefined) return undefined;
          const doc = readMarkdown(text);
          const fmDate = /^(\d{4}-\d{2}-\d{2})/.exec(
            String(doc.frontMatter.updated ?? doc.frontMatter["last-updated"] ?? e.date ?? ""),
          )?.[1];
          const standing = pageStandingOf(
            {
              source: p.source,
              pagePath: p.page,
              frontMatter: doc.frontMatter,
              text,
              ...(fmDate ? { date: fmDate } : {}),
            },
            settings,
            now,
          );
          return { ...p, standing, ...(doc.title ? { title: doc.title } : {}), text };
        })(),
      );
    return pages.get(key)!;
  };
}

const ref = (p: PageRef) => `${p.source}/${p.page}`;
const and = (xs: string[]) =>
  xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;

/** The page a standing suggests for a conflict, or the scan's own signal; undefined when none. */
export async function standingSuggestion(
  c: Pick<KnowledgeConflict, "pages" | "owner">,
  read: PageReader,
  settings: SourceSettings,
  now?: string,
): Promise<ConflictOwner | undefined> {
  const infos = (await Promise.all(c.pages.map(read))).filter((x) => x !== undefined);
  if (infos.length < 2 || infos.length !== c.pages.length) return c.owner;

  // 1. The one current page among pages no longer current.
  const current = infos.filter((i) => i.standing.status === "current");
  if (current.length === 1) {
    const others = infos.filter((i) => i !== current[0]);
    return {
      source: current[0]!.source,
      page: current[0]!.page,
      signal: "status",
      detail: `${ref(current[0]!)} is current; ${and(others.map((o) => `${ref(o)} is ${o.standing.status} (${o.standing.by ?? "its source says so"})`))}`,
    };
  }

  const authority = authoritySuggestion(infos, now);
  // 2. An approved exception to a more authoritative page, within its scope.
  for (const low of infos)
    for (const high of infos) {
      if (low === high) continue;
      if (authorityRank(low.standing.authority) <= authorityRank(high.standing.authority)) continue;
      const approval = exceptionTo(low.text, {
        source: high.source,
        page: high.page,
        ...(high.title ? { title: high.title } : {}),
      });
      if (!approval) continue;
      const scope = settings.get(low.source)?.appliesTo;
      return {
        source: low.source,
        page: low.page,
        signal: "exception",
        detail: `${ref(low)} records an approved exception to ${ref(high)} (${approval}), which is ${authorityWords[high.standing.authority]}; it is suggested within its scope (${scopeWords(scope)}), and ${ref(high)} outside it`,
        ...(scope ? { scope } : {}),
        ...(authority ? { otherwise: authority } : {}),
      };
    }

  // 3. The most authoritative page.
  return authority ?? c.owner;
}

function authoritySuggestion(infos: PageInfo[], now?: string): ConflictOwner | undefined {
  const ranked = [...infos].sort(
    (a, b) => authorityRank(a.standing.authority) - authorityRank(b.standing.authority),
  );
  const top = ranked[0]!;
  if (authorityRank(top.standing.authority) === authorityRank(ranked[1]!.standing.authority))
    return undefined;
  const o = top.standing.outOfDate;
  return {
    source: top.source,
    page: top.page,
    signal: "authority",
    detail: `${ref(top)} is ${authorityWords[top.standing.authority]} (${top.source}), above ${and(ranked.slice(1).map((x) => `${ref(x)}, ${authorityWords[x.standing.authority]}`))}${o ? `; it may be out of date: last updated ${o.since}, more than ${o.months} months before ${(now ?? "").slice(0, 10) || "today"}` : ""}`,
  };
}
