import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MockRuntime } from "@maycombhq/ai";
import { answerQuestion, listQuestions, ScanSettings } from "@maycombhq/core";
import { parse } from "yaml";
import { scanSurvey } from "../src/onboard-commands.js";

const FX = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/scan-settings");
const NOW = new Date("2026-10-21T12:00:00Z");

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
};

/** A metarepo with the fixture's org pack (no scan settings yet) and its repos as base clones. */
async function metarepo() {
  const root = await mkdtemp(join(tmpdir(), "atticus-survey-"));
  await cp(join(FX, "metarepo"), root, { recursive: true });
  await rm(join(root, "org-pack", "scan"), { recursive: true, force: true });
  await cp(join(FX, "repos"), join(root, "workspace"), { recursive: true });
  return root;
}

const ANSWER = `schemaVersion: 1
repo: forge-notes
exclude:
  - { path: "docs/**", why: a generated playground, at: "docs/playground.js:1" }
prefixes:
  - paths: ["src/main/java/**"]
    prefix: /notes-api
    why: server.servlet.context-path
    at: "src/main/resources/application.properties:3"
    value: /notes-api
`;

describe("atticus scan survey", () => {
  it("writes org-pack/scan/<repo>.yaml when the assistant's answer checks out, and won't overwrite it", async () => {
    const root = await metarepo();
    const runtime = new MockRuntime(() => ANSWER, { now: () => NOW });
    const t = io();
    expect(await scanSurvey(root, "forge-notes", {}, { runtime, now: NOW }, t.io)).toBe(0);
    expect(t.out).toEqual([
      "Wrote org-pack/scan/forge-notes.yaml: 1 folder left out, 1 prefix.",
      "  leave out docs/**: a generated playground (docs/playground.js:1)",
      "  /notes-api in front of src/main/java/**: server.servlet.context-path (src/main/resources/application.properties:3)",
      "Next: atticus scan, then review the file in a pull request.",
    ]);
    const text = await readFile(join(root, "org-pack", "scan", "forge-notes.yaml"), "utf8");
    expect(text).toMatch(/^# Drafted by atticus scan survey on 2026-10-21/);
    expect(ScanSettings.parse(parse(text)).prefixes[0]!.prefix).toBe("/notes-api");
    const again = io();
    expect(await scanSurvey(root, "forge-notes", {}, { runtime, now: NOW }, again.io)).toBe(1);
    expect(again.err[0]).toMatch(/already has scan settings/);
    expect(
      await scanSurvey(root, "forge-notes", { force: true }, { runtime, now: NOW }, io().io),
    ).toBe(0);
  });

  it("writes the questions the assistant raised, and the rerun reads the answers (ADR 0078)", async () => {
    const root = await metarepo();
    const prompts: string[] = [];
    const runtime = new MockRuntime(
      (req) => {
        prompts.push(req.pack.prompt);
        return `${ANSWER}questions:
  - question: Is /notes-api also the prefix of the admin endpoints?
    options:
      - { label: "Yes", means: one context path for the service, changes: admin endpoints get /notes-api }
      - { label: "No", means: admin has its own path, changes: admin endpoints are left as they are }
    evidence: ["src/main/resources/application.properties:3"]
    scope: repo
`;
      },
      { now: () => NOW },
    );
    const t = io();
    expect(await scanSurvey(root, "forge-notes", {}, { runtime, now: NOW }, t.io)).toBe(0);
    const open = await listQuestions(root, { state: "open" });
    expect(open.questions).toHaveLength(1);
    const q = open.questions[0]!;
    expect(q).toMatchObject({
      repo: "forge-notes",
      askedBy: { step: "scan-survey", command: "atticus scan survey forge-notes" },
      rerun: "atticus scan survey forge-notes --force",
      scope: { level: "repo", id: "forge-notes" },
    });
    expect(q.askedBy.run).toMatch(/^run-/);
    expect(t.out).toContain(`1 question for a person, in questions/:`);
    expect(t.out).toContain(`  ${q.id} Is /notes-api also the prefix of the admin endpoints?`);
    expect(t.out.at(-1)).toBe(
      `Answer it with atticus questions answer <id> --option <n>, or on the app's Questions page; then run atticus scan survey forge-notes --force`,
    );
    // The scan settings file never holds the questions.
    const text = await readFile(join(root, "org-pack", "scan", "forge-notes.yaml"), "utf8");
    expect(text).not.toContain("questions");

    await answerQuestion(root, q.id, { option: 2, by: "priya.nair", at: NOW.toISOString() });
    const again = io();
    expect(
      await scanSurvey(root, "forge-notes", { force: true }, { runtime, now: NOW }, again.io),
    ).toBe(0);
    expect(prompts.at(-1)).toContain("Answer (priya.nair): No");
    // Asked again by the rerun, it's the same question: not written twice, not shown as new.
    expect((await listQuestions(root)).questions).toHaveLength(1);
    expect(again.out.join("\n")).not.toContain("question for a person");
  });

  it("writes nothing when every attempt fails the checks", async () => {
    const root = await metarepo();
    const runtime = new MockRuntime(() => ANSWER.replace("value: /notes-api", "value: /made-up"), {
      now: () => NOW,
    });
    const t = io();
    expect(
      await scanSurvey(root, "forge-notes", { attempts: 2 }, { runtime, now: NOW }, t.io),
    ).toBe(1);
    expect(t.out.at(-1)).toBe(
      "The survey still had problems after 2 attempts; nothing was written.",
    );
    await expect(readFile(join(root, "org-pack", "scan", "forge-notes.yaml"))).rejects.toThrow();
  });
});
