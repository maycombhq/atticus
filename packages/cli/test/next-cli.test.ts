import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseRecord, raiseQuestions, recordPath, serializeRecord } from "@maycombhq/core";
import { main } from "../src/main.js";
import { canMoveOn, nextSteps, type NextState, type NextStep } from "../src/next-commands.js";

/** `atticus next` (ADR 0086): the next step from the metarepo's files, in several states. */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");

const run = async (args: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(
    args,
    { out: (l) => out.push(l), err: (l) => err.push(l) },
    { quiet: true },
  );
  return { code, out, err };
};

const json = async (root: string) => {
  const r = await run(["next", "--json", "--root", root]);
  expect(r.code, r.err.join("\n")).toBe(0);
  return JSON.parse(r.out.join("\n")) as { next: NextStep; steps: NextStep[] };
};

const commands = (steps: NextStep[]) => steps.map((s) => [s.command, s.slash ?? null]);

/** The scan-settings fixture: two repos in the manifest, both with scan settings. */
async function metarepo(o: { clone?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "atticus-next-"));
  await cp(join(FIXTURES, "scan-settings/metarepo"), root, { recursive: true });
  if (o.clone)
    for (const id of ["forge-notes", "forge-notes-ui"])
      await mkdir(join(root, "workspace", id, ".git"), { recursive: true });
  return root;
}

async function component(root: string, id: string) {
  const p = parseRecord({
    kind: "Component",
    schemaVersion: 2,
    id,
    status: "current",
    confidence: "verified",
    evidence: [{ source: "code", repo: id, path: "README.md", line: 1 }],
    system: "notes",
    repo: id,
    type: "service",
  });
  if (!p.ok) throw new Error(JSON.stringify(p.issues));
  const file = join(root, "catalog", "generated", recordPath(p.record));
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, serializeRecord(p.record));
}

