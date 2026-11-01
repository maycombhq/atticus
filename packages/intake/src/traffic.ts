import { createHash } from "node:crypto";
import {
  routeScore,
  TrafficFile,
  trafficFileText,
  type TrafficFileT,
  type TrafficRowT,
} from "@maycombhq/core";
import { parseCsv, type TrafficColumns } from "@maycombhq/ingestors";

/**
 * J4 (ADR 0151): a traffic export (a gateway's analytics, an API catalogue's usage), given as a
 * file, kept only as aggregate counts per caller app, method, path template, proxy and base path
 * over a date range. Raw rows are never kept. Every column but those is dropped before anything
 * is written; a value in a kept column that looks like an IP, an email, a token or an id is
 * dropped too (an app name becomes `(redacted)`, a path segment `{id}`); the query string is cut
 * off. The aggregate is then checked: no dropped value, no IP, email or token-looking string,
 * and nothing the deny-list names may be in it, or the import is refused and nothing written.
 * A file that doesn't read into that shape is refused, never stored.
 */

export interface AggregateTrafficInput {
  bytes: Uint8Array;
  /** The source's name, written in the aggregate (`apigee`, `catalog`). */
  source: string;
  columns: TrafficColumns;
  /** The day range to keep (YYYY-MM-DD, both ends kept); the rows' own range when left out. */
  from?: string;
  to?: string;
  /** The estate's route templates, which a concrete path is normalised to. */
  templates: readonly string[];
  /** SHA-256 hashes of denied words and two-word phrases (the `.denylist` format). */
  denyHashes?: ReadonlySet<string>;
}

export type AggregateTrafficResult =
  | {
      ok: true;
      file: TrafficFileT;
      /** The canonical text to write. */
      text: string;
      /** Rows read, rows outside the range, rows refused (no method, no path, a bad count). */
      read: number;
      outOfRange: number;
      skipped: number;
      /** The export's columns that were dropped, by name (never their values). */
      dropped: string[];
    }
  | { ok: false; message: string };

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/;
const IPV6 = /\b[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){4,7}\b/i;
const EMAIL = /[^\s@/]+@[^\s@/]+\.[a-z]{2,}/i;
const JWT = /\beyJ[A-Za-z0-9_-]{6,}/;
/** A long opaque string with letters and digits (a key, a client id, a token). */
const OPAQUE = /\b(?=[A-Za-z0-9+_-]*\d)(?=[A-Za-z0-9+_-]*[A-Za-z])[A-Za-z0-9+_-]{24,}={0,2}/;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const HEX = /\b[0-9a-f]{16,}\b/i;

/** Whether a value looks like an IP, an email, a token, a key or an id. */
export function looksSensitive(v: string): boolean {
  return [IPV4, IPV6, EMAIL, JWT, OPAQUE, UUID, HEX].some((re) => re.test(v));
}

/** The rows of a CSV or JSON export, each a column → value map; undefined when it is neither. */
function rowsOf(text: string): Record<string, string>[] | undefined {
  const t = text.replace(/^\uFEFF/, "").trim();
  if (!t) return undefined;
  if (t.startsWith("[") || t.startsWith("{")) {
    let v: unknown;
    try {
      v = JSON.parse(t);
    } catch {
      return undefined;
    }
    const list = Array.isArray(v)
      ? v
      : v && typeof v === "object"
        ? ["rows", "data", "records", "items"]
            .map((k) => (v as Record<string, unknown>)[k])
            .find((x) => Array.isArray(x))
        : undefined;
    if (!Array.isArray(list) || !list.length) return undefined;
    const out: Record<string, string>[] = [];
    for (const r of list) {
      if (!r || typeof r !== "object" || Array.isArray(r)) return undefined;
      const row: Record<string, string> = {};
      for (const [k, x] of Object.entries(r as Record<string, unknown>))
        if (typeof x === "string" || typeof x === "number") row[k] = String(x);
      out.push(row);
    }
    return out;
  }
  const recs = parseCsv(t);
  if (recs.length < 2) return undefined;
  const head = recs[0]!.cells.map((c) => c.trim());
  if (head.length < 2) return undefined;
  return recs.slice(1).map((r) => {
    const row: Record<string, string> = {};
    head.forEach((h, i) => (row[h] = (r.cells[i] ?? "").trim()));
    return row;
  });
}

/** The day of a date or timestamp (YYYY-MM-DD), or of epoch milliseconds. */
function dayOf(v: string): string | undefined {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(v.trim());
  if (m) return m[1];
  if (/^\d{12,13}$/.test(v.trim())) return new Date(Number(v)).toISOString().slice(0, 10);
  return undefined;
}

