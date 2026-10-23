import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MockRuntime, type AiRequest } from "@maycombhq/ai";
import { loadOrgPack } from "@maycombhq/core";
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
      // ADR 0111: the cited file isn't in the folder and its line doesn't name it.
      "exclude.0: docs/playground.js:1 isn't in site/** and doesn't name it, so site/** is still read",
      "exclude.0: site/** matches no file in the repo",
    ]);
    expect((await checkSurvey("not: [yaml", repo(), "forge-notes")).problems[0]).toMatch(
      /isn't YAML/,
    );
  });

  // ADR 0111: an empty answer is the cheapest one, so it passes only where nothing could apply,
  // or with the lines that show nothing does.
  it("hands back an empty answer for a repo with entry points, unless it says why with the lines it checked", async () => {
    const empty = await checkSurvey("schemaVersion: 1\nrepo: forge-notes\n", repo(), "forge-notes");
    expect(empty.problems).toEqual([
      "every list is empty, but the readers found 3 entry points and 0 calls with no host, in src/main/java/forge/notes/NoteController.java: add the entries they need, ask a question, or say why nothing applies under nothing_to_set with the lines you checked",
    ]);
    const said = (checked: string) =>
      [
        "schemaVersion: 1",
        "repo: forge-notes",
        "nothing_to_set:",
        "  why: The service sets no context path and every controller maps its full path.",
        `  checked: [${checked}]`,
      ].join("\n");
    const ok = await checkSurvey(
      said('"src/main/resources/application.properties:2"'),
      repo(),
      "forge-notes",
    );
    expect(ok.problems).toEqual([]);
    expect(ok.settings).toMatchObject({ exclude: [], prefixes: [], clients: [] });
    expect(ok.nothingToSet).toEqual({
      why: "The service sets no context path and every controller maps its full path.",
      checked: ["src/main/resources/application.properties:2"],
    });
    expect((await checkSurvey(said('"pom.xml:400"'), repo(), "forge-notes")).problems).toEqual([
      "nothing_to_set.checked.0: pom.xml has fewer than 400 lines",
    ]);
    expect((await checkSurvey(said(""), repo(), "forge-notes")).problems).toEqual([
      "nothing_to_set.checked: name at least one line you read",
    ]);
    // A repo with no entry points and no calls: nothing could apply, so empty is the answer.
    const dir = await mkdtemp(join(tmpdir(), "atticus-empty-"));
    await writeFile(join(dir, "README.md"), "# Notes\n");
    const bare = fsRepo("forge-bare", dir, "a".repeat(40));
    expect(
      (await checkSurvey("schemaVersion: 1\nrepo: forge-bare\n", bare, "forge-bare")).problems,
    ).toEqual([]);
  });

  it("asks for client bases, shows the calls built from a name, and checks the answer (ADR 0076)", async () => {
    const ui = fsRepo("forge-notes-ui", `${NOTES}-ui`, "a".repeat(40));
    const clients = (value: string, glob = "src/**") =>
      [
        "schemaVersion: 1",
        "repo: forge-notes-ui",
        "clients:",
        `  - paths: ["${glob}"]`,
        "    base: https://notes.forge.internal/notes-api/",
        "    names: [environment.NOTES_API_URL]",
        "    why: the environment file's API URL",
        '    at: "src/environment.js:4"',
        `    value: ${value}`,
      ].join("\n");
    const prompts: string[] = [];
    const replies = [
      clients("https://notes.forge.internal/v2/", "web/**"),
      clients("https://notes.forge.internal/notes-api/"),
    ];
    const runtime = new MockRuntime(
      (req: AiRequest) => {
        prompts.push(req.pack.prompt);
        return replies[prompts.length - 1]!;
      },
      { now: () => NOW },
    );
    const r = await surveyRepo(ui, { repoId: "forge-notes-ui", runtime, now: NOW });
    expect(r.status).toBe("drafted");
    expect(r.attempts[0]!.problems).toEqual([
      "clients.0: src/environment.js:4 doesn't say https://notes.forge.internal/v2/, so the base isn't applied",
      "clients.0.paths.0: web/** matches no file in the repo",
    ]);
    expect(r.settings?.clients[0]?.names).toEqual(["environment.NOTES_API_URL"]);
    expect(prompts[0]).toContain("Base URLs in front of the HTTP calls a client makes");
    expect(prompts[0]).toMatch(
      /GET \$\{environment\.NOTES_API_URL\}notes\/\{id\}\s+\(src\/note\.service\.ts:20\)/,
    );
    expect(prompts[0]).toContain('4:   NOTES_API_URL: "https://notes.forge.internal/notes-api/",');
  });

  it("hands the assistant the matched repo type's settings, resolved on the repo, and its skills as instructions (ADR 0077)", async () => {
    const op = await loadOrgPack(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "../../../fixtures/repo-types/metarepo/org-pack",
      ),
    );
    const type = op.repoTypes.find((t) => t.id === "forge-spring-service")!;
    const prompts: string[] = [];
    const runtime = new MockRuntime(
      (req: AiRequest) => {
        prompts.push(req.pack.prompt);
        return answer("/notes-api");
      },
      { now: () => NOW },
    );
    const r = await surveyRepo(repo(), {
      repoId: "forge-notes",
      runtime,
      now: NOW,
      repoType: {
        type,
        verdict: "clear",
        score: 1,
        skills: op.skills.filter((s) => s.id === "read-forge-spring-service"),
      },
    });
    expect(r.status).toBe("drafted");
    const p = prompts[0]!;
    expect(p).toContain(
      "This repo matches the organisation's repo type Forge Spring service (forge-spring-service): a clear match, 100% of its fingerprint.",
    );
    expect(p).toContain("key: server.servlet.context-path");
    expect(p).toContain("at: src/main/resources/application.properties:3");
    expect(p).toContain("each checked against its line");
    expect(p).toContain("Skill for this repo type: Read a Forge Spring service");
    // Instructions come before the repo's own content, which stays quoted data.
    expect(p.indexOf("Skill for this repo type")).toBeLessThan(p.indexOf("Folders of forge-notes"));
    // Without a type, none of it.
    prompts.length = 0;
    await surveyRepo(repo(), { repoId: "forge-notes", runtime, now: NOW });
    expect(prompts[0]).not.toContain("repo type");
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
        return answer("/notes-api");
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
