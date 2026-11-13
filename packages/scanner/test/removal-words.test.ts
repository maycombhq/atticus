import { describe, expect, it } from "vitest";
import type { CatalogRecord } from "@maycombhq/core";
import { rekeyedWords } from "../src/build.js";

/**
 * beta.28 (the review of fix/b28-field): what a removal says it is to its own record. "Comes back
 * as" only where exactly one record of the last build and one of this build are that thing, by
 * the identity fields its kind lists; never by a name alone, never by the order of the records.
 */
const rec = (kind: string, id: string, o: Record<string, unknown> = {}) =>
  ({
    kind,
    id,
    schemaVersion: 5,
    status: "current",
    confidence: "verified",
    evidence: [],
    ...o,
  }) as unknown as CatalogRecord;
const arrow = (id: string, o: Record<string, unknown> = {}) =>
  rec("Interface", id, {
    from: "checkout-api",
    to: "payments-api",
    via: "http",
    direction: "outbound",
    method: "GET",
    normalizedPath: "/payments/{}",
    sync: "sync",
    ...o,
  });
const comp = (id: string, o: Record<string, unknown> = {}) =>
  rec("Component", id, {
    system: "payments",
    repo: "forge-payments",
    path: "src",
    type: "service",
    ...o,
  });
const words = (before: CatalogRecord[], after: CatalogRecord[]) =>
  Object.fromEntries(rekeyedWords(before, after));

describe("what a removal is to its record (beta.28 review)", () => {
  it("says a record comes back under another id when one each side is that thing", () => {
    expect(words([arrow("if-old")], [arrow("if-new")])).toEqual({
      "Interface/if-old": "comes back as Interface/if-new",
    });
    // Through a component that came back under another id.
    expect(
      words(
        [comp("payments-svc"), arrow("if-old", { to: "payments-svc" })],
        [comp("payments-api"), arrow("if-new")],
      ),
    ).toEqual({
      "Component/payments-svc": "comes back as Component/payments-api",
      "Interface/if-old": "comes back as Interface/if-new",
    });
  });

  it("matches arrows that differ only by how they call (via, direction) to nothing", () => {
    expect(words([arrow("if-old", { via: "kafka" })], [arrow("if-new")])).toEqual({});
    expect(words([arrow("if-old", { direction: "inbound" })], [arrow("if-new")])).toEqual({});
  });

  it("says nothing where two records of either side are that thing", () => {
    // Two components at the same repo, path and type: which one came back isn't known.
    expect(words([comp("a"), comp("b")], [comp("c")])).toEqual({});
    expect(words([comp("a")], [comp("b"), comp("c")])).toEqual({});
  });

  it("matches a table by its store and name, and nothing by a name alone", () => {
    const t = (id: string, dataStore: string) =>
      rec("Table", id, {
        dataStore,
        name: "payments",
        tableKind: "table",
        readers: [],
        writers: [],
      });
    expect(words([t("t-old", "ledger-db")], [t("t-new", "refunds-db")])).toEqual({});
    expect(words([t("t-old", "ledger-db")], [t("t-new", "ledger-db")])).toEqual({
      "Table/t-old": "comes back as Table/t-new",
    });
    // A kind whose identity isn't listed is never matched, even by its name.
    const term = (id: string) => rec("GlossaryTerm", id, { name: "payment" });
    expect(words([term("term.pay")], [term("term.payment")])).toEqual({});
  });

  it("says an arrow's call goes elsewhere only where one new arrow takes it", () => {
    expect(words([arrow("if-old")], [arrow("if-new", { to: "northwind-pay" })])).toEqual({
      "Interface/if-old": "its call goes to northwind-pay now (Interface/if-new)",
    });
    expect(
      words(
        [arrow("if-old")],
        [arrow("if-a", { to: "northwind-pay" }), arrow("if-b", { to: "refunds-api" })],
      ),
    ).toEqual({});
  });

  it("says the same whatever order the records come in", () => {
    const before = [
      comp("payments-svc"),
      arrow("if-old", { to: "payments-svc" }),
      comp("x", { path: "y" }),
    ];
    const after = [arrow("if-new"), comp("payments-api"), comp("x", { path: "y" })];
    const one = [...rekeyedWords(before, after)];
    const two = [...rekeyedWords([...before].reverse(), [...after].reverse())];
    expect(new Map(two)).toEqual(new Map(one));
  });
});
