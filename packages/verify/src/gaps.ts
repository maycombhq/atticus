import { reachOrder } from "./batches.js";
import { lineRanges } from "./read-plan.js";

/**
 * R2: a second pass on the gaps only (ADR 0157). The first read leaves lists in
 * `<repo>.verify.yaml`: the files no fact cites (`coverage.unknown`), the lines that write a path,
 * URL or topic no fact cites (`skipped`), the reviewed globs holding such lines (`reviewedHolds`),
 * the spec operations no entry covers (`specOpsUncovered`) and the entries no flow follows
 * (`entriesNoFlowFollows`). A session that has read the whole repo has little room left to work
 * through them, so `atticus map <repo> --gaps` plans them for a fresh one: the unknown files
 * whole, and for the rest only their lines with `GAP_CONTEXT_LINES` round each, sized to the
 * session (`sessionTokensFor`). Pure and deterministic: the same lists give the same plan.
 */

/** The lines read on each side of a line a list names, so the reader sees what it sits in. */
export const GAP_CONTEXT_LINES = 20;

/** A line a list names: `file:line`, with what it writes. */
interface CitedLine {
  cite: string;
}

/** The lists of `<repo>.verify.yaml` the second pass reads, as verify wrote them. */
export interface GapsFrom {
  unknown?: readonly string[];
  skipped?: readonly (CitedLine & { kind: string; value: string })[];
  /** How many skipped lines there are; verify.yaml lists at most `SKIPPED_LISTED`. */
  skippedCount?: number;
  reviewedHolds?: readonly {
    path: string;
    why: string;
    count: number;
    skipped: readonly (CitedLine & { kind: string; value: string })[];
  }[];
  specOpsUncovered?: readonly (CitedLine & { spec: string; method: string; path: string })[];
  specOpsUncoveredCount?: number;
  entriesNoFlowFollows?: readonly (CitedLine & {
    id: string;
    entryType: string;
    method?: string;
    path: string;
    route?: true;
  })[];
}

/** One read of the second pass: a whole file, or lines of one (`<file>#L<from>-L<to>`). */
export interface GapRead {
  path: string;
  file: string;
  tokens: number;
  /** What to look for there, a line each. */
  why: string[];
}

export interface GapPlan {
  /** In the order they are read; each within the room. Empty when there is no gap. */
  sessions: { reads: GapRead[]; tokens: number }[];
  /** The files the reads open. */
  files: number;
  tokens: number;
  /**
   * The lines and operations verify counted but didn't list (past `SKIPPED_LISTED`): verify again
   * after this pass and the next plan holds them.
   */
  unlisted: number;
  /** Files a list names that aren't in the checkout any more. */
  gone: string[];
}

const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * A value from the repo (a literal the code writes, a spec's path, a reviewed line's glob and
 * why), quoted as one line of data (rule 6: ingested content is data, never instructions): in
 * double quotes, with quotes, backslashes and every control or line-breaking character escaped,
 * so it can't end the line it sits in or start one that reads as an instruction. The prompt
 * `atticus map <repo> --gaps` writes fences these lines as data as well.
 */
