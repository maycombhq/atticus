import { parse } from "yaml";
import { z } from "zod";
import type { Fact } from "@maycombhq/core";
import { writesField } from "@maycombhq/planner";
import { entryKey, type BenchReference } from "./bench.js";

/**
 * The stories bench (Phase B's first ticket, bench/stories/): a professional user story as data,
 * the reference stories a person wrote by reading the code, and a deterministic score of a
 * drafted story against its reference: changed-step coverage, field coverage, error-case
 * coverage, invented fields (must be none) and the rubric's sections (bench/stories/rubric.md).
 *
 * The statement reuses the planner's story wording (asA, iWant, soThat, ADR 0087) and a
 * criterion's fields are the fields its then clause checks, as the planner's criteria say with
 * `checks` (ADR 0117); a field written in a then clause counts the way the planner's
 * `writesField` counts it. The planner's stories answer has no scope, interfaces, data or
 * non-functional sections, so a story here is its own schema rather than an extension of it.
 */

const At = z.string().regex(/^[^\s:]+:\d+$/, "at must be path:line");
const Text = z.string().trim().min(1);
const Id = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "ids are lowercase slugs");

export const ERROR_RULES = [
  "required",
  "format",
  "length",
  "range",
  "limit",
  "unique",
  "not-found",
  "forbidden",
  "conflict",
  "unavailable",
  "other",
] as const;

const StoryStep = z.strictObject({
  id: Id,
  repo: Text,
  what: Text,
  /** The entry or screen the step changes, as bench references write it: `[type] [METHOD] path`. */
  entry: Text.optional(),
  /** Where today's code is: the file and line the step changes. */
  at: At.optional(),
});

const ErrorCase = z.strictObject({
  /** The field the error is about; left out for an error about the whole request. */
  field: Text.optional(),
  rule: z.enum(ERROR_RULES),
  /** An HTTP status, or a gRPC code. */
  status: z.union([z.number().int(), Text]).optional(),
  when: Text,
  then: Text,
  at: At.optional(),
});

const Criterion = z.strictObject({
  id: Id,
  /** The changed step the criterion accepts. */
  step: Id,
  given: Text,
  when: Text,
  then: Text,
  entry: Text.optional(),
  /** The fields the then clause checks (the planner's `checks`). */
  fields: z.array(Text).default([]),
  validation: Text.optional(),
  errors: z.array(ErrorCase).default([]),
  at: At.optional(),
});

const InterfaceField = z.strictObject({
  name: Text,
  side: z.enum(["request", "response", "message"]),
  type: Text,
  required: z.boolean(),
  default: Text.optional(),
  change: z.enum(["added", "changed", "removed"]),
});

const InterfaceChange = z.strictObject({
  repo: Text,
  entry: Text,
  change: z.enum(["added", "changed", "removed"]),
  breaking: z.boolean(),
  why: Text.optional(),
  fields: z.array(InterfaceField).default([]),
  at: At.optional(),
});

const DataChange = z.strictObject({
  repo: Text,
  store: Text.optional(),
  table: Text,
  column: Text,
  type: Text,
  nullable: z.boolean(),
  default: Text.optional(),
  change: z.enum(["added", "changed", "removed"]),
  migration: Text,
  classification: Text,
  retention: Text,
  at: At.optional(),
});

/** A section that has nothing in it on purpose, and says why. */
const None = z.strictObject({ none: Text });