describe("atticus next", () => {
  it("with no repos listed, says to propose the manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-next-"));
    await mkdir(join(root, "org-pack"), { recursive: true });
    const r = await run(["next", "--root", root]);
    expect(r.code).toBe(0);
    expect(r.out).toEqual([
      "Next: atticus repos discover <folder>",
      "Why: No repo is listed yet. Propose the manifest from a folder of clones or your Git host's organisation (--org).",
    ]);
  });

  it("outside a metarepo, says so and how to make or open one (ADR 0119)", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-next-none-"));
    const r = await run(["next", "--root", root]);
    expect(r.code).toBe(2);
    const said = r.err.join("\n");
    expect(said).toContain("isn't an Atticus metarepo");
    expect(said).toContain("atticus init");
    expect(said).toContain("atticus adopt");
  });

  it("names where to type the slash command: the default assistant (ADR 0121)", async () => {
    const root = await metarepo({ clone: true });
    await rm(join(root, "org-pack", "scan", "forge-notes-ui.yaml"));
    await writeFile(
      join(root, "org-pack", "runtime.yaml"),
      "schemaVersion: 1\nassistants: { allowed: [cursor, copilot], default: cursor }\n",
    );
    const r = await run(["next", "--root", root]);
    expect(r.out[1]).toBe("In Cursor's chat: /atticus-map forge-notes");
    // The editors' Next view shows what runs the step, in one line (ADR 0121 item 6).
    const j = (await json(root)) as { runs?: string; modelMode?: boolean };
    expect(j.runs).toBe("Hand-off to Cursor");
    expect(j.modelMode).toBe(false);
    // With model mode allowed and a provider set, a step can run on it (IntelliJ offers that).
    await writeFile(
      join(root, "org-pack", "runtime.yaml"),
      [
        "schemaVersion: 1",
        "assistants: { allowed: [copilot], default: copilot }",
        "modes: { allowed: [hand-off, model], default: hand-off }",
        "adapters: { model: { type: vertex, settings: { model: gemini-2.5-pro } } }",
        "",
      ].join("\n"),
    );
    expect(((await json(root)) as { modelMode?: boolean }).modelMode).toBe(true);
  });

  it("with repos not cloned, says to sync, and lists the rest with --all", async () => {
    const root = await metarepo();
    const r = await run(["next", "--root", root]);
    expect(r.out[0]).toBe("Next: atticus workspace sync");
    expect(r.out[1]).toBe("Why: 2 repos aren't cloned yet: forge-notes, forge-notes-ui.");
    expect(r.out[2]).toBe("2 more steps after this one: atticus next --all");
    const all = await run(["next", "--all", "--root", root]);
    expect(all.out[0]).toBe("1. atticus workspace sync");
    // ADR 0128: no repo says what it is yet, so a person is asked for one line.
    expect(all.out[2]).toBe('2. atticus repo describe forge-notes --description "what it is"');
    expect(all.out[4]).toBe('3. atticus change new "<title>" --type <type>');
  });

  it("with repos cloned but never read, has the assistant read each (/atticus-map), then verify --write: not a survey and a scan (ADR 0124)", async () => {
    const root = await metarepo({ clone: true });
    await rm(join(root, "org-pack", "scan", "forge-notes-ui.yaml"));
    const r = await run(["next", "--root", root]);
    expect(r.out.slice(0, 2)).toEqual([
      "Next: atticus map forge-notes",
      "In Copilot Chat: /atticus-map forge-notes",
    ]);
    const j = await json(root);
    expect(commands(j.steps)).toEqual([
      ["atticus map forge-notes", "/atticus-map forge-notes"],
      ["atticus map forge-notes-ui", "/atticus-map forge-notes-ui"],
      // ADR 0128: no repo says what it is yet, so a person is asked for one line.
      ['atticus repo describe forge-notes --description "what it is"', null],
      ['atticus change new "<title>" --type <type>', null],
    ]);
    expect(j.steps[0]!.why).toBe(
      "forge-notes isn't read yet: your assistant reads it and writes its facts, each citing its line, and atticus verify forge-notes checks them.",
    );
    // Read, not yet written into the catalog: verify --write is next.
    await mkdir(join(root, "facts"), { recursive: true });
    await writeFile(join(root, "facts", "forge-notes.jsonl"), "");
    expect(commands((await json(root)).steps).slice(0, 2)).toEqual([
      ["atticus verify forge-notes --write", null],
      ["atticus map forge-notes-ui", "/atticus-map forge-notes-ui"],
    ]);
  });

  /**
   * ADR 0124 addendum A-ledger: a repo read in parts has a read plan beside its facts, so
   * `atticus next` says which part comes next instead of leaving the person to keep the list.
   */
  it("names the part that comes next for a repo read in parts", async () => {
    const root = await metarepo({ clone: true });
    await mkdir(join(root, "facts"), { recursive: true });
    await writeFile(
      join(root, "facts", "forge-notes.read-plan.yaml"),
      [
        "schemaVersion: 1",
        "repo: forge-notes",
        "commit: 0123abc",
        "session: 150000",
        "plannedAt: 2026-10-26T09:00:00Z",
        "parts:",
        ...Array.from({ length: 13 }, (_, i) =>
          [
            `  - part: ${i + 1}`,
            "    paths:",
            `      - mod${i + 1}/**`,
            "    files: 10",
            "    tokens: 120000",
          ].join("\n"),
        ),
        "",
      ].join("\n"),
    );
    // Three parts' folders are in the reviewed file: parts 1 to 3 are read, part 4 is next.
    await writeFile(
      join(root, "facts", "forge-notes.reviewed.jsonl"),
      [1, 2, 3]
        .map((n) => JSON.stringify({ path: `mod${n}/**`, why: "read; no fact to record" }))
        .join("\n") + "\n",
    );
    const j = await json(root);
    expect(j.steps[0]!.command).toBe("atticus map forge-notes");
    expect(j.steps[0]!.why).toBe(
      "forge-notes is read in 13 parts (facts/forge-notes.read-plan.yaml): part 4 of 13 is next, 3 are read (mod4/**). Your assistant reads the part and writes its facts, each citing its line.",
    );
    const r = await run(["next", "--root", root]);
    expect(r.out[0]).toBe("Next: atticus map forge-notes");
    expect(r.out[1]).toBe("In Copilot Chat: /atticus-map forge-notes");
  });

  it("after the scan: verify each repo, accept a proposal, answer the questions, then the specs", async () => {
    const root = await metarepo({ clone: true });
    await component(root, "forge-notes");
    await component(root, "forge-notes-ui");
    await mkdir(join(root, "proposals", "scan"), { recursive: true });
    await writeFile(
      join(root, "proposals", "scan", "forge-notes.yaml"),
      `schemaVersion: 1
repo: forge-notes
at: 2026-10-21T12:00:00Z
settings:
  exclude:
    - { path: "docs/**", why: a generated playground, at: "docs/playground.js:1" }
  prefixes: []
  clients: []
`,
    );
    const { raised } = await raiseQuestions(
      root,
      [
        {
          question: "Is /notes-api also the prefix of the admin endpoints?",
          options: [
            { label: "Yes", means: "one context path", changes: "admin endpoints get /notes-api" },
            {
              label: "No",
              means: "admin has its own",
              changes: "admin endpoints stay as they are",
            },
          ],
          evidence: ["src/main/resources/application.properties:3"],
          scope: "repo",
        },
      ],
      {
        step: "scan-survey",
        repo: "forge-notes",
        command: "atticus scan survey forge-notes",
        rerun: "atticus scan survey forge-notes --force",
        at: "2026-10-21T12:00:00Z",
      },
    );
    const q = raised[0]!.id;
    const j = await json(root);
    expect(commands(j.steps)).toEqual([
      ["atticus scan verify forge-notes --accept", null],
      ["atticus scan verify forge-notes-ui", "/atticus-verify forge-notes-ui"],
      // ADR 0128: no repo says what it is yet, so a person is asked for one line.
      ['atticus repo describe forge-notes --description "what it is"', null],
      ["atticus questions list --state open", "/atticus-answer"],
      ["atticus spec draft forge-notes", "/atticus-spec forge-notes"],
      ["atticus spec draft forge-notes-ui", "/atticus-spec forge-notes-ui"],
      ['atticus change new "<title>" --type <type>', null],
    ]);
    expect(j.next.person).toBe(true);
    expect(j.steps.find((s) => s.step === "answer")!.why).toContain(q);
  });

  it("after verify --write, a repo whose spec comes from its verified facts skips the reader path (B-run2-fixes 7)", async () => {
    const root = await metarepo({ clone: true });
    // No scan, no verify proposal, no spec check: the spec and catalog come from the facts.
    await rm(join(root, "org-pack", "scan", "forge-notes-ui.yaml"));
    for (const id of ["forge-notes", "forge-notes-ui"]) {
      await mkdir(join(root, "specs", id), { recursive: true });
      await writeFile(
        join(root, "specs", id, "spec.yaml"),
        `schemaVersion: 1\nrepo: ${id}\ncommit: ${"a".repeat(40)}\ntemplate: facts@1\ntemplateReviewed: false\n`,
      );
    }
    await component(root, "forge-notes");
    await component(root, "forge-notes-ui");
    expect(commands((await json(root)).steps)).toEqual([
      // ADR 0128: no repo says what it is yet, so a person is asked for one line.
      ['atticus repo describe forge-notes --description "what it is"', null],
      ['atticus change new "<title>" --type <type>', null],
    ]);
    await cp(
      join(FIXTURES, "forge-change/openspec/changes/add-transfer-limit"),
      join(root, "openspec/changes/add-transfer-limit"),
      { recursive: true },
    );
    expect(commands((await json(root)).steps)).toEqual([
      // ADR 0128: no repo says what it is yet, so a person is asked for one line.
      ['atticus repo describe forge-notes --description "what it is"', null],
      ["atticus plan stories add-transfer-limit", "/atticus-stories add-transfer-limit"],
    ]);
  });

  it("with a change at the stories stage, gives /atticus-stories", async () => {
    const root = await metarepo({ clone: true });
    await component(root, "forge-notes");
    await component(root, "forge-notes-ui");
    await cp(
      join(FIXTURES, "forge-change/openspec/changes/add-transfer-limit"),
      join(root, "openspec/changes/add-transfer-limit"),
      { recursive: true },
    );
    const j = await json(root);
    expect(j.steps.at(-1)).toMatchObject({
      step: "stories",
      command: "atticus plan stories add-transfer-limit",
      slash: "/atticus-stories add-transfer-limit",
      change: "add-transfer-limit",
    });
    expect(j.steps.some((s) => s.step === "new-change")).toBe(false);
  });
});

