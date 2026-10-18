/** Names for generated code: identifiers, slugs and safe string literals. */

export const words = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);

/** "refuses a missing amount" → "refusesAMissingAmount"; never starts with a digit. */
export function camel(s: string, max = 60): string {
  const w = words(s).map((x) => x.toLowerCase());
  if (!w.length) return "test";
  const out = w.map((x, i) => (i === 0 ? x : x.charAt(0).toUpperCase() + x.slice(1))).join("");
  const id = /^[0-9]/.test(out) ? `t${out}` : out;
  return id.slice(0, max);
}

/** "s1-daily-transfer-limit" → "S1DailyTransferLimit". */
export function pascal(s: string, max = 60): string {
  const c = camel(s, max);
  return c.charAt(0).toUpperCase() + c.slice(1);
}

/** A slug for ids: lower case, dashes. */
export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/\{[^}]*\}/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Make names unique by adding 2, 3, ... */
export function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((n) => {
    const k = seen.get(n) ?? 0;
    seen.set(n, k + 1);
    return k === 0 ? n : `${n}${k + 1}`;
  });
}

/** A Java or TypeScript string literal body: backslashes, quotes and line breaks escaped. */
export const quote = (s: string) =>
  s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ");

/** One line of prose (from a person or a model) safe in any generated file. */
export const oneLine = (s: string, max = 120) =>
  s
    .replace(/[\r\n]+/g, " ")
    .replace(/[`*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
