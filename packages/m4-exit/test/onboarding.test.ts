import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inboxFor } from "../../ui/src/app/roles.js";
import { app, atticus, Clock, json, sandbox } from "./helpers.js";

/**
 * The onboarding bars. A platform lead goes from install to the first map in under an hour; a
 * new team member reaches their first item in under 15 minutes. What a machine can time is
 * timed here, on a fresh sandbox: every step the app or the CLI does. Reading, deciding and
 * typing are the person's part, timed by someone new (docs/m4-exit.md, "For a person").
 */

const HOUR = 3_600_000;
const QUARTER = 900_000;

interface Setup {
  steps: { id: string; done: boolean; fix?: string; optional?: boolean }[];
  baselined: boolean;
}

describe("the onboarding bars", () => {
  it("a platform lead goes from install to the first map and an accepted catalog", async () => {
    const clock = new Clock();
    const { root } = await sandbox();
    clock.lap("make the sandbox (stands in for install and repos discover)");

    const before = await atticus(root, "setup", "--json");
    expect(before.code).toBe(1);
    const open = json<Setup>(before).steps.filter((s) => !s.done && !s.optional);
    // What is left on a new metarepo, each with a fix a lead can follow.
    expect(open.map((s) => s.id)).toEqual(["scan", "baseline"]);
    expect(open.every((s) => s.fix && /atticus /.test(s.fix))).toBe(true);
    clock.lap("read the setup checklist");

    const scan = await atticus(root, "scan");
    expect(scan.code, scan.text).toBe(0);
    clock.lap("first scan");

    const ui = await app(root, "pat");
    try {
      const map = await ui.call<{ nodes: { id: string; kind: string }[]; edges: unknown[] }>(
        "GET",
        "/api/graph",
      );
      expect(map.status).toBe(200);
      expect(map.body.nodes.length).toBeGreaterThanOrEqual(7);
      expect(map.body.edges.length).toBeGreaterThan(0);
      clock.lap("first map in the app");

      const accept = await ui.call<{ lines: string[] }>("POST", "/api/baseline", {
        note: "Walked the map with the architect",
      });
      expect(accept.status, JSON.stringify(accept.body)).toBe(200);
      clock.lap("accept the catalog as the baseline");
    } finally {
      await ui.close();
    }

    const after = await atticus(root, "setup");
    expect(after.code, after.text).toBe(0);
    expect(after.text).toMatch(/Setup is done/);
    clock.lap("setup reports done");

    clock.report("Platform lead, machine time");
    expect(clock.total).toBeLessThan(HOUR / 12);
  });

  it("a new team member starts in their view from their group and clears their first item", async () => {
    const { root } = await sandbox();
    expect((await atticus(root, "scan")).code).toBe(0);
    // Their directory groups, as their machine knows them; Forge Architects maps to architect.
    await mkdir(join(root, ".atticus"), { recursive: true });
    await writeFile(join(root, ".atticus/me.yaml"), "groups: [Forge Architects]\n");

    const clock = new Clock();
    const ui = await app(root, "ari");
    try {
      const me = await ui.call<{ view: string; source: string; approvals: { action: string }[] }>(
        "GET",
        "/api/me",
      );
      expect(me.body).toMatchObject({ view: "architect", source: "group" });
      // Ownership, not the view, grants approvals: the group may waive findings.
      expect(me.body.approvals.map((a) => a.action)).toEqual(["waiver"]);
      clock.lap("open the app: the view comes from the group");

      const [changes, findings, triage, questions, todo, approvals] = await Promise.all([
        ui.call<{ id: string; title: string; type: string; state: string }[]>(
          "GET",
          "/api/changes",
        ),
        ui.call<
          {
            id: string;
            gate: string;
            severity: string;
            artifact: string;
            summary: string;
            state: string;
          }[]
        >("GET", "/api/findings?state=open"),
        ui.call<{ data: { items: { id: string; kind: string; summary: string }[] } }>(
          "GET",
          "/api/view/triage",
        ),
        ui.call<{ data: { questions?: { id: string; question: string }[] } | null }>(
          "GET",
          "/api/view/questions",
        ),
        ui.call<{ steps: { id: string; title: string; system: string }[] }>("GET", "/api/todo"),
        ui.call<
          {
            change: string;
            title: string;
            phase: string;
            pr: string;
            kind: "review" | "revise";
            because: string;
          }[]
        >("GET", "/api/me/approvals"),
      ]);
      const inbox = inboxFor(me.body.view, {
        changes: changes.body,
        findings: findings.body,
        triage: triage.body.data.items,
        questions: questions.body.data?.questions ?? [],
        steps: todo.body.steps,
        approvals: approvals.body,
      });
      expect(inbox.length).toBeGreaterThan(0);
      const first = inbox[0]!;
      clock.lap("Home lists what waits on them");

      // On the sandbox an architect's first item is a diagram name to confirm.
      expect(first).toMatchObject({ kind: "triage", href: "#/intake" });
      const item = triage.body.data.items.find((t) => t.summary === first.title)!;
      const decided = await ui.call("POST", `/api/triage/${encodeURIComponent(item.id)}/decide`, {
        option: 1,
      });
      expect(decided.status, JSON.stringify(decided.body)).toBe(200);
      const left = await ui.call<{ data: { items: { id: string }[] } }>("GET", "/api/view/triage");
      expect(left.body.data.items.map((t) => t.id)).not.toContain(item.id);
      clock.lap("decide the first item");
    } finally {
      await ui.close();
    }
    clock.report("New team member, machine time");
    expect(clock.total).toBeLessThan(QUARTER / 15);
  });
});
