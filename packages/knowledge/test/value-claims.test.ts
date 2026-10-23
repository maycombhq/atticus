import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { memoryJudgments } from "@maycombhq/core";
import { MockModelProvider, MockRuntime, ModelRuntime } from "@maycombhq/ai";
import { groundValues } from "../src/grounding.js";
import { LEAD_TIME, leadTimeDaysOf, settleClaims } from "../src/value-claims.js";

/** ADR 0117: the values no check settles are judged where a model can be called, kept either way. */

const NOW = new Date("2026-10-23T12:00:00Z");
const SPAN = "Requests need 3 approvers and take 15 days.";

const claimed = (id: string, item: Parameters<typeof groundValues>[0], quote: string) => ({
  item: { id, ...item },
  claims: groundValues(item, { quotes: [quote], pages: quote }).claims,
});

/** A model that judges as recorded: the span states the value only when it is a run of it. */
const judgeModel = () =>
  new ModelRuntime(
    new MockModelProvider("recorded-judge", (prompt) => {
      const rows = [
        ...prompt.matchAll(
          /item (\d+):\n {2}span: (".*")\n {2}facts:\n {4}- field: (.*)\n {4}- value: (.*)/g,
        ),
      ].map((m) => {
        const span = JSON.parse(m[2]!) as string;
        const value = m[4]!.trim();
        const says =
          (value === "15 days" && span.includes("15 days")) ||
          (value === "retiring" && span.includes("move off")) ||
          (value.startsWith("10 ") && span.includes("fortnight"));
        return {
          item: Number(m[1]),
          verdict: says ? "yes" : "no",
          quotes: [
            { of: "span", text: says ? span.split(" ").slice(-3).join(" ") : span.split(" ")[0]! },
          ],
          why: says ? "The span says it." : "The span gives another figure.",
        };
      });
      return stringify({ judgments: rows });
    }),
    { now: () => NOW },
  );

describe("value claims (ADR 0117)", () => {
  it("hands back a lead time the judge says its words don't state: 3 days is not 3 approvers and 15 days", async () => {
    const store = memoryJudgments();
    const bad = claimed("cab", { lead_time: "3 days", lead_time_quote: SPAN }, SPAN);
    expect(bad.claims).toHaveLength(1);
    const out = await settleClaims([bad], {
      runtime: judgeModel(),
      store,
      run: "run-scan",
      now: NOW,
    });
    expect(out.get("cab")).toEqual([
      `lead_time "3 days": the words "${SPAN}" don't state it (a judge read them); quote the words that do`,
    ]);
    expect(store.all()[0]).toMatchObject({ kind: "states-value", verdict: "no" });
  });

  it("keeps a reading the judge confirms, and the normalised lead time for the steps that plan by it", async () => {
    const store = memoryJudgments();
    const ok = claimed(
      "vendor-review",
      {
        lead_time: "a fortnight",
        lead_time_quote: "Allow a fortnight.",
        lead_time_days: { min: 10, max: 10, unit: "working-days" },
      },
      "Allow a fortnight.",
    );
    const out = await settleClaims([ok], {
      runtime: judgeModel(),
      store,
      run: "run-scan",
      now: NOW,
    });
    expect(out.size).toBe(0);
    expect(await leadTimeDaysOf(store, "vendor-review", "a fortnight")).toEqual({
      min: 10,
      max: 10,
      unit: "working-days",
    });
    const kept = store.all().find((j) => j.kind === LEAD_TIME)!;
    expect(kept.confirmedBy.by).toBe("ai");
    // A changed lead time on the page is a new reading: the old one isn't read for it.
    expect(await leadTimeDaysOf(store, "vendor-review", "three weeks")).toBeUndefined();
  });

  it("with a hand-off, keeps a status as the model's reading and hands back a value it didn't write", async () => {
    const store = memoryJudgments();
    const status = claimed(
      "pay-v1",
      { status: "retiring", status_quote: "move off the Northwind Pay v1 API by Q3" },
      "Teams should move off the Northwind Pay v1 API by Q3.",
    );
    const value = claimed("cab", { lead_time: "3 days", lead_time_quote: SPAN }, SPAN);
    const out = await settleClaims([status, value], {
      runtime: new MockRuntime(() => ""),
      store,
      run: "run-scan",
      now: NOW,
    });
    expect([...out.keys()]).toEqual(["cab"]);
    expect(out.get("cab")![0]).toMatch(/isn't word for word in/);
    expect(store.all()).toEqual([
      expect.objectContaining({ verdict: "yes", confirmedBy: { by: "ai", run: "run-scan" } }),
    ]);
  });
});
