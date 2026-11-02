import type { Api } from "@maycombhq/core";

/**
 * The contract check's findings (ADR 0164) on a link of the map: those of a call the link
 * carries, by its Interface (the link's own, or a gateway hop's forwarding call's), or by the
 * caller's line when the finding names no Interface (a call to an outside system).
 */
export function findingsOfJoin(
  join: Api.HierJoinT,
  findings: readonly Api.ContractMismatchViewT[],
): Api.ContractMismatchViewT[] {
  const lines = new Set(join.caller.map((e) => `${e.repo ?? ""}|${e.at}`));
  return findings.filter(
    (f) =>
      (f.interfaces ?? (f.interface ? [f.interface] : [])).includes(join.interface) ||
      (!f.interface && lines.has(`${f.call.repo}|${f.call.at}`)),
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
