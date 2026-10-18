import type { TestStrategy } from "@maycombhq/core";
import type { z } from "zod";
import type { Footprint } from "./footprint.js";
import type { ChangePolicy } from "./policy.js";

export type RiskLevel = "low" | "medium" | "high";

export interface RiskFactor {
  factor: "type" | "systems" | "data-store" | "vendor" | "interface";
  detail: string;
  points: number;
}

export interface Risk {
  score: number;
  level: RiskLevel;
  /** Every factor that added points, in a fixed order, so the score can be checked by hand. */
  factors: RiskFactor[];
}

/**
 * A deterministic risk score: the change type's weight, plus points per extra system, per
 * data store, for crossing the vendor boundary, and per interface planned to change or
 * retire. Weights and level thresholds come from the change policy.
 */
export function scoreRisk(
  input: { type: string; footprint: Footprint },
  policy: Pick<ChangePolicy, "risk">,
): Risk {
  const { risk } = policy;
  const w = risk.weights;
  const f = input.footprint;
  const factors: RiskFactor[] = [];
  const add = (factor: RiskFactor["factor"], detail: string, points: number) => {
    if (points > 0) factors.push({ factor, detail, points });
  };
  add("type", `change type ${input.type}`, risk.typeWeights[input.type] ?? risk.defaultTypeWeight);
  if (f.systems.length > 1)
    add(
      "systems",
      `${f.systems.length} systems touched (${f.systems.join(", ")})`,
      (f.systems.length - 1) * w.extraSystem,
    );
  for (const s of f.dataStores) add("data-store", `data store ${s}`, w.dataStore);
  if (f.vendors.length > 0)
    add("vendor", `crosses the vendor boundary (${f.vendors.join(", ")})`, w.vendor);
  for (const i of f.interfaces) {
    if (i.status === "planned-modify")
      add("interface", `interface ${i.id} planned-modify`, w.interfaceModify);
    if (i.status === "planned-retire")
      add("interface", `interface ${i.id} planned-retire`, w.interfaceRetire);
  }
  const score = factors.reduce((n, x) => n + x.points, 0);
  const level: RiskLevel =
    score >= risk.levels.high ? "high" : score >= risk.levels.medium ? "medium" : "low";
  return { score, level, factors };
}

const LEVELS: RiskLevel[] = ["low", "medium", "high"];

export interface TestPlan {
  required: z.infer<typeof TestStrategy>["matrix"][number]["required"];
  /** The matrix row used. */
  row?: { changeType: string; risk: RiskLevel };
  /** Set when no exact row exists. */
  note?: string;
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
