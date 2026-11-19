import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { MockGitHost } from "@maycombhq/adapters";
import { MockRuntime } from "@maycombhq/ai";
import {
  changeFolder,
  changeFootprint,
  changeStore,
  loadChangeContext,
  requireValid,
} from "@maycombhq/changes";
import { readChangeFiles } from "@maycombhq/naysayer";
import { EXPAND_AGENT, metarepoOpenSpec } from "@maycombhq/planner";
import { buildAndWrite } from "@maycombhq/scanner";
import { readChangeTasks } from "@maycombhq/speckit";
import { readyTasksOf } from "@maycombhq/taskrun";
import { changeHandoff, changeNew } from "../src/change-commands.js";
import { critic } from "../src/critic-commands.js";
import { main } from "../src/main.js";
import type { NextStep } from "../src/next-commands.js";
import { readyLines, taskRunReady } from "../src/run-ready-commands.js";
import { stageCli } from "../src/stage-commands.js";
import {
  ARCHETYPES,
  EMPTY_REPO,
  MIGRATION,
  MOVED,
  NEW_EVENT,
  NEW_PRODUCT,
  NEW_PUBLISHER,
  PORTAL_API,
  PORTAL_WEB,
  QUICK_PATH_HINT,
  section,
  SETTLE_FLOW,
  SETTLE_FLOW_YAML,
  STAGED_EVENT,
  STAGED_MIGRATION,
  STAGED_PRODUCT,
  TOPIC,
  UNREAD_REPO,
  type Archetype,
} from "./archetypes-changes.js";
import { makeFieldEstate, writeChangeFiles } from "./field-estate.js";

/**
 * ADR 0201 (2.0.0-beta.30, slice 1): the three kinds of change the stages refused or made hard at
 * beta.28.5, each on the quick path from a requirements file to ordered task runs, and each on
 * the staged path, on an estate in the field's shape (field-estate.ts: services and gateway
 * proxies read from facts, legacy services, open questions, links paired by hand, with a repo
 * whose clone is empty, a repo nobody read, and a topic). The changes are in
 * archetypes-changes.ts.
 *
 * Written before the code (CLAUDE.md, rule 2). No network: the model is a MockRuntime, the Git
 * host a MockGitHost, the hand-off's publisher a recorder. OpenSpec is the pinned one, run
 * locally. The estate is smaller than the field's forty repos so the file runs in CI's time.
 */

const NOW = "2026-11-18T09:00:00Z";
const T = 300_000;
const META = "forge/forge";

/** The field's shape at a size a test file can build: 6 services (1 legacy), 2 proxies. */
const SHAPE = {
  services: 6,
  gateways: 2,
  entries: 6,
  calls: 4,
  fieldNames: 60,
  legacy: 1,
  questions: 6,
  links: 2,
  suppressed: 2,
  emptyRepo: EMPTY_REPO,
  unreadRepo: UNREAD_REPO,
  topic: TOPIC,
};

interface Made {
  dir: string;
  root: string;
}
const made: Made[] = [];
async function estate(): Promise<Made> {
  const dir = await mkdtemp(join(tmpdir(), "atticus-archetypes-"));
  const e = await makeFieldEstate(dir, SHAPE);
  const built = await buildAndWrite(e.root, { command: "atticus catalog build" });
  expect(built.guard.refused).toBeUndefined();
  const m = { dir, root: e.root };
  made.push(m);
  return m;
}
afterAll(async () => {
  for (const m of made.splice(0)) await rm(m.dir, { recursive: true, force: true });
});

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
};

/** `atticus <args>` as a person types it. */
async function run(args: string[]) {
  const c = capture();
  const code = await main(args, c.io, { quiet: true });
  return { code, out: c.out, err: c.err };
}

/** A requirements file a person keeps outside the metarepo; `eol` as their editor saves it. */
async function requirementsFile(m: Made, name: string, text: string, eol = "\n") {
  const file = join(m.dir, "requirements", name, "requirements.md");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, eol === "\n" ? text : text.replace(/\n/g, eol), "utf8");
  return file;
}

/** The 1-based line of the first line of `text` that holds `needle`. */
const lineOf = (text: string, needle: string) => {
  const i = text.split("\n").findIndex((l) => l.includes(needle));
  if (i < 0) throw new Error(`no line holds ${needle}`);
  return i + 1;
};

