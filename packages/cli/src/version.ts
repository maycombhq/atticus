/** The Atticus version this build reports (atticus --version, health, the support bundle). */
export const VERSION = "2.0.0-beta.2";

/** Numeric version order, ignoring a pre-release or platform suffix: v is min or later. */
export function versionAtLeast(v: string, min: string): boolean {
  const a = v.replace(/^v/, "").split(/[.+-]/).map(Number);
  const b = min.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (Number.isNaN(x)) return false;
    if (x !== y) return x > y;
  }
  return true;
}
