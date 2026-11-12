/** Segments a group's prefix keeps going past: an api root or a version. */
const PREFIX_ROOT = /^(api|rest|services?|v\d+(\.\d+)*)$/i;

/**
 * The part of a call's path a group of target questions shares (Q1): its first segment, with an
 * api root or version segment in front of it kept (/api/v2/accounts). A placeholder ends it.
 * Its own module (beta.27) so the join's host questions group the same way.
 */
export function targetPathPrefix(path: string): string {
  const lead = path.startsWith("/") ? "/" : "";
  const out: string[] = [];
  for (const s of path.split(/[?#]/)[0]!.split("/").filter(Boolean)) {
    if (/^[{:<]/.test(s)) break;
    out.push(s);
    if (!PREFIX_ROOT.test(s)) break;
  }
  return out.length ? `${lead}${out.join("/")}` : "/";
}
