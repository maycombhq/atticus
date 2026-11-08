import type { RecordOf, ServiceRequestTemplate } from "@maycombhq/core";
import {
  matchServiceRequestTriggers,
  parseDoc,
  readSnowDrafts,
  triggerReason,
  type Hop,
} from "@maycombhq/naysayer";
import type { z } from "zod";
import type { PlanContext } from "./context.js";

/**
 * Service-desk drafts (snow.md) from the org pack's request templates (C6 `process/snow/`).
 * Which requests a change needs comes from each template's triggers, read exactly as the
 * critic's snow-drafts-present check reads them, so a generated draft satisfies the check:
 * a planned interface whose route (pattern route, else the catalog's `via`) matches `where`,
 * a gateway route the interface notes name that the catalog doesn't have yet, a new table or
 * column; plus every template a matched one `alsoNeeds`. Field values come from the
 * template's `from` (e.g. "${record}"), else from the field's name; what the catalog can't
 * tell is left empty and listed, never guessed.
 */

export type Template = z.infer<typeof ServiceRequestTemplate>;

export interface SnowNeed {
  template: Template;
  /** The record the request is for: an interface id, `<caller>-<callee>`, a route or a table. */
  record: string;
  why: string;
  /** The hop that triggered it, when there is one. */
  hop?: Hop;
  line?: number;
}

export interface SnowDraft {
  need: SnowNeed;
  fields: { name: string; value: string; required: boolean; source: string }[];
  /** Values filled by a stated assumption (a person checks them). */
  assumed: string[];
  /** Required fields left empty, with why. */
  missing: string[];
}

export function snowNeeds(ctx: PlanContext): SnowNeed[] {
  const templates = ctx.lifecycle.orgPack.serviceRequests;
  const needs: SnowNeed[] = [];
  const add = (n: SnowNeed) => {
    if (!needs.some((x) => x.template.id === n.template.id && x.record === n.record)) needs.push(n);
  };
  for (const m of matchServiceRequestTriggers({
    templates,
    hops: ctx.hops,
    data: ctx.data,
    files: ctx.files,
    patterns: ctx.patterns,
    get: (kind, id) => ctx.get(kind, id),
  }))
    add({
      template: m.template,
      record: m.record,
      why: m.alongside
        ? `the ${m.alongside.name.toLowerCase()} for ${m.record} also needs a ${m.template.name.toLowerCase()}`
        : triggerReason(m.record, m.trigger),
      ...(m.hop ? { hop: m.hop } : {}),
      ...(m.line ? { line: m.line } : {}),
    });
  return needs;
}

/**
 * A gateway route's base path, when every route the catalog knows follows one convention:
 * `gw-<name>-<version>` serves `/<name>/<version>` (as gw-ledger-v1 serves /ledger/v1).
 */
function basePathOf(ctx: PlanContext, route: string): string | undefined {
  const routes = ctx.records.filter((r) => r.kind === "GatewayRoute") as RecordOf<"GatewayRoute">[];
  const conv = (id: string) => {
    const m = /^gw-(.+?)(?:-(v\d+))?$/.exec(id);
    return m ? `/${m[1]!.replace(/-/g, "/")}${m[2] ? `/${m[2]}` : ""}` : undefined;
  };
  if (routes.length === 0 || !routes.every((r) => r.basepath && conv(r.id) === r.basepath))
    return undefined;
  return conv(route);
}

type Var = { value: string; source: string; assumed?: string };

function variables(ctx: PlanContext, n: SnowNeed): Record<string, Var | undefined> {
  const h = n.hop;
  const isRoute =
    n.template.triggers.some((t) => t.kind === "GatewayRoute") || /^gw-/.test(n.record);
  const http = !!h?.method;
  const callee = h ? (ctx.systemOf(h.callee) ?? h.callee) : undefined;
  const v: Record<string, Var | undefined> = {
    record: { value: n.record, source: "the record that needs the request" },
    change: { value: ctx.change.id, source: "the change" },
    changeTitle: { value: ctx.change.title, source: "the change" },
    caller: h ? { value: isRoute ? n.record : h.caller, source: "interfaces.md" } : undefined,
    callee: h ? { value: h.callee, source: "interfaces.md" } : undefined,
    operation: h ? { value: h.operation, source: "interfaces.md" } : undefined,
    method: h?.method ? { value: h.method, source: "interfaces.md" } : undefined,
    path: h?.path ? { value: h.path, source: "interfaces.md" } : undefined,
    basePath:
      isRoute && basePathOf(ctx, n.record)
        ? {
            value: basePathOf(ctx, n.record)!,
            source: "the naming of the catalog's gateway routes",
          }
        : undefined,
    protocol: http
      ? {
          value: "HTTPS",
          source: "assumed",
          assumed: `Protocol HTTPS, because ${h!.operation} is an HTTP call`,
        }
      : undefined,
    port: http
      ? {
          value: "443",
          source: "assumed",
          assumed: `Port 443, the HTTPS port, because ${h!.operation} is an HTTP call`,
        }
      : undefined,
    justification: h
      ? {
          value: `${h.caller} calls ${callee} ${h.operation}${isRoute ? ` through ${n.record}` : ""} for change ${ctx.change.id} (${ctx.change.title}).`,
          source: "interfaces.md and the change",
        }
      : {
          value: `${n.record} for change ${ctx.change.id} (${ctx.change.title}).`,
          source: "the change",
        },
  };
  return v;
}

