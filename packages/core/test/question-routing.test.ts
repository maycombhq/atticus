import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml, stringify } from "yaml";
import {
  asksOfFinding,
  asksOfPhase,
  asksOfQuestion,
  migrateRolesText,
  nextOwnersOf,
  Question,
  QUESTION_SCHEMA_VERSION,
  QuestionDraft,
  questionFromDraft,
  readQuestion,
  roleOfAsks,
  roleOfQuestion,
  Roles,
  routeQuestion,
  writeQuestion,
} from "../src/index.js";

/**
 * ADR 0189: a question is routed by what it asks (business, design, delivery), a person can
 * re-route it, a finding is told business from design, and a hand-off waits on the next role.
 */

const AT = "2026-11-09T10:00:00Z";
const by = (step: string, rerun = "atticus change feature add-holds") => ({
  step,
  repo: "add-holds",
  command: rerun,
  rerun,
  at: AT,
});
const money = (asks?: string) =>
  QuestionDraft.parse({
    question: "What happens when the account has too little money on the day?",
    evidence: ["openspec/changes/add-holds/brief.md:4"],
    ...(asks ? { asks } : {}),
  });

describe("a question is routed by what it asks", () => {
  it("is version 6", () => {
    expect(QUESTION_SCHEMA_VERSION).toBe(6);
  });

  it("goes to the product owner when the feature stage asks a business question", () => {
    const q = questionFromDraft(money("business"), by("change-feature"));
    expect(q.asks).toBe("business");
    expect(q.role).toBe("product");
    expect(roleOfQuestion(q)).toBe("product");
  });

  it("goes to the architect for design and the tech lead for delivery, whichever stage asked", () => {
    expect(questionFromDraft(money("design"), by("change-define")).role).toBe("architecture");
    expect(questionFromDraft(money("delivery"), by("change-stories")).role).toBe("delivery");
  });

  it("goes to the business analyst for a business question from the stories on", () => {
    expect(roleOfAsks("business", "analysis")).toBe("analysis");
    expect(roleOfAsks("business", "delivery")).toBe("analysis");
    expect(roleOfAsks("business", "architecture")).toBe("product");
    expect(questionFromDraft(money("business"), by("change-stories")).role).toBe("analysis");
  });

  it("keeps the stage's role when the draft doesn't say, and a draft's role wins", () => {
    expect(questionFromDraft(money(), by("change-feature")).role).toBe("architecture");
    const own = QuestionDraft.parse({ ...money("design"), role: "product" });
    expect(questionFromDraft(own, by("change-feature")).role).toBe("product");
  });

  it("says what an untagged question asks from its role", () => {
    const q = questionFromDraft(money(), by("change-feature"));
    expect(q.asks).toBeUndefined();
    expect(asksOfQuestion(q)).toBe("design");
  });

  it("reads a version 5 file as it is, at version 6 in memory", () => {
    const q = questionFromDraft(money("business"), by("change-feature"));
    const { asks: _a, ...old } = { ...q, schemaVersion: 5 } as Record<string, unknown>;
    const read = Question.parse(old);
    expect(read.schemaVersion).toBe(6);
    expect(read.asks).toBeUndefined();
  });
});

describe("a person re-routes a question", () => {
  it("moves it to another role, saying from which, by whom and when, and keeps the file", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-route-"));
    await mkdir(join(root, "questions"), { recursive: true });
    await writeFile(join(root, "metarepo.yaml"), "schemaVersion: 1\n");
    const q = questionFromDraft(money(), by("change-feature"));
    await writeQuestion(root, q);
    const routed = await routeQuestion(root, q.id, { role: "product", by: "@ari", at: AT });
    expect(routed.role).toBe("product");
    expect(routed.routed).toEqual({ from: "architecture", by: "ari", at: AT });
    const again = await readQuestion(root, q.id);
    expect(again?.role).toBe("product");
    const text = await readFile(join(root, "questions", `${q.id}.yaml`), "utf8");
    expect(
      (parseYaml(text.split("\n").slice(1).join("\n")) as { schemaVersion: number }).schemaVersion,
    ).toBe(6);
    // The same role again changes nothing.
    const same = await routeQuestion(root, q.id, { role: "product", by: "pat", at: AT });
    expect(same.routed?.by).toBe("ari");
  });

  it("refuses a question that isn't there", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-route-"));
    await expect(
      routeQuestion(root, "q-000000000000", { role: "product", by: "ari", at: AT }),
    ).rejects.toThrow(/no question/);
  });
});

