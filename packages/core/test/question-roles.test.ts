import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml, stringify } from "yaml";
import {
  listQuestions,
  migrateQuestions,
  Question,
  QUESTION_ROLES,
  QUESTION_SCHEMA_VERSION,
  QuestionDraft,
  questionFromDraft,
  roleOfOwner,
  roleOfQuestion,
  roleOfStep,
  rolesOfPerson,
} from "../src/index.js";

/** ADR 0181 part 4: every question a change's phase raises carries the role that owns it. */

const AT = "2026-11-08T10:00:00Z";

const draft = (extra: Record<string, unknown> = {}) =>
  QuestionDraft.parse({
    question: "Which ledger holds the hold amount?",
    evidence: ["openspec/changes/add-holds/proposal.md:4"],
    ...extra,
  });

const by = (step: string, rerun = `atticus change feature add-holds`) => ({
  step,
  repo: "add-holds",
  command: rerun,
  rerun,
  at: AT,
});

describe("the role of a stage", () => {
  it("is the stage's owner: define product, feature and architecture architecture, stories analysis, tasks delivery", () => {
    expect(QUESTION_ROLES).toEqual(["product", "architecture", "analysis", "delivery"]);
    // Ninth UX walk: the feature stage places the change on the estate, which ADR 0181 gives the
    // architect ("The architect places it on the estate and decides the design").
    expect(roleOfStep("change-feature")).toBe("architecture");
    expect(roleOfStep("change-brief")).toBe("product");
    expect(roleOfStep("change-define")).toBe("product");
    expect(roleOfStep("change-architecture")).toBe("architecture");
    expect(roleOfStep("change-design")).toBe("architecture");
    expect(roleOfStep("change-small")).toBe("architecture");
    expect(roleOfStep("change-stories")).toBe("analysis");
    expect(roleOfStep("change-plan")).toBe("analysis");
    expect(roleOfStep("change-tasks")).toBe("delivery");
    expect(roleOfStep("change-build")).toBe("delivery");
    expect(roleOfStep("task-run")).toBe("delivery");
  });

  it("is read from the rerun command for a step that serves every stage (a gap, a conflict)", () => {
    expect(roleOfStep("context-gap", "atticus change architecture add-holds")).toBe("architecture");
    expect(roleOfStep("knowledge-conflict", "atticus plan stories add-holds")).toBe("analysis");
    expect(roleOfStep("context-gap", "atticus task run add-holds 1.1")).toBe("delivery");
    expect(roleOfStep("context-gap", "atticus change feature add-holds")).toBe("architecture");
  });

  it("is none for a step outside a change's phases (a repo's survey)", () => {
    expect(roleOfStep("scan-survey", "atticus scan survey forge-ledger")).toBeUndefined();
    expect(roleOfStep("map")).toBeUndefined();
  });
});

describe("the role on a question file", () => {
  it("is written when the question is raised, from the stage that raised it", () => {
    const q = questionFromDraft(draft(), by("change-architecture"));
    expect(q.schemaVersion).toBe(QUESTION_SCHEMA_VERSION);
    expect(q.role).toBe("architecture");
  });

  it("is the question's own when it says otherwise", () => {
    const q = questionFromDraft(draft({ role: "product" }), by("change-architecture"));
    expect(q.role).toBe("product");
  });

  it("is left out where no stage owns it", () => {
    const q = questionFromDraft(draft(), {
      ...by("scan-survey", "atticus scan survey forge-ledger"),
      repo: "forge-ledger",
    });
    expect(q.role).toBeUndefined();
    expect(Object.keys(q)).not.toContain("role");
  });

  it("refuses a role that isn't one of the four", () => {
    expect(() => draft({ role: "developer" })).toThrow();
  });

  it("is derived on read for an older file, which reads unchanged", () => {
    const old = {
      schemaVersion: 4,
      id: "q-0123456789ab",
      askedBy: { step: "change-stories", command: "atticus plan stories add-holds", at: AT },
      repo: "add-holds",
      question: "Does a hold expire?",
      evidence: ["openspec/changes/add-holds/stories.md:3"],
      scope: { level: "repo", id: "add-holds" },
      state: "open",
      rerun: "atticus plan stories add-holds",
    };
    const q = Question.parse(old);
    expect(q.role).toBeUndefined();
    expect(roleOfQuestion(q)).toBe("analysis");
    // A role on the file wins over the stage.
    expect(roleOfQuestion({ ...q, role: "delivery" })).toBe("delivery");
  });
});

