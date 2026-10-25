import { isScalar, LineCounter, parseDocument } from "yaml";
import type { z } from "zod";

/**
 * A stage file's schema problems in plain words, each with its file and line (ADR 0111
 * addendum, R2): "target-flows/x.yaml:14: step 3's fields.sends is empty: write a list, such as
 * [orderId], or leave sends out." The line is the node's own, read off the YAML syntax tree;
 * the words come from the schema issue's code and the value written there. A fact, not a guess.
 */

const EXPECTED: Record<string, string> = {
  array: "a list, such as [orderId]",
  string: "some text",
  number: "a number",
  int: "a whole number",
  boolean: "true or false",
  object: "keys and values, such as { table: forge-orders-db.orders }",
};

/** A list's name for one of its items: steps → step, stories → story (B-run2-fixes 9). */
const one = (k: string) =>
  k.endsWith("ies") ? `${k.slice(0, -3)}y` : k.endsWith("s") ? k.slice(0, -1) : k;

/** "steps.2.fields.sends" in words: "step 3's fields.sends"; "stories.0.interfaces.1.entry": "story 1's interface 2's entry". */
export function pathWords(path: readonly PropertyKey[]): string {
  const out: string[] = [];
  let i = 0;
  while (i < path.length) {
    const k = path[i]!;
    const next = path[i + 1];
    if (typeof k === "string" && typeof next === "number") {
      const rest = path.slice(i + 2);
      const item = `${one(k)} ${next + 1}`;
      out.push(rest.length ? `${item}'s ${pathWords(rest)}` : item);
      break;
    }
    out.push(String(k));
    i++;
  }
  return out.join(".") || "the file";
}

/**
 * The issues of the union branch a value was meant for (B-run2-fixes 9): the first whose issues
 * don't say the value itself is of another type, with their paths from the file's root. None
 * when every branch wants another type, which `issueWords` then says.
 */
function unionCause(issue: z.core.$ZodIssue): z.core.$ZodIssue[] | undefined {
  const branches = (issue as { errors?: z.core.$ZodIssue[][] }).errors ?? [];
  const meant = branches.find(
    (b) => b.length > 0 && !b.some((x) => x.path.length === 0 && x.code === "invalid_type"),
  );
  return meant?.map((x) => ({ ...x, path: [...issue.path, ...x.path] }) as z.core.$ZodIssue);
}

const valueAt = (value: unknown, path: readonly PropertyKey[]) => {
  let v = value;
  for (const k of path) v = (v as Record<PropertyKey, unknown> | undefined)?.[k];
  return v;
};

const kindOf = (v: unknown) =>
  v === null || v === undefined
    ? "empty"
    : Array.isArray(v)
      ? "a list"
      : typeof v === "object"
        ? "keys and values"
        : `${typeof v === "string" ? "text" : typeof v} (${JSON.stringify(v)})`;

/** The plain words for one issue, given the value at its path. */
export function issueWords(issue: z.core.$ZodIssue, value: unknown): string {
  const where = pathWords(issue.path);
  const last = issue.path.at(-1);
  if (issue.code === "invalid_type") {
    const want =
      EXPECTED[String((issue as { expected?: string }).expected)] ??
      String((issue as { expected?: string }).expected);
    if (value === undefined) return `${where} is missing: write ${want}.`;
    return `${where} is ${kindOf(value)}: write ${want}${typeof last === "string" && value === null ? `, or leave ${last} out` : ""}.`;
  }
  if (issue.code === "unrecognized_keys")
    return `${where} has ${(issue as { keys: string[] }).keys.join(", ")}, which it doesn't take: take ${(issue as { keys: string[] }).keys.length === 1 ? "it" : "them"} out, or check the spelling.`;
  if (issue.code === "invalid_value") {
    const values = ((issue as { values?: unknown[] }).values ?? []).map(String);
    return `${where} is ${kindOf(value)}: write ${values.length > 1 ? `one of ${values.join(", ")}` : (values[0] ?? "another value")}.`;
  }
  // B-run2-fixes 9: a union's real cause, not "Invalid input": the issues of the branch the
  // value was written for, or, when it fits none, the kinds each branch takes.
  if (issue.code === "invalid_union") {
    const cause = unionCause(issue);
    if (cause)
      return cause
        .map((x) => issueWords(x, valueAt(value, x.path.slice(issue.path.length))))
        .join(" ");
    const wants = ((issue as { errors?: z.core.$ZodIssue[][] }).errors ?? []).flatMap((b) =>
      b
        .filter((x) => x.path.length === 0 && x.code === "invalid_type")
        .map((x) => {
          const e = String((x as { expected?: string }).expected);
          return EXPECTED[e] ?? e;
        }),
    );
    if (wants.length)
      return `${where} is ${kindOf(value)}: write ${[...new Set(wants)].join(", or ")}.`;
  }
  return `${where}: ${issue.message}.`;
}

/**
 * Each schema issue of a YAML file, as "file:line: words". The line is that of the deepest
 * node of the issue's path the file has (the key itself, when the value is empty).
 */
export function schemaProblems(
  file: string,
  text: string,
  issues: readonly z.core.$ZodIssue[],
): string[] {
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc, keepSourceTokens: false });
  const data = doc.toJS() as unknown;
  return issues.map((i) => {
    let line = 1;
    for (let n = i.path.length; n > 0; n--) {
      const node = doc.getIn(i.path.slice(0, n) as (string | number)[], true) as
        { range?: [number, number, number] } | undefined;
      const parentPath = i.path.slice(0, n - 1) as (string | number)[];
      const parent = (n > 1 ? doc.getIn(parentPath, true) : doc.contents) as
        { items?: { key?: unknown; value?: { range?: [number, number, number] } }[] } | undefined;
      // An empty value has no range of its own: take its key's line.
      const pair = parent?.items?.find(
        (p) => isScalar(p.key) && (p.key as { value: unknown }).value === i.path[n - 1],
      ) as { key?: { range?: [number, number, number] } } | undefined;
      const at = node?.range?.[0] ?? pair?.key?.range?.[0];
      if (at !== undefined) {
        line = lc.linePos(at).line;
        break;
      }
    }
    let value: unknown = data;
    for (const k of i.path) value = (value as Record<PropertyKey, unknown> | undefined)?.[k];
    return `${file}:${line}: ${issueWords(i, value)}`;
  });
}