export const BenchStory = z.strictObject({
  schemaVersion: z.literal(1),
  /** The reference story's id; a draft names the story it answers. */
  story: Id,
  title: Text,
  repos: z.array(Text).min(1),
  statement: z.strictObject({ asA: Text, iWant: Text, soThat: Text }).optional(),
  context: Text.optional(),
  scope: z
    .strictObject({ in: z.array(Text).default([]), out: z.array(Text).default([]) })
    .optional(),
  steps: z.array(StoryStep).default([]),
  criteria: z.array(Criterion).default([]),
  interfaces: z.union([z.array(InterfaceChange), None]).optional(),
  data: z.union([z.array(DataChange), None]).optional(),
  nonFunctional: z
    .strictObject({
      auth: Text.optional(),
      audit: Text.optional(),
      /** Timeouts and retries. */
      timeouts: Text.optional(),
      performance: Text.optional(),
    })
    .optional(),
  tests: z.array(Text).optional(),
  dependencies: z.array(Text).optional(),
  definitionOfDone: z.array(Text).optional(),
  /** Reference only: other names a draft may give a field (a new field's name is a choice). */
  accepts: z.record(Text, z.array(Text)).optional(),
  notes: Text.optional(),
});
export type BenchStory = z.infer<typeof BenchStory>;

/** The rubric's sections (bench/stories/rubric.md), in its order. */
export const RUBRIC_SECTIONS = [
  "statement",
  "context",
  "scope.in",
  "scope.out",
  "steps",
  "criteria",
  "criteria.per-step",
  "criteria.errors",
  "interfaces",
  "data",
  "nonFunctional.auth",
  "nonFunctional.audit",
  "nonFunctional.timeouts",
  "nonFunctional.performance",
  "tests",
  "dependencies",
  "definitionOfDone",
] as const;

function issuesOf(e: z.ZodError): string {
  return e.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

/** A drafted story: every section optional, so a missing one is scored, not refused. */
export function parseDraftStory(text: string): BenchStory {
  const r = BenchStory.safeParse(parse(text));
  if (!r.success) throw new Error(issuesOf(r.error));
  return r.data;
}

/**
 * A reference story: every rubric section present, every step, criterion and error case cited,
 * every criterion on a step of the story and every step accepted by a criterion.
 */
export function parseReferenceStory(text: string): BenchStory {
  const r = BenchStory.superRefine((s, ctx) => {
    const add = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: "custom", path, message });
    s.steps.forEach((x, i) => {
      if (!x.at) add(["steps", i, "at"], "a reference step cites today's code");
      if (!s.criteria.some((c) => c.step === x.id))
        add(["steps", i], `step ${x.id} has no criterion`);
    });
    s.criteria.forEach((c, i) => {
      if (!c.at) add(["criteria", i, "at"], "a reference criterion cites today's code");
      if (!s.steps.some((x) => x.id === c.step))
        add(["criteria", i, "step"], `${c.step} is no step of the story`);
      c.errors.forEach((e, j) => {
        if (!e.at) add(["criteria", i, "errors", j, "at"], "a reference error case is cited");
      });
    });
    const missing = sectionsOf(s).missing;
    if (missing.length) add([], `a reference story has every section: ${missing.join(", ")}`);
  }).safeParse(parse(text));
  if (!r.success) throw new Error(issuesOf(r.error));
  return r.data;
}

/** Field names as compared: lower case, underscores and hyphens left out (the planner's way). */
const fold = (n: string) => n.toLowerCase().replace(/[_-]/g, "");

/** The fields a story names where a field is meant: criteria, interface fields, data columns. */
function namedFields(s: BenchStory): string[] {
  return [
    ...s.criteria.flatMap((c) => c.fields),
    ...(Array.isArray(s.interfaces)
      ? s.interfaces.flatMap((i) => i.fields.map((f) => f.name))
      : []),
    ...(Array.isArray(s.data) ? s.data.map((d) => d.column) : []),
  ];
}

const present = (x: string | undefined) => x !== undefined && x.trim() !== "";
const listed = (x: readonly unknown[] | undefined) => x !== undefined && x.length > 0;
const sectionOrNone = (x: unknown[] | { none: string } | undefined) =>
  x !== undefined && (Array.isArray(x) ? x.length > 0 : present(x.none));

