import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { MockGitHost } from "@maycombhq/adapters";
import { changeHandoff, changeNew, changeStatus } from "../src/change-commands.js";

/**
 * v31 (WP-05): the quick path's plan hand-off checks each task as the stories stage checks a
 * story's (only a task with no criteria at all refuses it; the rest are notes), and lists the
 * org's knowledge the change leads to in knowledge.yaml, which rides with the hand-off.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");
const REPO = "forge/forge-metarepo";
const NOW = "2026-11-22T09:00:00Z";
const T = 60_000;
const ID = "daily-transfer-limit";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
}

const TASKS = [
  "## forge-ledger",
  "",
  "- [ ] t1 Check the daily limit before a transfer",
  "  - Given a transfer over the limit, when it is posted, then it is refused with 422.",
  "- [ ] t2 Write the limit's runbook",
  "",
].join("\n");

const DESIGN = `# Design

## Context

Transfers have no daily limit.

## In the code

| Repo         | Task | Has   | What                                  | Spec                                  |
| ------------ | ---- | ----- | ------------------------------------- | ------------------------------------- |
| forge-ledger | t1   | other | The limit checked before a transfer.  | transfer-limits: Daily transfer limit |
| forge-ledger | t2   | other | The limit's runbook.                  | -                                     |
`;

const SPEC = `## ADDED Requirements

### Requirement: Daily transfer limit

forge-ledger SHALL refuse a transfer that takes a day's total over the limit.

#### Scenario: Over the limit

- **WHEN** a transfer takes the day's total over the limit
- **THEN** it is refused
`;

async function quickChange(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-cli-quick-quality-"));
  await cp(join(FORGE, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
  for (const r of parse(readFileSync(join(FORGE, "expected/scan.yaml"), "utf8")) as Record<
    string,
    unknown
  >[]) {
    const p = parseRecord({ schemaVersion: 1, status: "current", ...r });
    if (!p.ok) throw new Error(String(r.id));
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  const c = capture();
  expect(
    await changeNew(root, { title: "Daily transfer limit", type: "quick", by: "pat" }, c.io, {
      now: NOW,
    }),
  ).toBe(0);
  const dir = join(root, "openspec/changes", ID);
  await writeFile(join(dir, "proposal.md"), "# Daily transfer limit\n\nTransfers get a limit.\n");
  await mkdir(join(dir, "specs/transfer-limits"), { recursive: true });
  await writeFile(join(dir, "specs/transfer-limits/spec.md"), SPEC);
  await writeFile(join(dir, "design.md"), DESIGN);
  await writeFile(join(dir, "tasks.md"), TASKS);
  const round = join(dir, "review/plan/1/meta");
  await mkdir(round, { recursive: true });
  await writeFile(
    join(round, "round.yaml"),
    `schemaVersion: 1\nchange: ${ID}\ngate: plan\nround: 1\ncreatedAt: 2026-11-22T00:00:00Z\nfindings: []\n`,
  );
  return root;
}

describe("the quick path's plan hand-off (v31, WP-05)", () => {
  it(
    "is refused while a task has no acceptance criteria, with its line and what to add",
    async () => {
      const root = await quickChange();
      const s = capture();
      await changeStatus(root, ID, {}, s.io);
      const blocked = s.out.slice(s.out.indexOf("Blocked by:"));
      expect(blocked).toContain(
        "  - tasks.md:5: task t2 (Write the limit's runbook) has no acceptance criteria. Add one under its line, indented: \"- Given …, when …, then …\". Or name, in its row of design.md's ## In the code, a requirement of its spec delta that has a #### Scenario:.",
      );
      // t1 has a criterion of its own: it is not named.
      expect(s.out.join("\n")).not.toContain("task t1");
      const gh = new MockGitHost([{ repo: REPO }]);
      const c = capture();
      expect(
        await changeHandoff(root, ID, { by: "pat", approve: true, repo: REPO }, c.io, {
          gitHost: gh,
          now: NOW,
        }),
      ).toBe(1);
      expect(c.err.join("\n")).toContain("task t2 (Write the limit's runbook)");
      expect(gh.journal).toHaveLength(0);
      // Refused: nothing is written, the knowledge list neither.
      expect(c.out.join("\n")).not.toContain("Knowledge:");
      expect(existsSync(join(root, "openspec/changes", ID, "knowledge.yaml"))).toBe(false);
    },
    T,
  );

  it(
    "raises it once each task has criteria, with knowledge.yaml saying nothing was found",
    async () => {
      const root = await quickChange();
      const dir = join(root, "openspec/changes", ID);
      await writeFile(
        join(dir, "tasks.md"),
        TASKS.replace(
          "- [ ] t2 Write the limit's runbook",
          "- [ ] t2 Write the limit's runbook\n  - Given the runbook, when a limit is raised by hand, then it says who may do it.",
        ),
      );
      const published: string[][] = [];
      const c = capture();
      const code = await changeHandoff(root, ID, { by: "pat", approve: true, repo: REPO }, c.io, {
        gitHost: new MockGitHost([{ repo: REPO }]),
        now: NOW,
        publisher: {
          publish: async (i) => {
            published.push(i.files);
            return { commit: "abc1234" };
          },
        },
      });
      expect(c.err).toEqual([]);
      expect(code).toBe(0);
      expect(c.out).toContain(
        "Knowledge: nothing in the org's knowledge was found for this change (knowledge.yaml).",
      );
      expect(published[0]).toContain(`openspec/changes/${ID}/knowledge.yaml`);
      expect(parse(await readFile(join(dir, "knowledge.yaml"), "utf8"))).toEqual({
        schemaVersion: 1,
        change: ID,
        items: [],
        nearMisses: [],
      });
    },
    T,
  );

  it(
    "says no knowledge source is set up when the metarepo has none",
    async () => {
      const root = await quickChange();
      await writeFile(join(root, "org-pack/sources.yaml"), "schemaVersion: 3\n");
      // An empty inputs/ folder is no source (review of PR #9).
      await mkdir(join(root, "inputs"), { recursive: true });
      const dir = join(root, "openspec/changes", ID);
      await writeFile(
        join(dir, "tasks.md"),
        TASKS.replace(
          "- [ ] t2 Write the limit's runbook",
          "- [ ] t2 Write the limit's runbook\n  - Given the runbook, when a limit is raised by hand, then it says who may do it.",
        ),
      );
      const c = capture();
      const code = await changeHandoff(root, ID, { by: "pat", approve: true, repo: REPO }, c.io, {
        gitHost: new MockGitHost([{ repo: REPO }]),
        now: NOW,
        publisher: { publish: async () => ({ commit: "abc1234" }) },
      });
      expect(c.err).toEqual([]);
      expect(code).toBe(0);
      expect(c.out).toContain(
        "Knowledge: nothing listed. No knowledge sources are set up: add a wiki with atticus sources add <type> <location>, or drop documents in inputs/ (atticus intake add <files>).",
      );
    },
    T,
  );
});
