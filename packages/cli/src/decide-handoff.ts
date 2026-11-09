import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { claimRunDir, makeRunId } from "@maycombhq/ai";
import { runsDirOf, runsRelOf, writeFileAtomic, type Api } from "@maycombhq/core";
import type { Output } from "./commands.js";

/**
 * ADR 0181, ninth UX walk: AI decides first in hand-off mode too, the only mode many teams have in
 * their first weeks. `questions propose` and Match with Copilot, where copilot-acp isn't allowed
 * (or isn't asked for), hand their brief to the person's assistant as an Atticus hand-off run:
 * a record under `.runs/<change>/<runId>/` (prompt.md, run.json, runtime `hand-off`) that Model
 * runs lists. Its Done (`atticus handoff done <runId>`, Done on Model runs, Read the answer on
 * Connect, Done on Questions) reads the answer back and applies what passes the same citation
 * check and bar as the AI's, recorded with runtime `hand-off` and the run, through Atticus,
 * never as the person. The assistant writes only its answer; Atticus writes every line.
 */

/** The agents of the two decide hand-offs, as run.json names them. */
export const DECIDE_AGENTS = {
  questions: "decide-propose",
  links: "decide-match",
} as const;
export type DecideKind = keyof typeof DECIDE_AGENTS;

/** The change folders the runs are kept under (as the Copilot sessions' are). */
export const PROPOSE_CHANGE = "questions-propose";
export const matchChangeOf = (from: string) => `match-${from}`;

/** What a decide hand-off run remembers, to read its answer back on Done. */
export type DecideOf =
  /** The proposals on file when it was handed off (id → sha-256 of the file), to tell the new. */
  | { kind: "questions"; before: Record<string, string> }
  | { kind: "links"; from: string; to: Api.LinkBoxT };

export interface DecideRun {
  runId: string;
  request: { change: string; agent: string; outputPath: string };
  runtime: "hand-off";
  state: "waiting" | "prepared" | "validated" | "failed" | "cancelled";
  attempt: number;
  startedAt: string;
  finishedAt?: string;
  errors: string[];
  decide: DecideOf;
}

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const runDir = (root: string, change: string, runId: string) =>
  join(runsDirOf(root), change, runId);

/** Records a decide hand-off run, waiting for the assistant's answer; returns its record. */
export async function startDecideRun(
  root: string,
  o: {
    kind: DecideKind;
    change: string;
    prompt: string;
    outputPath: string;
    decide: DecideOf;
    now?: Date;
  },
): Promise<DecideRun & { promptRel: string }> {
  const now = o.now ?? new Date();
  // Round 46: the folder is claimed with its id (made without `recursive`), never check-then-make.
  const runId = await claimRunDir(join(runsDirOf(root), o.change), () => makeRunId(now));
  const dir = runDir(root, o.change, runId);
  await writeFileAtomic(
    join(dir, "prompt.md"),
    o.prompt.endsWith("\n") ? o.prompt : `${o.prompt}\n`,
  );
  const run: DecideRun = {
    runId,
    request: { change: o.change, agent: DECIDE_AGENTS[o.kind], outputPath: o.outputPath },
    runtime: "hand-off",
    state: "waiting",
    attempt: 1,
    startedAt: now.toISOString(),
    errors: [],
    decide: o.decide,
  };
  await saveRun(root, run);
  return { ...run, promptRel: `${runsRelOf(root)}/${o.change}/${runId}/prompt.md` };
}

async function saveRun(root: string, run: DecideRun) {
  await writeFileAtomic(
    join(runDir(root, run.request.change, run.runId), "run.json"),
    JSON.stringify(run, null, 2) + "\n",
  );
}

const isDecide = (x: unknown): x is DecideRun => {
  const r = x as Partial<DecideRun> | undefined;
  return (
    r?.runtime === "hand-off" &&
    !!r.decide &&
    (r.request?.agent === DECIDE_AGENTS.questions || r.request?.agent === DECIDE_AGENTS.links)
  );
};

async function readRun(file: string): Promise<DecideRun | undefined> {
  const text = await readFile(file, "utf8").catch(() => undefined);
  if (!text) return undefined;
  try {
    const r = JSON.parse(text) as unknown;
    return isDecide(r) ? r : undefined;
  } catch {
    return undefined;
  }
}

/** The decide hand-off run of this id, in whichever change folder holds it. */
export async function findDecideRun(root: string, runId: string): Promise<DecideRun | undefined> {
  if (!/^run-[0-9a-z-]+$/.test(runId)) return undefined;
  for (const change of await readdir(runsDirOf(root)).catch(() => [] as string[])) {
    const r = await readRun(join(runsDirOf(root), change, runId, "run.json"));
    if (r) return r;
  }
  return undefined;
}

const open = (r: DecideRun) =>
  r.state === "waiting" || r.state === "prepared" || r.state === "failed";

/** The newest decide run of a change folder still waiting for its Done, that `pick` keeps. */
export async function openDecideRun(
  root: string,
  change: string,
  pick: (r: DecideRun) => boolean = () => true,
): Promise<DecideRun | undefined> {
  const ids = (await readdir(join(runsDirOf(root), change)).catch(() => [] as string[]))
    .filter((n) => n.startsWith("run-"))
    .sort()
    .reverse();
  for (const id of ids) {
    const r = await readRun(join(runsDirOf(root), change, id, "run.json"));
    if (r && open(r) && pick(r)) return r;
  }
  return undefined;
}

