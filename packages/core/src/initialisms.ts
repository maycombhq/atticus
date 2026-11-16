/**
 * An acronym and the words it stands for (beta.28.3): "SSO" and "single sign-on", "EDW" and
 * "enterprise data warehouse". One side of a search often writes the letters and the other the
 * words, with no word in common and no glossary alias, and a small embedding model rates the
 * two far apart. This reads the link from the letters themselves: an all-capital word of three
 * to six letters on one side, and on the other a run of words whose first letters spell it.
 * Deterministic, no model: the same two texts give the same links. A link only ranks and keeps
 * what a search shows; it never makes a record, a name or a fact.
 */

/** Words that join a name's words without giving it a letter: "point of sale" is POS. */
const JOINING = new Set(["a", "an", "and", "for", "in", "of", "on", "or", "the", "to"]);

const ACRONYM = /(?<![A-Za-z0-9])[A-Z][A-Z0-9]{2,5}(?=s?(?![A-Za-z0-9]))/g;

/**
 * The acronyms a text writes: all-capital words of three to six letters or digits starting with
 * a letter (a plural's "s" off), each once, in the order met. A line written all in capitals
 * names nothing: its words are left out.
 */
export function acronymsIn(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const found = [...line.matchAll(ACRONYM)].map((m) => m[0]);
    if (!found.length) continue;
    // A shouted line: three or more words and none with a small letter.
    const words = line.match(/[A-Za-z][A-Za-z0-9]*/g) ?? [];
    if (words.length >= 3 && !words.some((w) => /[a-z]/.test(w))) continue;
    for (const a of found)
      if (!seen.has(a)) {
        seen.add(a);
        out.push(a);
      }
  }
  return out;
}

interface Word {
  text: string;
  start: number;
  end: number;
  /** Joined to the word before it by a hyphen (the "on" of sign-on gives a letter). */
  hyphened: boolean;
}

/** A text's runs of words: broken at a line's end and at any punctuation but a hyphen. */
function runs(text: string): Word[][] {
  const out: Word[][] = [];
  let run: Word[] = [];
  let last = 0;
  for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9']*/g)) {
    const between = text.slice(last, m.index);
    const joined = run.length > 0 && /^(?:[ \t]+|-)$/.test(between);
    if (!joined && run.length) {
      out.push(run);
      run = [];
    }
    run.push({
      text: m[0],
      start: m.index,
      end: m.index + m[0].length,
      hyphened: joined && between === "-",
    });
    last = m.index + m[0].length;
  }
  if (run.length) out.push(run);
  return out;
}

/**
 * The words in a text an acronym stands for: the first run of whole words whose first letters
 * spell it, as written. A joining word (of, and, the) between them gives a letter or is stepped
 * over ("point of sale" is POS and PS); it ends the run only when a hyphen ties it to the word
 * before ("sign-on"). The run never starts on one, never crosses punctuation or a line's end,
 * and none of its words is the acronym itself. Undefined when the text doesn't spell it, or the acronym isn't three to six letters.
 */
export function spelledOut(acronym: string, text: string): string | undefined {
  return speller(text)(acronym);
}

/**
 * `spelledOut` for many acronyms against one text: the text is read into its runs of words once.
 */
export function speller(text: string): (acronym: string) => string | undefined {
  // Each word a run could start on, by its first letter.
  const starts = new Map<string, { run: Word[]; i: number }[]>();
  for (const run of runs(text))
    for (let i = 0; i + 1 < run.length; i++) {
      const lower = run[i]!.text.toLowerCase();
      if (JOINING.has(lower)) continue;
      const at = starts.get(lower[0]!);
      if (at) at.push({ run, i });
      else starts.set(lower[0]!, [{ run, i }]);
    }
  return (acronym) => {
    const letters = acronym.toLowerCase();
    if (!/^[a-z][a-z0-9]{2,5}$/.test(letters)) return undefined;
    for (const { run, i } of starts.get(letters[0]!) ?? []) {
      /** The last word of a run from `at` that spells the letters from `k`, if one does. */
      const spell = (at: number, k: number, last: Word): Word | undefined => {
        if (k === letters.length) return last;
        const w = run[at];
        if (!w) return undefined;
        const lower = w.text.toLowerCase();
        if (lower === letters) return undefined;
        const joining = JOINING.has(lower);
        // A joining word gives a letter inside the run, or at its end when hyphened ("sign-on").
        const mayGive = !joining || w.hyphened || k < letters.length - 1;
        if (mayGive && lower[0] === letters[k]) {
          const got = spell(at + 1, k + 1, w);
          if (got) return got;
        }
        return joining ? spell(at + 1, k, last) : undefined;
      };
      const first = run[i]!;
      if (first.text.toLowerCase() === letters) continue;
      const end = spell(i + 1, 1, first);
      if (end) return text.slice(first.start, end.end);
    }
    return undefined;
  };
}

export interface InitialismLink {
  acronym: string;
  /** The words it stands for, as the other text writes them. */
  phrase: string;
  /** Which text writes the acronym. */
  acronymIn: "a" | "b";
}

/**
 * The acronyms one text writes that the other spells out, a's first, each in the order met. An
 * acronym both texts write is a word in common, not a link, and is left out.
 */
export function initialismLinks(a: string, b: string): InitialismLink[] {
  const inA = acronymsIn(a);
  const inB = acronymsIn(b);
  const out: InitialismLink[] = [];
  const spellB = inA.length ? speller(b) : undefined;
  for (const acronym of inA) {
    if (inB.includes(acronym)) continue;
    const phrase = spellB!(acronym);
    if (phrase) out.push({ acronym, phrase, acronymIn: "a" });
  }
  const spellA = inB.length ? speller(a) : undefined;
  for (const acronym of inB) {
    if (inA.includes(acronym)) continue;
    const phrase = spellA!(acronym);
    if (phrase) out.push({ acronym, phrase, acronymIn: "b" });
  }
  return out;
}
