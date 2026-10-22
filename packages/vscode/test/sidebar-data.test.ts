import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type * as Api from "../src/api-types";
import {
  artifactItems,
  changeItems,
  citeLenses,
  codeRootFor,
  findingActions,
  findingItems,
  flowItems,
  kindItems,
  lensText,
  recordItems,
  repoChildren,
  repoItems,
  stepItems,
  type Paths,
} from "../src/sidebar-data";

const root = join("C:", "meta");
const paths: Paths = {
  root,
  codeRoot: (repo) => (repo === "forge-web" ? join(root, "workspace", "forge-web") : undefined),
  catalogRel: "catalog",
};

const ev = (path: string, line?: number) => ({
  source: "code",
  repo: "forge-web",
  path,
  ...(line ? { line } : {}),
});

const flowView: Api.FlowView = {
  repo: "forge-web",
  file: "specs/forge-web/forge-web.save-customer.yaml",
  joined: true,
  flow: {
    id: "forge-web.save-customer",
    component: "forge-web",
    name: "A person saves a new customer",
    trigger: {
      kind: "action",
      what: "The Save button is pressed",
      evidence: [ev("src/form.ts", 11)],
    },
    steps: [
      {
        kind: "call-out",
        what: "POST /api/customers with the form's fields",
        to: { component: "forge-customers", entry: "POST /api/customers" },
        data: { sends: ["name", "email"] },
        evidence: [ev("src/customer.service.ts", 10)],
        confirmedBy: "check",
      },
      { kind: "respond", what: "The id is kept on the form", evidence: [ev("src/form.ts", 12)] },
    ],
    errors: [],
  },
  calls: [],
  calledBy: [],
  unmatched: [],
};

describe("the Repos section (ADR 0093)", () => {
  const onboarding: Api.OnboardingView = {
    repos: [
      {
        id: "forge-web",
        type: "forge-ui",
        owner: "team-web",
        manifest: "org-pack/profiles/forge/repos.manifest.yaml",
        cloned: true,
        scanSettings: { path: "org-pack/scan/forge-web.yaml", present: true },
        lastScan: { records: 1535, kinds: {}, commit: "abc1234" },
      },
      {
        id: "forge-ledger",
        type: "forge-service",
        owner: "team-ledger",
        manifest: "org-pack/profiles/forge/repos.manifest.yaml",
        cloned: false,
        scanSettings: { path: "org-pack/scan/forge-ledger.yaml", present: false },
        lastScan: null,
      },
    ],
  };

  it("shows each repo with its last scan, and what it holds", () => {
    const items = repoItems(onboarding);
    expect(items.map((i) => [i.label, i.description])).toEqual([
      ["forge-web", "scanned · 1,535 records"],
      ["forge-ledger", "not cloned"],
    ]);
    expect(items[0]!.expand).toEqual({ kind: "repo", repo: "forge-web" });
    const kids = repoChildren(onboarding.repos[0]!, 3, paths);
    expect(kids.map((k) => k.label)).toEqual(["Flows (3)", "Scan settings", "On the canvas"]);
    expect(kids[0]!.expand).toEqual({ kind: "flows", repo: "forge-web" });
    expect(kids[1]!.open).toEqual({
      kind: "file",
      path: join(root, "org-pack/scan/forge-web.yaml"),
    });
    expect(kids[2]!.open).toEqual({ kind: "app", hash: "#/architecture?node=repo%3Aforge-web" });
    // No spec yet: the flows say how to draft one.
    expect(repoChildren(onboarding.repos[1]!, 0, paths)[0]).toMatchObject({
      label: "No flows yet",
      description: "atticus spec draft forge-ledger",
    });
  });

  it("lists a repo's flows, each opening its diagram, with its steps underneath", () => {
    const spec: Api.SpecView = {
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
          errors: 0,
          calls: 1,
          calledBy: 0,
        },
      ],
      problems: [],
    };
    const [f] = flowItems(spec);
    expect(f).toMatchObject({
      label: "A person saves a new customer",
      description: "2 steps · 1 confirmed",
      expand: { kind: "flow", repo: "forge-web", flow: "forge-web.save-customer" },
      open: { kind: "app", hash: "#/flows?repo=forge-web&flow=forge-web.save-customer" },
    });
  });

  it("opens each step's code at its line, and says when the repo isn't cloned", () => {
    const steps = stepItems(flowView, paths);
    expect(steps.map((s) => [s.label, s.description])).toEqual([
      ["Start: The Save button is pressed", "action · form.ts:11"],
      ["1. POST /api/customers with the form's fields", "call-out · customer.service.ts:10 ✓"],
      ["2. The id is kept on the form", "respond · form.ts:12"],
    ]);
    expect(steps[1]!.open).toEqual({
      kind: "file",
      path: join(root, "workspace", "forge-web", "src/customer.service.ts"),
      line: 10,
    });
    expect(steps[1]!.tooltip).toContain("sends: name, email");
    expect(steps[1]!.tooltip).toContain("Confirmed by the check");
    const elsewhere = stepItems(flowView, { ...paths, codeRoot: () => undefined });
    expect(elsewhere[1]!.open).toEqual({
      kind: "missing",
      message:
        "forge-web isn't cloned here. Run atticus workspace sync, or open the repo's folder in this window.",
    });
  });
});

