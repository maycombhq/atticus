import { looksLikeRepoId } from "./planned.js";
import { realUndo } from "./undo.js";

/**
 * ADR 0206 point 4: what a quick change says its code will have, in one table of its design.md,
 * under `## In the code` (Repo, Task, Has, What, Spec). After the build each row is looked for in
 * the branch's verified facts; impact, the change map and the estimate read it too. Read here
 * deterministically, with no I/O and no model: the caller gives the files' text and says which
 * ids the map has. A table it can't be sure of is refused at the plan hand-off, never passed
 * over, with its line and what to fix; a row with Has `other` is always a way on.
 */

export const CODE_TABLE_FILE = "design.md";
export const CODE_TABLE_HEADING = "In the code";
const HEADER = ["repo", "task", "has", "what", "spec"];

/** What a row says a repo will have. */
export const HAS_WORDS = [
  "serves",
  "listens",
  "calls",
  "publishes",
  "table",
  "column",
  "migration",
  "deployment",
  "route",
  "config",
  "secret",
  "pipeline",
  "cut-over",
  "other",
] as const;
export type HasWord = (typeof HAS_WORDS)[number];

/** The pairs an operation's row may give, as `sets` takes them (ADR 0203 B, ADR 0206). */
export const PAIRS: Partial<Record<HasWord, readonly string[]>> = {
  deployment: ["platform", "env"],
  route: ["host", "basePath"],
  config: ["key", "env", "value"],
  secret: ["key", "env"],
  pipeline: ["file"],
};

export interface CodeRow {
  /** The row's line in design.md, from 1. */
  line: number;
  repo: string;
  /** `-` is none. */
  task?: string;
  has: string;
  /** The What cell with its backticks taken off. */
  what: string;
  /** `<capability>: <Requirement name>`; `-` is none. */
  spec?: string;
  cells: number;
}

export interface CodeTable {
  /** The `## In the code` heading's line, when there is one. */
  heading?: number;
  /** Whether a table with the five columns is under it. */
  found: boolean;
  rows: CodeRow[];
  /** What can't be read for sure: its line and the words. */
  problems: { line: number; words: string }[];
}

export interface CodeTableReason {
  code: "design.code-table";
  line: number;
  message: string;
}

