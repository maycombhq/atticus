import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { MockRuntime, type AiRequest } from "@maycombhq/ai";
import { parseRecord, recordPath, serializeRecord, type CatalogRecord } from "@maycombhq/core";
import {
  architectureStage,
  estateOf,
  EXPAND_AGENT,
  featureStage,
  FlowDelta,
  loadEstate,
  storiesFromDeltas,
  storiesStage,
  storyCodeSource,
  taskContext,
} from "../src/index.js";

/**
 * What the stories bench run found (B-fixes): a task names the files its change goes into, from
 * the facts' citations (problem 2); the stories prompt carries the cited code, for an assistant
 * with no file tools (problem 3); a key-pattern store adds no column to a story (problem 4).
 * The Forge fraud check (fixtures/stages/stories/), with forge-orders' DTOs, entity and migration
 * folder (catalog-files.yaml).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "../../../fixtures/stages");
const STORIES_FIX = join(FIX, "stories");
const SPECS_CATALOG = join(HERE, "../../../fixtures/specs/catalog.yaml");
const NOW = new Date("2026-10-24T09:00:00Z");
const CHANGE = "add-fraud-check";
const fixture = (f: string) => readFileSync(join(STORIES_FIX, f), "utf8");

const rows = (withFiles: boolean) => [
  ...(parse(readFileSync(SPECS_CATALOG, "utf8")) as unknown[]),
  ...(parse(readFileSync(join(FIX, "catalog-extra.yaml"), "utf8")) as unknown[]),
  ...(withFiles ? (parse(fixture("catalog-files.yaml")) as unknown[]) : []),
];
const records = (withFiles = true): CatalogRecord[] =>
  rows(withFiles).map((r) => {
    const p = parseRecord(r);
    if (!p.ok) throw new Error(`bad fixture record: ${JSON.stringify(p.issues)}`);
    return p.record;
  });

async function root(withFiles = true): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "atticus-story-files-"));
  await mkdir(join(dir, "org-pack"), { recursive: true });
  for (const r of records(withFiles)) {
    const f = join(dir, "catalog/generated", recordPath(r));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(r));
  }
  for (const r of parse(readFileSync(join(FIX, "knowledge.yaml"), "utf8")) as unknown[]) {
    const p = parseRecord(r);
    if (!p.ok) throw new Error("bad knowledge record");
    const f = join(dir, "knowledge/items", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  await cp(join(FIX, "specs"), join(dir, "specs"), { recursive: true });
  await cp(join(FIX, "changes"), join(dir, "openspec/changes"), { recursive: true });
  return dir;
}

const deltas = (text = fixture("deltas.yaml")) =>
  (parse(text) as { flows: unknown[] }).flows.map((d) =>
    FlowDelta.parse({ schemaVersion: 2, ...(d as object) }),
  );

async function planned(withFiles = true) {
  const dir = await root(withFiles);
  const estate = await loadEstate(dir, records(withFiles));
  return { dir, estate, stories: storiesFromDeltas(deltas(), estate) };
}

/** forge-orders' checkout under workspace/, with the lines the facts cite. */
async function checkout(dir: string) {
  const file = async (path: string, lines: string[]) => {
    const f = join(dir, "workspace/forge-orders", path);
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, `${lines.join("\n")}\n`);
  };
  await file("src/main/java/forge/orders/OrderController.java", [
    "package forge.orders;",
    "",
    "@RestController",
    '@RequestMapping("/orders")',
    "class OrderController {",
    "  private final OrderRepository orders;",
    "",
    "  @PreAuthorize(\"hasRole('CLERK')\")",
    "  @PostMapping",
    "  ResponseEntity<OrderView> place(@Valid @RequestBody NewOrder body) {",
    "    stock.reserve(body.sku(), body.quantity());",
    "    Order order = new Order(body.sku(), body.quantity());",
    "    orders.save(order);",
    "    return ResponseEntity.status(201).body(OrderView.of(order));",
    "  }",
    "}",
  ]);
  await file("src/main/java/forge/orders/NewOrder.java", [
    "package forge.orders;",
    "",
    "record NewOrder(",
    "  // the order's lines",
    '  @NotBlank(message = "sku is required") String sku,',
    '  @Min(value = 1, message = "quantity must be at least 1") int quantity',
    ") {}",
  ]);
  await file("src/main/resources/schema.sql", [
    "CREATE TABLE orders (",
    "  id VARCHAR(36) PRIMARY KEY,",
    "  sku VARCHAR(40) NOT NULL,",
    "  quantity INT NOT NULL",
    ");",
  ]);
}

