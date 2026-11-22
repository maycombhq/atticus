import { join } from "node:path";
import { changeFolder, writeFileAtomic } from "@maycombhq/changes";
import { Finding, STAGE_GATE_PREFIX, toCanonicalYaml } from "@maycombhq/core";
import { fingerprint, readRound, roundsOf, writeFinding, type StoredFinding } from "./findings.js";

/**
 * Rounds for a check that runs again and again (traceability after each generation or
 * build): the newest round always holds the whole picture, so the lifecycle's and the
 * critic's reading of a gate works unchanged. A new round is written only when something
 * changed; a finding seen before keeps its state and resolution (dismissed stays dismissed).
 * The same rules as the Spec Kit layer's drift rounds. Conformance (ADR 0114) and the stages'
 * own gates (ADR 0203 A) write through it too, so it lives beside the rounds it writes.
 */
/**
 * ADR 0203 A.1: the built-in gate each stage's own blocking findings are written to as C3
 * findings (`stage-feature`, `stage-architecture`, `stage-stories`, `stage-small`), so a person
 * can accept one with `atticus finding … waive`. No phase's hand-off reads these gates: the
 * stage's own state already holds its phase.
 */
export { STAGE_GATE_PREFIX };
export const stageGateOf = (stage: string) => `${STAGE_GATE_PREFIX}${stage}`;

export interface RoundWrite {
  gate: string;
  round?: number;
  unchanged: boolean;
  findings: StoredFinding[];
}

/**
 * What a round says, to tell whether a new one is due. By the C3 fingerprint, or, for a gate whose
 * ids say exactly what each finding is (`carryById`), by the id and the words: the fingerprint's
 * summary is the message's first 197 characters and, for a rule with no record, doesn't hold the
 * target, so two findings it can't tell apart would be read as one.
 */
const sig = (fs: Finding[], byId = false) =>
  fs
    .map((f) =>
      byId
        ? `${f.id}|${f.state}|${f.severity}|${f.why}`
        : `${fingerprint(f)}|${f.state}|${f.severity}`,
    )
    .sort()
    .join("\n");

export async function writeGateRound(
  root: string,
  change: string,
  gate: string,
  fresh: Finding[],
  now: string,
  /**
   * ADR 0203 A: carry a finding's state and resolution by its id only, for a gate whose ids say
   * exactly what each finding is (a stage's, `stage-<fingerprint>`, the stage's rule and target):
   * its words may change, and another finding's words may agree with them for as long as the C3
   * fingerprint reads, so the fingerprint is never used to match one there.
   */
  o: { carryById?: boolean } = {},
): Promise<RoundWrite> {
  const rounds = await roundsOf(root, change, gate);
  const last = rounds.at(-1);
  const prev = last
    ? (await readRound(root, change, gate, last)).findings.map((s) => s.finding)
    : [];
  const byPrint = new Map(prev.map((f) => [fingerprint(f), f]));
  const byId = new Map(prev.map((f) => [f.id, f]));
  const taken = new Set<string>();
  const next: Finding[] = [];
  for (const f of fresh) {
    const before = o.carryById ? byId.get(f.id) : byPrint.get(fingerprint(f));
    let id = f.id;
    for (let i = 2; taken.has(id); i++) id = `${f.id}-${i}`;
    taken.add(id);
    const merged = Finding.safeParse({
      ...f,
      id,
      createdAt: before?.createdAt ?? f.createdAt,
      ...(before?.resolution ? { state: before.state, resolution: before.resolution } : {}),
    });
    next.push(merged.success ? merged.data : { ...f, id });
  }
  const byIds = !!o.carryById;
  if (sig(next, byIds) === sig(prev, byIds) && (last !== undefined || next.length === 0)) {
    const findings = last ? (await readRound(root, change, gate, last)).findings : [];
    return { gate, ...(last ? { round: last } : {}), unchanged: true, findings };
  }
  const round = (last ?? 0) + 1;
  const findings: StoredFinding[] = [];
  for (const f of next.sort((a, b) => a.id.localeCompare(b.id))) {
    const g = Finding.parse({ ...f, round, gate, change });
    await writeFinding(root, g);
    findings.push({ finding: g, path: `review/${gate}/${round}/${g.id}.yaml` });
  }
  await writeFileAtomic(
    join(changeFolder(root, change), "review", gate, String(round), "meta", "round.yaml"),
    toCanonicalYaml(
      {
        schemaVersion: 1,
        change,
        gate,
        round,
        createdAt: now,
        findings: findings.map((f) => ({
          id: f.finding.id,
          rule: f.finding.rule,
          severity: f.finding.severity,
        })),
      },
      ["schemaVersion", "change", "gate", "round", "createdAt"],
    ),
  );
  return { gate, round, unchanged: false, findings };
}