describe("nextSteps (pure)", () => {
  const base: NextState = {
    repos: [
      {
        id: "forge-ledger",
        cloned: true,
        settings: true,
        scanned: true,
        verify: "done",
        flows: 3,
        checked: true,
        findings: 0,
        described: "said",
      },
    ],
    catalogRecords: 10,
    openQuestions: [],
    sources: [],
    changes: [],
    problems: [],
  };

  it("loops the spec: check a fresh draft, redraft on findings, nothing once it passes", () => {
    const at = (r: Partial<NextState["repos"][number]>) =>
      nextSteps({ ...base, repos: [{ ...base.repos[0]!, ...r }] })[0]!;
    expect(at({ checked: false })).toMatchObject({
      command: "atticus spec check forge-ledger",
      slash: "/atticus-spec forge-ledger",
    });
    expect(at({ findings: 2 })).toMatchObject({
      command: "atticus spec draft forge-ledger",
      why: "The last spec check of forge-ledger found 2 problems: draft the flagged flows again, then check.",
    });
    expect(at({}).step).toBe("new-change");
    expect(at({}).why).toBe(
      "Everything is onboarded, checked and answered, and no change is in flight. Start one.",
    );
  });

  it("syncs a knowledge source, then reads its snapshot", () => {
    const steps = (snapshot: boolean, scanned: boolean) =>
      nextSteps({ ...base, sources: [{ id: "forge-wiki", snapshot, scanned }] });
    expect(steps(false, false)[0]).toMatchObject({
      command: "atticus sources sync --source forge-wiki",
      slash: "/atticus-knowledge forge-wiki",
    });
    expect(steps(true, false)[0]).toMatchObject({
      command: "atticus knowledge scan --source forge-wiki",
      slash: "/atticus-knowledge forge-wiki",
    });
    expect(steps(true, true)[0]!.step).toBe("new-change");
  });

  it("gives each change its stage's step, a task in the repo it belongs to", () => {
    const steps = nextSteps({
      ...base,
      changes: [
        { id: "add-limit", state: "define", tasks: [] },
        { id: "move-ledger", state: "design", tasks: [] },
        {
          id: "split-fees",
          state: "build",
          tasks: [
            { id: "1.1", repo: "forge-ledger", done: true },
            { id: "1.2", repo: "forge-ledger", done: false },
          ],
        },
        { id: "old-one", state: "released", tasks: [] },
      ],
    });
    expect(commands(steps)).toEqual([
      ["atticus change feature add-limit", "/atticus-feature add-limit"],
      ["atticus change architecture move-ledger", "/atticus-architecture move-ledger"],
      // ADR 0113: /atticus-task loads the task's context in the metarepo.
      ["atticus task run split-fees 1.2", "/atticus-task split-fees 1.2"],
    ]);
    expect(steps[2]!.where).toBe("metarepo");
    expect(steps[2]!.repo).toBe("forge-ledger");
  });

  it("once the state's stage is done, has a person raise its hand-off, not run the stage again (B-change)", () => {
    const steps = nextSteps({
      ...base,
      changes: [
        {
          id: "screen-orders",
          state: "define",
          tasks: [],
          stagesDone: ["feature", "architecture", "stories"],
        },
        { id: "move-ledger", state: "design", tasks: [], stagesDone: ["feature"] },
      ],
    });
    expect(commands(steps)).toEqual([
      ["atticus change handoff screen-orders --approve", null],
      ["atticus change architecture move-ledger", "/atticus-architecture move-ledger"],
    ]);
    expect(steps[0]).toMatchObject({ step: "handoff", person: true });
    expect(steps[0]!.why).toBe(
      "screen-orders's feature stage is done (and architecture and stories ran ahead), but the change is still in define: a person raises its define hand-off PR, and merging it approves the define gate and moves it on (ADR 0073).",
    );
  });

  it("gives a small change the fast path's one step until it is built (ADR 0113)", () => {
    const steps = nextSteps({
      ...base,
      changes: [
        { id: "fix-label", state: "plan", tasks: [], fast: true },
        { id: "raise-timeout", state: "define", tasks: [], fast: true },
        {
          id: "fix-built",
          state: "build",
          tasks: [{ id: "1.1", repo: "forge-web", done: false }],
          fast: true,
        },
      ],
    });
    expect(commands(steps)).toEqual([
      ["atticus change small fix-label", "/atticus-small fix-label"],
      ["atticus change small raise-timeout", "/atticus-small raise-timeout"],
      ["atticus task run fix-built 1.1", "/atticus-task fix-built 1.1"],
    ]);
    expect(steps[0]!.why).toMatch(/one step/);
    // Once its one step is done, a person opens its pull request.
    const done = nextSteps({
      ...base,
      changes: [{ id: "fix-label", state: "plan", tasks: [], fast: true, fastDone: true }],
    });
    expect(done[0]).toMatchObject({
      step: "small-handoff",
      command: "atticus change handoff fix-label --approve",
      person: true,
    });
  });
  it("asks what a placed change needs from the organisation, then has a person raise the open ones (ADR 0101)", () => {
    const find = nextSteps({
      ...base,
      changes: [{ id: "add-limit", state: "design", tasks: [], feature: true }],
    });
    expect(commands(find)).toEqual([
      ["atticus change needs add-limit", "/atticus-needs add-limit"],
      ["atticus change architecture add-limit", "/atticus-architecture add-limit"],
    ]);
    const raise = nextSteps({
      ...base,
      changes: [
        {
          id: "add-limit",
          state: "design",
          tasks: [],
          feature: true,
          needs: { open: 2, longest: "SSO intake, 10 working days" },
        },
      ],
    });
    expect(raise.map((x) => x.step)).toEqual(["architecture", "raise-needs"]);
    expect(raise[1]).toMatchObject({
      command: "atticus needs --change add-limit",
      person: true,
      why: expect.stringContaining("the longest: SSO intake, 10 working days"),
    });
    // A released change has nothing to find or raise.
    const old = nextSteps({
      ...base,
      changes: [{ id: "old", state: "released", tasks: [], feature: true, needs: { open: 1 } }],
    });
    expect(old.map((x) => x.step)).not.toContain("raise-needs");
    expect(old.map((x) => x.step)).not.toContain("needs");
  });
  it("keeps the knowledge current: a stale wiki synced again, the org pack drafted and accepted, needs verified (ADR 0101)", () => {
    const steps = nextSteps({
      ...base,
      sources: [{ id: "platform-wiki", snapshot: true, scanned: true, age: 30 }],
      orgpack: { missing: 3 },
      unverifiedNeeds: 2,
    });
    expect(steps.map((x) => [x.step, x.command])).toEqual([
      ["sync-source", "atticus sources sync --source platform-wiki"],
      ["orgpack-draft", "atticus orgpack draft"],
      ["verify-knowledge", "atticus knowledge list --unverified"],
      ["new-change", 'atticus change new "<title>" --type <type>'],
    ]);
    expect(steps[0]!.why).toContain("30 days old");
    const waiting = nextSteps({
      ...base,
      orgpack: { missing: 3, draft: { platform: "forge", proposals: 3 } },
    });
    expect(waiting[0]).toMatchObject({
      step: "accept-orgpack",
      command: "atticus orgpack accept forge",
      person: true,
    });
    const fresh = nextSteps({
      ...base,
      sources: [{ id: "w", snapshot: true, scanned: true, age: 3 }],
    });
    expect(fresh.map((x) => x.step)).not.toContain("sync-source");
  });

  // A live run (2026-10-25): next pointed at eleven repo questions from the map read while the
  // change in hand waited on its own step. With a change active, its steps come first: its own
  // questions, then its stage; the repos' questions after.
  it("puts the change in hand first: its questions, then its stage, then the repos' questions", () => {
    const repoQs = Array.from({ length: 11 }, (_, i) => `q-00000000000${i.toString(16)}`);
    const steps = nextSteps({
      ...base,
      openQuestions: [...repoQs, "q-aaaaaaaaaaaa"],
      changeQuestions: { "add-limit": ["q-aaaaaaaaaaaa"] },
      active: "add-limit",
      changes: [
        { id: "move-ledger", state: "design", tasks: [] },
        { id: "add-limit", state: "define", tasks: [] },
      ],
    });
    expect(steps.map((x) => [x.step, x.change ?? null])).toEqual([
      ["answer", "add-limit"],
      ["feature", "add-limit"],
      ["answer", null],
      ["architecture", "move-ledger"],
    ]);
    expect(steps[0]!.why).toBe(
      "1 question of add-limit is waiting for a person: q-aaaaaaaaaaaa. Its stage goes on once it is answered.",
    );
    expect(steps[2]!.why).toContain("11 questions are waiting for a person");
    expect(steps[2]!.why).not.toContain("q-aaaaaaaaaaaa");
  });
});

