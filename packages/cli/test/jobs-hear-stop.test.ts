import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The review of ADR 0202: a job is `stoppable` only if its work hears Stop, and says so where it
 * is started (`hearsStop: true`). This is every place the app starts a job, with its truth and
 * why: the work reads the job's signal or `cancelled` (true), or runs to its end (false: no Stop
 * is offered for it, a Stop asked of it is refused, and it never ends "Stopped."). A job started
 * anywhere else, or one whose truth changes, fails here until it is listed.
 */
const SRC = join(import.meta.dirname, "../src");
const STARTS = /\b(?:asJob|jobs\.start|jobs\.track|tracked|trackedLocal|answerAsJob)\(/g;

/** [file, words only that call has, whether its work hears Stop, why]. */
const JOBS: [string, string, boolean | "caller", string][] = [
  // Local steps (asJob), one at a time.
  ["ui-api.ts", "`Applying to ${repo}`", true, "verify --write: Stop until the write"],
  ["ui-api.ts", '"Upgrading the metarepo"', false, "atticus upgrade reads no signal"],
  ["ui-api.ts", '"Proposing for review"', true, "checks the signal until the push"],
  ["ui-api.ts", '"Bringing in what merged"', true, "checks the signal until the tree changes"],
  ["ui-api.ts", "`Setting the upstream to", false, "two git calls, no signal"],
  ["ui-api.ts", "code against its design`", false, "the conformance check reads no signal"],
  ["ui-api-steps.ts", "verifyAllCommand", true, "verify --all --write: Stop between repos"],
  ["ui-api-steps.ts", '"Joining the estate\'s flows"', false, "estate join reads no signal"],
  ["ui-api-steps.ts", '"Syncing every wiki"', false, "sources sync reads no signal"],
  ["ui-api-steps.ts", "worktrees", false, "workspace prune reads no signal"],
  ["ui-api-catalog.ts", "`Promote on ${repo}`", false, "a fact line and a dry verify"],
  ["ui-api-catalog.ts", "`Dismiss on ${repo}`", false, "one line written"],
  [
    "ui-api-catalog.ts",
    '["atticus catalog build", ...flags]',
    true,
    "the build: Stop until its write",
  ],
  [
    "ui-api-catalog.ts",
    '"Make the hand edits curated, then build"',
    true,
    "the build: Stop until its write",
  ],
  ["ui-api-catalog.ts", "`atticus catalog undo ${b.n} --yes`", false, "undo reads no signal"],
  ["ui-api-catalog.ts", '"atticus catalog prune --yes"', false, "prune reads no signal"],
  ["ui-api-catalog.ts", "atticus upgrade --yes", false, "atticus upgrade reads no signal"],
  [
    "ui-api-catalog.ts",
    "`Delete the link ${b.from}",
    false,
    "a curated decision and a build that doesn't listen",
  ],
  ["ui-api-catalog.ts", "`Bring back the link ${l.from}", false, "as Delete the link"],
  [
    "ui-api-catalog.ts",
    "to the map`",
    true,
    "Apply my changes: Stop until the first change is written",
  ],
  // Jobs started directly.
  ["ui-api.ts", '"local",', "caller", "asJob itself: as its caller says"],
  [
    "ui-api.ts",
    "runReadyTasks",
    true,
    "asks `cancelled` between tasks; a model call reads the signal",
  ],
  ["ui-api.ts", '"Checking with the built-in readers"', true, "the scan checks between repos"],
  ["ui-api.ts", '"Syncing base clones"', true, "the signal goes to every git"],
  ["ui-api.ts", "`Reconciling ${b.diagram}`", false, "reconcile reads no signal"],
  ["ui-api-link-match.ts", "`Matching ${from}", true, "the signal goes to the runner"],
  ["ui-api-runs.ts", "with ${model}`", true, "a model run: the runtime reads the signal"],
  ["ui-api-copilot-runs.ts", "const live = ()", true, "a Copilot run: the signal ends its session"],
  // Work a request waits on, as a job.
  ["ui-api-activity.ts", 'jobs.track(o.kind ?? "work"', "caller", "tracked itself"],
  ["ui-api-activity.ts", "const answer = await work(c)", "caller", "answerAsJob itself"],
  ["ui-api-activity.ts", "c?.progress(0, 1, title)", "caller", "trackedLocal itself"],
  ["ui-api-links.ts", "work_, hears", true, "linksJob: its steps take the signal"],
  ["ui-api-knowledge.ts", "`Sync the wiki ${id}`", false, "sources sync reads no signal"],
  [
    "ui-api-roles.ts",
    "Putting work items in the tracker",
    false,
    "the tracker's calls read no signal",
  ],
  ["ui-api-run.ts", "`Run step ${params.stepId!}`", false, "a team's tool, run to its end"],
  ["ui-api-runs.ts", '["verify", repo, "--write"]', true, "verify --write: Stop until the write"],
  [
    "ui-api.ts",
    "`Done: ${runId}`,\n        ()",
    false,
    "Done's check builds and commits: to its end",
  ],
  ["ui-api.ts", "Checked the answer", false, "as Done"],
  [
    "ui-api.ts",
    "`Finishing the step: ${after.runId}`",
    false,
    "a step's resume writes: to its end",
  ],
  [
    "ui-api.ts",
    "`Critic on ${params.changeId!}`",
    true,
    "a model call: the runtime reads the signal",
  ],
];

/** Every call that starts a job in a file: its text, from its name to its closing bracket. */
function calls(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(STARTS)) {
    // A declaration (`function tracked(`), a type or a comment is no call.
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    if (/(function|export const|const|type)\s+$/.test(before)) continue;
    const line = text.slice(text.lastIndexOf("\n", m.index) + 1, m.index);
    if (/^\s*(\*|\/\/|\/\*)/.test(line)) continue;
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < text.length; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")" && --depth === 0) break;
    }
    out.push(text.slice(m.index, i + 1));
  }
  return out;
}

