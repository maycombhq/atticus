import {
  changeStore,
  checkFindings,
  loadChangeContext,
  type ChangeContext,
} from "@maycombhq/changes";
import type { ChangeLifecycle } from "@maycombhq/core";
import { CriticError } from "./errors.js";
import { readRound, roundsOf, type StoredFinding } from "./findings.js";

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
  maxRounds: number;
  /** Open findings in the newest round, by severity. */
  open: SeverityCounts;
  /** Every finding in the newest round, whatever its state. */
  total: SeverityCounts;
  /** Same answer as the lifecycle's hand-off check: no open blocking finding, no open gap, no unreadable file. */
  mayProceed: boolean;
  /** The rounds are used up and something still blocks: a person decides (waive, fix by hand, or return). */
  humanDecides: boolean;
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

export function maxRoundsOf(lifecycle: ChangeContext, gate: string): number {
  const g = lifecycle.orgPack.gates.gates.find((x) => x.id === gate);
  return Math.max(1, g?.maxAuthorRounds ?? 2);
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
  const reasons = (await checkFindings(root, change, [gate])).map((r) => r.message);
  const maxRounds = maxRoundsOf(lifecycle, gate);
  return {
    gate,
    ...(round ? { round } : {}),
    maxRounds,
    open: count(open),
    total: count(findings),
    mayProceed: reasons.length === 0,
    humanDecides: reasons.length > 0 && (round ?? 0) >= maxRounds,
    reasons,
    findings,
  };
}

/** Gates Atticus itself writes findings to (drift check, Spec Kit hand-up), whether or not gates.yaml lists them. */
export const BUILT_IN_GATES: readonly string[] = ["drift", "hand-up"];

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