describe("a task names the files its change goes into (problem 2)", () => {
  it("from the fields' and the store's facts: the DTOs and spec, the table and entity, the migration's folder", async () => {
    const { stories } = await planned();
    const [callOut, branch, write] = stories[0]!.tasks;
    // the call-out sends the order's sku and quantity, and the new cardToken: the request DTO
    expect(callOut!.files).toEqual([
      {
        file: "forge-orders:src/main/java/forge/orders/NewOrder.java",
        lines: [5, 6],
        why: "where POST /orders' request fields are (forge-orders.post-orders.request: sku, quantity)",
      },
      {
        file: "forge-orders:src/main/resources/openapi.yaml",
        lines: [41],
        why: "where POST /orders' request fields are (forge-orders.post-orders.request: sku, quantity)",
      },
    ]);
    // a branch on the screen's verdict touches no declared field
    expect(branch!.files ?? []).toEqual([]);
    // the write adds fraud_verdict: the table's file and the entity beside its columns
    expect(write!.files).toEqual([
      {
        file: "forge-orders:src/main/resources/schema.sql",
        lines: [1],
        why: "where table forge-orders-db.orders and its columns are",
      },
      {
        file: "forge-orders:src/main/java/forge/orders/Order.java",
        lines: [14],
        why: "where table forge-orders-db.orders and its columns are",
      },
    ]);
    expect(write!.data?.migrationFile).toBe(
      "src/main/resources/db/migration/V4__add_fraud_verdict.sql",
    );
  });

  it("a validate step adding a request field names the entry's request DTO, a respond step its response's", async () => {
    const { estate } = await planned();
    const d = deltas(`flows:
  - flow: forge-orders.place-order
    repo: forge-orders
    change: modify
    why: The order carries a card token.
    steps:
      - op: add
        after: 1
        kind: validate
        what: cardToken is present
        fields: { checks: [cardToken] }
      - op: change
        step: 5
        kind: respond
        what: 201 Created with the order and its screening
        fields: { returns: [id, screening] }
`);
    const [validate, respond] = storiesFromDeltas(d, estate)[0]!.tasks;
    expect(validate!.files?.map((f) => [f.file, f.why])).toEqual([
      [
        "forge-orders:src/main/java/forge/orders/NewOrder.java",
        "where POST /orders' request fields are (forge-orders.post-orders.request)",
      ],
      [
        "forge-orders:src/main/resources/openapi.yaml",
        "where POST /orders' request fields are (forge-orders.post-orders.request)",
      ],
    ]);
    expect(respond!.files?.map((f) => f.file)).toEqual([
      "forge-orders:src/main/java/forge/orders/OrderView.java",
    ]);
  });

  it("names only what the facts cite: with no DTO or entity facts, the table's file alone", async () => {
    const { stories } = await planned(false);
    expect(stories[0]!.tasks.map((t) => (t.files ?? []).map((f) => f.file))).toEqual([
      [],
      [],
      ["forge-orders:src/main/resources/schema.sql"],
    ]);
  });

  it("the story file's files to touch and the task's context list them", async () => {
    const dir = await root();
    expect(
      (await featureStage(dir, CHANGE, { runtime: assistant(fixture("placed.yaml")), now: NOW }))
        .state,
    ).toBe("done");
    expect(
      (
        await architectureStage(dir, CHANGE, {
          runtime: assistant(fixture("deltas.yaml")),
          now: NOW,
        })
      ).state,
    ).toBe("done");
    expect(
      (await storiesStage(dir, CHANGE, { runtime: assistant(fixture("answer.yaml")), now: NOW }))
        .state,
    ).toBe("done");
    const story = await readFile(
      join(dir, "openspec/changes", CHANGE, "stories/s1-place-order.md"),
      "utf8",
    );
    expect(story).toContain(
      "- Files to touch: forge-orders:src/main/java/forge/orders/OrderController.java (lines 4 and 9), forge-orders:src/main/java/forge/orders/NewOrder.java (lines 5 and 6), forge-orders:src/main/resources/openapi.yaml (line 41)",
    );
    expect(story).toContain(
      "- Files to touch: forge-orders:src/main/java/forge/orders/OrderController.java (line 13), forge-orders:src/main/resources/schema.sql (line 1), forge-orders:src/main/java/forge/orders/Order.java (line 14), forge-orders:src/main/resources/db/migration/V4__add_fraud_verdict.sql (new migration)",
    );
    const c = await taskContext(dir, CHANGE, "1.3");
    expect(c.files).toContainEqual({
      path: "forge-orders:src/main/java/forge/orders/Order.java",
      line: 14,
      why: "where table forge-orders-db.orders and its columns are",
    });
  });
});

