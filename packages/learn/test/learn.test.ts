import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { MockRuntime } from "@maycombhq/ai";
import { CORE_ROLES, catalogDirOf } from "@maycombhq/core";
import { scanEstate, writeCatalog } from "@maycombhq/scanner";
import {
  answerSet,
  checkStep,
  commandNamed,
  COMMANDS,
  createSandbox,
  explain,
  isSandbox,
  loadLessons,
  readProgress,
  runCheck,
  SANDBOX_MARKER,
  startLesson,
  truthOf,
  type SandboxInfo,
} from "../src/index.js";

const NOW = new Date("2026-10-20T09:00:00Z");

describe("lessons as data", () => {
  it("every built-in lesson is valid, and every core role has a complete one", async () => {
    const { lessons, problems } = await loadLessons();
    expect(problems).toEqual([]);
    for (const role of CORE_ROLES)
      expect(
        lessons.some((l) => l.role === role),
        `a lesson for ${role}`,
      ).toBe(true);
    expect(lessons.map((l) => l.role)).toEqual([...CORE_ROLES]);
    for (const l of lessons) {
      expect(l.steps.length, l.id).toBeGreaterThanOrEqual(3);
      for (const s of l.steps) {
        // every command a lesson asks for is in the command reference
        for (const argv of s.do)
          expect(
            commandNamed(argv.join(" ")),
            `${l.id}/${s.id}: atticus ${argv.join(" ")}`,
          ).toBeDefined();
        // answer steps carry a worked answer, so the lesson can be checked end to end
        const answers =
          s.check.type === "answer" ||
          (s.check.type === "all" && s.check.checks.some((c) => c.type === "answer"));
        if (answers)
          expect(s.solution?.answer, `${l.id}/${s.id} needs a worked answer`).toBeTruthy();
      }
    }
  });

  it("lets an organisation add or replace lessons from its org pack", async () => {
    const pack = await mkdtemp(join(tmpdir(), "atticus-learn-pack-"));
    await mkdir(join(pack, "learn/lessons"), { recursive: true });
    await writeFile(
      join(pack, "learn/lessons/ours.yaml"),
      [
        "schemaVersion: 1",
        "id: developer-find-your-way",
        "role: developer",
        "title: Our own first steps",
        "summary: Ours.",
        "minutes: 5",
        "intro: Hello.",
        "steps:",
        "  - { id: one, title: One, body: Do it., check: { type: index-built }, hint: Build the index. }",
        "outro: Bye.",
      ].join("\n"),
    );
    await writeFile(join(pack, "learn/lessons/bad.yaml"), "schemaVersion: 1\nid: x\n");
    const { lessons, problems } = await loadLessons({ orgPackDir: pack });
    expect(lessons.find((l) => l.id === "developer-find-your-way")).toMatchObject({
      title: "Our own first steps",
      source: "org-pack/learn/lessons/ours.yaml",
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^org-pack\/learn\/lessons\/bad\.yaml: /);
  });

  it("compares answers as sets of words", () => {
    expect(answerSet("Reports-Job and ledger-api.")).toEqual(["ledger-api", "reports-job"]);
    expect(answerSet("`S.GW.SRO`")).toEqual(["s.gw.sro"]);
    expect(answerSet("ux.md")).toEqual(["ux.md"]);
  });

  it("knows every command by its longest name", () => {
    expect(commandNamed("atticus change handoff x --by pat")!.name).toBe("change handoff");
    expect(commandNamed("todo")!.name).toBe("todo");
    expect(commandNamed("nonsense here")).toBeUndefined();
    expect(new Set(COMMANDS.map((c) => c.name)).size).toBe(COMMANDS.length);
  });
});

describe("the practice sandbox", () => {
  let sb: SandboxInfo;
  beforeAll(async () => {
    sb = await createSandbox(join(await mkdtemp(join(tmpdir(), "atticus-sandbox-")), "sb"), {
      now: NOW,
    });
  });

  it("is a metarepo built from Forge with the seeded change and committed base clones", async () => {
    expect(sb.repos).toEqual([
      "forge-events",
      "forge-gateway",
      "forge-infra",
      "forge-ledger",
      "forge-portal-bff",
      "forge-portal-ui",
      "forge-reports-job",
    ]);
    expect(await isSandbox(sb.root)).toBe(true);
    expect(existsSync(join(sb.root, "org-pack/agents/story-critic.yaml"))).toBe(true);
    expect(existsSync(join(sb.root, "openspec/changes/add-transfer-limit/change.yaml"))).toBe(true);
    expect(existsSync(join(sb.root, "workspace/forge-ledger/.git"))).toBe(true);
    expect(JSON.parse(await readFile(join(sb.root, SANDBOX_MARKER), "utf8"))).toMatchObject({
      sandbox: 1,
      createdAt: NOW.toISOString(),
    });
    await expect(createSandbox(sb.dir)).rejects.toThrow(/isn't empty/);
  });

  it("refuses lessons outside a sandbox", async () => {
    const other = await mkdtemp(join(tmpdir(), "atticus-not-sandbox-"));
    await expect(startLesson(other, "developer")).rejects.toThrow(/isn't a practice sandbox/);
    expect(await isSandbox(other)).toBe(false);
  });

  it("runs a lesson: a step fails until it is done, passes after, and progress is kept", async () => {
    const start = await startLesson(sb.root, "developer", { now: NOW });
    expect(start.lesson.id).toBe("developer-find-your-way");
    expect(start.step!.id).toBe("scan");
    let r = await checkStep(sb.root, { now: NOW });
    expect(r.result).toEqual({
      pass: false,
      message: "The catalog has 0 Interface records; it needs 7.",
    });
    const scan = await scanEstate({ root: sb.root });
    await writeCatalog(join(catalogDirOf(sb.root), "generated"), scan.records);
    r = await checkStep(sb.root, { now: NOW });
    expect(r.result.pass).toBe(true);
    expect(r.next!.id).toBe("callers");
    r = await checkStep(sb.root, { answer: "ledger-api", now: NOW });
    expect(r.result).toEqual({
      pass: false,
      message: "Not quite: some of that is wrong and something is missing.",
    });
    r = await checkStep(sb.root, { answer: "portal-bff", now: NOW });
    expect(r.result).toEqual({ pass: true, message: "Right." });
    r = await checkStep(sb.root, { answer: "reports-job", now: NOW });
    expect(r.result.message).toBe("Not quite: there is more (1 missing).");
    r = await checkStep(sb.root, { answer: "reports-job, ledger-api", now: NOW });
    expect(r.result.pass).toBe(true);
    r = await checkStep(sb.root, { answer: "direct", now: NOW });
    expect(r.completed).toBe(true);
    const p = await readProgress(sb.root);
    expect(p.current).toBe("developer-find-your-way");
    expect(Object.keys(p.lessons["developer-find-your-way"]!.steps)).toEqual([
      "scan",
      "callers",
      "readers",
      "explain",
    ]);
    expect(p.lessons["developer-find-your-way"]!.completedAt).toBe("2026-10-20T09:00:00Z");
    // starting again resumes without running the setup
    const again = await startLesson(sb.root, "developer-find-your-way");
    expect(again).toMatchObject({ resumed: true, setup: [] });
    expect(again.step).toBeUndefined();
  });

  it("works out right answers from the sandbox itself", async () => {
    expect(
      await truthOf(sb.root, { from: "unknown-pattern", change: "add-transfer-limit" }),
    ).toEqual(["s.gw.sro"]);
    expect(
      await truthOf(sb.root, { from: "stories-without-criteria", change: "add-transfer-limit" }),
    ).toEqual(["s2-show-remaining"]);
    expect(
      await truthOf(sb.root, {
        from: "flagged-files",
        path: "openspec/changes/add-transfer-limit/stories",
      }),
    ).toEqual(["s3-audit-refusals"]);
    expect(await truthOf(sb.root, { from: "change-state", change: "add-transfer-limit" })).toEqual([
      "plan",
    ]);
    expect(await truthOf(sb.root, { from: "systems-without-owner" })).toEqual([
      "audit",
      "northwind-pay",
    ]);
    expect(await truthOf(sb.root, { from: "system-owner", id: "ledger" })).toEqual(["team-ledger"]);
    expect(
      await truthOf(sb.root, { from: "feature-of", entryPoint: "ledger-api.post-transfer" }),
    ).toEqual(["feature.transfers"]);
    expect(
      await runCheck(sb.root, {
        type: "answer",
        question: "q",
        truth: { from: "fixed", values: ["x"] },
      }),
    ).toEqual({
      pass: false,
      message: "Answer the question: q",
    });
  });

  it("explains records, changes, commands and unknown things in plain words", async () => {
    const rec = await explain(sb.root, "if-e7344c9455608119");
    expect(rec.kind).toBe("record");
    expect(rec.title).toBe(
      "if-e7344c9455608119 is an interface: one component calling or messaging another.",
    );
    expect(rec.lines[0]).toBe(
      "ledger-api calls northwind-pay with POST /v2/payments, directly, waiting for the answer.",
    );
    expect(rec.lines).toContain("No integration pattern is recorded for it.");
    expect(rec.lines.some((l) => l.startsWith("Its confidence is verified"))).toBe(true);

    const table = await explain(sb.root, "ledger-db.entry");
    expect(table.lines).toContain("Read by ledger-api, reports-job.");

    const change = await explain(sb.root, "add-transfer-limit");
    expect(change).toMatchObject({
      kind: "change",
      title: 'add-transfer-limit is a change: "Add a daily transfer limit" (feature).',
    });
    expect(change.lines[0]).toBe(
      "It is in Plan: stories, tasks and service-desk requests are written.",
    );

    const cmd = await explain(sb.root, "atticus change handoff");
    expect(cmd.kind).toBe("command");
    expect(cmd.lines).toContain(
      "It writes to a shared system, so it needs your approval each time (--approve; it shows what it would do first).",
    );
    expect((await explain(sb.root, "scan")).kind).toBe("command");

    const none = await explain(sb.root, "no-such-thing");
    expect(none.kind).toBe("unknown");

    const ai = await explain(sb.root, "ledger-db.entry", {
      runtime: new MockRuntime((req) =>
        req.pack.prompt.includes("Read by ledger-api") ? "A table two components read." : "",
      ),
      now: NOW,
    });
    expect(ai.reworded).toBe("A table two components read.");
    expect(ai.lines).toEqual(table.lines);
  });
});
