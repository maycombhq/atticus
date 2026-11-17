import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkContracts,
  looseFieldClasses,
  parseFacts,
  type ContractCheckResult,
  type ContractSpecT,
  type Fact,
  type SpecFieldT,
} from "../src/index.js";

/**
 * A field's place in the payload, built from the facts (ADR 0164, addendum of 2026-11-17). The
 * invented forge-desk calls Forge Parcels' Shipments API (an invented outside system, its
 * OpenAPI spec taken in through intake). Both payloads are an envelope: `receipt` (a
 * receipt number and, in the answer, `stamps[]`) and `cargo`, which holds a list under a
 * name of its own. forge-desk's reader wrote each class's fields by their bare names, each cited
 * in the class's own file: nothing but a field's type says that Stamp's fields sit
 * at `receipt.stamps[]`. Nothing here is a real system.
 */

const FIX = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/contract-paths");
const REPO = "forge-desk";
const CALL = "call.post.forge-parcels-shipments";
const SPEC = "inputs/inbox/forge-parcels-shipments-v1.yaml";
const LIST = "cargo.shipments";

const fixtureFacts = (): Fact[] => {
  const p = parseFacts(readFileSync(join(FIX, "facts", `${REPO}.jsonl`), "utf8"));
  if (!p.ok) throw new Error(JSON.stringify(p.issues));
  return p.facts;
};

let at = 100;
const sf = (
  side: "request" | "response",
  name: string,
  type: string,
  required?: boolean,
): SpecFieldT => ({
  side,
  name,
  type,
  ...(required !== undefined ? { required } : {}),
  in: "body",
  at: `${SPEC}:${++at}`,
});

/** The spec's fields as intake reads them from the fixture's OpenAPI file (the CLI test reads the file). */
const STAMP = ["depot", "stampedAt", "clerk", "lane"];
const specFields = (): SpecFieldT[] => {
  at = 100;
  return [
    sf("request", "receipt", "object", true),
    sf("request", "receipt.receiptNo", "string", true),
    sf("request", "receipt.counter", "string", false),
    sf("request", "cargo", "object", true),
    sf("request", LIST, "array", true),
    sf("request", `${LIST}[].parcelId`, "string", true),
    sf("request", `${LIST}[].service`, "string", false),
    sf("request", `${LIST}[].declaredValue`, "number", false),
    sf("response", "receipt", "object", false),
    sf("response", "receipt.receiptNo", "string", false),
    sf("response", "receipt.stamps", "array", false),
    ...STAMP.map((s) => sf("response", `receipt.stamps[].${s}`, "string", false)),
    sf("response", "cargo", "object", false),
    sf("response", LIST, "array", false),
    sf("response", `${LIST}[].shipmentId`, "string", false),
    sf("response", `${LIST}[].weightGrams`, "number", false),
    sf("response", `${LIST}[].stamps`, "array", false),
    ...STAMP.map((s) => sf("response", `${LIST}[].stamps[].${s}`, "string", false)),
  ];
};

const operation = (fields: SpecFieldT[]): ContractSpecT => ({
  kind: "operation",
  format: "openapi",
  role: "consumer",
  file: SPEC,
  line: 9,
  method: "POST",
  path: "/parcels/v1/shipments",
  id: "forge-parcels.post.shipments",
  fields,
});

const check = (facts: Fact[], fields: SpecFieldT[] = specFields()): ContractCheckResult =>
  checkContracts({
    repos: [{ repo: REPO, facts }],
    join: { joins: [], asks: [], misses: [], lineage: [], gaps: [] },
    outside: [
      {
        system: "forge-parcels",
        name: "Forge Parcels Shipments API",
        specs: [operation(fields)],
      },
    ],
    vendorMatches: [
      {
        call: { repo: REPO, fact: CALL, component: REPO, at: "src/x:1" },
        vendor: "forge-parcels",
        how: "host",
        operation: "forge-parcels.post.shipments",
        method: "POST",
        path: "/parcels/v1/shipments",
      } as never,
    ],
  });

const said = (r: ContractCheckResult) =>
  r.findings.map((f) => `${f.status} ${f.kind} ${f.side} ${f.field}`);
const edit = (facts: Fact[], id: string, change: Record<string, unknown>): Fact[] =>
  facts.map((f) => (f.id === id ? ({ ...f, ...change } as Fact) : f));
