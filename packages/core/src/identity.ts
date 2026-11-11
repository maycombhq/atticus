import { createHash } from "node:crypto";
import { normalizePath } from "./paths.js";

// Review of beta.24: the path normaliser lives in a module of its own, with no imports, so the
// app's screens (a browser bundle) use the very function the join does (`@maycombhq/core/paths`).
export { normalizePath, stripParamConstraints } from "./paths.js";

/** Code-unit string order, the same in every locale (`localeCompare` is not: ICU orders `_`/`-`
 * and, in `da`, `aa` differently), for every sort that feeds records, ids, hashes or a merge. */
export function cmpText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * `cmpText`, but a run of digits is compared as a number (`a.ts:9` before `a.ts:10`): what
 * `localeCompare(b, "en", { numeric: true })` was used for, without ICU.
 */
export function cmpNatural(a: string, b: string): number {
  const pa = a.split(/(\d+)/);
  const pb = b.split(/(\d+)/);
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const x = pa[i]!;
    const y = pb[i]!;
    if (x === y) continue;
    // Odd pieces are digit runs (split with a capture group alternates text and digits).
    if (i % 2 === 1) {
      const nx = x.replace(/^0+(?=\d)/, "");
      const ny = y.replace(/^0+(?=\d)/, "");
      if (nx.length !== ny.length) return nx.length - ny.length;
      if (nx !== ny) return cmpText(nx, ny);
      continue;
    }
    return cmpText(x, y);
  }
  return pa.length !== pb.length ? pa.length - pb.length : cmpText(a, b);
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
  const out = notDeviceName(slug).slice(0, 120);
  return /[a-z0-9]/.test(out) ? out : unnamedId(text);
}

/**
 * Round 47: a name with no Latin letter or digit in it (`注文`, `Заказы`, `...`) slugs to
 * nothing, so every such name used to become the same `unnamed` and their records merged.
 * It gets `unnamed-<short hash of the name>` instead: stable, and different per name. Blank
 * text stays `unnamed`.
 */
export function unnamedId(text: string): string {
  const name = text.normalize("NFC").trim();
  if (name === "") return "unnamed";
  return "unnamed-" + createHash("sha256").update(name, "utf8").digest("hex").slice(0, 8);
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
