import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  answerQuestion,
  listQuestions,
  orgPackJsonSchemas,
  Question,
  QuestionDraft,
  QuestionError,
  questionFromDraft,
  questionId,
  questionsDirOf,
  questionsRelOf,
  raiseQuestions,
  readQuestion,
  repoTypeSkillRel,
} from "../src/index.js";

const AT = "2026-10-21T12:00:00.000Z";

const draft = {
  question: "Is /notes-api the path every entry point is served under?",
  options: [
    {
      label: "Yes, every entry point",
      means: "The context path applies to the whole service",
      changes: "The scan puts /notes-api in front of every endpoint",
    },
    {
      label: "No, only the public ones",
      means: "Internal endpoints are served at the root",
      changes: "The scan leaves internal endpoints as they are",
    },
  ],
  evidence: ["src/main/resources/application.properties:3"],
  scope: "repo" as const,
};

const asked = {
  step: "scan-survey",
  repo: "forge-notes",
  command: "atticus scan survey forge-notes",
  rerun: "atticus scan survey forge-notes --force",
  run: "run-20261021120000-0001",
  at: AT,
};

async function metarepo(adopted = false) {
  const root = await mkdtemp(join(tmpdir(), "atticus-questions-"));
  await mkdir(join(root, ...(adopted ? [".atticus", "org-pack"] : ["org-pack"])), {
    recursive: true,
  });
  return root;
}

