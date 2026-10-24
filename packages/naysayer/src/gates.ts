import {
  BUILT_IN_GATES,
  changeStore,
  checkFindings,
  loadChangeContext,
  type ChangeContext,
} from "@maycombhq/changes";
import { gateRoundLimit, type ChangeLifecycle } from "@maycombhq/core";
import { CriticError } from "./errors.js";
import {
  checkRoundDue,
  countedRounds,
  readRound,
  readRoundMeta,
  roundsOf,
  type StoredFinding,
} from "./findings.js";

export interface SeverityCounts {
  blocking: number;
  gaps: number;
  risks: number;
  ideas: number;
}

export interface GateStatus {
  gate: string;
  /** The newest round, if the critic has run at this gate. */
  round?: number;
  /** The round limit; undefined when the gate has none (ADR 0087). */
  maxRounds?: number;
  /** Open findings in the newest round, by severity. */
  open: SeverityCounts;
  /** Every finding in the newest round, whatever its state. */
  total: SeverityCounts;
  /**
   * Same answer as the lifecycle's hand-off check: no open blocking finding, no open gap, no
   * unreadable file; and no AI lens still waiting for the person's assistant.
   */
  mayProceed: boolean;
  /** The rounds are used up and something still blocks: a person decides (waive, fix by hand, or return). */
  humanDecides: boolean;
  /**
   * The rounds are used up and a person acted on every blocking finding of the newest round: one
   * checking round past the limit reviews what they did (ADR 0115 addendum).
   */
  checkRound: boolean;
  /** Checking rounds past the limit that have run at the gate (ADR 0115 addendum). */
  checkRoundsRun: number;
  /** AI lenses of the newest round that are still with the person's assistant (hand-off). */
  waiting: { lens: string; runId: string }[];
  /** Why the hand-off may not proceed, as the lifecycle reports it. */
  reasons: string[];
  findings: StoredFinding[];
}

const count = (fs: StoredFinding[]): SeverityCounts => ({
  blocking: fs.filter((f) => f.finding.severity === "blocking").length,
  gaps: fs.filter((f) => f.finding.severity === "gap").length,
  risks: fs.filter((f) => f.finding.severity === "risk").length,
  ideas: fs.filter((f) => f.finding.severity === "idea").length,
});

/** The gate's critic round limit, or undefined when it has none (ADR 0087). */
export function maxRoundsOf(lifecycle: ChangeContext, gate: string): number | undefined {
  return gateRoundLimit(lifecycle.orgPack.gates, gate);
}

export async function gateStatusOf(
  root: string,
  lifecycle: ChangeContext,
  change: ChangeLifecycle,
  gate: string,
): Promise<GateStatus> {
  const rounds = await roundsOf(root, change.id, gate);
  const round = rounds.at(-1);
  const { findings } = round ? await readRound(root, change.id, gate, round) : { findings: [] };
  const open = findings.filter((f) => f.finding.state === "open");
  // The lifecycle's own reading decides: one answer for the critic and for the hand-off.
  const blocking = (await checkFindings(root, change, [gate])).map((r) => r.message);
  // A lens the person's assistant hasn't answered yet is a review that hasn't happened: the
  // gate doesn't open on layer 1 alone while one is out.
  const waiting = round
    ? ((await readRoundMeta(root, change.id, gate, round))?.lenses ?? [])
        .filter((l) => l.state === "waiting" && l.runId)
        .map((l) => ({ lens: l.lens, runId: l.runId! }))
    : [];
  const reasons = [
    ...blocking,
    ...waiting.map(
      (w) =>
        `The ${w.lens} lens is still with your assistant: run atticus handoff done ${w.runId}.`,
    ),
  ];
  const maxRounds = maxRoundsOf(lifecycle, gate);
  const usedUp =
    maxRounds !== undefined && (await countedRounds(root, change.id, gate)).length >= maxRounds;
  let checkRoundsRun = 0;
  for (const n of rounds)
    if ((await readRoundMeta(root, change.id, gate, n))?.checkRound) checkRoundsRun++;
  return {
    gate,
    ...(round ? { round } : {}),
    ...(maxRounds !== undefined ? { maxRounds } : {}),
    open: count(open),
    total: count(findings),
    mayProceed: reasons.length === 0,
    humanDecides: blocking.length > 0 && usedUp,
    checkRound: usedUp && (await checkRoundDue(root, change.id, gate)).length > 0,
    checkRoundsRun,
    waiting,
    reasons,
    findings,
  };
}

/** Gates Atticus itself writes findings to (drift check, Spec Kit hand-up, traceability), whether or not gates.yaml lists them. */
export { BUILT_IN_GATES };

/** Counts for a gate and whether its hand-off may proceed. */
export async function gateStatus(
  root: string,
  changeId: string,
  gate: string,
): Promise<GateStatus> {
  const lifecycle = await loadChangeContext(root);
  const change = await changeStore(root)
    .read(changeId)
    .catch((e: Error) => {
      throw new CriticError("not-found", e.message);
    });
  if (!BUILT_IN_GATES.includes(gate) && !lifecycle.orgPack.gates.gates.some((g) => g.id === gate))
    throw new CriticError(
      "no-gate",
      `There is no gate ${gate}. Gates: ${lifecycle.orgPack.gates.gates.map((g) => g.id).join(", ")}.`,
    );
  return gateStatusOf(root, lifecycle, change, gate);
}

/**
 * The gate's used rounds in words, for a person: "its 2 critic rounds are used", and once a
 * checking round past the limit has run, "its 2 critic rounds and the checking round are used",
 * so the words match the rounds on file.
 */
export function roundsUsed(s: Pick<GateStatus, "maxRounds" | "checkRoundsRun">): string {
  const max = s.maxRounds ?? 0;
  const n = s.checkRoundsRun ?? 0;
  const checking = n === 1 ? " and the checking round" : n > 1 ? ` and ${n} checking rounds` : "";
  return `its ${max} critic round${max === 1 ? "" : "s"}${checking} ${max === 1 && !n ? "is" : "are"} used`;
}
