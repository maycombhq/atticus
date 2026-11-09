import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { batchSections } from "@maycombhq/ai";
import { runsDirOf } from "@maycombhq/core";
import type { ServerContext } from "@maycombhq/server";
import { hasKeptResume } from "./handoff-resume.js";
import { allRuns, answerOf, type Stored } from "./runs-view.js";

/**
 * ADR 0188: the answer arrives by itself. The prompt a stage hands to the person's assistant ends
 * by asking it to write the file, nothing more; the server notices the file for a waiting
 * hand-off run and runs the check Done runs (the same function, so the two never differ), then
 * the thread shows the result. Done stays, for a person who wants to check at once.
 *
 * It never acts on a half-written file and never twice:
 * - the file must have sat unchanged for `stableMs` (debounced: each write starts the wait again),
 *   and read as complete: YAML that parses, a change draft with its proposal, a batch with every
 *   part's section, any other answer not empty;
 * - one check at a time per run (Done's own guard), and never again on the same text: a check
 *   that failed waits for the file to change; a run Done or the command line checked moves on
 *   from `waiting` and is left alone (a run the command line validated is only resumed);
 * - only the steps a stage or the critic hands off (their drafters, the critic's lenses); a task
 *   run's Done (it builds and commits) and a decision's are a person's to press.
 */

export interface AutoDoneOptions {
  /** How long an answer file must sit unchanged before it is checked. Default 3 s. */
  stableMs?: number;
  /** Off: the person presses Done (tests that check Done itself). Default on. */
  off?: boolean;
}

/** The agents whose answers the app checks by itself: the stages' drafters and the critic's lenses. */
const AUTO_AGENTS = new Set([
  "change-drafter",
  "feature-placer",
  "flow-architect",
  "story-writer-flows",
  "small-change-planner",
  "critic-lenses",
  // A round prepared before ADR 0188 may still wait on its expander or rerank prompt.
  "context-expander",
  "context-reranker",
]);
const isAuto = (agent: string) => AUTO_AGENTS.has(agent) || /^[a-z]+-critic$/.test(agent);

const agentOf = (s: Stored) => {
  const a = s.run.request.agent as unknown as string | { id: string };
  return typeof a === "string" ? a : a.id;
};

const sha = (t: string) => createHash("sha256").update(t).digest("hex");

/** The marker a check by the app leaves in the run's folder (for the thread's "checked by"). */
export const AUTO_CHECKED = "checked-by-app.json";

export async function markCheckedByApp(root: string, change: string, runId: string): Promise<void> {
  await writeFile(
    join(runsDirOf(root), change, runId, AUTO_CHECKED),
    JSON.stringify({ at: new Date().toISOString() }) + "\n",
    "utf8",
  );
}

export async function checkedByApp(root: string, change: string, runId: string): Promise<boolean> {
  return stat(join(runsDirOf(root), change, runId, AUTO_CHECKED)).then(
    () => true,
    () => false,
  );
}

/** Whether an answer reads as complete for its run (pure but for the text, for tests). */
export function answerComplete(s: Pick<Stored, "run">, text: string): boolean {
  if (!text.trim()) return false;
  const out = s.run.request.outputPath ?? "";
  if (s.run.parts?.length) {
    const got = batchSections(text);
    return s.run.parts.every((p) => (got.get(p.name)?.text ?? "").trim() !== "");
  }
  if (out === "change-draft.md") return /^===\s*proposal\.md\s*$/m.test(text);
  if (/\.ya?ml$/.test(out)) {
    try {
      const y = parse(text.replace(/^\s*```(?:ya?ml)?\s*\n/, "").replace(/\n```\s*$/, "\n"));
      return y !== null && y !== undefined && typeof y === "object";
    } catch {
      return false;
    }
  }
  return true;
}

/** Where a run's answer is, as the hand-off runtime writes it. */
async function answerFile(root: string, s: Stored): Promise<string | undefined> {
  const out = s.run.request.outputPath;
  if (!out) return undefined;
  const inRun = join(s.dir, out);
  if (s.run.request.outputIn === "run" || s.run.parts?.length) return inRun;
  const { changesDirOf } = await import("@maycombhq/core");
  return join(changesDirOf(root), s.run.request.change, out);
}

