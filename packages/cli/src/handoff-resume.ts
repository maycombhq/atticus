import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runsDirOf } from "@maycombhq/core";
import { listRuns } from "./runs-view.js";

/** One atticus command run in-process: its code and lines. */
export type StepRunner = (
  args: string[],
) => Promise<{ code: number; out: string[]; err: string[] }>;

/**
 * Fourth UX walk: a step prepared for the person's assistant is finished in two moves, Done
 * (the answer checked) and the step again with --resume (it writes what the answer said, or
 * offers its next prompt). The app keeps the step's resume beside its run, so Done does both.
 */
export interface Prepared {
  runId?: string;
  lines: string[];
  stillWaiting?: boolean;
}

/** Runs the step as a hand-off (`--json`), and keeps its resume beside the run it made. */
export async function prepareStep(
  root: string,
  runStep: StepRunner,
  args: string[],
): Promise<{ code: number; prepared: Prepared }> {
  const res = await runStep([...args, "--handoff", "--json"]);
  const lines = [...res.out, ...res.err];
  const json = [...res.out].reverse().find((l) => l.trim().startsWith("{"));
  let h: {
    state?: string;
    runId?: string;
    resumeArgs?: string[];
    stillWaiting?: boolean;
    messages?: string[];
    errors?: string[];
    questions?: { id: string; question: string; answer?: string }[];
    pagesLeft?: number;
  } = {};
  try {
    h = json ? JSON.parse(json) : {};
  } catch {
    h = {};
  }
  // Round 39: what the step said is inside its JSON (messages, errors, questions, pages left):
  // all of it reaches the person, never an empty "prepared no run".
  const said = [
    ...lines.filter((l) => !l.trim().startsWith("{")),
    ...(h.messages ?? []),
    ...(h.errors ?? []),
    ...(h.questions ?? []).map((q) => `Question ${q.id}: ${q.question} (answer it on Questions)`),
    ...(h.pagesLeft ? [`${h.pagesLeft} pages are left for the next part: Prepare it again.`] : []),
  ];
  if (h.state !== "handoff" || !h.runId) return { code: res.code, prepared: { lines: said } };
  const run = (await listRuns(root, { limit: 100000 })).find((x) => x.runId === h.runId);
  if (run && h.resumeArgs)
    await writeFile(
      join(runsDirOf(root), run.change, run.runId, "resume.json"),
      JSON.stringify({ args: h.resumeArgs.filter((a) => a !== "--json") }) + "\n",
      "utf8",
    ).catch(() => undefined);
  return {
    code: res.code,
    prepared: {
      runId: h.runId,
      lines: said,
      ...(h.stillWaiting ? { stillWaiting: true } : {}),
    },
  };
}

/**
 * After Done passed: the step's resume, when the app prepared it. Gives the next run when the
 * step offers another prompt, else what it said (it wrote the files).
 */
export async function resumeAfterDone(
  root: string,
  runStep: StepRunner,
  change: string,
  runId: string,
): Promise<{ next?: string; lines: string[] } | undefined> {
  const t = await readFile(join(runsDirOf(root), change, runId, "resume.json"), "utf8").catch(
    () => undefined,
  );
  if (!t) return undefined;
  const { args } = JSON.parse(t) as { args: string[] };
  // --resume <run> is in args; prepareStep adds --handoff --json and keeps the next resume.
  const words = args.filter((a) => a !== "--handoff");
  const r = await prepareStep(root, runStep, words);
  return r.prepared.runId && r.prepared.runId !== runId
    ? { next: r.prepared.runId, lines: r.prepared.lines }
    : { lines: r.prepared.lines };
}