describe("the stories prompt carries the cited code (problem 3)", () => {
  it("each task's cited lines and the lines around them, numbered as in the file, from the checkout", async () => {
    const { dir, stories } = await planned();
    await checkout(dir);
    const s = await storyCodeSource(dir, stories, 4000);
    expect(s?.kind).toBe("code");
    expect(s!.text).toContain(
      "forge-orders:src/main/java/forge/orders/OrderController.java lines 1-16 (cited at 4, 9 and 13):",
    );
    expect(s!.text).toContain(`8:   @PreAuthorize("hasRole('CLERK')")`);
    expect(s!.text).toContain(
      "forge-orders:src/main/java/forge/orders/NewOrder.java lines 2-7 (cited at 5 and 6):",
    );
    expect(s!.text).toContain(
      '6:   @Min(value = 1, message = "quantity must be at least 1") int quantity',
    );
    expect(s!.text).toContain("forge-orders:src/main/resources/schema.sql lines 1-4 (cited at 1):");
    // a file the checkout doesn't have is said, not guessed
    expect(s!.text).toContain(
      "Not in the checkout: forge-orders:src/main/resources/openapi.yaml, forge-orders:src/main/java/forge/orders/Order.java.",
    );
  });

  it("keeps to its budget: the tasks' own lines first, then said how many places are left out", async () => {
    const { dir, stories } = await planned();
    await checkout(dir);
    const s = await storyCodeSource(dir, stories, 300);
    expect(s!.text).toContain("OrderController.java");
    expect(s!.text).not.toContain("schema.sql lines");
    expect(s!.text).toMatch(
      /\d+ more cited places? (is|are) left out to keep to the prompt's budget/,
    );
  });

  it("is left out with no checkout, so the prompt is as it was", async () => {
    const { dir, stories } = await planned();
    expect(await storyCodeSource(dir, stories, 4000)).toBeUndefined();
  });

  it("the stage puts it in the prompt when the repo is checked out", async () => {
    const dir = await root();
    await checkout(dir);
    expect(
      (await featureStage(dir, CHANGE, { runtime: assistant(fixture("placed.yaml")), now: NOW }))
        .state,
    ).toBe("done");
    expect(
      (
        await architectureStage(dir, CHANGE, {
          runtime: assistant(fixture("deltas.yaml")),
          now: NOW,
        })
      ).state,
    ).toBe("done");
    const prompts: string[] = [];
    expect(
      (
        await storiesStage(dir, CHANGE, {
          runtime: assistant(fixture("answer.yaml"), prompts),
          now: NOW,
        })
      ).state,
    ).toBe("done");
    expect(prompts[0]).toContain('kind="code"');
    expect(prompts[0]).toContain(`8:   @PreAuthorize("hasRole('CLERK')")`);
  });
});

describe("a key-pattern store adds no column to a story (problem 4)", () => {
  it("gives a write to a cache of carts no data change", async () => {
    const { estate } = await planned();
    const ev = [{ source: "code", repo: "forge-orders", path: "src/cache/carts.ts", line: 3 }];
    const cache = [
      {
        kind: "DataStore",
        schemaVersion: 3,
        id: "forge-orders-cache",
        status: "current",
        confidence: "verified",
        storeType: "key-value",
        entitiesHeld: ["cart"],
        evidence: ev,
      },
      {
        kind: "Table",
        schemaVersion: 3,
        id: "forge-orders-cache.cart",
        status: "current",
        confidence: "verified",
        dataStore: "forge-orders-cache",
        name: "cart",
        tableKind: "key-pattern",
        readers: [],
        writers: ["forge-orders"],
        evidence: ev,
      },
    ].map((r) => {
      const p = parseRecord(r);
      if (!p.ok) throw new Error(JSON.stringify(p.issues));
      return p.record;
    });
    const e = estateOf([...estate.records, ...cache], estate.flows);
    const d = deltas(
      fixture("deltas.yaml").replace(
        "store: { table: forge-orders-db.orders, columns: [sku, quantity, fraud_verdict], types: { fraud_verdict: varchar(20) }, classification: { fraud_verdict: internal }, migration: V4__add_fraud_verdict.sql }",
        "store: { table: forge-orders-cache.cart, columns: [items] }",
      ),
    );
    const write = storiesFromDeltas(d, e)[0]!.tasks[2]!;
    expect(write.store).toBe("forge-orders-cache.cart: items");
    expect(write.data).toBeUndefined();
  });
});

function assistant(draft: string, seen: string[] = []) {
  return new MockRuntime(
    (req: AiRequest) => {
      if (req.agent.id.endsWith("-critic")) return "findings: []";
      if (req.agent.id === EXPAND_AGENT)
        return "terms: [fraud screen, place order]\nnames:\n  - { name: Northwind Pay, id: northwind-pay, quote: screened by Northwind Pay }\n";
      seen.push(req.pack.prompt);
      return draft;
    },
    { now: () => NOW },
  );
}
