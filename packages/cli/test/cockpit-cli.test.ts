import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { startServer, type RunningServer } from "@maycombhq/server";
import { cockpit, glanceNextStep } from "../src/cockpit.js";
import { uiCockpitRoutes } from "../src/ui-api-cockpit.js";

/**
 * The change cockpit (WP7.1): one change at a glance, from what change status, next and the
 * stage files already say. Over the invented Forge fixtures of the fast path (ADR 0113).
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
const CHANGE = "return-order-time";

async function estate(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-cockpit-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  const rows = [
    ...(parse(readFileSync(join(FIXTURES, "specs/catalog.yaml"), "utf8")) as unknown[]),
    ...(parse(readFileSync(join(FIXTURES, "stages/catalog-extra.yaml"), "utf8")) as unknown[]),
  ];
  for (const r of rows) {
    const p = parseRecord(r);
    if (!p.ok) throw new Error("bad fixture record");
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  await cp(join(FIXTURES, "stages/specs"), join(root, "specs"), { recursive: true });
  await cp(join(FIXTURES, "stages/changes"), join(root, "openspec/changes"), { recursive: true });
  await cp(join(FIXTURES, "stages/small", CHANGE), join(root, "openspec/changes", CHANGE), {
    recursive: true,
  });
  return root;
}

let root: string;
let srv: RunningServer;

beforeAll(async () => {
  root = await estate();
  srv = await startServer({
    root,
    port: 0,
    user: "priya.nair",
    watch: false,
    extend: (r, ctx) => uiCockpitRoutes(r, ctx),
  });
});
afterAll(() => srv?.close());

describe("the change cockpit (WP7.1)", () => {
  it("says where the change is, its next step with the slash command, and each stage", async () => {
    const c = await cockpit(root, CHANGE);
    expect(c.id).toBe(CHANGE);
    expect(c.state).toBeTruthy();
    expect(c.nextStep).toBeTruthy();
    expect(c.stages.map((s) => s.stage)).toEqual(["feature", "architecture", "stories"]);
    // Beta.27 review: a small change in plan never ran the stages before it: they read as
    // skipped (never "to come"), and its own stage hasn't started.
    expect(c.stages.map((s) => s.state)).toEqual(["skipped", "skipped", "not-started"]);
    expect(c.stages.every((s) => s.drafts === 0)).toBe(true);
    // The next step atticus next gives for this change: the fast path, in the assistant.
    expect(c.next?.change).toBe(CHANGE);
    expect(c.next?.slash).toMatch(/^\/atticus-/);
    expect(c.repos).toEqual([]);
  });

  it("beta.27: never says ready to raise while its next step is something else", () => {
    const type = { phases: ["define", "design", "plan", "build"] } as never;
    const report = {
      nextStep: 'Ready to raise "Plan ready".',
      ready: true,
      type,
      phase: "plan" as const,
      blockers: [],
    };
    // Beta.26: "Ready to raise "Plan ready"" over "1 question … is waiting for a person".
    expect(glanceNextStep(report, { step: "answer" })).toBe(
      'Not ready to raise "Plan ready" yet: the step below comes first.',
    );
    expect(glanceNextStep(report, { step: "stories" })).not.toMatch(/^Ready to raise/);
    // The gate's own step: ready it is.
    expect(glanceNextStep(report, { step: "handoff" })).toBe('Ready to raise "Plan ready".');
    expect(glanceNextStep(report, undefined)).toBe('Ready to raise "Plan ready".');
    // What change status says otherwise stands.
    const blocked = {
      ...report,
      nextStep: 'Finish the plan work, then raise "Plan ready".',
      ready: false,
      blockers: [{ code: "stage-not-done", message: "x" }],
    } as never;
    expect(glanceNextStep(blocked, { step: "answer" })).toBe(
      'Finish the plan work, then raise "Plan ready".',
    );
  });

  it("beta.27 review: reads the report's ready, never its sentence's words", () => {
    const type = { phases: ["define", "design", "plan", "build"] } as never;
    // A sentence worded otherwise (a later rewording, another language) still reads as ready.
    const reworded = { nextStep: "Plan ready can be raised.", ready: true, type, phase: "plan" };
    expect(glanceNextStep(reworded as never, { step: "answer" })).toBe(
      'Not ready to raise "Plan ready" yet: the step below comes first.',
    );
    // A sentence that looks ready but isn't, by the report, is left as it is.
    const notReady = {
      nextStep: 'Ready to raise "Plan ready".',
      ready: false,
      type,
      phase: "plan",
    };
    expect(glanceNextStep(notReady as never, { step: "answer" })).toBe(
      'Ready to raise "Plan ready".',
    );
  });

  it("beta.27 review: in the release phase, the release PRs and the release are go/no-go's own steps", () => {
    const type = { phases: ["define", "design", "plan", "build", "qa", "release"] } as never;
    const report = {
      nextStep: 'Ready to raise "Go/no-go".',
      ready: true,
      type,
      phase: "release" as const,
    };
    for (const step of ["release", "release-prs", "release-prs-merge", "handoff"])
      expect(glanceNextStep(report, { step }), step).toBe('Ready to raise "Go/no-go".');
    // Anything else still comes first.
    expect(glanceNextStep(report, { step: "answer" })).toBe(
      'Not ready to raise "Go/no-go" yet: the step below comes first.',
    );
    // Outside the release phase a release step is no gate's own.
    expect(
      glanceNextStep(
        { ...report, nextStep: 'Ready to raise "QA sign-off".', phase: "qa" },
        { step: "release-prs" },
      ),
    ).toBe('Not ready to raise "QA sign-off" yet: the step below comes first.');
  });

  it("beta.27 review: change status's report says ready to raise in a field of its own", async () => {
    const { changeReport } = await import("@maycombhq/changes");
    const r = await changeReport(root, CHANGE);
    expect(typeof r.ready).toBe("boolean");
    expect(r.ready).toBe(r.nextStep.startsWith("Ready to raise"));
  });

  it("is served by the local API, and a change that isn't there is not found", async () => {
    const call = async (path: string) => {
      const r = await fetch(srv.url + path, { headers: { "X-Atticus-Token": srv.token } });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
    const ok = await call(`/api/changes/${CHANGE}/cockpit`);
    expect(ok.status).toBe(200);
    expect(ok.body.id).toBe(CHANGE);
    expect((await call("/api/changes/no-such-change/cockpit")).status).toBe(404);
  });
});

describe("a stage's questions on the cockpit (WP7.1)", () => {
  it("counts the questions a stage raised, though they are filed under the repo", async () => {
    const at = await estate();
    const { raiseQuestions } = await import("@maycombhq/core");
    const r = await raiseQuestions(
      at,
      [
        {
          question: "How long are a pin's rows kept?",
          options: [],
          evidence: ["src/main/java/forge/Pins.java:3"],
          scope: "repo",
        },
      ],
      {
        step: "change-architecture",
        repo: "forge-notes",
        command: `atticus change architecture ${CHANGE}`,
        rerun: `atticus change architecture ${CHANGE}`,
        at: "2026-10-24T08:00:00Z",
      },
    );
    const id = r.raised[0]!.id;
    await mkdir(join(at, "openspec/changes", CHANGE, "stage"), { recursive: true });
    await writeFile(
      join(at, "openspec/changes", CHANGE, "stage", "architecture.yaml"),
      `schemaVersion: 1\nchange: ${CHANGE}\nstage: architecture\niteration: 3\nstate: waiting\nupdatedAt: 2026-10-24T08:00:00Z\ncritic: []\nquestions:\n  - ${id}\n`,
    );
    const c = await cockpit(at, CHANGE);
    expect(c.stages.find((s) => s.stage === "architecture")).toMatchObject({
      state: "waiting",
      drafts: 3,
      openQuestions: 1,
    });
    expect(c.openQuestions).toBe(1);
    expect(c.stages[0]).not.toHaveProperty("asked");
    // ADR 0181 part 4: the open questions by the role that owns them, and the person's roles.
    expect(c.openQuestionsByRole).toEqual({ architecture: 1 });
    expect(c).not.toHaveProperty("yourRoles");
    const change = join(at, "openspec/changes", CHANGE, "change.yaml");
    await writeFile(
      change,
      (await readFile(change, "utf8")).replace(
        "systems:",
        "owners:\n  architect: [priya.nair]\n  team-lead: [sam]\nsystems:",
      ),
    );
    expect((await cockpit(at, CHANGE, { user: "priya.nair" })).yourRoles).toEqual(["architecture"]);
    expect((await cockpit(at, CHANGE, { user: "cy" })).yourRoles).toEqual([]);
  });
});
