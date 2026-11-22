import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { act, readRound, roundsOf } from "@maycombhq/naysayer";
import { issueFingerprint, readAccepted, writeStageGate, type LoopFinding } from "../src/index.js";

/**
 * ADR 0203 A, the second review's blocker: a stage's gate carries a finding's acceptance by its
 * id (`stage-<fingerprint>`, the stage's rule and target) and never by the C3 fingerprint, whose
 * summary is the message's first 197 characters and which, for a rule with no record, doesn't
 * hold the target. Two findings of one rule whose messages agree that far but whose targets
 * differ (the consumers left out, the folder, the fields, the entry) are two findings: one
 * accepted says nothing of the other, and the other is written, open. Invented Forge names.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "../../../fixtures");
const CHANGE = "add-fraud-check";

async function root(): Promise<string> {
  const r = await mkdtemp(join(tmpdir(), "atticus-accept-gate-"));
  await mkdir(join(r, "org-pack"), { recursive: true });
  for (const row of parse(readFileSync(join(FIX, "specs/catalog.yaml"), "utf8")) as unknown[]) {
    const p = parseRecord(row);
    if (!p.ok) throw new Error("bad fixture record");
    const f = join(r, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  await cp(join(FIX, "stages/changes"), join(r, "openspec/changes"), { recursive: true });
  return r;
}

/** Words longer than the 197 characters a C3 summary keeps, so the list comes after them. */
const LONG =
  "Flow forge-orders.place-order changes POST /orders in a way that breaks who calls it today " +
  "(the request gains the required field shopId; the response drops reservationId and the " +
  "error body changes its shape), but doesn't list ";

const finding = (rule: string, target: string, tail: string): LoopFinding => ({
  fingerprint: issueFingerprint(rule, target),
  rule,
  target,
  message: `${LONG}${tail}`,
  blocking: true,
  source: "stage",
  seenIn: [1],
});

/** Each exposed rule: the accepted target, and another with the same first 197 characters. */
const PROBES: [string, "architecture" | "stories", [string, string], [string, string]][] = [
  [
    "delta.consumer-missing",
    "architecture",
    ["forge-orders.place-order:forge-web", "forge-web, which the map shows calling it."],
    [
      "forge-orders.place-order:forge-pos,forge-web",
      "forge-pos and forge-web, which the map shows calling it.",
    ],
  ],
  [
    "delta.new-folder",
    "architecture",
    ["forge-orders.place-order#1:new:src/main/java/forge/screen", "the folder src/.../screen."],
    ["forge-orders.place-order#1:new:src/main/java/forge/ledger", "the folder src/.../ledger."],
  ],
  [
    "stories.field-not-checked",
    "stories",
    ["1.3:deliver_by", "a criterion for deliver_by."],
    ["1.3:deliver_by,gift_note", "a criterion for deliver_by or gift_note."],
  ],
  [
    "delta.unknown-entry",
    "architecture",
    ["forge-orders.place-order#1:forge-stock:POST /holds", "POST /holds on forge-stock."],
    ["forge-orders.place-order#1:forge-stock:DELETE /stock", "DELETE /stock on forge-stock."],
  ],
];

const opts = (stage: "architecture" | "stories", now: string) => ({
  change: CHANGE,
  stage,
  source: stage === "stories" ? "stage/stories.yaml" : "target-flows/",
  rerun: `atticus change ${stage} ${CHANGE}`,
  now,
});

const newest = async (r: string, gate: string) => {
  const n = (await roundsOf(r, CHANGE, gate)).at(-1)!;
  return { n, findings: (await readRound(r, CHANGE, gate, n)).findings.map((s) => s.finding) };
};

