/**
 * The order of two Atticus versions, and the shape of one. Kept here so the command line (the
 * metarepo's stamp, `atticus status`) and the build (the Atticus a newer build.json names, ADR
 * 0202 point 7) tell newer from older by the same rule.
 */

/** The shape of an Atticus version: the only value that goes into a command a person copies. */
export const ATTICUS_VERSION_SHAPE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;

/** `v` when it has the shape of a version (trimmed), else undefined. */
export const atticusVersionOf = (v: string | undefined): string | undefined =>
  v && ATTICUS_VERSION_SHAPE.test(v.trim()) ? v.trim() : undefined;

/**
 * Round 38: semver order with pre-releases (2.0.0-beta.30 > 2.0.0-beta.21 > 2.0.0-beta.9, and a
 * release above its pre-releases), so an older beta refuses a metarepo a newer beta upgraded.
 */
export function newerThan(a: string, b: string): boolean {
  const split = (v: string) => {
    const [core, pre] = v.trim().replace(/^v/, "").split(/-(.*)/s, 2);
    return { core: (core ?? "").split(".").map((n) => Number(n) || 0), pre: pre ?? "" };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.max(x.core.length, y.core.length); i++) {
    const d = (x.core[i] ?? 0) - (y.core[i] ?? 0);
    if (d) return d > 0;
  }
  if (x.pre === y.pre) return false;
  if (!x.pre) return true; // a release is above its pre-releases
  if (!y.pre) return false;
  const xp = x.pre.split(".");
  const yp = y.pre.split(".");
  for (let i = 0; i < Math.max(xp.length, yp.length); i++) {
    const p = xp[i];
    const q = yp[i];
    if (p === undefined) return false;
    if (q === undefined) return true;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) > Number(q);
    if (pn !== qn) return !pn; // numeric identifiers sort below the others
    return p > q;
  }
  return false;
}