// ADR 0201 part 2: the words of the check at the door.
const passes = (c: Archetype["counts"]) =>
  `passes: ${c.questions} questions (${c.answered} answered, ${c.accepted} accepted), ${c.inMap} ids in the map, ${c.planned} planned.`;
const openWords = (role: string, question: string) =>
  `${role} has an open question: "${question}". Answer it (State answered) or accept it (State accepted, with who and why), then run this again.`;
const unknownWords = (id: string) =>
  `the evidence names ${id}, which is not in the map and not listed under "## Planned". Name an id the map has (atticus query ${id}), or list it under Planned.`;
const unreadableWords = (role: string) => `this row of ${role}'s questions doesn't read: `;
// ADR 0201 part 4.
const unlistedWords = (task: string, repo: string) =>
  `Task ${task} is under ${repo}, which no repos.manifest.yaml lists. If the repo is new, create it on your Git host, then add it: atticus repo add <its clone URL> --id ${repo}. If the name is a slip, fix the heading in tasks.md.`;

/** The steps a quick change is never offered (ADR 0201 part 1), and the commands that run them. */
const STAGE_STEPS = ["brief", "feature", "architecture", "stories", "small", "draft"];
const STAGE_COMMAND = /atticus (change (feature|architecture|small|draft)|plan stories)\b/;

/** What `atticus next` offers for one change. */
async function nextFor(root: string, change: string): Promise<NextStep[]> {
  const r = await run(["next", "--json", "--root", root]);
  expect(r.code, r.err.join("\n")).toBe(0);
  const steps = (JSON.parse(r.out.join("\n")) as { steps: NextStep[] }).steps.filter(
    (s) => s.change === change,
  );
  for (const s of steps) {
    expect(STAGE_STEPS, `${change} is offered the ${s.step} step`).not.toContain(s.step);
    expect(s.command).not.toMatch(STAGE_COMMAND);
  }
  return steps;
}

/** A model that finds nothing wrong, and the agents that asked it. */
function calmCritic() {
  const asked: string[] = [];
  const runtime = new MockRuntime(
    (req) => {
      asked.push(req.agent.id);
      return "findings: []";
    },
    { now: () => new Date(NOW) },
  );
  return { runtime, asked };
}

const tasksOf = async (root: string, change: string) =>
  readChangeTasks(await readChangeFiles(changeFolder(root, change)));

/** Tick a task in tasks.md, as a person does when its PR is merged. */
async function tick(root: string, change: string, task: string) {
  const file = join(changeFolder(root, change), "tasks.md");
  const text = await readFile(file, "utf8");
  const ticked = text.replace(`- [ ] ${task} `, `- [x] ${task} `);
  expect(ticked, `tasks.md has no open task ${task}`).not.toBe(text);
  await writeFile(file, ticked, "utf8");
}

/** The ready plan as `atticus task run-ready` reads and says it, with no deployment plan. */
async function ready(root: string, change: string) {
  const plan = await readyTasksOf(root, change, { repoOrder: [] });
  return {
    plan,
    order: plan.tasks.map((t) => t.id),
    lines: readyLines(change, plan),
    of: (id: string) => plan.tasks.find((t) => t.id === id)!,
  };
}

// ===================================================================== the quick path

