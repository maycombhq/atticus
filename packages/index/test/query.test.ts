import { describe, expect, it } from "vitest";
import { parseQuery, QueryError } from "../src/query.js";

describe("the catalog query language", () => {
  it("parses field terms, lists of values, negation, has/missing, references and free text", () => {
    expect(
      parseQuery(
        'kind:interface via:gateway,direct -confidence:inferred has:pattern missing:auth refs:ledger-api refby:if-1 "audit svc" ledger',
      ),
    ).toEqual([
      { neg: false, type: "field", field: "kind", values: ["interface"] },
      { neg: false, type: "field", field: "via", values: ["gateway", "direct"] },
      { neg: true, type: "field", field: "confidence", values: ["inferred"] },
      { neg: false, type: "has", field: "pattern" },
      { neg: false, type: "missing", field: "auth" },
      { neg: false, type: "refs", values: ["ledger-api"] },
      { neg: false, type: "refby", values: ["if-1"] },
      { neg: false, type: "text", values: ["audit svc"] },
      { neg: false, type: "text", values: ["ledger"] },
    ]);
  });

  it("takes dotted fields, quoted values and wildcards", () => {
    expect(parseQuery('pattern.code:S.GW.* name:"Northwind Pay"')).toEqual([
      { neg: false, type: "field", field: "pattern.code", values: ["S.GW.*"] },
      { neg: false, type: "field", field: "name", values: ["Northwind Pay"] },
    ]);
  });

  it("an empty query matches everything", () => {
    expect(parseQuery("   ")).toEqual([]);
  });

  it.each([
    ["via:", /needs a value/],
    ["has:", /needs a field/],
    ["bad-field:x", /field names/],
    ['name:"open', /closing quote/],
    ["kind:nope", /Unknown kind "nope"/],
    ["-", /nothing after "-"/],
  ])("rejects %s with a message that points at the problem", (q, msg) => {
    expect(() => parseQuery(q)).toThrow(QueryError);
    expect(() => parseQuery(q)).toThrow(msg);
  });
});
