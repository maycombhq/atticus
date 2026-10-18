import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { catalogDirOf, orgPackDirOf, stateDirOf } from "@maycombhq/core";
import { scanEstate, writeCatalog } from "@maycombhq/scanner";
import { runCheck, type CheckResult } from "./checks.js";
import { loadLessons, type Lesson, type LessonStep } from "./lessons.js";
import { isSandbox } from "./sandbox.js";

/**
 * Running lessons: start one (by id, or the first lesson for a role), check the current step,
 * and keep progress locally in `<state>/.learn/progress.json` (git-ignored, beside the index).
 * Lesson commands only run in a practice sandbox: a lesson records decisions and moves changes,
 * which must never happen to a real metarepo by accident.
 */

export interface StepProgress {
  passedAt: string;
  answer?: string;
}

export interface LessonProgress {
  startedAt: string;
  completedAt?: string;
  steps: Record<string, StepProgress>;
}

export interface Progress {
  schemaVersion: 1;
  current?: string;
  lessons: Record<string, LessonProgress>;
}

export class LearnError extends Error {
  constructor(
    message: string,
    readonly code: "not-sandbox" | "not-found" | "usage" = "usage",
  ) {
    super(message);
    this.name = "LearnError";
  }
}

export const progressPath = (root: string) => join(stateDirOf(root), ".learn", "progress.json");

export async function readProgress(root: string): Promise<Progress> {
  try {
    const p = JSON.parse(await readFile(progressPath(root), "utf8")) as Progress;
    if (p.schemaVersion === 1 && p.lessons) return p;
  } catch {
    // none yet
  }
  return { schemaVersion: 1, lessons: {} };
}

async function writeProgress(root: string, p: Progress): Promise<void> {
  const f = progressPath(root);
  await mkdir(dirname(f), { recursive: true });
  await writeFile(`${f}.tmp`, JSON.stringify(p, null, 2) + "\n", "utf8");
  await rename(`${f}.tmp`, f);
}

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

export async function lessonsFor(root?: string) {
  return loadLessons(root ? { orgPackDir: orgPackDirOf(root) } : {});
}

/** A lesson by id, or the first lesson for a role. */
export async function findLesson(root: string | undefined, roleOrLesson: string): Promise<Lesson> {
  const { lessons } = await lessonsFor(root);
  const l =
    lessons.find((x) => x.id === roleOrLesson) ?? lessons.find((x) => x.role === roleOrLesson);
  if (!l) {
    const roles = [...new Set(lessons.map((x) => x.role))].join(", ");
    throw new LearnError(
      `No lesson or role ${roleOrLesson}. Roles with lessons: ${roles}.`,
      "not-found",
    );
  }
  return l;
}

async function requireSandbox(root: string): Promise<void> {
  if (!(await isSandbox(root)))
    throw new LearnError(
      `${root} isn't a practice sandbox. Make one with atticus sandbox create <dir> and run lessons there.`,
      "not-sandbox",
    );
}

export interface StartResult {
  lesson: Lesson;
  step?: LessonStep;
  /** What the lesson's setup did. */
  setup: string[];
  resumed: boolean;
}

/** Start (or resume) a lesson in a sandbox; run its setup the first time. */
export async function startLesson(
  root: string,
  roleOrLesson: string,
  o: { now?: Date } = {},
): Promise<StartResult> {
  await requireSandbox(root);
  const lesson = await findLesson(root, roleOrLesson);
  const p = await readProgress(root);
  const resumed = !!p.lessons[lesson.id];
  const setup: string[] = [];
  if (!resumed) {
    for (const s of lesson.setup) {
      if (s === "scan") {
        const scan = await scanEstate({ root });
        await writeCatalog(join(catalogDirOf(root), "generated"), scan.records);
        setup.push(`Scanned the sandbox: ${scan.records.length} records in catalog/generated.`);
      }
    }
    p.lessons[lesson.id] = { startedAt: iso(o.now ?? new Date()), steps: {} };
  }
  p.current = lesson.id;
  await writeProgress(root, p);
  const done = p.lessons[lesson.id]!.steps;
  const step = lesson.steps.find((s) => !done[s.id]);
  return { lesson, ...(step ? { step } : {}), setup, resumed };
}

export interface CheckStepResult {
  lesson: Lesson;
  step: LessonStep;
  result: CheckResult;
  next?: LessonStep;
  completed: boolean;
}

/** Check the current step of the current lesson (or the step named), and move on when it passes. */
export async function checkStep(
  root: string,
  o: { lesson?: string; step?: string; answer?: string; now?: Date } = {},
): Promise<CheckStepResult> {
  await requireSandbox(root);
  const p = await readProgress(root);
  const id = o.lesson ?? p.current;
  if (!id)
    throw new LearnError("No lesson started. Start one with atticus learn start <role|lesson>.");
  const lesson = await findLesson(root, id);
  const lp = (p.lessons[lesson.id] ??= { startedAt: iso(o.now ?? new Date()), steps: {} });
  const step = o.step
    ? lesson.steps.find((s) => s.id === o.step)
    : (lesson.steps.find((s) => !lp.steps[s.id]) ?? lesson.steps.at(-1));
  if (!step) throw new LearnError(`Lesson ${lesson.id} has no step ${o.step}.`, "not-found");
  const result = await runCheck(root, step.check, o.answer);
  if (result.pass && !lp.steps[step.id])
    lp.steps[step.id] = {
      passedAt: iso(o.now ?? new Date()),
      ...(o.answer ? { answer: o.answer } : {}),
    };
  const next = lesson.steps.find((s) => !lp.steps[s.id]);
  const completed = !next;
  if (completed && !lp.completedAt) lp.completedAt = iso(o.now ?? new Date());
  p.current = lesson.id;
  await writeProgress(root, p);
  return { lesson, step, result, ...(next ? { next } : {}), completed };
}