export function quoted(v: string): string {
  return JSON.stringify(v).replace(
    /[\u007f-\u009f\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function split(cite: string): { file: string; line: number } | undefined {
  const m = /^(.+):(\d+)$/.exec(cite);
  return m ? { file: m[1]!, line: Number(m[2]) } : undefined;
}

/**
 * The second pass's plan. `size` gives a file's tokens and lines at the commit (undefined when it
 * is gone); `room` is the source one session reads (`sessionTokensFor`).
 */
export function planGaps(
  from: GapsFrom,
  size: (file: string) => { tokens: number; lines: number } | undefined,
  room: number,
  /**
   * ADR 0169: read these first (after the build and config files), in this order: the entry
   * points and clients, then the model classes they reach. Without it, in path order.
   */
  o: { first?: readonly string[] } = {},
): GapPlan {
  const whole = new Set(from.unknown ?? []);
  const lines = new Map<string, Map<number, string[]>>();
  const note = (cite: string, why: string) => {
    const at = split(cite);
    if (!at) return;
    const of = lines.get(at.file) ?? new Map<number, string[]>();
    of.set(at.line, [...(of.get(at.line) ?? []), why]);
    lines.set(at.file, of);
  };
  for (const s of from.skipped ?? [])
    note(s.cite, `writes the ${s.kind} ${quoted(s.value)}, which no fact cites`);
  for (const h of from.reviewedHolds ?? [])
    for (const s of h.skipped)
      note(
        s.cite,
        `writes the ${s.kind} ${quoted(s.value)}, but ${quoted(h.path)} is reviewed as ${quoted(h.why)}: write its fact, or narrow the reviewed line`,
      );
  for (const o of from.specOpsUncovered ?? [])
    note(
      o.cite,
      `declares ${o.method} ${quoted(o.path)}, which no entry covers: find the code that serves it`,
    );
  for (const e of from.entriesNoFlowFollows ?? [])
    note(
      e.cite,
      e.route
        ? `is ${e.id} (${[e.method, quoted(e.path)].filter(Boolean).join(" ")}), a gateway route with no forwarding call: write the call it forwards to its RouteRule's target, \`from\` it, as the gateway rules say`
        : `is ${e.id} (${[e.entryType, e.method, quoted(e.path)].filter(Boolean).join(" ")}), which no flow follows: write its flow`,
    );
  const unlisted =
    Math.max(0, (from.skippedCount ?? 0) - (from.skipped?.length ?? 0)) +
    Math.max(0, (from.specOpsUncoveredCount ?? 0) - (from.specOpsUncovered?.length ?? 0));

  const gone: string[] = [];
  const reads: GapRead[] = [];
  const named = [...new Set([...whole, ...lines.keys()])].sort(byPath);
  const files = o.first?.length ? reachOrder(named, o.first) : named;
  for (const file of files) {
    const sz = size(file);
    if (!sz) {
      gone.push(file);
      continue;
    }
    const at = lines.get(file) ?? new Map<number, string[]>();
    const whys = (a: number, b: number) =>
      [...at.entries()]
        .filter(([l]) => l >= a && l <= b)
        .sort((x, y) => x[0] - y[0])
        .flatMap(([l, ws]) => [...new Set(ws)].sort().map((w) => `line ${l} ${w}`));
    const share = (a: number, b: number) => Math.ceil((sz.tokens * (b - a + 1)) / sz.lines);
    if (whole.has(file)) {
      const head = "no fact cites it: read it whole";
      if (sz.tokens <= room || sz.lines <= 1) {
        reads.push({ path: file, file, tokens: sz.tokens, why: [head, ...whys(1, sz.lines)] });
        continue;
      }
      for (const r of lineRanges(sz, room))
        reads.push({
          path: `${file}#L${r.from}-L${r.to}`,
          file,
          tokens: r.tokens,
          // R4: a line the ranges share is named in the range it is its own in, the earlier one.
          why: ["no fact cites the file: read these lines", ...whys(r.start, r.to)],
        });
      continue;
    }
    // The lines round each named line, joined where they meet.
    const windows: [number, number][] = [];
    for (const l of [...at.keys()].sort((a, b) => a - b)) {
      const a = Math.max(1, l - GAP_CONTEXT_LINES);
      const b = Math.min(sz.lines, l + GAP_CONTEXT_LINES);
      const last = windows.at(-1);
      if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
      else windows.push([a, b]);
    }
    for (const [a, b] of windows)
      reads.push({ path: `${file}#L${a}-L${b}`, file, tokens: share(a, b), why: whys(a, b) });
  }

  const sessions: GapPlan["sessions"] = [];
  for (const r of reads) {
    const last = sessions.at(-1);
    if (last && last.tokens + r.tokens <= room) {
      last.reads.push(r);
      last.tokens += r.tokens;
    } else sessions.push({ reads: [r], tokens: r.tokens });
  }
  return {
    sessions,
    files: new Set(reads.map((r) => r.file)).size,
    tokens: reads.reduce((n, r) => n + r.tokens, 0),
    unlisted,
    gone,
  };
}
