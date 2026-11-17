import { describe, expect, it } from "vitest";
import {
  checkContracts,
  declaredTypeOf,
  looseFieldClasses,
  newFindings,
  placeFields,
  type ContractCheckResult,
  type Fact,
  type FactOf,
  type SpecFieldT,
} from "../src/index.js";

/**
 * The review of the addendum of 2026-11-17 (ADR 0164): a check that goes quiet is worse than
 * one that over-reports. Each case is the reviewer's smallest input: the invented forge-desk's
 * call against an invented outside API's spec. Nothing here is a real system.
 */

type Field = FactOf<"field">;
const REPO = "forge-desk";
const CALL = "call.post.x";
let n = 0;
const F = (
  name: string,
  file: string,
  o: {
    side?: "request" | "response";
    type?: string;
    id?: string;
    quote?: string;
    x?: Record<string, unknown>;
  } = {},
): Field =>
  ({
    kind: "field",
    id:
      o.id ??
      `field.${file.split("/").pop()!.split(".")[0]!.toLowerCase()}.${name.toLowerCase().replace(/[^a-z0-9]/g, "_")}`,
    repo: REPO,
    commit: "abc1234",
    owner: CALL,
    side: o.side ?? "request",
    name,
    ...(o.type ? { type: o.type } : {}),
    cite: { file, line: ++n, value: name, ...(o.quote ? { quote: o.quote } : {}) },
    verified: "line",
    by: "assistant",
    conf: "declared",
    ...(o.x ?? {}),
  }) as Field;
const call = {
  kind: "call",
  id: CALL,
  repo: REPO,
  commit: "abc1234",
  callType: "rest",
  method: "POST",
  path: "/x",
  host: "h.example",
  cite: { file: "C.java", line: 1, value: "/x" },
  verified: "line",
  by: "assistant",
  conf: "declared",
} as Fact;
let at = 0;
const S = (
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
  at: `spec.yaml:${++at}`,
});
const check = (fields: Field[], spec: SpecFieldT[]): ContractCheckResult =>
  checkContracts({
    repos: [{ repo: REPO, facts: [call, ...fields] }],
    join: { joins: [], asks: [], misses: [], lineage: [], gaps: [] },
    outside: [
      {
        system: "v",
        name: "V API",
        specs: [
          {
            kind: "operation",
            format: "openapi",
            role: "consumer",
            file: "spec.yaml",
            line: 1,
            method: "POST",
            path: "/x",
            id: "v.post.x",
            fields: spec,
          },
        ],
      },
    ],
    vendorMatches: [
      {
        call: { repo: REPO, fact: CALL, component: REPO, at: "C.java:1" },
        vendor: "v",
        how: "host",
        operation: "v.post.x",
        method: "POST",
        path: "/x",
      } as never,
    ],
  });
const said = (r: ContractCheckResult) =>
  r.findings.map((f) => `${f.status} ${f.kind} ${f.field}`).sort();
const R = { side: "response" as const };
const env = { mappedTo: "field.r.data", transform: "envelope ApiResponse" };

describe("M1: several unreached classes that hold others are each a root", () => {
  it("an error body beside the success body: both differences are mismatches", () => {
    const r = check(
      [
        F("payload", "Resp.java", { ...R, type: "Payload" }),
        F("amount", "Payload.java", { ...R, type: "String" }),
        F("ghost", "Payload.java", { ...R, type: "String" }),
        F("errors", "ErrorResponse.java", { ...R, type: "List<ErrorItem>" }),
        F("code", "ErrorItem.java", { ...R, type: "String" }),
      ],
      [
        S("response", "payload", "object"),
        S("response", "payload.amount", "number"),
        S("response", "errors", "array"),
        S("response", "errors[].code", "string"),
      ],
    );
    expect(said(r)).toEqual([
      "mismatch field-missing payload.ghost",
      "mismatch field-type payload.amount",
    ]);
  });

  it("a base class that holds the envelope beside the class that extends it", () => {
    const fields = [
      F("receipt", "BaseResponse.java", { ...R, type: "Meta" }),
      F("id", "Meta.java", { ...R, type: "String" }),
      F("payload", "Resp.java", { ...R, type: "Payload" }),
      F("ghost", "Payload.java", { ...R, type: "String" }),
      F("amount", "Payload.java", { ...R, type: "String" }),
    ];
    const r = check(fields, [
      S("response", "receipt", "object"),
      S("response", "receipt.id", "string"),
      S("response", "payload", "object"),
      S("response", "payload.amount", "number"),
    ]);
    expect(said(r)).toEqual([
      "mismatch field-missing payload.ghost",
      "mismatch field-type payload.amount",
    ]);
    // Nothing to note: both hold classes, so both are roots.
    expect(looseFieldClasses([call, ...fields])).toEqual([]);
  });
});