/** Which variable a template field means, by its name, when the template has no `from`. */
function byName(name: string, isRoute: boolean): string | undefined {
  const k = name.toLowerCase().trim();
  if (/^(proxy|route)( name)?$/.test(k)) return isRoute ? "record" : undefined;
  if (/base ?path/.test(k)) return "basePath";
  if (/^source( app| application| system)?$/.test(k)) return "caller";
  if (/^port$/.test(k)) return "port";
  if (/^protocol$/.test(k)) return "protocol";
  if (/justification|reason/.test(k)) return "justification";
  if (/^(operation|endpoint)$/.test(k)) return "operation";
  return undefined;
}

function render(template: string, vars: Record<string, Var | undefined>): Var | undefined {
  let source = "";
  let ok = true;
  const value = template.replace(/\$\{\s*([A-Za-z]+)\s*\}/g, (_m, k: string) => {
    const v = vars[k];
    if (!v) {
      ok = false;
      return "";
    }
    source ||= v.source;
    return v.value;
  });
  return ok ? { value, source: source || "the template" } : undefined;
}

export function draftFor(ctx: PlanContext, n: SnowNeed): SnowDraft {
  const vars = variables(ctx, n);
  const isRoute =
    /^gw-/.test(n.record) || n.template.triggers.some((t) => t.kind === "GatewayRoute");
  const assumed: string[] = [];
  const missing: string[] = [];
  const fields = n.template.fields.map((f) => {
    const key = f.from ? undefined : byName(f.name, isRoute);
    const v = f.from ? render(f.from, vars) : key ? vars[key] : undefined;
    if (v?.assumed) assumed.push(v.assumed);
    if (!v?.value && f.required)
      missing.push(`${f.name}: not in the catalog or the change; fill it in before submitting`);
    return { name: f.name, value: v?.value ?? "", required: f.required, source: v?.source ?? "" };
  });
  return { need: n, fields, assumed, missing };
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** snow.md: one section per needed request, in the shape the critic reads. */
export function renderSnow(drafts: SnowDraft[], waits: Map<string, string[]>): string {
  const lines = [
    "<!-- Generated by atticus plan snow from org-pack/process/snow. Edit the values; re-run to regenerate. -->",
    "# Service-desk requests",
    "",
  ];
  if (drafts.length === 0) {
    lines.push(
      "No service-desk request is needed: no org-pack template's triggers match this change.",
      "",
    );
    return lines.join("\n");
  }
  for (const d of drafts) {
    const t = d.need.template;
    const tasks = waits.get(`${t.id}|${d.need.record}`) ?? [];
    lines.push(
      `## ${t.requestType}: ${d.need.record}`,
      "",
      `Template ${t.id} (org-pack/process/snow/${t.id}.yaml). Approvers: ${t.approvers.join(", ") || "none named"}. Lead time: ${t.leadTimeDays} days. Why: ${d.need.why}.${tasks.length ? ` Unblocks task${tasks.length > 1 ? "s" : ""} ${tasks.join(", ")}.` : ""}`,
      "",
      "| Field | Value |",
      "| --- | --- |",
      ...d.fields.map((f) => `| ${cell(f.name)} | ${cell(f.value)} |`),
      "",
    );
    if (d.assumed.length)
      lines.push("Assumed (check before submitting):", "", ...d.assumed.map((a) => `- ${a}`), "");
    if (d.missing.length) lines.push("To fill:", "", ...d.missing.map((m) => `- ${m}`), "");
  }
  return lines.join("\n").replace(/\n+$/, "\n");
}

/** Drafts as written in snow.md now (a person may have filled values), matched to templates. */
export function readDrafts(
  ctx: PlanContext,
): { template: Template; record: string; fields: Record<string, string>; heading: string }[] {
  const templates = ctx.lifecycle.orgPack.serviceRequests;
  return readSnowDrafts(ctx.files).flatMap((d) => {
    const h = d.heading.toLowerCase();
    const t = templates.find((x) =>
      [x.requestType, x.name, x.id].some((n) => h.includes(n.toLowerCase())),
    );
    if (!t) return [];
    const record = /:\s*(\S+)\s*$/.exec(d.heading)?.[1] ?? "";
    const fields: Record<string, string> = {};
    for (const f of t.fields) fields[f.name] = d.fields.get(f.name.toLowerCase())?.value ?? "";
    return [{ template: t, record, fields, heading: d.heading }];
  });
}

/** Why snow.md's fields weren't filled: nothing was changed. */
export class SnowFillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnowFillError";
  }
}

