import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { EstateJoins, parseRecord, type CatalogRecord, type FlowRecord } from "@maycombhq/core";
import {
  estateFlow,
  fieldLineage,
  flattenEstateFlow,
  joinEstate,
  type EstateSpec,
} from "../src/estate.js";
import { pathScore } from "../src/spec-check.js";

const ESTATE = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/estate");
const records = (): CatalogRecord[] =>
  (parse(readFileSync(join(ESTATE, "catalog.yaml"), "utf8")) as unknown[]).map((r) => {
    const p = parseRecord(r);
    if (!p.ok) throw new Error(JSON.stringify(p.issues));
    return p.record;
  });
const specs = (): EstateSpec[] =>
  ["forge-customers", "forge-web"].map((repo) => ({
    repo,
    flows: readdirSync(join(ESTATE, "specs", repo))
      .filter((n) => n.endsWith(".yaml"))
      .sort()
      .map((n) => {
        const p = parseRecord(parse(readFileSync(join(ESTATE, "specs", repo, n), "utf8")));
        if (!p.ok || p.record.kind !== "Flow") throw new Error(`${n} isn't a flow`);
        return p.record;
      }),
  }));
const expected = () =>
  EstateJoins.parse(parse(readFileSync(join(ESTATE, "expected", "estate.yaml"), "utf8")));

// The owners part of the estate (ADR 0088), on top of the base fixture.
const OWNERS = join(ESTATE, "owners");
const withOwners = () => ({
  records: [
    ...records(),
    ...(parse(readFileSync(join(OWNERS, "catalog.yaml"), "utf8")) as unknown[]).map((r) => {
      const p = parseRecord(r);
      if (!p.ok) throw new Error(JSON.stringify(p.issues));
      return p.record;
    }),
  ],
  specs: specs().map((s) => ({
    ...s,
    flows: [
      ...s.flows,
      ...readdirSync(join(OWNERS, "specs", s.repo))
        .sort()
        .map((n) => {
          const p = parseRecord(parse(readFileSync(join(OWNERS, "specs", s.repo, n), "utf8")));
          if (!p.ok || p.record.kind !== "Flow") throw new Error(`${n} isn't a flow`);
          return p.record;
        }),
    ],
  })),
});
const expectedOwners = () =>
  EstateJoins.parse(parse(readFileSync(join(OWNERS, "expected", "estate.yaml"), "utf8")));

describe("pathScore", () => {
  it("matches the same path, or a tail with a plain segment, and topics by name", () => {
    expect(pathScore("/api/customers/{id}", "/api/customers/{customerId}")).toBe(1000);
    expect(pathScore("/api/customers/{id}", "/customers/{customerId}")).toBe(2);
    expect(pathScore("/api/customers/{id}/points", "/customers/{customerId}")).toBe(0);
    expect(pathScore("/api/{id}", "/{id}")).toBe(0);
    expect(pathScore("customer-created", "Customer-Created")).toBe(1000);
  });
});

describe("joinEstate (ADR 0085)", () => {
  it("joins through an Interface and by path, and says why the others aren't", async () => {
    const r = await joinEstate({ specs: specs(), records: records() });
    const want = expected();
    expect(r.joins).toEqual(want.joins);
    expect(r.unmatched).toEqual(want.unmatched);
  });

  it("finds the Interface from the caller to the target when the step doesn't name it", async () => {
    const s = specs().map((x) => ({
      ...x,
      flows: x.flows.map((f) => ({ ...f, steps: f.steps.map((st) => ({ ...st, refs: [] })) })),
    }));
    const r = await joinEstate({ specs: s, records: records() });
    expect(r.joins).toEqual(expected().joins);
  });

  it("needs a citation at both ends", async () => {
    const r = await joinEstate({
      specs: specs(),
      records: records(),
      // The callee's trigger line is gone from its file.
      cited: async (repo, _path, line) => !(repo === "forge-customers" && line === 10),
    });
    expect(r.joins.map((j) => j.to.flow)).toEqual(["forge-customers.get-customer"]);
    expect(r.unmatched.find((u) => u.from.flow === "forge-web.save-customer")).toMatchObject({
      reason: "no-citation",
      trigger: "forge-customers.post-customer",
      message:
        "the trigger of forge-customers.create-customer cites no file and line that exists, so the join has no citation at both ends",
    });
  });

  it("says when the target component isn't in the catalog", async () => {
    const s = specs();
    const web = s.find((x) => x.repo === "forge-web")!;
    const f = web.flows.find((x) => x.id === "forge-web.remove-customer")!;
    const moved: FlowRecord = {
      ...f,
      steps: [{ ...f.steps[0]!, to: { component: "forge-loyalty", entry: "GET /points" } }],
    };
    const r = await joinEstate({
      specs: [{ repo: "forge-web", flows: [moved] }],
      records: records(),
    });
    expect(r.unmatched).toMatchObject([
      {
        reason: "no-target",
        message:
          "forge-loyalty isn't a component in the catalog, and neither an Interface from forge-web nor an entry point of the estate serves GET /points",
      },
    ]);
    expect(r.inferred).toEqual([]);
  });
});