describe("M2: a required part is sent only when a field the code places inside it is", () => {
  it("a root field that matches a field inside the part by its last segment doesn't send the part", () => {
    const r = check(
      [F("id", "Req.java", { type: "String" }), F("name", "Req.java", { type: "String" })],
      [
        S("request", "name", "string", true),
        S("request", "payload", "object", true),
        S("request", "payload.id", "string", true),
      ],
    );
    expect(said(r)).toEqual(["mismatch field-not-sent payload"]);
  });

  it("a field the code places inside the part does", () => {
    const r = check(
      [
        F("payload", "Req.java", { type: "Payload" }),
        F("id", "Payload.java", { type: "String" }),
        F("name", "Req.java", { type: "String" }),
      ],
      [
        S("request", "name", "string", true),
        S("request", "payload", "object", true),
        S("request", "payload.id", "string", true),
        S("request", "payload.amount", "number", true),
      ],
    );
    expect(said(r)).toEqual(["mismatch field-not-sent payload.amount"]);
  });
});

describe("M3: a doubt about place doesn't hide a difference that doesn't depend on place", () => {
  it("(a) a loose class's field with one namesake of another type family is a mismatch", () => {
    const r = check(
      [
        F("meta", "Resp.java", { ...R, type: "Meta" }),
        F("id", "Meta.java", { ...R, type: "String" }),
        F("weightGrams", "Shipment.java", { ...R, type: "String" }),
      ],
      [
        S("response", "meta", "object"),
        S("response", "meta.id", "string"),
        S("response", "payload.items[].weightGrams", "number"),
      ],
    );
    expect(said(r)).toEqual(["mismatch field-type weightGrams"]);
  });

  it("(b) a loose class's field the spec has under no name anywhere is a mismatch", () => {
    const r = check(
      [
        F("meta", "Resp.java", { ...R, type: "Meta" }),
        F("id", "Meta.java", { ...R, type: "String" }),
        F("reviewer", "Shipment.java", { ...R, type: "String" }),
      ],
      [S("response", "meta", "object"), S("response", "meta.id", "string")],
    );
    expect(said(r)).toEqual(["mismatch field-missing reviewer"]);
  });

  it("(c) a bare field cited in a client file beside nested DTOs is a mismatch when the spec lacks it", () => {
    const r = check(
      [
        F("meta", "Req.java", { type: "Meta" }),
        F("receiptNo", "Meta.java", { type: "String" }),
        F("page", "Client.java", { type: "int" }),
      ],
      [S("request", "meta", "object", true), S("request", "meta.receiptNo", "string", true)],
    );
    expect(said(r)).toEqual(["mismatch field-extra page"]);
  });

  it("stays unconfirmed where the place decides: a map's value class", () => {
    const r = check(
      [
        F("notes", "Resp.java", { ...R, type: "Map<String, Note>" }),
        F("text", "Note.java", { ...R, type: "String" }),
      ],
      [S("response", "notes", "object")],
    );
    expect(said(r)).toEqual(["unconfirmed field-missing notes.text"]);
  });
});