describe("the quick path: from a requirements file to ordered task runs (ADR 0201)", () => {
  let m: Made;
  beforeAll(async () => {
    m = await estate();
  }, 600_000);

  describe.each(ARCHETYPES.map((a) => [a.id, a] as const))("%s", (_id, a) => {
    // The migration's file is saved as a Windows editor saves it (CRLF); the others with LF.
    const eol = a === MIGRATION ? "\r\n" : "\n";
    // The new product takes its id from its title; the others are given one.
    const idArgs = a === NEW_PRODUCT ? [] : ["--id", a.id];
    let file: string;
    beforeAll(async () => {
      file = await requirementsFile(m, a.id, a.requirements, eol);
    });

    it(
      "the door check passes its requirements file and creates nothing (--check)",
      async () => {
        const r = await run(["change", "new", "--from", file, "--check", "--root", m.root]);
        expect(r.err).toEqual([]);
        expect(r.code).toBe(0);
        const said = r.out.find((l) => l.endsWith(passes(a.counts)));
        expect(said, r.out.join("\n")).toBeDefined();
        expect(said).toContain("requirements.md passes: ");
        expect(existsSync(changeFolder(m.root, a.id))).toBe(false);

        const j = await run([
          "change",
          "new",
          "--from",
          file,
          "--check",
          "--json",
          "--root",
          m.root,
        ]);
        expect(j.code).toBe(0);
        expect(JSON.parse(j.out.join("\n"))).toMatchObject({ ok: true, reasons: [] });
        expect(existsSync(changeFolder(m.root, a.id))).toBe(false);
      },
      T,
    );

    it(
      "--from creates the change: type quick, in plan, the file copied byte for byte, no brief",
      async () => {
        const r = await run([
          "change",
          "new",
          "--from",
          file,
          ...idArgs,
          "--by",
          "pat",
          "--root",
          m.root,
        ]);
        expect(r.err).toEqual([]);
        expect(r.code).toBe(0);
        const created = r.out.find((l) => l.startsWith(`Created ${a.id} (quick, from `));
        expect(created, r.out.join("\n")).toBeDefined();
        expect(created).toMatch(/requirements\.md\)\. It is in plan\.$/);
        // The ADR's addendum (the owner's decision): a separate spec writer writes the four files.
        expect(r.out).toContain(
          `Next: hand the cleared requirements to the spec writer: /define-change ${a.id}. Then a person runs atticus change handoff ${a.id} --approve.`,
        );
        // So --from makes the change with change.yaml and requirements.md only, and OpenSpec's own file.
        expect((await readdir(changeFolder(m.root, a.id))).sort()).toEqual(
          [".openspec.yaml", "change.yaml", "requirements.md"].sort(),
        );

        const dir = changeFolder(m.root, a.id);
        expect((await readFile(join(dir, "requirements.md"))).equals(await readFile(file))).toBe(
          true,
        );
        expect(existsSync(join(dir, "brief.md"))).toBe(false);
        const change = await changeStore(m.root).read(a.id);
        expect(change).toMatchObject({ id: a.id, title: a.title, type: "quick", state: "plan" });
      },
      T,
    );

    it(
      "next offers quick-define, naming the files that are missing, and never a stage",
      async () => {
        const first = (await nextFor(m.root, a.id)).find((s) => s.step === "quick-define");
        expect(first, "no quick-define step").toBeDefined();
        expect(first).toMatchObject({
          command: `atticus change status ${a.id}`,
          slash: `/define-change ${a.id}`,
        });
        for (const missing of ["proposal.md", "specs", "design.md", "tasks.md"])
          expect(first!.why).toContain(missing);

        // One file written: still quick-define, for the rest.
        await writeChangeFiles(m.root, a.id, { "proposal.md": a.files["proposal.md"]! });
        const second = (await nextFor(m.root, a.id)).find((s) => s.step === "quick-define");
        expect(second, "no quick-define step with only a proposal").toBeDefined();
        for (const missing of ["specs", "design.md", "tasks.md"])
          expect(second!.why).toContain(missing);
        expect((await nextFor(m.root, a.id)).some((s) => s.step === "handoff")).toBe(false);
      },
      T,
    );

    it(
      "its four files pass openspec validate --strict, and next offers the hand-off",
      async () => {
        await writeChangeFiles(m.root, a.id, a.files);
        expect(Object.keys(a.files).sort()).toEqual(
          ["design.md", "proposal.md", a.spec, "tasks.md"].sort(),
        );
        // The call the plan hand-off makes (packages/changes/src/handoff.ts).
        await requireValid(metarepoOpenSpec(m.root)!, a.id);

        const steps = await nextFor(m.root, a.id);
        expect(steps.some((s) => s.step === "quick-define")).toBe(false);
        expect(steps.find((s) => s.step === "handoff")).toMatchObject({
          command: `atticus change handoff ${a.id} --approve`,
          person: true,
        });
      },
      T,
    );

    it(
      "the critic runs every lens at the plan gate and nothing blocks",
      async () => {
        const { runtime, asked } = calmCritic();
        const c = capture();
        const code = await critic(m.root, a.id, { json: true }, c.io, { runtime, now: NOW });
        expect(c.err).toEqual([]);
        expect(code).toBe(0);
        const j = JSON.parse(c.out.join("\n")) as {
          gate: string;
          mayProceed: boolean;
          open: { blocking: number };
          lenses: { lens: string; state: string }[];
          findings: { severity: string; rule: string }[];
        };
        expect(j.gate).toBe("plan");
        expect(j.mayProceed).toBe(true);
        expect(j.open.blocking).toBe(0);
        expect(j.findings.filter((f) => f.severity === "blocking")).toEqual([]);
        expect(j.lenses.map((l) => [l.lens, l.state])).toEqual([
          ["true", "ran"],
          ["complete", "ran"],
          ["safe", "ran"],
          ["ship", "ran"],
        ]);
        expect(asked.sort()).toEqual([
          "complete-critic",
          "safe-critic",
          "ship-critic",
          "true-critic",
        ]);
        // Still the hand-off, and still no stage.
        expect((await nextFor(m.root, a.id)).map((s) => s.step)).toContain("handoff");
      },
      T,
    );

    it(
      "the critic sees the repos its tasks are under when a manifest lists them",
      async () => {
        const ctx = await loadChangeContext(m.root);
        const fp = await changeFootprint(ctx, await changeStore(m.root).read(a.id));
        // A manifest repo counts, read or not (ADR 0201 part 8, the footprint's task repos).
        const listed = a.repos.filter((r) => r !== PORTAL_API && r !== PORTAL_WEB);
        for (const repo of listed) expect(fp.repos).toContain(repo);
      },
      T,
    );

    it(
      "the plan hand-off's files include requirements.md",
      async () => {
        const published: string[][] = [];
        const c = capture();
        const code = await changeHandoff(
          m.root,
          a.id,
          { by: "pat", approve: true, repo: META },
          c.io,
          {
            gitHost: new MockGitHost([{ repo: META }]),
            now: NOW,
            publisher: {
              publish: async (i) => {
                published.push(i.files);
                return { commit: "abc1234" };
              },
            },
          },
        );
        expect(c.err).toEqual([]);
        expect(code).toBe(0);
        expect(c.out[0]).toMatch(
          new RegExp(`^Hand-off PR #1 \\(handoff/${a.id}/plan\\) is open: `),
        );
        expect(published).toHaveLength(1);
        const at = `openspec/changes/${a.id}`;
        expect(published[0]).toEqual(
          expect.arrayContaining([
            `${at}/requirements.md`,
            `${at}/proposal.md`,
            `${at}/${a.spec}`,
            `${at}/design.md`,
            `${at}/tasks.md`,
            `${at}/change.yaml`,
          ]),
        );
        // Raised: a person merges it. Still never a stage.
        expect((await nextFor(m.root, a.id)).map((s) => s.step)).not.toContain("quick-define");
      },
      T,
    );
  });

  // ------------------------------------------------------------------ waves (ADR 0201 part 3)

  it(
    "new product: the pages wait for the service's task they name; (after …) is not in a title",
    async () => {
      const id = NEW_PRODUCT.id;
      const tasks = await tasksOf(m.root, id);
      expect(tasks.map((t) => [t.id, t.repo])).toEqual([
        ["1.1", PORTAL_API],
        ["1.2", PORTAL_API],
        ["2.1", PORTAL_WEB],
      ]);
      const last = tasks[2] as (typeof tasks)[number] & { after?: string[] };
      expect(last.after).toEqual(["1.2"]);
      expect(last.title).toBe("List the manager's open requests and record a decision");

      let r = await ready(m.root, id);
      expect(r.plan.ready).toEqual(["1.1"]);
      expect(r.lines).toEqual([
        `Ready to run, in cross-repo order: 1.1 (${PORTAL_API}).`,
        "  Not ready: task 1.2: it waits for task 1.1 (same repo) to be done first.",
        "  Not ready: task 2.1: it waits for task 1.2 (after) to be done first.",
      ]);
      await tick(m.root, id, "1.1");
      r = await ready(m.root, id);
      expect(r.plan.ready).toEqual(["1.2"]);
      expect(r.of("2.1")).toMatchObject({ ready: false, waitsFor: ["1.2"] });
      await tick(m.root, id, "1.2");
      r = await ready(m.root, id);
      expect(r.plan.ready).toEqual(["2.1"]);
    },
    T,
  );

  it(
    "migration: the second wave is held until every task of the first is ticked",
    async () => {
      const id = MIGRATION.id;
      const tasks = (await tasksOf(m.root, id)) as (Awaited<ReturnType<typeof tasksOf>>[number] & {
        after?: string[];
      })[];
      expect(tasks.map((t) => [t.id, t.repo, t.after ?? []])).toEqual([
        ["m1", MOVED[0], []],
        ["m2", MOVED[1], []],
        ["m3", MOVED[2], ["m1", "m2"]],
        ["m4", EMPTY_REPO, ["m3"]],
      ]);
      expect(tasks[2]!.title).toBe("Add the Anvil deployment descriptor and drop the host scripts");

      // Wave 1 is ready; wave 2 waits for both of its tasks, and the routing for wave 2.
      let r = await ready(m.root, id);
      expect(r.order).toEqual(["m1", "m2", "m3", "m4"]);
      expect(r.plan.ready).toEqual(["m1", "m2"]);
      expect(r.lines[0]).toBe(
        `Ready to run, in cross-repo order: m1 (${MOVED[0]}), m2 (${MOVED[1]}).`,
      );
      expect(r.of("m3")).toMatchObject({ ready: false, waitsFor: ["m1", "m2"] });
      expect(r.of("m3").why).toContain("(after)");
      expect(r.of("m4")).toMatchObject({ ready: false, waitsFor: ["m3"] });
      expect(r.lines).toContain(
        "  Not ready: task m4: it waits for task m3 (after) to be done first.",
      );

      // Half of wave 1 done: wave 2 is still held, for the other half.
      await tick(m.root, id, "m1");
      r = await ready(m.root, id);
      expect(r.plan.ready).toEqual(["m2"]);
      expect(r.of("m3")).toMatchObject({ ready: false, waitsFor: ["m2"] });
      expect(r.lines).toContain(
        "  Not ready: task m3: it waits for task m2 (after) to be done first.",
      );

      // Wave 1 done: wave 2 runs, and the routing after it.
      await tick(m.root, id, "m2");
      r = await ready(m.root, id);
      expect(r.plan.ready).toEqual(["m3"]);
      expect(r.of("m4")).toMatchObject({ ready: false, waitsFor: ["m3"] });
      await tick(m.root, id, "m3");
      r = await ready(m.root, id);
      expect(r.plan.ready).toEqual(["m4"]);
    },
    T,
  );

  it(
    "new event: the publisher's task comes after the listener's it names, whatever tasks.md's order",
    async () => {
      const id = NEW_EVENT.id;
      // tasks.md writes the publisher's repo first.
      expect((await tasksOf(m.root, id)).map((t) => [t.id, t.repo])).toEqual([
        ["e2", NEW_PUBLISHER],
        ["e1", UNREAD_REPO],
      ]);
      let r = await ready(m.root, id);
      expect(r.order).toEqual(["e1", "e2"]);
      expect(r.plan.ready).toEqual(["e1"]);
      expect(r.lines).toEqual([
        `Ready to run, in cross-repo order: e1 (${UNREAD_REPO}).`,
        "  Not ready: task e2: it waits for task e1 (after) to be done first.",
      ]);
      await tick(m.root, id, "e1");
      r = await ready(m.root, id);
      expect(r.plan.ready).toEqual(["e2"]);
    },
    T,
  );

  it(
    "an (after …) that names no task, and two tasks that name each other, are never ready",
    async () => {
      const id = "wave-slips";
      const c = capture();
      expect(
        await changeNew(m.root, { title: "Wave slips", type: "quick", by: "pat", id }, c.io, {
          now: NOW,
        }),
        c.err.join("\n"),
      ).toBe(0);
      await writeChangeFiles(m.root, id, {
        "tasks.md": [
          `## ${MOVED[0]}`,
          "",
          "- [ ] t1 Add the descriptor",
          "",
          `## ${MOVED[1]}`,
          "",
          "- [ ] t3 Add the descriptor (after t9)",
          "",
          `## ${MOVED[2]}`,
          "",
          "- [ ] t4 Add the descriptor (after t5)",
          "",
          `## ${EMPTY_REPO}`,
          "",
          "- [ ] t5 Route the traffic (after t4)",
          "",
        ].join("\n"),
      });
      const r = await ready(m.root, id);
      expect(r.plan.ready).toEqual(["t1"]);
      expect(r.lines).toEqual(
        expect.arrayContaining([
          `Ready to run, in cross-repo order: t1 (${MOVED[0]}).`,
          "  Not ready: task t3: it names task t9 in (after …), which tasks.md doesn't have.",
          "  Not ready: task t4: it and task t5 each wait for the other in (after …).",
        ]),
      );
      expect(r.of("t5").ready).toBe(false);
    },
    T,
  );

  // -------------------------------------------- a repo no manifest lists (ADR 0201 part 4)

  it(
    "a task under a repo no manifest lists is refused with how to add the repo",
    async () => {
      const id = NEW_PRODUCT.id;
      // The pages' task, ready now that the service's are ticked above.
      const one = await run([
        "task",
        "run",
        id,
        "2.1",
        "--dry-run",
        "--by",
        "pat",
        "--root",
        m.root,
      ]);
      expect(one.code).toBe(1);
      expect(one.err).toEqual([unlistedWords("2.1", PORTAL_WEB)]);

      // And in a run of everything that is ready, which does nothing else.
      const c = capture();
      const code = await taskRunReady(m.root, id, { by: "pat", dryRun: true }, c.io, {
        repoOrder: [],
        now: () => new Date(NOW),
      });
      expect(code).toBe(0);
      expect(c.out).toContain(`Task 2.1: ${unlistedWords("2.1", PORTAL_WEB)}`);
    },
    T,
  );

  // ------------------------------------------------- the door refuses (ADR 0201 part 2)

  describe("the door check refuses", () => {
    const base = NEW_EVENT.requirements;
    const QUESTION = "Who receives the topic today, and do they expect a refund on it?";
    /** `atticus change new --from`, with and without --check and as JSON: each refuses alike. */
    async function refused(name: string, text: string, problems: number) {
      const file = await requirementsFile(m, name, text);
      const id = `refused-${name}`;
      const args = ["change", "new", "--from", file, "--id", id, "--by", "pat", "--root", m.root];
      const created = await run(args);
      const checked = await run([...args, "--check"]);
      for (const r of [created, checked]) {
        expect(r.code).toBe(1);
        expect(r.err[0]).toMatch(
          new RegExp(`^Refused: ${problems} problems? in .*requirements\\.md\\.$`),
        );
        expect(r.err).toHaveLength(problems + 1);
      }
      const j = await run([...args, "--check", "--json"]);
      expect(j.code).toBe(1);
      const json = JSON.parse(j.out.join("\n")) as {
        ok: boolean;
        reasons: { code: string; line: number; role: string; message: string }[];
      };
      expect(json.ok).toBe(false);
      expect(json.reasons).toHaveLength(problems);
      // Nothing was made, by any of the three.
      expect(existsSync(changeFolder(m.root, id))).toBe(false);
      return { lines: created.err.slice(1), reasons: json.reasons };
    }
    /** The line that says one problem: it starts with its reason and names the file's line. */
    const said = (lines: string[], code: string, line: number, words: string) => {
      const l = lines.find((x) => x.includes(`requirements.md:${line}: `));
      expect(l, `no line for requirements.md:${line} in:\n${lines.join("\n")}`).toBeDefined();
      expect(l!.startsWith(code)).toBe(true);
      expect(l).toContain(`requirements.md:${line}: ${words}`);
    };

    it(
      "an open row: requirements.open-question, with its role, question and line",
      async () => {
        const at = lineOf(base, QUESTION);
        const text = base
          .split("\n")
          .map((l, i) => (i === at - 1 ? l.replace(/\| answered \|$/, "| open |") : l))
          .join("\n");
        expect(text).not.toBe(base);
        const r = await refused("open", text, 1);
        said(
          r.lines,
          "requirements.open-question",
          at,
          openWords("Application architect", QUESTION),
        );
        expect(r.reasons).toEqual([
          {
            code: "requirements.open-question",
            line: at,
            role: "Application architect",
            message: expect.stringContaining(openWords("Application architect", QUESTION)),
          },
        ]);
      },
      T,
    );

    it(
      "an evidence id neither in the map nor planned: requirements.unknown-id; planned, it passes",
      async () => {
        const text = base.replace(
          `\`${NEW_PUBLISHER}\` |`,
          `\`${NEW_PUBLISHER}\`; \`forge-ghost\` |`,
        );
        expect(text).not.toBe(base);
        const at = lineOf(text, "forge-ghost");
        const r = await refused("unknown", text, 1);
        said(r.lines, "requirements.unknown-id", at, unknownWords("forge-ghost"));
        expect(r.reasons).toEqual([
          {
            code: "requirements.unknown-id",
            line: at,
            role: "Developer",
            message: expect.stringContaining(unknownWords("forge-ghost")),
          },
        ]);

        // Listed under Planned, the same row passes, and the id is counted as planned.
        const planned = text.replace(
          "\n## Application architect\n",
          "\n## Planned\n\n- `forge-ghost`: a service this change plans\n\n## Application architect\n",
        );
        const file = await requirementsFile(m, "planned", planned);
        const ok = await run(["change", "new", "--from", file, "--check", "--root", m.root]);
        expect(ok.err).toEqual([]);
        expect(ok.code).toBe(0);
        expect(ok.out.some((l) => l.endsWith(passes({ ...NEW_EVENT.counts, planned: 1 })))).toBe(
          true,
        );
      },
      T,
    );

    it(
      "rows that don't read: requirements.unreadable, each with its line",
      async () => {
        const rows = {
          five: "| Which listener is slowest? | - | qa-naysayer | quinn | answered |",
          state: "| Is the topic kept for a week? | - | qa-naysayer | quinn | Yes | done |",
          unnamed: "| Who replays a lost event? | - | qa-naysayer |  | The publisher | answered |",
          nobody:
            "| Is an order of events kept? | - | qa-naysayer |  | Not needed yet | accepted |",
        };
        const text = [
          base.trimEnd(),
          rows.five,
          rows.state,
          rows.unnamed,
          rows.nobody,
          "",
          "## Notes",
          "",
          "| A table | of another shape | is free text |",
          "| --- | --- | --- |",
          "| and | is | not read |",
          "",
        ].join("\n");
        const r = await refused("unreadable", text, 4);
        for (const row of Object.values(rows))
          said(r.lines, "requirements.unreadable", lineOf(text, row), unreadableWords("QA"));
        expect(r.reasons.map((x) => [x.code, x.line, x.role]).sort()).toEqual(
          Object.values(rows)
            .map((row) => ["requirements.unreadable", lineOf(text, row), "QA"])
            .sort(),
        );
      },
      T,
    );

    it(
      "every problem of a file is said at once, each with its own reason",
      async () => {
        const text = [
          "# Three slips",
          "",
          section("Developer", "One row of each kind.", [
            ["Is the retry safe?", "-", "developer-naysayer", "dev", "", "open"],
            [
              "Who else writes the row?",
              "`forge-ghost`",
              "developer-naysayer",
              "dev",
              "Nobody",
              "answered",
            ],
          ]).trimEnd(),
          "| Is it logged? | - | developer-naysayer | dev | answered |",
          "",
        ].join("\n");
        const r = await refused("three", text, 3);
        expect(r.reasons.map((x) => [x.code, x.line]).sort()).toEqual(
          [
            ["requirements.open-question", lineOf(text, "Is the retry safe?")],
            ["requirements.unknown-id", lineOf(text, "forge-ghost")],
            ["requirements.unreadable", lineOf(text, "Is it logged?")],
          ].sort(),
        );
      },
      T,
    );

    it(
      "a file no persona asked a question in passes, and says so",
      async () => {
        const file = await requirementsFile(
          m,
          "no-roles",
          "# A plain note\n\nWhat is wanted and why.\n\n## Background\n\nFree text under a heading with no table.\n",
        );
        const r = await run(["change", "new", "--from", file, "--check", "--root", m.root]);
        expect(r.err).toEqual([]);
        expect(r.code).toBe(0);
        expect(
          r.out.some((l) => /^No persona asked a question in .*requirements\.md\.$/.test(l)),
          r.out.join("\n"),
        ).toBe(true);
      },
      T,
    );
  });
});

