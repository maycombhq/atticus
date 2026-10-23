import { describe, expect, it } from "vitest";
import {
  FILTER_PLACEHOLDER,
  filterDescription,
  filterItems,
  filterTree,
  filterWords,
  itemText,
  noMatchRow,
  RESOLVED_BELOW,
} from "../src/filter";
import type { Item } from "../src/sidebar-data";

/**
 * ADR 0105 addendum: a filter wherever a list grows. One box, the same words in both surfaces,
 * matching an item's title, id, change and repo, case-insensitively. A matching parent keeps its
 * children; a parent shows when any child matches. The invented Forge ecosystem only.
 */

type Row = Item & { rows?: Row[] };

const ROWS: Row[] = [
  {
    id: "waiting:change:add-note-tags",
    label: "Add tags to notes",
    description: "add-note-tags · 2 waiting",
    rows: [
      { id: "need:add-note-tags:request-kafka-topic:change", label: "Request a Kafka topic" },
      { id: "finding:add-note-tags:f-2", label: "The tags table has no owner" },
    ],
  },
  {
    id: "waiting:change:northwind-refunds",
    label: "Refunds through Northwind Pay",
    rows: [
      {
        id: "todo:northwind-refunds/step-2",
        label: "Add the refunds account to the ledger",
        words: ["forge-ledger"],
      },
      { id: "todo:northwind-refunds/step-1", label: "Turn on refunds in the console" },
    ],
  },
  { id: "waiting:knowledge", label: "Knowledge to verify", description: "2 items" },
];

const kids = { kids: (r: Row) => r.rows, withKids: (r: Row, rows: Row[]) => ({ ...r, rows }) };
const tree = (rows: Row[]): unknown =>
  rows.map((r) => (r.rows ? { [r.label]: tree(r.rows) } : r.label));

describe("the filter's words (ADR 0105)", () => {
  it("says the same words as the app", () => {
    expect(FILTER_PLACEHOLDER).toBe("Words to match, for example forge-ledger");
  });

  it("splits on spaces, case-insensitively, and ignores empty words", () => {
    expect(filterWords("  Forge-Ledger   REFUNDS ")).toEqual(["forge-ledger", "refunds"]);
    expect(filterWords("   ")).toEqual([]);
  });

  it("shows the filter in the view's description, and nothing without one", () => {
    expect(filterDescription(" forge-ledger ")).toBe("filter: forge-ledger");
    expect(filterDescription("")).toBeUndefined();
  });

  it("matches a row's title, id, change and repo, and the words it shows beside them", () => {
    const need: Item = {
      id: "need:add-note-tags:request-kafka-topic:change",
      label: "Request a Kafka topic",
      description: "for the change · Platform team",
      need: { change: "add-note-tags", item: "request-kafka-topic" } as never,
    };
    const t = itemText(need);
    for (const w of ["request a kafka", "add-note-tags", "request-kafka-topic", "platform team"])
      expect(t).toContain(w);
    const finding: Item = {
      id: "f",
      label: "x",
      finding: { change: "northwind-refunds", id: "f-9" } as never,
    };
    expect(itemText(finding)).toContain("northwind-refunds");
    expect(itemText({ id: "s", label: "y", source: "forge-wiki" })).toContain("forge-wiki");
    expect(itemText({ id: "t", label: "z", task: { change: "c-1", id: "t-4" } })).toContain("t-4");
  });
});

describe("filtering a tree of rows (ADR 0105)", () => {
  it("keeps everything without words", () => {
    expect(filterTree(ROWS, "  ", { text: itemText, ...kids })).toBe(ROWS);
  });

  it("keeps a matching parent with all its children", () => {
    expect(tree(filterTree(ROWS, "NOTE-TAGS", { text: itemText, ...kids }))).toEqual([
      { "Add tags to notes": ["Request a Kafka topic", "The tags table has no owner"] },
    ]);
  });

  it("shows a parent when any child matches, with only the children that match", () => {
    expect(tree(filterTree(ROWS, "forge-ledger", { text: itemText, ...kids }))).toEqual([
      { "Refunds through Northwind Pay": ["Add the refunds account to the ledger"] },
    ]);
  });

  it("needs every word, each anywhere in the row", () => {
    expect(tree(filterTree(ROWS, "kafka add-note-tags", { text: itemText, ...kids }))).toEqual([
      { "Add tags to notes": ["Request a Kafka topic"] },
    ]);
    expect(filterTree(ROWS, "kafka northwind", { text: itemText, ...kids })).toEqual([]);
  });
});

describe("a filtered list (ADR 0105)", () => {
  const clear = "atticus.clearFilterWaiting";

  it("is the list itself when something matches", () => {
    expect(tree(filterItems(ROWS, "knowledge", "Waiting on you", clear, kids))).toEqual([
      "Knowledge to verify",
    ]);
  });

  it("says what was filtered in one row when nothing matches, clearing the filter when clicked", () => {
    const rows = filterItems(ROWS, "forge-billing", "Waiting on you", clear, kids);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(noMatchRow("forge-billing", "Waiting on you", clear));
    expect(rows[0]).toMatchObject({
      label: "Nothing in Waiting on you matches “forge-billing”",
      command: { command: clear },
      icon: "filter",
    });
    expect(rows[0]!.description).toMatch(/clear the filter/i);
  });

  it("looks below the Knowledge section's groups, which are read with it, and not below a change", () => {
    for (const k of ["sources", "knowledge-items", "knowledge-group", "last-scan", "finds", "find"])
      expect(RESOLVED_BELOW.has(k as never), k).toBe(true);
    for (const k of ["change", "repo", "kind", "evidence"])
      expect(RESOLVED_BELOW.has(k as never), k).toBe(false);
  });
});
