import type { BuildRefusal } from "@maycombhq/scanner";
import { refusalPlanOf } from "./build-report.js";
import type { Output } from "./commands.js";
import { refusalTakenBack, refusedBuild } from "./standing.js";

/**
 * ADR 0202 point 9: one question a command, asked once, and only in a terminal (`Output.ask`).
 * The build's guard asks nothing; this is the command line's one helper. Where nothing can be
 * asked (a script, `--json`, `CI`, a job of the app) every line is what it was, and the count
 * flags (`--yes --accept-changes N`, `--allow-removals N`, `--discard-edits N`) work as before.
 */

/** Every word of the questions (ADR 0202: the command line's words, in one constant). */
export const CONFIRM_WORDS = {
  accept: (n: number) => `Accept these ${n}? [y/N]`,
  apply: "Apply this step? It changes no record file. [y/N]",
  remove: (n: number) => `Remove these ${n} records? [y/N]`,
  discard: (n: number) =>
    `Discard these ${n} hand edits? A copy is kept for atticus catalog undo. [y/N]`,
  both: (n: number, m: number) =>
    `Discard these ${n} hand edits and remove these ${m} records? [y/N]`,
  no: "Nothing written.",
  /** Declined, when the same run wrote something before the step asked about. */
  noStep: "Nothing of this step written.",
} as const;

/** Only `y` or `yes`, in any case, is yes: Enter, anything else and the end of input are no. */
export const isYes = (answer: string | undefined): boolean =>
  /^(y|yes)$/i.test((answer ?? "").trim());

/** Ask once. Where nothing can be asked the answer is no, and nothing is printed. */
export async function confirmOnce(io: Pick<Output, "ask">, question: string): Promise<boolean> {
  return io.ask ? isYes(await io.ask(question)) : false;
}

export interface BuildCounts {
  allowRemovals?: number;
  discardEdits?: number;
}

/**
 * The question a refused build is asked about, and the counts a yes confirms: only a refusal
 * that is `large-removals`, `hand-edits` or both, and nothing else. Never for removals nothing
 * explains, a newer Atticus's catalog, a catalog not upgraded, a scan that read nothing, an
 * empty build or a build.json that doesn't read: those keep their one command.
 */
export function buildQuestion(
  r: BuildRefusal,
): { question: string; counts: BuildCounts } | undefined {
  const asked = new Set(["large-removals", "hand-edits"]);
  if (!r.reasons.length || r.reasons.some((x) => !asked.has(x)) || r.unreadableManifest)
    return undefined;
  const removals = r.reasons.includes("large-removals") ? r.allowRemovals : undefined;
  const edits = r.reasons.includes("hand-edits") ? r.discardEdits : undefined;
  if (r.reasons.includes("large-removals") && removals === undefined) return undefined;
  if (r.reasons.includes("hand-edits") && edits === undefined) return undefined;
  const W = CONFIRM_WORDS;
  return {
    question:
      edits !== undefined && removals !== undefined
        ? W.both(edits, removals)
        : edits !== undefined
          ? W.discard(edits)
          : W.remove(removals!),
    counts: {
      ...(removals !== undefined ? { allowRemovals: removals } : {}),
      ...(edits !== undefined ? { discardEdits: edits } : {}),
    },
  };
}

/**
 * Run a command that builds; where it refused with a list a person can confirm and a terminal is
 * there to ask, ask once, and on yes run the same command with the counts listed and the
 * refusal's `plan`, so a list that changed between the listing and the answer writes nothing.
 */
export async function withBuildConfirm(
  io: Output,
  given: BuildCounts,
  run: (o: BuildCounts & { plan?: string }) => Promise<number>,
): Promise<number> {
  const code = await run(given);
  if (!io.ask || given.allowRemovals !== undefined || given.discardEdits !== undefined) return code;
  const refused = refusedBuild();
  const q = refused && buildQuestion(refused);
  if (!refused || !q) return code;
  if (!(await confirmOnce(io, q.question))) {
    io.err(CONFIRM_WORDS.no);
    return code;
  }
  refusalTakenBack();
  return run({ ...q.counts, plan: refusalPlanOf(refused) });
}
