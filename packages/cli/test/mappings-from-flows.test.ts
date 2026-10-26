import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { mappingGrid } from "../src/ui-api-across.js";

/**
 * API mappings on an Atticus 2 change (ADR 0129 §2.3). The page read `mappings.md` and nothing
 * else, so on a change taken through the stages — which never write that file — it showed "no
 * hops in mappings" and the page was a dead end. Its Atticus 2 source is the architecture
 * stage's target flows: every step that moves data names the fields it sends, returns and reads,
 * the column each is stored as (`fields.as`) and how a field is worked out (`fields.derived`).
 *
 * Everything here is invented (CLAUDE.md rule 3): the Forge estate and the vendor Northwind Pay.
 */

let root: string;
const CHANGE = "screen-order-consent";
const LEGACY = "add-gift-wrap";

/** The architecture stage's target flow: a call out to a vendor, and a write with a column of another name. */
const FLOW = `schemaVersion: 2
flow: forge-orders.place-order
repo: forge-orders
change: modify
why: A consenting customer's order is screened by Northwind Pay before stock is reserved.
steps:
  - op: add
    after: 1
    kind: call-out
    what: Northwind Pay screens the order for fraud.
    to:
      component: northwind-pay
      entry: POST /v1/screenings
      new: true
    fields:
      sends:
        - sku
        - quantity
        - cardToken
      returns:
        - verdict
      as:
        cardToken: card_token
      derived:
        quantity: sum of the order's line quantities
    why: The screen the brief asks for.
  - op: add
    after: 2
    kind: write
    what: Keep the verdict against the order.
    store:
      table: forge-orders-db.orders
      columns:
        - screen_verdict
    fields:
      sends:
        - verdict
      as:
        verdict: screen_verdict
    why: The verdict is read when the order is picked.
  - op: add
    after: 3
    kind: branch
    what: A rejected order is refused with 422 and nothing is reserved.
    fields:
      reads:
        - verdict
    why: Nothing is reserved for a rejected order.
`;

/** An Atticus 1 change, with mappings.md and no target flows: it must read exactly as before. */
const MAPPINGS = `# Mappings

## POST /orders

| Source field | Target field | Rule or transformation | When missing or invalid |
| --- | --- | --- | --- |
| basket.giftWrap | giftWrap | as is | false |
`;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "atticus-mappings-flows-"));
  const stages = join(root, "openspec/changes", CHANGE);
  await mkdir(join(stages, "target-flows"), { recursive: true });
  await writeFile(join(stages, "target-flows", "forge-orders.place-order.yaml"), FLOW);
  const legacy = join(root, "openspec/changes", LEGACY);
  await mkdir(legacy, { recursive: true });
  await writeFile(join(legacy, "mappings.md"), MAPPINGS);
});

describe("API mappings on a change taken through the stages (ADR 0129)", () => {
  it("reads its hops from the target flows when there is no mappings.md", async () => {
    const g = await mappingGrid(root, CHANGE, []);
    expect(g.hops.map((h) => h.heading)).toEqual(["POST /v1/screenings", "forge-orders-db.orders"]);
    // Every hop says which target flow it was read from, so a reader can open it.
    expect(g.hops.every((h) => h.from?.startsWith("target-flows/"))).toBe(true);
  });

  it("maps a sent field to the name it is stored or sent as, and says how a field is worked out", async () => {
    const [call, write] = (await mappingGrid(root, CHANGE, [])).hops;
    expect(call!.rows).toEqual([
      { line: 1, source: "sku", target: "sku", rule: "", whenMissing: "" },
      {
        line: 2,
        source: "quantity",
        target: "quantity",
        rule: "sum of the order's line quantities",
        whenMissing: "",
      },
      { line: 3, source: "cardToken", target: "card_token", rule: "", whenMissing: "" },
      { line: 4, source: "verdict", target: "verdict", rule: "", whenMissing: "" },
    ]);
    expect(write!.rows).toEqual([
      { line: 1, source: "verdict", target: "screen_verdict", rule: "", whenMissing: "" },
    ]);
  });

  it("leaves out a step that moves no data, and never says a hop doesn't change", async () => {
    const g = await mappingGrid(root, CHANGE, []);
    expect(g.hops.map((h) => h.heading)).not.toContain("branch");
    expect(g.hops.every((h) => h.noChange === false)).toBe(true);
    expect(g.hops.every((h) => h.rows.length > 0)).toBe(true);
  });

  it("reads mappings.md exactly as before on a change that has one", async () => {
    const g = await mappingGrid(root, LEGACY, []);
    expect(g.hops.map((h) => h.heading)).toEqual(["POST /orders"]);
    expect(g.hops[0]!.from).toBe("mappings.md");
    expect(g.hops[0]!.rows[0]).toMatchObject({
      source: "basket.giftWrap",
      target: "giftWrap",
      rule: "as is",
      whenMissing: "false",
    });
  });

  it("says nothing rather than guessing on a change with neither", async () => {
    const empty = join(root, "openspec/changes", "nothing-yet");
    await mkdir(empty, { recursive: true });
    const g = await mappingGrid(root, "nothing-yet", []);
    expect(g.hops).toEqual([]);
  });
});