/** A row's cells: split on `|` (a `\|` is a bar in a cell), the outer bars dropped. */
function cellsOf(line: string): string[] {
  const parts = line.split(/(?<!\\)\|/);
  if (parts[0]?.trim() === "") parts.shift();
  if (parts.at(-1)?.trim() === "") parts.pop();
  return parts.map((c) => c.trim().replace(/\\\|/g, "|"));
}
const plain = (c: string) => c.replace(/[*_`]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
const isDelimiter = (line: string) =>
  line.includes("|") && line.includes("-") && /^[\s|:-]+$/.test(line);
/** A cell's words with the backticks taken off. */
export const unticked = (c: string): string => c.replace(/`([^`]*)`/g, "$1").trim();

/**
 * The lines of a Markdown file that are prose: a line inside a code fence (opened by three or
 * more backticks or tildes, indented three spaces at most) or an HTML comment is blanked, so no
 * heading or table is read from it.
 */
export function proseLines(text: string): string[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  let fence: string | undefined;
  let comment = false;
  return lines.map((l) => {
    if (comment) {
      if (l.includes("-->")) comment = false;
      return "";
    }
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(l);
    if (fence) {
      if (f && f[1]![0] === fence[0] && f[1]!.length >= fence.length) fence = undefined;
      return "";
    }
    if (f) {
      fence = f[1];
      return "";
    }
    const open = l.indexOf("<!--");
    if (open >= 0 && !l.includes("-->", open)) {
      comment = true;
      return l.slice(0, open);
    }
    return l.replace(/<!--.*?-->/g, "");
  });
}

export function parseCodeTable(text: string): CodeTable {
  const out: CodeTable = { found: false, rows: [], problems: [] };
  if (text.includes("\0")) {
    out.problems.push({ line: 1, words: "the file isn't text: save it as UTF-8." });
    return out;
  }
  const lines = proseLines(text);
  const at = lines.findIndex(
    (l) => /^##\s+/.test(l) && plain(l.replace(/^##\s+/, "")) === "in the code",
  );
  if (at < 0) return out;
  out.heading = at + 1;
  let i = at + 1;
  const end = (n: number) => n >= lines.length || /^#{1,2}\s/.test(lines[n]!);
  while (!end(i) && !(lines[i]!.includes("|") && isDelimiter(lines[i + 1] ?? ""))) i++;
  if (end(i)) return out;
  const header = cellsOf(lines[i]!);
  if (header.length !== HEADER.length || !header.every((c, n) => plain(c) === HEADER[n])) {
    out.problems.push({
      line: i + 1,
      words: `the table under ## In the code doesn't read: its header is ${header.map((c) => `"${c}"`).join(", ")}, not the five columns Repo, Task, Has, What, Spec.`,
    });
    return out;
  }
  out.found = true;
  for (let n = i + 2; n < lines.length; n++) {
    const l = lines[n]!;
    if (!l.trim() || !l.includes("|") || end(n)) break;
    const cells = cellsOf(l);
    const cell = (k: number) => cells[k] ?? "";
    const dash = (c: string) => (c === "-" || c === "" ? undefined : c);
    out.rows.push({
      line: n + 1,
      repo: unticked(cell(0)),
      ...(dash(unticked(cell(1))) ? { task: unticked(cell(1)) } : {}),
      has: plain(cell(2)),
      what: unticked(cell(3)),
      ...(dash(unticked(cell(4))) ? { spec: unticked(cell(4)) } : {}),
      cells: cells.length,
    });
  }
  return out;
}

/** `METHOD /path`. */
export const HTTP_ENTRY = /^([A-Za-z]+)\s+(\/\S*)$/;
const ONE = /^\S+$/;

/** The pairs of an operation's row, `platform anvil, env prod`; undefined when one doesn't read. */
export function pairsOf(what: string): Record<string, string> | undefined {
  const pieces = splitOutsideQuotes(what);
  if (!pieces) return undefined;
  const out: Record<string, string> = {};
  let last: string | undefined;
  for (const raw of pieces) {
    const part = raw.trim();
    const m = /^([A-Za-z]+)\s+(.+)$/.exec(part);
    if (m && PAIR_WORDS.has(m[1]!)) {
      last = m[1]!;
      out[last] = m[2]!.trim();
      continue;
    }
    // v31 gate 0: only a value holds a comma (`value a,b`): a piece after it that doesn't start
    // with a pair's word is the value's, joined with no space, as code holds it. Any other pair
    // still refuses a stray piece, so a mistyped word or a bare secret never reads.
    if (last !== "value" || isQuoted(out.value!)) return undefined;
    out.value = `${out.value},${part}`;
  }
  for (const k of Object.keys(out)) {
    const v = out[k]!;
    // A value that opens with a quote is quoted whole, or it doesn't read (`"a",b`); a quote
    // inside a plain value is its own (`{"a":1}`).
    if (/^["`]/.test(v) && !isQuoted(v)) return undefined;
    out[k] = isQuoted(v) ? v.slice(1, -1) : v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Every word that starts a pair, of any kind of row. */
const PAIR_WORDS = new Set(Object.values(PAIRS).flat());

const isQuoted = (v: string) =>
  v.length >= 2 && (v[0] === '"' || v[0] === "`") && v.at(-1) === v[0];

/** Splits on commas, but not inside "double quotes" or `backticks`; undefined for a quote left open. */
function splitOutsideQuotes(s: string): string[] | undefined {
  const parts: string[] = [];
  let cur = "";
  let quote: string | undefined;
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = undefined;
    } else if (ch === '"' || ch === "`") quote = ch;
    else if (ch === ",") {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (quote) return undefined;
  parts.push(cur);
  return parts.filter((p) => p.trim() !== "");
}

/** A row's undo, from `undo: <sentence>` in its What. */
export const undoOf = (what: string): string | undefined =>
  /\bundo:\s*(.+)$/i.exec(what)?.[1]?.trim();

/** The ids a row names that must be in the map: a call's target, a topic. */
export function rowIds(r: CodeRow): string[] {
  if (r.has === "calls") return [r.what.split(/\s+/)[0]!];
  if (r.has === "listens" || r.has === "publishes") return [r.what];
  return [];
}

/** What a row of each kind needs, and an example, for the refusal's words. */
const NEEDS: Record<string, [string, string]> = {
  serves: ["METHOD /path", "GET /v1/refunds/{id}"],
  calls: ["a component or repo, then METHOD /path", "forge-ledger GET /v1/accounts/{id}"],
  listens: ["a topic", "forge.items.settled"],
  publishes: ["a topic", "forge.items.settled"],
  table: ["a table", "refund_receipts"],
  column: ["table.column", "refund_receipts.issued_at"],
  migration: ["a file", "V7__refund_receipts.sql"],
  other: ["what a person checks, in words", "Receipts are kept for seven years."],
};
const EXAMPLE_PAIRS: Record<string, string> = {
  deployment: "platform anvil, env prod",
  route: "host orders.anvil.forge.example, basePath /orders",
  config: "key orders.retry.max, env prod, value 5",
  secret: "key ledger.client.key",
  pipeline: "file .anvil/pipeline.yaml",
};

/** Why a row's What doesn't read for its Has; undefined when it reads. */
function whatProblem(r: CodeRow): string | undefined {
  const w = r.what;
  const need = (h: string) =>
    NEEDS[h]
      ? `a ${h} row needs ${NEEDS[h]![0]}, for example ${NEEDS[h]![1]}.`
      : `a ${h} row needs pairs from ${PAIRS[h as HasWord]!.join(", ")}, for example ${EXAMPLE_PAIRS[h]}${h === "config" ? '; a value with a comma in "double quotes"' : ""}.`;
  switch (r.has) {
    case "serves":
      return HTTP_ENTRY.test(w) ? undefined : need("serves");
    case "calls": {
      const [target, ...rest] = w.split(/\s+/);
      return target && HTTP_ENTRY.test(rest.join(" ")) ? undefined : need("calls");
    }
    case "listens":
    case "publishes":
    case "table":
    case "migration":
      return ONE.test(w) ? undefined : need(r.has);
    case "column":
      return ONE.test(w) && /^[^.]+(\.[^.]+)*\.[^.]+$/.test(w) ? undefined : need("column");
    case "cut-over":
      return realUndo(undoOf(w))
        ? undefined
        : "a cut-over row needs undo: and one or two sentences that say how it is taken back.";
    case "other":
      return w ? undefined : need("other");
    default: {
      const pairs = pairsOf(w);
      if (r.has === "secret" && pairs && "value" in pairs)
        return "a secret row never gives a value: name its key, and keep the value where secrets are kept.";
      const allowed = PAIRS[r.has as HasWord]!;
      return pairs && Object.keys(pairs).every((k) => allowed.includes(k))
        ? undefined
        : need(r.has);
    }
  }
}

/** The repos of tasks.md, each with its task ids. */
export function tasksByRepo(tasks: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let repo: string | undefined;
  for (const l of proseLines(tasks)) {
    const h = /^##\s+(\S+)\s*$/.exec(l);
    if (h) {
      repo = h[1]!;
      if (!out.has(repo)) out.set(repo, []);
      continue;
    }
    if (/^#{1,2}\s/.test(l)) repo = undefined;
    const t = /^\s*-\s+\[[ xX]\]\s+(\S+)/.exec(l);
    if (t && repo) out.get(repo)!.push(t[1]!.toLowerCase());
  }
  return out;
}

/** Each `### Requirement:` of a spec delta, by its capability (its folder under specs/). */
function requirementsOf(
  specs: readonly { path: string; text: string }[],
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const s of specs) {
    const cap = /^specs\/([^/]+)\//.exec(s.path.replace(/\\/g, "/"))?.[1];
    if (!cap) continue;
    const names = out.get(cap) ?? new Set<string>();
    for (const l of proseLines(s.text)) {
      const m = /^###\s+Requirement:\s*(.+?)\s*$/i.exec(l);
      if (m) names.add(m[1]!.toLowerCase());
    }
    out.set(cap, names);
  }
  return out;
}

export interface CodeTableContext {
  /** tasks.md's text. */
  tasks: string;
  /** Each spec delta, its path under the change folder (`specs/<cap>/spec.md`) and text. */
  specs: readonly { path: string; text: string }[];
  /** Whether the map has the id: a record, a manifest's repo, a name exactly one record has. */
  has: (id: string) => boolean;
  /** The ids requirements.md lists under `## Planned`. */
  planned: readonly string[];
}

/** The table's problems, as hand-off reasons: each with its line and what to fix. */
export function checkCodeTable(t: CodeTable, c: CodeTableContext): CodeTableReason[] {
  const out: CodeTableReason[] = [];
  const say = (line: number, message: string) =>
    out.push({ code: "design.code-table", line, message });
  for (const p of t.problems) say(p.line, `design.md:${p.line}: ${p.words}`);
  if (t.problems.length) return out;
  if (!t.found) {
    say(
      t.heading ?? 1,
      "design.md doesn't say what the code will have: add ## In the code with the columns Repo, Task, Has, What, Spec, a row for each thing a repo's code or deployment will have. A repo whose work no scan can see gets a row with Has other.",
    );
    return out;
  }
  const tasks = tasksByRepo(c.tasks);
  const reqs = requirementsOf(c.specs);
  const planned = new Set(c.planned);
  for (const r of t.rows) {
    const at = `design.md:${r.line}:`;
    if (r.cells !== HEADER.length) {
      say(r.line, `${at} this row has ${r.cells} cells, not the five Repo, Task, Has, What, Spec.`);
      continue;
    }
    if (!tasks.has(r.repo)) {
      say(r.line, `${at} Repo names ${r.repo}, which tasks.md doesn't have under a ## heading.`);
      continue;
    }
    if (r.task && !tasks.get(r.repo)!.includes(r.task.toLowerCase())) {
      say(r.line, `${at} Task names ${r.task}, which tasks.md doesn't have under ## ${r.repo}.`);
      continue;
    }
    if (!(HAS_WORDS as readonly string[]).includes(r.has)) {
      say(r.line, `${at} Has is "${r.has}", which is none of ${HAS_WORDS.join(", ")}.`);
      continue;
    }
    const why = whatProblem(r);
    if (why) {
      say(r.line, `${at} ${why}`);
      continue;
    }
    const unknown = rowIds(r).find((id) => !c.has(id) && !planned.has(id) && !tasks.has(id));
    if (unknown) {
      say(
        r.line,
        `${at} the row names ${unknown}, which is not in the map and not listed under "## Planned". Name an id the map has (atticus query ${unknown}), or list it under Planned in requirements.md.`,
      );
      continue;
    }
    if (r.spec) {
      const m = /^([^:]+):\s*(.+)$/.exec(r.spec);
      const cap = m?.[1]?.trim() ?? r.spec;
      if (!m || !reqs.get(cap)?.has(m[2]!.trim().toLowerCase()))
        say(
          r.line,
          `${at} Spec names ${r.spec}, which specs/ doesn't have as a ### Requirement: under specs/${cap}/.`,
        );
    }
  }
  const stated = new Set(t.rows.map((r) => r.repo));
  for (const [repo, ids] of tasks)
    if (ids.length && looksLikeRepoId(repo) && !stated.has(repo))
      say(1, `design.md: ${repo} has tasks and no row in ## In the code.`);
  return out;
}

const METHOD_PATH = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/[^\s,;)]*)/g;

/**
 * The map's names on a spec delta's lines that no row names (ADR 0206 point 4): a topic, an
 * Endpoint id, a component, a repo, or a `METHOD /path`, each once, at its first line. A note,
 * never a refusal: what a sentence means is never read from prose.
 */
export function specNamesNotInRows(
  t: CodeTable,
  specs: readonly { path: string; text: string }[],
  has: (id: string) => boolean,
): string[] {
  const named = new Set<string>();
  for (const r of t.rows) {
    named.add(r.repo);
    named.add(r.what);
    for (const w of r.what.split(/[\s,]+/)) named.add(w);
    const call = r.has === "calls" ? r.what.split(/\s+/).slice(1).join(" ") : "";
    if (call) named.add(call);
  }
  const out: string[] = [];
  const said = new Set<string>();
  for (const s of specs) {
    proseLines(s.text).forEach((l, i) => {
      const found: [number, string][] = [];
      for (const m of l.matchAll(METHOD_PATH))
        found.push([m.index!, `${m[1]} ${m[2]!.replace(/[.:]+$/, "")}`]);
      for (const m of l.matchAll(/[A-Za-z0-9][A-Za-z0-9._/{}-]*/g)) {
        const w = m[0].replace(/[.]+$/, "");
        if (!w.startsWith("/") && has(w)) found.push([m.index!, w]);
      }
      for (const [, name] of found.sort((a, b) => a[0] - b[0])) {
        if (named.has(name) || said.has(name)) continue;
        said.add(name);
        out.push(
          `${s.path}:${i + 1} names ${name}, and no row of ## In the code does, so the code isn't checked for it.`,
        );
      }
    });
  }
  return out;
}