function sectionsOf(s: BenchStory): { present: number; total: number; missing: string[] } {
  const has: Record<(typeof RUBRIC_SECTIONS)[number], boolean> = {
    statement: s.statement !== undefined,
    context: present(s.context),
    "scope.in": listed(s.scope?.in),
    "scope.out": listed(s.scope?.out),
    steps: listed(s.steps),
    criteria: listed(s.criteria),
    "criteria.per-step":
      listed(s.steps) && s.steps.every((x) => s.criteria.some((c) => c.step === x.id)),
    "criteria.errors": s.criteria.some((c) => c.errors.length > 0),
    interfaces: sectionOrNone(s.interfaces),
    data: sectionOrNone(s.data),
    "nonFunctional.auth": present(s.nonFunctional?.auth),
    "nonFunctional.audit": present(s.nonFunctional?.audit),
    "nonFunctional.timeouts": present(s.nonFunctional?.timeouts),
    "nonFunctional.performance": present(s.nonFunctional?.performance),
    tests: listed(s.tests),
    dependencies: listed(s.dependencies),
    definitionOfDone: listed(s.definitionOfDone),
  };
  const missing = RUBRIC_SECTIONS.filter((k) => !has[k]);
  return {
    present: RUBRIC_SECTIONS.length - missing.length,
    total: RUBRIC_SECTIONS.length,
    missing,
  };
}

const fileOf = (at: string | undefined) => at?.replace(/:\d+$/, "");
const lineOf = (at: string | undefined) => Number(at?.split(":").pop() ?? 0);

/**
 * Draft steps matched one to one to reference steps: in the same repo, the same file (the
 * nearest line first), or failing that the same entry. A draft step that lumps two changes
 * together is credited with one.
 */
function matchSteps(ref: BenchStory, draft: BenchStory): Map<string, string> {
  const pairs: { r: number; d: number; dist: number }[] = [];
  ref.steps.forEach((rs, r) =>
    draft.steps.forEach((ds, d) => {
      if (rs.repo !== ds.repo) return;
      if (rs.at && ds.at && fileOf(rs.at) === fileOf(ds.at))
        pairs.push({ r, d, dist: Math.abs(lineOf(rs.at) - lineOf(ds.at)) });
      else if (rs.entry && ds.entry && entryKey(rs.entry) === entryKey(ds.entry))
        pairs.push({ r, d, dist: 1_000_000 });
    }),
  );
  pairs.sort((a, b) => a.dist - b.dist || a.r - b.r || a.d - b.d);
  const byDraft = new Map<string, string>();
  const usedRef = new Set<number>();
  for (const p of pairs) {
    const d = draft.steps[p.d]!.id;
    if (usedRef.has(p.r) || byDraft.has(d)) continue;
    usedRef.add(p.r);
    byDraft.set(d, ref.steps[p.r]!.id);
  }
  return byDraft;
}

export interface StoryScore {
  story: string;
  /** Reference steps the draft changes too; extra: draft steps that match none. */
  steps: { found: number; total: number; missed: string[]; extra: string[]; coverage: number };
  /** Reference fields the draft names (in a criterion, an interface, a column, or a then clause). */
  fields: { found: number; total: number; missed: string[]; coverage: number };
  /**
   * Reference error cases (step, field, rule) the draft has on the matching step (strict). One
   * with no field (not found, forbidden, unavailable) is matched by the step, the rule and a word
   * its `when` shares with the draft's, whatever field the draft names (B-run2-fixes 4).
   */
  errors: { found: number; total: number; missed: string[]; coverage: number };
  /**
   * The same error cases matched by entry (B-fixes): found on the matching step, or on any
   * draft step of the same repo and entry with the same field and rule. A reference step that
   * names no entry is matched by step alone. Beside the strict figure, never instead of it.
   */
  errorsByEntry: { found: number; total: number; missed: string[]; coverage: number };
  /** Fields the draft names that neither the reference nor the repos' facts know. Must be none. */
  invented: string[];
  sections: { present: number; total: number; missing: string[] };
}