describe("every job the app starts says whether its work hears Stop", () => {
  const files = readdirSync(SRC).filter((f) => /^ui-api.*\.ts$/.test(f));
  const found = files.flatMap((f) =>
    calls(readFileSync(join(SRC, f), "utf8")).map((text) => ({ file: f, text })),
  );

  /** A call's row: the first listed whose words it has (a call may hold another inside it). */
  const rowOf = (c: { file: string; text: string }) =>
    JOBS.find(([f, words]) => f === c.file && c.text.includes(words));

  it("each start is listed, and each listed one is one start", () => {
    for (const c of found) expect(rowOf(c), `${c.file}: ${c.text.slice(0, 160)}`).toBeDefined();
    for (const row of JOBS)
      expect(found.filter((c) => rowOf(c) === row).length, `${row[0]}: ${row[1]}`).toBe(1);
  });

  it.each(JOBS)("%s: %s hears Stop: %s (%s)", (file, words, hears) => {
    const c = found.find((x) => rowOf(x)?.[0] === file && rowOf(x)?.[1] === words)!;
    const text = readFileSync(join(SRC, file), "utf8");
    if (hears === "caller") {
      // A helper others start jobs through: it hands on what its caller said, and no more.
      expect(text).toMatch(/o\.hearsStop \? \{ hearsStop: (true|o\.hearsStop) \}/);
      expect(c.text).not.toMatch(/(?<!\? \{ )hearsStop: true/);
      return;
    }
    // Its own start says so, in its call or in the options it names there.
    const named = [...c.text.matchAll(/\b(applyFor|mapEdits|several|hears)\b/g)].some((m) =>
      new RegExp(`const ${m[1]} = [^;]*hearsStop: true`).test(text),
    );
    expect(c.text.includes("hearsStop: true") || named).toBe(hears);
  });
});
