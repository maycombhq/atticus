import { existsSync, readFileSync } from "node:fs";
import { cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { changeStore, checkFindings } from "@maycombhq/changes";
import { driftCheck, handDown, openTaskWorktree } from "../src/index.js";
import { CHANGE, git, NOW, SPECKIT, speckitRoot, worktree } from "./helpers.js";

const T = 120_000;
type Row = Record<string, unknown>;

async function drifted() {
  const { root } = await speckitRoot({ repos: ["forge-ledger"] });
  await handDown(root, CHANGE, "1.2", { git });
  await cp(
    join(SPECKIT, "drift/forge-ledger/specs/1.2"),
    join(worktree(root, "forge-ledger"), "specs/1.2"),
    {
      recursive: true,
    },
  );
  return root;
}

describe("three-way drift check", () => {
  it(
    "finds nothing right after hand-down, and writes no round",
    async () => {
      const { root } = await speckitRoot({ repos: ["forge-ledger"] });
      await handDown(root, CHANGE, "1.2", { git });
      const r = await driftCheck(root, CHANGE, { now: NOW });
      expect(r.plans.map((p) => `${p.repo}/${p.feature.feature} from ${p.from}`)).toEqual([
        "forge-ledger/1.2 from workspace/.worktrees/add-transfer-limit/forge-ledger",
      ]);
      expect(r.found).toEqual([]);
      expect(r.unchanged).toBe(true);
      expect(r.round).toBeUndefined();
      expect(existsSync(join(root, "openspec/changes", CHANGE, "review/drift"))).toBe(false);
    },
    T,
  );

  it(
    "catches the seeded drifting plan as the hand-written golden says (golden)",
    async () => {
      const root = await drifted();
      const r = await driftCheck(root, CHANGE, { now: NOW });
      const want = parse(readFileSync(join(SPECKIT, "expected/drift.yaml"), "utf8")) as Row[];
      const got = r.found.map((f) => ({
        id: f.id,
        rule: f.rule,
        lens: f.lens,
        severity: f.severity,
        artifact: f.artifact,
        locator: f.locator,
        summary: f.summary,
        evidence: f.evidence,
      }));
      expect(got).toEqual(want);
      for (const f of r.found) {
        expect(f).toMatchObject({
          gate: "drift",
          round: 1,
          layer: "constitution",
          waivable: false,
          state: "open",
        });
        expect(f.why.length).toBeGreaterThan(20);
        expect(f.fix.text.length).toBeGreaterThan(20);
      }
      expect(r.round).toBe(1);
      expect(r.findings.map((f) => f.path)).toEqual(
        want.map((w) => `review/drift/1/${String(w.id)}.yaml`),
      );
      expect(
        existsSync(join(root, "openspec/changes", CHANGE, "review/drift/1/meta/round.yaml")),
      ).toBe(true);
    },
    T,
  );

  it(
    "is read by the lifecycle like any gate: the blocking contradiction stops a hand-off on the drift gate",
    async () => {
      const root = await drifted();
      await driftCheck(root, CHANGE, { now: NOW });
      const change = await changeStore(root).read(CHANGE);
      const reasons = await checkFindings(root, change, ["drift"]);
      expect(reasons.length).toBeGreaterThan(0);
      expect(reasons.map((x) => x.message).join("\n")).toMatch(
        /^Blocking finding plan-contradicts-design-if-6315f15d109e6f96 on the drift gate/,
      );
    },
    T,
  );

  it(
    "writes a new round only when something changed, and keeps a person's decisions",
    async () => {
      const root = await drifted();
      await driftCheck(root, CHANGE, { now: NOW });
      expect((await driftCheck(root, CHANGE, { now: NOW })).unchanged).toBe(true);
      // A person dismisses the fraud-scorer warning.
      const file = join(
        root,
        "openspec/changes",
        CHANGE,
        "review/drift/1/plan-adds-system-if-2a90dcd73ab60d91.yaml",
      );
      const f = parse(await readFile(file, "utf8")) as Row;
      await writeFile(
        file,
        stringify({
          ...f,
          state: "dismissed",
          resolution: {
            action: "not-relevant",
            by: "avery",
            at: NOW,
            reason: "The scorer is approved in another change.",
          },
        }),
      );
      // The developer puts the Northwind call back through the gateway.
      const plan = join(worktree(root, "forge-ledger"), "specs/1.2/plan.md");
      await writeFile(
        plan,
        (await readFile(plan, "utf8")).replace(
          "| POST /v2/velocity-checks | direct |",
          "| POST /v2/velocity-checks | gateway |",
        ),
      );
      const r = await driftCheck(root, CHANGE, { now: "2026-10-22T09:00:00Z" });
      expect(r.round).toBe(2);
      expect(r.findings.map((x) => [x.finding.id, x.finding.state])).toEqual([
        ["plan-adds-data-ledger-db.velocity-cache", "open"],
        ["plan-adds-interface-if-ceffd642df78ee78", "open"],
        ["plan-adds-interface-ledger-api.get.61ca50afac", "open"],
        ["plan-adds-system-if-2a90dcd73ab60d91", "dismissed"],
        ["plan-contradicts-design-ledger-db.account.daily-limit", "open"],
      ]);
    },
    T,
  );

  it(
    "reads the plan from the task's worktree when a task run is editing it",
    async () => {
      const { root } = await speckitRoot({ repos: ["forge-ledger"] });
      await handDown(root, CHANGE, "1.2", { git });
      const t = await openTaskWorktree(root, CHANGE, "1.2", "forge-ledger", git);
      expect(t.branch).toBe("task/add-transfer-limit/1.2");
      const plan = join(t.path, "specs/1.2/plan.md");
      await writeFile(
        plan,
        (await readFile(plan, "utf8")).replace(
          "| risk-engine | POST /risk/assess | gateway | S.GW.SOR | planned-new |",
          "| risk-engine | POST /risk/assess | gateway | S.GW.SOR | planned-new |\n| northwind-pay | POST /v2/payments | gateway | S.GW.VND | planned-modify |",
        ),
      );
      const r = await driftCheck(root, CHANGE, { now: NOW, write: false });
      expect(r.plans[0]!.from).toBe(
        "workspace/.worktrees/add-transfer-limit/.tasks/1.2/forge-ledger",
      );
      // The code calls Northwind's payments directly; the plan says through the gateway.
      expect(r.found.map((f) => [f.rule, f.summary])).toEqual([
        [
          "drift.plan-vs-code",
          "specs/1.2/plan.md in forge-ledger calls northwind-pay POST /v2/payments gateway; the code calls it direct.",
        ],
      ]);
    },
    T,
  );

  it(
    "compares the design with the code: a changed interface the code doesn't have",
    async () => {
      const { root } = await speckitRoot({ repos: ["forge-ledger"] });
      await handDown(root, CHANGE, "1.2", { git });
      const file = join(root, "openspec/changes", CHANGE, "interfaces.md");
      await writeFile(
        file,
        (await readFile(file, "utf8")).replace("if-5c55930b735276a9", "if-0000000000000000"),
      );
      const r = await driftCheck(root, CHANGE, { now: NOW, write: false });
      expect(r.found.map((f) => [f.rule, f.locator, f.summary])).toEqual([
        [
          "drift.design-vs-code",
          { line: 8 },
          "interfaces.md changes if-0000000000000000, portal-bff to audit-svc (POST /audit/events), which the code doesn't have.",
        ],
      ]);
    },
    T,
  );
});
