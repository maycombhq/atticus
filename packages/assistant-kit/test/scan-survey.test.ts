import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MockRuntime, type AiRequest } from "@maycombhq/ai";
import { fsRepo } from "@maycombhq/sdk";
import { checkSurvey, surveyRepo } from "../src/scan-survey.js";

const NOTES = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures/scan-settings/repos/forge-notes",
);
const NOW = new Date("2026-10-21T12:00:00Z");
const repo = () => fsRepo("forge-notes", NOTES, "a".repeat(40));

const answer = (value: string) =>
  [
    "```yaml",
    "schemaVersion: 1",
    "repo: forge-notes",
    "exclude:",
    '  - { path: "docs/**", why: a generated playground, at: "docs/playground.js:1" }',
    "prefixes:",
    '  - paths: ["src/main/java/**"]',
    "    prefix: /notes-api",
    "    why: server.servlet.context-path",
    '    at: "src/main/resources/application.properties:3"',
    `    value: ${value}`,
    "```",
  ].join("\n");

describe("atticus scan survey (ADR 0075)", () => {
  it("hands the assistant the folders, the entry points found and the config files, then checks its answer", async () => {
    const prompts: string[] = [];
    const replies = [answer("/notes-v1"), answer("/notes-api")];
    const runtime = new MockRuntime(
      (req: AiRequest) => {
        prompts.push(req.pack.prompt);
        return replies[prompts.length - 1]!;
      },
      { now: () => NOW },
    );
    const r = await surveyRepo(repo(), { repoId: "forge-notes", runtime, now: NOW });
    expect(r.status).toBe("drafted");
    expect(r.attempts.map((a) => a.problems)).toEqual([
      [
        "prefixes.0: src/main/resources/application.properties:3 doesn't say /notes-v1, so the prefix /notes-api isn't applied",
      ],
      [],
    ]);
    expect(r.settings?.prefixes[0]?.prefix).toBe("/notes-api");
    expect(prompts[0]).toContain("3: server.servlet.context-path=/notes-api");
    expect(prompts[0]).toMatch(
      /rest GET \/notes\s+\(src\/main\/java\/forge\/notes\/NoteController\.java:\d+\)/,
    );
    expect(prompts[0]).toContain("docs/ 1");
    // The second attempt is told what failed.
    expect(prompts[1]).toContain("doesn't say /notes-v1");
  });

  it("refuses an answer for another repo, globs that match nothing, and text that isn't YAML", async () => {
    const wrong = answer("/notes-api")
      .replace("repo: forge-notes", "repo: forge-other")
      .replace('"docs/**"', '"site/**"');
    expect((await checkSurvey(wrong, repo(), "forge-notes")).problems).toEqual([
      "repo: it is forge-notes, not forge-other",
      "exclude.0: site/** matches no file in the repo",
    ]);
    expect((await checkSurvey("not: [yaml", repo(), "forge-notes")).problems[0]).toMatch(
      /isn't YAML/,
    );
    // Nothing to set is a correct answer.
    const empty = await checkSurvey("schemaVersion: 1\nrepo: forge-notes\n", repo(), "forge-notes");
    expect(empty.problems).toEqual([]);
    expect(empty.settings).toMatchObject({ exclude: [], prefixes: [] });
  });
});

const QUESTIONS = [
  "schemaVersion: 1",
  "repo: forge-notes",
  "questions:",
  "  - question: Is docs/ a generated playground or part of the product?",
  "    options:",
  "      - { label: Generated, means: nobody edits it, changes: the scan leaves docs/ out }",
  "      - { label: Product, means: it ships, changes: the scan reads docs/ }",
  '    evidence: ["docs/playground.js:1"]',
  "    scope: repo",
].join("\n");

describe("questions the survey raises when it isn't sure (ADR 0078)", () => {
  it("checks every evidence line exists and returns the questions with the settings", async () => {
    const ok = await checkSurvey(QUESTIONS, repo(), "forge-notes");
    expect(ok.problems).toEqual([]);
    expect(ok.settings).toMatchObject({ exclude: [], prefixes: [] });
    expect(ok.questions).toHaveLength(1);
    expect(ok.questions?.[0]).toMatchObject({
      question: "Is docs/ a generated playground or part of the product?",
      evidence: ["docs/playground.js:1"],
      scope: "repo",
    });
    const bad = QUESTIONS.replace(
      '["docs/playground.js:1"]',
      '["docs/playground.js:400", "docs/gone.js:1"]',
    );
    expect((await checkSurvey(bad, repo(), "forge-notes")).problems).toEqual([
      "questions.0.evidence.0: docs/playground.js has fewer than 400 lines",
      "questions.0.evidence.1: docs/gone.js isn't in the repo",
    ]);
    expect(
      (
        await checkSurvey(
          QUESTIONS.replace("    scope: repo", "    scope: everywhere"),
          repo(),
          "forge-notes",
        )
      ).problems[0],
    ).toMatch(/^questions\.0\.scope/);
  });

  it("puts the answers people gave, and the questions still open, in the rerun's prompt", async () => {
    const prompts: string[] = [];
    const runtime = new MockRuntime(
      (req: AiRequest) => {
        prompts.push(req.pack.prompt);
        return "schemaVersion: 1\nrepo: forge-notes\n";
      },
      { now: () => NOW },
    );
    const asked = {
      schemaVersion: 1 as const,
      askedBy: {
        step: "scan-survey",
        command: "atticus scan survey forge-notes",
        at: NOW.toISOString(),
      },
      repo: "forge-notes",
      options: [
        { label: "Generated", means: "nobody edits it", changes: "the scan leaves docs/ out" },
        { label: "Product", means: "it ships", changes: "the scan reads docs/" },
      ],
      evidence: ["docs/playground.js:1"],
      scope: { level: "repo" as const, id: "forge-notes" },
      rerun: "atticus scan survey forge-notes --force",
    };
    const r = await surveyRepo(repo(), {
      repoId: "forge-notes",
      runtime,
      now: NOW,
      questions: [
        {
          ...asked,
          id: "q-aaaaaaaaaaaa",
          question: "Is docs/ a generated playground?",
          state: "answered",
          answer: {
            option: 1,
            by: "priya.nair",
            at: NOW.toISOString(),
            scope: { level: "repo", id: "forge-notes" },
          },
        },
        {
          ...asked,
          id: "q-bbbbbbbbbbbb",
          question: "Is /notes-api the only prefix?",
          state: "open",
        },
      ],
    });
    expect(r.status).toBe("drafted");
    expect(r.runId).toBeDefined();
    expect(prompts[0]).toContain("Is docs/ a generated playground?");
    expect(prompts[0]).toContain("Answer (priya.nair): Generated");
    expect(prompts[0]).toContain("Is /notes-api the only prefix?");
    expect(prompts[0]).toMatch(/don't ask (it|them) again/i);
  });
});
