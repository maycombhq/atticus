import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";
import { CORE_ROLES, LifecycleState, RecordId } from "@maycombhq/core";

/**
 * Lessons as data. A lesson is a short guided exercise for one role, run in the practice
 * sandbox (a throwaway metarepo built from the Forge fixture, see sandbox.ts): Markdown to
 * read, the commands to try, and for every step a check Atticus can verify from the
 * sandbox's files (a record exists, a decision was recorded, a change moved on) or from an
 * answer the learner gives, compared with what the sandbox's catalog says. Lessons live in
 * `lessons/*.yaml` inside this package, so the M4 screens (tours, the practice sandbox) read
 * the same data the CLI does. An organisation adds its own under
 * `org-pack/learn/lessons/*.yaml` (rule 7).
 */

export const LESSON_SCHEMA_VERSION = 1 as const;

/** Where a check's right answer comes from: the sandbox's own catalog, inputs or changes. */
export const Truth = z.discriminatedUnion("from", [
  /** Components that read a table (Table.readers). */
  z.strictObject({ from: z.literal("table-readers"), id: RecordId }),
  /** Components that call a component, optionally only through one route kind. */
  z.strictObject({
    from: z.literal("interface-callers"),
    to: RecordId,
    via: z.string().optional(),
  }),
  /** The owner of a system. */
  z.strictObject({ from: z.literal("system-owner"), id: RecordId }),
  /** Systems with no owner in the catalog. */
  z.strictObject({ from: z.literal("systems-without-owner") }),
  /** Files under a folder the ingested-content defences rate medium or high. */
  z.strictObject({ from: z.literal("flagged-files"), path: z.string().min(1) }),
  /** A change's state. */
  z.strictObject({ from: z.literal("change-state"), change: RecordId }),
  /** The feature an entry point belongs to. */
  z.strictObject({ from: z.literal("feature-of"), entryPoint: RecordId }),
  /** The pattern code a change's interfaces.md names that the org pack doesn't know. */
  z.strictObject({ from: z.literal("unknown-pattern"), change: RecordId }),
  /** Stories of a change with no acceptance criteria. */
  z.strictObject({ from: z.literal("stories-without-criteria"), change: RecordId }),
  /** A fixed answer, for questions the files can't decide (yes/no, a name on a diagram). */
  z.strictObject({ from: z.literal("fixed"), values: z.array(z.string().min(1)).min(1) }),
]);
export type Truth = z.infer<typeof Truth>;

export type Check =
  | { type: "catalog-has"; kind: string; id?: string; min?: number }
  | { type: "index-built" }
  | { type: "file"; path: string; contains?: string[]; notContains?: string[] }
  | { type: "files"; dir: string; suffix?: string; min?: number }
  | { type: "curated-decision"; action: string; target: string; includes?: string }
  | { type: "record"; kind: string; id: string; where?: Record<string, string> }
  | { type: "change-state"; change: string; atLeast: LifecycleState }
  | {
      type: "findings";
      change: string;
      gate?: string;
      rule?: string;
      artifact?: string;
      min?: number;
      max?: number;
      state?: string;
      /** Only the newest round at the gate. */
      latest?: boolean;
    }
  | { type: "answer"; question: string; truth: Truth }
  | { type: "steps"; action?: string; state?: "open" | "done"; min?: number }
  | { type: "all"; checks: Check[] };

export const Check: z.ZodType<Check> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.strictObject({
      type: z.literal("catalog-has"),
      kind: z.string().min(1),
      id: z.string().optional(),
      min: z.number().int().positive().optional(),
    }),
    z.strictObject({ type: z.literal("index-built") }),
    z.strictObject({
      type: z.literal("file"),
      path: z.string().min(1),
      contains: z.array(z.string()).optional(),
      notContains: z.array(z.string()).optional(),
    }),
    z.strictObject({
      type: z.literal("files"),
      dir: z.string().min(1),
      suffix: z.string().optional(),
      min: z.number().int().positive().optional(),
    }),
    z.strictObject({
      type: z.literal("curated-decision"),
      action: z.string().min(1),
      target: z.string().min(1),
      includes: z.string().optional(),
    }),
    z.strictObject({
      type: z.literal("record"),
      kind: z.string().min(1),
      id: z.string().min(1),
      where: z.record(z.string(), z.string()).optional(),
    }),
    z.strictObject({ type: z.literal("change-state"), change: RecordId, atLeast: LifecycleState }),
    z.strictObject({
      type: z.literal("findings"),
      change: RecordId,
      gate: z.string().optional(),
      rule: z.string().optional(),
      artifact: z.string().optional(),
      min: z.number().int().min(0).optional(),
      max: z.number().int().min(0).optional(),
      state: z.string().optional(),
      latest: z.boolean().optional(),
    }),
    z.strictObject({ type: z.literal("answer"), question: z.string().min(1), truth: Truth }),
    z.strictObject({
      type: z.literal("steps"),
      action: z.string().optional(),
      state: z.enum(["open", "done"]).optional(),
      min: z.number().int().positive().optional(),
    }),
    z.strictObject({ type: z.literal("all"), checks: z.array(Check).min(1) }),
  ]),
);

