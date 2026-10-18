import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockGitHost } from "@maycombhq/adapters";
import { loadLessons, type Lesson } from "@maycombhq/learn";
import { changeHandoff, changeSync } from "../src/change-commands.js";
import { defencesScan } from "../src/eval-commands.js";
import {
  initiativeNew,
  initiativePlan,
  initiativeStatus,
  requestFromTeam,
} from "../src/initiative-commands.js";
import {
  explainCommand,
  learnCheck,
  learnList,
  learnStart,
  sandboxCreate,
} from "../src/learn-commands.js";
import { main } from "../src/main.js";
import type { Output } from "../src/commands.js";

const T = 180_000;
const NOW = new Date("2026-12-14T09:00:00Z");
const REPO = "forge/forge-metarepo";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
}

/** `--key value` flags (repeatable) and positionals, the way main.ts will parse them. */
function flags(args: string[]): { pos: string[]; f: Record<string, string[]> } {
  const pos: string[] = [];
  const f: Record<string, string[]> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const v = args[i + 1] !== undefined && !args[i + 1]!.startsWith("--") ? args[++i]! : "true";
      (f[a.slice(2)] ??= []).push(v);
    } else pos.push(a);
  }
  return { pos, f };
}

/**
 * Run a lesson command the way a learner types it. Commands this track adds (initiative,
 * defences, explain, learn) go to their functions, as main.ts will once they are wired; the
 * hand-off goes through one shared mock Git host on which the product owner approves (in a
 * sandbox with a manual Git host this is the step a person records with atticus todo done).
 */
async function atticus(root: string, argv: string[], io: Output, gh: MockGitHost): Promise<number> {
  const [a, b, ...rest] = argv;
  const { pos, f } = flags(rest);
  const one = (k: string) => f[k]?.[0];
  if (a === "initiative") {
    if (b === "new")
      return initiativeNew(
        root,
        {
          title: pos[0]!,
          journey: one("journey")!,
          by: one("by")!,
          ...(one("release") ? { release: one("release")! } : {}),
        },
        io,
      );
    if (b === "plan")
      return initiativePlan(
        root,
        pos[0],
        { ...(one("target") ? { target: one("target")! } : {}), by: one("by")! },
        io,
        { now: NOW },
      );
    if (b === "status") return initiativeStatus(root, pos[0], {}, io, { now: NOW });
    if (b === "request")
      return requestFromTeam(root, pos[0], pos[1], { by: one("by")! }, io, { now: NOW });
  }
  if (a === "defences" && b === "scan") return defencesScan(root, pos[0], {}, io);
  if (a === "explain") return explainCommand(root, [b, ...rest].join(" "), {}, io);
  if (a === "change" && b === "handoff") {
    const code = await changeHandoff(root, pos[0]!, { by: one("by")!, repo: REPO }, io, {
      gitHost: gh,
      now: "2026-12-14T10:00:00Z",
    });
    if (code === 0)
      gh.review(
        REPO,
        gh.journal.filter((j) => j.method === "createPullRequest").length,
        "pat",
        "approved",
      );
    return code;
  }
  if (a === "change" && b === "sync")
    return changeSync(root, pos[0]!, { by: one("by")!, repo: REPO }, io, {
      gitHost: gh,
      now: "2026-12-14T11:00:00Z",
    });
  return main([...argv, "--root", root], io);
}

async function writeSolution(root: string, files: { path: string; content: string }[]) {
  for (const f of files) {
    const p = join(root, ...f.path.split("/"));
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, f.content, "utf8");
  }
}

const sandbox = async () => {
  const c = capture();
  const dir = join(await mkdtemp(join(tmpdir(), "atticus-learn-cli-")), "sandbox");
  expect(await sandboxCreate(dir, { json: true }, c.io, { now: NOW })).toBe(0);
  return (JSON.parse(c.out.join("\n")) as { root: string }).root;
};

const lessons: Lesson[] = (await loadLessons()).lessons;

