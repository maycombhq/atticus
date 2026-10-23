import type { SourceInput } from "@maycombhq/ai";
import type { ContextInput, GraphNodeRow } from "@maycombhq/index";
import {
  oneSource,
  reportOf,
  roomFor,
  selectFor,
  sourceTokens,
  useEngine,
  type ContextOptions,
  type ContextReport,
  type ContextStep,
} from "../engine.js";
import { gapContext } from "../gaps.js";
import { ESTATE_HEADING, ESTATE_KINDS, estateLine, type Estate } from "./estate.js";

/**
 * The estate a stage sends, selected by the context engine (ADR 0107): the records and flows
 * the stage's input names or leads to, in the compact index's own lines, and, for the
 * architecture stage, the knowledge items (patterns, standards, decisions) that apply. A flow
 * in full is its steps; in one line its id, repo, component and name.
 */

export interface EstateContext {
  sources: SourceInput[];
  report: ContextReport;
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
  },
): Promise<EstateContext | { note: string } | undefined> {
  if (!useEngine(step, o.context)) return undefined;
  const room = roomFor(o.budget, o.others, o.context);
  const e = o.estate;
  const kinds = [...(e ? ESTATE_KINDS : []), ...(o.knowledge?.kinds ?? [])];
  const render = (n: GraphNodeRow, level: "full" | "line"): string | undefined => {
    if (o.knowledge?.kinds.includes(n.kind)) return o.knowledge.line(n.id);
    if (!e) return undefined;
    if (n.kind === "Flow" && level === "line") {
      const f = e.flowById.get(n.id);
      return f
        ? `flow ${f.flow.id} (repo ${f.repo}, component ${f.flow.component}) "${f.flow.name}"`
        : undefined;
    }
    return estateLine(e, n.kind, n.id);
  };
  const select = (budget: number) =>
    selectFor(root, input, {
      budget,
      kinds,
      groups: [...(e ? ["catalog", "flow"] : []), ...(o.knowledge ? ["knowledge"] : [])],
      exclude: o.exclude ?? [],
      render: (n, level) => render(n, level) ?? `${n.kind} ${n.id}`,
    });
  let got = await select(room);
  if (!got.selection) return got.note ? { note: got.note } : undefined;
  // What neither the wikis nor the repos say (ADR 0107 point 5): listed, never guessed. The gaps
  // and the answers people gave take their room from the selection, not from the step's input.
  const g = o.change ? await gapContext(root, o.change, got.selection.unknown) : undefined;
  const less = g ? sourceTokens(g.sources) : 0;
  if (less) got = await select(Math.max(0, room - less));
  if (!got.selection) return got.note ? { note: got.note } : undefined;
  const s = got.selection;
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
  const report = reportOf(s, room);
  if (g) {
    report.gaps = g.gaps;
    sources.push(...g.sources);
  }
  return { sources, report };
}
