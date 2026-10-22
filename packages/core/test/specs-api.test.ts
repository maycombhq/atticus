import { describe, expect, it } from "vitest";
import { Api, API_VERSION, openApiDocument } from "../src/index.js";

const flow = {
  kind: "Flow",
  schemaVersion: 1,
  id: "forge-web.save-customer",
  component: "forge-web",
  name: "A person saves a new customer",
  template: "default@1",
  trigger: {
    kind: "action",
    what: "The Save button of the customer form is pressed",
    evidence: [{ source: "code", repo: "forge-web", path: "src/app/customer-form.ts", line: 11 }],
  },
  steps: [
    {
      kind: "call-out",
      what: "POST /api/customers with the form's fields",
      to: { component: "forge-customers", entry: "POST /api/customers" },
      evidence: [
        { source: "code", repo: "forge-web", path: "src/app/customer.service.ts", line: 10 },
      ],
    },
  ],
};

describe("the specs API (ADR 0092)", () => {
  it("is in the OpenAPI document", () => {
    const doc = openApiDocument() as {
      paths: Record<string, Record<string, { operationId: string }>>;
      components: { schemas: Record<string, unknown> };
    };
    expect(API_VERSION).toBe("2.4.0");
    expect(doc.paths["/api/specs"]!.get!.operationId).toBe("listSpecs");
    expect(doc.paths["/api/specs/{repo}"]!.get!.operationId).toBe("getSpec");
    expect(doc.paths["/api/specs/{repo}/flows/{flowId}"]!.get!.operationId).toBe("getFlow");
    for (const s of ["SpecList", "SpecView", "FlowView"])
      expect(doc.components.schemas).toHaveProperty(s);
  });

  it("lists each repo's flows with what starts them and how far they are confirmed", () => {
    const v = Api.SpecView.parse({
      repo: "forge-web",
      path: "specs/forge-web",
      flows: [
        {
          id: "forge-web.save-customer",
          name: "A person saves a new customer",
          component: "forge-web",
          trigger: { kind: "action", what: "The Save button of the customer form is pressed" },
          steps: 2,
          confirmed: 1,
          errors: 0,
          calls: 1,
          calledBy: 0,
        },
      ],
      problems: [],
    });
    expect(v.flows[0]!.trigger.kind).toBe("action");
    expect(Api.SpecList.parse({ repos: [{ repo: "forge-web", flows: 3 }] }).repos).toHaveLength(1);
  });

  it("gives one flow with the flows its calls reach and the flows that call it", () => {
    const v = Api.FlowView.parse({
      repo: "forge-web",
      file: "specs/forge-web/forge-web.save-customer.yaml",
      flow,
      joined: true,
      calls: [
        {
          step: 1,
          repo: "forge-customers",
          flow: "forge-customers.create-customer",
          name: "A client creates a customer",
          how: "interface",
        },
      ],
      calledBy: [],
      unmatched: [],
    });
    expect(v.flow.steps[0]!.to?.component).toBe("forge-customers");
    expect(() => Api.FlowView.parse({ ...v, flow: { ...flow, steps: [] } })).toThrow();
  });
});

describe("the cited lines of one file (ADR 0094)", () => {
  it("is in the OpenAPI document, as API 2.4.0", () => {
    const doc = openApiDocument() as {
      paths: Record<string, Record<string, { operationId: string }>>;
      components: { schemas: Record<string, unknown> };
    };
    expect(API_VERSION).toBe("2.4.0");
    expect(doc.paths["/api/cites"]!.get!.operationId).toBe("getCites");
    expect(doc.components.schemas).toHaveProperty("CiteList");
  });

  it("gives each cited line with the flow steps and records that cite it", () => {
    const v = Api.CiteList.parse({
      repo: "forge-web",
      path: "src/app/customers/customer.service.ts",
      lines: [
        {
          line: 10,
          flows: [
            {
              repo: "forge-web",
              flow: "forge-web.save-customer",
              name: "A person saves a new customer",
              step: 1,
              kind: "call-out",
              confirmedBy: "check",
            },
          ],
          records: [{ kind: "Interface", id: "if-c74e2fa3c8152a13", source: "code" }],
        },
      ],
    });
    expect(v.lines[0]!.flows[0]!.step).toBe(1);
  });
});