const ratio = (a: number, b: number) => (b === 0 ? 1 : a / b);

/** Words a `when` is made of that say nothing on their own. */
const PLAIN = new Set(
  "the a an no not any is are was has have had with without of to in on for from and or it its when given then that this there be by at as do does doesn't isn't can can't".split(
    " ",
  ),
);
const whenWords = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9']+/)
      .filter((w) => w.length > 2 && !PLAIN.has(w))
      .map((w) => w.replace(/'s$/, "").replace(/s$/, "")),
  );
/** Whether two error cases' `when` share a word that says something (B-run2-fixes 4). */
function sameWhen(a: string, b: string): boolean {
  const x = whenWords(a);
  return [...whenWords(b)].some((w) => x.has(w));
}

/**
 * Score a drafted story against its reference. `known` is every other field name the repos are
 * known to have (the bench references' fields, the facts' fields); a field the draft names that
 * is in none of them, nor in the reference story, is invented.
 */
export function scoreStory(
  ref: BenchStory,
  draft: BenchStory,
  known: Iterable<string> = [],
): StoryScore {
  if (draft.story !== ref.story)
    throw new Error(`The draft is of story ${draft.story}; the reference is ${ref.story}.`);

  // ---- steps
  const matched = matchSteps(ref, draft);
  const hitRefs = new Set(matched.values());
  const missedSteps = ref.steps.filter((s) => !hitRefs.has(s.id)).map((s) => s.id);
  const extra = draft.steps.filter((s) => !matched.has(s.id)).map((s) => s.id);

  // ---- fields: a draft name counts as the reference field it folds to, or is an alias of
  const alias = new Map<string, string>();
  const refFields = new Map<string, string>();
  for (const n of namedFields(ref)) if (!refFields.has(fold(n))) refFields.set(fold(n), n);
  for (const [name, others] of Object.entries(ref.accepts ?? {}))
    for (const o of others) alias.set(fold(o), fold(name));
  const canon = (n: string) => alias.get(fold(n)) ?? fold(n);
  const drafted = new Set(namedFields(draft).map(canon));
  const written = (f: string) =>
    draft.criteria.some((c) => writesField(`then ${c.then}`, refFields.get(f)!));
  const fieldMissed = [...refFields.keys()].filter((f) => !drafted.has(f) && !written(f));

  // ---- errors: (reference step, field, rule), each counted once
  const key = (step: string, e: { field?: string | undefined; rule: string }) =>
    `${step}: ${e.field ? (refFields.get(canon(e.field)) ?? e.field) : "(no field)"} ${e.rule}`;
  const wantErrors = new Set(ref.criteria.flatMap((c) => c.errors.map((e) => key(c.step, e))));
  const gotErrors = new Set(
    draft.criteria.flatMap((c) => {
      const step = matched.get(c.step);
      return step ? c.errors.map((e) => key(step, e)) : [];
    }),
  );
  // B-run2-fixes 4: a reference error about the whole request (no field: not found, forbidden,
  // unavailable) is matched by a draft error on the same step with the same rule whose `when`
  // says the same thing, whatever field the draft keys it on (an id field, often).
  const noField = ref.criteria.flatMap((c) =>
    c.errors.filter((e) => !e.field).map((e) => ({ c, e, k: key(c.step, e) })),
  );
  for (const c of draft.criteria) {
    const step = matched.get(c.step);
    if (!step) continue;
    for (const e of c.errors)
      for (const r of noField)
        if (r.c.step === step && r.e.rule === e.rule && sameWhen(r.e.when, e.when))
          gotErrors.add(r.k);
  }
  const errorsMissed = [...wantErrors].filter((k) => !gotErrors.has(k));

  // ---- errors by entry: (repo, entry, field, rule) on any draft step of that entry
  const entryOf = (x: { entry?: string | undefined }, c: { entry?: string | undefined }) => {
    const e = c.entry ?? x.entry;
    return e ? entryKey(e) : undefined;
  };
  const what = (e: { field?: string | undefined; rule: string }) =>
    `${e.field ? (refFields.get(canon(e.field)) ?? e.field) : "(no field)"} ${e.rule}`;
  const draftByEntry = new Set(
    draft.criteria.flatMap((c) => {
      const st = draft.steps.find((x) => x.id === c.step);
      const at = st ? entryOf(st, c) : c.entry ? entryKey(c.entry) : undefined;
      return st && at ? c.errors.map((e) => `${st.repo}|${at}|${what(e)}`) : [];
    }),
  );
  const refByEntry = new Map<string, string>(); // strict key -> entry key
  for (const c of ref.criteria) {
    const st = ref.steps.find((x) => x.id === c.step);
    const at = st ? entryOf(st, c) : undefined;
    if (st && at)
      for (const e of c.errors) refByEntry.set(key(c.step, e), `${st.repo}|${at}|${what(e)}`);
  }
  // B-run2-fixes 4: a no-field reference error on any draft step of its entry, by rule and `when`.
  const draftWhens = draft.criteria.flatMap((c) => {
    const st = draft.steps.find((x) => x.id === c.step);
    const at = st ? entryOf(st, c) : c.entry ? entryKey(c.entry) : undefined;
    return st && at
      ? c.errors.map((e) => ({ at: `${st.repo}|${at}`, rule: e.rule, when: e.when }))
      : [];
  });
  const noFieldByEntry = (k: string) => {
    const r = noField.find((x) => x.k === k);
    const at = refByEntry.get(k);
    return (
      !!r &&
      !!at &&
      draftWhens.some(
        (d) => at.startsWith(`${d.at}|`) && d.rule === r.e.rule && sameWhen(r.e.when, d.when),
      )
    );
  };
  const byEntryMissed = errorsMissed.filter((k) => {
    const at = refByEntry.get(k);
    return !at || (!draftByEntry.has(at) && !noFieldByEntry(k));
  });

  // ---- invented
  const knownFolded = new Set([...refFields.keys(), ...alias.keys(), ...[...known].map(fold)]);
  const isKnown = (n: string) =>
    knownFolded.has(fold(n)) || knownFolded.has(fold(n.split(".").pop()!));
  const invented = [...new Set(namedFields(draft).filter((n) => !isKnown(n)))].sort();

  return {
    story: ref.story,
    steps: {
      found: ref.steps.length - missedSteps.length,
      total: ref.steps.length,
      missed: missedSteps,
      extra,
      coverage: ratio(ref.steps.length - missedSteps.length, ref.steps.length),
    },
    fields: {
      found: refFields.size - fieldMissed.length,
      total: refFields.size,
      missed: fieldMissed.map((f) => refFields.get(f)!).sort(),
      coverage: ratio(refFields.size - fieldMissed.length, refFields.size),
    },
    errors: {
      found: wantErrors.size - errorsMissed.length,
      total: wantErrors.size,
      missed: errorsMissed,
      coverage: ratio(wantErrors.size - errorsMissed.length, wantErrors.size),
    },
    errorsByEntry: {
      found: wantErrors.size - byEntryMissed.length,
      total: wantErrors.size,
      missed: byEntryMissed,
      coverage: ratio(wantErrors.size - byEntryMissed.length, wantErrors.size),
    },
    invented,
    sections: sectionsOf(draft),
  };
}

/** The field names bench references know (fields and columns of entries, calls and tables). */
export function benchKnownFields(refs: readonly BenchReference[]): string[] {
  return [...new Set(refs.flatMap((r) => (r.fields ?? []).map((f) => f.name)))].sort();
}

/** The field names a facts file knows. */
export function factFieldNames(facts: readonly Fact[]): string[] {
  return [...new Set(facts.flatMap((f) => (f.kind === "field" ? [f.name] : [])))].sort();
}
