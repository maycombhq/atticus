import { Fact as FactSchema, FactId, type BadFactLine, type Fact } from "@maycombhq/core";

/**
 * R6: the reader's slips of form, fixed in code rather than refused (ADR 0124 addendum A-read, as
 * R6 amends it). Two slips, both of form and never of claim:
 *
 * - a fact id that isn't a lowercase slug (`postCheck`) is slugged (`post-check`), and every
 *   reference to it (a call's `from`, a store's `under`, a field's `owner` and `mappedTo`, a
 *   flow's `entry` and its steps' `ref`) is rewritten with it. A slug another fact already has,
 *   or two ids that slug to the same one, is a collision: reported, and the lines left as they
 *   were, so the schema still refuses them;
 * - a flow with no `cite` takes its entry's, the line the flow starts on.
 *
 * Only lines the schema refused are touched, and a repaired line is parsed by the same schema
 * again; each repaired fact then goes through `verifyFacts` like any other, so its claim must
 * still be on its cited line. Nothing the verifier checks against the code is loosened.
 */

export type FormSlipCode = "id-slugged" | "ref-rewritten" | "id-collision" | "flow-cite-from-entry";

export interface FormSlip {
  /** The line of the facts file the slip is on. */
  line: number;
  code: FormSlipCode;
  /** The fact's id as kept (the slug), or as written when a collision left it. */
  fact: string;
  message: string;
}

/** A fact id as a lowercase slug: camelCase split at its capitals, other characters as `-`. */
export function slugFactId(id: string): string {
  return id
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-+$/, "")
    .slice(0, 120);
}

const isId = (x: unknown): x is string => typeof x === "string" && FactId.safeParse(x).success;
type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => !!x && typeof x === "object" && !Array.isArray(x);

/** The fields of a fact that name another fact by id. */
const REF_FIELDS = ["from", "under", "owner", "mappedTo", "entry"] as const;

/**
 * The facts with the slips of form among the refused lines fixed: the facts that now read, the
 * lines still refused (a collision among their issues), and every fix and collision said.
 * `onFile` are facts already on file beside these (`atticus map`'s earlier batches): a reference may
 * name one by an id it slugs to, a flow may take the cite of an entry among them, and a line whose
 * id slugs to one of theirs writes that fact again, as the batch loop merges by id. They are not
 * returned.
 */
