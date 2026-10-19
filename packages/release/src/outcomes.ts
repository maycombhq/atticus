import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { ChangeOutcomes, toCanonicalYaml, type OutcomeValue } from "@maycombhq/core";
import { docOf, sectionLines } from "@maycombhq/naysayer";
import type { ReleaseContext } from "./context.js";
import { ReleaseError } from "./errors.js";
import { sentences } from "./model.js";

/**
 * Outcome tracking (ADR 0045): the brief's success measures become outcome records a person
 * updates after release. The measures are read from brief.md on every view; the values people
 * record are kept in the change folder at review/outcomes.yaml, each with who and when.
 */

export const OUTCOMES_FILE = "review/outcomes.yaml";

/** States in which a change has been released, so its outcomes can be measured. */
export const MEASURABLE = new Set(["released", "post-release-review", "archived"]);

export interface Measure {
  id: string;
  /** 1-based, in the brief's order. */
  n: number;
  measure: string;
  /** "brief.md:28" */
  source: string;
}

export interface OutcomeView extends Measure {
  values: OutcomeValue[];
  latest?: OutcomeValue;
}

export interface OutcomesView {
  change: string;
  title: string;
  state: string;
  /** Where the measures came from, or undefined when the brief has none. */
  source?: string;
  measures: OutcomeView[];
  /** Values recorded against measures the brief no longer has. */
  orphans: { id: string; measure: string; values: OutcomeValue[] }[];
  canRecord: boolean;
  /** Why values can't be recorded yet, in words. */
  why?: string;
  gaps: string[];
}

const SECTION = [/success/i, /measures?|kpis?|metrics?/i, /outcome/i];

/** "No transfer over a limit is accepted" → "no-transfer-over-a-limit-is-accepted" (≤ 60). */
export function measureId(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length <= 60) return slug || "measure";
  const cut = slug.slice(0, 61);
  return cut.slice(0, cut.lastIndexOf("-") > 20 ? cut.lastIndexOf("-") : 60);
}

const tidy = (s: string) => {
  const t = s
    .trim()
    .replace(/[.;]+$/, "")
    .trim();
  return t ? t[0]!.toUpperCase() + t.slice(1) : t;
};

/** The brief's success measures, one per bullet, sentence or clause between semicolons. */
export function measuresOf(ctx: Pick<ReleaseContext, "files">): {
  measures: Measure[];
  source?: string;
} {
  const doc = docOf(ctx.files, "brief.md");
  if (!doc) return { measures: [] };
  const s = SECTION.map((re) => doc.sections.find((x) => re.test(x.heading))).find(Boolean);
  if (!s) return { measures: [] };
  const out: Measure[] = [];
  for (const sen of sentences(sectionLines(doc, s)))
    for (const part of sen.text.split(/;\s+/)) {
      const measure = tidy(part);
      if (!measure) continue;
      let id = measureId(measure);
      for (let k = 2; out.some((m) => m.id === id); k++) id = `${measureId(measure)}-${k}`;
      out.push({ id, n: out.length + 1, measure, source: `brief.md:${sen.n}` });
    }
  return { measures: out, source: `brief.md:${s.line}` };
}

