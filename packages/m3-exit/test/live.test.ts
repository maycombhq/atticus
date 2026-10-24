import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { changeDirOf, metarepoOf, SANDBOXES, writeText } from "../live/common.mjs";
import { FORGE_CHANGE, PACKAGE } from "../live/estate.mjs";
import { grade, report, required, type Grades } from "../live/grade.mjs";
import { leaks, prepare } from "../live/prepare.mjs";
import { simulate } from "../live/simulate.mjs";
import { readYaml, T, walk } from "./helpers.js";

/**
 * M3 exit, live runs: `live/prepare.mjs` builds sandboxes for fresh agent sessions, `live/grade.mjs`
 * grades what they did. Here a perfect agent (live/simulate.mjs: it answers every hand-off prompt
 * with the repository's hand-written recording) works in one prepared run, the grader passes it, and
 * broken answers fail it. Nothing touches the network; the "agent" is the recordings.
 */

const run = promisify(execFile);
let out: string;
let runDir: string;
let grades: Grades;
const CHANGE = "add-transfer-limit";

beforeAll(async () => {
  out = await mkdtemp(join(tmpdir(), "atticus-m3-live-"));
  await prepare(out, { runs: 1 });
  runDir = join(out, "run-1");
}, T);

afterAll(async () => {
  await rm(out, { recursive: true, force: true });
});

describe("M3 exit live runs: prepare.mjs", () => {
  it(
    "builds five independent sandboxes, an atticus shim, env.sh and a TASK.md for each run",
    async () => {
      for (const name of Object.values(SANDBOXES))
        expect(await readdir(join(runDir, name, "metarepo", "org-pack"))).toContain("runtime.yaml");
      const shim = join(runDir, "bin", process.platform === "win32" ? "atticus.cmd" : "atticus");
      // The shim runs the built CLI by absolute path, with hand-off as the default AI mode.
      const r = await run(shim, ["change", "status", CHANGE, "--json"], {
        cwd: metarepoOf(runDir, "task"),
        shell: process.platform === "win32",
      });
      expect(JSON.parse(r.stdout)).toMatchObject({ id: CHANGE, state: "build" });
      expect(await readFile(join(runDir, "bin", "atticus"), "utf8")).toContain(
        'ATTICUS_RUNTIME="${ATTICUS_RUNTIME:-hand-off}"',
      );
      const env = await readFile(join(runDir, "env.sh"), "utf8");
      expect(env).toContain(`export PATH="${join(runDir, "bin")}:$PATH"`);
      expect(env).toContain("export ATTICUS_RUNTIME=hand-off");
    },
    T,
  );

  it(
    "starts each sandbox where its exit needs it: no plan for the story writer, the seeded plan for the critic, Build with task 1.2 handed down, built and merged, or not yet",
    async () => {
      const change = (key: keyof typeof SANDBOXES) => changeDirOf(metarepoOf(runDir, key));
      const exists = (p: string) =>
        stat(p).then(
          () => true,
          () => false,
        );
      expect(await exists(join(change("stories"), "stories.md"))).toBe(false);
      expect(await exists(join(change("stories"), "snow.md"))).toBe(false);
      expect(await exists(join(change("stories"), "design.md"))).toBe(true);
      expect(await exists(join(change("critic"), "stories/s2-show-remaining.md"))).toBe(true);
      for (const key of ["task", "handup", "names"] as const) {
        expect((await readYaml<{ state: string }>(join(change(key), "change.yaml"))).state).toBe(
          "build",
        );
        expect(await exists(join(change(key), "sync.yaml"))).toBe(true);
      }
      expect(
        await exists(
          join(
            metarepoOf(runDir, "task"),
            "workspace/.worktrees",
            CHANGE,
            "forge-ledger/specs/1.2",
          ),
        ),
      ).toBe(true);
      expect(await exists(join(change("task"), "tasks/1.2/task-run.yaml"))).toBe(false);
      expect(
        (await readYaml<{ state: string }>(join(change("handup"), "tasks/1.2/task-run.yaml")))
          .state,
      ).toBe("built");
      expect(await exists(join(change("names"), "tasks/1.2"))).toBe(false);
      // The real build command, not the suite's fake of it, is what the manifest names: a node
      // script that logs the build.
      // Read as YAML, not as text: a long Windows path is folded across lines.
      const manifest = await readYaml<{ repos: { build?: string }[] }>(
        join(metarepoOf(runDir, "task"), "org-pack/profiles/forge/repos.manifest.yaml"),
      );
      const builds = manifest.repos.flatMap((r) => (r.build ? [r.build] : []));
      expect(builds.length).toBeGreaterThan(0);
      for (const b of builds) expect(b).toMatch(/^node ".*fake-build\.mjs"$/);
    },
    T,
  );

  it(
    "leaves every expected file, recording, finding or story answer and the repository's tests out of the run",
    async () => {
      expect(await leaks(runDir)).toEqual([]);
      const files = await walk(runDir, (rel) => rel.split("/").includes(".git"));
      expect(files.filter((f) => /(^|\/)(expected|recordings)(\/|$)/.test(f))).toEqual([]);
      expect(files.filter((f) => /(^|\/)(findings|stories)\.yaml$/.test(f))).toEqual([]);
      expect(files.filter((f) => /\.test\.(ts|mjs)$|^packages\/|vitest/.test(f))).toEqual([]);
      expect(files.filter((f) => /(^|\/)[0-9a-f]{64}\.json$/.test(f))).toEqual([]);
      // The ground truth is the repository's: no id of the seeded problems appears in any text
      // file of the run (TASK.md included).
      const ids = (await readFile(join(FORGE_CHANGE, "expected/findings.yaml"), "utf8"))
        .split("\n")
        .map((l) => /^\s*- id: (\S+)/.exec(l)?.[1])
        .filter((x): x is string => Boolean(x));
      expect(ids.length).toBeGreaterThan(25);
      const seeded = new RegExp(ids.join("|"));
      for (const f of files.filter((x) => /\.(md|yaml|yml|json|sh|txt)$/.test(x))) {
        const hit = seeded.exec(await readFile(join(runDir, f), "utf8"));
        expect(hit?.[0], `${f} mentions a seeded id`).toBeUndefined();
      }
      // TASK.md names the commands of every exit and tells the agent to stay inside the run.
      const task = await readFile(join(runDir, "TASK.md"), "utf8");
      for (const cmd of [
        "plan stories",
        "plan snow",
        "critic add-transfer-limit --gate plan --mode hand-off",
        "plan bar",
        "task run add-transfer-limit 1.2 --by dev --level draft --mode hand-off",
        "drift add-transfer-limit",
        "trace add-transfer-limit",
        "spec hand-up add-transfer-limit 1.2",
        "feature suggest-names --mode hand-off",
        "tests generate add-transfer-limit s2-remaining-limit --mode hand-off",
        "glossary scan --mode hand-off",
        "templates draft --mode hand-off",
        "handoff done",
      ])
        expect(task, cmd).toContain(cmd);
      // The hand-offs finish on their own: no --force, no expected failure to wave through.
      expect(task).not.toContain("--force");
      expect(task).not.toContain("at least one delta");
      expect(task).toContain(`Work only inside \`${runDir}\``);
      expect(task).toContain("NOTES.md");
    },
    T,
  );

  it("refuses to write into a run folder that exists, and says how to use the script", async () => {
    await expect(prepare(out, { runs: 1 })).rejects.toThrow(/run-1 already exists/);
    const usage = await run(process.execPath, [join(PACKAGE, "live/prepare.mjs")]).catch(
      (e: { code: number; stderr: string }) => e,
    );
    expect(usage).toMatchObject({ code: 2 });
    expect((usage as { stderr: string }).stderr).toMatch(/Usage: node .*prepare\.mjs <outDir>/);
  });
});

