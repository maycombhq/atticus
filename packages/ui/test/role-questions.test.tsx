import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { COPY } from "../src/copy.js";
import {
  readViewerRole,
  RoleFilter,
  RolePicker,
  RoleQuestionsLine,
  roleQuestionsHref,
  roleScopeOf,
  saveViewerRole,
  scopeWithRole,
  withRoleScope,
  yourRole,
} from "../src/screens/RoleQuestions.js";
import { RunReadyView, runReadyWords } from "../src/screens/know/run-ready.js";

/** ADR 0181 part 4: role-owned questions on Home and Questions, and Run all ready tasks. */

const R = COPY.roles;
const esc = (s: string) => s.replace(/'/g, "&#x27;");

describe("role-owned questions", () => {
  it("reads the change and role from the Questions address, and adds them to the list's", () => {
    expect(roleScopeOf("#/questions?change=add-holds&role=architecture")).toEqual({
      change: "add-holds",
      role: "architecture",
    });
    expect(roleScopeOf("#/questions?role=developer&change=Not%20an%20id")).toEqual({});
    expect(
      withRoleScope("/api/questions?state=open", { change: "add-holds", role: "delivery" }),
    ).toBe("/api/questions?state=open&change=add-holds&role=delivery");
    expect(withRoleScope("/api/questions", {})).toBe("/api/questions");
    expect(withRoleScope("/api/questions", { role: "product" })).toBe(
      "/api/questions?role=product",
    );
    expect(scopeWithRole({ change: "add-holds", role: "product" }, undefined)).toEqual({
      change: "add-holds",
    });
    expect(roleQuestionsHref("add-holds", "analysis")).toBe(
      "#/questions?change=add-holds&role=analysis",
    );
  });

  it("takes the person's role from the change's owners, else the viewer's pick", () => {
    expect(yourRole(["architecture", "delivery"], "product")).toEqual({
      roles: ["architecture", "delivery"],
      from: "owners",
    });
    expect(yourRole([], "product")).toEqual({ roles: ["product"], from: "picker" });
    expect(yourRole(undefined, undefined)).toEqual({ roles: [], from: "none" });
  });

  it("remembers the viewer's pick, and survives storage that throws", () => {
    const m = new Map<string, string>();
    const store = {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
    };
    expect(readViewerRole(store)).toBeUndefined();
    saveViewerRole("analysis", store);
    expect(readViewerRole(store)).toBe("analysis");
    saveViewerRole(undefined, store);
    expect(readViewerRole(store)).toBeUndefined();
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readViewerRole(broken)).toBeUndefined();
    expect(() => saveViewerRole("product", broken)).not.toThrow();
  });

  it("shows the role filter with each role's open count and the person's marked", () => {
    const html = renderToStaticMarkup(
      <RoleFilter
        value="architecture"
        onChange={() => {}}
        byRole={{ architecture: { open: 2 }, product: { open: 1 } }}
        yours={["architecture"]}
      />,
    );
    expect(html).toContain('for="questions-role"');
    expect(html).toContain(R.allRoles);
    expect(html).toContain(R.option("Architecture", 2, true));
    expect(html).toContain(R.option("Product", 1, false));
    expect(html).toContain(R.option("Delivery", undefined, false));
  });

  it("says a change's open questions for the person's role on Home, with a link to answer them", () => {
    const html = renderToStaticMarkup(
      <RoleQuestionsLine
        change="add-holds"
        roles={["architecture", "delivery"]}
        from="owners"
        byRole={{ architecture: { open: 2 } }}
      />,
    );
    expect(html).toContain(esc(R.line("add-holds", "the architect", 2)));
    expect(html).toContain(esc(R.line("add-holds", "the tech lead", 0)));
    expect(html).toContain('href="#/questions?change=add-holds&amp;role=architecture"');
    expect(html).not.toContain("role=delivery");
    expect(html).toContain(esc(R.fromOwners));
  });

  it("offers a labelled role picker when no change names the person", () => {
    const html = renderToStaticMarkup(<RolePicker value={undefined} onChange={() => {}} />);
    expect(html).toContain('for="viewer-role"');
    expect(html).toContain('aria-describedby="viewer-role-hint"');
    expect(html).toContain(esc(R.pickYoursHint));
  });
});

describe("Run all ready tasks on the Task board", () => {
  const ready = {
    change: "add-transfer-limit",
    tasks: [
      { id: "1.1", repo: "forge-ledger", ready: true, waitsFor: [] },
      { id: "2.1", repo: "forge-portal-bff", ready: false, waitsFor: ["1.1"], why: "it waits" },
    ],
    ready: ["1.1"],
  };

  it("counts the ready tasks on the button and says who runs them", () => {
    const html = renderToStaticMarkup(<RunReadyView ready={ready} busy={false} onRun={() => {}} />);
    expect(html).toContain(COPY.runReady.buttonCount(1));
    expect(html).toContain("The tech lead or architect runs the tasks");
    expect(html).not.toContain("disabled");
  });

  it("is disabled, and says why, when no task is ready or while it runs", () => {
    const none = renderToStaticMarkup(
      <RunReadyView ready={{ ...ready, ready: [] }} busy={false} onRun={() => {}} />,
    );
    expect(none).toContain("disabled");
    expect(none).toContain(esc(COPY.runReady.noneReady));
    const busy = renderToStaticMarkup(<RunReadyView ready={ready} busy onRun={() => {}} />);
    expect(busy).toContain(COPY.runReady.running);
    expect(busy).toContain('aria-busy="true"');
  });

  it("says each task's end and where the job stopped", () => {
    expect(
      runReadyWords({
        ran: [
          { task: "1.1", repo: "forge-ledger", state: "built", branch: "task/x/1.1" },
          { task: "1.2", repo: "forge-ledger", state: "needs-person" },
        ],
        stopped: { task: "1.2", why: "the build still fails" },
        left: ["1.3"],
      }),
    ).toBe(
      [
        COPY.runReady.ran("1.1", COPY.phase.taskState.built!),
        COPY.runReady.ran("1.2", COPY.phase.taskState["needs-person"]!),
        COPY.runReady.stopped("1.2", "the build still fails", "1.3"),
      ].join("\n"),
    );
    expect(runReadyWords({ ran: [{ task: "1.1", repo: "r", refused: "held" }], left: [] })).toBe(
      [COPY.runReady.refused("1.1", "held"), COPY.runReady.allRan(1)].join("\n"),
    );
  });
});