export function repairFormSlips(
  facts: readonly Fact[],
  bad: readonly BadFactLine[],
  onFile: readonly Fact[] = [],
): { facts: Fact[]; bad: BadFactLine[]; slips: FormSlip[] } {
  const slips: FormSlip[] = [];
  // The lines that are JSON objects and were refused by the schema (not a repeated id).
  const cands = bad.flatMap((b) => {
    if (b.issues.some((i) => i.code === "not-json" || i.code === "duplicate-id")) return [];
    let json: unknown;
    try {
      json = JSON.parse(b.raw);
    } catch {
      return [];
    }
    return isObj(json) ? [{ b, json }] : [];
  });

  // ---- ids: each id that isn't a slug and slugs to one, unless the slug is taken
  const taken = new Map<string, number>();
  for (const f of facts) taken.set(f.id, (taken.get(f.id) ?? 0) + 1);
  for (const { json } of cands)
    if (isId(json.id)) taken.set(json.id, (taken.get(json.id) ?? 0) + 1);
  const wanted = new Map<string, number>();
  for (const { json } of cands)
    if (typeof json.id === "string" && !isId(json.id)) {
      const s = slugFactId(json.id);
      if (isId(s)) wanted.set(s, (wanted.get(s) ?? 0) + 1);
    }
  const known = new Set([...facts, ...onFile].map((f) => f.id));
  const renames = new Map<string, string>();
  const collided = new Map<BadFactLine, string>();
  for (const { b, json } of cands) {
    if (typeof json.id !== "string" || isId(json.id)) continue;
    const s = slugFactId(json.id);
    if (!isId(s)) continue;
    if (taken.has(s) || (wanted.get(s) ?? 0) > 1) {
      const message = `line ${b.line}: fact id ${json.id} would slug to ${s}, which another fact already has; rename one of them`;
      slips.push({ line: b.line, code: "id-collision", fact: json.id, message });
      collided.set(b, message);
      continue;
    }
    renames.set(json.id, s);
  }

  // ---- each refused line with its ids and references rewritten
  const rewritten = cands.map(({ b, json }) => {
    const o = structuredClone(json);
    const fixes: FormSlip[] = [];
    if (typeof o.id === "string" && renames.has(o.id)) {
      fixes.push({
        line: b.line,
        code: "id-slugged",
        fact: renames.get(o.id)!,
        message: `line ${b.line}: fact id ${o.id} slugged to ${renames.get(o.id)!}, and every reference to it`,
      });
      o.id = renames.get(o.id)!;
    }
    // A reference to an id renamed here, or one that slugs to a fact's id (an earlier batch's).
    const ref = (v: unknown) => {
      if (typeof v !== "string") return undefined;
      if (renames.has(v)) return renames.get(v);
      if (isId(v)) return undefined;
      const s = slugFactId(v);
      return known.has(s) ? s : undefined;
    };
    const said = (field: string, from: string, to: string) =>
      fixes.push({
        line: b.line,
        code: "ref-rewritten",
        fact: String(o.id),
        message: `line ${b.line}: ${String(o.id)}'s ${field} ${from} rewritten as ${to}`,
      });
    for (const k of REF_FIELDS) {
      const to = ref(o[k]);
      if (to) {
        said(k, o[k] as string, to);
        o[k] = to;
      }
    }
    if (Array.isArray(o.steps))
      o.steps.forEach((st: unknown, i) => {
        if (!isObj(st)) return;
        const to = ref(st.ref);
        if (to) {
          said(`step ${i + 1} ref`, st.ref as string, to);
          st.ref = to;
        }
      });
    return { b, o, fixes };
  });

  // ---- a flow with no cite: its entry's
  const entries = new Map<string, Obj>();
  for (const f of [...onFile, ...facts])
    if (f.kind === "entry") entries.set(f.id, f as unknown as Obj);
  for (const { o } of rewritten)
    if (o.kind === "entry" && typeof o.id === "string" && isObj(o.cite)) entries.set(o.id, o);
  for (const r of rewritten) {
    const { o, b } = r;
    if (o.kind !== "flow" || o.cite !== undefined || typeof o.entry !== "string") continue;
    const e = entries.get(o.entry);
    if (!e || !isObj(e.cite)) continue;
    o.cite = structuredClone(e.cite);
    const c = e.cite as { file?: unknown; line?: unknown };
    r.fixes.push({
      line: b.line,
      code: "flow-cite-from-entry",
      fact: String(o.id),
      message: `line ${b.line}: flow ${String(o.id)} had no cite; it takes its entry ${o.entry}'s line (${String(c.file)}:${String(c.line)})`,
    });
  }

  // ---- parse again: a line that now reads is a fact; one that doesn't stays as it was
  const kept = [...facts];
  const seen = new Set(facts.map((f) => f.id));
  const fixedLines = new Set<BadFactLine>();
  for (const { b, o, fixes } of rewritten) {
    if (!fixes.length || collided.has(b)) continue;
    const p = FactSchema.safeParse(o);
    if (!p.success || seen.has(p.data.id)) continue;
    seen.add(p.data.id);
    kept.push(p.data);
    fixedLines.add(b);
    slips.push(...fixes);
  }
  const still = bad
    .filter((b) => !fixedLines.has(b))
    .map((b) =>
      collided.has(b)
        ? {
            ...b,
            issues: [
              ...b.issues,
              { line: b.line, code: "id-collision", message: collided.get(b)! },
            ],
          }
        : b,
    );
  slips.sort((x, y) => x.line - y.line);
  return { facts: kept, bad: still, slips };
}