describe("an acceptance covers its own target, never one whose words agree for 197 characters", () => {
  it.each(PROBES)(
    "%s: another finding in the round changes, and the new one is open and not accepted",
    async (rule, stage, [ta, wa], [tb, wb]) => {
      const r = await root();
      const gate = `stage-${stage}`;
      const a = finding(rule, ta, wa);
      const b = finding(rule, tb, wb);
      expect(a.message.slice(0, 197)).toBe(b.message.slice(0, 197));
      const other = (n: number): LoopFinding => ({
        ...finding("delta.empty", `forge-orders.place-order#${n}`, ""),
        message: `Step ${n} of forge-orders.place-order is empty.`,
      });
      await writeStageGate(r, [a, other(1)], new Map(), opts(stage, "2026-11-21T09:00:00Z"));
      await act(r, CHANGE, `stage-${a.fingerprint}`, "waive", {
        by: "pat",
        reason: "Not affected this release",
        now: "2026-11-21T10:00:00Z",
      });
      const accepted = await readAccepted(r, CHANGE);
      expect([...accepted.keys()]).toEqual([a.fingerprint]);

      await writeStageGate(r, [b, other(2)], accepted, opts(stage, "2026-11-21T11:00:00Z"));
      const { n, findings } = await newest(r, gate);
      expect(n).toBe(2);
      expect(findings.find((f) => f.id === `stage-${b.fingerprint}`)).toMatchObject({
        state: "open",
      });
      expect(findings.find((f) => f.id === `stage-${b.fingerprint}`)?.resolution).toBeUndefined();
      expect((await readAccepted(r, CHANGE)).has(b.fingerprint)).toBe(false);
    },
  );

  it.each(PROBES)(
    "%s: nothing else changes, and the new finding is still written, so a person can act on it",
    async (rule, stage, [ta, wa], [tb, wb]) => {
      const r = await root();
      const gate = `stage-${stage}`;
      const a = finding(rule, ta, wa);
      const b = finding(rule, tb, wb);
      await writeStageGate(r, [a], new Map(), opts(stage, "2026-11-21T09:00:00Z"));
      await act(r, CHANGE, `stage-${a.fingerprint}`, "waive", {
        by: "pat",
        reason: "Not affected this release",
        now: "2026-11-21T10:00:00Z",
      });
      const accepted = await readAccepted(r, CHANGE);
      const w = await writeStageGate(r, [b], accepted, opts(stage, "2026-11-21T11:00:00Z"));
      expect(w.unchanged).toBe(false);
      const { findings } = await newest(r, gate);
      expect(findings.map((f) => [f.id, f.state])).toEqual([[`stage-${b.fingerprint}`, "open"]]);
      await act(r, CHANGE, `stage-${b.fingerprint}`, "waive", {
        by: "pat",
        reason: "Neither is affected",
        now: "2026-11-21T12:00:00Z",
      });
      expect([...(await readAccepted(r, CHANGE)).keys()]).toEqual([b.fingerprint]);
    },
  );

  it("carries an acceptance by its id when the same target's words change", async () => {
    const r = await root();
    const t = "forge-orders.place-order:forge-web";
    const a = finding("delta.consumer-missing", t, "forge-web.");
    await writeStageGate(r, [a], new Map(), opts("architecture", "2026-11-21T09:00:00Z"));
    await act(r, CHANGE, `stage-${a.fingerprint}`, "waive", {
      by: "pat",
      reason: "Web moves off it first",
      now: "2026-11-21T10:00:00Z",
    });
    // The redraft's message words the same target differently, inside the first 197 characters.
    const again = { ...a, message: `Flow forge-orders.place-order, redrafted: ${a.message}` };
    await writeStageGate(
      r,
      [again],
      await readAccepted(r, CHANGE),
      opts("architecture", "2026-11-21T11:00:00Z"),
    );
    const { findings } = await newest(r, "stage-architecture");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      id: `stage-${a.fingerprint}`,
      state: "waived",
      resolution: { by: "pat", reason: "Web moves off it first" },
    });
    // The gate shows the current draft's words.
    expect(findings[0]!.why).toBe(again.message);
    expect([...(await readAccepted(r, CHANGE)).keys()]).toEqual([a.fingerprint]);
  });
});

describe("a stage's own finding is never stranded by a dismissal (the second review of beta.30)", () => {
  it("refuses not-relevant, so the finding stays open across the next run and a person may still accept it", async () => {
    const r = await root();
    const folder = finding(
      "delta.new-folder",
      "forge-orders.place-order#1:new:src/main/java/forge/screen",
      "the folder src/.../screen.",
    );
    const archived: LoopFinding = {
      ...finding("feature.archived-repo", "forge-orders.place-order:forge-legacy", ""),
      message: "The flow forge-orders.place-order is placed in forge-legacy, which is archived.",
    };
    await writeStageGate(
      r,
      [folder, archived],
      new Map(),
      opts("architecture", "2026-11-22T09:00:00Z"),
    );
    for (const f of [folder, archived])
      await expect(
        act(r, CHANGE, `stage-${f.fingerprint}`, "not-relevant", {
          by: "pat",
          reason: "Not in this release",
          now: "2026-11-22T10:00:00Z",
        }),
      ).rejects.toThrow(
        `stage-${f.fingerprint} is the architecture stage's own finding: only a fix to the draft or a person's acceptance settles it, so it can't be dismissed as not relevant.`,
      );
    // The stage runs again with the same draft: both are still open, nothing carried.
    await writeStageGate(
      r,
      [folder, archived],
      await readAccepted(r, CHANGE),
      opts("architecture", "2026-11-22T11:00:00Z"),
    );
    const { findings } = await newest(r, "stage-architecture");
    expect(findings.map((f) => f.state)).toEqual(["open", "open"]);
    // The acceptable one is accepted, and the stage reads the acceptance.
    await act(r, CHANGE, `stage-${folder.fingerprint}`, "waive", {
      by: "pat",
      reason: "The folder is new on purpose",
      now: "2026-11-22T12:00:00Z",
    });
    expect([...(await readAccepted(r, CHANGE)).keys()]).toEqual([folder.fingerprint]);
  });
});
