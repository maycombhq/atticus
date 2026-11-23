import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { MockGitHost } from "@maycombhq/adapters";
import { MockRuntime, type AiRequest } from "@maycombhq/ai";
import {
  changeFolder,
  changeFootprint,
  changeReport,
  changeStore,
  loadChangeContext,
  requireValid,
} from "@maycombhq/changes";
import { gateStatus, readChangeFiles } from "@maycombhq/naysayer";
import { checkStageDraft, EXPAND_AGENT, metarepoOpenSpec } from "@maycombhq/planner";
import { buildAndWrite, readFactsSlot } from "@maycombhq/scanner";
import { readChangeTasks } from "@maycombhq/speckit";
import { conformChange, readyTasksOf } from "@maycombhq/taskrun";
import type { GitRunner } from "@maycombhq/workspace";
import type { Api, Fact } from "@maycombhq/core";
import { bigRepoId } from "./big-estate.js";
import { changeHandoff, changeNew } from "../src/change-commands.js";
import { critic } from "../src/critic-commands.js";
import { main } from "../src/main.js";
import type { NextStep } from "../src/next-commands.js";
import { readyLines, taskRunReady } from "../src/run-ready-commands.js";
import { handoffReview } from "../src/handoff-review.js";
import { reviewCommand } from "../src/review-commands.js";
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
  OUTSIDE_PARTY,
  STAGED_EVENT,
  STAGED_MIGRATION,
  STAGED_MIXED,
  STAGED_NEW_TOPIC,
  NEW_TOPIC,
  LISTENER_FLOW,
  given,
  STAGED_NO_STEP,
  STAGED_NOTHING,
  STAGED_PRODUCT,
  TOPIC,
  UNREAD_REPO,
  type Archetype,
  withoutCodeTable,
} from "./archetypes-changes.js";
import { FIELD_TOPIC_LISTENER, makeFieldEstate, writeChangeFiles } from "./field-estate.js";

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
/** ADR 0203 A: a consumer nothing knows: no record, no manifest, not planned, not declared outside. */
const GHOST = "forge-ghost";
/** A repo and a component nothing knows either, for an operation and a call (ADR 0203 A). */
const GHOST_SVC = "forge-ghost-svc";
const EVIL_SVC = "forge-evil-svc";
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
  // ADR 0206: the moved services' prod deployments on their hosts, read from facts.
  deployments: [0, 1, 4],
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

// ADR 0203 C: the starter application architect's naysayer, as an org pack copies it.
const NAYSAYER = "application-architect-naysayer";
const STARTER_NAYSAYER = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../assistant-files/starter/agents",
  `${NAYSAYER}.md`,
);

/** The naysayer's answer: one question, quoting `quoted` of the file it reviews. */
const naysayerAnswer =
  (quoted: string, artifact = "requirements.md") =>
  (req: AiRequest): string => {
    let line = 1;
    for (const m of req.pack.prompt.matchAll(/^(\d+): (.*)$/gm))
      if (m[2]!.trimEnd() === quoted) {
        line = Number(m[1]);
        break;
      }
    return [
      "findings:",
      `  - rule: persona.${NAYSAYER}`,
      "    kind: issue",
      `    artifact: ${artifact}`,
      `    locator: { line: ${line} }`,
      "    summary: Nothing says who runs it at night.",
      "    why: Someone is paged when it fails.",
      "    fix: Name who runs it.",
      "    evidence:",
      `      - { path: ${artifact}, line: ${line}, quote: ${JSON.stringify(quoted)} }`,
      "",
    ].join("\n");
  };

/** A model in which only the naysayer finds something. */
const naysayerModel = (quoted: string) =>
  new MockRuntime(
    (req) => (req.agent.id === NAYSAYER ? naysayerAnswer(quoted)(req) : "findings: []"),
    { now: () => new Date(NOW) },
  );

