import { describe, expect, it } from "vitest";
import { SCREENS } from "../src/app/screens.js";
import { inboxOf } from "../src/app/inbox.js";

const ids = new Set(SCREENS.map((s) => s.id));

/** ADR 0073: one list of what needs a person, the same for everyone; no roles, no approvals. */
describe("what needs a person", () => {
  const data = {
    changes: [
      {
        id: "add-transfer-limit",
        title: "Add a daily transfer limit",
        type: "feature",
        state: "design",
      },
      { id: "fix-timeout", title: "Fix the Northwind timeout", type: "bug-fix", state: "qa" },
      { id: "old", title: "Old change", type: "feature", state: "archived" },
    ],
    findings: [
      {
        id: "b1",
        gate: "design",
        severity: "blocking",
        artifact: "design.md",
        summary: "A hop has no pattern",
        state: "open",
        change: "add-transfer-limit",
      },
      {
        id: "g1",
        gate: "define",
        severity: "gap",
        artifact: "brief.md",
        summary: "No measure for the outcome",
        state: "open",
        change: "add-transfer-limit",
      },
      {
        id: "i1",
        gate: "design",
        severity: "idea",
        artifact: "design.md",
        summary: "Reuse the audit client",
        state: "open",
        change: "add-transfer-limit",
      },
    ],
    questions: [
      { id: "q1", question: "Who owns audit-svc?", owner: "team-platform", system: "audit" },
    ],
    triage: [
      { id: "alias-needed.ledger-platform", kind: "alias-needed", summary: "Confirm Ledger" },
    ],
    steps: [
      {
        id: "s1",
        title: "File the gateway request",
        system: "service-desk",
        change: "add-transfer-limit",
      },
    ],
  };

  it("lists changes in a phase, blocking findings and gaps, triage, questions and steps", () => {
    const items = inboxOf(data);
    expect(items.map((i) => i.kind)).toEqual([
      "phase",
      "phase",
      "finding",
      "finding",
      "triage",
      "question",
      "step",
    ]);
    expect(items[0]).toMatchObject({
      title: "Add a daily transfer limit is in design",
      href: "#/arch-review?change=add-transfer-limit",
    });
    expect(items[1]!.href).toBe("#/trace?change=fix-timeout");
    expect(items[2]).toMatchObject({
      title: "A hop has no pattern",
      href: "#/arch-review?change=add-transfer-limit",
    });
    expect(items[3]!.href).toBe("#/brief?change=add-transfer-limit");
  });

  it("leaves out ideas and archived changes, and links only to screens that exist", () => {
    const items = inboxOf(data);
    expect(items.some((i) => i.title === "Reuse the audit client")).toBe(false);
    expect(items.some((i) => i.title.startsWith("Old change"))).toBe(false);
    for (const i of items) expect(ids.has(/^#\/([a-z-]+)/.exec(i.href)![1]!), i.href).toBe(true);
  });

  it("lists open needs across changes, each linking to the Needs view (ADR 0105)", () => {
    const items = inboxOf({
      ...data,
      needs: [
        {
          change: "add-transfer-limit",
          item: "firewall-rule-request",
          title: "Network firewall rule",
          kind: "request",
          status: "open",
          handledBy: "Network team",
          leadTime: "10 working days",
        },
        {
          change: "add-transfer-limit",
          item: "json-logging",
          title: "Log as JSON",
          kind: "standard",
          status: "done",
        },
      ],
    });
    const needs = items.filter((i) => i.kind === "need");
    expect(needs).toEqual([
      {
        kind: "need",
        title: "Network firewall rule",
        detail: "request · Network team · 10 working days · add-transfer-limit",
        href: "#/changes?across=needs",
        // Its id and change, for grouping by change and the filter (ADR 0105 addendum).
        id: "firewall-rule-request",
        change: "add-transfer-limit",
      },
    ]);
    // After the findings, before the queues.
    expect(items.map((i) => i.kind).indexOf("need")).toBe(4);
  });

  it("is empty when nothing needs a person", () => {
    expect(inboxOf({ changes: [], findings: [], questions: [], triage: [], steps: [] })).toEqual(
      [],
    );
  });
});
