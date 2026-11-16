/**
 * An acronym and the words it stands for (beta.28.3): "SSO" and "single sign-on", "EDW" and
 * "enterprise data warehouse". One side of a search often writes the letters and the other the
 * words, with no word in common, and a small embedding model rates the two far apart.
 *
 * The link is taken only from where the organisation's own pages define it: "Enterprise Data
 * Warehouse (EDW)", "EDW (Enterprise Data Warehouse)", or a line of an abbreviations list
 * ("EDW: Enterprise Data Warehouse", "| SSO | single sign-on |"), and only when the words' first
 * letters spell the acronym. Letters alone are not enough: ordinary prose spells most
 * three-letter acronyms by chance ("step still open" is no SSO), so a run of words is never
 * taken for an acronym's meaning unless a page sets the two side by side. Deterministic, no
 * model. A link only ranks and keeps what a search shows; it never makes a record or a fact.
 */

export interface Initialism {
  /** As written: capital letters and digits, two to six, starting with a letter. */
  acronym: string;
  /** The words it stands for: lower case, single spaces, hyphens as spaces. */
  phrase: string;
}

/** Words that join a name's words: they give a letter or none ("point of sale" is POS and PS). */
const JOINING = new Set(["a", "an", "and", "for", "in", "of", "on", "or", "the", "to"]);

