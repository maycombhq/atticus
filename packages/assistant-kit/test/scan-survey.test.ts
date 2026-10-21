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
    expect(empty.settings).toMatchObject({ exclude: [], prefixes: [], clients: [] });
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
});
