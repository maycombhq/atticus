import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseRecord, raiseQuestions, recordPath, serializeRecord } from "@maycombhq/core";
import { main } from "../src/main.js";
import { nextSteps, type NextState, type NextStep } from "../src/next-commands.js";

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

  it("with repos not cloned, says to sync, and lists the rest with --all", async () => {
    const root = await metarepo();
    const r = await run(["next", "--root", root]);
    expect(r.out[0]).toBe("Next: atticus workspace sync");
    expect(r.out[1]).toBe("Why: 2 repos aren't cloned yet: forge-notes, forge-notes-ui.");
    expect(r.out[2]).toBe("1 more step after this one: atticus next --all");
    const all = await run(["next", "--all", "--root", root]);
    expect(all.out[0]).toBe("1. atticus workspace sync");
    expect(all.out[2]).toBe('2. atticus change new "<title>" --type <type>');
  });

  it("with a repo cloned but not surveyed, gives the survey and its slash command, then the scan", async () => {
    const root = await metarepo({ clone: true });
    await rm(join(root, "org-pack", "scan", "forge-notes-ui.yaml"));
    const r = await run(["next", "--root", root]);
    expect(r.out.slice(0, 2)).toEqual([
      "Next: atticus scan survey forge-notes-ui",
      "In Copilot Chat: /atticus-survey forge-notes-ui",
    ]);
    const j = await json(root);
    expect(commands(j.steps)).toEqual([
      ["atticus scan survey forge-notes-ui", "/atticus-survey forge-notes-ui"],
      ["atticus scan", null],
      ['atticus change new "<title>" --type <type>', null],
    ]);
    expect(j.steps[1]!.why).toBe("forge-notes, forge-notes-ui haven't been scanned yet.");
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
      ["atticus questions list --state open", "/atticus-answer"],
      ["atticus spec draft forge-notes", "/atticus-spec forge-notes"],
      ["atticus spec draft forge-notes-ui", "/atticus-spec forge-notes-ui"],
      ['atticus change new "<title>" --type <type>', null],
    ]);
    expect(j.next.person).toBe(true);
    expect(j.steps[2]!.why).toContain(q);
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
});
