import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { countedRounds } from "../src/index.js";

/**
 * B2 (i): the rounds that count toward a gate's limit. A round a crash left behind, a folder
 * with neither its record (meta/round.yaml) nor a finding, reviewed nothing and doesn't count;
 * a clean round (its record, no finding) and a round that wrote findings do.
 */

const META = (round: number, lens: "ran" | "failed") =>
  [
    "schemaVersion: 1",
    "change: add-limit",
    "gate: define",
    `round: ${round}`,
    "createdAt: 2026-10-25T09:00:00Z",
    "findings: []",
    "rules: { ran: [], skipped: [] }",
    "lenses:",
    `  - { lens: complete, agent: complete-critic, state: ${lens}, rules: [], artifacts: [] }`,
    "discarded: []",
    "",
  ].join("\n");

const FINDING = "id: f-1\nrule: review.call-timeout-stated\nseverity: blocking\n";

describe("the rounds that count toward a gate's limit", () => {
  it("leaves out a round a crash left with no record and no finding", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-rounds-"));
    await mkdir(join(root, "org-pack"), { recursive: true });
    const round = (n: number) =>
      join(root, "openspec", "changes", "add-limit", "review", "define", String(n));
    // 1: a round that reviewed and wrote a finding.
    await mkdir(join(round(1), "meta"), { recursive: true });
    await writeFile(join(round(1), "meta", "round.yaml"), META(1, "ran"));
    await writeFile(join(round(1), "f-1.yaml"), FINDING);
    // 2: what a crash leaves: the folder and a lens's run summary, no record, no finding.
    await mkdir(join(round(2), "meta", "runs"), { recursive: true });
    await writeFile(join(round(2), "meta", "runs", "complete-critic.yaml"), "runId: run-1\n");
    // 3: a clean round: its record and no finding.
    await mkdir(join(round(3), "meta"), { recursive: true });
    await writeFile(join(round(3), "meta", "round.yaml"), META(3, "ran"));
    // 4: a crash after the findings were written: they count.
    await mkdir(round(4), { recursive: true });
    await writeFile(join(round(4), "f-1.yaml"), FINDING);
    // 5: every lens it was due failed (as before): it reviewed nothing.
    await mkdir(join(round(5), "meta"), { recursive: true });
    await writeFile(join(round(5), "meta", "round.yaml"), META(5, "failed"));
    // 6: an empty folder.
    await mkdir(round(6), { recursive: true });
    expect(await countedRounds(root, "add-limit", "define")).toEqual([1, 3, 4]);
  });
});
