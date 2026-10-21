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
