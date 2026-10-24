import type { SourceInput } from "@maycombhq/ai";
import { endpointKey, type Estate } from "./estate.js";
import type { StageIssue } from "./loop.js";

/**
 * The endpoints a brief names and the flows they start (W5). A live run's brief named
 * `GET /api/chats/{id}/messages` twice, and both times the design changed only the open-chat flow,
 * whose trigger is `GET /api/chats/{id}`: the estate showed a flow's trigger in words, never its
 * method and path, so the drafter couldn't map the endpoint to the flow that serves it. These are
 * facts: an endpoint written as METHOD /path in the brief, matched (parameters folded) to the
 * Endpoint record a flow's trigger cites. Which flow the change is about stays the drafter's
 * reading; a design that leaves the endpoint's flow alone gets a note, never a block.
 */

export interface BriefEndpoint {
  /** As the brief writes it. */
  endpoint: string;
  /** The flows whose trigger it is. */
  flows: string[];
}

/** "METHOD /path" as written in the text, each once, in order. */
function endpointsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s`'",;)\]]*)/g)) {
    const e = `${m[1]} ${m[2]!.replace(/[.:]+$/, "")}`;
    if (!out.some((x) => endpointKey(x) === endpointKey(e))) out.push(e);
  }
  return out;
}

/** The endpoints the brief names that start a flow, with those flows. */
export function briefEndpoints(brief: string, e: Estate): BriefEndpoint[] {
  const out: BriefEndpoint[] = [];
  for (const endpoint of endpointsIn(brief)) {
    const key = endpointKey(endpoint).toLowerCase();
    const flows = e.flows
      .filter((f) => {
        const r = f.flow.trigger.ref ? e.byId.get(f.flow.trigger.ref) : undefined;
        if (r?.kind !== "Endpoint") return false;
        const at = `${String(r.method ?? "")} ${String(r.pathOrTopic ?? "")}`;
        return endpointKey(at).toLowerCase() === key;
      })
      .map((f) => f.flow.id)
      .sort();
    if (flows.length) out.push({ endpoint, flows });
  }
  return out;
}

/** The data block the drafter (and the lenses, with the drafter's sources) reads: none when empty. */
export function briefEndpointsSource(brief: string, e: Estate): SourceInput[] {
  const found = briefEndpoints(brief, e);
  if (!found.length) return [];
  return [
    {
      id: "brief-endpoints",
      kind: "catalog",
      origin: "the brief's endpoints, matched to the flows' trigger entries (deterministic)",
      text: [
        "Endpoints the brief names, and the flow each one starts (its trigger entry, from the specs and the catalog). A change to what one of these endpoints does is a change to that flow.",
        ...found.map(
          (b) => `- ${b.endpoint}: the trigger entry of flow ${b.flows.join(", flow ")}`,
        ),
      ].join("\n"),
      classification: "internal",
      priority: 86,
    },
  ];
}

/**
 * A note to the drafter for each endpoint the brief names whose flow the design doesn't touch
 * (W5): not blocking, since the brief may name an endpoint it leaves alone; the drafter reads it
 * and decides.
 */
export function briefEndpointNotes(
  brief: string,
  e: Estate,
  deltas: readonly { flow: string }[],
): StageIssue[] {
  const touched = new Set(deltas.map((d) => d.flow));
  return briefEndpoints(brief, e)
    .filter((b) => !b.flows.some((f) => touched.has(f)))
    .map((b) => {
      const flows = b.flows.join(" or ");
      return {
        rule: "delta.brief-endpoint-flow",
        target: b.endpoint,
        blocking: false,
        kind: "drafting" as const,
        message: `The brief names ${b.endpoint}, the trigger entry of flow ${flows}, but the design doesn't change that flow. If the change is to what ${b.endpoint} does, change ${flows}; otherwise leave it as it is.`,
      };
    });
}
