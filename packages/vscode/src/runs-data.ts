import { join, normalize } from "node:path";
import type { Item, Open, Paths } from "./sidebar-data";

/**
 * The Model runs section (ADR 0106), as plain data: each run `atticus runs --json` lists, newest
 * first, with its step or change, agent, round, state, whether it was answered and how many
 * problems the checks handed back to it; and what it opens to: its prompt, its answer and the
 * app's Model runs screen. No `vscode` here, so it is tested outside the editor.
 */

/** One run as `atticus runs --json` prints it (the local API's RunListItem). */
export interface RunEntry {
  runId: string;
  /** The change, or the step's own folder (survey-forge-ledger, knowledge-scan). */
  change: string;
  agent: string;
  runtime: string;
  state: string;
  startedAt: string;
  finishedAt?: string;
  /** Where the runtime was asked to write the answer, relative to the change folder. */
  output?: string;
  /** The prompt, relative to the metarepo. */
  promptPath: string;
  /** The round of its step, carried across hand-offs (ADR 0103). */
  attempt: number;
  answered: boolean;
  handedBack: number;
  promptTokens?: number;
}

/** The runs, from what `atticus runs --json` printed; throws, saying why, when it isn't that. */
export function parseRuns(stdout: string): RunEntry[] {
  let v: unknown;
  try {
    v = JSON.parse(stdout);
  } catch {
    throw new Error(
      `atticus runs --json didn't print the list of runs${stdout.trim() ? `: ${stdout.trim().split("\n")[0]}` : ""}. An older command line has no atticus runs; update it.`,
    );
  }
  const runs = (v as { runs?: unknown })?.runs;
  if (!Array.isArray(runs)) throw new Error("atticus runs --json printed no list of runs.");
  return runs.filter(
    (r): r is RunEntry =>
      typeof r === "object" &&
      r !== null &&
      typeof (r as RunEntry).runId === "string" &&
      typeof (r as RunEntry).change === "string",
  );
}

/** The app's Model runs screen, on one run. */
export const runHash = (runId: string) => `#/runs?run=${encodeURIComponent(runId)}`;

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const when = (iso: string) => iso.replace("T", " ").slice(0, 16);

const ICON: Record<string, { icon: string; color?: string }> = {
  validated: { icon: "pass", color: "testing.iconPassed" },
  produced: { icon: "check" },
  waiting: { icon: "clock" },
  prepared: { icon: "circle-outline" },
  failed: { icon: "error", color: "testing.iconFailed" },
  cancelled: { icon: "circle-slash" },
};

/** The runs, newest first, each opening to what it holds. */
export function runItems(runs: RunEntry[]): Item[] {
  return [...runs]
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.runId.localeCompare(a.runId))
    .map((r) => {
      const i = ICON[r.state] ?? { icon: "sparkle" };
      return {
        id: `run:${r.runId}`,
        label: r.change,
        description: [
          r.agent,
          `round ${r.attempt}`,
          r.state,
          r.answered ? "answered" : "no answer yet",
          ...(r.handedBack ? [`${plural(r.handedBack, "problem")} handed back`] : []),
        ].join(" · "),
        tooltip: [
          `${r.runId}: ${r.change}, ${r.agent}, round ${r.attempt}, ${r.state} (${r.runtime}).`,
          `Started ${when(r.startedAt)}${r.finishedAt ? `, finished ${when(r.finishedAt)}` : ""}.`,
          `Prompt: ${r.promptPath}${r.promptTokens !== undefined ? ` (${r.promptTokens} tokens)` : ""}.`,
          r.answered ? "Answered." : "No answer yet.",
          ...(r.handedBack
            ? [`The checks handed ${plural(r.handedBack, "problem")} back to this round.`]
            : []),
        ].join("\n"),
        icon: i.icon,
        ...(i.color ? { color: i.color } : {}),
        expand: { kind: "run", run: r },
        words: [r.runId, r.agent, r.state, r.runtime],
      } satisfies Item;
    });
}

/**
 * The answer's file: in the run's own folder (a hand-off writes it there), else in the change's
 * folder. A path that leaves the change folder is never looked at.
 */
export function answerFileOf(r: RunEntry, p: Paths): string | undefined {
  if (!r.output) return undefined;
  const out = normalize(r.output);
  if (out.startsWith("..") || /^[\\/]|^[a-zA-Z]:/.test(out)) return undefined;
  const exists = p.exists ?? (() => true);
  const runDir = join(p.root, r.promptPath, "..");
  const name = out.split(/[\\/]/).pop()!;
  const candidates = [
    join(runDir, name),
    join(p.root, "openspec", "changes", r.change, out),
    join(p.root, ".atticus", "openspec", "changes", r.change, out),
  ];
  return candidates.find((f) => exists(f));
}

/** What a run opens to: its prompt, its answer when there is one, and the app's screen. */
export function runChildren(r: RunEntry, p: Paths): Item[] {
  const exists = p.exists ?? (() => true);
  const promptAt = join(p.root, r.promptPath);
  const prompt: Open = exists(promptAt)
    ? { kind: "file", path: promptAt }
    : {
        kind: "missing",
        message: `The prompt ${r.promptPath} isn't there any more: .runs/ is git-ignored and may have been cleaned.`,
      };
  const rows: Item[] = [
    {
      id: `run:${r.runId}:prompt`,
      label: "Open the prompt",
      ...(r.promptTokens !== undefined ? { description: `${r.promptTokens} tokens` } : {}),
      tooltip: `What Atticus asked the model: ${r.promptPath}`,
      icon: "comment",
      open: prompt,
    },
  ];
  if (r.answered) {
    const file = answerFileOf(r, p);
    rows.push({
      id: `run:${r.runId}:answer`,
      label: "Open the answer",
      tooltip: file
        ? `What the model answered: ${file}`
        : "What the model answered, as the run keeps it (atticus runs show).",
      icon: "reply",
      ...(file
        ? { open: { kind: "file", path: file } as Open }
        : { command: { command: "atticus.openRunAnswer", args: [r.runId] } }),
    });
  }
  rows.push({
    id: `run:${r.runId}:app`,
    label: "Open in the app",
    tooltip:
      "The app's Model runs screen: the prompt, the answer and the problems handed back, round by round.",
    icon: "link-external",
    open: { kind: "app", hash: runHash(r.runId) },
  });
  return rows;
}