// The join fallback (ADR 0124 addendum C-join): a call whose target the catalog doesn't have.
const RELATIVE = join(ESTATE, "relative");
const relative = () => ({
  records: (parse(readFileSync(join(RELATIVE, "catalog.yaml"), "utf8")) as unknown[]).map((r) => {
    const p = parseRecord(r);
    if (!p.ok) throw new Error(JSON.stringify(p.issues));
    return p.record;
  }),
  specs: ["forge-archive", "forge-notes"].map((repo) => ({
    repo,
    flows: readdirSync(join(RELATIVE, "specs", repo))
      .sort()
      .map((n) => {
        const p = parseRecord(parse(readFileSync(join(RELATIVE, "specs", repo, n), "utf8")));
        if (!p.ok || p.record.kind !== "Flow") throw new Error(`${n} isn't a flow`);
        return p.record;
      }),
  })),
});
const expectedRelative = () =>
  EstateJoins.parse(parse(readFileSync(join(RELATIVE, "expected", "estate.yaml"), "utf8")));

describe("joinEstate: a target the catalog doesn't have (ADR 0124 addendum C-join)", () => {
  it("joins by method and path to the one entry point that serves it, its own repo first, and asks when two could", async () => {
    const r = await joinEstate(relative());
    const want = expectedRelative();
    expect(r.joins).toEqual(want.joins);
    expect(r.unmatched).toEqual(want.unmatched);
  });

  it("marks each such join inferred and says why", async () => {
    const r = await joinEstate(relative());
    expect(r.inferred).toEqual([
      {
        from: { repo: "forge-notes", flow: "forge-notes-web.open-note", step: 1 },
        named: "notes-service",
        within: "repo",
        message:
          "forge-notes-web.open-note step 1 names notes-service, which isn't a component in the catalog: joined by method and path to forge-notes.get-note, the only entry point of its own repo (forge-notes) that serves GET /api/notes/{id}",
      },
      {
        from: { repo: "forge-notes", flow: "forge-notes-web.open-note", step: 2 },
        named: "notes-service",
        within: "estate",
        message:
          "forge-notes-web.open-note step 2 names notes-service, which isn't a component in the catalog: joined by method and path to forge-archive.list-tags, the only entry point of the estate that serves GET /api/tags",
      },
      {
        from: { repo: "forge-notes", flow: "forge-notes-web.open-note", step: 4 },
        named: "unresolved.c-save-note",
        within: "repo",
        message:
          "forge-notes-web.open-note step 4 names unresolved.c-save-note, which isn't a component in the catalog: joined by method and path to forge-notes.create-note, the only entry point of its own repo (forge-notes) that serves POST /api/notes",
      },
    ]);
  });

  it("gives what to ask a person when two components could answer, and joins the one a person names", async () => {
    const r = await joinEstate(relative());
    expect(r.asks).toEqual([
      {
        from: {
          repo: "forge-notes",
          flow: "forge-notes-web.open-note",
          step: 3,
          evidence: "web/src/notes/notes-api.ts:13",
        },
        caller: "forge-notes-web",
        named: "notes-service",
        what: "GET /api/archive/{id}",
        candidates: ["forge-archive", "forge-archive-replica"],
      },
    ]);
    const answered = await joinEstate({
      ...relative(),
      targets: { "forge-notes-web.open-note#3": "forge-archive-replica" },
    });
    expect(answered.asks).toEqual([]);
    expect(answered.unmatched).toEqual([]);
    expect(answered.joins.find((j) => j.from.step === 3)).toMatchObject({
      to: { repo: "forge-archive", flow: "forge-archive-replica.get-archived" },
      how: "path",
    });
    // A person named it: not inferred.
    expect(answered.inferred.map((i) => i.from.step)).toEqual([1, 2, 4]);
  });

  it("joins through an Interface the estate join made from the caller, when there is one", async () => {
    const o = relative();
    const iface = parseRecord({
      kind: "Interface",
      schemaVersion: 2,
      id: "if-ba3de1d9549a58e3",
      status: "current",
      confidence: "inferred",
      evidence: [
        { source: "code", repo: "forge-notes", path: "web/src/notes/notes-api.ts", line: 5 },
      ],
      from: "forge-notes-web",
      to: "forge-archive",
      endpoint: "forge-archive.get-note",
      via: "direct",
      method: "GET",
      normalizedPath: "/api/notes/{}",
      sync: "sync",
      direction: "outbound",
      conflicts: [],
    });
    if (!iface.ok) throw new Error(JSON.stringify(iface.issues));
    const r = await joinEstate({ ...o, records: [...o.records, iface.record] });
    // The Interface reaches forge-archive.get-note, which no flow starts at: said, not re-guessed.
    expect(r.unmatched.find((u) => u.from.step === 1)).toMatchObject({
      reason: "no-flow",
      interface: "if-ba3de1d9549a58e3",
      trigger: "forge-archive.get-note",
    });
  });
});