describe("atticus next with a change in hand, and the assistant that was probed", () => {
  it("reads the change whose stage is in progress as the one in hand", async () => {
    const root = await metarepo({ clone: true });
    await component(root, "forge-notes");
    await component(root, "forge-notes-ui");
    const dir = join(root, "openspec/changes/add-fraud-check");
    await cp(join(FIXTURES, "stages/changes/add-fraud-check"), dir, { recursive: true });
    await mkdir(join(dir, "stage"), { recursive: true });
    await writeFile(
      join(dir, "stage/feature.yaml"),
      "schemaVersion: 1\nchange: add-fraud-check\nstage: feature\niteration: 1\nstate: questions\nupdatedAt: 2026-10-25T09:00:00Z\n",
    );
    const at = "2026-10-25T09:00:00Z";
    await raiseQuestions(
      root,
      [
        {
          question: "Is the screen's verdict kept?",
          options: [],
          evidence: ["x:1"],
          scope: "repo",
        },
      ],
      { step: "change-feature", repo: "add-fraud-check", command: "c", rerun: "c", at },
    );
    await raiseQuestions(
      root,
      [{ question: "Is docs/ generated?", options: [], evidence: ["y:1"], scope: "repo" }],
      { step: "map", repo: "forge-notes", command: "c", rerun: "c", at },
    );
    const j = await json(root);
    expect(j.steps[0]).toMatchObject({ step: "answer", change: "add-fraud-check" });
    expect(j.steps[1]).toMatchObject({ step: "feature", change: "add-fraud-check" });
  });

  // ADR 0006 addendum: `openspec status` is a child process, so it is run only where its answer
  // could move the change on — a drafting stage with a later one after it. A change at the last
  // drafting stage, or past them, keeps the stage its state says whatever OpenSpec reports.
  it("asks OpenSpec's status only where its answer could move the change on", () => {
    for (const state of ["draft", "define", "returned", "design"])
      expect(canMoveOn(state), state).toBe(true);
    for (const state of ["plan", "build", "qa", "released", "archived", "post-release-review"])
      expect(canMoveOn(state), state).toBe(false);
  });

  it("names the assistant a probe measured here, not the default's chat", async () => {
    const root = await metarepo({ clone: true });
    await rm(join(root, "org-pack", "scan", "forge-notes-ui.yaml"));
    await writeFile(
      join(root, "org-pack", "runtime.yaml"),
      "schemaVersion: 1\nassistants: { allowed: [copilot, claude-code], default: copilot }\n",
    );
    await mkdir(join(root, ".atticus", "probe"), { recursive: true });
    await writeFile(
      join(root, ".atticus", "probe", "claude-code.yaml"),
      "schemaVersion: 1\nassistant: claude-code\nmeasured: 2026-10-25T09:00:00Z\ntier: 1\nread: true\nwrite: true\nrun: true\nanswered: command\n",
    );
    const r = await run(["next", "--root", root]);
    expect(r.out[1]).toBe("In Claude Code: /atticus-map forge-notes");
  });
});
