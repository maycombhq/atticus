import type { RecordOf, ServiceRequestTemplate } from "@maycombhq/core";
import { hopRoutes, readSnowDrafts, type Hop } from "@maycombhq/naysayer";
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
  for (const t of templates) {
    for (const trig of t.triggers) {
      const matches: {
        record: string;
        fields: Record<string, string>;
        hop?: Hop;
        line?: number;
      }[] = [];
      if (trig.kind === "Interface")
        for (const h of ctx.hops) {
          if (h.status !== trig.change) continue;
          const p = ctx.patterns.get(h.pattern);
          const rec = h.id.startsWith("if-") ? ctx.get("Interface", h.id) : undefined;
          const via = p?.route ?? rec?.via;
          if (!via) continue;
          matches.push({
            record: h.id !== "new" ? h.id : `${h.caller}-${h.callee}`,
            fields: { via, method: h.method ?? "", from: h.caller, to: h.callee },
            hop: h,
            line: h.line,
          });
        }
      if (trig.kind === "GatewayRoute")
        for (const h of ctx.hops)
          for (const route of hopRoutes(ctx.files, h)) {
            const exists = !!ctx.get("GatewayRoute", route);
            if ((trig.change === "planned-new") === exists) continue;
            if (trig.change !== "planned-new" && h.status !== trig.change) continue;
            matches.push({ record: route, fields: {}, hop: h, line: h.line });
          }
      if ((trig.kind === "Table" || trig.kind === "Column") && trig.change === "planned-new")
        for (const d of ctx.data) {
          if (trig.kind === "Table" && d.newTable)
            matches.push({ record: d.tableId, fields: {}, line: d.line });
          if (trig.kind === "Column")
            for (const c of d.newColumns)
              matches.push({ record: `${d.tableId}.${c.name}`, fields: {}, line: d.line });
        }
      for (const m of matches) {
        if (!Object.entries(trig.where).every(([k, v]) => m.fields[k] === v)) continue;
        const why = `${m.record} is ${trig.change} (${trig.kind}${
          Object.keys(trig.where).length
            ? `, ${Object.entries(trig.where)
                .map(([k, v]) => `${k} ${v}`)
                .join(", ")}`
            : ""
        })`;
        add({
          template: t,
          record: m.record,
          why,
          ...(m.hop ? { hop: m.hop } : {}),
          ...(m.line ? { line: m.line } : {}),
        });
        for (const also of t.alsoNeeds) {
          const at = templates.find((x) => x.id === also);
          if (at)
            add({
              template: at,
              record: m.record,
              why: `the ${t.name.toLowerCase()} for ${m.record} also needs a ${at.name.toLowerCase()}`,
              ...(m.hop ? { hop: m.hop } : {}),
              ...(m.line ? { line: m.line } : {}),
            });
        }
      }
    }
  }
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