describe("S1: a class inside a generic type that isn't a list, an optional or a map", () => {
  it("Page<Item> with no Page on record: Item's fields are unplaced, not at items.id", () => {
    const r = check(
      [
        F("items", "Resp.java", { ...R, type: "Page<Item>" }),
        F("id", "Item.java", { ...R, type: "String" }),
      ],
      [
        S("response", "items", "object"),
        S("response", "items.content", "array"),
        S("response", "items.content[].id", "string"),
      ],
    );
    expect(r.findings.filter((f) => f.status === "mismatch")).toEqual([]);
  });

  it("Envelope<Order> with Envelope's own `T content` on record composes through it", () => {
    const fields = [
      F("data", "Resp.java", { ...R, type: "Envelope<Order>" }),
      F("content", "Envelope.java", { ...R, type: "T" }),
      F("id", "Order.java", { ...R, type: "String" }),
      F("ghost", "Order.java", { ...R, type: "String" }),
    ];
    const r = check(fields, [
      S("response", "data", "object"),
      S("response", "data.content", "object"),
      S("response", "data.content.id", "number"),
    ]);
    expect(said(r)).toEqual([
      "mismatch field-missing data.content.ghost",
      "mismatch field-type data.content.id",
    ]);
  });

  it("a wrapper that only passes its value on is no level: ResponseEntity<Body>, Optional<List<Item>>", () => {
    const p = placeFields(
      [
        F("body", "Resp.java", { ...R, type: "ResponseEntity<Body>" }),
        F("items", "Body.java", { ...R, type: "Optional<List<Item>>" }),
        F("id", "Item.java", R),
      ],
      "response",
    );
    expect(p.loose()).toEqual([]);
  });
});

describe("S2: fields of a nested class mapped to the envelope, as the field-types rule says", () => {
  it("are placed by their class under the envelope, with no clash", () => {
    const r = check(
      [
        F("data", "ApiResponse.java", { ...R, type: "T", id: "field.r.data" }),
        F("customer", "Order.java", { ...R, type: "Customer", x: env }),
        F("name", "Customer.java", { ...R, type: "String", x: env }),
        F("ghost", "Customer.java", { ...R, type: "String", x: env }),
      ],
      [
        S("response", "data", "object"),
        S("response", "data.customer", "object"),
        S("response", "data.customer.name", "string"),
      ],
    );
    expect(said(r)).toEqual(["mismatch field-missing data.customer.ghost"]);
  });
});

describe("S3: 'recorded without its envelope' needs more than one chance match", () => {
  it("one deeper namesake beside an unmatched field: the required fields are mismatches", () => {
    const r = check(
      [F("id", "Req.java", { type: "String" }), F("foo", "Req.java", { type: "String" })],
      [
        S("request", "a", "string", true),
        S("request", "b", "string", true),
        S("request", "customer.id", "string", false),
      ],
    );
    expect(said(r)).toEqual([
      "mismatch field-extra foo",
      "mismatch field-not-sent a",
      "mismatch field-not-sent b",
    ]);
  });
});

describe("S4: the cost of deep nesting", () => {
  it("places 8 layers of 4 classes, each holding the next layer, in well under a second", () => {
    const fs: Field[] = [];
    const L = 8;
    const W = 4;
    for (let l = 0; l < L; l++)
      for (let w = 0; w < W; w++) {
        const c = `L${l}W${w}`;
        for (let k = 0; k < 8; k++)
          fs.push(
            F(`f${k}`, `${c}.java`, { ...R, type: "String", id: `field.${c.toLowerCase()}.f${k}` }),
          );
        if (l + 1 < L)
          for (let w2 = 0; w2 < W; w2++)
            fs.push(
              F(`h${w2}`, `${c}.java`, {
                ...R,
                type: `L${l + 1}W${w2}`,
                id: `field.${c.toLowerCase()}.h${w2}`,
              }),
            );
      }
    for (let w = 0; w < W; w++)
      fs.push(F(`r${w}`, "Root.java", { ...R, type: `L0W${w}`, id: `field.root.r${w}` }));
    const t = Date.now();
    const p = placeFields(fs, "response");
    const deep = p.of(fs.find((f) => f.id === "field.l7w0.f0")!);
    for (const f of fs) p.of(f);
    expect(Date.now() - t).toBeLessThan(400);
    // More places than are kept: said, never silent.
    expect(deep.length).toBe(64);
    expect(deep.every((x) => /more places than/.test(x.unplaced ?? ""))).toBe(true);
  });
});

