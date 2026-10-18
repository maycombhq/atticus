import type { AiRuntime } from "@maycombhq/ai";
import {
  checkStep,
  createSandbox,
  explain,
  isSandbox,
  LearnError,
  lessonsFor,
  readProgress,
  SandboxError,
  startLesson,
  type Check,
  type Lesson,
  type LessonStep,
} from "@maycombhq/learn";
import type { Output } from "./commands.js";
import { table } from "./index-commands.js";

/**
 * atticus learn, atticus sandbox, atticus explain: the learning tools. Lessons run only in a
 * practice sandbox (a throwaway metarepo built from the invented Forge estate). Exit 0 ok, 1
 * when a check fails or something is missing, 2 usage.
 */

export interface LearnDeps {
  now?: Date;
  /** For explain: an AI runtime to reword the explanation (never needed). */
  runtime?: AiRuntime;
}

function fail(io: Output, e: unknown): number {
  if (e instanceof LearnError || e instanceof SandboxError) {
    io.err(e.message);
    return e instanceof LearnError && e.code === "usage" ? 2 : 1;
  }
  throw e;
}

const command = (argv: string[]) =>
  `atticus ${argv.map((a) => (/[\s"']/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(" ")}`;

function printStep(io: Output, lesson: Lesson, step: LessonStep) {
  const n = lesson.steps.indexOf(step) + 1;
  io.out(`Step ${n} of ${lesson.steps.length}: ${step.title}`);
  io.out("");
  for (const l of step.body.trimEnd().split("\n")) io.out(l);
  if (step.do.length) {
    io.out("");
    for (const argv of step.do) io.out(`  ${command(argv)}`);
  }
  const ask =
    step.check.type === "answer"
      ? step.check
      : step.check.type === "all"
        ? step.check.checks.find(
            (c): c is Extract<Check, { type: "answer" }> => c.type === "answer",
          )
        : undefined;
  if (ask) {
    io.out("");
    io.out(`Question: ${ask.question}`);
    io.out('Answer with: atticus learn check --answer "<your answer>"');
  } else {
    io.out("");
    io.out("When you have done it: atticus learn check");
  }
}

/** atticus learn [list] [--json]: lessons by role, with progress when run in a sandbox. */
export async function learnList(root: string, o: { json?: boolean }, io: Output): Promise<number> {
  const { lessons, problems } = await lessonsFor(root);
  const sandbox = await isSandbox(root);
  const progress = sandbox ? await readProgress(root) : undefined;
  const state = (l: Lesson) => {
    const p = progress?.lessons[l.id];
    if (!p) return "not started";
    if (p.completedAt) return "done";
    return `${Object.keys(p.steps).length} of ${l.steps.length} steps`;
  };
  if (o.json) {
    io.out(
      JSON.stringify(
        {
          sandbox,
          lessons: lessons.map((l) => ({
            id: l.id,
            role: l.role,
            title: l.title,
            minutes: l.minutes,
            steps: l.steps.length,
            state: state(l),
          })),
          problems,
        },
        null,
        2,
      ),
    );
    return problems.length ? 1 : 0;
  }
  for (const l of table(
    ["ROLE", "LESSON", "MINUTES", "PROGRESS", "TITLE"],
    lessons.map((l) => [l.role, l.id, String(l.minutes), sandbox ? state(l) : "-", l.title]),
  ))
    io.out(l);
  for (const p of problems) io.err(p);
  io.out(
    sandbox
      ? "Start one with atticus learn start <role|lesson>."
      : "Lessons run in a practice sandbox: atticus sandbox create <dir>, then run atticus learn start <role> there.",
  );
  return problems.length ? 1 : 0;
}