describe("what a finding asks", () => {
  it("tells a business finding on the brief from a design one (the audit's circuit breakers)", () => {
    expect(
      asksOfFinding({
        artifact: "brief.md",
        summary: "The brief doesn't say who approves a hold.",
      }),
    ).toBe("business");
    expect(
      asksOfFinding({
        artifact: "brief.md",
        rule: "constitution.hop-resilience-stated",
        summary: "No circuit breaker is named for the ledger call.",
      }),
    ).toBe("design");
    expect(
      asksOfFinding({ artifact: "proposal.md", summary: "No alert is raised when holds fail." }),
    ).toBe("design");
  });

  it("goes by the file: the design's files are design, tasks and the release delivery", () => {
    expect(asksOfFinding({ artifact: "design.md", summary: "x" })).toBe("design");
    expect(asksOfFinding({ artifact: "target-flows/forge-ledger.holds.yaml", summary: "x" })).toBe(
      "design",
    );
    expect(asksOfFinding({ artifact: "tasks.md", summary: "x" })).toBe("delivery");
    expect(
      asksOfFinding({
        artifact: "stories/s1-holds.md",
        summary: "No criterion for a refused hold.",
      }),
    ).toBe("business");
  });

  it("holds a change in Define only at the business level", () => {
    expect(asksOfPhase("define")).toEqual(["business"]);
    expect(asksOfPhase("design")).toEqual(["business", "design"]);
    expect(asksOfPhase("plan")).toEqual(["business", "design", "delivery"]);
  });
});

describe("who a hand-off waits on", () => {
  const owners = {
    "product-owner": ["pia"],
    architect: ["@ari"],
    "business-analyst": ["bea"],
    "team-lead": ["tom", "@forge/leads"],
  };
  it("is the next role's owners", () => {
    expect(nextOwnersOf("define", owners)).toEqual({ role: "architect", people: ["ari"] });
    expect(nextOwnersOf("design", owners)).toEqual({ role: "business-analyst", people: ["bea"] });
    // A team handle is no person to name.
    expect(nextOwnersOf("plan", owners)).toEqual({ role: "team-lead", people: ["tom"] });
    expect(nextOwnersOf("archived", owners)).toBeUndefined();
  });
});

describe("roles.yaml version 3: who takes each role", () => {
  const v3 = {
    schemaVersion: 3,
    teams: [
      {
        id: "team-ledger",
        people: ["ari", "tom"],
        roles: { architect: ["ari"], "team-lead": ["tom"] },
      },
    ],
    defaults: { "product-owner": ["pia"], "business-analyst": ["bea"] },
  };
  it("reads a team's roles and the defaults", () => {
    const r = Roles.parse(v3);
    expect(r.teams[0]!.roles?.architect).toEqual(["ari"]);
    expect(r.defaults?.["product-owner"]).toEqual(["pia"]);
  });
  it("refuses them below version 3, and an unknown role", () => {
    expect(Roles.safeParse({ ...v3, schemaVersion: 2 }).success).toBe(false);
    expect(Roles.safeParse({ ...v3, defaults: { wizard: ["x"] } }).success).toBe(false);
  });
  it("is reached from version 1 and 2 by the number alone", () => {
    const two = "# who is who\nschemaVersion: 2 # kept\nteams: []\n";
    expect(migrateRolesText(two)).toEqual({
      text: "# who is who\nschemaVersion: 3 # kept\nteams: []\n",
      changed: true,
    });
    expect(migrateRolesText("schemaVersion: 1\n").text).toBe("schemaVersion: 3\n");
    expect(migrateRolesText(stringify(v3)).changed).toBe(false);
  });
});
