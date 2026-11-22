import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { Api, parseFacts, type Fact } from "@maycombhq/core";
import { gateStatus, readRound, roundsOf } from "@maycombhq/naysayer";
import {
  conformanceOf,
  conformChange,
  conformAfterBuild,
  CONFORM_GATE,
  type ScanAt,
} from "../src/index.js";
import { CHANGE, FIXTURES, git, speckitRoot } from "./helpers.js";

/**
 * ADR 0206 part A: conformance of operations, end to end on a metarepo with a base clone. The
 * scan of the branch's commit is the fixture's facts (fixtures/conform-operations), given through
 * `scanAt`, so the outcomes and findings are the golden ones; git and the files are real.
 */

const T = 300_000;
const OPS = join(FIXTURES, "conform-operations");
const facts = (name: string): Fact[] => {
  const r = parseFacts(readFileSync(join(OPS, "facts", name), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};
const tree = (repo: string) =>
  readFileSync(join(OPS, "tree", `${repo}.txt`), "utf8")
    .split("\n")
    .filter(Boolean);

/** forge-ledger at the branch's commit, as the fixture has it. */
const scanAt =
  (unread: string[] = []): ScanAt =>
  async () => ({
    records: [],
    files: tree("forge-ledger"),
    problems: [],
    basis: { from: "facts", unread },
    facts: facts("forge-ledger.after.jsonl"),
  });

async function withOperations(root: string) {
  const dir = join(root, "openspec/changes", CHANGE, "target-flows");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "_operations.yaml"),
    readFileSync(join(OPS, "target-flows/_operations.yaml"), "utf8").replace(
      "change: move-orders-to-anvil",
      `change: ${CHANGE}`,
    ),
  );
}

describe("operations checked against the code (ADR 0206 part A)", () => {
  it(
    "keeps each claim's outcome in conform/<repo>.yaml and writes the golden findings on the conform gate",
    async () => {
      const { root } = await speckitRoot({ repos: ["forge-ledger"] });
      await withOperations(root);
      const run = await conformChange(root, CHANGE, {
        repo: "forge-ledger",
        ref: "HEAD",
        git,
        now: "2026-11-21T09:00:00Z",
        scanAt: scanAt(),
      });
      expect(run.flows).toBe(0);
      expect(run.claims).toBe(11);
      const stored = Api.ConformRepoResult.parse(
        parse(
          await readFile(
            join(root, "openspec/changes", CHANGE, "conform/forge-ledger.yaml"),
            "utf8",
          ),
        ),
      );
      expect(stored.claims?.map((c) => [c.outcome, c.check, c.from.operation])).toEqual([
        ["present-differently", "deployment", "deploy-anvil"],
        ["present-differently", "secret", "ledger-key"],
        ["missing", "pipeline", "anvil-pipeline"],
        ["not-checkable", "config", "notify"],
        ["not-checkable", "cut-over", "switch"],
      ]);
      expect(stored.counts.claims).toEqual({
        present: 0,
        differs: 2,
        missing: 1,
        notCheckable: 2,
        unconfirmed: 0,
      });
      expect(JSON.stringify(stored)).not.toContain("set-in-file");

      const want = (
        parse(readFileSync(join(OPS, "expected/findings.yaml"), "utf8")) as {
          id: string;
          rule: string;
          severity: string;
          artifact: string;
          line: number;
        }[]
      ).filter((f) => f.id.endsWith("-forge-ledger"));
      const round = (await roundsOf(root, CHANGE, CONFORM_GATE)).at(-1)!;
      const got = (await readRound(root, CHANGE, CONFORM_GATE, round)).findings.map((f) => ({
        id: f.finding.id,
        rule: f.finding.rule,
        severity: f.finding.severity,
        artifact: f.finding.artifact,
        line: (f.finding.locator as { line?: number }).line,
      }));
      expect(got.sort((a, b) => a.id.localeCompare(b.id))).toEqual(
        want.sort((a, b) => a.id.localeCompare(b.id)),
      );
      const gate = await gateStatus(root, CHANGE, CONFORM_GATE);
      expect(gate.open.blocking).toBe(5);

      const view = await conformanceOf(root, CHANGE);
      expect(view?.claims).toBe(11);
      expect(view?.results[0]!.claims?.[2]!.finding).toEqual({
        id: "conform-missing-pipeline-anvil-pipeline-forge-ledger",
        state: "open",
      });
    },
    T,
  );

  it(
    "reads the branch's own facts from the change folder for the files no fact covers, and never writes the catalog",
    async () => {
      const { root } = await speckitRoot({ repos: ["forge-ledger"] });
      await withOperations(root);
      const before = await readFile(
        join(root, "catalog/generated/components/ledger-api.yaml"),
        "utf8",
      ).catch(() => "");
      const r = await conformChange(root, CHANGE, {
        repo: "forge-ledger",
        ref: "HEAD",
        git,
        now: "2026-11-21T09:00:00Z",
        scanAt: scanAt(["deploy/anvil.yaml"]),
      });
      const deploy = r.results[0]!.claims!.find((c) => c.check === "deployment")!;
      expect(deploy.outcome).toBe("unconfirmed");
      expect(deploy.next).toContain(`openspec/changes/${CHANGE}/conform/facts/forge-ledger.jsonl`);
      expect(
        await readFile(join(root, "catalog/generated/components/ledger-api.yaml"), "utf8").catch(
          () => "",
        ),
      ).toBe(before);
    },
    T,
  );

  it(
    "the end of a task run notes the claims, as it notes the flows",
    async () => {
      const { root } = await speckitRoot({ repos: ["forge-ledger"] });
      await withOperations(root);
      const head = (
        await git(["rev-parse", "HEAD"], join(root, "workspace/forge-ledger"))
      ).stdout.trim();
      const record = { state: "built", commit: head, branch: "HEAD", notes: [] as string[] };
      await conformAfterBuild(
        {
          root,
          t: { change: { id: CHANGE }, task: { id: "o5.2" } },
          record,
          git,
          now: () => new Date("2026-11-21T09:00:00Z"),
        },
        { scanAt: scanAt() },
      );
      expect(record.notes.at(-1)).toBe(
        `Checked against the design: 1 claim missing; the findings are on the conform gate (atticus change conform ${CHANGE} --task o5.2).`,
      );
    },
    T,
  );
});
