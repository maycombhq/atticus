import { columnsOf, endpointKey, isKeyPattern, type Estate } from "./estate.js";
import { parseAt, usesOf, type DeltaStep, type FlowDelta } from "./schema.js";

/**
 * Where an added step's code goes (ADR 0124 addendum B-place), shared by the architecture
 * stage's checks and the stories stage. Three kinds of place: `at` (path:line, the code there
 * changes), `new` (a file the change creates) and `uses` (existing code the step calls, which
 * doesn't change). Deterministic, from the step, the catalog's flows and the line's own text.
 */

/** An existing flow's step that does what an added step does, at the line the step names. */
export interface DoneAt {
  /** The existing flow and its step (from 1). */
  flow: string;
  step: number;
  /** repo:path:line of the code that does it. */
  at: string;
}

/**
 * Words that start a statement, not a declaration, though a `(` follows them.
 */
const NOT_DECLARED =
  /^\s*(?:if|for|while|switch|catch|return|throw|new|else|do|try|await|yield|case|super|this)\b/;

/**
 * Whether a line declares a method or function (B-place), in the languages the readers know:
 * `public List<X> name(…) {`, `def name(`, `func name(`, `function name(`, `const name = (…) =>`,
 * `export function Name(`, a class member `name(…): T {`. A call or a statement isn't one.
 */
export function declaresMethod(line: string): boolean {
  const l = line.replace(/\/\/.*$/, "").trim();
  if (!l || NOT_DECLARED.test(l) || /^[@#*/]/.test(l)) return false;
  if (/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\b/.test(l)) return true;
  if (/^(?:async\s+)?def\s+\w+\s*\(/.test(l) || /^func\s/.test(l) || /^fun\s+\w/.test(l))
    return true;
  if (
    /^(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*(?::[^=]+)?=>/.test(
      l,
    )
  )
    return true;
  // Java, C#, Kotlin, TypeScript members: modifiers or a type before the name, and a body or
  // nothing after the parameters (an abstract or interface method), never a `;` call.
  return (
    /^(?:(?:public|private|protected|internal|static|final|abstract|override|virtual|synchronized|async|readonly|open|suspend)\s+)*(?:[\w$<>[\],.?]+\s+)?[\w$]+\s*\([^;]*\)\s*(?::\s*[^={;]+)?(?:throws\s+[\w$.,\s]+)?\s*(?:\{.*)?$/.test(
      l,
    ) && !/=\s*[\w$.]+\s*\(/.test(l)
  );
}

/** The flows of the delta's repo that cite repo:path:line in a step, with that step. */
function stepsAt(e: Estate, repo: string, path: string, line: number) {
  const out: {
    flow: string;
    n: number;
    step: (typeof e.flows)[number]["flow"]["steps"][number];
  }[] = [];
  for (const f of e.flows) {
    if (f.repo !== repo) continue;
    f.flow.steps.forEach((step, k) => {
      if (
        step.evidence.some(
          (x) => (!x.repo || x.repo === repo) && x.path === path && x.line === line,
        )
      )
        out.push({ flow: f.flow.id, n: k + 1, step });
    });
  }
  return out;
}

/**
 * Whether an existing step does what the added step does (B-place): the same kind, and for a
 * call-out or publish the same existing entry, for a read, lookup or write the same existing
 * table with no column the catalog doesn't have (a step that adds a column is never done).
 */
function sameEffect(
  e: Estate,
  s: DeltaStep,
  y: { kind: string; to?: { entry: string }; store?: { table: string } },
): boolean {
  if (!s.kind || y.kind !== s.kind) return false;
  if (s.kind === "call-out" || s.kind === "publish")
    return !!s.to && !s.to.new && !!y.to && endpointKey(y.to.entry) === endpointKey(s.to.entry);
  if (s.kind === "read" || s.kind === "lookup" || s.kind === "write") {
    if (!s.store || s.store.new || y.store?.table !== s.store.table) return false;
    if (isKeyPattern(e, s.store.table)) return true;
    const have = columnsOf(e, s.store.table);
    return s.store.columns.every((c) => have.has(c));
  }
  return true;
}

/**
 * The existing code that already does an added step (B-place): the step names a line by `uses`
 * (or, in an older answer, `at`), and a flow of its repo cites that very line in a step with the
 * same effect. Never the delta's own flow: today's code of a flow it changes isn't done twice.
 */
export function doneAt(d: FlowDelta, s: DeltaStep, e: Estate): DoneAt | undefined {
  if (s.op !== "add") return undefined;
  for (const place of [...usesOf(s), ...(s.at ? [s.at] : [])]) {
    const p = parseAt(place);
    if (!p?.line) continue;
    for (const x of stepsAt(e, d.repo, p.path, p.line))
      if (x.flow !== d.flow && sameEffect(e, s, x.step))
        return { flow: x.flow, step: x.n, at: `${d.repo}:${p.path}:${p.line}` };
  }
  return undefined;
}

/**
 * The existing step whose code an `at` line is, of another flow, doing a call or a read (B-place):
 * the step there only calls it. Undefined when no flow cites the line, or only the delta's own.
 */
export function callsAt(
  d: FlowDelta,
  path: string,
  line: number,
  e: Estate,
): { flow: string; step: number; kind: string } | undefined {
  const x = stepsAt(e, d.repo, path, line).find(
    (y) =>
      y.flow !== d.flow && ["call-out", "publish", "read", "lookup", "write"].includes(y.step.kind),
  );
  return x ? { flow: x.flow, step: x.n, kind: x.step.kind } : undefined;
}

/** Whether today's flow of a delta cites a file (its trigger, steps or error paths). */
export function flowCitesFile(d: FlowDelta, path: string, e: Estate): boolean {
  const f = e.flowById.get(d.flow);
  if (!f) return false;
  const all = [
    ...f.flow.trigger.evidence,
    ...f.flow.steps.flatMap((s) => s.evidence),
    ...(f.flow.errors ?? []).flatMap((x) => x.evidence),
  ];
  return all.some((x) => (!x.repo || x.repo === d.repo) && x.path === path);
}