/** A model that finds nothing wrong, and the agents that asked it. */
function calmCritic() {
  const asked: string[] = [];
  /** What each lens was sent, by its agent. */
  const prompts = new Map<string, string>();
  const runtime = new MockRuntime(
    (req) => {
      asked.push(req.agent.id);
      prompts.set(req.agent.id, req.pack.prompt);
      return "findings: []";
    },
    { now: () => new Date(NOW) },
  );
  return { runtime, asked, prompts };
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
      "atticus review says what the door would, the map's standing and the naysayer's questions, exits 0, and --write adds rows once (ADR 0203 C.4)",
      async () => {
        // A copy, so the door check above and --from below read the file as it was written.
        const copy = await requirementsFile(m, `${a.id}-review`, a.requirements, eol);
        const plain = await run(["review", copy, "--no-ai", "--root", m.root]);
        expect(plain.err).toEqual([]);
        expect(plain.code).toBe(0);
        for (const l of plain.out.filter((x) => x.startsWith(copy)))
          expect(l).toMatch(/requirements\.md:\d+: atticus: .+ \[.+\]$/);
        if (a === NEW_EVENT)
          expect(plain.out).toContain(
            `${copy}:${lineOf(a.requirements, `\`${UNREAD_REPO}\``)}: atticus: ${UNREAD_REPO} is in the manifest, not read: atticus map ${UNREAD_REPO} [${UNREAD_REPO}]`,
          );

        // The application architect's naysayer, as the org pack keeps it: no gates needed here.
        const agents = join(m.root, "org-pack", "agents");
        await mkdir(agents, { recursive: true });
        const persona = join(agents, `${NAYSAYER}.md`);
        await writeFile(persona, await readFile(STARTER_NAYSAYER, "utf8"));
        try {
          const before = await readFile(copy, "utf8");
          const quoted =
            a.requirements.split("\n")[lineOf(a.requirements, "## Application architect") + 1]!;
          const says = async (write: boolean) => {
            const c = capture();
            const code = await reviewCommand(m.root, copy, { write }, c.io, {
              runtime: naysayerModel(quoted),
              now: new Date(NOW),
            });
            expect(c.err).toEqual([]);
            expect(code).toBe(0);
            return c.out;
          };
          const once = await says(true);
          expect(once).toContain(
            `${copy}:${lineOf(a.requirements, quoted)}: ${NAYSAYER}: Nothing says who runs it at night. [requirements.md:${lineOf(a.requirements, quoted)}]`,
          );
          expect(once.at(-1)).toMatch(new RegExp(`^Added \\d+ rows? to `));
          const after = await readFile(copy, "utf8");
          // Only rows were added, under the role's table, with the file's line endings.
          const kept = before.split(eol);
          const now = after.split(eol);
          expect(
            now.filter((l) => !kept.includes(l)).every((l) => l.endsWith(" | - | - | open |")),
          ).toBe(true);
          expect(now.filter((l) => kept.includes(l))).toEqual(kept);
          if (eol === "\r\n") expect(/[^\r]\n/.test(after)).toBe(false);
          // A second --write adds nothing.
          expect((await says(true)).at(-1)).toBe(`${copy} has every row already.`);
          expect(await readFile(copy, "utf8")).toBe(after);
          // And the door now refuses for the open rows.
          const door = await run(["change", "new", "--from", copy, "--check", "--root", m.root]);
          expect(door.code).toBe(1);
          expect(door.err.join("\n")).toContain(
            openWords("Application architect", "Nothing says who runs it at night."),
          );
        } finally {
          await rm(persona, { force: true });
        }
      },
      T,
    );

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
      "without design.md's In the code, next asks for it and the plan hand-off is refused with what to fix (ADR 0206)",
      async () => {
        await writeChangeFiles(m.root, a.id, {
          ...a.files,
          "design.md": withoutCodeTable(a.files["design.md"]!),
        });
        const step = (await nextFor(m.root, a.id)).find((s) => s.step === "quick-define");
        expect(step, "no quick-define step without the table").toBeDefined();
        expect(step!.why).toContain("design.md's ## In the code");
        const status = await run(["change", "status", a.id, "--root", m.root]);
        expect(status.out).toContain(
          "  - design.md doesn't say what the code will have: add ## In the code with the columns Repo, Task, Has, What, Spec, a row for each thing a repo's code or deployment will have. A repo whose work no scan can see gets a row with Has other.",
        );
        const h = await run(["change", "handoff", a.id, "--root", m.root]);
        expect(h.code).not.toBe(0);
        expect([...h.out, ...h.err].join("\n")).toContain(
          "design.md doesn't say what the code will have",
        );
      },
      T,
    );

    it(
      "its four files pass openspec validate --strict, and next offers the hand-off",
      async () => {
        await writeChangeFiles(m.root, a.id, a.files);
        // ADR 0206: its In the code reads, and nothing is refused for it.
        const status = await run(["change", "status", a.id, "--json", "--root", m.root]);
        const said = JSON.parse(status.out.join("\n")) as {
          reasons: { code: string; message: string }[];
          notes?: string[];
        };
        expect(said.reasons.filter((r) => r.code === "design.code-table")).toEqual([]);
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
        const { runtime, asked, prompts } = calmCritic();
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
        // The real-model run: the true lens got design.md alone and an empty catalog slice, so it
        // had nothing to hold the change against. A quick change's lenses read all of its files,
        // the requirements it was made from, and the records they name.
        const sent = prompts.get("true-critic")!;
        const dataIds = [...sent.matchAll(/<atticus-data id="([^"]+)"/g)].map((x) => x[1]!);
        expect(dataIds).toEqual(
          expect.arrayContaining(["proposal.md", "design.md", "tasks.md", "requirements.md"]),
        );
        expect(dataIds.some((id) => /^specs\/.+\/spec\.md$/.test(id))).toBe(true);
        const slice = /<atticus-data id="catalog-slice"[^>]*>\n([\s\S]*?)\n<\/atticus-data>/.exec(
          sent,
        )![1]!;
        expect(slice.trim()).not.toBe("[]");
        // Each catalog record the requirements cite as evidence is in the slice.
        const records = new Set(
          (await loadChangeContext(m.root)).records.map((r: { id: string }) => r.id),
        );
        const cited = [...a.requirements.matchAll(/`([a-z0-9][a-z0-9._-]*)`/g)]
          .map((x) => x[1]!)
          .filter((id) => records.has(id));
        expect(cited.length).toBeGreaterThan(0);
        for (const id of cited) expect(slice, id).toContain(`id: ${id}`);
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
        // v31 (WP-05): first the knowledge the change leads to, written to knowledge.yaml.
        expect(c.out[0]).toMatch(/^Knowledge: /);
        expect(c.out[1]).toMatch(
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
            `${at}/knowledge.yaml`,
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

  // ADR 0206: the quick changes' rows read by the map, impact and estimate, and checked against
  // the code after the build. The scan of a branch is the estate's facts with what the branch
  // adds, given through `scanAt`; git answers the branch and its base. The metarepo is real.
  const SNAP = (root: string, repo: string) =>
    readFactsSlot(root, repo).then((s) => (s?.ok ? s.facts : []));
  const gitAt =
    (commit: string, base: string): GitRunner =>
    async (args) => ({
      stdout: args[0] === "merge-base" ? base : args[0] === "rev-parse" ? commit : "",
      stderr: "",
    });
  const fact = (repo: string, f: Record<string, unknown>) =>
    ({
      repo,
      commit: "b".repeat(40),
      verified: "line",
      by: "assistant",
      conf: "declared",
      ...f,
    }) as unknown as Fact;

  it(
    "the new product's map, impact and estimate are read from its In the code, and its rows are checked on a branch (ADR 0206)",
    async () => {
      const a = NEW_PRODUCT;
      const map = await run(["change", "map", a.id, "--json", "--root", m.root]);
      const drawn = JSON.parse(map.out.join("\n")) as Api.ChangeMapT;
      expect(drawn).toMatchObject({ from: "design", rows: 4 });
      for (const r of [PORTAL_API, PORTAL_WEB])
        expect(drawn.nodes.find((n) => n.id === r)?.legend).toBe("new");
      const impact = JSON.parse(
        (await run(["change", "impact", a.id, "--json", "--root", m.root])).out.join("\n"),
      ) as Api.ChangeImpactT;
      expect(impact.breaks).toBe(0);
      expect(
        impact.reaches?.find((x) => x.has === "calls" && x.name.startsWith(bigRepoId(0)))?.ids,
      ).toEqual([bigRepoId(0)]);
      const est = JSON.parse(
        (await run(["change", "estimate", a.id, "--json", "--root", m.root])).out.join("\n"),
      ) as Api.ChangeEstimateT;
      expect(est.units.map((u) => [u.repo, u.class])).toEqual([
        [PORTAL_API, "quick/table/new-table"],
        [PORTAL_API, "quick/serves"],
        [PORTAL_API, "quick/calls"],
        [PORTAL_WEB, "quick/calls/new-entry"],
      ]);

      // The service's branch has its table and entry; the pages' repo isn't made yet.
      await mkdir(join(m.root, "workspace", PORTAL_API), { recursive: true });
      const r = await conformChange(m.root, a.id, {
        git: gitAt("c".repeat(40), "a".repeat(40)),
        now: NOW,
        scanAt: async (repo, commit) => ({
          records: [],
          files: [],
          problems: [],
          basis: { from: "facts", unread: [] },
          facts:
            commit === "a".repeat(40)
              ? []
              : [
                  fact(repo, {
                    kind: "store",
                    id: "s-0",
                    store: "approvals",
                    name: "approval_requests",
                    op: "write",
                    columns: ["id"],
                    cite: { file: "db/V1__approvals.sql", line: 1, value: "approval_requests" },
                  }),
                  fact(repo, {
                    kind: "entry",
                    id: "e-0",
                    entryType: "rest",
                    method: "POST",
                    path: "/v1/approvals/{id}/decision",
                    cite: {
                      file: "src/Approvals.java",
                      line: 9,
                      value: "/v1/approvals/{id}/decision",
                    },
                  }),
                ],
        }),
      });
      const api = r.results.find((x) => x.repo === PORTAL_API)!;
      expect(api.claims!.map((c) => [c.check, c.outcome])).toEqual([
        ["table", "present"],
        ["endpoint", "present"],
        ["call", "missing"],
      ]);
      const web = r.results.find((x) => x.repo === PORTAL_WEB)!;
      expect(web.claims!.map((c) => c.outcome)).toEqual(["unconfirmed"]);
      // The persona check of beta.30: a repo no manifest lists is added first, never read first.
      expect(web.claims![0]!.next).toBe(
        `Add ${PORTAL_WEB} to the estate first: create it on your Git host if it is new, then atticus repo add <its clone URL> --id ${PORTAL_WEB}. Then read it into facts (/atticus-map ${PORTAL_WEB}, then atticus verify ${PORTAL_WEB} --write) and check again: atticus change conform ${a.id}.`,
      );
      expect(web.problems).toEqual([
        `${PORTAL_WEB} isn't a repo of the estate yet: if it is new, create it on your Git host, then add it (atticus repo add <its clone URL> --id ${PORTAL_WEB}), and check again.`,
      ]);
    },
    T,
  );

  it(
    "the new event's publish is present on its branch; the listener nobody read couldn't be confirmed (ADR 0206)",
    async () => {
      const a = NEW_EVENT;
      const base = await SNAP(m.root, NEW_PUBLISHER);
      const r = await conformChange(m.root, a.id, {
        git: gitAt("c".repeat(40), "a".repeat(40)),
        now: NOW,
        scanAt: async (repo, commit) => ({
          records: [],
          files: [],
          problems: [],
          basis: { from: "facts", unread: [] },
          facts:
            commit === "a".repeat(40)
              ? base
              : [
                  ...base,
                  fact(repo, {
                    kind: "call",
                    id: "c-refund-publish",
                    callType: "event-topic",
                    method: "publish",
                    path: TOPIC,
                    cite: { file: "src/RefundEvents.java", line: 4, value: TOPIC },
                  }),
                ],
        }),
      });
      const pub = r.results.find((x) => x.repo === NEW_PUBLISHER)!;
      expect(pub.claims!.map((c) => [c.check, c.outcome])).toEqual([["publish", "present"]]);
      expect(pub.claims![0]!.at).toEqual([
        { source: "code", repo: NEW_PUBLISHER, path: "src/RefundEvents.java", line: 4 },
      ]);
      expect(pub.items.filter((i) => i.status === "unexpected")).toEqual([]);
      const listener = r.results.find((x) => x.repo === UNREAD_REPO)!;
      expect(listener.claims!.map((c) => [c.check, c.outcome])).toEqual([
        ["listener", "unconfirmed"],
      ]);
      expect(listener.claims![0]!.what).toBe(
        `Atticus couldn't confirm that ${UNREAD_REPO} listens to ${TOPIC}: nobody has read ${UNREAD_REPO} at this commit.`,
      );
      expect(listener.problems[0]).toContain(`${UNREAD_REPO} has no clone here`);
    },
    T,
  );

  it(
    "the quick migration's rows checked on each repo's branch, and its Go/no-go hand-off not held by the cut-over a person has waived (ADR 0206)",
    async () => {
      const a = MIGRATION;
      const repos = [...MOVED, EMPTY_REPO];
      for (const r of repos) await mkdir(join(m.root, "workspace", r), { recursive: true });
      const base = new Map<string, Fact[]>();
      for (const r of repos) base.set(r, await SNAP(m.root, r));
      const r1 = await conformChange(m.root, a.id, {
        git: gitAt("c".repeat(40), "a".repeat(40)),
        now: NOW,
        scanAt: async (repo, commit) => {
          const before = base.get(repo) ?? [];
          const at = (o: { unread?: string[]; facts?: Fact[]; lines?: Map<string, string[]> }) => ({
            records: [],
            files: [],
            problems: [],
            basis: { from: "facts" as const, unread: o.unread ?? [] },
            facts: o.facts ?? before,
            ...(o.lines ? { lines: o.lines } : {}),
          });
          if (commit === "a".repeat(40)) return at({});
          // As the staged migration: the first on Anvil, the second still on its hosts, the
          // third's descriptor changed and no fact covers it; the routing repo is empty.
          if (repo === MOVED[0])
            return at({
              facts: [
                ...before,
                fact(repo, {
                  kind: "deploy",
                  id: "d-anvil",
                  env: "prod",
                  platform: "anvil",
                  resourceName: repo,
                  cite: { file: "deploy/anvil.yaml", line: 1, value: repo },
                }),
              ],
              lines: new Map([["deploy/anvil.yaml", [`name: ${repo} platform: anvil env: prod`]]]),
            });
          return at({ unread: repo === MOVED[2] ? ["deploy/anvil.yaml"] : [] });
        },
      });
      const of = (repo: string) =>
        r1.results.find((x) => x.repo === repo)!.claims!.map((c) => [c.check, c.outcome]);
      expect(of(MOVED[0])).toEqual([["deployment", "present"]]);
      expect(of(MOVED[1])).toEqual([["deployment", "present-differently"]]);
      expect(of(MOVED[2])).toEqual([["deployment", "unconfirmed"]]);
      expect(of(EMPTY_REPO)).toEqual([
        ["route", "missing"],
        ["cut-over", "not-checkable"],
      ]);
      const cut = r1.results
        .find((x) => x.repo === EMPTY_REPO)!
        .claims!.find((c) => c.check === "cut-over")!;
      const id = `conform-not-checked-cut-over-${EMPTY_REPO}-undo-route-the-three-services-back-to-their-old-hosts-which-stay-up-until-the`;
      expect(cut.next).toBe(
        `Check it by hand, then say how: atticus finding ${a.id} ${id} waive --reason "<how it was checked>".`,
      );

      // The Go/no-go hand-off itself: held by the cut-over until a named person says how it was
      // checked, then held only by what the code still lacks.
      const store = changeStore(m.root);
      const was = await store.read(a.id);
      // As if it were built and through QA: its Go/no-go is what the test reads.
      await store.write({
        ...was,
        state: "release-ready",
        history: [
          ...was.history,
          { from: was.state, to: "release-ready", at: NOW, by: "pat", reason: "the test" },
        ],
      });
      try {
        const held = async () =>
          (await changeReport(m.root, a.id)).blockers.flatMap((b) =>
            "finding" in b && b.finding ? [b.finding] : [],
          );
        expect(await held()).toContain(id);
        const w = await run([
          "finding",
          a.id,
          id,
          "waive",
          "--reason",
          "Routed back and forth with the platform team on 2026-11-21.",
          "--by",
          "pat",
          "--root",
          m.root,
        ]);
        expect(w.code, w.err.join("\n")).toBe(0);
        const after = await held();
        expect(after).not.toContain(id);
        expect(after.sort()).toEqual(
          [
            `conform-differs-deployment-${MOVED[1]}-platform-anvil-env-prod`,
            `conform-missing-route-${EMPTY_REPO}-host-anvil-forge-example`,
          ].sort(),
        );
      } finally {
        await store.write(was);
      }
    },
    T,
  );

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

    it(
      "records no one, so with no Git user it says nothing of who it would record (--check)",
      async () => {
        // A machine with no Git user (a fresh CI runner): the check creates nothing and records
        // no one, so the note that the OS user stands in for a person isn't said.
        const empty = join(m.dir, "no-git-user.gitconfig");
        await writeFile(empty, "");
        const kept = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_NOSYSTEM };
        process.env.GIT_CONFIG_GLOBAL = empty;
        process.env.GIT_CONFIG_NOSYSTEM = "1";
        try {
          const file = await requirementsFile(m, "no-git-user", "# A plain note\n\nWhy.\n");
          const r = await run(["change", "new", "--from", file, "--check", "--root", m.root]);
          expect(r.err).toEqual([]);
          expect(r.code).toBe(0);
        } finally {
          for (const [k, v] of [
            ["GIT_CONFIG_GLOBAL", kept.g],
            ["GIT_CONFIG_NOSYSTEM", kept.s],
          ] as const)
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
      },
      T,
    );
  });
});

