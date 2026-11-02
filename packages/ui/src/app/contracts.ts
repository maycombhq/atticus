import type { Api } from "@maycombhq/core";

/**
 * The contract check's findings (ADR 0164) on a link of the map: those of a call the link
 * carries, by its Interface (the link's own, or a gateway hop's forwarding call's). A finding
 * that names no Interface is found by its lines: a call to an outside system by the caller's
 * line, a listener whose publisher is outside (its call and entry are the listener) by the
 * listener's line on the link's callee side.
 */
export function findingsOfJoin(
  join: Api.HierJoinT,
  findings: readonly Api.ContractMismatchViewT[],
): Api.ContractMismatchViewT[] {
  const key = (repo: string | undefined, at: string) => `${repo ?? ""}|${at}`;
  const callers = new Set(join.caller.map((e) => key(e.repo, e.at)));
  const callees = new Set(join.callee.map((e) => key(e.repo, e.at)));
  const listener = (f: Api.ContractMismatchViewT) =>
    !!f.system &&
    !!f.entry &&
    f.entry.repo === f.call.repo &&
    f.entry.fact === f.call.fact &&
    callees.has(key(f.entry.repo, f.entry.at));
  return findings.filter(
    (f) =>
      (f.interfaces ?? (f.interface ? [f.interface] : [])).includes(join.interface) ||
      (!f.interface && (callers.has(key(f.call.repo, f.call.at)) || listener(f))),
  );
}

/** The gaps a link's findings add on the canvas: one for mismatches, one for the unconfirmed. */
export function contractGaps(
  joins: readonly Api.HierJoinT[],
  findings: readonly Api.ContractMismatchViewT[],
): string[] {
  const mine = joins.flatMap((j) => findingsOfJoin(j, findings));
  return [
    ...(mine.some((f) => f.status === "mismatch") ? ["contract-mismatch"] : []),
    ...(mine.some((f) => f.status === "unconfirmed") ? ["contract-unconfirmed"] : []),
  ];
}

export const mismatchesHash = "#/mismatches";
