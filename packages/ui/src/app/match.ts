/**
 * The filter's matching (ADR 0105 addendum), apart from its box so code without React (the
 * inbox, the VS Code extension's tests) can use it: an item matches when every word of the
 * filter is in one of its fields, case aside.
 */

/** The filter's words, lower case. */
export const filterWords = (text: string): string[] =>
  text.toLowerCase().split(/\s+/).filter(Boolean);

/** Every word of the text is in one of the fields, case aside; an empty filter matches all. */
export function matchesWords(fields: readonly (string | undefined)[], text: string): boolean {
  const words = filterWords(text);
  if (!words.length) return true;
  const hay = fields.filter((f): f is string => !!f).map((f) => f.toLowerCase());
  return words.every((w) => hay.some((f) => f.includes(w)));
}
