import { createHash } from "node:crypto";

/**
 * Normalise an HTTP path or topic so the same interface found in different places
 * (caller code, gateway route, callee controller) gets the same identity.
 *
 * - path parameters in any style ({id}, :id, <id>, ${id}) become "{}"
 * - query strings and fragments are dropped
 * - repeated and trailing slashes are removed; a leading slash is ensured for paths
 * - topics (no leading slash in the input and no "/" at all) are returned trimmed
 */
export function normalizePath(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "") return "";
  const withoutQuery = trimmed.split(/[?#]/, 1)[0] ?? "";
  const isPath = withoutQuery.startsWith("/") || withoutQuery.includes("/");
  if (!isPath) return withoutQuery;
  const segments = withoutQuery
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => (/^(\{[^}]*\}|:[^/]+|<[^>]+>|\$\{[^}]*\})$/.test(s) ? "{}" : s));
  return "/" + segments.join("/");
}

/**
 * Stable interface id: a hash of caller, callee, method and normalised path, so the same
 * edge seen by several extractors merges into one Interface record.
 */
export function interfaceId(
  from: string,
  to: string,
  method: string | undefined,
  path: string,
): string {
  const key = [from, to, (method ?? "").toUpperCase(), normalizePath(path)].join("|");
  return "if-" + createHash("sha256").update(key, "utf8").digest("hex").slice(0, 16);
}

/** Lowercase slug suitable as a record id, built from free text such as a system name. */
export function slugify(text: string): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return slug.slice(0, 120) || "unnamed";
}
