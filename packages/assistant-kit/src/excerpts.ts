import type { SourceInput } from "@maycombhq/ai";
import type { RepoHandle } from "@maycombhq/sdk";

/**
 * Code excerpts, not whole files (ADR 0112). A step that puts a repo's code in a prompt sends
 * a window of lines around each line a fact cites, merged where windows overlap or touch,
 * ranked by how many facts cite them: the code the most facts rest on is in the prompt before
 * anything else is cut. Each excerpt keeps its path and the file's own line numbers, so the
 * model can cite exactly the line it read.
 */

/** Lines kept on each side of a cited line. */
export const EXCERPT_WINDOW = 20;

/** A line a fact cites: a path, and the line when the fact has one (else line 1). */
export interface Citation {
  path: string;
  line?: number;
}

export interface Excerpt {
  path: string;
  /** First and last line, counting from 1, as in the file. */
  from: number;
  to: number;
  /** How many citations fall in it. */
  cites: number;
  /** The cited lines in it, in order. */
  lines: number[];
  /** The excerpt as the prompt shows it: a heading, then `n: text` per line. */
  text: string;
}

/**
 * The windows around `cites`, read from the repo, merged per file and ranked: most cited
 * first, then by path and line. A file that can't be read, or a line past its end, is left out.
 */
export async function codeExcerpts(
  repo: Pick<RepoHandle, "readText">,
  cites: readonly Citation[],
  o: { window?: number } = {},
): Promise<Excerpt[]> {
  const w = o.window ?? EXCERPT_WINDOW;
  const byPath = new Map<string, number[]>();
  for (const c of cites) {
    const l = c.line ?? 1;
    byPath.set(c.path, [...(byPath.get(c.path) ?? []), l]);
  }
  const out: Excerpt[] = [];
  for (const [path, cited] of byPath) {
    const text = await repo.readText(path).catch(() => undefined);
    if (text === undefined) continue;
    const file = text.replace(/\r\n?/g, "\n").split("\n");
    // A file's last line break ends its last line; it doesn't start another.
    if (file.length > 1 && file.at(-1) === "") file.pop();
    const lines = cited.filter((l) => l >= 1 && l <= file.length).sort((a, b) => a - b);
    let cur: { from: number; to: number; lines: number[] } | undefined;
    const windows: { from: number; to: number; lines: number[] }[] = [];
    for (const l of lines) {
      const from = Math.max(1, l - w);
      const to = Math.min(file.length, l + w);
      if (cur && from <= cur.to + 1) {
        cur.to = Math.max(cur.to, to);
        cur.lines.push(l);
      } else {
        cur = { from, to, lines: [l] };
        windows.push(cur);
      }
    }
    for (const x of windows) {
      const at = [...new Set(x.lines)];
      out.push({
        path,
        from: x.from,
        to: x.to,
        cites: x.lines.length,
        lines: at,
        text: [
          `${path} lines ${x.from}-${x.to} (cited at ${at.join(", ")}; numbered as in the file):`,
          ...file.slice(x.from - 1, x.to).map((t, i) => `${x.from + i}: ${t}`),
        ].join("\n"),
      });
    }
  }
  return out.sort((a, b) => b.cites - a.cites || a.path.localeCompare(b.path) || a.from - b.from);
}

/**
 * The excerpts as pack sources, in rank order under one priority: ids `<id>-000`, `<id>-001`
 * and so on, so the pack keeps the most cited and cuts the least cited first.
 */
export function excerptSources(
  excerpts: readonly Excerpt[],
  o: { id: string; origin: string; priority: number },
): SourceInput[] {
  return excerpts.map((x, i) => ({
    id: `${o.id}-${String(i).padStart(3, "0")}`,
    kind: "code",
    origin: `${o.origin}:${x.path}:${x.from}-${x.to}`,
    text: x.text,
    classification: "internal",
    priority: o.priority,
  }));
}

interface Cited {
  repo?: string;
  path?: string;
  line?: number;
}

/**
 * The citations of records and flows in one repo: every `evidence` entry they hold (a record's,
 * a flow's trigger, steps and errors), with a path, from that repo (or naming none).
 */
export function citationsOf(things: readonly unknown[], repoId: string): Citation[] {
  const out: Citation[] = [];
  const take = (ev: unknown) => {
    if (!Array.isArray(ev)) return;
    for (const e of ev as Cited[])
      if (e && typeof e.path === "string" && (!e.repo || e.repo === repoId))
        out.push(e.line ? { path: e.path, line: e.line } : { path: e.path });
  };
  for (const t of things) {
    const x = t as {
      evidence?: unknown;
      trigger?: { evidence?: unknown };
      steps?: { evidence?: unknown }[];
      errors?: { evidence?: unknown }[];
    };
    take(x.evidence);
    take(x.trigger?.evidence);
    for (const s of x.steps ?? []) take(s.evidence);
    for (const s of x.errors ?? []) take(s.evidence);
  }
  return out;
}