export async function readOutcomes(dir: string): Promise<ChangeOutcomes | undefined> {
  let text: string;
  try {
    text = await readFile(join(dir, OUTCOMES_FILE), "utf8");
  } catch {
    return undefined;
  }
  const r = ChangeOutcomes.safeParse(parse(text));
  if (!r.success)
    throw new ReleaseError(
      `${OUTCOMES_FILE}: ${r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
      "invalid",
    );
  return r.data;
}

export async function outcomesView(ctx: ReleaseContext): Promise<OutcomesView> {
  const { measures, source } = measuresOf(ctx);
  const file = await readOutcomes(ctx.dir);
  const recorded = new Map((file?.measures ?? []).map((m) => [m.id, m]));
  const gaps: string[] = [];
  if (!source)
    gaps.push(
      'brief.md has no "Success measures" section, so there is nothing to measure after release. Add one: how the team will know the change worked.',
    );
  const canRecord = MEASURABLE.has(ctx.change.state) && measures.length > 0;
  const why = !measures.length
    ? "The brief names no success measures."
    : canRecord
      ? undefined
      : `Outcomes are measured after release; ${ctx.change.id} is ${ctx.change.state}.`;
  return {
    change: ctx.change.id,
    title: ctx.change.title,
    state: ctx.change.state,
    ...(source ? { source } : {}),
    measures: measures.map((m) => {
      const values = recorded.get(m.id)?.values ?? [];
      return { ...m, values, ...(values.length ? { latest: values.at(-1)! } : {}) };
    }),
    orphans: (file?.measures ?? [])
      .filter((x) => !measures.some((m) => m.id === x.id))
      .map((x) => ({ id: x.id, measure: x.measure, values: x.values })),
    canRecord,
    ...(why ? { why } : {}),
    gaps,
  };
}

/** Find a measure by id, by its number, or by its words. */
export function findMeasure(measures: Measure[], ref: string): Measure | undefined {
  const r = ref.trim();
  if (/^\d+$/.test(r)) return measures.find((m) => m.n === Number(r));
  return (
    measures.find((m) => m.id === r) ??
    measures.find((m) => m.measure.toLowerCase() === r.toLowerCase()) ??
    measures.find((m) => m.id === measureId(r))
  );
}

export interface RecordOutcomeInput {
  measure: string;
  value: string;
  by: string;
  note?: string;
}

/** Record a measured value as the person who measured it. Refuses before release. */
export async function recordOutcome(
  ctx: ReleaseContext,
  input: RecordOutcomeInput,
): Promise<{ measure: Measure; value: OutcomeValue; written: string }> {
  const { measures } = measuresOf(ctx);
  if (!measures.length)
    throw new ReleaseError(
      `brief.md of ${ctx.change.id} names no success measures, so there is nothing to record.`,
      "refused",
    );
  if (!MEASURABLE.has(ctx.change.state))
    throw new ReleaseError(
      `Outcomes are measured after release; ${ctx.change.id} is ${ctx.change.state}.`,
      "refused",
    );
  const m = findMeasure(measures, input.measure);
  if (!m)
    throw new ReleaseError(
      `brief.md has no measure "${input.measure}". Its measures: ${measures.map((x) => `${x.n} ${x.id}`).join("; ")}.`,
      "refused",
    );
  const by = input.by.replace(/^@/, "");
  const value: OutcomeValue = {
    value: input.value.trim(),
    by,
    at: ctx.now,
    ...(input.note?.trim() ? { note: input.note.trim() } : {}),
  };
  const file = (await readOutcomes(ctx.dir)) ?? {
    schemaVersion: 1 as const,
    change: ctx.change.id,
    measures: [],
  };
  const existing = file.measures.find((x) => x.id === m.id);
  const next = {
    ...file,
    measures: existing
      ? file.measures.map((x) => (x.id === m.id ? { ...x, values: [...x.values, value] } : x))
      : [...file.measures, { id: m.id, measure: m.measure, values: [value] }],
  };
  const parsed = ChangeOutcomes.safeParse(next);
  if (!parsed.success)
    throw new ReleaseError(
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      "refused",
    );
  const path = join(ctx.dir, OUTCOMES_FILE);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  try {
    await writeFile(
      tmp,
      toCanonicalYaml(parsed.data, [
        "schemaVersion",
        "change",
        "id",
        "measure",
        "value",
        "by",
        "at",
      ]),
      "utf8",
    );
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
  return {
    measure: m,
    value: parsed.data.measures.find((x) => x.id === m.id)!.values.at(-1)!,
    written: OUTCOMES_FILE,
  };
}
