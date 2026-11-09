/** What POST /api/changes/{id}/critic gives back: the round, with each AI lens's state. */
export interface CriticRan {
  ai?: string;
  round?: { lenses?: { lens: string; state: string; runId?: string }[] };
}

/**
 * ADR 0189 (app-only audit): how many of the round's AI lenses wait for the person's assistant,
 * so the note says a lens waits only when one does (it said so with no run, and no link).
 */
export const lensesWaiting = (r: CriticRan | undefined): number =>
  (r?.round?.lenses ?? []).filter((l) => l.state === "waiting" && !!l.runId).length;