describe("estateFlow and fieldLineage (ADR 0085)", () => {
  const joins = () => expected();

  it("prints the callee's steps inline at the call-out, with the data at the crossing", () => {
    const f = estateFlow({ flow: "forge-web.save-customer", specs: specs(), joins: joins() })!;
    expect(flattenEstateFlow(f).map((s) => `${s.n} ${s.repo} ${s.step.kind}`)).toEqual([
      "1 forge-web call-out",
      "1.1 forge-customers entry",
      "1.2 forge-customers transform",
      "1.3 forge-customers write",
      "1.4 forge-customers respond",
      "2 forge-web respond",
    ]);
    expect(f.steps[0]!.call!.crossing).toEqual({
      sends: ["name", "email", "phone"],
      receives: ["name", "email", "phone"],
      returns: ["id", "fullName", "emailAddress"],
      unused: [],
      objects: [],
    });
    const view = estateFlow({ flow: "forge-web.view-customer", specs: specs(), joins: joins() })!;
    expect(view.steps[1]!.call).toMatchObject({ unmatched: { reason: "no-target" } });
    expect(view.steps[0]!.call!.crossing).toMatchObject({ receives: ["customerId"], unused: [] });
  });

  it("stops at the depth limit and at a cycle", () => {
    const j = joins();
    const shallow = estateFlow({
      flow: "forge-web.save-customer",
      specs: specs(),
      joins: j,
      depth: 0,
    })!;
    expect(shallow.steps[0]!.call).toMatchObject({ stopped: "depth" });
    // The API calls back into the UI's flow: a cycle.
    const s = specs();
    const api = s.find((x) => x.repo === "forge-customers")!;
    const create = api.flows.find((x) => x.id === "forge-customers.create-customer")!;
    const back: EstateJoins["joins"][number] = {
      from: {
        repo: "forge-customers",
        flow: create.id,
        step: 1,
        evidence: "src/main/java/forge/customers/CustomerController.java:11",
      },
      to: {
        repo: "forge-web",
        flow: "forge-web.save-customer",
        trigger: "x",
        evidence: "src/app/customers/customer-form.component.ts:11",
      },
      entry: "forge-web x",
      how: "path",
    };
    const looped = {
      ...api,
      flows: api.flows.map((f) =>
        f.id === create.id
          ? {
              ...f,
              steps: [
                { ...f.steps[0]!, to: { component: "forge-web", entry: "x" } },
                ...f.steps.slice(1),
              ],
            }
          : f,
      ),
    };
    const c = estateFlow({
      flow: "forge-web.save-customer",
      specs: [looped, s.find((x) => x.repo === "forge-web")!],
      joins: { joins: [...j.joins, back], unmatched: j.unmatched },
    })!;
    expect(c.steps[0]!.call!.callee!.steps[0]!.call).toMatchObject({ stopped: "cycle" });
  });

  it("follows a field from the UI to its column, and says where a chain breaks", () => {
    const f = estateFlow({ flow: "forge-web.save-customer", specs: specs(), joins: joins() })!;
    const name = fieldLineage(f, "name");
    expect(name.stored).toEqual({ table: "forge-customers-db.customers", column: "full_name" });
    expect(name.links.map((l) => [l.n, l.as, l.field, l.evidence])).toEqual([
      ["1", "sent", "name", "forge-web:src/app/customers/customer.service.ts:10"],
      [
        "1.1",
        "named",
        "name",
        "forge-customers:src/main/java/forge/customers/CustomerController.java:11",
      ],
      [
        "1.2",
        "renamed",
        "CustomerRequest.name → Customer.fullName",
        "forge-customers:src/main/java/forge/customers/CustomerMapper.java:6",
      ],
      [
        "1.3",
        "stored",
        "forge-customers-db.customers.full_name",
        "forge-customers:src/main/java/forge/customers/CustomerController.java:12",
      ],
    ]);
    const phone = fieldLineage(f, "phone");
    expect(phone.stored).toBeUndefined();
    expect(phone.links.map((l) => l.n)).toEqual(["1", "1.1"]);
    expect(phone.breaks).toEqual({
      after: "1.1",
      message: "After 1.1 no step names phone, and no write stores it.",
    });
    const remove = estateFlow({
      flow: "forge-web.remove-customer",
      specs: specs(),
      joins: joins(),
    })!;
    expect(fieldLineage(remove, "id").breaks!.message).toBe(
      "1 sends id to forge-customers, but that call-out isn't joined to a flow: DELETE /api/customers/{id} reaches forge-customers.delete-customer, but no flow of forge-customers starts there.",
    );
    expect(fieldLineage(f, "colour").breaks).toEqual({
      message: "No step of forge-web.save-customer, or of the flows it calls, sends colour.",
    });
  });
});