/** A hand-off Match's open run for these two boxes. */
export const openMatchRun = (root: string, from: string, to: Api.LinkBoxT) =>
  openDecideRun(
    root,
    matchChangeOf(from),
    (r) =>
      r.decide.kind === "links" &&
      r.decide.from === from &&
      (r.decide.to.repo ?? "") === (to.repo ?? "") &&
      (r.decide.to.system ?? "") === (to.system ?? ""),
  );

/** Ends a decide run: validated (read in) or failed (with why: Done can be given again). */
export async function finishDecideRun(
  root: string,
  run: DecideRun,
  o: { state: "validated" | "failed"; errors?: string[]; now?: Date },
): Promise<DecideRun> {
  const done: DecideRun = {
    ...run,
    state: o.state,
    finishedAt: (o.now ?? new Date()).toISOString(),
    errors: o.errors ?? [],
  };
  await saveRun(root, done);
  return done;
}

/**
 * Done for a decide hand-off run (`atticus handoff done <runId>`, Model runs' Done): reads its
 * answer back and decides from it as the AI's (runtime hand-off, this run). 0 read in; 1 nothing
 * to read yet (said, and Done can be given again); 2 the run is already done or cancelled.
 */
export async function decideRunDone(
  root: string,
  runId: string,
  io: Output,
  o: { now?: Date } = {},
): Promise<number> {
  const run = await findDecideRun(root, runId);
  if (!run) {
    io.err(`There is no hand-off run ${runId} to decide from.`);
    return 2;
  }
  if (!open(run)) {
    io.err(`Run ${runId} is already ${run.state}.`);
    return 2;
  }
  if (run.decide.kind === "questions") return proposeDone(root, run, io, o);
  const { candidatesOf } = await import("./ui-api-links.js");
  const { view, facts } = await candidatesOf(root, run.decide.from, run.decide.to);
  const { matchDone, matchLines } = await import("./link-match.js");
  const m = await matchDone(root, { view, facts, run, ...(o.now ? { now: o.now } : {}) });
  if (m.state !== "done") {
    io.err(m.error ?? `The answer isn't written yet: ${m.answer ?? "the answer file"}.`);
    return 1;
  }
  for (const l of matchLines(m, run.decide.from, view.toName, run.decide.to)) io.out(l);
  return 0;
}

/** The proposals written or changed since the run was handed off. */
export async function proposedSince(root: string, before: Record<string, string>) {
  const { proposalsSnapshot } = await import("./ai-decide.js");
  const after = await proposalsSnapshot(root);
  return new Set([...after].filter(([id, text]) => before[id] !== sha256(text)).map(([id]) => id));
}

async function proposeDone(
  root: string,
  run: DecideRun,
  io: Output,
  o: { now?: Date },
): Promise<number> {
  if (run.decide.kind !== "questions") return 2;
  // Final review: inside a Copilot session nothing is decided, so the run stays open for the
  // person's Done (validating it here would use it up with nothing applied).
  const { inAcpSession } = await import("./ai-decide.js");
  if (inAcpSession()) {
    io.err(
      `Run ${run.runId} decides as the AI only on a person's Done: press Done in the app, or run atticus handoff done ${run.runId} outside the Copilot session.`,
    );
    return 1;
  }
  const ids = await proposedSince(root, run.decide.before);
  if (!ids.size) {
    const why =
      "No proposal was written or changed since this hand-off: run /atticus-propose in a new Copilot Chat (agent mode) or Claude Code session, then Done again.";
    await finishDecideRun(root, run, {
      state: "failed",
      errors: [why],
      ...(o.now ? { now: o.now } : {}),
    });
    io.err(why);
    return 1;
  }
  const { decideAnswers } = await import("./ai-decide.js");
  const d = await decideAnswers(root, {
    run: run.runId,
    runtime: "hand-off",
    ids,
    ...(o.now ? { now: o.now } : {}),
  });
  await finishDecideRun(root, run, { state: "validated", ...(o.now ? { now: o.now } : {}) });
  io.out(`Read ${ids.size} proposal${ids.size === 1 ? "" : "s"} from hand-off run ${run.runId}.`);
  for (const l of decidedAnswerLines(d, run.runId)) io.out(l);
  return 0;
}

/** What Atticus did with the proposals, in words (the CLI and the app say the same). */
export function decidedAnswerLines(
  d: Awaited<ReturnType<typeof import("./ai-decide.js").decideAnswers>>,
  runId: string,
): string[] {
  const out: string[] = [];
  if (!d)
    out.push(
      "runtime.yaml's decide.questions is propose: each proposal waits on its question for a person to accept or answer otherwise.",
    );
  if (d?.paused) out.push(`Deciding is paused: ${d.paused}`);
  if (d?.applied.length) {
    out.push(
      `Detected by AI: ${d.applied.length} answer${d.applied.length === 1 ? "" : "s"} applied in batch ${d.batch} (by AI, run ${runId}):`,
    );
    for (const a of d.applied) out.push(`  ${a.id}: option ${a.option} (${a.bar})`);
    out.push(
      `Correct one with atticus questions correct <id> --option <n> | --none; undo them all with atticus questions undo ${d.batch}.`,
    );
  }
  for (const k of d?.kept ?? []) out.push(`  kept as a proposal: ${k.id} (${k.why})`);
  return out;
}
