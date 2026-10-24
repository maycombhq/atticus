import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { Question, QuestionDraft, raiseQuestions } from "@maycombhq/core";
import { questionsFiles } from "../src/question-commands.js";

const AT = "2026-10-21T12:00:00.000Z";
const NOW = new Date(AT);

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
};

const asked = {
  step: "scan-survey",
  repo: "forge-notes",
  command: "atticus scan survey forge-notes",
  rerun: "atticus scan survey forge-notes --force",
  at: AT,
};

const draft = (over: Record<string, unknown> = {}) =>
  QuestionDraft.parse({
    question: "Is docs/ a generated playground or part of the product?",
    options: [
      { label: "Generated", means: "nobody edits it", changes: "the scan leaves docs/ out" },
      { label: "Product", means: "it ships", changes: "the scan reads docs/" },
    ],
    evidence: ["docs/playground.js:1"],
    ...over,
  });

async function metarepo() {
  const root = await mkdtemp(join(tmpdir(), "atticus-questions-cli-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  const { raised } = await raiseQuestions(root, [draft()], asked);
  return { root, id: raised[0]!.id };
}

const run = (root: string, args: string[]) => {
  const t = io();
  return questionsFiles(root, ["questions", ...args], t.io, { now: NOW }).then((code) => ({
    code,
    ...t,
  }));
};

describe("atticus questions list and answer (ADR 0078)", () => {
  it("lists open questions with their options, evidence, scope and the command to answer", async () => {
    const { root, id } = await metarepo();
    const r = await run(root, ["list", "--state", "open"]);
    expect(r.code).toBe(0);
    expect(r.out).toEqual([
      `${id}  open  forge-notes  (asked by atticus scan survey forge-notes on 2026-10-21)`,
      "  Is docs/ a generated playground or part of the product?",
      "  1. Generated: nobody edits it. It would change: the scan leaves docs/ out.",
      "  2. Product: it ships. It would change: the scan reads docs/.",
      "  Evidence: docs/playground.js:1",
      "  Proposed scope: this repo (forge-notes)",
      `  Answer: atticus questions answer ${id} --option <n>, or --text "your own words"`,
      "1 open question.",
    ]);
    const json = await run(root, ["list", "--json"]);
    const body = JSON.parse(json.out.join("\n")) as { questions: Question[] };
    expect(body.questions.map((q) => q.id)).toEqual([id]);
    expect((await run(root, ["list", "--state", "answered"])).out).toEqual([
      "No answered questions.",
    ]);
    expect((await run(root, ["list", "--state", "nope"])).code).toBe(2);
  });

  it("writes the answer to the file, with who and when, and prints the command to rerun", async () => {
    const { root, id } = await metarepo();
    const r = await run(root, ["answer", id, "--option", "1", "--by", "priya.nair"]);
    expect(r.code).toBe(0);
    expect(r.out).toEqual([
      `Answered ${id}: Generated (for this repo, forge-notes). Wrote questions/${id}.yaml; commit it for review.`,
      "Next: atticus scan survey forge-notes --force",
    ]);
    const q = Question.parse(parse(await readFile(join(root, "questions", `${id}.yaml`), "utf8")));
    expect(q).toMatchObject({
      state: "answered",
      answer: { option: 1, by: "priya.nair", at: AT, scope: { level: "repo", id: "forge-notes" } },
    });
    const listed = await run(root, ["list"]);
    expect(listed.out).toContain("  Answered by priya.nair on 2026-10-21: Generated (this repo)");
  });

  it("takes the person's own words, and a repo-type scope with its skill file", async () => {
    const { root, id } = await metarepo();
    const words = await run(root, [
      "answer",
      id,
      "--text",
      "Only docs/api is generated",
      "--by",
      "a",
    ]);
    expect(words.code).toBe(0);
    expect(words.out[0]).toMatch(/: Only docs\/api is generated \(for this repo/);
    const skill = join(root, "org-pack", "process", "skills", "forge-service", "SKILL.md");
    await mkdir(join(skill, ".."), { recursive: true });
    await writeFile(skill, "---\nid: forge-service\n---\n# Forge services\n", "utf8");
    const wide = await run(root, [
      "answer",
      id,
      "--option",
      "2",
      "--scope",
      "repo-type",
      "--type",
      "forge-service",
      "--by",
      "a",
    ]);
    expect(wide.code).toBe(0);
    expect(wide.out).toEqual([
      `Answered ${id}: Product (for every repo of type forge-service). Wrote questions/${id}.yaml; commit it for review.`,
      "Also wrote it under Answers in org-pack/process/skills/forge-service/SKILL.md; review it in the same pull request.",
      "Next: atticus scan survey forge-notes --force",
    ]);
    expect(await readFile(skill, "utf8")).toContain(`## Answers\n\n- Is docs/`);
  });

  it("says when the repo type's skill file isn't there yet", async () => {
    const { root, id } = await metarepo();
    const r = await run(root, [
      "answer",
      id,
      "--option",
      "1",
      "--scope",
      "repo-type",
      "--type",
      "forge-service",
      "--by",
      "a",
    ]);
    expect(r.code).toBe(0);
    expect(r.out[1]).toBe(
      "org-pack/process/skills/forge-service/SKILL.md isn't there yet, so the answer is kept in the question file, with that path.",
    );
  });

  it("refuses an unknown question, a missing or doubled answer, a bad option and a bad scope", async () => {
    const { root, id } = await metarepo();
    expect((await run(root, ["answer", "q-ffffffffffff", "--option", "1"])).code).toBe(1);
    const none = await run(root, ["answer", id]);
    expect(none.code).toBe(2);
    expect(none.err[0]).toMatch(/--option <n> or --text/);
    expect((await run(root, ["answer", id, "--option", "1", "--text", "x"])).code).toBe(2);
    const bad = await run(root, ["answer", id, "--option", "9"]);
    expect(bad.code).toBe(2);
    expect(bad.err[0]).toBe("There is no option 9: pick 1 to 2.");
    expect((await run(root, ["answer", id, "--option", "1", "--scope", "everyone"])).code).toBe(2);
    expect((await run(root, ["answer"])).code).toBe(2);
  });
});

describe("atticus questions show, and a change's question (WP2.4)", () => {
  it("shows one question by its id, as list prints it, or says there is none", async () => {
    const { root, id } = await metarepo();
    const r = await run(root, ["show", id]);
    expect(r.code).toBe(0);
    expect(r.out[0]).toBe(
      `${id}  open  forge-notes  (asked by atticus scan survey forge-notes on 2026-10-21)`,
    );
    expect(r.out).toContain("  Proposed scope: this repo (forge-notes)");
    const json = await run(root, ["show", id, "--json"]);
    expect((JSON.parse(json.out.join("\n")) as Question).id).toBe(id);
    const none = await run(root, ["show", "q-000000000000"]);
    expect(none.code).toBe(1);
    expect(none.err.join("\n")).toMatch(/No question q-000000000000.*atticus questions list/);
    expect((await run(root, ["show"])).code).toBe(2);
  });

  it("refuses a subcommand it hasn't, rather than listing the gaps", async () => {
    const { root } = await metarepo();
    const r = await run(root, ["shwo", "q-1"]);
    expect(r.code).toBe(2);
    expect(r.err.join("\n")).toMatch(/questions list, show or answer/);
  });

  it("says a change's question was answered for this change, not this repo", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-questions-change-"));
    await mkdir(join(root, "org-pack"), { recursive: true });
    await mkdir(join(root, "openspec", "changes", "add-pins"), { recursive: true });
    await writeFile(join(root, "openspec", "changes", "add-pins", "change.yaml"), "id: add-pins\n");
    const { raised } = await raiseQuestions(root, [draft()], {
      ...asked,
      step: "stories",
      repo: "add-pins",
      command: "atticus plan stories add-pins",
      rerun: "atticus plan stories add-pins",
    });
    const r = await run(root, ["answer", raised[0]!.id, "--option", "2", "--by", "pat"]);
    expect(r.out[0]).toContain("(for this change, add-pins)");
  });
});