describe("M3 exit live runs: grade.mjs", () => {
  it(
    "a run nobody worked in fails every graded exit with a reason that says what is missing, never an exception",
    async () => {
      const g = await grade(out);
      const reasons = (["a", "b", "c", "d"] as const).map((id) => {
        expect(g.exits[id].results[0]!.pass, id).toBe(false);
        return g.exits[id].results[0]!.reason;
      });
      expect(reasons).toEqual([
        "no tasks.md: `plan stories --resume` did not complete",
        "the critic was never run at the plan gate (no review/plan/1/meta/round.yaml)",
        "task 1.2 was never run (no tasks/1.2/task-run.yaml)",
        "the code-and-test lens never ran (spec hand-up not run, or its hand-off not finished)",
      ]);
      expect(g.exits.e.results[0]).toMatchObject({ complete: false });
      expect(g.exits.e.results[0]!.reason).toMatch(/^missing: /);
    },
    T,
  );

  it(
    "a perfect agent (every hand-off answered from the recordings) passes exits a to d, and exit e is collected for a person",
    async () => {
      await simulate(runDir);
      grades = await grade(out);
      const g = (id: "a" | "b" | "c" | "d") => grades.exits[id];
      expect(g("a").results[0]!.reason).toBe(
        "5 of 5 stories ready (100%, bar 90%); 13 of 13 gaps covered; 0 invented names",
      );
      expect(g("b").results[0]!.reason).toBe(
        "14 of 14 blocking; 13 of 13 gaps (100%); 5 of 5 lenses ran; 0 unlisted (for a person to review); b07-personal-column-unclassified caught as a question to the table's owner naming the personal columns (no model was asked in hand-off mode)",
      );
      // ADR 0117 addendum: the sandbox holds no person's judgments, so under hand-off the
      // critic asks the table's owner which columns are personal; that question is b07.
      expect(g("b").results[0]!.details).toMatchObject({
        askedOfAPerson: ["b07-personal-column-unclassified"],
      });
      expect(g("c").results[0]!.reason).toBe(
        "built in 1 attempt; No drift.; trace links code to s2",
      );
      expect(g("d").results[0]!.reason).toBe("the lens ran; 0 findings on task 1.2, 0 blocking");
      for (const id of ["a", "b", "c", "d"] as const) {
        expect(g(id).results[0]!.pass, `${id}: ${g(id).results[0]!.reason}`).toBe(true);
        expect(g(id)).toMatchObject({ passed: 1, total: 1, required: 1, verdict: "PASS" });
        expect(g(id).provisional).toBe(true);
      }
      expect(grades.exits.e.results[0]).toMatchObject({ run: "run-1", complete: true });

      const file = await readYaml<Grades>(join(out, "grades.json"));
      expect(file.runs).toEqual(["run-1"]);
      expect(file.exits.b.results[0]!.pass).toBe(true);
      const md = await readFile(join(out, "for-a-person.md"), "utf8");
      expect(md).toContain("## Feature namer");
      expect(md).toContain("### run-1");
      expect(md).toContain("feature.transfers");
      expect(md).toContain("names.yaml");
      expect(md).not.toContain("_Not written._");

      const lines = report(grades);
      expect(lines).toContain("Exit a: Story writer meets the story bar");
      expect(
        lines.some((l) => /^ {2}Verdict: PASS: 1 of 1 runs passed; the exit needs 1 /.test(l)),
      ).toBe(true);
    },
    T,
  );

  it("grading needs 4 of 5 runs: with five runs one failing run still passes the exit, two do not", () => {
    expect([1, 2, 3, 4, 5].map(required)).toEqual([1, 2, 3, 4, 4]);
  });

  it(
    "broken answers fail: empty lens answers, placeholder stories, a failed task run and a blocking hand-up finding",
    async () => {
      // b: every lens found nothing wrong, so the AI-only seeded problems are missed: take what
      // the lenses read into round 1 out of it, leaving the findings of the rule checks.
      const round = join(changeDirOf(metarepoOf(runDir, "critic")), "review/plan/1");
      const meta = await readYaml<{ lenses: { rules: string[] }[] }>(
        join(round, "meta/round.yaml"),
      );
      const lensRules = new Set(meta.lenses.flatMap((l) => l.rules));
      for (const f of (await readdir(round)).filter((n) => n.endsWith(".yaml"))) {
        const finding = await readYaml<{ rule: string }>(join(round, f));
        if (lensRules.has(finding.rule)) await rm(join(round, f));
      }
      // a: stories that are placeholders.
      const storyDir = join(changeDirOf(metarepoOf(runDir, "stories")), "stories");
      for (const f of await readdir(storyDir))
        await writeFile(join(storyDir, f), "# Placeholder\n\nTBD\n");
      // c: the task run did not end built.
      const taskRun = join(changeDirOf(metarepoOf(runDir, "task")), "tasks/1.2/task-run.yaml");
      await writeFile(
        taskRun,
        (await readFile(taskRun, "utf8")).replace(/^state: built$/m, "state: needs-person"),
      );
      // d: the lens raised a blocking finding on the task.
      await writeText(
        join(changeDirOf(metarepoOf(runDir, "handup")), "review/hand-up/1/planted.yaml"),
        [
          "artifact: tasks/1.2/review-code-and-test.yaml",
          "severity: blocking",
          "state: open",
          "summary: The endpoint has no test for an unknown account.",
          "",
        ].join("\n"),
      );

      const broken = await grade(out);
      const g = (id: "a" | "b" | "c" | "d") => broken.exits[id];
      for (const id of ["a", "b", "c", "d"] as const) {
        expect(g(id).results[0]!.pass, `${id}: ${g(id).results[0]!.reason}`).toBe(false);
        expect(g(id)).toMatchObject({ passed: 0, total: 1, verdict: "FAIL" });
      }
      expect(g("a").results[0]!.reason).toMatch(/stories ready/);
      expect(g("b").results[0]!.reason).toMatch(
        /12 of 14 blocking \(missed b13-concurrent-transfers, b14-story-without-spec\); 11 of 13 gaps/,
      );
      expect(g("c").results[0]!.reason).toBe("task 1.2 ended needs-person");
      expect(g("d").results[0]!.reason).toMatch(
        /1 blocking: The endpoint has no test for an unknown account\./,
      );
      const lines = report(broken).join("\n");
      expect(lines).toMatch(/Verdict: FAIL: 0 of 1 runs passed/);
    },
    T,
  );

  it("says what is missing when there is no run to grade, and how to use the script", async () => {
    const empty = await mkdtemp(join(tmpdir(), "atticus-m3-live-empty-"));
    try {
      await expect(grade(empty)).rejects.toThrow(/holds no run-N folders/);
      const usage = await run(process.execPath, [join(PACKAGE, "live/grade.mjs")]).catch(
        (e: { code: number; stderr: string }) => e,
      );
      expect(usage).toMatchObject({ code: 2 });
      expect((usage as { stderr: string }).stderr).toMatch(/Usage: node .*grade\.mjs <outDir>/);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});
