import type { Expand, Item } from "./sidebar-data";

/**
 * A filter wherever a list grows (ADR 0105 addendum): Waiting on you, Changes and Knowledge. One
 * box, the same words as the app's ("Filter: words to match, for example forge-ledger"), matched
 * case-insensitively against a row's title, id, change and repo, and the words it shows beside
 * them. Every word must be somewhere in the row. A matching parent keeps its children; a parent
 * shows when any child matches. No `vscode` here, so it is tested outside the editor.
 */

export const FILTER_PLACEHOLDER = "Words to match, for example forge-ledger";
export const FILTER_PROMPT =
  "Show only the rows that match these words: a title, an id, a change or a repo. Leave it empty to show everything.";

/** The words to match, lower case. */
export const filterWords = (text: string): string[] =>
  text.toLowerCase().split(/\s+/).filter(Boolean);

/** The view's description while a filter is on. */
export const filterDescription = (text: string): string | undefined =>
  text.trim() ? `filter: ${text.trim()}` : undefined;

/** What a row is matched against, lower case. */
export function itemText(it: Item): string {
  const parts: (string | undefined)[] = [it.label, it.id, it.description, ...(it.words ?? [])];
  if (it.need) parts.push(it.need.change, it.need.item);
  if (it.finding) parts.push(it.finding.change, it.finding.id, it.finding.artifact);
  if (it.knowledge) parts.push(it.knowledge.id);
  if (it.task) parts.push(it.task.change, it.task.id);
  if (it.source) parts.push(it.source);
  if (it.expand && "change" in it.expand) parts.push(it.expand.change);
  if (it.expand && "repo" in it.expand) parts.push(it.expand.repo);
  return parts.filter(Boolean).join("\n").toLowerCase();
}

const matches = (text: string, words: string[]) => words.every((w) => text.includes(w));

/** The rows that match, each parent with what matches under it; all of them without words. */
export function filterTree<T>(
  rows: T[],
  text: string,
  o: {
    text: (t: T) => string;
    kids: (t: T) => T[] | undefined;
    withKids: (t: T, kids: T[]) => T;
  },
): T[] {
  const words = filterWords(text);
  if (!words.length) return rows;
  const walk = (ts: T[]): T[] =>
    ts.flatMap((t) => {
      if (matches(o.text(t), words)) return [t];
      const below = o.kids(t);
      const kept = below?.length ? walk(below) : [];
      return kept.length ? [o.withKids(t, kept)] : [];
    });
  return walk(rows);
}

/** The one row a filter that matches nothing leaves: what was filtered, cleared with a click. */
export function noMatchRow(text: string, section: string, clear: string): Item {
  const words = text.trim();
  return {
    id: "filter:none",
    label: `Nothing in ${section} matches “${words}”`,
    description: "Click to clear the filter",
    tooltip: `No row in ${section} has these words in its title, id, change or repo: ${words}. Click to clear the filter and show every row.`,
    icon: "filter",
    command: { command: clear },
  };
}

/** A list filtered, or the one row that says nothing matched. */
export function filterItems<T extends Item>(
  rows: T[],
  text: string,
  section: string,
  clear: string,
  o: { kids: (t: T) => T[] | undefined; withKids: (t: T, kids: T[]) => T },
): (T | Item)[] {
  if (!filterWords(text).length) return rows;
  const kept = filterTree(rows, text, { text: itemText, ...o });
  return kept.length ? kept : [noMatchRow(text, section, clear)];
}

/**
 * The parts of a section a filter looks below: those read with the section (the Knowledge
 * section's sources, items, what the last scan changed and searches). A change's parts are read
 * from the app one change at a time, so a change shows when it matches itself.
 */
export const RESOLVED_BELOW: ReadonlySet<Expand["kind"]> = new Set<Expand["kind"]>([
  "sources",
  "knowledge-items",
  "knowledge-group",
  "last-scan",
  "finds",
  "find",
]);