const without = (facts: Fact[], ...ids: string[]) => facts.filter((f) => !ids.includes(f.id));
const more = (o: Record<string, unknown>): Fact =>
  ({
    kind: "field",
    repo: REPO,
    commit: "d4d0001",
    owner: CALL,
    verified: "line",
    by: "assistant",
    conf: "declared",
    ...o,
  }) as Fact;
const R = "src/main/java/forge/desk/parcels/model/response/";
const Q = "src/main/java/forge/desk/parcels/model/request/";

describe("a field's place in the payload, from the facts", () => {
  it("fields recorded bare, class by class, are compared at their place: no false mismatch", () => {
    const r = check(fixtureFacts());
    expect(said(r)).toEqual([
      "mismatch field-missing response receipt.depot_token",
      "unconfirmed field-not-sent request receipt",
      "unconfirmed field-not-sent request receipt.receiptNo",
      `mismatch field-type response ${LIST}[].weightGrams`,
    ]);
    expect(r.counts).toMatchObject({ mismatches: 2, unconfirmed: 2 });
    // None of the report's false lines: the stamps' fields are returned, nested.
    for (const f of r.findings) {
      expect(f.message).not.toMatch(/field (depot|stampedAt|clerk|lane) /);
      expect(f.message).not.toMatch(/requires the request field cargo/);
    }
  });

  it("a real difference is still reported, at its full path, with both lines", () => {
    const r = check(fixtureFacts());
    const token = r.findings.find((f) => f.field === "receipt.depot_token")!;
    expect(token.status).toBe("mismatch");
    expect(token.message).toBe(
      `forge-desk's call reads the response field receipt.depot_token (${R}ResponseReceipt.java:11), which Forge Parcels Shipments API's spec forge-parcels-shipments-v1.yaml never returns`,
    );
    const weight = r.findings.find((f) => f.kind === "field-type")!;
    expect(weight).toMatchObject({ status: "mismatch", field: `${LIST}[].weightGrams` });
    expect(weight.sender.at).toBe(`${R}Shipment.java:8`);
    expect(weight.message).toContain("is String in forge-desk's call");
    expect(weight.message).toContain("and number in Forge Parcels Shipments API's spec");
  });

  it("a class reached by two fields is at both places: a field the spec lacks at one is found there", () => {
    const fields = specFields().filter((f) => f.name !== `${LIST}[].stamps[].lane`);
    const r = check(fixtureFacts(), fields);
    const lane = r.findings.filter((f) => /lane$/.test(f.field ?? ""));
    expect(lane.map((f) => `${f.status} ${f.kind} ${f.field}`)).toEqual([
      `mismatch field-missing ${LIST}[].stamps[].lane`,
    ]);
    expect(lane[0]!.sender.at).toBe(`${R}Stamp.java:12`);
  });

  it("a type read from the cited line ties a class where the fact has no type", () => {
    // `stamps` of ResponseReceipt has no `type`: its line says List<Stamp>.
    const facts = fixtureFacts();
    const stamps = facts.find((f) => f.id === "field.response-receipt.stamps")!;
    expect("type" in stamps).toBe(false);
    const fields = specFields().filter((f) => f.name !== "receipt.stamps[].depot");
    expect(said(check(facts, fields))).toContain(
      "mismatch field-missing response receipt.stamps[].depot",
    );
  });

  it("a class nothing points at: what doesn't depend on its place is still a mismatch", () => {
    // The read left out `cargo` and the list inside it: Shipment hangs loose. The review
    // of the addendum: its weightGrams has one namesake in the spec, of another type family, and
    // `reviewer` is nowhere in the spec, wherever the class sits. (Both were pinned here as
    // unconfirmed at first; that hid real differences.)
    const facts = [
      ...without(
        fixtureFacts(),
        "field.shipments-response.cargo",
        "field.shipments-response-cargo.shipments",
        "field.shipment.stamps",
      ),
      more({
        id: "field.shipment.reviewer",
        side: "response",
        name: "reviewer",
        type: "String",
        cite: { file: `${R}Shipment.java`, line: 12, value: "reviewer" },
      }),
    ];
    const r = check(facts);
    expect(said(r).filter((x) => x.includes(" response "))).toEqual([
      "mismatch field-missing response receipt.depot_token",
      "mismatch field-missing response reviewer",
      "mismatch field-type response weightGrams",
    ]);
    // verify still notes the class it can't place.
    expect(looseFieldClasses(facts).map((l) => `${l.class}: ${l.why}`)).toEqual([
      "Shipment: Shipment is not reached from the response's fields",
    ]);
  });

  it("two unreached classes that each hold others are both roots: real differences stay mismatches", () => {
    // Shipment still holds `stamps`; ShipmentsResponse holds `receipt`.
    const facts = without(
      fixtureFacts(),
      "field.shipments-response.cargo",
      "field.shipments-response-cargo.shipments",
    );
    const resp = check(facts).findings.filter((f) => f.side === "response");
    expect(resp.filter((f) => f.status === "mismatch").map((f) => `${f.kind} ${f.field}`)).toEqual([
      "field-missing receipt.depot_token",
      "field-type weightGrams",
    ]);
    // Its `stamps` is the spec's one that `receipt.stamps` doesn't already account for.
    expect(resp.filter((f) => f.status === "unconfirmed")).toEqual([]);
  });

  it("a bare name several nested spec fields share is unconfirmed, not a mismatch", () => {
    // Nothing ties Stamp: no `stamps` field on record at all.
    const facts = without(fixtureFacts(), "field.response-receipt.stamps", "field.shipment.stamps");
    const r = check(facts);
    const rows = r.findings.filter((f) => STAMP.includes(f.field ?? ""));
    expect(rows.map((f) => f.status)).toEqual([
      "unconfirmed",
      "unconfirmed",
      "unconfirmed",
      "unconfirmed",
    ]);
    expect(rows[0]!.message).toContain(
      "2 fields of Forge Parcels Shipments API's spec forge-parcels-shipments-v1.yaml are named clerk, and nothing on record says which this one is",
    );
    expect(r.findings.filter((f) => f.status === "mismatch").map((f) => f.field)).toEqual([
      "receipt.depot_token",
      `${LIST}[].weightGrams`,
    ]);
  });

  it("a class that holds itself ends: its fields are placed once per level on record", () => {
    const facts = [
      ...fixtureFacts(),
      more({
        id: "field.stamp.causes",
        side: "response",
        name: "causes",
        type: "List<Stamp>",
        cite: { file: `${R}Stamp.java`, line: 14, value: "causes" },
      }),
    ];
    const fields = [
      ...specFields(),
      sf("response", "receipt.stamps[].causes", "array", false),
      sf("response", "receipt.stamps[].causes[].depot", "string", false),
      sf("response", `${LIST}[].stamps[].causes`, "array", false),
    ];
    const r = check(facts, fields);
    expect(said(r).filter((x) => /causes/.test(x))).toEqual([]);
    expect(r.findings.filter((f) => f.status === "mismatch")).toHaveLength(2);
  });

  it("two classes that hold each other and nothing else end, and no place is made up", () => {
    const loop = [
      fixtureFacts().find((f) => f.id === CALL)!,
      more({
        id: "field.ring-a.b",
        side: "response",
        name: "b",
        type: "RingB",
        cite: { file: `${R}RingA.java`, line: 3, value: "b" },
      }),
      more({
        id: "field.ring-b.a",
        side: "response",
        name: "a",
        type: "RingA",
        cite: { file: `${R}RingB.java`, line: 3, value: "a" },
      }),
      more({
        id: "field.ring-b.colour",
        side: "response",
        name: "colour",
        type: "String",
        cite: { file: `${R}RingB.java`, line: 4, value: "colour" },
      }),
    ];
    const r = check(loop);
    // Each by its own name: the spec has none of them anywhere, which is true wherever they sit.
    expect(r.findings.map((f) => `${f.status} ${f.field}`)).toEqual([
      "mismatch a",
      "mismatch b",
      "mismatch colour",
    ]);
    expect(looseFieldClasses(loop).map((l) => l.why)).toEqual([
      "RingA is reached only from classes it holds itself",
      "RingB is reached only from classes it holds itself",
    ]);
  });

  it("a name the read already wrote from the root isn't given its prefix twice", () => {
    // `depot_token` written as `receipt.depot_token`, no mapping; its siblings bare.
    const facts = edit(fixtureFacts(), "field.response-receipt.depot_token", {
      name: "receipt.depot_token",
      mappedTo: undefined,
      transform: undefined,
    }).map((f) => JSON.parse(JSON.stringify(f)) as Fact);
    const r = check(facts);
    expect(said(r)).toContain("mismatch field-missing response receipt.depot_token");
    expect(JSON.stringify(r.findings)).not.toContain("receipt.receipt.");
    expect(r.counts).toMatchObject({ mismatches: 2, unconfirmed: 2 });
  });

  it("a dotted name places itself only: its bare siblings keep their names and still find their fields", () => {
    // No `receipt` field on record; `receipt.depot_token` is written from the root.
    const facts = without(
      edit(fixtureFacts(), "field.response-receipt.depot_token", {
        name: "receipt.depot_token",
        mappedTo: undefined,
        transform: undefined,
      }).map((f) => JSON.parse(JSON.stringify(f)) as Fact),
      "field.shipments-response.receipt",
    );
    const r = check(facts);
    expect(said(r).filter((x) => x.startsWith("mismatch"))).toEqual([
      "mismatch field-missing response receipt.depot_token",
      `mismatch field-type response ${LIST}[].weightGrams`,
    ]);
    // `stamps[].depot` is the end of one spec path more than of the other: no finding.
    expect(r.findings.filter((f) => f.side === "response" && f.status === "unconfirmed")).toEqual(
      [],
    );
  });

  it("an envelope mapping and a type that name another parent disagree: unconfirmed", () => {
    // depot_token says it is inside `cargo`; its class is ResponseReceipt, under `receipt`.
    const facts = edit(fixtureFacts(), "field.response-receipt.depot_token", {
      mappedTo: "field.shipments-response.cargo",
      transform: "envelope cargo",
    });
    const f = check(facts).findings.find((x) => /depot_token$/.test(x.field ?? ""))!;
    expect(f.status).toBe("unconfirmed");
    expect(f.message).toContain("its place in the payload isn't on record");
  });

  it("a request recorded without its envelope: the required fields around it aren't called unsent", () => {
    const r = check(fixtureFacts());
    const req = r.findings.filter((f) => f.side === "request");
    // `cargo` and the list are sent: a field inside them is. `receipt` is unknown, not unsent.
    expect(req.map((f) => `${f.status} ${f.field}`)).toEqual([
      "unconfirmed receipt",
      "unconfirmed receipt.receiptNo",
    ]);
    expect(req[0]!.message).toMatch(
      /; unconfirmed: forge-desk's call's request fields on record don't start at the payload's root$/,
    );
  });

  it("a request recorded from its root: a required field it lacks is a mismatch", () => {
    const facts = [
      ...fixtureFacts(),
      more({
        id: "field.shipments-request.receipt",
        side: "request",
        name: "receipt",
        type: "RequestReceipt",
        cite: { file: `${Q}ShipmentsRequest.java`, line: 6, value: "receipt" },
      }),
      more({
        id: "field.shipments-request.cargo",
        side: "request",
        name: "cargo",
        type: "ShipmentsRequestCargo",
        cite: { file: `${Q}ShipmentsRequest.java`, line: 9, value: "cargo" },
      }),
      more({
        id: "field.shipments-request-cargo.orders",
        side: "request",
        name: "shipments",
        type: "List<ParcelOrder>",
        cite: { file: `${Q}ShipmentsRequestCargo.java`, line: 7, value: "x" },
      }),
      more({
        id: "field.request-receipt.counter",
        side: "request",
        name: "counter",
        type: "String",
        cite: { file: `${Q}RequestReceipt.java`, line: 6, value: "counter" },
      }),
    ];
    const req = check(facts).findings.filter((f) => f.side === "request");
    expect(req.map((f) => `${f.status} ${f.kind} ${f.field}`)).toEqual([
      "mismatch field-not-sent receipt.receiptNo",
    ]);
  });

  it("a sent field the spec has nowhere is still a mismatch, envelope or none", () => {
    const facts = [
      ...fixtureFacts(),
      more({
        id: "field.parcel-order.branch",
        side: "request",
        name: "branchCode",
        type: "String",
        cite: { file: `${Q}ParcelOrder.java`, line: 12, value: "branchCode" },
      }),
    ];
    expect(said(check(facts))).toContain("mismatch field-extra request branchCode");
  });

  it("gives the same findings in the same order whatever order the facts and the spec come in", () => {
    const want = JSON.stringify(check(fixtureFacts()));
    const facts = fixtureFacts();
    for (const turn of [3, 7, 11]) {
      const f = [...facts.slice(turn), ...facts.slice(0, turn)].reverse();
      const s = [...specFields().slice(turn), ...specFields().slice(0, turn)].reverse();
      expect(JSON.stringify(check(f, s))).toBe(want);
    }
  });
});