describe("questions as files (ADR 0078)", () => {
  it("gives a question a stable id from what it asks about", () => {
    const a = questionId({ step: "scan-survey", repo: "forge-notes", ...draft });
    expect(a).toMatch(/^q-[0-9a-f]{12}$/);
    // Spacing, case and the order of the evidence don't change what it asks.
    expect(
      questionId({
        step: "scan-survey",
        repo: "forge-notes",
        question: "  is /NOTES-API the path every entry point is served under ",
        evidence: [...draft.evidence],
      }),
    ).toBe(a);
    expect(questionId({ step: "scan-survey", repo: "forge-other", ...draft })).not.toBe(a);
  });

  it("checks a question the AI raises: evidence as path:line, a type for a repo-type scope", () => {
    expect(QuestionDraft.safeParse(draft).success).toBe(true);
    expect(
      QuestionDraft.safeParse({ ...draft, evidence: ["application.properties"] }).success,
    ).toBe(false);
    expect(QuestionDraft.safeParse({ ...draft, evidence: [] }).success).toBe(false);
    expect(QuestionDraft.safeParse({ ...draft, scope: "repo-type" }).success).toBe(false);
    expect(
      QuestionDraft.safeParse({ ...draft, scope: "repo-type", repoType: "spring-service" }).success,
    ).toBe(true);
  });

  it("builds an open question with the scope proposed and the command that asked", () => {
    const q = questionFromDraft(QuestionDraft.parse(draft), asked);
    expect(q).toMatchObject({
      schemaVersion: 1,
      askedBy: {
        step: "scan-survey",
        command: "atticus scan survey forge-notes",
        run: "run-20261021120000-0001",
        at: AT,
      },
      repo: "forge-notes",
      state: "open",
      scope: { level: "repo", id: "forge-notes" },
      rerun: "atticus scan survey forge-notes --force",
    });
    expect(Question.parse(q)).toEqual(q);
  });

  it("refuses an answered question with no answer, and an answer that is both an option and words", () => {
    const q = questionFromDraft(QuestionDraft.parse(draft), asked);
    expect(Question.safeParse({ ...q, state: "answered" }).success).toBe(false);
    const answer = { by: "priya.nair", at: AT, scope: { level: "repo", id: "forge-notes" } };
    expect(
      Question.safeParse({ ...q, state: "answered", answer: { ...answer, option: 1, text: "x" } })
        .success,
    ).toBe(false);
    expect(
      Question.safeParse({ ...q, state: "answered", answer: { ...answer, option: 3 } }).success,
    ).toBe(false);
    expect(
      Question.safeParse({ ...q, state: "answered", answer: { ...answer, option: 2 } }).success,
    ).toBe(true);
  });

  it("writes questions/<id>.yaml, and never asks the same thing twice", async () => {
    const root = await metarepo();
    expect(questionsRelOf(root)).toBe("questions");
    const first = await raiseQuestions(root, [QuestionDraft.parse(draft)], asked);
    expect(first.raised).toHaveLength(1);
    const id = first.raised[0]!.id;
    const text = await readFile(join(questionsDirOf(root), `${id}.yaml`), "utf8");
    expect(text).toMatch(/^# A question from atticus scan survey forge-notes/);
    expect(Question.parse(parse(text)).question).toBe(draft.question);
    const again = await raiseQuestions(root, [QuestionDraft.parse(draft)], asked);
    expect(again.raised).toEqual([]);
    expect(again.known.map((q) => q.id)).toEqual([id]);
  });

  it("lists questions by state and says which files it can't read", async () => {
    const root = await metarepo();
    const { raised } = await raiseQuestions(root, [QuestionDraft.parse(draft)], asked);
    await writeFile(join(questionsDirOf(root), "q-000000000000.yaml"), "not: [valid", "utf8");
    const all = await listQuestions(root);
    expect(all.questions.map((q) => q.id)).toEqual([raised[0]!.id]);
    expect(all.problems).toHaveLength(1);
    expect(all.problems[0]!.file).toBe("questions/q-000000000000.yaml");
    expect((await listQuestions(root, { state: "answered" })).questions).toEqual([]);
    expect(await listQuestions(await metarepo())).toEqual({ questions: [], problems: [] });
  });

  it("records an answer for this repo: the option, who, when and the scope confirmed", async () => {
    const root = await metarepo();
    const { raised } = await raiseQuestions(root, [QuestionDraft.parse(draft)], asked);
    const id = raised[0]!.id;
    const r = await answerQuestion(root, id, { option: 2, by: "priya.nair", at: AT });
    expect(r.question.state).toBe("answered");
    expect(r.question.answer).toEqual({
      option: 2,
      by: "priya.nair",
      at: AT,
      scope: { level: "repo", id: "forge-notes" },
    });
    expect(r.skill).toBeUndefined();
    expect((await readQuestion(root, id))?.answer?.option).toBe(2);
    // Words of their own instead.
    const words = await answerQuestion(root, id, {
      text: "Only the /public controllers",
      by: "priya.nair",
      at: AT,
    });
    expect(words.question.answer).toMatchObject({ text: "Only the /public controllers" });
    expect(words.question.answer?.option).toBeUndefined();
  });

  it("refuses an unknown question, an option out of range, and a repo-type answer with no type", async () => {
    const root = await metarepo();
    const { raised } = await raiseQuestions(root, [QuestionDraft.parse(draft)], asked);
    const id = raised[0]!.id;
    await expect(
      answerQuestion(root, "q-ffffffffffff", { option: 1, by: "a", at: AT }),
    ).rejects.toThrow(QuestionError);
    await expect(answerQuestion(root, id, { option: 5, by: "a", at: AT })).rejects.toThrow(
      /option 5/,
    );
    await expect(answerQuestion(root, id, { by: "a", at: AT })).rejects.toThrow(
      /an option or your own words/,
    );
    await expect(
      answerQuestion(root, id, { option: 1, scope: "repo-type", by: "a", at: AT }),
    ).rejects.toThrow(/which repo type/);
  });

  it("writes a repo-type answer under Answers in that type's skill file, when the file is there", async () => {
    const root = await metarepo();
    const { raised } = await raiseQuestions(
      root,
      [QuestionDraft.parse({ ...draft, scope: "repo-type", repoType: "spring-service" })],
      asked,
    );
    const id = raised[0]!.id;
    expect(repoTypeSkillRel(root, "spring-service")).toBe(
      "org-pack/process/skills/spring-service/SKILL.md",
    );
    // No skill file yet: the path is recorded in the answer and nothing else is written.
    const before = await answerQuestion(root, id, { option: 1, by: "priya.nair", at: AT });
    expect(before.question.answer).toMatchObject({
      scope: { level: "repo-type", id: "spring-service" },
      skill: "org-pack/process/skills/spring-service/SKILL.md",
    });
    expect(before.skill).toEqual({
      path: "org-pack/process/skills/spring-service/SKILL.md",
      written: false,
    });
    const skill = join(root, "org-pack", "process", "skills", "spring-service", "SKILL.md");
    await mkdir(join(skill, ".."), { recursive: true });
    await writeFile(
      skill,
      "---\nid: spring-service\n---\n# Spring services\n\n## Answers\n\n## Notes\n\nKeep this.\n",
      "utf8",
    );
    const after = await answerQuestion(root, id, { option: 1, by: "priya.nair", at: AT });
    expect(after.skill).toEqual({
      path: "org-pack/process/skills/spring-service/SKILL.md",
      written: true,
    });
    const body = await readFile(skill, "utf8");
    expect(body).toContain(
      `## Answers\n\n- ${draft.question} Yes, every entry point. (priya.nair, 2026-10-21, question ${id})\n\n## Notes`,
    );
    expect(body).toContain("Keep this.");
    // The same answer again doesn't add a second line.
    await answerQuestion(root, id, { option: 1, by: "priya.nair", at: AT });
    expect((await readFile(skill, "utf8")).split(`question ${id}`).length).toBe(2);
  });

  it("keeps questions in .atticus/questions in a repo adopted in place", async () => {
    const root = await metarepo(true);
    expect(questionsRelOf(root)).toBe(".atticus/questions");
    expect(repoTypeSkillRel(root, "x")).toBe(".atticus/org-pack/process/skills/x/SKILL.md");
  });

  it("publishes the question file's JSON Schema with the org pack's", () => {
    expect(Object.keys(orgPackJsonSchemas())).toContain("Question");
  });
});
