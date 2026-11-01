import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readRepoSpec, type FlowRecord } from "@maycombhq/core";
import {
  SEED_MARK,
  seedChangeId,
  seedSpec,
  specDeltas,
  type ExistingSpec,
  type StoriesAnswer,
} from "../src/index.js";

/**
 * V2 (ADR 0146): a repo's starting openspec/specs, seeded from its verified flows. A
 * capability per flow, a requirement per flow, a scenario for the main path, each branch and each
 * error case, every line citing the code it came from. Golden files in fixtures/spec-seed/.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "../../../fixtures/spec-seed");
const expected = (f: string) => readFileSync(join(FIX, "expected", f), "utf8");

async function flows(repo: string): Promise<FlowRecord[]> {
  const root = await mkdtemp(join(tmpdir(), "atticus-seed-"));
  return (await readRepoSpec(FIX, repo, { cacheRoot: root })).flows;
}

describe("a repo's starting spec from its flows", () => {
  it("writes a capability per flow, worded and cited from its steps and errors", async () => {
    const s = seedSpec("forge-orders", await flows("forge-orders"), {
      existing: [],
      multiRepo: true,
    });
    expect(s.change).toBe("seed-forge-orders");
    expect(Object.keys(s.files)).toEqual([
      "specs/forge-orders-list-orders/spec.md",
      "specs/forge-orders-place-order/spec.md",
    ]);
    expect(s.files["specs/forge-orders-place-order/spec.md"]).toBe(
      expected("forge-orders-place-order.spec.md"),
    );
    expect(s.files["specs/forge-orders-list-orders/spec.md"]).toBe(
      expected("forge-orders-list-orders.spec.md"),
    );
    expect(s.proposal).toBe(expected("proposal.md"));
    expect(s.skipped).toEqual([{ flow: "forge-orders.old-export", why: "retired" }]);
    expect(s.proposal.startsWith(SEED_MARK)).toBe(true);
  });

  it("leaves out a flow openspec/specs already has, and says so", async () => {
    const existing: ExistingSpec[] = [
      { id: "forge-orders-place-order", flow: "forge-orders.place-order", requirements: [] },
    ];
    const s = seedSpec("forge-orders", await flows("forge-orders"), { existing, multiRepo: true });
    expect(Object.keys(s.files)).toEqual(["specs/forge-orders-list-orders/spec.md"]);
    expect(s.skipped).toContainEqual({
      flow: "forge-orders.place-order",
      why: "openspec/specs has it already, as forge-orders-place-order",
    });
  });

  it("says less where the flow says less: a step without a line cites its file, another repo's file names it", () => {
    const flow = {
      id: "forge-stock.count",
      name: "Stock is counted",
      trigger: {
        kind: "job",
        what: "The scheduler starts the count",
        evidence: [{ source: "code", repo: "forge-stock", path: "jobs/Count.java" }],
      },
      steps: [
        {
          kind: "entry",
          what: "Count.run starts",
          refs: [],
          evidence: [{ source: "code", repo: "forge-stock", path: "jobs/Count.java", line: 2 }],
        },
      ],
      errors: [],
      status: "current",
    } as unknown as FlowRecord;
    const other = {
      ...flow,
      id: "forge-stock.count-two",
      trigger: {
        ...flow.trigger,
        evidence: [{ source: "code", repo: "forge-shared", path: "Cron.java", line: 4 }],
      },
    } as unknown as FlowRecord;
    const s = seedSpec("forge-stock", [flow, other], { existing: [], multiRepo: false });
    const one = s.files["specs/count/spec.md"]!;
    // only the entry step: it is the main path's outcome
    expect(one).toContain(
      "#### Scenario: Main path: Count.run starts\n- **WHEN** the scheduler starts the count (`jobs/Count.java`)\n- **THEN** Count.run starts (`jobs/Count.java:2`)",
    );
    expect(s.files["specs/count-two/spec.md"]).toContain("(`forge-shared:Cron.java:4`)");
  });

  it("names the seed change after the repo", () => {
    expect(seedChangeId("Forge_Orders")).toBe("seed-forge-orders");
  });

  it("the first change on a seeded flow writes MODIFIED, keeping the seed's scenarios", async () => {
    const s = seedSpec("forge-orders", await flows("forge-orders"), {
      existing: [],
      multiRepo: true,
    });
    const d = s.deltas.find((x) => x.flow === "forge-orders.place-order")!;
    // what `openspec show` gives once the seed is archived
    const existing: ExistingSpec[] = [
      {
        id: d.capability,
        flow: d.flow,
        requirements: d.added.map((r) => ({
          name: r.name,
          text: r.text,
          scenarios: r.scenarios.map((x) => ({ name: x.name, rawText: x.body })),
        })),
      },
    ];
    const answer: StoriesAnswer = {
      stories: [
        {
          id: "s1",
          title: "Hold big orders",
          asA: "shop owner",
          iWant: "big orders held",
          soThat: "nothing ships unchecked",
          tasks: [
            {
              id: "t1",
              criteria: [
                {
                  text: "Given an order above 1000, when POST /orders is called, then 202 says it waits",
                  checks: [],
                  outcome: "success",
                },
              ],
            },
          ],
        },
      ],
    } as unknown as StoriesAnswer;
    const story = {
      id: "s1",
      repo: "forge-orders",
      flow: "forge-orders.place-order",
      name: "A client places an order",
      change: "modify" as const,
      tasks: [{ id: "t1" }],
    } as unknown as Parameters<typeof specDeltas>[1][number];
    const [delta] = specDeltas("hold-big-orders", [story], answer, { existing, multiRepo: true });
    expect(delta!.added).toEqual([]);
    expect(delta!.purpose).toBeUndefined();
    expect(delta!.modified.map((m) => m.name)).toEqual(["A client places an order"]);
    expect(delta!.modified[0]!.scenarios.map((x) => x.name)).toEqual([
      ...d.added[0]!.scenarios.map((x) => x.name),
      "202 says it waits",
    ]);
  });
});
