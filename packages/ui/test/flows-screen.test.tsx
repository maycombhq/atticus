import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { COPY } from "../src/copy.js";
import { FlowList, Flows, SequenceDiagram } from "../src/screens/flows/Flows.js";
import { sequence } from "../src/screens/flows/model.js";

const C = COPY.flows;
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");

const ev = (path: string, line: number) => ({
  source: "code" as const,
  repo: "forge-web",
  path,
  line,
});

const view: Api.FlowViewT = {
  repo: "forge-web",
  file: "specs/forge-web/forge-web.save-customer.yaml",
  joined: true,
  flow: {
    kind: "Flow",
    schemaVersion: 1,
    status: "current",
    confidence: "inferred",
    evidence: [],
    family: [],
    template: "default@1",
    id: "forge-web.save-customer",
    component: "forge-web",
    name: "A person saves a new customer",
    trigger: {
      kind: "action",
      what: "The Save button of the customer form is pressed",
      evidence: [ev("src/app/customers/customer-form.component.ts", 11)],
    },
    steps: [
      {
        kind: "call-out",
        what: "POST /api/customers with the form's fields",
        refs: [],
        to: { component: "forge-customers", entry: "POST /api/customers" },
        data: { sends: ["name", "email"] },
        evidence: [ev("src/app/customers/customer.service.ts", 10)],
        confirmedBy: "check",
      },
      {
        kind: "respond",
        what: "The saved customer's id is kept on the form",
        refs: [],
        evidence: [ev("src/app/customers/customer-form.component.ts", 12)],
      },
    ],
    errors: [
      { when: "the email is taken", then: "409", evidence: [ev("src/app/customers/x.ts", 3)] },
    ],
  },
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
};

describe("the flow's sequence diagram (ADR 0092)", () => {
  const out = renderToStaticMarkup(<SequenceDiagram seq={sequence(view)} />);

  it("draws a lane for each part and the steps in order, as a list", () => {
    for (const l of ["A person", "forge-web", "forge-customers"]) expect(out).toContain(l);
    expect(out).toContain("<ol");
    const at = (s: string) => out.indexOf(esc(s));
    expect(at("The Save button")).toBeLessThan(at("POST /api/customers with"));
    expect(at("POST /api/customers with")).toBeLessThan(at("The saved customer"));
  });

  it("puts the file and line on every step, and says who confirmed it in words", () => {
    expect(out).toContain("src/app/customers/customer.service.ts:10");
    expect(out).toContain(esc(C.confirmed.check!));
    expect(out).toContain(esc(C.notConfirmed));
    expect(out).toContain("sends: name, email");
  });

  it("names where an arrow goes in text too, and links the flow a call starts", () => {
    expect(out).toContain(esc(C.goesTo("POST /api/customers", "forge-customers")));
    expect(out).toContain(
      'href="#/flows?repo=forge-customers&amp;flow=forge-customers.create-customer"',
    );
    expect(out).toContain(esc(C.opens("A client creates a customer", "forge-customers")));
  });

  it("marks the step a link points at (&step=, from the code or the sidebar)", () => {
    const marked = renderToStaticMarkup(<SequenceDiagram seq={sequence(view)} current={1} />);
    expect(marked.match(/aria-current="step"/g)).toHaveLength(1);
    expect(marked).toContain("seq-row seq-now");
    expect(out).not.toContain('aria-current="step"');
  });

  it("lists the error paths with their citations", () => {
    expect(out).toContain(esc(C.errorsTitle));
    expect(out).toContain("the email is taken");
    expect(out).toContain("src/app/customers/x.ts:3");
  });
});

describe("the list of a repo's flows", () => {
  const spec: Api.SpecViewT = {
    repo: "forge-web",
    path: "specs/forge-web",
    flows: [
      {
        id: "forge-web.save-customer",
        name: "A person saves a new customer",
        component: "forge-web",
        trigger: { kind: "action", what: "The Save button is pressed" },
        steps: 2,
        confirmed: 1,
        errors: 1,
        calls: 1,
        calledBy: 0,
      },
      {
        id: "forge-web.view-customer",
        name: "A person opens a customer",
        component: "forge-web",
        trigger: { kind: "page", what: "The customer page opens" },
        steps: 3,
        confirmed: 0,
        errors: 0,
        calls: 1,
        calledBy: 0,
      },
    ],
    problems: [{ file: "specs/forge-web/forge-web.broken.yaml", message: "bad YAML" }],
  };

  it("shows each flow with what starts it and its counts, the picked one marked", () => {
    const out = renderToStaticMarkup(
      <FlowList spec={spec} filter="" current="forge-web.save-customer" />,
    );
    expect(out).toContain("A person saves a new customer");
    expect(out).toContain('aria-current="true"');
    expect(out).toContain(esc(C.counts(2, 1)));
    expect(out).toContain("specs/forge-web/forge-web.broken.yaml");
  });

  it("filters by name, id or trigger, and says when nothing matches", () => {
    const one = renderToStaticMarkup(<FlowList spec={spec} filter="opens" current={undefined} />);
    expect(one).toContain("A person opens a customer");
    expect(one).not.toContain("A person saves");
    const none = renderToStaticMarkup(<FlowList spec={spec} filter="zzz" current={undefined} />);
    expect(none).toContain(esc(C.noMatch));
  });
});

describe("the Flows screen's states", () => {
  it("is loading before the specs arrive", () => {
    const out = renderToStaticMarkup(<Flows hash="#/flows" />);
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain(esc(C.title));
  });
});