describe("depth: a chain of classes longer than is compared", () => {
  it("is placed down to the limit whatever class the ids put first, and says so beyond it", () => {
    const fs: Field[] = [];
    const N = 30;
    for (let c = 0; c < N; c++) {
      fs.push(F("v", `C${c}.java`, { ...R, type: "String", id: `field.c${c}.v` }));
      if (c + 1 < N)
        fs.push(F("next", `C${c}.java`, { ...R, type: `C${c + 1}`, id: `field.c${c}.next` }));
    }
    const names = (list: Field[]) => {
      const p = placeFields(list, "response");
      return fs.map((f) =>
        p
          .of(f)
          .map((x) => `${x.name}${x.decides ? " !" : ""}`)
          .join(";"),
      );
    };
    const got = names(fs);
    expect(got[fs.findIndex((f) => f.id === "field.c3.v")]).toBe("next.next.next.v");
    const deep = placeFields(fs, "response").of(fs.find((f) => f.id === "field.c25.v")!);
    expect(deep).toHaveLength(1);
    expect(deep[0]!.decides).toBe(true);
    expect(deep[0]!.unplaced).toMatch(/more than 10 levels deep/);
    expect(names([...fs].reverse())).toEqual(got);
  });
});

describe("a part the other side lists nothing inside", () => {
  it("is unknown, not different: a field the code places inside it is unconfirmed", () => {
    const r = check(
      [
        F("details", "Resp.java", { ...R, type: "Details" }),
        F("note", "Details.java", { ...R, type: "String" }),
        F("gone", "Resp.java", { ...R, type: "String" }),
      ],
      [S("response", "details", "object")],
    );
    expect(r.findings.map((f) => `${f.status} ${f.field}`)).toEqual([
      "unconfirmed details.note",
      "mismatch gone",
    ]);
    expect(r.findings[0]!.message).toMatch(
      /; unconfirmed: V API's spec spec\.yaml lists nothing inside details$/,
    );
  });
});

describe("S5: a wire name that isn't the name the line declares", () => {
  it("takes the type of the declaration the annotation sits on", () => {
    const d = (name: string, quote: string) =>
      declaredTypeOf({ name, cite: { file: "x", line: 1, value: name, quote } });
    expect(d("stamps", '@JsonProperty("stamps") private List<Stamp> stampLines;')).toBe(
      "List<Stamp>",
    );
    expect(
      d("status_lines", '@JsonProperty("status_lines") private List<Stamp> lines = null;'),
    ).toBe("List<Stamp>");
    expect(d("receipt", '@JsonProperty("receipt")')).toBeUndefined();
  });

  it("a parent recorded under its Java name still lets its children match their one namesake", () => {
    // `stampLines` on record for the wire's `stamps`: one wrong name, not one finding a child.
    const r = check(
      [
        F("stampLines", "Resp.java", { ...R, type: "List<Stamp>" }),
        F("depot", "Stamp.java", { ...R, type: "String" }),
        F("lane", "Stamp.java", { ...R, type: "String" }),
      ],
      [
        S("response", "stamps", "array"),
        S("response", "stamps[].depot", "string"),
        S("response", "stamps[].lane", "string"),
      ],
    );
    expect(said(r)).toEqual(["mismatch field-missing stampLines"]);
  });
});

describe("S6: a dotted name places itself only", () => {
  it("a bare field beside dotted ones in a client file keeps its own name", () => {
    const r = check(
      [
        F("meta.receiptNo", "Client.java", { ...R, type: "String", id: "field.c.a" }),
        F("bogus", "Client.java", { ...R, type: "String", id: "field.c.b" }),
        F("status", "Client.java", { ...R, type: "String", id: "field.c.c" }),
      ],
      [
        S("response", "meta.receiptNo", "string"),
        S("response", "status", "number"),
        S("response", "meta.status", "string"),
      ],
    );
    expect(said(r)).toEqual(["mismatch field-missing bogus", "mismatch field-type status"]);
  });
});

