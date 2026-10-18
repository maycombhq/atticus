import { isDeepStrictEqual } from "node:util";
import type { Grade, GraderKind } from "./types.js";

/**
 * Graders. All deterministic: the same outcome always gets the same grade. "AI-graded" in
 * this harness means the outcome depends on a model's answer (so live runs vary and the
 * 4-of-5 bar applies), not that a model does the grading.
 */

export interface Item {
  name: string;
  ok: boolean;
  note?: string;
}

/** A grade from item results: passes when the share that passed reaches the threshold. */
export function fromItems(grader: string, kind: GraderKind, items: Item[], threshold = 1): Grade {
  const passed = items.filter((i) => i.ok).length;
  const score = items.length ? passed / items.length : 1;
  return {
    grader,
    kind,
    pass: score >= threshold,
    score,
    notes: items.filter((i) => !i.ok).map((i) => (i.note ? `${i.name}: ${i.note}` : i.name)),
  };
}

/** Exact: deep equality with the hand-written expectation. */
export function exact(grader: string, actual: unknown, expected: unknown): Grade {
  const ok = isDeepStrictEqual(actual, expected);
  return {
    grader,
    kind: "exact",
    pass: ok,
    score: ok ? 1 : 0,
    notes: ok ? [] : [`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`],
  };
}

/** Structural recall: every expected item is in the output. */
export function covers(
  grader: string,
  actual: readonly string[],
  expected: readonly string[],
): Grade {
  return fromItems(
    grader,
    "structural",
    expected.map((e) => ({ name: e, ok: actual.includes(e), note: "missing" })),
  );
}

/** Structural precision: nothing in the output outside what is allowed. */
export function within(
  grader: string,
  actual: readonly string[],
  allowed: readonly string[],
): Grade {
  const items = actual.map((a) => ({ name: a, ok: allowed.includes(a), note: "not expected" }));
  return fromItems(grader, "structural", items.length ? items : [{ name: "nothing", ok: true }]);
}

/** A count within bounds. */
export function count(grader: string, n: number, o: { min?: number; max?: number }): Grade {
  const ok = (o.min === undefined || n >= o.min) && (o.max === undefined || n <= o.max);
  return {
    grader,
    kind: "structural",
    pass: ok,
    score: ok ? 1 : 0,
    notes: ok ? [] : [`${n} is outside ${o.min ?? "-"}..${o.max ?? "-"}`],
  };
}

export interface RubricCheck<T> {
  name: string;
  test: (item: T) => boolean | string;
}

/** Rubric: named checks on every item; a string result is a failure with that note. */
export function rubric<T>(
  grader: string,
  items: readonly T[],
  label: (item: T) => string,
  checks: RubricCheck<T>[],
  threshold = 1,
): Grade {
  const out: Item[] = [];
  for (const it of items)
    for (const c of checks) {
      const r = c.test(it);
      out.push({
        name: `${label(it)} ${c.name}`,
        ok: r === true,
        ...(typeof r === "string" ? { note: r } : {}),
      });
    }
  return fromItems(
    grader,
    "rubric",
    out.length ? out : [{ name: "no items", ok: true }],
    threshold,
  );
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** Evidence: every quote is on the line it cites (or, without a line, anywhere in the file). */
export function quotesExist(
  grader: string,
  evidence: readonly { path: string; line?: number; quote?: string }[],
  lines: (path: string) => string[] | undefined,
): Grade {
  const items: Item[] = evidence
    .filter((e) => e.quote)
    .map((e) => {
      const ls = lines(e.path);
      const q = norm(e.quote!);
      const ok =
        !!ls &&
        (e.line ? norm(ls[e.line - 1] ?? "").includes(q) : ls.some((l) => norm(l).includes(q)));
      return {
        name: `${e.path}${e.line ? `:${e.line}` : ""} "${e.quote}"`,
        ok,
        note: "the quote isn't there",
      };
    });
  return fromItems(grader, "evidence", items.length ? items : [{ name: "no quotes", ok: true }]);
}

/** Evidence: every id an item cites is one it was given for that item. */
export function citesWithin(
  grader: string,
  items: readonly { id: string; evidence: readonly string[] }[],
  allowed: (id: string) => ReadonlySet<string>,
): Grade {
  const out: Item[] = items.flatMap((it) =>
    it.evidence.length
      ? it.evidence.map((e) => ({
          name: `${it.id} cites ${e}`,
          ok: allowed(it.id).has(e),
          note: "not in its input",
        }))
      : [{ name: `${it.id}`, ok: false, note: "cites nothing" }],
  );
  return fromItems(grader, "evidence", out.length ? out : [{ name: "no items", ok: true }]);
}

/** A case passes when every grade passes. */
export const allPass = (grades: readonly Grade[]) =>
  grades.length > 0 && grades.every((g) => g.pass);
