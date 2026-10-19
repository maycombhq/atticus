import { describe, expect, it } from "vitest";
import { SCREENS } from "../src/app/screens.js";
import { inboxFor, ROLE_SCREENS, screensFor } from "../src/app/roles.js";

const ids = new Set(SCREENS.map((s) => s.id));

describe("role views", () => {
  it("gives each of the thirteen built-in roles a home and seven or eight screens that exist", () => {
    expect(Object.keys(ROLE_SCREENS)).toHaveLength(13);
    for (const [role, screens] of Object.entries(ROLE_SCREENS)) {
      expect(screens[0], role).toBe("home");
      expect(screens.length, role).toBeGreaterThanOrEqual(7);
      expect(screens.length, role).toBeLessThanOrEqual(8);
      for (const s of screens) expect(ids.has(s), `${role}: ${s}`).toBe(true);
      expect(new Set(screens).size, role).toBe(screens.length);
    }
  });

  it("gives a custom role the screens of the role it is based on, and no view the plain list", () => {
    const roles = [{ id: "test-architect", name: "Test architect", core: false, basedOn: "qa" }];
    expect(screensFor("test-architect", roles)).toEqual(ROLE_SCREENS.qa);
    expect(screensFor(null, roles)).toEqual(["home", "explore", "changes", "map"]);
  });
});

describe("what waits on you", () => {
  const changes = [
    {
      id: "add-transfer-limit",
      title: "Add a daily transfer limit",
      type: "feature",
      state: "design",
    },
    { id: "fix-timeout", title: "Fix the Northwind timeout", type: "bug-fix", state: "qa" },
  ];
  const findings = [
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
  ];
  const data = {
    changes,
    findings,
    questions: [
      { id: "q1", question: "Who owns audit-svc?", owner: "team-platform", system: "audit" },
    ],
    triage: [
      {
        id: "alias-needed.ledger-platform",
        kind: "alias-needed",
        summary: "Confirm Ledger Platform",
      },
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

  it("shows an architect the changes in design and the blocking and gap findings on their artifacts", () => {
    const items = inboxFor("architect", data);
    expect(items.map((i) => i.kind)).toEqual(["phase", "finding", "triage", "question"]);
    expect(items[0]).toMatchObject({
      title: "Add a daily transfer limit is in design",
      href: "#/arch-review?change=add-transfer-limit",
    });
    expect(items[1]).toMatchObject({
      title: "A hop has no pattern",
      href: "#/arch-review?change=add-transfer-limit",
    });
  });

  it("shows a product owner their brief's findings, and QA the change in QA", () => {
    expect(inboxFor("product-owner", data).map((i) => i.title)).toEqual([
      "No measure for the outcome",
    ]);
    expect(inboxFor("qa", data).map((i) => i.href)).toEqual(["#/trace?change=fix-timeout"]);
  });

  it("shows a delivery lead the manual steps waiting, and nobody ideas", () => {
    expect(inboxFor("delivery-lead", data).map((i) => i.kind)).toEqual(["step"]);
    for (const role of Object.keys(ROLE_SCREENS))
      expect(inboxFor(role, data).some((i) => i.title === "Reuse the audit client")).toBe(false);
  });
});