describe("a family that spec check finds wrong blocks a join (ADR 0088)", () => {
  it("refuses to join a call-out to a flow that stands for its endpoint through a wrong family", async () => {
    const r = await joinEstate(withOwners());
    const want = expectedOwners();
    expect(r.joins).toEqual(want.joins);
    expect(r.unmatched).toEqual(want.unmatched);
  });

  it("prefers the flow whose own trigger is the endpoint over one that stands for it", async () => {
    const o = withOwners();
    const api = o.specs.find((s) => s.repo === "forge-customers")!;
    const add = api.flows.find((f) => f.id === "forge-customers.add-owner")!;
    const find: FlowRecord = {
      ...add,
      id: "forge-customers.find-owners",
      name: "A client finds owners",
      trigger: {
        ...add.trigger,
        ref: "forge-customers.get-owners",
        what: "GET /owners is called",
        evidence: [{ ...add.trigger.evidence[0]!, line: 18 }],
      },
      family: [],
      steps: [{ ...add.steps[0]!, refs: [], data: { reads: ["lastName"] } }],
    };
    // A flow sorted first that stands for GET /owners in a right family (a read for a read).
    const lister: FlowRecord = {
      ...find,
      id: "forge-customers.aa-lister",
      trigger: { ...find.trigger, ref: "forge-customers.get-customer" },
      family: ["forge-customers.get-owners"],
    };
    const r = await joinEstate({
      ...o,
      specs: o.specs.map((s) =>
        s.repo === "forge-customers" ? { ...s, flows: [lister, ...s.flows, find] } : s,
      ),
    });
    expect(r.joins.find((j) => j.from.flow === "forge-web.find-owners")).toMatchObject({
      to: { flow: "forge-customers.find-owners", trigger: "forge-customers.get-owners" },
      how: "path",
    });
  });
});

