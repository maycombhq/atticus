/**
 * The words an identifier is made of (ADR 0116): camelCase, PascalCase, ACRONYMCase,
 * snake_case, kebab-case, dots and slashes, lower case. `renamedAt` → renamed, at;
 * `HTTPServer` → http, server; `v2Payments` → v2, payments. A path parameter (`{id}`) is
 * dropped. Deterministic and small: it reads names, not prose.
 */
export function identifierWords(s: string): string[] {
  return s
    .replace(/\{[^}]*\}/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * The split forms of the identifiers in a text, for a search index: each word of the text
 * that splits into more than one word (`renamedAt`, `daily_limit`) gives its words, once, in
 * the order met. Words that don't split are left to the text itself.
 */
export function splitForms(text: string, max = 2000): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/[A-Za-z0-9][A-Za-z0-9_.\-/]*/g)) {
    const parts = identifierWords(m[0]);
    if (parts.length < 2) continue;
    const key = parts.join(" ");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= max) break;
  }
  return out;
}
