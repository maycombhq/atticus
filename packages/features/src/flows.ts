import type { CatalogRecord } from "@maycombhq/core";
import { Tracer, type EntryPoint, type Flow } from "./detect.js";
import type { CapabilityRec, FlowGraph } from "./graph.js";
import { overlaps, splitWords, tokens } from "./words.js";

/**
 * The flows of the features in a catalog, traced again from each feature's entry points as
 * they are now (people may have split or merged them), and where those flows end in
 * something Atticus can't follow: a caller nothing leads to, an event nothing makes
 * happen, a call seen at one end only, or a loose end in a component the flow passes.
 */

export type LooseEndKind = "unknown-caller" | "unknown-trigger" | "one-end" | "loose-end";

export interface LooseEnd {
  kind: LooseEndKind;
  /** The interface or Unresolved record that can't be followed. */
  record: string;
  /** One clause, for an owner question. */
  text: string;
}

export interface FeatureFlows {
  feature: CapabilityRec;
  /** System of the component where the first entry point starts work. */
  system?: string;
  flows: Flow[];
  looseEnds: LooseEnd[];
}

/** The component where an entry point starts work. */
export function entryComponent(g: FlowGraph, id: string): string | undefined {
  return (
    g.endpoints.get(id)?.component ??
    g.interfaces.get(id)?.to ??
    g.settings.get(id)?.component ??
    (g.components.has(id) ? id : undefined)
  );
}

export function featureFlows(
  records: readonly CatalogRecord[],
  o: { maxDepth?: number } = {},
): FeatureFlows[] {
  const tracer = new Tracer(records, o.maxDepth);
  const g = tracer.g;
  const entries = new Map<string, EntryPoint>();
  for (const f of g.capabilities)
    for (const id of f.entryPoints) {
      if (entries.has(id)) continue;
      const e = tracer.entryFor(id);
      if (e) entries.set(id, e);
    }
  tracer.useEntries([...entries.values()]);
  const flows = new Map([...entries.values()].map((e) => [e.id, tracer.trace(e)]));
  const reachedBy = new Map<string, Set<string>>();
  for (const f of flows.values())
    for (const r of f.reached) {
      const s = reachedBy.get(r) ?? new Set<string>();
      s.add(f.entry.id);
      reachedBy.set(r, s);
    }
  const reachedByOther = (record: string, self: string) =>
    [...(reachedBy.get(record) ?? [])].some((x) => x !== self);

  const out: FeatureFlows[] = [];
  for (const feature of [...g.capabilities].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const mine = feature.entryPoints.map((id) => flows.get(id)).filter((f): f is Flow => !!f);
    const ends = new Map<string, LooseEnd>();
    const add = (e: LooseEnd) => {
      if (!ends.has(e.record)) ends.set(e.record, e);
    };
    for (const flow of mine) {
      const id = flow.entry.id;
      const i = g.interfaces.get(id);
      if (i) {
        if (!reachedByOther(i.id, id))
          add({
            kind: "unknown-trigger",
            record: i.id,
            text: `nothing Atticus found makes ${i.from} publish ${i.normalizedPath}`,
          });
      } else if (g.endpoints.has(id)) {
        for (const c of g.callers.get(id) ?? []) {
          if (g.isUi(c.from) || reachedByOther(c.id, id)) continue;
          add({
            kind: "unknown-caller",
            record: c.id,
            text: `nothing Atticus found makes ${c.from} call ${c.method ? `${c.method} ` : ""}${c.normalizedPath}`,
          });
        }
      }
      for (const h of flow.hops)
        if (h.confidence === "inferred")
          add({
            kind: "one-end",
            record: h.id,
            text: `only one end of ${h.from} → ${h.to}${h.method ? ` ${h.method}` : ""} ${h.normalizedPath} was seen`,
          });
      for (const v of flow.visits)
        for (const u of g.unresolved.get(v.component) ?? [])
          if (overlaps(v.tokens, tokens(splitWords(u.raw))))
            add({
              kind: "loose-end",
              record: u.id,
              text: `${v.component} has a loose end Atticus couldn't follow (${u.raw})`,
            });
    }
    const first = feature.entryPoints[0];
    const component = first ? entryComponent(g, first) : undefined;
    const system = component ? g.systemOf(component) : undefined;
    out.push({
      feature,
      ...(system ? { system } : {}),
      flows: mine,
      looseEnds: [...ends.values()],
    });
  }
  return out;
}