/** atticus learn start <role|lesson>: start or resume a lesson in the sandbox. */
export async function learnStart(
  root: string,
  roleOrLesson: string | undefined,
  o: { json?: boolean },
  io: Output,
  deps: LearnDeps = {},
): Promise<number> {
  if (!roleOrLesson) {
    io.err("Usage: atticus learn start <role|lesson>");
    return 2;
  }
  try {
    const r = await startLesson(root, roleOrLesson, deps.now ? { now: deps.now } : {});
    if (o.json) {
      io.out(
        JSON.stringify(
          { lesson: r.lesson.id, step: r.step?.id ?? null, setup: r.setup, resumed: r.resumed },
          null,
          2,
        ),
      );
      return 0;
    }
    io.out(
      `${r.lesson.title} (${r.lesson.role}, about ${r.lesson.minutes} minutes)${r.resumed ? ": resumed" : ""}`,
    );
    for (const s of r.setup) io.out(s);
    io.out("");
    if (!r.resumed) {
      for (const l of r.lesson.intro.trimEnd().split("\n")) io.out(l);
      io.out("");
    }
    if (r.step) printStep(io, r.lesson, r.step);
    else io.out("You have finished this lesson. Pick another with atticus learn.");
    return 0;
  } catch (e) {
    return fail(io, e);
  }
}

/** atticus learn check [--answer text] [--lesson id] [--step id]: check the current step. */
export async function learnCheck(
  root: string,
  o: { answer?: string; lesson?: string; step?: string; json?: boolean },
  io: Output,
  deps: LearnDeps = {},
): Promise<number> {
  try {
    const r = await checkStep(root, {
      ...(o.answer !== undefined ? { answer: o.answer } : {}),
      ...(o.lesson ? { lesson: o.lesson } : {}),
      ...(o.step ? { step: o.step } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    });
    if (o.json) {
      io.out(
        JSON.stringify(
          {
            lesson: r.lesson.id,
            step: r.step.id,
            pass: r.result.pass,
            message: r.result.message,
            next: r.next?.id ?? null,
            completed: r.completed,
          },
          null,
          2,
        ),
      );
      return r.result.pass ? 0 : 1;
    }
    if (!r.result.pass) {
      io.out(`Not yet: ${r.result.message}`);
      io.out(`Hint: ${r.step.hint}`);
      return 1;
    }
    io.out(`Passed: ${r.result.message}`);
    if (r.next) {
      io.out("");
      printStep(io, r.lesson, r.next);
    } else {
      io.out("");
      for (const l of r.lesson.outro.trimEnd().split("\n")) io.out(l);
    }
    return 0;
  } catch (e) {
    return fail(io, e);
  }
}

/** atticus sandbox create <dir>: a throwaway practice metarepo from the Forge fixture. */
export async function sandboxCreate(
  dir: string | undefined,
  o: { json?: boolean },
  io: Output,
  deps: LearnDeps = {},
): Promise<number> {
  if (!dir) {
    io.err("Usage: atticus sandbox create <dir>");
    return 2;
  }
  try {
    const s = await createSandbox(dir, deps.now ? { now: deps.now } : {});
    if (o.json) {
      io.out(JSON.stringify(s, null, 2));
      return 0;
    }
    io.out(
      `Made a practice sandbox in ${s.dir}: ${s.repos.length} Forge repos and the seeded change ${s.change}.`,
    );
    io.out(
      `Its metarepo is ${s.root}. Run commands there (or add --root), starting with atticus learn.`,
    );
    return 0;
  } catch (e) {
    return fail(io, e);
  }
}

/** atticus explain <id|command> [--json]: a record, finding, change or command in plain words. */
export async function explainCommand(
  root: string,
  idOrCommand: string | undefined,
  o: { json?: boolean },
  io: Output,
  deps: LearnDeps = {},
): Promise<number> {
  if (!idOrCommand?.trim()) {
    io.err("Usage: atticus explain <record id | finding id | change id | command>");
    return 2;
  }
  const e = await explain(root, idOrCommand, {
    ...(deps.runtime ? { runtime: deps.runtime } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });
  if (o.json) {
    io.out(JSON.stringify(e, null, 2));
    return e.kind === "unknown" ? 1 : 0;
  }
  io.out(e.title);
  for (const l of e.lines) io.out(`  ${l}`);
  if (e.reworded) {
    io.out("");
    io.out("In plain words (AI):");
    for (const l of e.reworded.split("\n")) io.out(`  ${l}`);
  }
  if (e.seeAlso.length) io.out(`See also: ${e.seeAlso.join(", ")}`);
  return e.kind === "unknown" ? 1 : 0;
}
