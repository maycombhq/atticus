import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { defaultCodeDir } from "@maycombhq/index";

/**
 * Evidence beside a question (WP7.2): the lines around each `path:line` a question cites, so a
 * person answers looking at the code rather than a file name. A repo's question reads its base
 * clone; a change's question (or a repo not cloned here) reads the metarepo. Read-only, never
 * outside that folder, and a file too big or a line past its end is said, not guessed.
 */

export interface EvidenceExcerpt {
  ref: string;
  line: number;
  /** The first line shown (1-based). */
  start: number;
  lines: string[];
  found: boolean;
}

/** Lines shown before and after the cited one. */
const AROUND = 3;
const MAX_BYTES = 2 * 1024 * 1024;

const inside = (base: string, p: string) => {
  const r = relative(base, p);
  return r !== "" && !r.startsWith("..") && !isAbsolute(r);
};

async function excerpt(bases: string[], ref: string): Promise<EvidenceExcerpt> {
  const m = /^(.+):(\d+)$/.exec(ref);
  const line = m ? Number(m[2]) : 0;
  const none = { ref, line, start: line, lines: [], found: false };
  if (!m || line < 1) return none;
  for (const base of bases) {
    const file = resolve(base, m[1]!);
    if (!inside(base, file)) continue;
    const st = await stat(file).catch(() => undefined);
    if (!st?.isFile() || st.size > MAX_BYTES) continue;
    const all = (await readFile(file, "utf8")).replace(/\r\n?/g, "\n").split("\n");
    if (all.at(-1) === "") all.pop();
    if (line > all.length) return none;
    const start = Math.max(1, line - AROUND);
    return { ref, line, start, lines: all.slice(start - 1, line + AROUND), found: true };
  }
  return none;
}

export async function evidenceExcerpts(
  root: string,
  q: { repo: string; evidence: string[] },
): Promise<EvidenceExcerpt[]> {
  const clone = defaultCodeDir(root, q.repo);
  const bases = [...(clone ? [clone] : []), root];
  const out: EvidenceExcerpt[] = [];
  for (const ref of q.evidence) out.push(await excerpt(bases, ref));
  return out;
}
