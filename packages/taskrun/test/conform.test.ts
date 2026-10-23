import { readFileSync } from "node:fs";
import { cp, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { MockRuntime } from "@maycombhq/ai";
import { Api } from "@maycombhq/core";
import { act, gateStatus } from "@maycombhq/naysayer";
import {
  conformanceOf,
  conformChange,
  CONFORM_GATE,
  runTask,
  type CommandRunner,
} from "../src/index.js";
import { CHANGE, FIXTURES, git, speckitRoot } from "./helpers.js";

/**
 * ADR 0114: after a task's build passes, Atticus rescans the task branch's commit from the base
 * clone and checks it against the change's target flows. The fixture (fixtures/conform) builds
 * part of the transfer limit: the golden findings are hand-written.
 */

const T = 300_000;
const NOW = new Date("2026-10-23T09:00:00Z");
const now = () => NOW;
const CONFORM = join(FIXTURES, "conform");
const AFTER = join(CONFORM, "after/forge-ledger");

/** Lay the transfer limit's target flows, stories and today's spec over the change. */
async function withDesign(root: string) {
  const dir = join(root, "openspec/changes", CHANGE);
  await cp(join(CONFORM, "target-flows"), join(dir, "target-flows"), { recursive: true });
  await cp(join(CONFORM, "stories"), join(dir, "stories"), { recursive: true });
  await cp(join(CONFORM, "specs"), join(root, "specs"), { recursive: true });
  // The Forge dialect's own tests read ../../../repos from its folder (fixtures/forge layout).
  await cp(join(FIXTURES, "forge/repos/forge-ledger"), join(root, "../repos/forge-ledger"), {
    recursive: true,
    force: true,
  });
}

async function filesOf(dir: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(join(dir, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await filesOf(dir, p)));
    else out.push(p);
  }
  return out.sort();
}

/** A one-shot answer that writes the fixture's after state. */
async function afterAnswer(): Promise<string> {
  const blocks = await Promise.all(
    (await filesOf(AFTER)).map(
      async (p) => `=== file: ${p}\n${await readFile(join(AFTER, p), "utf8")}=== end file`,
    ),
  );
  return `I added the limit endpoint, the migration and the limit check.\n\n${blocks.join("\n")}\n`;
}

const passing: CommandRunner = async () => ({ exitCode: 0, stdout: "BUILD OK", stderr: "" });

describe("does the code do what the design says? (ADR 0114)", () => {
  it(
    "checks a passing task run's commit against its steps, and writes the findings on the conform gate",
    async () => {
      const { root } = await speckitRoot({ repos: ["forge-ledger"] });
      await withDesign(root);
      const text = await afterAnswer();
      const r = await runTask(root, CHANGE, "1.2", {
        level: "draft",
        by: "dev",
        runtime: new MockRuntime(() => text, { now }),
        git,
        now,
        commands: passing,
      });
      expect(r.state).toBe("built");
      expect(r.notes.at(-1)).toBe(
        "Checked against the design: 1 still there, 2 not in the design; the findings are on the conform gate (atticus change conform add-transfer-limit --task 1.2).",
      );
      const stored = Api.ConformRepoResult.parse(
        parse(
          await readFile(
            join(root, "openspec/changes", CHANGE, "conform/forge-ledger.yaml"),
            "utf8",
          ),
        ),
      );
      expect(stored).toMatchObject({
        repo: "forge-ledger",
        ref: "task/add-transfer-limit/1.2",
        commit: r.commit,
        task: "1.2",
        counts: { found: 0, missing: 0, stillThere: 1, unexpected: 2 },
      });
      expect(stored.base).not.toBe(r.commit);
      const gate = await gateStatus(root, CHANGE, CONFORM_GATE);
      expect(gate.open.blocking).toBe(1);
      expect(gate.mayProceed).toBe(false);
      // The person's working copies are untouched, and no worktree is left behind.
      expect(
        (await git(["worktree", "list"], join(root, "workspace/forge-ledger"))).stdout,
      ).not.toContain(".index");
    },
    T,
  );

  it(
    "checks the whole branch against every step: the golden findings, a dismissal kept on a rescan",
    async () => {
      const { root } = await speckitRoot({ repos: ["forge-ledger"] });
      await withDesign(root);
      const text = await afterAnswer();
      const built = await runTask(root, CHANGE, "1.2", {
        level: "draft",
        by: "dev",
        runtime: new MockRuntime(() => text, { now }),
        git,
        now,
        commands: passing,
      });
      const run = await conformChange(root, CHANGE, {
        repo: "forge-ledger",
        ref: built.branch,
        git,
        now: "2026-10-23T10:00:00Z",
      });
      expect(run.problems).toEqual([]);
      expect(run.results[0]!.problems).toEqual([]);
      const items = run.results[0]!.items;
      const want = parse(readFileSync(join(CONFORM, "expected/result.yaml"), "utf8")) as {
        items: { status: string; check: string; flow?: string; item?: number; what: string }[];
      };
      expect(items.map((i) => [i.status, i.check, i.flow, i.item, i.what])).toEqual(
        want.items.map((i) => [i.status, i.check, i.flow, i.item, i.what]),
      );
      const gate = await gateStatus(root, CHANGE, CONFORM_GATE);
      const golden = parse(readFileSync(join(CONFORM, "expected/findings.yaml"), "utf8")) as {
        id: string;
        rule: string;
        severity: string;
        artifact: string;
        summary: string;
        evidence: unknown[];
      }[];
      expect(
        gate.findings.map(({ finding: f }) => ({
          id: f.id,
          rule: f.rule,
          severity: f.severity,
          artifact: f.artifact,
          summary: f.summary,
          evidence: f.evidence,
        })),
      ).toEqual(golden);

      // A person marks the extra refund call not relevant; a rescan keeps the decision.
      await act(root, CHANGE, "conform-unexpected-call-if-e25b9623de50b834", "not-relevant", {
        by: "dev",
        reason: "The refund call belongs to the next change.",
        now: "2026-10-23T10:05:00Z",
      });
      await conformChange(root, CHANGE, {
        repo: "forge-ledger",
        ref: built.branch,
        git,
        now: "2026-10-23T10:10:00Z",
      });
      const view = Api.ChangeConformance.parse(await conformanceOf(root, CHANGE));
      expect(view.flows).toBe(2);
      expect(
        view.results[0]!.items.filter((i) => i.finding).map((i) => [
          i.finding!.id,
          i.finding!.state,
        ]),
      ).toEqual([
        ["conform-missing-call-ledger-api-create-transfer-2", "open"],
        ["conform-still-there-call-ledger-api-create-transfer-4", "open"],
        ["conform-unexpected-call-if-e25b9623de50b834", "dismissed"],
        ["conform-unexpected-table-ledger-db-limit-override", "open"],
      ]);
    },
    T,
  );

  it(
    "has nothing to check for a change with no target flows, and says when the branch isn't there",
    async () => {
      const { root } = await speckitRoot({ repos: ["forge-ledger"] });
      expect(await conformChange(root, CHANGE, { git })).toEqual({
        results: [],
        problems: [],
        flows: 0,
      });
      await withDesign(root);
      const r = await conformChange(root, CHANGE, { git, ref: "task/add-transfer-limit/9.9" });
      expect(r.results).toEqual([]);
      expect(r.problems).toEqual([
        "forge-ledger has no task/add-transfer-limit/9.9 yet, so there is no code to check: open the change (atticus workspace open add-transfer-limit --repos forge-ledger) or name the branch with --ref.",
      ]);
    },
    T,
  );
});