describe("finding a repo's code", () => {
  it("takes an open folder named for the repo first, then the base clone", () => {
    const folders = [{ name: "forge-web", path: join("D:", "src", "forge-web") }];
    const has = (p: string) => p === join(root, "workspace", "forge-ledger");
    expect(codeRootFor("forge-web", root, folders, has)).toBe(join("D:", "src", "forge-web"));
    expect(codeRootFor("forge-ledger", root, folders, has)).toBe(
      join(root, "workspace", "forge-ledger"),
    );
    expect(codeRootFor("forge-orders", root, folders, has)).toBeUndefined();
  });
});

describe("the Changes section", () => {
  const change: Api.ChangeDetail = {
    id: "add-note-tags",
    title: "Let people tag notes",
    type: "feature",
    state: "define",
    repos: [],
    openFindings: { blocking: 2, gap: 1, risk: 0, idea: 0 },
    updatedAt: "2026-10-20T21:52:28Z",
    artifacts: [
      {
        artifact: "brief",
        path: "openspec/changes/add-note-tags/brief.md",
        status: "done",
        openFindings: 0,
      },
      {
        artifact: "interfaces",
        path: "openspec/changes/add-note-tags/interfaces.md",
        status: "ready",
        openFindings: 2,
      },
      {
        artifact: "data",
        path: "openspec/changes/add-note-tags/data.md",
        status: "blocked",
        openFindings: 0,
      },
    ],
  };

  it("shows each change with its state and blocking findings", () => {
    expect(changeItems([change]).map((c) => [c.label, c.description])).toEqual([
      ["Let people tag notes", "define · 2 blocking"],
    ]);
  });

  it("lists the change's files with their state, then its findings", () => {
    const items = artifactItems(change, paths);
    expect(items.map((i) => [i.label, i.description, i.icon])).toEqual([
      ["brief", "done", "pass"],
      ["interfaces", "ready · 2 findings", "circle-large-outline"],
      ["data", "blocked", "lock"],
      ["Findings", "2 blocking, 1 gap", "warning"],
      ["In the app", undefined, "link-external"],
    ]);
    expect(items[0]!.open).toEqual({
      kind: "file",
      path: join(root, "openspec/changes/add-note-tags/brief.md"),
    });
    expect(items[3]!.expand).toEqual({ kind: "findings", change: "add-note-tags" });
    // A file the change hasn't reached yet says so, rather than failing to open.
    const notYet = artifactItems(change, {
      ...paths,
      exists: (f) => !f.endsWith("data.md"),
    })[2]!;
    expect(notYet.open).toEqual({
      kind: "missing",
      message: "data isn't written yet: it is blocked until the steps before it are done.",
    });
  });

  it("opens a finding's file, and puts its why and fix in the tooltip", () => {
    const [f] = findingItems(
      [
        {
          id: "f1",
          kind: "issue",
          change: "add-note-tags",
          severity: "blocking",
          artifact: "interfaces.md",
          summary: "The tag endpoint has no error for a duplicate tag.",
          why: "Clients can't tell a duplicate from a failure.",
          fix: { text: "Add a 409." },
          state: "open",
        },
      ],
      change,
      paths,
    );
    expect(f).toMatchObject({
      label: "The tag endpoint has no error for a duplicate tag.",
      description: "blocking · interfaces.md",
      icon: "error",
      open: { kind: "file", path: join(root, "openspec/changes/add-note-tags/interfaces.md") },
    });
    expect(f!.tooltip).toContain("Add a 409.");
  });
});

describe("the Catalog section", () => {
  it("shows each kind with its count, and each record with its code", () => {
    expect(kindItems([{ kind: "Table", count: 55, stale: 2 }]).map((k) => k.description)).toEqual([
      "55 · 2 stale",
    ]);
    const page: Api.RecordPage = {
      items: [
        {
          kind: "Table",
          id: "forge-db.customers",
          name: "customers",
          status: "current",
          confidence: "verified",
          evidence: [ev("db/V1__customers.sql", 3)],
        },
      ],
      total: 230,
    };
    const items = recordItems(page, paths);
    expect(items[0]).toMatchObject({
      label: "customers",
      description: "forge-db.customers · verified",
      open: {
        kind: "file",
        path: join(root, "catalog", "generated", "table", "forge-db.customers.yaml"),
      },
      expand: { kind: "evidence", repo: "forge-web" },
    });
    expect(items.at(-1)).toMatchObject({ label: "229 more in the app" });
  });
});