describe("the migration", () => {
  it("writes a version-4 file at the current version, adding nothing else", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-roles-"));
    await mkdir(join(root, "questions"), { recursive: true });
    const file = join(root, "questions", "q-0123456789ab.yaml");
    await writeFile(
      file,
      stringify({
        schemaVersion: 4,
        id: "q-0123456789ab",
        askedBy: { step: "change-feature", command: "atticus change feature add-holds", at: AT },
        repo: "add-holds",
        question: "Who places a hold?",
        evidence: ["openspec/changes/add-holds/proposal.md:2"],
        scope: { level: "repo", id: "add-holds" },
        state: "open",
        rerun: "atticus change feature add-holds",
      }),
    );
    expect(await migrateQuestions(root, { dryRun: true })).toEqual([
      "questions/q-0123456789ab.yaml",
    ]);
    await migrateQuestions(root);
    const y = parseYaml(await readFile(file, "utf8")) as Record<string, unknown>;
    expect(y.schemaVersion).toBe(QUESTION_SCHEMA_VERSION);
    expect(y.role).toBeUndefined();
    const { questions } = await listQuestions(root);
    expect(roleOfQuestion(questions[0]!)).toBe("architecture");
    expect(await migrateQuestions(root, { dryRun: true })).toEqual([]);
  });

  it("writes a version-5 file at version 6 (ADR 0191), once", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-roles-"));
    await mkdir(join(root, "questions"), { recursive: true });
    const file = join(root, "questions", "q-0123456789ac.yaml");
    await writeFile(
      file,
      stringify({
        schemaVersion: 5,
        id: "q-0123456789ac",
        askedBy: { step: "change-feature", command: "atticus change feature add-holds", at: AT },
        repo: "add-holds",
        question: "How long does a hold last?",
        evidence: ["openspec/changes/add-holds/proposal.md:3"],
        scope: { level: "repo", id: "add-holds" },
        state: "open",
        rerun: "atticus change feature add-holds",
        role: "product",
      }),
    );
    expect(await migrateQuestions(root, { dryRun: true })).toEqual([
      "questions/q-0123456789ac.yaml",
    ]);
    expect(await migrateQuestions(root)).toEqual(["questions/q-0123456789ac.yaml"]);
    const y = parseYaml(await readFile(file, "utf8")) as Record<string, unknown>;
    expect(y.schemaVersion).toBe(6);
    expect(y.role).toBe("product");
    expect(y.asks).toBeUndefined();
    expect(await migrateQuestions(root, { dryRun: true })).toEqual([]);
    expect(await migrateQuestions(root)).toEqual([]);
  });
});

describe("a person's roles on a change", () => {
  it("are read from change.yaml's owners, by what each owner key does", () => {
    expect(roleOfOwner("product-owner")).toBe("product");
    expect(roleOfOwner("architect")).toBe("architecture");
    expect(roleOfOwner("data-architect")).toBe("architecture");
    expect(roleOfOwner("business-analyst")).toBe("analysis");
    expect(roleOfOwner("team-lead")).toBe("delivery");
    expect(roleOfOwner("tech-lead")).toBe("delivery");
    expect(roleOfOwner("developer")).toBe("delivery");
    expect(roleOfOwner("qa")).toBeUndefined();
    const owners = {
      "product-owner": ["pat"],
      architect: ["@Ari"],
      "team-lead": ["ari", "sam"],
      qa: ["cy"],
    };
    expect(rolesOfPerson("ari", owners)).toEqual(["architecture", "delivery"]);
    expect(rolesOfPerson("pat", owners)).toEqual(["product"]);
    expect(rolesOfPerson("cy", owners)).toEqual([]);
    expect(rolesOfPerson("nobody", owners)).toEqual([]);
  });

  it("follow roles.yaml's custom roles to the built-in role each is based on", () => {
    const custom = [{ id: "solution-designer", name: "Solution designer", basedOn: "architect" }];
    expect(roleOfOwner("solution-designer", custom)).toBe("architecture");
    expect(rolesOfPerson("lee", { "solution-designer": ["lee"] }, custom)).toEqual([
      "architecture",
    ]);
  });
});
