import { isAssistantResolution, type FindingAction } from "@maycombhq/core";
import type { z } from "zod";
import { readRound, reviewedGates, roundsOf } from "./findings.js";

/**
 * Facts a person recorded for a change (ADR 0115 addendum, W2): what they wrote on a finding at
 * any gate when they acted on it with a reason (edit-and-apply: the fact they wrote in; waive:
 * why the risk is accepted; not-relevant: why it doesn't apply). The lenses of every later
 * round read them as data, with who and when, so a fact a person recorded isn't raised again
 * without new evidence. Read from the finding files: facts, nothing judged.
 */
export interface RecordedFact {
  /** The gate where the person acted. */
  gate: string;
  finding: string;
  summary: string;
  action: z.infer<typeof FindingAction>;
  by: string;
  at: string;
  reason: string;
}

/** The suffix a carried decision's reason gets: where it was decided (findings.ts). */
export const decidedAt = (gate: string, path: string) =>
  ` (decided at the ${gate} gate: see ${path})`;
const DECIDED_AT = / \(decided at the ([a-z0-9-]+) gate: see [^)]+\)$/;

/** A reason without the carried suffix, and the gate it names, if any. */
export function decidedReason(reason: string): { reason: string; gate?: string } {
  const m = DECIDED_AT.exec(reason);
  return m ? { reason: reason.slice(0, m.index), gate: m[1]! } : { reason };
}

const RECORDED: ReadonlySet<string> = new Set(["edit-and-apply", "waive", "not-relevant"]);

export async function recordedFacts(root: string, change: string): Promise<RecordedFact[]> {
  const out = new Map<string, RecordedFact>();
  for (const gate of await reviewedGates(root, change))
    for (const n of await roundsOf(root, change, gate))
      for (const { finding: f } of (await readRound(root, change, gate, n)).findings) {
        const r = f.resolution;
        if (!r?.reason || !RECORDED.has(r.action) || f.state === "open") continue;
        // What an assistant wrote isn't what people recorded (ADR 0115 addendum, 2026-10-25): a
        // live run's drafter dismissed a finding, and its words reached the lenses as a person's.
        if (isAssistantResolution(r)) continue;
        const d = decidedReason(r.reason);
        const key = [f.id, r.action, r.by, r.at].join("|");
        // A carried copy is the same decision: its reason names the gate it was made at.
        if (out.has(key)) continue;
        out.set(key, {
          gate: d.gate ?? gate,
          finding: f.id,
          summary: f.summary,
          action: r.action,
          by: r.by,
          at: r.at,
          reason: d.reason,
        });
      }
  return [...out.values()].sort(
    (a, b) =>
      a.at.localeCompare(b.at) ||
      a.gate.localeCompare(b.gate) ||
      a.finding.localeCompare(b.finding),
  );
}

const ACTIONS: Record<string, string> = {
  "edit-and-apply": "wrote in",
  waive: "waived it",
  "not-relevant": "dismissed it as not relevant",
};

/** The facts as a lens's data block: each with the gate, the finding, who, when and the words. */
export function recordedText(facts: readonly RecordedFact[]): string {
  return [
    "Facts and decisions people recorded on this change's findings, with who and when:",
    ...facts.map(
      (f) =>
        `- ${f.gate} gate, finding ${f.finding} ("${f.summary}"): ${f.by} ${ACTIONS[f.action] ?? f.action} on ${f.at.slice(0, 10)}: ${f.reason}`,
    ),
  ].join("\n");
}
