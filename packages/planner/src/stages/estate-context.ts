import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SourceInput } from "@maycombhq/ai";
import { changeFolder } from "@maycombhq/changes";
import type { RunRetrieval, RunSummary } from "@maycombhq/core";
import type { ContextInput, GraphNodeRow, SelectOptions } from "@maycombhq/index";
import {
  oneSource,
  reportOf,
  retrieve,
  roomFor,
  selectFor,
  sourceTokens,
  useEngine,
  type ContextOptions,
  type ContextReport,
  type ContextStep,
  type RetrievalAi,
} from "../engine.js";
import { gapContext } from "../gaps.js";
import { briefEndpointsSource } from "./brief-endpoints.js";
import { ESTATE_HEADING, ESTATE_KINDS, estateLine, flowSummary, type Estate } from "./estate.js";

/**
 * The estate a stage sends, selected by the context engine (ADR 0107): the records and flows
 * the stage's input names or leads to, in the compact index's own lines, and, for the
 * architecture stage, the knowledge items (patterns, standards, decisions) that apply. A flow
 * in full is its steps; in one line its id, repo, component and name.
 */

export interface EstateContext {
  sources: SourceInput[];
  report: ContextReport;
  /** How the context was retrieved, for the step's run record (ADR 0116). */
  retrieval?: RunRetrieval;
  /** Whether the run the step was resumed with was the expansion's or the rerank's. */
  consumed?: boolean;
}

export interface KnowledgeLines {
  /** The kinds of item to select (Pattern, Decision, ProcessDefinition). */
  kinds: string[];
  /** An item as the stage writes it, by id; undefined: not an item the stage may name. */
  line: (id: string) => string | undefined;
  id: string;
  origin: string;
  heading?: string;
  priority: number;
  empty?: string;
}

/** Undefined when the stage should send the whole lists (the option says so, or no index). */
export async function estateContext(
  root: string,
  step: ContextStep,
  input: ContextInput,
  o: {
    estate?: Estate;
    budget: number;
    others: SourceInput[];
    context?: ContextOptions;
    exclude?: string[];
    origin: string;
    priority: number;
    knowledge?: KnowledgeLines;
    /** The change: its gaps are found in its files, and its answered gaps go in the pack. */
    change?: string;
    /** The step's model, for the expansion and rerank (ADR 0116), when they are on. */
    ai?: RetrievalAi;
  },
): Promise<
  | EstateContext
  | { note: string; consumed?: boolean }
  | { waiting: { runId: string }; summary: RunSummary }
  | undefined
> {
  if (!useEngine(step, o.context)) return undefined;
  const room = roomFor(o.budget, o.others, o.context);
  const e = o.estate;
  const kinds = [...(e ? ESTATE_KINDS : []), ...(o.knowledge?.kinds ?? [])];
  const render = (n: GraphNodeRow, level: "full" | "line"): string | undefined => {
    if (o.knowledge?.kinds.includes(n.kind)) return o.knowledge.line(n.id);
    if (!e) return undefined;
    if (n.kind === "Flow" && level === "line") {
      // A flow in one line still names its trigger entry (W5): the endpoint that starts it.
      const f = e.flowById.get(n.id);
      return f ? flowSummary(f, e) : undefined;
    }
    return estateLine(e, n.kind, n.id);
  };
  const selectAt = (budget: number) => (inp: ContextInput, order?: SelectOptions["order"]) =>
    selectFor(root, inp, {
      budget,
      ...(order ? { order } : {}),
      kinds,
      groups: [...(e ? ["catalog", "flow"] : []), ...(o.knowledge ? ["knowledge"] : [])],
      exclude: o.exclude ?? [],
      render: (n, level) => render(n, level) ?? `${n.kind} ${n.id}`,
    });
  // ADR 0116: the model's expansion (and, at the final room, its rerank) where they are on; either
  // may be a hand-off the step waits on. The first selection finds the gaps; the expansion is
  // kept, so the second asks the model nothing new about it.
  const first = await retrieve(
    root,
    o.change ?? "",
    input,
    selectAt(room),
    { ...o.context, rerank: false },
    o.ai,
  );
  if ("waiting" in first) return first;
  if (!first.selection)
    return first.note ? { note: first.note, consumed: first.consumed } : undefined;
  // What neither the wikis nor the repos say (ADR 0107 point 5): listed, never guessed. The gaps
  // and the answers people gave take their room from the selection, not from the step's input.
  const g = o.change
    ? await gapContext(root, o.change, first.selection.unknown, e ? { records: e.records } : {})
    : undefined;
  const less = g ? sourceTokens(g.sources) : 0;
  const final = await retrieve(
    root,
    o.change ?? "",
    first.input,
    selectAt(Math.max(0, room - less)),
    { ...o.context, expand: false },
    o.ai && { ...o.ai, ...(first.consumed ? { resume: undefined } : {}) },
  );
  if ("waiting" in final) return final;
  if (first.retrieval.expansion) final.retrieval.expansion = first.retrieval.expansion;
  const consumed = first.consumed || final.consumed;
  if (!final.selection) return final.note ? { note: final.note, consumed } : undefined;
  const s = final.selection;
  const sources: SourceInput[] = [];
  const isKnowledge = (k: string) => !!o.knowledge?.kinds.includes(k);
  if (e)
    sources.push(
      oneSource(s, {
        id: "estate-index",
        kind: "catalog",
        origin: o.origin,
        heading: ESTATE_HEADING,
        priority: o.priority,
        only: (p) => !isKnowledge(p.kind),
        empty: "Nothing in the estate matches the input.",
      }),
    );
  if (o.knowledge && (s.picked.some((p) => isKnowledge(p.kind)) || o.knowledge.empty))
    sources.push(
      oneSource(s, {
        id: o.knowledge.id,
        kind: "document",
        origin: o.knowledge.origin,
        ...(o.knowledge.heading ? { heading: o.knowledge.heading } : {}),
        priority: o.knowledge.priority,
        only: (p) => isKnowledge(p.kind),
        ...(o.knowledge.empty ? { empty: o.knowledge.empty } : {}),
      }),
    );
  // The endpoints the change's brief names, each with the flow it starts (W5): a fact the
  // drafter maps the brief's endpoint to its flow by.
  if (e && o.change) {
    const brief = await readFile(join(changeFolder(root, o.change), "brief.md"), "utf8").catch(
      () => "",
    );
    sources.push(...briefEndpointsSource(brief, e));
  }
  const report = reportOf(s, room);
  if (g) {
    report.gaps = g.gaps;
    if (g.inCode.length) report.inCode = g.inCode;
    if (g.known.length) report.known = g.known;
    if (g.gaps.length || g.inCode.length) report.searched = g.searched;
    sources.push(...g.sources);
  }
  if (final.retrieval.expansion || final.retrieval.rerank) report.retrieval = final.retrieval;
  // The first round's note too: an expansion that was left out says why (ADR 0116 addendum).
  const notes = [...new Set([first.note, final.note].filter((n): n is string => !!n))];
  if (notes.length) report.note = notes.join("; ");
  return { sources, report, retrieval: final.retrieval, consumed };
}
