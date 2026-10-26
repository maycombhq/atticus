import { describe, expect, it } from "vitest";
import type { SourceInput } from "@maycombhq/ai";
import { diffLines, diffText, focusTerms, trimSources } from "../src/index.js";

/**
 * ADR 0115 addendum (2026-10-25, critic cost): a redraft's lenses see what changed since the last
 * reviewed draft, and each lens gets only the estate that bears on the draft and its question.
 */

const OLD = [
  "# Feature",
  "",
  "## Touches",
  "",
  "- Feature cap-ordering: Placing an order gains the screen.",
  "- Flow forge-orders.place-order (changed): The screen runs first.",
  "- Flow forge-stock.reserve-stock (read): Reserving waits for the screen.",
  "",
  "## Gaps",
  "",
  "- No call to Northwind Pay exists yet.",
  "",
].join("\n");
const NEW = OLD.replace(
  "forge-stock.reserve-stock (read): Reserving waits",
  "forge-stock.reserve-stock (changed): Reserving waits",
);

describe("what changed since the last reviewed draft", () => {
  it("maps each unchanged line to its line now, and names the changed ones", () => {
    const d = diffLines(OLD, `# Title\n${NEW}`);
    expect(d.changed).toBe(true);
    // Every old line moved down one; the flow line changed.
    expect(d.oldToNew.get(6)).toBe(7);
    expect(d.oldToNew.has(7)).toBe(false);
    expect([...d.addedNew].sort((a, b) => a - b)).toEqual([1, 8]);
  });

  it("writes the change as hunks with the lines' numbers now, removed lines marked", () => {
    const text = diffText(diffLines(OLD, NEW), { context: 1 });
    expect(text).toBe(
      [
        "@@ lines 6-8 now @@",
        "6: - Flow forge-orders.place-order (changed): The screen runs first.",
        "-: - Flow forge-stock.reserve-stock (read): Reserving waits for the screen.",
        "7: - Flow forge-stock.reserve-stock (changed): Reserving waits for the screen.",
        "8: ",
      ].join("\n"),
    );
  });

  it("says nothing changed for the same text", () => {
    expect(diffLines(OLD, OLD).changed).toBe(false);
  });
});

const ESTATE: SourceInput = {
  id: "estate-index",
  kind: "catalog",
  origin: "atticus change feature (context engine)",
  classification: "internal",
  text: [
    "The estate, from the repos' specs and the scanned catalog. Ids are exact.",
    "",
    "component forge-orders: system forge, repo forge-orders, service",
    "component forge-stock: system forge, repo forge-stock, service",
    "component forge-mail: system forge, repo forge-mail, service",
    'system northwind-pay "Northwind Pay" (vendor)',
    "flow forge-mail.send-receipt (repo forge-mail): sends the receipt. Steps: 1 entry; 2 respond",
    "flow forge-stock.reserve-stock (repo forge-stock): reserves stock. Steps: 1 entry; 2 respond",
    "flow forge-orders.place-order (repo forge-orders): places an order. Steps: 1 entry; 2 call-out",
    "endpoint forge-mail.post-receipts: forge-mail serves POST /receipts",
  ].join("\n"),
};
const KNOWLEDGE: SourceInput = {
  id: "knowledge",
  kind: "document",
  origin: "knowledge/items, selected",
  classification: "internal",
  text: [
    "The organisation's patterns, standards, decisions, processes and requests that may apply:",
    "",
    'process vendor-onboarding "Vendor onboarding": before a service sends data to a vendor; lead time 20 working days',
    'standard forge-mail-templates "Mail templates": every receipt uses the shared template',
  ].join("\n"),
};

describe("each lens's estate, sized to what bears on the draft and its question", () => {
  const focus = focusTerms(NEW);

  it("finds the ids and names the draft uses", () => {
    expect(focus).toEqual(
      expect.arrayContaining([
        "cap-ordering",
        "forge-orders.place-order",
        "forge-stock.reserve-stock",
        "forge-orders",
        "northwind pay",
      ]),
    );
  });

  it("keeps the header and the entries that name the draft's ids, and says what it left out", () => {
    const r = trimSources([ESTATE], { focus, question: "true", budget: 200_000 });
    const text = r.sources[0]!.text;
    expect(text).toContain("The estate, from the repos' specs");
    expect(text).toContain("flow forge-stock.reserve-stock");
    expect(text).toContain("system northwind-pay");
    expect(text).not.toContain("forge-mail");
    expect(text).toContain("(3 of 8 entries left out: they name nothing the draft names");
    expect(r.trimmed).toEqual([
      { source: "estate-index", from: expect.any(Number), to: expect.any(Number) },
    ]);
    expect(r.trimmed[0]!.to).toBeLessThan(r.trimmed[0]!.from);
  });

  it("keeps what the lens's question asks about: the ship lens gets a vendor's lead time", () => {
    const ship = trimSources([KNOWLEDGE], { focus, question: "ship", budget: 200_000 });
    expect(ship.sources[0]!.text).toContain("vendor-onboarding");
    const truth = trimSources([KNOWLEDGE], { focus, question: "true", budget: 200_000 });
    expect(truth.sources).toEqual([]);
    expect(truth.trimmed[0]).toMatchObject({ source: "knowledge", to: 0 });
  });

  it("ignores an id that names nearly everything (the system), so it doesn't keep it all", () => {
    const r = trimSources([ESTATE], { focus: ["forge"], question: "true", budget: 200_000 });
    expect(r.sources).toEqual([]);
  });

  it("leaves a source alone when it is all relevant and under the cap", () => {
    const small: SourceInput = { ...ESTATE, text: "component forge-orders: service" };
    const r = trimSources([small], { focus, question: "true", budget: 200_000 });
    expect(r.sources).toEqual([small]);
    expect(r.trimmed).toEqual([]);
  });

  it("caps each source at a share of the lens's budget", () => {
    const big: SourceInput = {
      ...ESTATE,
      text: Array.from(
        { length: 400 },
        (_, i) =>
          `flow forge-orders.f${i}: ${i % 2 ? "forge-orders.place-order" : "forge-mail.send-receipt"} calls step ${i} with a long description of what it does`,
      ).join("\n"),
    };
    const r = trimSources([big], { focus, question: "true", budget: 32_000 });
    expect(r.trimmed[0]!.to).toBeLessThanOrEqual(1_000 + 40);
    expect(r.sources[0]!.text).toMatch(/entries left out/);
  });
});
