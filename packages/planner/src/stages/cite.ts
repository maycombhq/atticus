/**
 * A model that cites a line by the data block it read it in (`atticus-data:brief.md:5`, or
 * `brief.md:5` for a block whose id is brief.md) means that block's file: the prompt gives each
 * block an id and the file it came from (its origin). The citation is read as that file's line,
 * exactly; a block whose origin isn't a file (the estate index, the instructions) is left alone,
 * so its citation is still handed back. Seen with GPT-4o mini on NadiEngine, on every draft.
 */

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The answer with each citation of a file block's id read as that file's path. */
export function citeFiles(answer: string, blocks: { id: string; origin: string }[]): string {
  let out = answer;
  for (const b of blocks) {
    // Only an origin that is a path in the metarepo: no spaces, a file name with an extension.
    if (!/^[\w./-]+\.\w+$/.test(b.origin) || b.origin === b.id) continue;
    const re = new RegExp(`(?<![\\w/.-])(?:atticus-data:)?${escape(b.id)}:(\\d+)`, "g");
    out = out.replace(re, `${b.origin}:$1`);
  }
  return out;
}