describe("atticus learn: every lesson, every check, against a fresh sandbox", () => {
  for (const lesson of lessons)
    it(
      `${lesson.role}: ${lesson.id}`,
      async () => {
        const root = await sandbox();
        const gh = new MockGitHost([{ repo: REPO }]);
        let c = capture();
        expect(await learnStart(root, lesson.role, {}, c.io, { now: NOW })).toBe(0);
        expect(c.out[0]).toContain(lesson.title);
        for (const step of lesson.steps) {
          // Before the work, the check fails (an answer step fails without an answer).
          c = capture();
          expect(
            await learnCheck(root, {}, c.io, { now: NOW }),
            `${lesson.id}/${step.id} passes before it is done`,
          ).toBe(1);
          expect(c.out[1]).toBe(`Hint: ${step.hint}`);
          await writeSolution(root, step.solution?.files ?? []);
          for (const argv of step.do) {
            const run = capture();
            const code = await atticus(root, argv, run.io, gh);
            expect([0, 1], `atticus ${argv.join(" ")}: ${run.err.join(" | ")}`).toContain(code);
          }
          c = capture();
          const code = await learnCheck(
            root,
            step.solution?.answer !== undefined ? { answer: step.solution.answer } : {},
            c.io,
            { now: NOW },
          );
          expect({ step: step.id, code, out: c.out[0] }).toEqual({
            step: step.id,
            code: 0,
            out: expect.stringMatching(/^Passed: /),
          });
        }
        c = capture();
        expect(await learnList(root, { json: true }, c.io)).toBe(0);
        const list = JSON.parse(c.out.join("\n")) as {
          sandbox: boolean;
          lessons: { id: string; state: string }[];
        };
        expect(list.sandbox).toBe(true);
        expect(list.lessons.find((l) => l.id === lesson.id)!.state).toBe("done");
      },
      T,
    );
});

describe("atticus learn, sandbox and explain", () => {
  it("lists lessons by role, and says lessons need a sandbox outside one", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-learn-real-"));
    const c = capture();
    expect(await learnList(root, {}, c.io)).toBe(0);
    expect(c.out[0]).toMatch(/^ROLE\s+LESSON\s+MINUTES\s+PROGRESS\s+TITLE$/);
    expect(c.out.at(-1)).toBe(
      "Lessons run in a practice sandbox: atticus sandbox create <dir>, then run atticus learn start <role> there.",
    );
    const s = capture();
    expect(await learnStart(root, "developer", {}, s.io)).toBe(1);
    expect(s.err[0]).toMatch(/isn't a practice sandbox/);
    const u = capture();
    expect(await learnStart(root, undefined, {}, u.io)).toBe(2);
    expect(await sandboxCreate(undefined, {}, u.io)).toBe(2);
  });

  it("explains a finding the critic wrote, in plain words", async () => {
    const root = await sandbox();
    const gh = new MockGitHost([{ repo: REPO }]);
    await atticus(root, ["scan"], capture().io, gh);
    await atticus(root, ["critic", "add-transfer-limit"], capture().io, gh);
    const c = capture();
    expect(await explainCommand(root, "interface-approved-pattern-interfaces-l6", {}, c.io)).toBe(
      0,
    );
    expect(c.out[0]).toBe(
      "interface-approved-pattern-interfaces-l6 is a critic finding on change add-transfer-limit at the plan gate (round 1).",
    );
    expect(c.out).toContain(
      "  It is blocking: it stops the hand-off until it is fixed or, where allowed, waived by the stage owner.",
    );
    expect(c.out.some((l) => l.includes("It is open.") && l.includes("it can't be waived"))).toBe(
      true,
    );
    const none = capture();
    expect(await explainCommand(root, "nothing-here", {}, none.io)).toBe(1);
    expect(await explainCommand(root, " ", {}, none.io)).toBe(2);
  });

  it("defences scan: reports hidden instructions in a document dropped into intake", async () => {
    const root = await sandbox();
    const platform = lessons.find((l) => l.id === "platform-lead-coverage-and-defences")!;
    await writeSolution(root, platform.steps[1]!.solution!.files);
    let c = capture();
    expect(await defencesScan(root, undefined, {}, c.io)).toBe(1);
    expect(c.out.find((l) => l.startsWith("high"))).toMatch(
      /^high\s+inputs\/inbox\/vendor-notes\.md\s+quarantined: left out of every AI step/,
    );
    expect(c.out.at(-1)).toMatch(/^Scanned \d+ files: 1 high, 0 medium\.$/);
    c = capture();
    expect(await defencesScan(root, "nowhere", {}, c.io)).toBe(2);
  });
});
