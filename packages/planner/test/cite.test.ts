import { describe, expect, it } from "vitest";
import { citeFiles } from "../src/stages/cite.js";

/** A line cited by the data block it was read in is read as that block's file (seen with a small model). */

const blocks = [
  { id: "brief.md", origin: "openspec/changes/add-fraud-check/brief.md" },
  { id: "estate-index", origin: "atticus change small (context engine)" },
  { id: "instructions", origin: "atticus" },
];

describe("citations of a data block", () => {
  it("reads atticus-data:<id>:<line> and <id>:<line> as the block's file and line", () => {
    expect(citeFiles("evidence: [atticus-data:brief.md:5]", blocks)).toBe(
      "evidence: [openspec/changes/add-fraud-check/brief.md:5]",
    );
    expect(citeFiles("evidence: [brief.md:3, brief.md:7]", blocks)).toBe(
      "evidence: [openspec/changes/add-fraud-check/brief.md:3, openspec/changes/add-fraud-check/brief.md:7]",
    );
  });

  it("leaves a path that only ends in the id, and a block that isn't a file, as they are", () => {
    expect(citeFiles("evidence: [docs/brief.md:5]", blocks)).toBe("evidence: [docs/brief.md:5]");
    expect(citeFiles("evidence: [openspec/changes/add-fraud-check/brief.md:5]", blocks)).toBe(
      "evidence: [openspec/changes/add-fraud-check/brief.md:5]",
    );
    expect(citeFiles("evidence: [estate-index:line]", blocks)).toBe(
      "evidence: [estate-index:line]",
    );
    expect(citeFiles("evidence: [atticus-data:estate-index:4]", blocks)).toBe(
      "evidence: [atticus-data:estate-index:4]",
    );
  });
});

describe("a question that cites no file and line", () => {
  it("is left out, and said; a question with one good line keeps it and drops the rest", async () => {
    const { dropUncitedQuestions } = await import("../src/stages/uncited.js");
    const d = {
      questions: [
        { question: "Which format?", options: [], evidence: ["estate-index:line"] },
        { question: "Kept for how long?", options: [], evidence: ["brief.md:5", "estate-index"] },
        { question: "Fine", options: [], evidence: ["openspec/changes/x/brief.md:3"] },
      ],
    };
    const said = dropUncitedQuestions(d);
    expect(d.questions.map((q) => [q.question, q.evidence])).toEqual([
      ["Kept for how long?", ["brief.md:5"]],
      ["Fine", ["openspec/changes/x/brief.md:3"]],
    ]);
    expect(said.map((i) => [i.rule, i.blocking])).toEqual([
      ["repair.question-without-evidence", false],
      ["repair.question-evidence", false],
    ]);
  });
});

describe("a criterion that names a field in words", () => {
  it("names it when it holds the field, or every word of it", async () => {
    const { namesField } = await import("../src/stages/stories.js");
    expect(namesField("then I can see the renamed timestamp", "renamedAt")).toBe(true);
    expect(namesField("then renamedAt is set", "renamedAt")).toBe(true);
    expect(namesField("then the fraud verdict is shown", "fraud_verdict")).toBe(true);
    expect(namesField("then the verdict is shown", "fraud_verdict")).toBe(false);
    expect(namesField("then the order is saved", "id")).toBe(false);
    expect(namesField("then the order's id comes back", "id")).toBe(true);
  });
});

describe("where a new migration goes", () => {
  it("goes in the folder the store's migrations are in, when they are in one", async () => {
    const { migrationPath } = await import("../src/task-context.js");
    const { estateOf } = await import("../src/index.js");
    const e = estateOf(
      [
        { kind: "Table", id: "db.chat", dataStore: "db" },
        {
          kind: "Migration",
          id: "db.v1",
          dataStore: "db",
          file: "api/src/main/resources/db/migration/V1__a.sql",
        },
        {
          kind: "Migration",
          id: "db.v2",
          dataStore: "db",
          file: "api/src/main/resources/db/migration/V2__b.sql",
        },
      ] as never,
      [],
    );
    expect(migrationPath("V3__c.sql", "db.chat", e)).toBe(
      "api/src/main/resources/db/migration/V3__c.sql",
    );
    expect(migrationPath("db/V3__c.sql", "db.chat", e)).toBe("db/V3__c.sql");
    expect(migrationPath("V3__c.sql", "other.t", e)).toBe("V3__c.sql");
  });
});
