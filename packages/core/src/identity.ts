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
  return notDeviceName(slug).slice(0, 120) || "unnamed";
}

/** The names Windows keeps for devices, whatever extension follows (`aux.yaml` opens AUX). */
const DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * A slug that is never a Windows device name (review round 46): a record is the file
 * `<kind>/<id>.yaml` and Windows can't create `aux.yaml`, so the slug's first dot-separated part,
 * when it is one, gets `-1` (`aux` is `aux-1`, `con.v2` is `con-1.v2`). C1's RecordId is unchanged.
 */
export function notDeviceName(slug: string): string {
  const dot = slug.indexOf(".");
  const head = dot < 0 ? slug : slug.slice(0, dot);
  return DEVICE_NAME.test(head) ? `${head}-1${slug.slice(head.length)}` : slug;
}