describe("words and bookkeeping", () => {
  it("a name several fields share says so, and doesn't say the place isn't on record", () => {
    const r = check(
      [
        F("status", "Resp.java", { ...R, type: "String" }),
        F("name", "Resp.java", { ...R, type: "String" }),
      ],
      [
        S("response", "name", "string"),
        S("response", "a.status", "string"),
        S("response", "b.status", "string"),
      ],
    );
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.status).toBe("unconfirmed");
    expect(r.findings[0]!.message).toMatch(
      /; unconfirmed: 2 fields of V API's spec spec\.yaml are named status, and nothing on record says which this one is$/,
    );
  });

  it("newFindings tells a finding by its full path: a break at payload.status isn't hidden by one at receipt.status", () => {
    const code = [
      F("receipt", "Resp.java", { ...R, type: "Meta" }),
      F("status", "Meta.java", { ...R, type: "String" }),
      F("payload", "Resp.java", { ...R, type: "Payload" }),
      F("status", "Payload.java", { ...R, type: "String" }),
      F("amount", "Payload.java", { ...R, type: "String" }),
    ];
    const old = [
      S("response", "receipt", "object"),
      S("response", "receipt.other", "string"),
      S("response", "payload", "object"),
      S("response", "payload.status", "string"),
      S("response", "payload.amount", "string"),
    ];
    // The newer spec drops payload.status too.
    const prev = check(code, old).findings;
    const next = check(
      code,
      old.filter((f) => f.name !== "payload.status"),
    ).findings;
    expect(prev.map((f) => f.field)).toEqual(["receipt.status"]);
    expect(newFindings(next, prev).map((f) => f.field)).toEqual(["payload.status"]);
  });

  it("looseFieldClasses leaves a mapper's dropped end out, as the check does", () => {
    const entry = {
      ...call,
      kind: "entry",
      id: "entry.post.x",
      entryType: "rest",
    } as unknown as Fact;
    const fields = [
      F("view", "Resp.java", { ...R, type: "OrderView" }),
      F("orderId", "OrderView.java", { ...R, type: "String", id: "field.v.order-id" }),
      // Outbound: `id` becomes `orderId`; the mapper's line is no class of the payload.
      F("id", "OrderMapper.java", {
        ...R,
        type: "String",
        x: { mappedTo: "field.v.order-id", transform: "MapStruct OrderMapper" },
      }),
    ].map((f) => ({ ...f, owner: "entry.post.x" }));
    expect(looseFieldClasses([entry, ...fields])).toEqual([]);
  });
});

describe("round 3, 1: a generic class used with two arguments", () => {
  const spec = (a: string, b: string, ta = "string", tb = "string") => [
    S("response", "customer", "object"),
    S("response", "customer.value", "object"),
    S("response", `customer.value.${a}`, ta),
    S("response", "account", "object"),
    S("response", "account.value", "object"),
    S("response", `account.value.${b}`, tb),
  ];
  const holders = [
    F("customer", "Resp.java", { ...R, type: "Result<Customer>" }),
    F("account", "Resp.java", { ...R, type: "Result<Account>" }),
    F("value", "Result.java", { ...R, type: "T" }),
  ];

  it("places each argument class under its own holder only", () => {
    const r = check(
      [
        ...holders,
        F("name", "Customer.java", { ...R, type: "String" }),
        F("iban", "Account.java", { ...R, type: "String" }),
      ],
      spec("name", "iban"),
    );
    expect(r.findings).toEqual([]);
  });

  it("a field of one name in both classes is compared with its own, type and all", () => {
    const fields = [
      ...holders,
      F("id", "Customer.java", { ...R, type: "String" }),
      F("id", "Account.java", { ...R, type: "Long" }),
    ];
    expect(check(fields, spec("id", "id", "string", "integer")).findings).toEqual([]);
    // And a real difference at one of them is found there.
    expect(said(check(fields, spec("id", "id", "string", "string")))).toEqual([
      "mismatch field-type account.value.id",
    ]);
  });
});

