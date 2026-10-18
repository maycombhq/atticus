import { PatternCode, type IntegrationPattern } from "@maycombhq/core";
import type { KnowledgePage } from "./sources.js";

/**
 * The integration pattern scan: a wiki page that lists pattern codes in a table becomes a
 * draft C6 IntegrationPattern per code, holding only what the page states. Drafts are
 * compared with the org pack so a person can bring the pack up to date through a PR;
 * Atticus never edits the pack itself.
 */

export interface PatternDraft {
  code: string;
  /** Line of the table row. */
  line: number;
  draft: Partial<IntegrationPattern> & { code: string };
}

export interface PatternFieldDiff {
  field: string;
  page: unknown;
  pack: unknown;
}

export interface PatternDiff {
  /** On the page, not in the pack. */
  new: PatternDraft[];
  /** In both, with fields that differ. Only fields the page states are compared. */
  changed: { code: string; line: number; fields: PatternFieldDiff[] }[];
  /** In the pack, not on the page. */
  missing: string[];
  same: string[];
}

type Column =
  "code" | "name" | "definition" | "interaction" | "route" | "target" | "controls" | "technology";

const COLUMNS: [Column, RegExp][] = [
  ["code", /\bcode\b/],
  ["controls", /control/],
  ["definition", /definition|description/],
  ["interaction", /interaction|style/],
  ["route", /\broute\b|\bvia\b/],
  ["target", /target/],
  ["technology", /technolog|\btech\b/],
  ["name", /name|title/],
];

const isCode = (s: string) => PatternCode.safeParse(s).success;

/** Split a list cell on commas that are not inside brackets. */
function splitList(cell: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of cell) {
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if ((ch === "," || ch === ";") && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function routeFrom(text: string, interaction?: string): IntegrationPattern["route"] | undefined {
  const t = text.toLowerCase();
  if (/gateway/.test(t)) return "gateway";
  if (/event[ -]bus/.test(t)) return "event-bus";
  if (/pub\s*\/?\s*sub/.test(t)) return "pubsub";
  if (/\bsftp\b|file transfer/.test(t)) return "sftp";
  if (/\bqueue\b|\bmq\b/.test(t)) return "mq";
  if (/database|jdbc/.test(t) || interaction === "data-access") return "jdbc";
  if (/\bdirect/.test(t)) return "direct";
  return undefined;
}

function targetFrom(
  text: string,
  interaction?: string,
): IntegrationPattern["targetType"] | undefined {
  const t = text.toLowerCase();
  if (/vendor|partner/.test(t)) return "vendor";
  if (/database|data store/.test(t) || interaction === "data-access") return "data-store";
  if (/\binternal\b/.test(t)) return "internal";
  if (/\bproduct\b/.test(t)) return "product";
  return undefined;
}

function resilienceFrom(controls: string[]): IntegrationPattern["resilience"] | undefined {
  const text = controls.join(", ").toLowerCase();
  const r: IntegrationPattern["resilience"] = {};
  const t =
    /timeout\s+(?:under|below|of|at most|max(?:imum)?|<=?)?\s*(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?)\b/.exec(
      text,
    );
  if (t) r.timeoutMs = Math.round(Number(t[1]) * (t[2]!.startsWith("m") ? 1 : 1000));
  const n = /(\d+)\s+retr(?:y|ies)/.exec(text);
  if (n) r.retries = Number(n[1]);
  if (/circuit[ -]breaker/.test(text)) r.circuitBreaker = true;
  return Object.keys(r).length ? r : undefined;
}

export function scanPatterns(page: KnowledgePage): PatternDraft[] {
  const out: PatternDraft[] = [];
  for (const s of page.sections)
    for (const b of s.blocks) {
      if (b.type !== "table") continue;
      const cols = new Map<Column, number>();
      b.header.forEach((h, i) => {
        const hl = h.toLowerCase();
        const col = COLUMNS.find(([c, re]) => re.test(hl) && !cols.has(c))?.[0];
        if (col) cols.set(col, i);
      });
      const codeAt =
        cols.get("code") ?? (b.rows.some((r) => isCode(r.cells[0] ?? "")) ? 0 : undefined);
      if (codeAt === undefined) continue;
      const cell = (row: string[], c: Column) => {
        const i = cols.get(c);
        const v = i === undefined ? undefined : row[i]?.trim();
        return v ? v : undefined;
      };
      for (const row of b.rows) {
        const code = row.cells[codeAt]?.trim() ?? "";
        if (!isCode(code) || out.some((d) => d.code === code)) continue;
        const name = cell(row.cells, "name");
        const definition = cell(row.cells, "definition");
        const ia = cell(row.cells, "interaction")?.toLowerCase();
        const interaction =
          ia === "sync" || ia === "async" || ia === "data-access"
            ? ia
            : ia && /data/.test(ia)
              ? "data-access"
              : ia && /async/.test(ia)
                ? "async"
                : ia && /sync/.test(ia)
                  ? "sync"
                  : undefined;
        const words = [name, definition].filter(Boolean).join(" ");
        const route =
          (cell(row.cells, "route") ? routeFrom(cell(row.cells, "route")!) : undefined) ??
          routeFrom(words, interaction);
        const targetType =
          (cell(row.cells, "target") ? targetFrom(cell(row.cells, "target")!) : undefined) ??
          targetFrom(words, interaction);
        const controls = cell(row.cells, "controls");
        const controlList = controls ? splitList(controls) : undefined;
        const resilience = controlList ? resilienceFrom(controlList) : undefined;
        const technology = cell(row.cells, "technology");
        out.push({
          code,
          line: row.line,
          draft: {
            schemaVersion: 1,
            code,
            ...(name ? { name } : {}),
            ...(definition ? { definition } : {}),
            ...(interaction ? { interaction } : {}),
            ...(route ? { route } : {}),
            ...(targetType ? { targetType } : {}),
            ...(controlList ? { controls: controlList } : {}),
            ...(resilience ? { resilience } : {}),
            ...(technology ? { technology: splitList(technology) } : {}),
            source: page.path,
            status: "to-review",
          },
        });
      }
    }
  return out;
}

const FIELDS = [
  "name",
  "definition",
  "interaction",
  "route",
  "targetType",
  "controls",
  "technology",
] as const;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Compare drafts read from a page with the org pack's patterns. */
export function diffPatterns(drafts: PatternDraft[], pack: IntegrationPattern[]): PatternDiff {
  const byCode = new Map(pack.map((p) => [p.code, p]));
  const res: PatternDiff = { new: [], changed: [], missing: [], same: [] };
  for (const d of drafts) {
    const p = byCode.get(d.code);
    if (!p) {
      res.new.push(d);
      continue;
    }
    const fields: PatternFieldDiff[] = [];
    for (const f of FIELDS) {
      const v = d.draft[f];
      if (v !== undefined && !same(v, p[f])) fields.push({ field: f, page: v, pack: p[f] });
    }
    for (const [k, v] of Object.entries(d.draft.resilience ?? {})) {
      const pv = (p.resilience as Record<string, unknown>)[k];
      if (!same(v, pv)) fields.push({ field: `resilience.${k}`, page: v, pack: pv });
    }
    if (fields.length) res.changed.push({ code: d.code, line: d.line, fields });
    else res.same.push(d.code);
  }
  const seen = new Set(drafts.map((d) => d.code));
  res.missing = pack
    .map((p) => p.code)
    .filter((c) => !seen.has(c))
    .sort();
  res.same.sort();
  return res;
}