// ===================================================================== the staged path

describe("the staged path on the same three changes (ADR 0201 part 8)", () => {
  let m: Made;
  beforeAll(async () => {
    m = await estate();
    // The publisher's flow, as its spec has it.
    const dir = join(m.root, "specs", SETTLE_FLOW.repo);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${SETTLE_FLOW.id}.yaml`), SETTLE_FLOW_YAML, "utf8");
  }, 600_000);

  /** A change of `type` with its brief written. */
  async function change(o: { id: string; title: string; brief: string }, type: string) {
    const c = capture();
    expect(
      await changeNew(m.root, { title: o.title, type, by: "pat", id: o.id }, c.io, { now: NOW }),
      c.err.join("\n"),
    ).toBe(0);
    await writeChangeFiles(m.root, o.id, { "brief.md": o.brief });
  }

  /** An assistant that gives `answer` to the stage's own agent, and who was asked. */
  function assistant(answer: string) {
    const drafts: string[] = [];
    const runtime = new MockRuntime(
      (req) => {
        if (req.agent.id.endsWith("-critic")) return "findings: []";
        if (req.agent.id === EXPAND_AGENT) return "terms: [settled refund]\nnames: []\n";
        drafts.push(req.agent.id);
        return answer;
      },
      { now: () => new Date(NOW) },
    );
    return { runtime, drafts };
  }

  interface StageJson {
    state: string;
    findings: { rule: string; blocking: boolean; message: string }[];
    questions: unknown[];
  }
  async function stage(args: string[], answer: string) {
    const a = assistant(answer);
    const c = capture();
    const code = await stageCli(m.root, args, { json: true }, c.io, {
      runtime: a.runtime,
      now: new Date(NOW),
    });
    expect(c.err).toEqual([]);
    return { code, result: JSON.parse(c.out.join("\n")) as StageJson };
  }

  const noteWords = `is in the manifest and hasn't been read, so its use can't be checked: atticus map ${UNREAD_REPO}`;

  it(
    "new event: feature, architecture and stories each end done; the consumer nobody read is a note",
    async () => {
      const e = STAGED_EVENT;
      await change(e, "feature");

      const feature = await stage(["change", "feature", e.id], e.feature);
      expect(feature.result.state).toBe("done");
      expect(feature.code).toBe(0);

      const architecture = await stage(["change", "architecture", e.id], e.architecture);
      expect(architecture.result.findings.filter((f) => f.blocking).map((f) => f.message)).toEqual(
        [],
      );
      expect(architecture.result.state).toBe("done");
      expect(architecture.code).toBe(0);
      const delta = architecture.result.findings.filter((f) => f.rule === "delta.unknown-consumer");
      expect(delta).toHaveLength(1);
      expect(delta[0]).toMatchObject({ blocking: false });
      expect(delta[0]!.message).toContain(UNREAD_REPO);
      expect(delta[0]!.message).toContain(noteWords);

      const stories = await stage(["plan", "stories", e.id], e.stories);
      expect(stories.result.findings.filter((f) => f.blocking).map((f) => f.message)).toEqual([]);
      expect(stories.result.state).toBe("done");
      expect(stories.code).toBe(0);
      const story = stories.result.findings.filter((f) => f.rule === "stories.unknown-consumer");
      expect(story).toHaveLength(1);
      expect(story[0]).toMatchObject({ blocking: false });
      expect(story[0]!.message).toContain(noteWords);

      // To the end: the stories' tasks are written, under the publisher's repo.
      expect((await tasksOf(m.root, e.id)).map((t) => t.repo)).toEqual([NEW_PUBLISHER]);
    },
    T,
  );

  /** Every file under the questions folder: a question raised adds one. */
  const questionFiles = async () =>
    (await readdir(join(m.root, "questions"), { recursive: true })).length;

  /** The stage's loop state, as it keeps it in the change's folder. */
  const loopOf = async (id: string, stageName: string) =>
    parse(await readFile(join(changeFolder(m.root, id), "stage", `${stageName}.yaml`), "utf8")) as {
      state: string;
    };

  /** A stage run once, in words, that is expected to stop on its first draft with the hint. */
  async function refusesOnce(args: string[], answer: string) {
    const before = await questionFiles();
    const a = assistant(answer);
    const c = capture();
    const code = await stageCli(m.root, args, {}, c.io, { runtime: a.runtime, now: new Date(NOW) });
    const said = [...c.out, ...c.err].join("\n");
    expect(code).toBe(1);
    // One draft was asked for, and no question was raised.
    expect(a.drafts).toHaveLength(1);
    expect(await questionFiles()).toBe(before);
    expect(said).toContain(QUICK_PATH_HINT);
    expect(said).toContain("atticus change new --from <requirements.md>");
    return said;
  }

  it(
    "new product: the feature stage stops on its first draft and names the quick path",
    async () => {
      const p = STAGED_PRODUCT;
      await change(p, "feature");
      const said = await refusesOnce(["change", "feature", p.id], p.feature);
      expect(said).toContain("The feature touches nothing");
      expect((await loopOf(p.id, "feature")).state).toBe("stopped");

      // Planning its stories anyway is refused with the same hint ("has nothing to plan").
      const plan = await run(["plan", "stories", p.id, "--draft", "--root", m.root]);
      expect(plan.code).toBe(1);
      expect(plan.err.join("\n")).toContain(`${p.id} has nothing to plan`);
      expect(plan.err.join("\n")).toContain(QUICK_PATH_HINT);
    },
    T,
  );

  it(
    "migration: the one-step stage stops on its first draft and names the quick path",
    async () => {
      const g = STAGED_MIGRATION;
      await change(g, "small-change");
      const said = await refusesOnce(["change", "small", g.id], g.small);
      expect(said).toContain("The answer changes no step of any flow");
      expect((await loopOf(g.id, "small")).state).toBe("stopped");
    },
    T,
  );
});
