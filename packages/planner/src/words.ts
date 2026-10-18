/**
 * Small word tools for deterministic matching between artifacts (a story and the proposal
 * bullet it traces to, an open question and the story that carries it). Plain English
 * heuristics, no AI and no dictionary: lower case, drop stop words, a crude stem.
 */

const STOP = new Set(
  `a an the and or but if then than that this these those of to in on at by for from with
  without into onto over under about as is are was were be been being it its it's their there
  they them we our you your i me my he she his her not no nor so too very can could should would
  will shall may might must do does did done has have had having which who whom whose what when
  where why how all any each every some such own same other only also just new via per through
  up down out off again once here more most much many few one two`
    .split(/\s+/)
    .filter(Boolean),
);

export function stem(word: string): string {
  let w = word.toLowerCase().replace(/'s$/, "");
  if (w.length <= 3) return w;
  if (/ies$/.test(w)) w = w.slice(0, -3) + "y";
  else if (!/ss$/.test(w)) {
    const m = /(ing|ed|es|s)$/.exec(w);
    if (m && w.length - m[1]!.length >= 3) w = w.slice(0, -m[1]!.length);
  }
  if (w.length > 3 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

/** Content words of a text, stemmed, in order of first appearance. */
export function contentWords(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9']+/)) {
    const w = raw.replace(/^'+|'+$/g, "");
    if (!w || STOP.has(w) || /^\d+$/.test(w)) continue;
    const s = stem(w);
    if (s.length < 2 || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/** How many content words two texts share. */
export function overlap(a: string, b: string): number {
  const bs = new Set(contentWords(b));
  return contentWords(a).filter((w) => bs.has(w)).length;
}

/** Share of `a`'s content words that appear in `b` (0 when `a` has none). */
export function coverage(a: string, b: string): number {
  const aw = contentWords(a);
  if (aw.length === 0) return 0;
  const bs = new Set(contentWords(b));
  return aw.filter((w) => bs.has(w)).length / aw.length;
}

export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** "Network firewall rule" → "Network firewall rule"; "source app" → "Source app". */
export const sentenceCase = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
