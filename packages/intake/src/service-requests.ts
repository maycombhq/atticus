import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parse } from "yaml";

/**
 * Exported service-desk requests (closed ServiceNow requests and the like) dropped into
 * inputs/ (ADR 0032 point 3). When the service desk can't be reached, or its adapter is
 * manual, these exports are what Atticus reads: to know past requests, and to learn request
 * templates from them (which fields were always filled, which group approved, how long a
 * request took). Read-only, deterministic, files only. Three shapes: a flat list (`number`,
 * `type`, `fields`, `opened`, `closed`, `approvalGroup`), a table export (`result: [...]`
 * with `opened_at`, `closed_at`, `cat_item`, `approval_group`, `variables`), and CSV with a
 * Number column (other columns become fields).
 */

export const SERVICE_REQUEST_READER = "service-requests@0.1.0";

export interface ExportedServiceRequest {
  /** The request number, e.g. SR-0001 or RITM0012345. */
  id: string;
  /** The request type or catalog item as the desk names it. */
  type: string;
  state?: string;
  /** Field name → value, as exported. */
  fields: Record<string, string | number>;
  opened?: string;
  closed?: string;
  approvalGroup?: string;
  source: { path: string; line?: number };
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const text = (v: unknown): string | undefined => {
  if (v === undefined || v === null) return undefined;
  if (isObj(v)) return text(v.display_value ?? v.displayName ?? v.name ?? v.value);
  const s = String(v).trim();
  return s.length ? s : undefined;
};

const norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "");

function pick(o: Record<string, unknown>, ...names: string[]): unknown {
  const want = names.map(norm);
  for (const [k, v] of Object.entries(o)) if (want.includes(norm(k))) return v;
  return undefined;
}

/** A date as YYYY-MM-DD, from a date or date-time. */
const day = (v: unknown): string | undefined => {
  const s = text(v);
  const m = s ? /^(\d{4}-\d{2}-\d{2})/.exec(s) : null;
  return m ? m[1] : undefined;
};

const KNOWN = [
  "number",
  "id",
  "type",
  "requesttype",
  "catitem",
  "catalogitem",
  "state",
  "status",
  "opened",
  "openedat",
  "closed",
  "closedat",
  "approvalgroup",
  "assignmentgroup",
  "fields",
  "variables",
];

function requestOf(
  o: Record<string, unknown>,
  path: string,
  lineOf: (id: string) => number | undefined,
): ExportedServiceRequest | undefined {
  const id = text(pick(o, "number", "id"));
  const type = text(pick(o, "type", "requestType", "cat_item", "catalogItem"));
  if (!id || !type) return undefined;
  const nested = pick(o, "fields", "variables");
  const fields: Record<string, string | number> = {};
  const add = (k: string, v: unknown) => {
    if (typeof v === "number") fields[k] = v;
    else {
      const s = text(v);
      if (s !== undefined) fields[k] = s;
    }
  };
  if (isObj(nested)) for (const [k, v] of Object.entries(nested)) add(k, v);
  else for (const [k, v] of Object.entries(o)) if (!KNOWN.includes(norm(k))) add(k, v);
  const state = text(pick(o, "state", "status"));
  const opened = day(pick(o, "opened", "opened_at"));
  const closed = day(pick(o, "closed", "closed_at"));
  const approvalGroup = text(pick(o, "approvalGroup", "approval_group", "assignment_group"));
  const line = lineOf(id);
  return {
    id,
    type,
    ...(state ? { state } : {}),
    fields,
    ...(opened ? { opened } : {}),
    ...(closed ? { closed } : {}),
    ...(approvalGroup ? { approvalGroup } : {}),
    source: { path, ...(line ? { line } : {}) },
  };
}

/** RFC 4180 CSV rows with the line each starts on. */
function csvRows(s: string): { cells: string[]; line: number }[] {
  const rows: { cells: string[]; line: number }[] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let start = 1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else {
        if (c === "\n") line++;
        cell += c;
      }
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((x) => x.trim())) rows.push({ cells: row, line: start });
      row = [];
      cell = "";
      line++;
      start = line;
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push({ cells: row, line: start });
  return rows;
}

/**
 * The requests in one exported file, or undefined when it isn't a service-request export (a
 * work-item export, a document). Never throws.
 */
export function readServiceRequestExport(
  path: string,
  bytes: Uint8Array,
): ExportedServiceRequest[] | undefined {
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  } catch {
    return undefined;
  }
  if (/\.csv$/i.test(path)) {
    const rows = csvRows(content);
    const header = rows[0]?.cells.map((h) => h.trim());
    if (!header?.some((h) => norm(h) === "number")) return undefined;
    if (!header.some((h) => ["type", "requesttype", "catitem", "catalogitem"].includes(norm(h))))
      return undefined;
    const out: ExportedServiceRequest[] = [];
    for (const r of rows.slice(1)) {
      const o = Object.fromEntries(header.map((h, i) => [h, r.cells[i] ?? ""]));
      const req = requestOf(o, path, () => r.line);
      if (req) out.push(req);
    }
    return out.length ? out : undefined;
  }
  if (!/\.(json|ya?ml)$/i.test(path)) return undefined;
  let data: unknown;
  try {
    data = parse(content);
  } catch {
    return undefined;
  }
  const list = Array.isArray(data)
    ? data
    : isObj(data) && Array.isArray(data.result)
      ? data.result
      : isObj(data) && Array.isArray(data.requests)
        ? data.requests
        : undefined;
  if (!list?.length || !list.every(isObj)) return undefined;
  // A request has a number and something only requests carry: fields, variables or dates.
  const looks = (o: Record<string, unknown>) =>
    pick(o, "number") !== undefined &&
    [
      pick(o, "fields", "variables"),
      pick(o, "opened", "opened_at"),
      pick(o, "closed", "closed_at"),
    ].some((v) => v !== undefined);
  if (!(list as Record<string, unknown>[]).every(looks)) return undefined;
  const lines = content.split("\n");
  const lineOf = (id: string) => {
    const re = new RegExp(
      `"?number"?\\s*:\\s*"?${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`,
    );
    const i = lines.findIndex((l) => re.test(l));
    return i >= 0 ? i + 1 : undefined;
  };
  const out: ExportedServiceRequest[] = [];
  for (const o of list as Record<string, unknown>[]) {
    const r = requestOf(o, path, lineOf);
    if (!r) return undefined;
    out.push(r);
  }
  return out;
}

/** Every service-request export under inputs/, in path order (paths start with inputs/). */
export async function readServiceRequestExports(o: { root: string; inputsDir?: string }): Promise<{
  requests: ExportedServiceRequest[];
  files: string[];
  problems: { path: string; message: string }[];
}> {
  const dir = o.inputsDir ?? join(o.root, "inputs");
  const found: string[] = [];
  async function walk(d: string) {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (e.name.startsWith(".")) continue;
      const full = join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (/\.(json|ya?ml|csv)$/i.test(e.name)) found.push(full);
    }
  }
  await walk(dir);
  const out = {
    requests: [] as ExportedServiceRequest[],
    files: [] as string[],
    problems: [] as { path: string; message: string }[],
  };
  for (const full of found) {
    const path = `inputs/${relative(dir, full).split(sep).join("/")}`;
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(full));
    } catch (e) {
      out.problems.push({ path, message: `can't read it: ${(e as Error).message}` });
      continue;
    }
    const rs = readServiceRequestExport(path, bytes);
    if (!rs) continue;
    out.files.push(path);
    out.requests.push(...rs);
  }
  return out;
}
