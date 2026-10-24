import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { MockRuntime, type AiRequest } from "@maycombhq/ai";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { loadChangeContext } from "@maycombhq/changes";
import {
  architectureStage,
  checkDeltas,
  EXPAND_AGENT,
  FlowDelta,
  loadEstate,
  mergedFlowsText,
  MERGED_FLOWS,
  renderData,
  type FeaturePlacement,
} from "../src/index.js";

/**
 * A live run on a chat app whose change pins a message, retold on Forge (fixtures/stages/
 * pin-table): S3, the critic didn't know how adds are ordered and raised a false finding; S4, a
 * store block couldn't declare a foreign key, so the critic asked about it three times.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "../../../fixtures");
const PIN = join(FIX, "stages/pin-table");
const NOW = new Date("2026-10-24T09:00:00Z");
const CHANGE = "pin-order-note";
const LEVELS = ["public", "internal", "confidential", "restricted"];
const draft = (name: string) => readFileSync(join(PIN, "drafts", `${name}.yaml`), "utf8");

async function pinRoot(o: { lenses?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-pin-message-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  const rows = [
    ...(parse(readFileSync(join(FIX, "specs/catalog.yaml"), "utf8")) as unknown[]),
    ...(parse(readFileSync(join(FIX, "stages/catalog-extra.yaml"), "utf8")) as unknown[]),
    ...(parse(readFileSync(join(PIN, "catalog.yaml"), "utf8")) as unknown[]),
  ];
  for (const r of rows) {
    const p = parseRecord(r);
    if (!p.ok) throw new Error(`bad fixture record: ${JSON.stringify(p.issues)}`);
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  await cp(join(FIX, "stages/specs"), join(root, "specs"), { recursive: true });
  await cp(join(PIN, CHANGE), join(root, "openspec/changes", CHANGE), { recursive: true });
  if (o.lenses)
    await cp(join(PIN, "checklists"), join(root, "org-pack/checklists"), { recursive: true });
  return root;
}

const estateOf = async (root: string) => loadEstate(root, (await loadChangeContext(root)).records);

const deltasOf = (name: string) =>
  (parse(draft(name)) as { flows: unknown[] }).flows.map((f) =>
    FlowDelta.parse({ schemaVersion: 2, ...(f as object) }),
  );

/** The place-order change: the feature changes forge-orders.place-order. */
const ORDER_PLACEMENT = {
  schemaVersion: 1,
  change: CHANGE,
  entry: "brief",
  summary: "The saved order says who placed it.",
  features: [],
  flows: [{ id: "forge-orders.place-order", how: "changed", why: "Its response changes." }],
  newFlows: [],
  gaps: [],
  conflicts: [],
  questions: [],
} as unknown as FeaturePlacement;

async function check(name: string, placement?: FeaturePlacement) {
  const root = await pinRoot();
  const p =
    placement ??
    (parse(
      await readFile(join(root, "openspec/changes", CHANGE, "feature.yaml"), "utf8"),
    ) as FeaturePlacement);
  return checkDeltas(deltasOf(name), await estateOf(root), p, [], { levels: LEVELS });
}

describe("S3: the order of a target flow's steps is a fact the critic reads, not works out", () => {
  it("the merged target flow numbers adds with the same after in the order they are written", async () => {
    const root = await pinRoot();
    const text = mergedFlowsText(deltasOf("order-by-name"), await estateOf(root));
    expect(text).toContain("never work it out from after");
    expect(text).toContain(
      "# forge-orders.place-order (modify, repo forge-orders): A client places an order",
    );
    expect(text).toContain(
      "5. lookup (added, change 1): The name of the shopper who placed the order is looked up.",
    );
    expect(text).toContain(
      "6. respond (added, change 2): 201 Created with the saved order and who placed it.",
    );
    expect(text).toContain("removed: today's step 5 (respond): 201 Created with the saved order.");
    expect(text.indexOf("5. lookup")).toBeLessThan(text.indexOf("6. respond"));
  });

  it("a respond step whose returned field comes from a step after it is a drafting finding with both step numbers", async () => {
    const got = (await check("order-by-name-swapped", ORDER_PLACEMENT)).filter((i) => i.blocking);
    expect(got.map((i) => [i.rule, i.target])).toEqual([
      ["delta.returned-before-given", "forge-orders.place-order#1:placedByName"],
    ]);
    expect(got[0]!.message).toBe(
      "Step 5 of the target of forge-orders.place-order (respond, change 1) returns placedByName, but no step before it gives it: step 6 (lookup, change 2) gives it after. Adds with the same after keep the order they are written in, so write the step that gives placedByName first, or give it an earlier after.",
    );
  });

  it("the same change written in the right order has no such finding", async () => {
    const got = (await check("order-by-name", ORDER_PLACEMENT)).filter((i) => i.blocking);
    expect(got).toEqual([]);
  });

  it("a call-out that sends a field no step before it gives is handed back too, in a new flow", async () => {
    const d = deltasOf("answered");
    d[0]!.steps.push({
      op: "add",
      after: 2,
      kind: "call-out",
      what: "The shopper is told the note is pinned",
      to: { component: "forge-stock", entry: "POST /stock/reservations", new: false },
      fields: { sends: [orderId(), "pinColour"] },
    });
    const root = await pinRoot();
    const p = parse(
      await readFile(join(root, "openspec/changes", CHANGE, "feature.yaml"), "utf8"),
    ) as FeaturePlacement;
    const got = checkDeltas(d, await estateOf(root), p, [], { levels: LEVELS }).filter(
      (i) => i.rule === "delta.returned-before-given",
    );
    expect(got.map((i) => i.target)).toEqual(["forge-orders.pin-note#3:pinColour"]);
    expect(got[0]!.message).toBe(
      "Step 3 of the target of forge-orders.pin-note (call-out, change 3) sends pinColour, but no step before it gives it (the trigger's input, a read, a lookup, or an earlier step's fields or store): add the step that gives it before step 3, or leave it out.",
    );
  });
});

