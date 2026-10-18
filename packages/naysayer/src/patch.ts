/**
 * Unified diffs for mechanical fixes. The critic writes a patch into a finding when the fix is
 * certain (a pattern-code typo); Apply runs it against the artifact. Patches are checked line
 * by line against the current file: if the artifact changed since the finding was written,
 * the patch refuses rather than guessing.
 */

export class PatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchError";
  }
}

/** A patch that replaces lines `from`..`to` (1-based, inclusive) with `replacement`. */
export function linePatch(
  path: string,
  text: string,
  from: number,
  to: number,
  replacement: string[],
  context = 1,
): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const start = Math.max(1, from - context);
  const end = Math.min(lines.length, to + context);
  const before = lines.slice(start - 1, from - 1);
  const old = lines.slice(from - 1, to);
  const after = lines.slice(to, end);
  const oldCount = before.length + old.length + after.length;
  const newCount = before.length + replacement.length + after.length;
  return (
    [
      `--- a/${path}`,
      `+++ b/${path}`,
      `@@ -${start},${oldCount} +${start},${newCount} @@`,
      ...before.map((l) => ` ${l}`),
      ...old.map((l) => `-${l}`),
      ...replacement.map((l) => `+${l}`),
      ...after.map((l) => ` ${l}`),
    ].join("\n") + "\n"
  );
}

interface Hunk {
  oldStart: number;
  lines: string[];
}

/** The file a patch changes (from its +++ header, without the b/ prefix). */
export function patchTarget(patch: string): string | undefined {
  const m = /^\+\+\+ (?:b\/)?(\S+)/m.exec(patch);
  return m?.[1];
}

/** Apply a unified diff to text. Throws PatchError when a line doesn't match. */
export function applyPatch(text: string, patch: string): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const hunks: Hunk[] = [];
  let cur: Hunk | undefined;
  for (const l of patch.replace(/\r\n/g, "\n").split("\n")) {
    const h = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(l);
    if (h) {
      cur = { oldStart: Number(h[1]), lines: [] };
      hunks.push(cur);
      continue;
    }
    if (!cur || l.startsWith("---") || l.startsWith("+++")) continue;
    if (l === "") continue;
    if (/^[ +-]/.test(l)) cur.lines.push(l);
    else if (l.startsWith("\\")) continue;
    else throw new PatchError(`unexpected patch line: ${l}`);
  }
  if (hunks.length === 0) throw new PatchError("the patch has no hunks");
  const out: string[] = [];
  let pos = 0;
  for (const h of hunks) {
    const start = h.oldStart - 1;
    if (start < pos) throw new PatchError("hunks overlap or are out of order");
    out.push(...lines.slice(pos, start));
    let i = start;
    for (const l of h.lines) {
      const body = l.slice(1);
      if (l[0] === "+") {
        out.push(body);
        continue;
      }
      if (lines[i] !== body)
        throw new PatchError(
          `line ${i + 1} is "${lines[i] ?? ""}", the patch expects "${body}"; the artifact changed since the finding was written`,
        );
      if (l[0] === " ") out.push(body);
      i++;
    }
    pos = i;
  }
  out.push(...lines.slice(pos));
  return out.join(eol);
}
