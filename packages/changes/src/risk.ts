import type { TestStrategy } from "@maycombhq/core";
import type { z } from "zod";
import type { Footprint, RiskSignal } from "./footprint.js";
import { SIGNAL_FACTORS, type ChangePolicy, type SignalFactor } from "./policy.js";

export type RiskLevel = "low" | "medium" | "high";

export interface RiskFactor {
  factor: "type" | "systems" | "data-store" | "vendor" | "interface" | SignalFactor;
  detail: string;
  points: number;
  /**
   * The delta steps that raised it, `target-flows/<flow>.yaml:<line>` (ADR 0124 addendum
   * B-change); left out for a factor read from the footprint as a whole.
   */
  cites?: string[];
}

export interface Risk {
  score: number;
  level: RiskLevel;
  /** Every factor that added points, in a fixed order, so the score can be checked by hand. */
  factors: RiskFactor[];
}

/** How each signal factor is said, and the policy weight it takes. */
const SIGNAL_WORDS: Record<SignalFactor, { one: string; many: string }> = {
  "outside-call": { one: "calls an outside system", many: "calls outside systems" },
  auth: { one: "changes who may do what", many: "changes who may do what" },
  "personal-data": {
    one: "reads or writes personal or consent data",
    many: "reads or writes personal or consent data",
  },
  schema: { one: "changes the schema", many: "changes the schema" },
  breaking: { one: "breaks who uses it today", many: "breaks who uses it today" },
  spread: { one: "spans several repos", many: "spans several repos" },
};

const WEIGHT: Record<SignalFactor, keyof ChangePolicy["risk"]["weights"]> = {
  "outside-call": "outsideCall",
  auth: "auth",
  "personal-data": "personalData",
  schema: "schema",
  breaking: "breaking",
  spread: "extraRepo",
};

/** One factor's details, the first three and how many more. */
function detailsOf(signals: RiskSignal[]): string {
  const ds = [...new Set(signals.map((s) => s.detail))];
  return ds.length > 3 ? `${ds.slice(0, 3).join("; ")}; and ${ds.length - 3} more` : ds.join("; ");
}

/**
 * A deterministic risk score: the change type's weight, plus points per extra system, per
 * data store, for crossing the vendor boundary, and per interface planned to change or
 * retire; then, from the stages' deltas (ADR 0124 addendum B-change), once each for a call to
 * an outside system, a change to who may do what, personal or consent data, a schema change,
 * a breaking change, and per repo beyond the first, each citing the steps that raised it.
 * Weights and level thresholds come from the change policy; a factor weighed at 0 isn't one.
 */
export function scoreRisk(
  input: { type: string; footprint: Footprint },
  policy: Pick<ChangePolicy, "risk">,
): Risk {
  const { risk } = policy;
  const w = risk.weights;
  const f = input.footprint;
  const factors: RiskFactor[] = [];
  const add = (factor: RiskFactor["factor"], detail: string, points: number, cites?: string[]) => {
    if (points > 0) factors.push({ factor, detail, points, ...(cites ? { cites } : {}) });
  };
  add("type", `change type ${input.type}`, risk.typeWeights[input.type] ?? risk.defaultTypeWeight);
  if (f.systems.length > 1)
    add(
      "systems",
      `${f.systems.length} systems touched (${f.systems.join(", ")})`,
      (f.systems.length - 1) * w.extraSystem,
    );
  for (const s of f.dataStores) add("data-store", `data store ${s}`, w.dataStore);
  // A vendor a step calls is said once, by the call (B-change).
  const crossed = f.vendors.filter((v) => !(f.outside ?? []).some((o) => o.id === v));
  if (crossed.length > 0)
    add("vendor", `crosses the vendor boundary (${crossed.join(", ")})`, w.vendor);
  for (const i of f.interfaces) {
    if (i.status === "planned-modify")
      add("interface", `interface ${i.id} planned-modify`, w.interfaceModify);
    if (i.status === "planned-retire")
      add("interface", `interface ${i.id} planned-retire`, w.interfaceRetire);
  }
  for (const factor of SIGNAL_FACTORS) {
    const signals = (f.signals ?? []).filter((s) => s.factor === factor);
    if (!signals.length) continue;
    const words = SIGNAL_WORDS[factor];
    const points =
      factor === "spread" ? (f.repos.length - 1) * w[WEIGHT[factor]] : w[WEIGHT[factor]];
    add(factor, `${signals.length > 1 ? words.many : words.one}: ${detailsOf(signals)}`, points, [
      ...new Set(signals.map((s) => s.cite)),
    ]);
  }
  const score = factors.reduce((n, x) => n + x.points, 0);
  const level: RiskLevel =
    score >= risk.levels.high ? "high" : score >= risk.levels.medium ? "medium" : "low";
  return { score, level, factors };
}