describe("round 3, 1b: a generic class with two type variables", () => {
  it("places neither argument through it: which variable is which isn't on record", () => {
    const r = check(
      [
        F("pair", "Resp.java", { ...R, type: "Pair<Customer, Account>" }),
        F("left", "Pair.java", { ...R, type: "L" }),
        F("right", "Pair.java", { ...R, type: "R" }),
        F("name", "Customer.java", { ...R, type: "String" }),
        F("iban", "Account.java", { ...R, type: "String" }),
      ],
      [
        S("response", "pair", "object"),
        S("response", "pair.left", "object"),
        S("response", "pair.left.name", "string"),
        S("response", "pair.right", "object"),
        S("response", "pair.right.iban", "string"),
      ],
    );
    expect(r.findings.filter((f) => f.status === "mismatch")).toEqual([]);
  });
});

describe("round 3, 2: a field whose place is sure matches at its place, or says where its name is", () => {
  it("(a) a root field isn't given the namesake its side doesn't claim: unconfirmed, and says where the name is", () => {
    // Pinned as a mismatch in the second review; the third found that a root borne out by one
    // chance match then made false mismatches of a whole class, so a name that is on the other
    // side elsewhere is never called missing outright.
    const code = [
      F("status", "Resp.java", { ...R, type: "String" }),
      F("a", "Resp.java", { ...R, type: "A" }),
      F("status", "A.java", { ...R, type: "String" }),
    ];
    for (const t of ["string", "integer"]) {
      const r = check(code, [
        S("response", "a", "object"),
        S("response", "a.status", "string"),
        S("response", "b", "object"),
        S("response", "b.status", t),
      ]);
      expect(said(r)).toEqual(["unconfirmed field-missing status"]);
      expect(r.findings[0]!.message).toMatch(/a field of that name is only at b\.status$/);
    }
  });

  it("(b) a nested field placed by type, its name only elsewhere in the spec: unconfirmed, and says where", () => {
    const r = check(
      [
        F("payload", "Resp.java", { ...R, type: "Payload" }),
        F("items", "Payload.java", { ...R, type: "List<Item>" }),
        F("status", "Item.java", { ...R, type: "String" }),
        F("sku", "Item.java", { ...R, type: "String" }),
      ],
      [
        S("response", "payload", "object"),
        S("response", "payload.items", "array"),
        S("response", "payload.items[].sku", "string"),
        S("response", "receipt", "object"),
        S("response", "receipt.stamps", "array"),
        S("response", "receipt.stamps[].status", "string"),
      ],
    );
    expect(said(r)).toEqual(["unconfirmed field-missing payload.items[].status"]);
    expect(r.findings[0]!.message).toMatch(
      /; unconfirmed: a field of that name is only at receipt\.stamps\[\]\.status$/,
    );
  });
});

describe("round 3, 4-6: doubts that reach too far", () => {
  it("4: a loose class's field at a path the spec has, with a namesake elsewhere: the type isn't called different", () => {
    const r = check(
      [
        F("payload", "Resp.java", { ...R, type: "Payload" }),
        F("amount", "Payload.java", { ...R, type: "String" }),
        F("x", "Loose.java", { ...R, type: "String" }),
      ],
      [
        S("response", "payload", "object"),
        S("response", "payload.amount", "string"),
        S("response", "x", "integer"),
        S("response", "payload.x", "string"),
      ],
    );
    expect(said(r)).toEqual(["unconfirmed field-type x"]);
  });

  it("5: a required field inside the prefix the sender's fields lack is missing wherever the root is", () => {
    const r = check(
      [F("id", "Data.java", { type: "String" }), F("foo", "Data.java", { type: "String" })],
      [
        S("request", "data", "object", true),
        S("request", "data.id", "string", true),
        S("request", "data.foo", "string", true),
        S("request", "data.other", "string", true),
        S("request", "top", "string", true),
      ],
    );
    expect(said(r)).toEqual([
      "mismatch field-not-sent data.other",
      "unconfirmed field-not-sent top",
    ]);
  });

  it("6: a part sent as a string has nothing inside it: the required field inside is a mismatch", () => {
    const r = check(
      [F("payload", "Req.java", { type: "String" }), F("id", "Req.java", { type: "String" })],
      [
        S("request", "id", "string", true),
        S("request", "payload", "object", true),
        S("request", "payload.amount", "number", true),
      ],
    );
    expect(said(r)).toContain("mismatch field-not-sent payload.amount");
  });
});

