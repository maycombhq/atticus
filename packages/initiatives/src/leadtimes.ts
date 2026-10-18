import type { OrgPack } from "@maycombhq/core";
import type { ExportedServiceRequest } from "@maycombhq/intake";
import { parseLeadTime, workingDays } from "./dates.js";
import type { JourneyStep } from "./journeys.js";
import type { PartyRecord } from "./store.js";

/**
 * How long a step takes, and where that number came from. In order: what the party says
 * (`Party.typicalLeadTimes`, keyed by the step's lead-time key or the request template id);
 * for a service-desk request, the median working days of past requests of that type (closed
 * requests exported into inputs/ and read by intake, ADR 0032), then the request template's
 * `leadTimeDays`; else the journey's default for the step. Every figure cites its source.
 */

export interface LeadTime {
  days: number;
  source: string;
}

export interface LeadTimeContext {
  templates: readonly OrgPack["serviceRequests"][number][];
  requests: readonly ExportedServiceRequest[];
  journey: string;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function leadTimeFor(
  step: Pick<JourneyStep, "id" | "kind" | "leadTimeKey" | "template" | "days">,
  party: PartyRecord | undefined,
  ctx: LeadTimeContext,
): LeadTime {
  const key = step.template ?? step.leadTimeKey;
  if (party && key && party.typicalLeadTimes[key] !== undefined) {
    const raw = party.typicalLeadTimes[key]!;
    const days = parseLeadTime(raw);
    if (days !== undefined) return { days, source: `${party.id} typicalLeadTimes.${key} (${raw})` };
  }
  if (step.kind === "request" && step.template) {
    const t = ctx.templates.find((x) => x.id === step.template);
    const names = new Set([norm(step.template), ...(t ? [norm(t.requestType), norm(t.id)] : [])]);
    const past = ctx.requests.filter((r) => names.has(norm(r.type)) && r.opened && r.closed);
    if (past.length) {
      const days = past.map((r) => workingDays(r.opened!, r.closed!));
      const med = median(days);
      const files = [...new Set(past.map((r) => r.source.path))].sort().join(", ");
      return {
        days: Math.ceil(med),
        source: `${files} (median ${med} working days over ${past.length} request${past.length === 1 ? "" : "s"}, rounded up)`,
      };
    }
    if (t)
      return { days: t.leadTimeDays, source: `org-pack/process/snow/${t.id}.yaml leadTimeDays` };
  }
  return {
    days: step.days,
    source: `journey ${ctx.journey} step ${step.id} (${step.days} working days)`,
  };
}
