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
      { reason: "no-target", message: "forge-loyalty isn't a component in the catalog" },
    ]);
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
