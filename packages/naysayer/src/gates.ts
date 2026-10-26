import {
  BUILT_IN_GATES,
  changeStore,
  checkFindings,
  loadChangeContext,
  type ChangeContext,
} from "@maycombhq/changes";
import { gateRoundLimit, type ChangeLifecycle } from "@maycombhq/core";
import { CriticError } from "./errors.js";
import { proposalWords, readProposals } from "./proposals.js";
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
  const read = round ? await readRound(root, change.id, gate, round) : { findings: [] };
  // What an assistant proposed, waiting on a person (ADR 0115 addendum, 2026-10-25), on each finding.
  const proposals = round ? await readProposals(root, change.id, gate, round) : [];
  const findings: StoredFinding[] = read.findings.map((f) => {
    const p = proposals.find((x) => x.finding === f.finding.id);
    return p && f.finding.state === "open" ? { ...f, proposal: p } : f;
  });
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
  const proposed = findings.filter((f) => f.proposal && f.finding.severity === "blocking");
  const reasons = [
    ...blocking,
    ...proposed.map(
      (f) =>
        `${f.finding.id} is ${proposalWords(f.proposal!)}: atticus finding ${change.id} ${f.finding.id} ${f.proposal!.claim === "fixed" ? "apply" : "not-relevant"} records a person's decision.`,
    ),
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
    // An open gap with nothing blocking waits on its owner, not on a person's decision.
    humanDecides:
      blocking.length > 0 &&
      usedUp &&
      !(count(open).blocking === 0 && count(open).gaps > 0 && waiting.length === 0),
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
/**
 * The checking round's rule in the one sentence every message states it with (ADR 0087 addendum,
 * 2026-10-24): a stop, `atticus finding`, `atticus critic` and `atticus change status`.
 */
export const checkRoundRule = (round: number | undefined) =>
  `a person acted since round ${round ?? "the newest"}, so one more checking round is due`;

/** The open gaps of a gate whose blocking findings are all dealt with, by id. */
const openGaps = (s: Pick<GateStatus, "findings">) =>
  s.findings.filter((f) => f.finding.severity === "gap" && f.finding.state === "open");

/**
 * An open gap with nothing blocking (ADR 0087 addendum): the gap is an owner question, so it waits
 * on its owner, not on a person's decision about the draft. The stage is done; the gate's hand-off
 * waits until the gap is routed to its owner (ask) or a person writes the fact in. One line for
 * `atticus change status`, `atticus critic` and the stage's done. Undefined otherwise.
 */
export function ownerWaitsLine(s: GateStatus, change: string): string | undefined {
  if (s.open.blocking > 0 || s.open.gaps === 0 || s.waiting.length) return undefined;
  const gaps = openGaps(s);
  const one = gaps.length === 1 ? gaps[0]!.finding.id : "<id>";
  return `Nothing blocking is open at the ${s.gate} gate; ${s.open.gaps} open gap${s.open.gaps === 1 ? " waits on its owner" : "s wait on their owners"}, so the ${s.gate} hand-off waits until ${s.open.gaps === 1 ? "it is" : "they are"} answered: route ${s.open.gaps === 1 ? "it" : "each"} to its owner (atticus finding ${change} ${one} ask --asked-of <owner>), or write the fact in and record it (atticus finding ${change} ${one} edit-and-apply --reason "<what you wrote>").`;
}

export function roundsUsed(s: Pick<GateStatus, "maxRounds" | "checkRoundsRun">): string {
  const max = s.maxRounds ?? 0;
  const n = s.checkRoundsRun ?? 0;
  const checking = n === 1 ? " and the checking round" : n > 1 ? ` and ${n} checking rounds` : "";
  return `its ${max} critic round${max === 1 ? "" : "s"}${checking} ${max === 1 && !n ? "is" : "are"} used`;
}