/**
 * The runs to check now: waiting hand-offs of the steps above whose answer is complete and has
 * sat unchanged for stableMs, and validated runs whose kept resume nothing ran yet. `later` is
 * set when an answer is still settling, so the scan runs again once it may have.
 */
export async function dueRuns(
  root: string,
  o: { stableMs: number; now: number; tried: Map<string, string> },
): Promise<{ due: string[]; later: boolean }> {
  const due: string[] = [];
  let later = false;
  for (const s of await allRuns(root)) {
    if (s.run.runtime !== "hand-off" || !isAuto(agentOf(s))) continue;
    // A lens asked in a batch is answered by its batch's check.
    if (s.run.batch) continue;
    if (s.run.state === "validated") {
      if (!o.tried.has(s.run.runId) && (await hasKeptResume(root, s.run.runId))) {
        o.tried.set(s.run.runId, "resume");
        due.push(s.run.runId);
      }
      continue;
    }
    if (s.run.state !== "waiting" && s.run.state !== "failed") continue;
    const file = await answerFile(root, s);
    const info = file ? await stat(file).catch(() => undefined) : undefined;
    if (!info) continue;
    if (o.now - info.mtimeMs < o.stableMs) {
      later = true;
      continue;
    }
    const text = (await answerOf(root, s)) ?? (await readFile(file!, "utf8").catch(() => ""));
    const key = sha(text);
    if (o.tried.get(s.run.runId) === key) continue;
    if (!answerComplete(s, text)) continue;
    // A failed run is checked again only once its file changed since the check that failed it.
    if (s.run.state === "failed" && !o.tried.has(s.run.runId)) {
      o.tried.set(s.run.runId, key);
      continue;
    }
    o.tried.set(s.run.runId, key);
    due.push(s.run.runId);
  }
  return { due, later };
}

/** Follow the metarepo's live events and check each answer once it is complete. */
export function startAutoDone(
  ctx: ServerContext,
  check: (runId: string) => Promise<unknown>,
  o: AutoDoneOptions = {},
): void {
  if (o.off || process.env.ATTICUS_AUTO_DONE === "off") return;
  // A test's own context (no run logs, no live events of its own) checks by Done only, unless
  // the test asks for the app's check.
  if (typeof ctx.events?.listen !== "function") return;
  if (!ctx.runLogs && o.stableMs === undefined) return;
  const stableMs = o.stableMs ?? 3000;
  const tried = new Map<string, string>();
  const busy = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let scanning = false;
  let again = false;
  let closed = false;
  const scan = async () => {
    if (closed) return;
    if (scanning) {
      again = true;
      return;
    }
    scanning = true;
    try {
      const { due, later } = await dueRuns(ctx.root, { stableMs, now: Date.now(), tried });
      for (const id of due) {
        if (busy.has(id)) continue;
        busy.add(id);
        // A refusal (already checked by Done, a check under way) or a failed check is the run's
        // own state, shown in the thread; nothing here throws past it.
        await check(id)
          .catch(() => undefined)
          .finally(() => busy.delete(id));
      }
      if (later) schedule(stableMs + 50);
    } catch {
      // the next event scans again
    } finally {
      scanning = false;
      if (again) {
        again = false;
        schedule(50);
      }
    }
  };
  const schedule = (ms: number) => {
    if (closed) return;
    clearTimeout(timer);
    timer = setTimeout(() => void scan(), ms);
    timer.unref?.();
  };
  const stop = ctx.events.listen((e) => {
    if (e.type === "file.changed" || e.type === "run.changed") schedule(stableMs + 50);
  });
  // A run that waited while the server was down is looked at once it starts.
  schedule(stableMs + 50);
  ctx.onClose?.add(() => {
    closed = true;
    clearTimeout(timer);
    stop();
  });
}