const ACR = "[A-Z][A-Z0-9]{1,5}";
const WORD = /[A-Za-z][A-Za-z0-9']*/g;

/** The words of a stretch of text with no punctuation but hyphens in it, else undefined. */
function wordsOf(s: string): string[] | undefined {
  if (/[^A-Za-z0-9' \t-]/.test(s)) return undefined;
  return s.match(WORD) ?? [];
}

/**
 * Whether these words spell the letters, each giving its first letter. A joining word gives its
 * letter or none; the first word is never one, and the last gives a letter ("sign-on").
 */
function spells(words: readonly string[], letters: string): boolean {
  if (words.length < 2 || words.length > 2 * letters.length) return false;
  if (JOINING.has(words[0]!.toLowerCase())) return false;
  const go = (i: number, k: number): boolean => {
    if (i === words.length) return k === letters.length;
    const w = words[i]!.toLowerCase();
    if (k < letters.length && w[0] === letters[k] && go(i + 1, k + 1)) return true;
    return JOINING.has(w) && i < words.length - 1 && go(i + 1, k);
  };
  return go(0, 0);
}

/** Lower case, anything but letters and digits as one space, a space at each end: how a phrase is looked for. */
export const foldWords = (s: string) =>
  ` ${s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()} `;

/**
 * The acronyms a text defines, each with the words it sets beside it, in the order met:
 *
 * - `words (ACR)`: the words just before the bracket, as many as spell it;
 * - `ACR (words)`: everything in the bracket;
 * - `ACR: words`, `ACR - words`, `ACR = words`, `| ACR | words |` at a line's start (after a
 *   list mark or emphasis): the words up to the next punctuation, as many as spell it.
 *
 * The words' first letters must spell the acronym; a pair that doesn't is no definition.
 */
export function definedInitialisms(text: string): Initialism[] {
  const out: Initialism[] = [];
  const seen = new Set<string>();
  const add = (acronym: string, words: readonly string[]) => {
    const phrase = foldWords(words.join(" ")).trim();
    const key = `${acronym}\0${phrase}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ acronym, phrase });
  };
  /** The longest run of words at an end of `words` that spells the acronym. */
  const fit = (acronym: string, words: readonly string[], from: "start" | "end") => {
    const letters = acronym.toLowerCase();
    for (let n = Math.min(words.length, 2 * letters.length); n >= 2; n--) {
      const part = from === "end" ? words.slice(words.length - n) : words.slice(0, n);
      if (spells(part, letters)) return part;
    }
    return undefined;
  };
  for (const line of text.split(/\r?\n/)) {
    if (line.length > 4000 || !/[A-Z][A-Z0-9]/.test(line)) continue;
    // words (ACR)
    for (const m of line.matchAll(new RegExp(`\\(\\s*[*_\`]*(${ACR})s?[*_\`]*\\s*\\)`, "g"))) {
      const before = /([A-Za-z0-9' \t-]+)$/.exec(line.slice(0, m.index).replace(/[*_`]/g, ""));
      const words = before ? wordsOf(before[1]!) : undefined;
      const part = words && fit(m[1]!, words.slice(-12), "end");
      if (part) add(m[1]!, part);
    }
    // ACR (words)
    for (const m of line.matchAll(
      new RegExp(`(?<![A-Za-z0-9])(${ACR})s?[*_\`]*\\s*\\(([^()]{3,120})\\)`, "g"),
    )) {
      const words = wordsOf(m[2]!.replace(/[*_`"“”]/g, "").trim());
      if (words && spells(words, m[1]!.toLowerCase())) add(m[1]!, words);
    }
    // ACR: words / ACR - words / | ACR | words |
    const list = new RegExp(
      `^\\s*(?:[-*+]\\s+|\\d+[.)]\\s+|\\|\\s*)?[*_\`]*(${ACR})[*_\`]*\\s*(?::|=|\\||-{1,2}|[–—])\\s*[*_\`"“]*([A-Za-z][A-Za-z0-9' \\t-]*)`,
    ).exec(line);
    if (list) {
      const words = wordsOf(list[2]!.trim());
      const part = words && fit(list[1]!, words.slice(0, 12), "start");
      if (part) add(list[1]!, part);
    }
  }
  return out;
}

export interface InitialismUse extends Initialism {
  /** Which form the text writes. */
  wrote: "acronym" | "phrase";
}

export interface InitialismLink extends Initialism {
  /** Which text writes the acronym; the other writes the words. */
  acronymIn: "a" | "b";
}

/** The acronyms an estate's pages define, to link a text that writes one form to one that writes the other. */
export interface InitialismBook {
  readonly size: number;
  entries(): Initialism[];
  /** The defined acronyms a text writes, and the defined phrases it writes, in the book's order. */
  uses(text: string): InitialismUse[];
  /**
   * The names one text writes as an acronym and the other only as its words. A name both write
   * as the acronym is a word in common, not a link, and is left out.
   */
  links(a: string, b: string): InitialismLink[];
}

/** A book of definitions, each acronym and phrase once, sorted: the same definitions give the same book. */
export function initialismBook(defs: Iterable<Initialism>): InitialismBook {
  const byKey = new Map<string, Initialism>();
  for (const d of defs) {
    if (!new RegExp(`^${ACR}$`).test(d.acronym)) continue;
    const phrase = foldWords(d.phrase).trim();
    if (phrase.split(" ").length < 2) continue;
    byKey.set(`${d.acronym}\0${phrase}`, { acronym: d.acronym, phrase });
  }
  const all = [...byKey.keys()].sort().map((k) => byKey.get(k)!);
  const token = new Map<string, RegExp>();
  const writes = (text: string, acronym: string) => {
    let re = token.get(acronym);
    if (!re) token.set(acronym, (re = new RegExp(`(?<![A-Za-z0-9])${acronym}s?(?![A-Za-z0-9])`)));
    return re.test(text);
  };
  const uses = (text: string): InitialismUse[] => {
    if (!all.length) return [];
    const folded = foldWords(text);
    const out: InitialismUse[] = [];
    for (const d of all) {
      if (writes(text, d.acronym)) out.push({ ...d, wrote: "acronym" });
      if (folded.includes(` ${d.phrase} `)) out.push({ ...d, wrote: "phrase" });
    }
    return out;
  };
  return {
    size: all.length,
    entries: () => all.map((d) => ({ ...d })),
    uses,
    links(a, b) {
      if (!all.length) return [];
      const inA = uses(a);
      if (!inA.length) return [];
      const inB = uses(b);
      const has = (us: InitialismUse[], d: Initialism, wrote: InitialismUse["wrote"]) =>
        us.some((u) => u.wrote === wrote && u.acronym === d.acronym && u.phrase === d.phrase);
      const out: InitialismLink[] = [];
      for (const d of all) {
        const aA = has(inA, d, "acronym");
        const bA = has(inB, d, "acronym");
        if (aA && !bA && has(inB, d, "phrase")) out.push({ ...d, acronymIn: "a" });
        else if (bA && !aA && has(inA, d, "phrase")) out.push({ ...d, acronymIn: "b" });
      }
      return out;
    },
  };
}
