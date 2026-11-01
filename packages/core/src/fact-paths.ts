/**
 * A file path as Atticus reads it: with `/` only (ADR 0124 addendum W-paths). A facts line
 * written on Windows can cite `src\main\App.java`; every reader of the facts file (the facts
 * parser, the corrections file, the reviewed list, the reader's answer) passes what it reads
 * through here, so the verifier, the join's folder and bundle rules and every record see one
 * form, whichever OS wrote the line.
 */
export const forwardSlashes = (path: string): string => path.replace(/\\/g, "/");

/**
 * A parsed facts line (or a correction, or any JSON beside them) with every `file` it carries,
 * at any depth (`cite.file`, `cite.with[].file`, an auth's, a scope's, a caller's), written with
 * `/`. Nothing else changes: a claimed path or key is not a file. Returns a copy.
 */
export function normalizeFactPaths<T>(json: T): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== "object") return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v))
      out[k] = k === "file" && typeof x === "string" ? forwardSlashes(x) : walk(x);
    return out;
  };
  return walk(json) as T;
}
