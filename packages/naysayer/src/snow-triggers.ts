import type { IntegrationPattern, OrgPack } from "@maycombhq/core";
import { hopRoutes, type ChangeFiles, type DataChange, type Hop } from "./artifacts.js";

/**
 * Which org-pack service-desk templates (C6 `process/snow/`) a change triggers, read one way
 * for everyone: the critic's snow-drafts-present check and the planner's snow.md drafts call
 * this, so a generated draft always satisfies the check.
 *
 * A trigger matches a planned interface whose route (the pattern's route, else the catalog's
 * `via`) fits `where`, a gateway route the interface notes name that the catalog doesn't have
 * yet (or has, for planned-modify and planned-retire), and a new table or column in data.md.
 * Every template a matched one `alsoNeeds` follows it. Matches come in template, trigger and
 * file order, repeats included; callers keep the first per template and record.
 */

export type ServiceRequestTemplate = OrgPack["serviceRequests"][number];
export type ServiceRequestTrigger = ServiceRequestTemplate["triggers"][number];

export interface TriggerMatch {
  /** The template the change needs. */
  template: ServiceRequestTemplate;
  /** The record the request is for: an interface id, `<caller>-<callee>`, a route or a table. */
  record: string;
  /** The trigger that matched (on `alongside` when this template is only also needed). */
  trigger: ServiceRequestTrigger;
  /** The template whose trigger matched, when `template` is needed through its `alsoNeeds`. */
  alongside?: ServiceRequestTemplate;
  /** The hop in interfaces.md that matched, for interface and route triggers. */
  hop?: Hop;
  /** Where it shows: the hop's line in interfaces.md, or the table's line in data.md. */
  line: number;
  file: "interfaces.md" | "data.md";
}

export interface TriggerInput {
  templates: readonly ServiceRequestTemplate[];
  hops: readonly Hop[];
  data: readonly DataChange[];
  files: ChangeFiles;
  patterns: ReadonlyMap<string, Pick<IntegrationPattern, "route">>;
  /** A catalog record by kind and id (interfaces for their `via`, gateway routes for existence). */
  get(kind: "Interface" | "GatewayRoute", id: string): object | undefined;
}

/** "planned-new (Interface, via gateway)": how a match reads in a need's reason. */
export function triggerReason(record: string, trig: ServiceRequestTrigger): string {
  const where = Object.entries(trig.where);
  return `${record} is ${trig.change} (${trig.kind}${
    where.length ? `, ${where.map(([k, v]) => `${k} ${v}`).join(", ")}` : ""
  })`;
}

export function matchServiceRequestTriggers(input: TriggerInput): TriggerMatch[] {
  const out: TriggerMatch[] = [];
  for (const t of input.templates) {
    for (const trig of t.triggers) {
      const matches: {
        record: string;
        fields: Record<string, string>;
        hop?: Hop;
        line: number;
        file: TriggerMatch["file"];
      }[] = [];
      if (trig.kind === "Interface")
        for (const h of input.hops) {
          if (h.status !== trig.change) continue;
          const rec = h.id.startsWith("if-")
            ? (input.get("Interface", h.id) as { via?: string } | undefined)
            : undefined;
          const via = input.patterns.get(h.pattern)?.route ?? rec?.via;
          if (!via) continue;
          matches.push({
            record: h.id !== "new" ? h.id : `${h.caller}-${h.callee}`,
            fields: { via, method: h.method ?? "", from: h.caller, to: h.callee },
            hop: h,
            line: h.line,
            file: "interfaces.md",
          });
        }
      if (trig.kind === "GatewayRoute")
        for (const h of input.hops)
          for (const route of hopRoutes(input.files, h)) {
            const exists = !!input.get("GatewayRoute", route);
            if ((trig.change === "planned-new") === exists) continue;
            if (trig.change !== "planned-new" && h.status !== trig.change) continue;
            matches.push({
              record: route,
              fields: {},
              hop: h,
              line: h.line,
              file: "interfaces.md",
            });
          }
      if ((trig.kind === "Table" || trig.kind === "Column") && trig.change === "planned-new")
        for (const d of input.data) {
          if (trig.kind === "Table" && d.newTable)
            matches.push({ record: d.tableId, fields: {}, line: d.line, file: "data.md" });
          if (trig.kind === "Column")
            for (const c of d.newColumns)
              matches.push({
                record: `${d.tableId}.${c.name}`,
                fields: {},
                line: d.line,
                file: "data.md",
              });
        }
      for (const m of matches) {
        if (!Object.entries(trig.where).every(([k, v]) => m.fields[k] === v)) continue;
        const base = {
          record: m.record,
          trigger: trig,
          ...(m.hop ? { hop: m.hop } : {}),
          line: m.line,
          file: m.file,
        };
        out.push({ template: t, ...base });
        for (const also of t.alsoNeeds) {
          const at = input.templates.find((x) => x.id === also);
          if (at) out.push({ template: at, alongside: t, ...base });
        }
      }
    }
  }
  return out;
}