export const LessonStep = z.strictObject({
  id: RecordId,
  title: z.string().min(1),
  /** What to read and do, in Markdown. */
  body: z.string().min(1),
  /** The commands to try, as arguments after `atticus` (the sandbox root is added). */
  do: z.array(z.array(z.string())).default([]),
  /** Files to write for this step, when it asks the learner to write something (also the worked solution). */
  solution: z
    .strictObject({
      answer: z.string().optional(),
      files: z.array(z.strictObject({ path: z.string().min(1), content: z.string() })).default([]),
    })
    .optional(),
  check: Check,
  /** Shown when the check fails. */
  hint: z.string().min(1),
});
export type LessonStep = z.infer<typeof LessonStep>;

export const Lesson = z
  .strictObject({
    schemaVersion: z.literal(LESSON_SCHEMA_VERSION),
    id: RecordId,
    /** A role id from roles.yaml (core or custom). */
    role: RecordId,
    title: z.string().min(1),
    summary: z.string().min(1),
    minutes: z.number().int().positive(),
    /** What the sandbox must have before the first step: "scan" scans it and builds the index. */
    setup: z.array(z.enum(["scan"])).default([]),
    intro: z.string().min(1),
    steps: z.array(LessonStep).min(1),
    outro: z.string().min(1),
  })
  .superRefine((l, ctx) => {
    const seen = new Set<string>();
    for (const s of l.steps) {
      if (seen.has(s.id))
        ctx.addIssue({ code: "custom", path: ["steps"], message: `step ${s.id} appears twice` });
      seen.add(s.id);
    }
  });
export type Lesson = z.infer<typeof Lesson>;

/** The folder of built-in lessons (beside src/ and dist/). */
export const LESSONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "lessons");

export interface LoadedLessons {
  lessons: (Lesson & { source: string })[];
  problems: string[];
}

async function readDir(dir: string, label: string, out: LoadedLessons): Promise<void> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => /\.ya?ml$/.test(n)).sort();
  } catch {
    return;
  }
  for (const n of names) {
    try {
      const r = Lesson.safeParse(parse(await readFile(join(dir, n), "utf8")));
      if (!r.success) {
        out.problems.push(
          `${label}/${n}: ${r.error.issues.map((i) => `${i.path.join(".") || "(file)"} ${i.message}`).join("; ")}`,
        );
        continue;
      }
      const at = out.lessons.findIndex((l) => l.id === r.data.id);
      const lesson = { ...r.data, source: `${label}/${n}` };
      if (at >= 0) out.lessons[at] = lesson;
      else out.lessons.push(lesson);
    } catch (e) {
      out.problems.push(`${label}/${n}: ${(e as Error).message.split("\n")[0]}`);
    }
  }
}

/** Built-in lessons, then the organisation's (`<orgPackDir>/learn/lessons`), which replace by id. */
export async function loadLessons(
  o: { orgPackDir?: string; dir?: string } = {},
): Promise<LoadedLessons> {
  const out: LoadedLessons = { lessons: [], problems: [] };
  await readDir(o.dir ?? LESSONS_DIR, "lessons", out);
  if (o.orgPackDir)
    await readDir(join(o.orgPackDir, "learn", "lessons"), "org-pack/learn/lessons", out);
  const order = (role: string) => {
    // The first hour is for everyone, so it comes before any role's lessons (WP7.11).
    if (role === "everyone") return -1;
    const i = (CORE_ROLES as readonly string[]).indexOf(role);
    return i === -1 ? CORE_ROLES.length : i;
  };
  out.lessons.sort(
    (a, b) => order(a.role) - order(b.role) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return out;
}