const LEVELS: RiskLevel[] = ["low", "medium", "high"];

type TestKind = z.infer<typeof TestStrategy>["matrix"][number]["required"][number];

export interface TestPlan {
  /** Every kind the change needs: the strategy row's, then what its risk factors add. */
  required: TestKind[];
  /** The matrix row used. */
  row?: { changeType: string; risk: RiskLevel };
  /** Set when no exact row exists. */
  note?: string;
  /** The kinds the strategy's row asks, when the risk factors add to them (B-change). */
  matrix?: TestKind[];
  /**
   * What the change's risk factors ask of its tests, on top of the row (ADR 0124 addendum
   * B-change): the kinds (the change policy's `risk.tests`), why, and the steps that raised it.
   */
  added?: { factor: SignalFactor; kinds: TestKind[]; why: string; cites: string[] }[];
}

/**
 * The test kinds a change needs, from the org pack's test strategy (C6 matrix of change
 * type and risk). Without an exact row the nearest lower risk row for the type is used,
 * then the nearest higher one, and the plan says so.
 */
export function testsFor(
  strategy: z.infer<typeof TestStrategy>,
  type: string,
  level: RiskLevel,
): TestPlan {
  const rows = strategy.matrix.filter((m) => m.changeType === type);
  if (rows.length === 0)
    return { required: [], note: `test-strategy.yaml has no row for ${type}.` };
  const at = LEVELS.indexOf(level);
  const order = [
    at,
    ...LEVELS.slice(0, at)
      .map((_, i) => at - 1 - i)
      .filter((i) => i >= 0),
    ...LEVELS.slice(at + 1).map((_, i) => at + 1 + i),
  ];
  for (const i of order) {
    const row = rows.find((r) => r.risk === LEVELS[i]);
    if (!row) continue;
    const plan: TestPlan = {
      required: [...row.required],
      row: { changeType: type, risk: row.risk },
    };
    if (row.risk !== level)
      plan.note = `test-strategy.yaml has no ${type}/${level} row; using ${type}/${row.risk}.`;
    return plan;
  }
  return { required: [], note: `test-strategy.yaml has no row for ${type}.` };
}

/** Why a factor asks for its kinds, in words a developer acts on. */
function whyOf(factor: SignalFactor, f: RiskFactor): string {
  const what = f.detail.replace(/^[^:]*: /, "");
  switch (factor) {
    case "outside-call":
      return `against a stub of ${what}, with its failure paths (an error, a timeout, an answer it can't use)`;
    case "auth":
      return "of who may and who may not: each caller the rule lets in and each it refuses";
    case "personal-data":
      return "that the personal or consent data is read only where it may be, and never logged or sent on";
    case "schema":
      return "that the migration runs on today's data and the code reads what it writes";
    case "breaking":
      return "that today's callers and readers still work, or are changed with it";
    case "spread":
      return `across the repos in their deploy order (${what})`;
  }
}

/**
 * The test plan of a change at its risk (ADR 0124 addendum B-change): the test strategy's row
 * for its type and level, and the kinds each of its risk factors asks (the change policy's
 * `risk.tests`), each with why and the steps that raised it.
 */
export function testPlanFor(
  ctx: {
    orgPack: { testStrategy: z.infer<typeof TestStrategy> };
    policy: Pick<ChangePolicy, "risk">;
  },
  type: string,
  risk: Risk,
): TestPlan {
  const plan = testsFor(ctx.orgPack.testStrategy, type, risk.level);
  const added: NonNullable<TestPlan["added"]> = [];
  for (const f of risk.factors) {
    const factor = (SIGNAL_FACTORS as readonly string[]).includes(f.factor)
      ? (f.factor as SignalFactor)
      : undefined;
    const kinds = factor ? ctx.policy.risk.tests[factor] : undefined;
    if (!factor || !kinds?.length) continue;
    added.push({ factor, kinds: [...kinds], why: whyOf(factor, f), cites: f.cites ?? [] });
  }
  if (!added.length) return plan;
  const matrix = [...plan.required];
  const required = [...matrix];
  for (const a of added) for (const k of a.kinds) if (!required.includes(k)) required.push(k);
  return { ...plan, required, matrix, added };
}