describe("round 3, 7: a class at many places", () => {
  const money = (n: number, extra: Field[] = [], currency = "string") => {
    const fs: Field[] = [F("order", "Resp.java", { ...R, type: "Order" })];
    const spec: SpecFieldT[] = [S("response", "order", "object")];
    for (let i = 0; i < n; i++) {
      fs.push(F(`m${i}`, "Order.java", { ...R, type: "Money" }));
      spec.push(
        S("response", `order.m${i}`, "object"),
        S("response", `order.m${i}.amount`, "number"),
        S("response", `order.m${i}.currency`, currency),
      );
    }
    fs.push(
      F("amount", "Money.java", { ...R, type: "BigDecimal" }),
      F("currency", "Money.java", { ...R, type: "String" }),
      ...extra,
    );
    return check(fs, spec);
  };

  it("fifteen places are all compared", () => {
    expect(money(15).findings).toEqual([]);
  });

  it("one fact that differs at each of its places is one finding that lists them", () => {
    const r = money(5, [F("ghost", "Money.java", { ...R, type: "String" })]);
    expect(said(r)).toEqual(["mismatch field-missing order.m0.ghost"]);
    expect(r.findings[0]!.message).toMatch(
      /never returns; the same at 4 more places: order\.m1\.ghost, order\.m2\.ghost, order\.m3\.ghost, order\.m4\.ghost$/,
    );
    expect(r.counts.mismatches).toBe(1);
    const types = money(15, [], "integer");
    expect(said(types)).toEqual(["mismatch field-type order.m0.currency"]);
    expect(types.findings[0]!.message).toContain("the same at 14 more places: order.m1.currency,");
  });

  it("beyond the limit, a field the spec has nowhere is still a mismatch", () => {
    const r = money(70, [F("ghost", "Money.java", { ...R, type: "String" })]);
    const ghost = r.findings.filter((f) => /ghost$/.test(f.field ?? ""));
    expect(ghost.map((f) => f.status)).toEqual(["mismatch"]);
  });
});

describe("round 3, 8: an array the other side lists nothing inside", () => {
  it("says what isn't recorded: what its items are", () => {
    const r = check(
      [
        F("tags", "Resp.java", { ...R, type: "List<Tag>" }),
        F("label", "Tag.java", { ...R, type: "String" }),
      ],
      [S("response", "tags", "array")],
    );
    expect(said(r)).toEqual(["unconfirmed field-missing tags[].label"]);
    expect(r.findings[0]!.message).toMatch(
      /; unconfirmed: what the items of tags are isn't recorded for V API's spec spec\.yaml$/,
    );
  });
});