const VERSION = /^v\d+(?:\.\d+)*$/i;

/** A path's segment kept as written, or `{id}`: anything with a digit (but a version), or sensitive. */
const segmentOf = (s: string) =>
  VERSION.test(s) || (!/\d/.test(s) && !looksSensitive(s) && !/[@%]/.test(s) && s.length <= 40)
    ? s
    : "{id}";

/** A concrete path as the estate's route template it is, else with its ids as `{id}`. */
export function pathTemplateOf(path: string, templates: readonly string[]): string | undefined {
  let p = path.trim().split(/[?#]/, 1)[0] ?? "";
  p = p.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "");
  if (!p.startsWith("/")) return undefined;
  let best: string | undefined;
  let score = 0;
  for (const t of [...templates].sort()) {
    const s = routeScore(p, t);
    if (s >= 500 && s > score) {
      score = s;
      best = t;
    }
  }
  if (best) return best;
  const segs = p.split("/").filter(Boolean);
  return `/${segs.map(segmentOf).join("/")}`;
}

/** The deny-list's hits in a text: lines holding a denied word or two-word phrase. */
export function denyListHits(text: string, hashes: ReadonlySet<string>): number[] {
  const hits: number[] = [];
  text
    .toLowerCase()
    .split("\n")
    .forEach((line, i) => {
      const w = line.match(/[a-z0-9]+/g) ?? [];
      for (let k = 0; k < w.length; k++)
        if (
          hashes.has(sha(w[k]!)) ||
          (k + 1 < w.length && hashes.has(sha(`${w[k]} ${w[k + 1]}`)))
        ) {
          hits.push(i + 1);
          break;
        }
    });
  return hits;
}

/** Read a traffic export into its aggregate (ADR 0151), or say why it can't be. */
export function aggregateTraffic(input: AggregateTrafficInput): AggregateTrafficResult {
  const text = Buffer.from(input.bytes).toString("utf8");
  const rows = rowsOf(text);
  const shape = `a CSV with a header row, or a JSON list of rows, with an app, a method and a path column (${input.source}: app ${input.columns.app.join("/")}; method ${input.columns.method.join("/")}; path ${[...input.columns.path, ...input.columns.basepath].join("/")})`;
  if (!rows)
    return { ok: false, message: `The file doesn't read as a traffic export: give ${shape}.` };
  const names = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const col = (aliases: readonly string[]) => {
    for (const a of aliases) {
      const hit = names.find((n) => key(n) === key(a));
      if (hit) return hit;
    }
    return undefined;
  };
  const c = {
    app: col(input.columns.app),
    method: col(input.columns.method),
    basepath: col(input.columns.basepath),
    suffix: col(input.columns.suffix),
    proxy: col(input.columns.proxy),
    count: col(input.columns.count),
    time: col(input.columns.time),
    path: undefined as string | undefined,
  };
  if (!c.basepath || !c.suffix) c.path = col(input.columns.path);
  const missing = [
    !c.app ? "app" : "",
    !c.method ? "method" : "",
    !c.path && !(c.basepath && c.suffix) ? "path" : "",
  ].filter(Boolean);
  if (missing.length)
    return {
      ok: false,
      message: `The file has no ${missing.join(", ")} column, so it can't be kept as aggregates: give ${shape}.`,
    };
  const range = (v: string | undefined) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
  if ((input.from && !range(input.from)) || (input.to && !range(input.to)))
    return { ok: false, message: "--from and --to are days: YYYY-MM-DD." };
  if ((!input.from || !input.to) && !c.time)
    return {
      ok: false,
      message:
        "The export has no date column: give --from and --to (YYYY-MM-DD) for the range it covers.",
    };
  const kept = new Set(Object.values(c).filter((x): x is string => !!x));
  const dropped = names.filter((n) => !kept.has(n)).sort();

  // Every value that must not be written: those of the dropped columns, and the query strings.
  const secrets = new Set<string>();
  const keptValues = new Set<string>();
  const agg = new Map<string, TrafficRowT>();
  let outOfRange = 0;
  let skipped = 0;
  const days: string[] = [];
  for (const r of rows) {
    for (const n of dropped) {
      const v = (r[n] ?? "").trim();
      const q = /^(?:[a-z][a-z0-9+.-]*:\/\/|\/)/i.test(v) ? (v.split(/[?#]/)[1] ?? "") : v;
      if (q.length >= 6) secrets.add(q);
    }
    for (const n of [c.path, c.suffix, c.basepath]) {
      const q = n ? ((r[n] ?? "").split(/[?#]/)[1] ?? "") : "";
      if (q.length >= 4) secrets.add(q);
    }
    if (c.time) {
      const d = dayOf(r[c.time] ?? "");
      if (d) {
        if ((input.from && d < input.from) || (input.to && d > input.to)) {
          outOfRange++;
          continue;
        }
        days.push(d);
      } else if (!input.from || !input.to) {
        skipped++;
        continue;
      }
    }
    const method = (r[c.method!] ?? "").trim().toUpperCase();
    const rawPath = c.path
      ? (r[c.path] ?? "")
      : `${(r[c.basepath!] ?? "").replace(/\/+$/, "")}/${(r[c.suffix!] ?? "").replace(/^\/+/, "")}`;
    const path = pathTemplateOf(rawPath, input.templates);
    const countText = c.count ? (r[c.count] ?? "").trim() : "1";
    const count = Number(countText);
    if (!/^[A-Z]{3,10}$/.test(method) || !path || !Number.isInteger(count) || count < 0) {
      skipped++;
      continue;
    }
    if (count === 0) continue;
    const appRaw = (r[c.app!] ?? "").trim();
    const app = !appRaw ? "(none)" : looksSensitive(appRaw) ? "(redacted)" : appRaw;
    const proxyRaw = c.proxy ? (r[c.proxy] ?? "").trim() : "";
    const proxy = proxyRaw && !looksSensitive(proxyRaw) ? proxyRaw : undefined;
    const baseRaw = c.basepath ? (r[c.basepath] ?? "").trim() : "";
    const basepath = baseRaw ? pathTemplateOf(baseRaw, []) : undefined;
    for (const v of [app, proxy, basepath, path]) if (v) keptValues.add(v);
    const k = [app, method, path, proxy ?? "", basepath ?? ""].join("\u0000");
    const row = agg.get(k) ?? {
      app,
      method,
      path,
      ...(proxy ? { proxy } : {}),
      ...(basepath ? { basepath } : {}),
      count: 0,
    };
    row.count += count;
    agg.set(k, row);
  }
  if (!agg.size)
    return {
      ok: false,
      message: `No row of the file is a request in the range (${rows.length} read, ${outOfRange} outside it, ${skipped} without a method, path or count): nothing to keep.`,
    };
  days.sort();
  const from = input.from ?? days[0];
  const to = input.to ?? days[days.length - 1];
  if (!from || !to)
    return { ok: false, message: "The rows carry no dates: give --from and --to (YYYY-MM-DD)." };
  const parsed = TrafficFile.safeParse({
    schemaVersion: 1,
    source: input.source,
    from,
    to,
    inputSha256: createHash("sha256").update(input.bytes).digest("hex"),
    rows: [...agg.values()].sort(
      (a, b) =>
        cmp(a.app, b.app) ||
        cmp(a.proxy ?? "", b.proxy ?? "") ||
        cmp(a.path, b.path) ||
        cmp(a.method, b.method),
    ),
  });
  if (!parsed.success)
    return { ok: false, message: `The aggregate isn't valid: ${parsed.error.issues[0]?.message}.` };
  const out = trafficFileText(parsed.data);

  // The checks on what would be written: refused, never trimmed, so a reviewer sees why.
  const lower = out.toLowerCase();
  const leaked = [...secrets].filter((s) => !keptValues.has(s) && lower.includes(s.toLowerCase()));
  if (leaked.length)
    return {
      ok: false,
      message: `Refused: ${leaked.length} value${leaked.length === 1 ? "" : "s"} of the export's dropped columns would be written. Nothing was written.`,
    };
  const body = out.replace(/^inputSha256: .*$/m, "");
  if ([IPV4, EMAIL, JWT, OPAQUE, UUID].some((re) => re.test(body)))
    return {
      ok: false,
      message:
        "Refused: the aggregate would hold an IP, an email or a token-looking value. Nothing was written.",
    };
  const hits = input.denyHashes?.size ? denyListHits(out, input.denyHashes) : [];
  if (hits.length)
    return {
      ok: false,
      message: `Refused: the deny-list names a word on line${hits.length === 1 ? "" : "s"} ${hits.join(", ")} of the aggregate. Nothing was written.`,
    };
  return {
    ok: true,
    file: parsed.data,
    text: out,
    read: rows.length,
    outOfRange,
    skipped,
    dropped,
  };
}
