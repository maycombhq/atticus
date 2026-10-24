import { readFile, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import {
  answerQuestion,
  judgmentKey,
  memoryJudgments,
  QuestionDraft,
  raiseQuestions,
  type RuntimeKind,
  type SameVerdict,
} from "@maycombhq/core";
import {
  APPLIES_SPEC,
  ASKS_CHECK_SPEC,
  BREAKING_SPEC,
  COVERS_FIELD_SPEC,
  judge,
  judgeStandIn,
  MockRuntime,
  NAMES_SECRET_SPEC,
  PERSONAL_DATA_SPEC,
  personalItem,
  questionJudge,
  REACHES_SPEC,
  recordedJudge as recordedStandIn,
  settle,
  UNDOES_SPEC,
  verdictOf,
  type AiRequest,
  type JudgeItem,
  type JudgeSpec,
} from "@maycombhq/ai";
import { groundValues, reachesItem, settleClaims } from "@maycombhq/knowledge";
import { dorItems, reliedOn, writesField, type DorCheck } from "@maycombhq/planner";
import { breakingItem, secretItem, undoesItem } from "@maycombhq/release";
import {
  oldApplies,
  oldBreaking,
  oldDorChecks,
  oldLeadTimeDays,
  oldLooksPersonal,
  oldNamesField,
  oldNamesSecret,
  oldReaches,
  oldReliesOn,
  oldSameQuestion,
  oldStatesValue,
  oldUndoes,
  type OldStep,
} from "./judgment-baselines.js";

/**
 * The judgments' eval (ADR 0117 and its addendum). Each judgment moved from a word rule to the
 * model is scored on the cases in fixtures/judgments/, against what a person says (`truth`),
 * three ways:
 *
 * - **old**: the deleted heuristic (judgment-baselines.ts), as it was;
 * - **model**: the new path with a model the runtime can call: the checks and vetoes, then the
 *   judge, replaying the judge's recorded answers (`recorded` in each case) through judge();
 * - **hand-off**: the new path with Copilot's hand-off, where no extra round is spent: the
 *   checks and vetoes, the step's own reading where its prompt carries it, and what is left is
 *   handed back or raised (never guessed).
 *
 * `wrongYes` counts the errors a bank can't take: a person's answer reused for another question,
 * a value passed that the page doesn't state, a field counted as tested that isn't. `prompts`
 * counts the judge's model calls (each a batch). No model is called: the recorded answers stand
 * in for one, and a changed prompt doesn't change them, so this measures the pipeline (what the
 * checks settle, what reaches the judge and whether its quotes check out), not a live model.
 */

export interface JudgmentScore {
  correct: number;
  total: number;
  /** Said yes (same, covers, states, applies, relies) where the truth is no. */
  wrongYes: number;
  /** Said no where the truth is yes. */
  wrongNo: number;
  /** Case ids it got wrong. */
  wrong: string[];
}

export interface JudgmentRow {
  kind: string;
  cases: number;
  old: JudgmentScore;
  model: JudgmentScore;
  handoff: JudgmentScore;
  /** The judge's model calls in the model mode (batched); hand-off spends none. */
  prompts: number;
}

const NOW = new Date("2026-10-23T12:00:00Z");

function score(rows: { id: string; truth: boolean; said: boolean }[]): JudgmentScore {
  const s: JudgmentScore = { correct: 0, total: rows.length, wrongYes: 0, wrongNo: 0, wrong: [] };
  for (const r of rows)
    if (r.truth === r.said) s.correct++;
    else {
      s.wrong.push(r.id);
      if (r.said) s.wrongYes++;
      else s.wrongNo++;
    }
  return s;
}

interface Recorded {
  verdict: string;
  quotes?: { of: string; text: string }[];
  why?: string;
}

/**
 * A runtime that answers the judge from recorded verdicts: it reads the items in the prompt it
 * is sent and gives each the verdict recorded for its texts. Counts the calls.
 */
class RecordedRuntime extends MockRuntime {
  constructor(
    respond: (r: AiRequest) => string,
    override readonly kind: RuntimeKind,
  ) {
    super(respond, { now: () => NOW });
  }
}

function recordedJudge(
  byTexts: Map<string, Recorded>,
  kind: RuntimeKind = "replay",
): { runtime: MockRuntime; calls: () => number } {
  let calls = 0;
  const runtime = new RecordedRuntime((r: AiRequest) => {
    calls++;
    const rows: unknown[] = [];
    for (const m of r.pack.prompt.matchAll(/^item (\d+):\n((?: {2}\w+: ".*"\n?)+)/gm)) {
      const texts: Record<string, string> = {};
      for (const l of m[2]!.matchAll(/^ {2}(\w+): (".*")$/gm))
        texts[l[1]!] = JSON.parse(l[2]!) as string;
      const rec = byTexts.get(JSON.stringify(texts));
      rows.push({
        item: Number(m[1]),
        verdict: rec?.verdict ?? "unsure",
        quotes: rec?.quotes ?? [],
        ...(rec?.why ? { why: rec.why } : {}),
      });
    }
    return stringify({ judgments: rows });
  }, kind);
  return { runtime, calls: () => calls };
}

const fixture = async <T>(root: string, name: string) =>
  parse(await readFile(join(root, "fixtures", "judgments", name), "utf8")) as T;

// ---------------------------------------------------------------- same-question

interface SameCase {
  id: string;
  repo?: string;
  new: { question: string; evidence: string[] };
  existing: { question: string; evidence: string[]; state: "open" | "answered" };
  truth: SameVerdict;
  recorded?: Recorded;
}

async function sameQuestionRow(repoRoot: string): Promise<JudgmentRow> {
  const f = await fixture<{ repo: string; cases: SameCase[] }>(repoRoot, "same-question.yaml");
  const byTexts = new Map<string, Recorded>();
  for (const c of f.cases)
    if (c.recorded)
      byTexts.set(
        JSON.stringify({ new: c.new.question, existing: c.existing.question }),
        c.recorded,
      );
  const rec = recordedJudge(byTexts);
  const run = async (c: SameCase, mode: "model" | "handoff") => {
    const repo = c.repo ?? f.repo;
    const root = await mkdtemp(join(tmpdir(), "atticus-judgment-bench-"));
    await mkdir(join(root, "org-pack"), { recursive: true });
    const by = (step: string) => ({
      step,
      repo,
      command: step,
      rerun: step,
      at: NOW.toISOString(),
    });
    const d = (q: { question: string; evidence: string[] }) =>
      QuestionDraft.parse({
        question: q.question,
        evidence: q.evidence,
        options: [],
        scope: "repo",
      });
    const first = (await raiseQuestions(root, [d(c.existing)], by("first"))).raised[0]!;
    if (c.existing.state === "answered")
      await answerQuestion(root, first.id, { text: "Internal", by: "eval", at: NOW.toISOString() });
    const judgeFn =
      mode === "model"
        ? questionJudge({
            runtime: rec.runtime,
            store: memoryJudgments(),
            change: "eval",
            now: NOW,
          })
        : undefined;
    const r = await raiseQuestions(
      root,
      [d(c.new)],
      by("second"),
      judgeFn ? { judge: judgeFn } : {},
    );
    return r.reused.some((q) => q.id === first.id);
  };
  const old: { id: string; truth: boolean; said: boolean }[] = [];
  const model: typeof old = [];
  const handoff: typeof old = [];
  for (const c of f.cases) {
    const repo = c.repo ?? f.repo;
    const truth = c.truth === "same";
    old.push({
      id: c.id,
      truth,
      said: oldSameQuestion({ repo, ...c.new }, { repo, ...c.existing }),
    });
    model.push({ id: c.id, truth, said: await run(c, "model") });
    handoff.push({ id: c.id, truth, said: await run(c, "handoff") });
  }
  return {
    kind: "same-question",
    cases: f.cases.length,
    old: score(old),
    model: score(model),
    handoff: score(handoff),
    prompts: rec.calls(),
  };
}

// ---------------------------------------------------------------- covers-field

interface CoversCase {
  id: string;
  field: string;
  criterion: string;
  truth: "yes" | "no";
  recorded?: Recorded;
}

async function judgedAll(
  spec: JudgeSpec,
  items: { id: string; item: JudgeItem; recorded?: Recorded }[],
): Promise<{ verdicts: Map<string, string>; prompts: number }> {
  const byTexts = new Map<string, Recorded>();
  for (const x of items) if (x.recorded) byTexts.set(JSON.stringify(x.item.texts), x.recorded);
  const rec = recordedJudge(byTexts);
  const verdicts = new Map<string, string>();
  if (!items.length) return { verdicts, prompts: 0 };
  const r = await judge(
    spec,
    items.map((x) => x.item),
    { runtime: rec.runtime, store: memoryJudgments(), change: "eval", now: NOW },
  );
  for (const x of items)
    verdicts.set(x.id, r.results.get(judgmentKey(spec.kind, x.item.inputs))?.verdict ?? "unsure");
  return { verdicts, prompts: rec.calls() };
}

async function coversFieldRow(repoRoot: string): Promise<JudgmentRow> {
  const f = await fixture<{ cases: CoversCase[] }>(repoRoot, "covers-field.yaml");
  const unwritten = f.cases.filter((c) => !writesField(c.criterion, c.field));
  const j = await judgedAll(
    COVERS_FIELD_SPEC,
    unwritten.map((c) => ({
      id: c.id,
      item: {
        inputs: { v: 1, field: c.field, criterion: c.criterion },
        texts: { criterion: c.criterion },
        facts: [`the field: ${c.field}`],
      },
      ...(c.recorded ? { recorded: c.recorded } : {}),
    })),
  );
  const rows = (said: (c: CoversCase) => boolean) =>
    score(f.cases.map((c) => ({ id: c.id, truth: c.truth === "yes", said: said(c) })));
  return {
    kind: "covers-field",
    cases: f.cases.length,
    old: rows((c) => oldNamesField(c.criterion, c.field)),
    model: rows((c) => writesField(c.criterion, c.field) || j.verdicts.get(c.id) === "yes"),
    // Hand-off: a field the then clause doesn't write is handed back to the writer to name.
    handoff: rows((c) => writesField(c.criterion, c.field)),
    prompts: j.prompts,
  };
}

// ---------------------------------------------------------------- states-value

interface ValueCase {
  id: string;
  field: string;
  value: string;
  /** lead_time_days: the lead time as the page words it. */
  words?: string;
  quote: string;
  span?: string;
  truth: "yes" | "no";
  recorded?: Recorded;
}

const valued = (c: ValueCase) => {
  const own = c.span;
  if (c.field === "lead_time_days") {
    const [n, unit] = c.value.split(" ");
    return {
      lead_time: c.words ?? "",
      ...(own ? { lead_time_quote: own } : {}),
      lead_time_days: {
        min: Number(n),
        max: Number(n),
        unit: unit as "working-days" | "calendar-days" | "hours",
      },
    };
  }
  if (c.field === "lead_time")
    return { lead_time: c.value, ...(own ? { lead_time_quote: own } : {}) };
  if (c.field === "status") return { status: c.value, ...(own ? { status_quote: own } : {}) };
  const k = c.field.replace(/^dates\./, "");
  return { dates: { [k]: c.value }, ...(own ? { date_quotes: { [k]: own } } : {}) };
};

async function statesValueRow(repoRoot: string): Promise<JudgmentRow> {
  const f = await fixture<{ cases: ValueCase[] }>(repoRoot, "states-value.yaml");
  const byTexts = new Map<string, Recorded>();
  for (const c of f.cases)
    if (c.recorded && c.span) byTexts.set(JSON.stringify({ span: c.span }), c.recorded);
  const rec = recordedJudge(byTexts);
  const settle = async (c: ValueCase, mode: "model" | "handoff") => {
    const g = groundValues(valued(c), { quotes: [c.quote], pages: c.quote });
    if (g.problems.length) return false;
    if (!g.claims.length) return true;
    const out = await settleClaims([{ item: { id: c.id }, claims: g.claims }], {
      runtime: mode === "model" ? rec.runtime : new MockRuntime(() => ""),
      store: memoryJudgments(),
      run: "run-eval",
      now: NOW,
    });
    return !out.has(c.id);
  };
  const old: { id: string; truth: boolean; said: boolean }[] = [];
  const model: typeof old = [];
  const handoff: typeof old = [];
  for (const c of f.cases) {
    const truth = c.truth === "yes";
    old.push({
      id: c.id,
      truth,
      said:
        c.field === "lead_time_days"
          ? oldLeadTimeDays(c.words ?? "") === Number(c.value.split(" ")[0])
          : oldStatesValue(c.field, c.value, c.quote),
    });
    model.push({ id: c.id, truth, said: await settle(c, "model") });
    handoff.push({ id: c.id, truth, said: await settle(c, "handoff") });
  }
  return {
    kind: "states-value",
    cases: f.cases.length,
    old: score(old),
    model: score(model),
    handoff: score(handoff),
    prompts: rec.calls(),
  };
}

// ---------------------------------------------------------------- applies

interface AppliesCase {
  id: string;
  process: { id: string; title: string; appliesWhen: string };
  step: OldStep;
  facts: string;
  truth: "yes" | "no";
  recorded?: Recorded;
}

async function appliesRow(repoRoot: string): Promise<JudgmentRow> {
  const f = await fixture<{ cases: AppliesCase[] }>(repoRoot, "applies.yaml");
  const j = await judgedAll(
    APPLIES_SPEC,
    f.cases.map((c) => ({
      id: c.id,
      item: {
        inputs: {
          v: 1,
          process: c.process.id,
          appliesWhen: c.process.appliesWhen,
          facts: [c.facts],
        },
        texts: { appliesWhen: c.process.appliesWhen, step: c.facts },
      },
      ...(c.recorded ? { recorded: c.recorded } : {}),
    })),
  );
  const rows = (said: (c: AppliesCase) => boolean) =>
    score(f.cases.map((c) => ({ id: c.id, truth: c.truth === "yes", said: said(c) })));
  return {
    kind: "applies",
    cases: f.cases.length,
    old: rows((c) => oldApplies(c.step, c.process)),
    model: rows((c) => j.verdicts.get(c.id) === "yes"),
    // Hand-off: the story writer's own reading in its prompt; the recorded verdict stands for it,
    // and its quote of the applies-when is checked the same way.
    handoff: rows((c) => j.verdicts.get(c.id) === "yes"),
    prompts: j.prompts,
  };
}

// ---------------------------------------------------------------- relies-on-gaps

async function reliesRow(repoRoot: string): Promise<JudgmentRow> {
  const f = await fixture<{
    gap: string;
    cases: { id: string; answer: string; truth: "yes" | "no" }[];
  }>(repoRoot, "relies-on-gaps.yaml");
  const gaps = [{ name: f.gap, state: "listed" as const }];
  const rows = (said: (a: string) => boolean) =>
    score(f.cases.map((c) => ({ id: c.id, truth: c.truth === "yes", said: said(c.answer) })));
  const now = rows((a) => reliedOn(gaps, a).relied.length > 0);
  return {
    kind: "relies-on-gaps",
    cases: f.cases.length,
    old: rows((a) => oldReliesOn(f.gap, a)),
    model: now,
    handoff: now,
    prompts: 0,
  };
}

// ---------------------------------------------------------------- the addendum's kinds

interface YesNoCase {
  id: string;
  truth: "yes" | "no";
  recorded?: Recorded;
}

/**
 * A yes-or-no kind of the addendum, scored three ways through settle(), the call the steps
 * make: the model mode with the recorded verdicts standing in for a model, the hand-off mode
 * with no model to ask (the veto and nothing else; an open item is never a yes).
 */
async function settledRow<C extends YesNoCase>(
  kind: string,
  spec: JudgeSpec,
  cases: C[],
  itemOf: (c: C) => JudgeItem,
  old: (c: C) => boolean,
): Promise<JudgmentRow> {
  // Keyed by texts and facts: one sentence can be judged for two steps.
  const key = (it: { texts: Record<string, string>; facts?: string[] }) =>
    JSON.stringify({ texts: it.texts, facts: it.facts ?? [] });
  const byItem = new Map<string, Recorded>();
  for (const c of cases) if (c.recorded) byItem.set(key(itemOf(c)), c.recorded);
  const rec = judgeStandIn((it) => byItem.get(key(it)), { now: () => NOW });
  const items = cases.map(itemOf);
  const asked = await settle(spec, items, {
    runtime: rec.runtime,
    store: memoryJudgments(),
    change: "eval",
    now: NOW,
  });
  const handed = await settle(spec, items, {
    runtime: new MockRuntime(() => "", { now: () => NOW }),
    store: memoryJudgments(),
    change: "eval",
    now: NOW,
  });
  const rows = (said: (c: C, i: number) => boolean) =>
    score(cases.map((c, i) => ({ id: c.id, truth: c.truth === "yes", said: said(c, i) })));
  return {
    kind,
    cases: cases.length,
    old: rows((c) => old(c)),
    model: rows((_, i) => verdictOf(asked, spec, items[i]!.inputs)?.verdict === "yes"),
    handoff: rows((_, i) => verdictOf(handed, spec, items[i]!.inputs)?.verdict === "yes"),
    prompts: rec.calls(),
  };
}

async function breakingRow(repoRoot: string): Promise<JudgmentRow> {
  const f = await fixture<{ cases: (YesNoCase & { change: string; notes: string })[] }>(
    repoRoot,
    "breaking.yaml",
  );
  return settledRow(
    "breaking",
    BREAKING_SPEC,
    f.cases,
    (c) =>
      breakingItem(
        { change: c.change, operation: "the operation", caller: "a-caller", callee: "a-callee" },
        c.notes,
      ),
    // "check" was the old rule's "a person decides", so it never said yes.
    (c) => oldBreaking(c.change, c.notes) === "yes",
  );
}

async function undoesRow(repoRoot: string): Promise<JudgmentRow> {
  const f = await fixture<{
    steps: Record<string, { kind: string; names: string[] }>;
    cases: (YesNoCase & { step: string; sentence: string })[];
  }>(repoRoot, "undoes.yaml");
  const others = (step: string) =>
    Object.entries(f.steps)
      .filter(([k]) => k !== step)
      .flatMap(([, s]) => s.names);
  return settledRow(
    "undoes",
    UNDOES_SPEC,
    f.cases,
    (c) =>
      undoesItem(c.sentence, { key: c.step, repo: c.step, what: [], ...f.steps[c.step]! }, [
        ...others(c.step),
        ...f.steps[c.step]!.names,
      ]),
    (c) => oldUndoes(c.sentence, f.steps[c.step]!, others(c.step)),
  );
}

async function namesSecretRow(repoRoot: string): Promise<JudgmentRow> {
  const f = await fixture<{ cases: (YesNoCase & { line: string })[] }>(
    repoRoot,
    "names-secret.yaml",
  );
  return settledRow(
    "names-secret",
    NAMES_SECRET_SPEC,
    f.cases,
    (c) => secretItem(c.line),
    (c) => oldNamesSecret(c.line),
  );
}

async function personalDataRow(repoRoot: string): Promise<JudgmentRow> {
  const f = await fixture<{
    cases: (YesNoCase & {
      column: string;
      table: string;
      type?: string;
      classifiedPersonal?: boolean;
    })[];
  }>(repoRoot, "personal-data.yaml");
  return settledRow(
    "personal-data",
    PERSONAL_DATA_SPEC,
    f.cases,
    (c) => personalItem(c),
    // The old check also read the classification first; looksPersonal judged the rest.
    (c) => c.classifiedPersonal === true || oldLooksPersonal(c.column),
  );
}

async function asksCheckRow(repoRoot: string): Promise<JudgmentRow> {
  const f = await fixture<{ cases: (YesNoCase & { item: string; check: DorCheck })[] }>(
    repoRoot,
    "asks-check.yaml",
  );
  return settledRow(
    "asks-check",
    ASKS_CHECK_SPEC,
    f.cases,
    (c) => dorItems(c.item).find((x) => x.check === c.check)!.item,
    (c) => oldDorChecks(c.item).includes(c.check),
  );
}

/**
 * Reaches has four answers. Correct is the right one; a wrong yes is a route said that isn't
 * so (a claim the wiki doesn't make, checked against code as if it did); a wrong no is a route
 * missed (none, or open).
 */
async function reachesRow(repoRoot: string): Promise<JudgmentRow> {
  const f = await fixture<{
    cases: {
      id: string;
      sentence: string;
      from: string;
      to: string;
      truth: string;
      recorded?: Recorded;
    }[];
  }>(repoRoot, "reaches.yaml");
  const items = f.cases.map((c) => reachesItem(c.sentence, c.from, c.to));
  const byTexts = new Map<string, Recorded>();
  f.cases.forEach((c, i) => c.recorded && byTexts.set(JSON.stringify(items[i]!.texts), c.recorded));
  const rec = recordedStandIn(byTexts, { now: () => NOW });
  const asked = await settle(REACHES_SPEC, items, {
    runtime: rec.runtime,
    store: memoryJudgments(),
    change: "eval",
    now: NOW,
  });
  const scored = (said: (i: number) => string) => {
    const s: JudgmentScore = {
      correct: 0,
      total: f.cases.length,
      wrongYes: 0,
      wrongNo: 0,
      wrong: [],
    };
    f.cases.forEach((c, i) => {
      const v = said(i);
      if (v === c.truth) return void s.correct++;
      s.wrong.push(c.id);
      if (v === "gateway" || v === "direct" || v === "api-only") s.wrongYes++;
      else s.wrongNo++;
    });
    return s;
  };
  return {
    kind: "reaches",
    cases: f.cases.length,
    old: scored((i) => oldReaches(f.cases[i]!.sentence)),
    model: scored((i) => verdictOf(asked, REACHES_SPEC, items[i]!.inputs)?.verdict ?? "open"),
    // Hand-off: no model to ask; every sentence is shown to a person as unjudged.
    handoff: scored(() => "open"),
    prompts: rec.calls(),
  };
}

/** Score every judgment ADR 0117 and its addendum replaced, old against new, on the fixtures. */
export async function runJudgmentBench(repoRoot: string): Promise<JudgmentRow[]> {
  return [
    await sameQuestionRow(repoRoot),
    await coversFieldRow(repoRoot),
    await statesValueRow(repoRoot),
    await appliesRow(repoRoot),
    await reliesRow(repoRoot),
    await breakingRow(repoRoot),
    await undoesRow(repoRoot),
    await namesSecretRow(repoRoot),
    await personalDataRow(repoRoot),
    await asksCheckRow(repoRoot),
    await reachesRow(repoRoot),
  ];
}

/** The rows as a Markdown table. */
export function judgmentTable(rows: JudgmentRow[]): string {
  const cell = (s: JudgmentScore) =>
    `${s.correct}/${s.total} (wrong yes ${s.wrongYes}, wrong no ${s.wrongNo})`;
  return [
    "| Judgment | Cases | Old heuristic | Model (recorded judge) | Hand-off | Judge calls |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows.map(
      (r) =>
        `| ${r.kind} | ${r.cases} | ${cell(r.old)} | ${cell(r.model)} | ${cell(r.handoff)} | ${r.prompts} |`,
    ),
  ].join("\n");
}