const orderId = () => "orderId";

describe("S4: a store block declares a foreign key on the table's one definition", () => {
  it("reads in the flow delta, version 2 still; a bad onDelete is a schema problem", () => {
    const d = deltasOf("keys");
    expect(d[0]!.schemaVersion).toBe(2);
    expect(d[0]!.steps[1]!.store!.keys).toEqual({
      order_id: { references: "forge-orders-db.orders.id", onDelete: "cascade" },
    });
    const bad = FlowDelta.safeParse({
      ...d[0],
      steps: [
        {
          op: "add",
          after: 0,
          kind: "write",
          what: "x",
          store: {
            table: "forge-orders-db.order_pin",
            columns: ["order_id"],
            keys: { order_id: { references: "forge-orders-db.orders.id", onDelete: "drop" } },
          },
        },
      ],
    });
    expect(bad.success).toBe(false);
  });

  it("a key whose table and column exist passes, and data.md says it", async () => {
    const got = (await check("keys")).filter((i) => i.blocking);
    expect(got).toEqual([]);
    const root = await pinRoot();
    const data = renderData(deltasOf("keys"), await estateOf(root))!;
    expect(data).toContain("## Keys");
    expect(data).toContain(
      "- order_pin.order_id references forge-orders-db.orders.id; on delete cascade.",
    );
  });

  it("a key to a table or column neither the catalog nor the change has, or on a column the table lacks, is a fact handed back", async () => {
    const d = deltasOf("keys");
    d[0]!.steps[1]!.store!.keys = {
      order_id: { references: "forge-orders-db.orders.uuid", onDelete: "cascade" },
      note_id: { references: "forge-orders-db.order_note.id", onDelete: "set-null" },
      colour: { references: "forge-orders-db.orders.id", onDelete: "restrict" },
    };
    const root = await pinRoot();
    const p = parse(
      await readFile(join(root, "openspec/changes", CHANGE, "feature.yaml"), "utf8"),
    ) as FeaturePlacement;
    const got = checkDeltas(d, await estateOf(root), p, [], { levels: LEVELS })
      .filter((i) => i.rule.startsWith("delta.key-"))
      .map((i) => [i.rule, i.target, i.message]);
    expect(got).toEqual([
      [
        "delta.key-unknown-reference",
        "forge-orders.pin-note#2:order_id",
        "Change 2 to forge-orders.pin-note says column order_id of forge-orders-db.order_pin references forge-orders-db.orders.uuid, but forge-orders-db.orders has no column uuid (its columns: created_at, id, quantity, sku). Name a column it has, as <db>.<table>.<column>.",
      ],
      [
        "delta.key-unknown-reference",
        "forge-orders.pin-note#2:note_id",
        "Change 2 to forge-orders.pin-note says column note_id of forge-orders-db.order_pin references forge-orders-db.order_note.id, but neither the catalog nor this change has a table forge-orders-db.order_note. Name a table and column the catalog or this change has, as <db>.<table>.<column>.",
      ],
      [
        "delta.key-unknown-column",
        "forge-orders.pin-note#2:colour",
        "Change 2 to forge-orders.pin-note gives a key for column colour, which isn't one of forge-orders-db.order_pin's columns (order_id, note_id, pinned_by): key a column the table has, or add it under store.columns.",
      ],
    ]);
  });

  it("a key on a step that uses the new table without defining it goes on the definition", async () => {
    const d = deltasOf("keys");
    d[1]!.steps[1]!.store!.keys = {
      order_id: { references: "forge-orders-db.orders.id", onDelete: "cascade" },
    };
    const root = await pinRoot();
    const p = parse(
      await readFile(join(root, "openspec/changes", CHANGE, "feature.yaml"), "utf8"),
    ) as FeaturePlacement;
    const got = checkDeltas(d, await estateOf(root), p, [], { levels: LEVELS }).filter(
      (i) => i.rule === "delta.key-not-on-definition",
    );
    expect(got.map((i) => i.message)).toEqual([
      "Change 2 to forge-orders.unpin-note gives keys for forge-orders-db.order_pin, which change 2 to forge-orders.pin-note creates: give its keys on that step, the table's one definition.",
    ]);
  });

  it("the architecture prompt shows keys in its format, and the lenses get the merged target flows with the declared keys", async () => {
    const root = await pinRoot({ lenses: true });
    const drafter: string[] = [];
    const lens: string[] = [];
    const rt = new MockRuntime(
      (req: AiRequest) => {
        if (req.agent.id.endsWith("-critic")) {
          lens.push(req.pack.prompt);
          return "findings: []";
        }
        if (req.agent.id === EXPAND_AGENT) return "terms: []\nnames: []\n";
        drafter.push(req.pack.prompt);
        return draft("keys");
      },
      { now: () => NOW },
    );
    const r = await architectureStage(root, CHANGE, { runtime: rt, now: NOW });
    expect(r.state).toBe("done");
    expect(drafter[0]).toContain(
      "keys: { <a column it adds that references another table's row>: { references: <db>.<table>.<column>, onDelete: set-null | cascade | restrict | no-action } }",
    );
    expect(lens.length).toBeGreaterThan(0);
    expect(lens[0]).toContain(`id="${MERGED_FLOWS}"`);
    expect(lens[0]).toContain("2. write (added, change 2): The pin is saved");
    expect(lens[0]).toContain(
      "keys: order_id references forge-orders-db.orders.id, on delete cascade",
    );
    expect(lens[0]).toContain("read the order of a flow's steps from it");
  });
});