describe("an object sent across a crossing, followed to its fields (ADR 0088)", () => {
  it("maps the object the caller sends to the fields the callee's entry takes", () => {
    const o = withOwners();
    const f = estateFlow({ flow: "forge-web.add-owner", specs: o.specs, joins: expectedOwners() })!;
    expect(f.steps[0]!.call!.crossing).toEqual({
      sends: ["owner"],
      receives: ["firstName", "lastName"],
      returns: ["id", "firstName", "lastName"],
      unused: [],
      objects: [{ sent: "owner", fields: ["firstName", "lastName"] }],
    });
  });

  it("follows firstName from the UI's owner into the API, to owners.first_name", () => {
    const o = withOwners();
    const f = estateFlow({ flow: "forge-web.add-owner", specs: o.specs, joins: expectedOwners() })!;
    const l = fieldLineage(f, "firstName");
    expect(l.stored).toEqual({ table: "forge-customers-db.owners", column: "first_name" });
    expect(l.links.map((k) => [k.n, k.as, k.field, k.evidence])).toEqual([
      ["1", "sent", "owner.firstName", "forge-web:src/app/owners/owner.service.ts:10"],
      [
        "1.1",
        "named",
        "firstName",
        "forge-customers:src/main/java/forge/customers/OwnerController.java:12",
      ],
      [
        "1.2",
        "stored",
        "forge-customers-db.owners.first_name",
        "forge-customers:src/main/java/forge/customers/OwnerController.java:14",
      ],
    ]);
    // A field the object doesn't carry still isn't sent.
    expect(fieldLineage(f, "telephone").breaks!.message).toBe(
      "No step of forge-web.add-owner, or of the flows it calls, sends telephone.",
    );
  });

  it("maps a write's fields to its columns as the step says (data.from to data.to)", () => {
    const o = withOwners();
    const api = o.specs.find((s) => s.repo === "forge-customers")!;
    const mapped = api.flows.map((x) =>
      x.id === "forge-customers.add-owner"
        ? {
            ...x,
            steps: x.steps.map((s) =>
              s.kind === "write"
                ? {
                    ...s,
                    data: { from: ["firstName", "lastName"], to: ["last_name", "first_name"] },
                  }
                : s,
            ),
          }
        : x,
    );
    const f = estateFlow({
      flow: "forge-web.add-owner",
      specs: o.specs.map((s) => (s.repo === "forge-customers" ? { ...s, flows: mapped } : s)),
      joins: expectedOwners(),
    })!;
    // The step's own mapping wins over a column of the same name.
    expect(fieldLineage(f, "firstName").stored).toEqual({
      table: "forge-customers-db.owners",
      column: "last_name",
    });
  });

  it("maps an object only when it is clear which sent name carries the fields", () => {
    const o = withOwners();
    const web = o.specs.find((s) => s.repo === "forge-web")!;
    const two = {
      ...web,
      flows: web.flows.map((f) =>
        f.id === "forge-web.add-owner"
          ? { ...f, steps: [{ ...f.steps[0]!, data: { sends: ["owner", "audit"] } }] }
          : f,
      ),
    };
    const specs2 = o.specs.map((s) => (s.repo === "forge-web" ? two : s));
    const f = estateFlow({ flow: "forge-web.add-owner", specs: specs2, joins: expectedOwners() })!;
    expect(f.steps[0]!.call!.crossing!.objects).toEqual([]);
    // Unless the callee names the fields on the object: owner.firstName.
    const api = specs2.find((s) => s.repo === "forge-customers")!;
    const named = api.flows.map((x) =>
      x.id === "forge-customers.add-owner"
        ? {
            ...x,
            steps: [
              { ...x.steps[0]!, data: { reads: ["owner.firstName", "owner.lastName"] } },
              ...x.steps.slice(1),
            ],
          }
        : x,
    );
    const g = estateFlow({
      flow: "forge-web.add-owner",
      specs: specs2.map((s) => (s.repo === "forge-customers" ? { ...s, flows: named } : s)),
      joins: expectedOwners(),
    })!;
    expect(g.steps[0]!.call!.crossing!.objects).toEqual([
      { sent: "owner", fields: ["owner.firstName", "owner.lastName"] },
    ]);
  });
});