// ===================================================================== the staged path

describe("the staged path on the same three changes (ADR 0201 part 8, ADR 0203 part B)", () => {
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

  it(
    "new topic (ADR 0207 part 4): the topic's schema and settings reach design.md and the tasks",
    async () => {
      const e = STAGED_NEW_TOPIC;
      await change(e, "feature");
      const feature = await stage(["change", "feature", e.id], e.feature);
      expect(feature.result.findings.filter((f) => f.blocking).map((f) => f.message)).toEqual([]);
      const architecture = await stage(["change", "architecture", e.id], e.architecture);
      expect(architecture.result.findings.filter((f) => f.blocking).map((f) => f.message)).toEqual(
        [],
      );
      expect(architecture.result.state).toBe("done");
      expect(architecture.result.findings.filter((f) => f.rule.startsWith("delta.topic-"))).toEqual(
        [],
      );
      // design.md, golden: its Topics this change adds.
      const golden = join(
        dirname(fileURLToPath(import.meta.url)),
        "../../../fixtures/stages/new-topic/field-design.md",
      );
      const design = await readFile(join(changeFolder(m.root, e.id), "design.md"), "utf8");
      if (process.env.UPDATE_GOLDEN) await writeFile(golden, design);
      expect(design).toBe(await readFile(golden, "utf8"));
      expect(design).toContain("## Topics this change adds");

      const stories = await stage(["plan", "stories", e.id], e.stories);
      expect(stories.result.findings.filter((f) => f.blocking).map((f) => f.message)).toEqual([]);
      expect(stories.result.state).toBe("done");
      const dir = join(changeFolder(m.root, e.id), "stories");
      const files = (await readdir(dir)).sort();
      const text = await Promise.all(files.map((f) => readFile(join(dir, f), "utf8")));
      const publisher = text.find((t) => t.includes(`target-flows/${SETTLE_FLOW.id}.yaml`))!;
      expect(publisher).toContain(
        `- Given the change is built, when ${NEW_PUBLISHER}'s tree is read, then schemas/${NEW_TOPIC}.json holds the json schema of ${NEW_TOPIC}, keyed by batokbaKeltokren, with batokbaKeltokren (string). (from the topic in target-flows/${SETTLE_FLOW.id}.yaml)`,
      );
      expect(publisher).toContain(
        `- Given the change is deployed, when ${NEW_TOPIC} is made, then its settings are partitions 3 and retention 7d. (from the topic in target-flows/${SETTLE_FLOW.id}.yaml)`,
      );
      const listener = text.find((t) => t.includes(`target-flows/${LISTENER_FLOW}.yaml`))!;
      expect(listener).toContain(
        `- Topic it listens to: ${NEW_TOPIC}; the fields it may read: batokbaKeltokren (the topic as this change defines it)`,
      );
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

  /** A change's stages, each run once with its answer and expected to end done on that draft. */
  async function staged(c: { id: string; feature: string; architecture: string; stories: string }) {
    const feature = await stage(["change", "feature", c.id], c.feature);
    expect(feature.result.findings.filter((f) => f.blocking).map((f) => f.message)).toEqual([]);
    expect(feature.result.state).toBe("done");
    const architecture = await stage(["change", "architecture", c.id], c.architecture);
    expect(architecture.result.findings.filter((f) => f.blocking).map((f) => f.message)).toEqual(
      [],
    );
    expect(architecture.result.state).toBe("done");
    const stories = await stage(["plan", "stories", c.id], c.stories);
    expect(stories.result.findings.filter((f) => f.blocking).map((f) => f.message)).toEqual([]);
    expect(stories.result.state).toBe("done");
    expect(stories.code).toBe(0);
    return { feature, architecture, stories };
  }
  const fileOf = (id: string, name: string) =>
    readFile(join(changeFolder(m.root, id), ...name.split("/")), "utf8");
  const afterOf = async (id: string) =>
    (
      (await tasksOf(m.root, id)) as (Awaited<ReturnType<typeof tasksOf>>[number] & {
        after?: string[];
      })[]
    ).map((t) => [t.id, t.repo, t.after ?? []]);

  it(
    "new product: a pipeline and a deployment in two planned repos go through the three stages, the outside party declared",
    async () => {
      const p = STAGED_PRODUCT;
      await change(p, "feature");
      const r = await staged(p);
      // The two repos don't exist yet: a note each names how to add them; nothing blocks.
      const planned = r.feature.result.findings.filter((f) => f.rule === "feature.planned-repo");
      expect(planned.length).toBeGreaterThan(0);
      expect(planned.every((f) => !f.blocking)).toBe(true);
      expect(planned[0]!.message).toContain(`atticus repo add <its clone URL> --id ${PORTAL_API}`);
      // The party outside the map is kept with its standing.
      expect(await fileOf(p.id, "feature.md")).toContain(`- Outside the map: ${OUTSIDE_PARTY} (`);
      expect(parse(await fileOf(p.id, "feature.yaml"))).toMatchObject({
        outside: [{ id: OUTSIDE_PARTY }],
      });
      // One story an operation, one task a repo, under the planned repos; the deployment's
      // task waits for its repo's pipeline.
      expect(await afterOf(p.id)).toEqual([
        ["o1.1", PORTAL_API, []],
        ["o2.1", PORTAL_API, ["o1.1"]],
        ["o1.2", PORTAL_WEB, []],
        ["o2.2", PORTAL_WEB, ["o1.2"]],
      ]);
      const ready1 = await ready(m.root, p.id);
      expect(ready1.plan.ready).toEqual(["o1.1", "o1.2"]);
      expect(ready1.of("o2.1")).toMatchObject({ ready: false });
      // The spec deltas the stage made, one capability a repo, pass OpenSpec's strict check.
      expect(await fileOf(p.id, `specs/${PORTAL_API}-operations/spec.md`)).toContain(
        "### Requirement: Build and release the portal",
      );
      const v = await metarepoOpenSpec(m.root)!.validate({ item: p.id, strict: true });
      expect(v.items[0]!.issues.filter((i) => i.level !== "INFO")).toEqual([]);
      expect(v.items[0]!.valid).toBe(true);
    },
    T,
  );

  it(
    "migration: three services in two waves and a cut-over with its undo go through the three stages; tasks are ready in wave order",
    async () => {
      const g = STAGED_MIGRATION;
      await change(g, "feature");
      // A cut-over without undo is refused at the architecture stage's own check.
      await stage(["change", "feature", g.id], g.feature);
      const noUndo = await checkStageDraft(
        m.root,
        g.id,
        "architecture",
        g.architecture.replace(/ {4}undo: .*\n/, ""),
      );
      expect(noUndo.map((i) => i.rule)).toEqual(["operation.no-undo"]);

      await staged(g);
      const design = await fileOf(g.id, "design.md");
      expect(design).toContain("## Operations");
      expect(design).toContain(`| deploy-anvil | deployment | ${MOVED[2]} | 2 | ${MOVED[2]}: `);
      expect(design).toContain(
        `| Operation switch | cut-over in ${MOVED.join(", ")} | Point the traffic back at the hosts, which stay up for one release. |`,
      );
      expect(await fileOf(g.id, "target-flows/_operations.yaml")).toContain("id: deploy-anvil");

      // Wave 2's tasks wait for the last task of each repo of wave 1: its cut-over.
      expect(await afterOf(g.id)).toEqual([
        ["o1.1", MOVED[0], []],
        ["o2.1", MOVED[0], ["o1.1"]],
        ["o1.2", MOVED[1], []],
        ["o2.2", MOVED[1], ["o1.2"]],
        ["o1.3", MOVED[2], ["o2.1", "o2.2"]],
        ["o2.3", MOVED[2], ["o2.1", "o2.2", "o1.3"]],
      ]);
      let r = await ready(m.root, g.id);
      expect(r.plan.ready).toEqual(["o1.1", "o1.2"]);
      expect(r.lines[0]).toBe(
        `Ready to run, in cross-repo order: o1.1 (${MOVED[0]}), o1.2 (${MOVED[1]}).`,
      );
      expect(r.of("o1.3")).toMatchObject({ ready: false, waitsFor: ["o2.1", "o2.2"] });
      await tick(m.root, g.id, "o1.1");
      await tick(m.root, g.id, "o1.2");
      r = await ready(m.root, g.id);
      expect(r.plan.ready).toEqual(["o2.1", "o2.2"]);
      // Half of wave 1's cut-over done: wave 2 is still held.
      await tick(m.root, g.id, "o2.1");
      r = await ready(m.root, g.id);
      expect(r.plan.ready).toEqual(["o2.2"]);
      expect(r.of("o1.3")).toMatchObject({ ready: false, waitsFor: ["o2.2"] });
      expect(r.lines).toContain(
        "  Not ready: task o1.3: it waits for task o2.2 (after) to be done first.",
      );
      await tick(m.root, g.id, "o2.2");
      r = await ready(m.root, g.id);
      expect(r.plan.ready).toEqual(["o1.3"]);
      await tick(m.root, g.id, "o1.3");
      r = await ready(m.root, g.id);
      expect(r.plan.ready).toEqual(["o2.3"]);

      const v = await metarepoOpenSpec(m.root)!.validate({ item: g.id, strict: true });
      expect(v.items[0]!.issues.filter((i) => i.level !== "INFO")).toEqual([]);
      expect(v.items[0]!.valid).toBe(true);
    },
    T,
  );

  it(
    "the migration's operations checked on each repo's branch: present, present differently, couldn't confirm, and the cut-over a person checks (ADR 0206)",
    async () => {
      const g = STAGED_MIGRATION;
      for (const r of MOVED) await mkdir(join(m.root, "workspace", r), { recursive: true });
      const anvil = (repo: string) =>
        ({
          repo,
          commit: "c".repeat(40),
          verified: "line",
          by: "assistant",
          conf: "declared",
          kind: "deploy",
          id: "d-anvil",
          env: "prod",
          platform: "anvil",
          resourceName: repo,
          cite: { file: "deploy/anvil.yaml", line: 1, value: repo },
        }) as unknown as Fact;
      const base = new Map<string, Fact[]>();
      for (const r of MOVED)
        base.set(r, await readFactsSlot(m.root, r).then((s) => (s?.ok ? s.facts : [])));
      const git: GitRunner = async (args) => ({
        stdout:
          args[0] === "merge-base" ? "a".repeat(40) : args[0] === "rev-parse" ? "c".repeat(40) : "",
        stderr: "",
      });
      const run1 = await conformChange(m.root, g.id, {
        git,
        now: NOW,
        scanAt: async (repo, commit) => {
          const before = base.get(repo) ?? [];
          if (commit === "a".repeat(40))
            return {
              records: [],
              files: [],
              problems: [],
              basis: { from: "facts", unread: [] },
              facts: before,
            };
          // The first is on Anvil; the second still only on its hosts; the third's descriptor
          // changed on the branch and no fact covers it yet.
          if (repo === MOVED[0])
            return {
              records: [],
              files: [],
              problems: [],
              basis: { from: "facts", unread: [] },
              facts: [...before, anvil(repo)],
              lines: new Map([["deploy/anvil.yaml", [`name: ${repo} platform: anvil`]]]),
            };
          return {
            records: [],
            files: [],
            problems: [],
            basis: { from: "facts", unread: repo === MOVED[2] ? ["deploy/anvil.yaml"] : [] },
            facts: before,
          };
        },
      });
      const of = (repo: string) =>
        run1.results
          .find((x) => x.repo === repo)!
          .claims!.map((c) => [c.from.operation, c.outcome]);
      expect(of(MOVED[0])).toEqual([
        ["deploy-anvil", "present"],
        ["switch", "not-checkable"],
      ]);
      expect(of(MOVED[1])).toEqual([
        ["deploy-anvil", "present-differently"],
        ["switch", "not-checkable"],
      ]);
      expect(of(MOVED[2])).toEqual([
        ["deploy-anvil", "unconfirmed"],
        ["switch", "not-checkable"],
      ]);
      const present = run1.results[0]!.claims![0]!;
      expect(present.why).toBe(
        `Written on the cited lines: platform anvil. The assistant's reading of deploy/anvil.yaml:1: env prod.`,
      );
      expect(run1.results.find((x) => x.repo === MOVED[1])!.claims![0]!.what).toBe(
        `${MOVED[1]} runs on hosts in prod, not on anvil.`,
      );
      // The answer the owner chose: a cut-over holds the gate until a named person says how it
      // was checked; couldn't confirm is a note in the hand-off PR, never a finding.
      let gate = await gateStatus(m.root, g.id, "conform");
      expect(gate.open.blocking).toBe(4);
      for (const r of MOVED) {
        const w = await run([
          "finding",
          g.id,
          `conform-not-checked-cut-over-switch-${r}`,
          "waive",
          "--reason",
          "Pointed back and forth on the Anvil console with the platform team on 2026-11-21.",
          "--by",
          "pat",
          "--root",
          m.root,
        ]);
        expect(w.code, w.err.join("\n")).toBe(0);
      }
      gate = await gateStatus(m.root, g.id, "conform");
      expect(gate.open.blocking).toBe(1);
      // The estimate counts each operation task.
      const est = JSON.parse(
        (await run(["change", "estimate", g.id, "--json", "--root", m.root])).out.join("\n"),
      ) as Api.ChangeEstimateT;
      expect(est.units.filter((u) => u.from === "operations")).toHaveLength(6);
    },
    T,
  );

  it(
    "a change of flows and operations: one deploy order, the operations' tasks beside the flow's, and the capabilities named",
    async () => {
      const x = STAGED_MIXED;
      await change(x, "feature");
      await staged(x);
      // design.md: the flow's code and the operations in one deploy order.
      const design = await fileOf(x.id, "design.md");
      expect(design).toContain(
        [
          "## Deploy order",
          "",
          `1. ${NEW_PUBLISHER}.`,
          `2. Operation topic-setting, in ${NEW_PUBLISHER}.`,
          `3. Operation topic-retention, in ${EMPTY_REPO}.`,
        ].join("\n"),
      );
      // tasks.md: the operation's task after the flow's in its repo, and a heading of its own.
      expect(await afterOf(x.id)).toEqual([
        ["1.1", NEW_PUBLISHER, []],
        ["o1.1", NEW_PUBLISHER, []],
        ["o2.1", EMPTY_REPO, ["o1.1"]],
      ]);
      let r = await ready(m.root, x.id);
      expect(r.plan.ready).toEqual(["1.1"]);
      expect(r.of("o2.1")).toMatchObject({ ready: false, waitsFor: ["o1.1"] });
      await tick(m.root, x.id, "1.1");
      r = await ready(m.root, x.id);
      expect(r.plan.ready).toEqual(["o1.1"]);
      await tick(m.root, x.id, "o1.1");
      r = await ready(m.root, x.id);
      expect(r.plan.ready).toEqual(["o2.1"]);
      // proposal.md names the operations' capabilities beside the flow's.
      const proposal = await fileOf(x.id, "proposal.md");
      expect(proposal).toContain(`- \`${NEW_PUBLISHER}-operations\`: operations: `);
      expect(proposal).toContain(`- \`${EMPTY_REPO}-operations\`: operations: `);
      expect(proposal).toContain(
        `- Operation (config) in ${EMPTY_REPO}: Set the topic's retention.`,
      );
      const v = await metarepoOpenSpec(m.root)!.validate({ item: x.id, strict: true });
      expect(v.items[0]!.issues.filter((i) => i.level !== "INFO")).toEqual([]);
      // ADR 0206: the estimate sizes the flow's step and each operation task, citing the file.
      const e = await run(["change", "estimate", x.id, "--json", "--root", m.root]);
      expect(e.code).toBe(0);
      const units = (
        JSON.parse(e.out.join("\n")) as {
          units: { flow: string; repo: string; class: string; from?: string; source: string }[];
        }
      ).units;
      expect(
        units.filter((u) => u.from === "operations").map((u) => [u.flow, u.repo, u.class]),
      ).toEqual([
        ["o1.1", NEW_PUBLISHER, "operation/config"],
        ["o2.1", EMPTY_REPO, "operation/config"],
      ]);
      expect(units.find((u) => u.from === "operations")!.source).toBe(
        `openspec/changes/${x.id}/target-flows/_operations.yaml`,
      );
      // Conformance reads the flow and the operations' claims; it never says they aren't checked.
      const c = await run(["change", "conform", x.id, "--latest", "--root", m.root]);
      expect(c.code).toBe(0);
      expect(c.err.join("\n")).not.toContain("Unrecognized key");
      expect(c.out.join("\n")).not.toContain("doesn't check operations");
    },
    T,
  );

  it(
    "kept: a change with no flow and no operation still stops once and names the quick path",
    async () => {
      const p = STAGED_NOTHING;
      await change(p, "feature");
      const said = await refusesOnce(["change", "feature", p.id], p.feature);
      expect(said).toContain("The feature touches nothing");
      expect((await loopOf(p.id, "feature")).state).toBe("stopped");

      // Planning its stories anyway is refused with the same hint ("has nothing to plan").
      const plan = await run(["plan", "stories", p.id, "--draft", "--root", m.root]);
      expect(plan.code).toBe(1);
      expect(plan.err.join("\n")).toContain(`${p.id} has nothing to plan`);
      expect(plan.err.join("\n")).toContain(QUICK_PATH_HINT);

      const g = STAGED_NO_STEP;
      await change(g, "small-change");
      const small = await refusesOnce(["change", "small", g.id], g.small);
      expect(small).toContain("The answer changes no step of any flow");
      expect((await loopOf(g.id, "small")).state).toBe("stopped");
    },
    T,
  );

  // ------------------------------------------------------------- ADR 0203 parts A and C

  /** The newest round of a gate's findings. */
  const gateFindings = async (id: string, gate: string) => {
    const dir = join(changeFolder(m.root, id), "review", gate);
    const n = Math.max(...(await readdir(dir)).map(Number).filter((x) => x > 0));
    return (await readdir(join(dir, String(n))))
      .filter((f) => f.endsWith(".yaml"))
      .map(
        async (f) =>
          parse(await readFile(join(dir, String(n), f), "utf8")) as Record<string, unknown>,
      );
  };

  it(
    "new event: a consumer nothing knows blocks, a person accepts it, and the stages finish; status and the PR body list the acceptance",
    async () => {
      const e = { ...STAGED_EVENT, id: "publish-settled-refunds-accepted" };
      const ghost = e.architecture.replace(`, ${UNREAD_REPO}]`, `, ${GHOST}]`);
      const ghostStories = e.stories.replace(`, ${UNREAD_REPO}]`, `, ${GHOST}]`);
      expect(ghost).toContain(GHOST);
      await change(e, "feature");
      expect((await stage(["change", "feature", e.id], e.feature)).result.state).toBe("done");

      // The architecture stage stops on it: three drafts had it, and nothing knows forge-ghost.
      const first = assistant(ghost);
      const c1 = capture();
      expect(
        await stageCli(m.root, ["change", "architecture", e.id], {}, c1.io, {
          runtime: first.runtime,
          now: new Date(NOW),
        }),
      ).toBe(1);
      expect(c1.err.join("\n")).toContain(`lists consumer ${GHOST}, which isn't in the catalog`);
      const [projected] = await Promise.all(await gateFindings(e.id, "stage-architecture"));
      expect(projected).toMatchObject({
        rule: "delta.unknown-consumer",
        severity: "blocking",
        waivable: true,
        state: "open",
        locator: { record: GHOST },
      });

      // A person accepts it, with a name and a reason, as a waiver.
      const why = "Its team reads the topic; the repo comes into the map next quarter";
      const w = await run([
        "finding",
        e.id,
        String(projected!.id),
        "waive",
        "--reason",
        why,
        "--by",
        "pat",
        "--root",
        m.root,
      ]);
      expect(w.err.join("\n")).not.toContain("Error");
      expect(w.code).toBe(0);

      // Run again: its files pass, the critic reviews, done with no new draft.
      const again = assistant(ghost);
      const c2 = capture();
      expect(
        await stageCli(m.root, ["change", "architecture", e.id], { json: true }, c2.io, {
          runtime: again.runtime,
          now: new Date(NOW),
        }),
      ).toBe(0);
      expect((JSON.parse(c2.out.join("\n")) as { state: string }).state).toBe("done");
      expect(again.drafts).toEqual([]);
      const design = await readFile(join(changeFolder(m.root, e.id), "design.md"), "utf8");
      expect(design).toContain(
        `- ${GHOST} (of ${SETTLE_FLOW.id}): accepted by pat: ${why}; its use can't be checked.`,
      );

      // The stories stage takes the accepted consumer with a note, and makes no task for it.
      const stories = await stage(["plan", "stories", e.id], ghostStories);
      expect(stories.result.state).toBe("done");
      const note = stories.result.findings.find((f) => f.rule === "stories.unknown-consumer");
      expect(note).toMatchObject({ blocking: false });
      expect(note!.message).toContain(
        `${GHOST} is accepted by pat: ${why}, so its use can't be checked.`,
      );
      expect((await tasksOf(m.root, e.id)).map((t) => t.repo)).toEqual([NEW_PUBLISHER]);

      // Shown in change status and the hand-off PR's body, one line each: rule, who, why.
      const status = await run(["change", "status", e.id, "--root", m.root]);
      expect(status.out).toContain(
        "Accepted: 1 finding accepted at the architecture stage: delta.unknown-consumer, by pat.",
      );
      const body = await handoffReview(m.root, e.id);
      expect(body).toContain(
        `### Accepted by people\n\n- \`delta.unknown-consumer\` at the architecture stage, by \`pat\`: \`${why}\``,
      );
    },
    T,
  );

  /**
   * A stage whose draft keeps a finding a person may accept: run once (it stops or asks), the
   * finding accepted by pat as a waiver, then run again: done, with no new draft.
   */
  async function acceptedThenDone(args: string[], answer: string, id: string, rule: string) {
    const first = assistant(answer);
    await stageCli(m.root, args, {}, capture().io, { runtime: first.runtime, now: new Date(NOW) });
    const gate = `stage-${args[0] === "plan" ? "stories" : args[1]}`;
    const projected = (await Promise.all(await gateFindings(id, gate))).find(
      (f) => f.rule === rule,
    );
    expect(projected, `no ${rule} on ${gate}`).toMatchObject({ waivable: true, state: "open" });
    const w = await run([
      "finding",
      id,
      String(projected!.id),
      "waive",
      "--reason",
      "It is created in the same release",
      "--by",
      "pat",
      "--root",
      m.root,
    ]);
    expect(w.code, w.err.join("\n")).toBe(0);
    const again = assistant(answer);
    const c = capture();
    await stageCli(m.root, args, { json: true }, c.io, {
      runtime: again.runtime,
      now: new Date(NOW),
    });
    expect((JSON.parse(c.out.join("\n")) as { state: string }).state).toBe("done");
    expect(again.drafts).toEqual([]);
    return projected!;
  }

  it(
    "operation.unknown-repo accepted: the repo is known as a new repo, and its operation's task is under it",
    async () => {
      const x = { ...STAGED_MIXED, id: "publish-settled-refunds-ghost-repo" };
      const architecture = x.architecture.replace(
        `    repos: [${EMPTY_REPO}]\n    what: Set the topic's retention to seven days.`,
        `    repos: [${EMPTY_REPO}, ${GHOST_SVC}]\n    what: Set the topic's retention to seven days.`,
      );
      expect(architecture).toContain(GHOST_SVC);
      const stories = x.stories.replace(
        given(EMPTY_REPO, "the topic's retention is seven days in its deploy files"),
        given(EMPTY_REPO, "the topic's retention is seven days in its deploy files") +
          given(GHOST_SVC, "the topic's retention is seven days in its deploy files"),
      );
      expect(stories).toContain(GHOST_SVC);
      await change(x, "feature");
      await stage(["change", "feature", x.id], x.feature);
      const f = await acceptedThenDone(
        ["change", "architecture", x.id],
        architecture,
        x.id,
        "operation.unknown-repo",
      );
      expect(f).toMatchObject({ locator: { record: GHOST_SVC } });
      const s = await stage(["plan", "stories", x.id], stories);
      expect(s.result.findings.filter((i) => i.blocking).map((i) => i.message)).toEqual([]);
      expect(s.result.state).toBe("done");
      const ghost = (await tasksOf(m.root, x.id)).find((t) => t.repo === GHOST_SVC);
      expect(ghost, "no task under the accepted repo").toBeDefined();
      // tasks.md puts it under the repo's own heading. The task run's words for a repo no
      // manifest lists are ADR 0201's, tested on the quick path above (this change is in define).
      expect(await fileOf(x.id, "tasks.md")).toContain(`## ${GHOST_SVC}`);
    },
    T,
  );

  it(
    "delta.unknown-component accepted: the call's target is known as accepted, and the stories name it",
    async () => {
      const e = { ...STAGED_EVENT, id: "publish-settled-refunds-ghost-target" };
      const architecture = e.architecture.replace(
        `to: { component: ${FIELD_TOPIC_LISTENER}, entry: ${TOPIC} }`,
        `to: { component: ${GHOST_SVC}, entry: ${TOPIC} }`,
      );
      expect(architecture).toContain(GHOST_SVC);
      await change(e, "feature");
      await stage(["change", "feature", e.id], e.feature);
      const f = await acceptedThenDone(
        ["change", "architecture", e.id],
        architecture,
        e.id,
        "delta.unknown-component",
      );
      expect(f).toMatchObject({ locator: { record: GHOST_SVC } });
      const s = await stage(["plan", "stories", e.id], e.stories);
      expect(s.result.findings.filter((i) => i.blocking).map((i) => i.message)).toEqual([]);
      expect(s.result.state).toBe("done");
      const story = await readFile(
        join(changeFolder(m.root, e.id), "stories", "s1-settle-refund.md"),
        "utf8",
      );
      expect(story).toContain(`goes to ${GHOST_SVC} ${TOPIC}`);

      // The acceptance covers that component only. Drafted again to the same one: still accepted.
      const same = assistant(architecture);
      const c1 = capture();
      await stageCli(m.root, ["change", "architecture", e.id], { json: true, force: true }, c1.io, {
        runtime: same.runtime,
        now: new Date(NOW),
      });
      expect((JSON.parse(c1.out.join("\n")) as { state: string }).state).toBe("done");
      // Drafted to another component nothing knows: a new open finding, and the stage isn't done.
      const evil = assistant(architecture.replace(GHOST_SVC, EVIL_SVC));
      const c2 = capture();
      await stageCli(m.root, ["change", "architecture", e.id], { json: true, force: true }, c2.io, {
        runtime: evil.runtime,
        now: new Date(NOW),
      });
      expect(c2.out.join("\n")).not.toContain('"state": "done"');
      const now = await Promise.all(await gateFindings(e.id, "stage-architecture"));
      expect(now.map((x) => [(x.locator as { record?: string }).record, x.state])).toEqual([
        [EVIL_SVC, "open"],
      ]);
      expect(String(now[0]!.summary)).toContain(EVIL_SVC);
    },
    T,
  );

  it(
    "a persona's naysayer with gates: [design] runs at the design gate; its finding is a risk with lens persona, and the gate isn't held",
    async () => {
      const e = { ...STAGED_EVENT, id: "publish-settled-refunds-persona" };
      const agents = join(m.root, "org-pack", "agents");
      await mkdir(agents, { recursive: true });
      const persona = join(agents, `${NAYSAYER}.md`);
      const starter = await readFile(STARTER_NAYSAYER, "utf8");
      await writeFile(
        persona,
        starter.replace(
          "\nowns: Application architect\n",
          "\nowns: Application architect\ngates: [design]\n",
        ),
      );
      try {
        await change(e, "feature");
        await stage(["change", "feature", e.id], e.feature);
        const brief = e.brief.split("\n")[2]!;
        const lens = naysayerAnswer(brief, "brief.md");
        const drafts: string[] = [];
        const runtime = new MockRuntime(
          (req) => {
            if (req.agent.id === NAYSAYER) return lens(req);
            if (req.agent.id.endsWith("-critic")) return "findings: []";
            if (req.agent.id === EXPAND_AGENT) return "terms: [settled refund]\nnames: []\n";
            drafts.push(req.agent.id);
            return e.architecture;
          },
          { now: () => new Date(NOW) },
        );
        const c = capture();
        expect(
          await stageCli(m.root, ["change", "architecture", e.id], { json: true }, c.io, {
            runtime,
            now: new Date(NOW),
          }),
        ).toBe(0);
        expect((JSON.parse(c.out.join("\n")) as { state: string }).state).toBe("done");
        const found = (await Promise.all(await gateFindings(e.id, "design"))).filter(
          (f) => f.lens === "persona",
        );
        expect(found.length).toBeGreaterThan(0);
        expect(found[0]).toMatchObject({
          lens: "persona",
          persona: NAYSAYER,
          rule: `persona.${NAYSAYER}`,
          severity: "risk",
        });
        const s = await run(["findings", e.id, "--root", m.root]);
        expect(s.out.join("\n")).not.toMatch(/design gate is closed/);
      } finally {
        await rm(persona, { force: true });
      }
    },
    T,
  );
});