describe("a lens's words", () => {
  it("names the flow and the step, and who confirmed it", () => {
    const c = { line: 10, n: 1, kind: "call-out", repo: "forge-web", flow: "f", name: "Save" };
    expect(lensText({ ...c, n: 0, kind: "action" })).toBe("Atticus: Save · start (action)");
    expect(lensText({ ...c, confirmedBy: "check" })).toBe(
      "Atticus: Save · step 1, call-out · confirmed by the check",
    );
    expect(lensText(c)).toBe("Atticus: Save · step 1, call-out · not confirmed yet");
  });
});

describe("acting on a finding from the sidebar (ADR 0094)", () => {
  const issue = {
    id: "f1",
    kind: "issue",
    change: "add-note-tags",
    layer: "checklist",
    severity: "blocking",
    waivable: true,
    artifact: "interfaces.md",
    summary: "No 409 for a duplicate tag.",
    why: "Clients can't tell a duplicate from a failure.",
    fix: { text: "Add a 409.", patch: "--- a/interfaces.md\n+++ b/interfaces.md\n" },
  };

  it("offers what the finding allows, each with what it needs", () => {
    expect(findingActions(issue).map((a) => [a.action, a.label, a.needs])).toEqual([
      ["apply", "Apply the fix", undefined],
      ["edit-and-apply", "I fixed it by hand", "reason"],
      ["not-relevant", "Not relevant", "reason"],
      ["waive", "Waive it", "reason"],
      ["ask", "Ask someone", "askedOf"],
    ]);
  });

  it("offers no Apply without a patch, and no Waive unless the rule allows it", () => {
    const plain = { ...issue, severity: "gap", waivable: false, fix: { text: "Say more." } };
    expect(findingActions(plain).map((a) => a.action)).toEqual([
      "edit-and-apply",
      "not-relevant",
      "ask",
    ]);
    expect(
      findingActions({ ...issue, layer: "constitution", waivable: true }).map((a) => a.action),
    ).not.toContain("waive");
  });

  it("answers a knowledge gap by asking its owner, or by writing the fact in", () => {
    const gap = {
      ...issue,
      kind: "knowledge-gap",
      severity: "gap",
      question: { text: "Who owns nadiengine-api?", owner: "tomgeorge" },
    };
    expect(findingActions(gap)).toEqual([
      { action: "ask", label: "Ask tomgeorge", needs: undefined, askedOf: "tomgeorge" },
      { action: "edit-and-apply", label: "I wrote the fact in", needs: "reason" },
    ]);
  });
});

describe("one file's cited lines, as lenses", () => {
  it("gives a lens per flow step and one for the records on a line", () => {
    const lenses = citeLenses(
      {
        repo: "forge-customers",
        path: "src/CustomerController.java",
        lines: [
          {
            line: 10,
            flows: [
              {
                repo: "forge-customers",
                flow: "forge-customers.create-customer",
                name: "A client creates a customer",
                step: 0,
                kind: "endpoint",
              },
            ],
            records: [
              { kind: "Endpoint", id: "forge-customers.post-customer", source: "code" },
              { kind: "Interface", id: "if-1", name: "Customers API", source: "code" },
            ],
          },
          { line: 12, flows: [], records: [{ kind: "Table", id: "db.customers", source: "code" }] },
        ],
      },
      paths,
    );
    expect(lenses.map((l) => [l.line, l.title])).toEqual([
      [10, "Atticus: A client creates a customer · start (endpoint)"],
      [10, "Atticus: Endpoint forge-customers.post-customer, Interface Customers API"],
      [12, "Atticus: Table db.customers"],
    ]);
    expect(lenses[0]!.open).toEqual({
      kind: "app",
      hash: "#/flows?repo=forge-customers&flow=forge-customers.create-customer&step=0",
    });
    expect(lenses[2]!.open).toEqual({
      kind: "file",
      path: join(root, "catalog", "generated", "table", "db.customers.yaml"),
    });
    // Two records on a line: a pick between their files.
    expect(lenses[1]!.open).toMatchObject({ kind: "pick" });
  });

  it("can leave the records out", () => {
    const only = citeLenses(
      {
        repo: "r",
        path: "a.ts",
        lines: [{ line: 3, flows: [], records: [{ kind: "Table", id: "t", source: "code" }] }],
      },
      paths,
      { records: false },
    );
    expect(only).toEqual([]);
  });
});