describe("third review", () => {
  const cargo = (side: "request" | "response") => [
    F("id", "Cargo.java", { side, type: "String" }),
    F("weight", "Cargo.java", { side, type: "BigDecimal" }),
    F("unit", "Cargo.java", { side, type: "String" }),
    F("crates", "Cargo.java", { side, type: "List<Crate>" }),
    F("label", "Crate.java", { side, type: "String" }),
  ];
  const spec = (side: "request" | "response", required?: boolean) => [
    S(side, "id", "string", required),
    S(side, "data", "object", required),
    S(side, "data.id", "string", required),
    S(side, "data.weight", "number", required),
    S(side, "data.unit", "string", required),
    S(side, "data.crates", "array", required),
    S(side, "data.crates[].label", "string", required),
  ];

  it("M1: a class borne out as the root by one chance match makes no mismatch of its other fields", () => {
    // Nothing holds Cargo; the spec has its fields under `data`, and a root `id` of its own.
    const r = check(cargo("response"), spec("response"));
    expect(r.findings.filter((f) => f.status === "mismatch")).toEqual([]);
    for (const f of r.findings) expect(f.message).toMatch(/a field of that name is only at data\./);
  });

  it("M1: on the request side the one mismatch is the part nothing sends, as before the addendum", () => {
    const r = check(cargo("request"), spec("request", true));
    expect(r.findings.filter((f) => f.status === "mismatch").map((f) => f.field)).toEqual(["data"]);
  });

  it("M2: a place newly dropped by a newer spec is new, though its fact's finding lists it", () => {
    const code = [
      F("order_id", "Resp.java", { ...R, type: "String" }),
      F("billing", "Resp.java", { ...R, type: "Address" }),
      F("shipping", "Resp.java", { ...R, type: "Address" }),
      F("city", "Address.java", { ...R, type: "String" }),
      F("zip", "Address.java", { ...R, type: "String" }),
    ];
    const full = [
      S("response", "order_id", "string"),
      S("response", "billing", "object"),
      S("response", "billing.city", "string"),
      S("response", "billing.zip", "string"),
      S("response", "shipping", "object"),
      S("response", "shipping.city", "string"),
      S("response", "shipping.zip", "string"),
    ];
    const prev = check(
      code,
      full.filter((f) => f.name !== "billing.city"),
    ).findings;
    const next = check(
      code,
      full.filter((f) => !f.name.endsWith(".city")),
    ).findings;
    expect(prev.map((f) => f.field)).toEqual(["billing.city"]);
    expect(next.map((f) => f.field)).toEqual(["billing.city"]);
    expect(next[0]!.message).toContain("the same at 1 more place: shipping.city");
    expect(newFindings(next, prev).map((f) => f.field)).toEqual(["billing.city"]);
    // Nothing new when the newer spec drops nothing more, and the other way round.
    expect(newFindings(next, next)).toEqual([]);
    expect(newFindings(prev, next)).toEqual([]);
    // A finding that didn't come from this run's check (read back, copied) has no places on
    // record: it only vouches for its own field, so the place it may have listed is new.
    expect(
      newFindings(
        prev,
        next.map((f) => ({ ...f })),
      ),
    ).toEqual([]);
    expect(
      newFindings(
        next,
        prev.map((f) => ({ ...f })),
      ).map((f) => f.field),
    ).toEqual(["billing.city"]);
  });

  it("S1: a type that differs on a pair matched under another parent name is unconfirmed", () => {
    const r = check(
      [
        F("stampLines", "Resp.java", { ...R, type: "List<Stamp>" }),
        F("depot", "Stamp.java", { ...R, type: "String" }),
      ],
      [S("response", "stamps", "array"), S("response", "stamps[].depot", "integer")],
    );
    expect(said(r)).toEqual([
      "mismatch field-missing stampLines",
      "unconfirmed field-type stampLines[].depot",
    ]);
    expect(r.findings.find((f) => f.kind === "field-type")!.message).toMatch(
      /; unconfirmed: matched under another parent name \(stamps\[\]\.depot\)$/,
    );
  });

  it("S2: a request spec of thousands of required fields is checked in linear time", () => {
    const spec: SpecFieldT[] = [];
    for (let p = 0; p < 40; p++) {
      spec.push(S("request", `part${p}`, "object", true));
      for (let k = 0; k < 178; k++) spec.push(S("request", `part${p}.f${k}`, "string", true));
    }
    // The call sends half of it, each field recorded by its path.
    const code: Field[] = [];
    for (let p = 0; p < 20; p++) {
      code.push(F(`part${p}`, "Req.java", { type: "object", id: `field.req.part${p}` }));
      for (let k = 0; k < 178; k++)
        code.push(F(`part${p}.f${k}`, "Req.java", { type: "String", id: `field.req.p${p}f${k}` }));
    }
    expect(spec).toHaveLength(7160);
    const t = Date.now();
    const r = check(code, spec);
    expect(Date.now() - t).toBeLessThan(1500);
    // The 20 other parts and every field of theirs are not sent.
    expect(r.counts).toMatchObject({ mismatches: 3580, unconfirmed: 0 });
  });
});