/** A table row's cells, as the reader splits them (naysayer's parseDoc). */
const rowCells = (line: string) => {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
};

/**
 * Round 36 (UX review): fill fields of one draft in snow.md, as a person would edit the file.
 * Only the value cell of each field's row in that request's Field | Value table changes; a field
 * the table lacks is added as a row after its last one. A filled field's line in the request's
 * "To fill:" note goes (and the note, once it lists nothing). Comments, the other requests and
 * every other line stay as written, with the file's own line ends. Throws SnowFillError.
 */
export function fillSnowFields(
  text: string,
  heading: string,
  values: Record<string, string>,
): string {
  const given = Object.entries(values).map(([name, v]) => [name.trim(), v.trim()] as const);
  if (!given.length) throw new SnowFillError("Give at least one field to fill.");
  for (const [name, v] of given)
    if (!name || /[|\r\n]/.test(v) || /[|\r\n]/.test(name))
      throw new SnowFillError(
        `${name || "A field"}: a value can't hold | or a line break (snow.md keeps it in a table cell).`,
      );
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const doc = parseDoc("snow.md", text);
  const raw = doc.rawLines;
  const s = doc.sections.find((x) => x.level === 2 && x.heading === heading);
  if (!s)
    throw new SnowFillError(
      `snow.md has no request "${heading}". Reload the page to see its requests.`,
    );
  const table = doc.tables.find(
    (t) => t.line >= s.line && t.line <= s.end && t.headers.includes("field"),
  );
  if (!table || !table.headers.includes("value"))
    throw new SnowFillError(`"${heading}" in snow.md has no Field | Value table to fill.`);
  const fieldAt = table.headers.indexOf("field");
  const valueAt = table.headers.indexOf("value");
  const edited = new Map<number, string>();
  const added: string[] = [];
  const row = (cells: string[]) => `| ${cells.join(" | ")} |`;
  for (const [name, v] of given) {
    const r = table.rows.find((x) => (x.cells.field ?? "").toLowerCase() === name.toLowerCase());
    if (!r) {
      const cells = table.headers.map(() => "");
      cells[fieldAt] = name;
      cells[valueAt] = v;
      added.push(row(cells));
      continue;
    }
    const at = r.line - 1;
    if (raw[at]!.includes("<!--"))
      throw new SnowFillError(`${name}'s row in snow.md holds a comment: edit that row there.`);
    const cells = rowCells(raw[at]!);
    while (cells.length < table.headers.length) cells.push("");
    cells[valueAt] = v;
    edited.set(at, row(cells));
  }
  // The "To fill:" note's lines for the fields filled now, and the note once it lists nothing.
  const filled = given.filter(([, v]) => v).map(([n]) => n.toLowerCase());
  const drop = new Set<number>();
  const lines = doc.lines;
  for (let i = s.line; i < s.end; i++) {
    if (lines[i]!.trim() !== "To fill:") continue;
    let j = i + 1;
    const bullets: number[] = [];
    for (; j < s.end; j++) {
      const l = lines[j]!.trim();
      if (!l) continue;
      if (!l.startsWith("- ")) break;
      bullets.push(j);
    }
    for (const b of bullets) {
      const l = lines[b]!.trim().slice(2).toLowerCase();
      if (filled.some((n) => l.startsWith(`${n}:`))) drop.add(b);
    }
    if (bullets.length && bullets.every((b) => drop.has(b))) {
      // The note, its bullets and the blank lines among them; one blank line after it too.
      const last = bullets[bullets.length - 1]!;
      for (let k = i; k <= last; k++) drop.add(k);
      if (last + 1 < raw.length && !raw[last + 1]!.trim() && last + 1 < s.end) drop.add(last + 1);
    }
  }
  const lastRow = table.rows.length ? table.rows[table.rows.length - 1]!.line - 1 : table.line;
  const out: string[] = [];
  raw.forEach((l, i) => {
    if (!drop.has(i)) out.push(edited.get(i) ?? l);
    if (i === lastRow) out.push(...added);
  });
  return out.join(eol);
}
