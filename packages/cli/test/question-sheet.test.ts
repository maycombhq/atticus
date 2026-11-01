import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import {
  hostQuestionText,
  HOSTS_NONE,
  HOSTS_STEP,
  QuestionDraft,
  raiseQuestions,
  readQuestion,
  writeQuestion,
} from "@maycombhq/core";
import { questionsFiles } from "../src/question-commands.js";
import { askedFingerprint } from "../src/question-sheet.js";

/**
 * Answer in one sitting (ADR 0153, Q6) and answer by rule from the terminal (Q2): `atticus
 * questions sheet` writes every open question with an empty answer; `--apply` answers the filled
 * entries as the person running it, skips blanks and refuses an entry whose question changed.
 */

const ESTATE = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/estate");
const AT = "2026-11-01T12:00:00.000Z";
const NOW = new Date(AT);

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
};
const run = (root: string, args: string[]) => {
  const t = io();
  return questionsFiles(root, ["questions", ...args], t.io, { now: NOW }).then((code) => ({
    code,
    ...t,
  }));
};

const survey = (question: string, line: number) =>
  QuestionDraft.parse({
    question,
    options: [
      { label: "Generated", means: "nobody edits it", changes: "the scan leaves it out" },
      { label: "Product", means: "it ships", changes: "the scan reads it" },
    ],
    evidence: [`docs/playground.js:${line}`],
  });

async function metarepo() {
  const root = await mkdtemp(join(tmpdir(), "atticus-sheet-"));
  await cp(join(ESTATE, "org-pack"), join(root, "org-pack"), { recursive: true });
  const by = {
    step: "scan-survey",
    repo: "forge-web",
    command: "atticus scan survey forge-web",
    rerun: "atticus scan survey forge-web --force",
    at: AT,
  };
  const { raised } = await raiseQuestions(
    root,
    [
      survey("Is docs/playground.js generated?", 1),
      survey("Is docs/legacy.js generated?", 2),
      survey("Is docs/old.js generated?", 3),
    ],
    by,
  );
  const host = (
    await raiseQuestions(
      root,
      [
        {
          question: hostQuestionText("limits.payments.forge.internal"),
          options: [
            {
              label: "forge-customers",
              means: "it serves HTTP",
              changes: "the host goes under its hosts",
            },
            { label: HOSTS_NONE, means: "nothing", changes: "nothing" },
          ],
          evidence: ["src/app/limits.service.ts:4"],
          scope: "repo",
        },
      ],
      { ...by, step: HOSTS_STEP, command: "atticus scan", rerun: "atticus scan" },
    )
  ).raised[0]!;
  return { root, ids: raised.map((q) => q.id), host };
}

type SheetDoc = {
  schemaVersion: number;
  questions: Record<string, unknown>[];
};

describe("atticus questions sheet (ADR 0153, Q6)", () => {
  it("writes every open question with its options, evidence and an empty answer", async () => {
    const { root, ids, host } = await metarepo();
    const r = await run(root, ["sheet"]);
    expect(r.code).toBe(0);
    expect(r.out[0]).toContain("Wrote 4 open questions to questions-sheet.yaml");
    const text = await readFile(join(root, "questions-sheet.yaml"), "utf8");
    expect(text).toMatch(/^# Atticus answer sheet/);
    const doc = parse(text) as SheetDoc;
    expect(doc.schemaVersion).toBe(1);
    expect(doc.questions.map((q) => q.id).sort()).toEqual([...ids, host.id].sort());
    const first = doc.questions.find((q) => q.id === ids[0])!;
    expect(first).toEqual({
      id: ids[0],
      repo: "forge-web",
      question: "Is docs/playground.js generated?",
      options: [
        "1. Generated: nobody edits it. It would change: the scan leaves it out.",
        "2. Product: it ships. It would change: the scan reads it.",
      ],
      evidence: ["docs/playground.js:1"],
      scope: "repo",
      asked: askedFingerprint((await readQuestion(root, ids[0]!))!),
      answer: null,
    });
    // A hosts question takes a rule: its entry has an empty match.
    expect(doc.questions.find((q) => q.id === host.id)).toHaveProperty("match", null);
  });

  it("applies the filled entries as the person running it, skips blanks, refuses a changed question", async () => {
    const { root, ids, host } = await metarepo();
    await run(root, ["sheet", "--out", "mine.yaml"]);
    const file = join(root, "mine.yaml");
    const doc = parse(await readFile(file, "utf8")) as SheetDoc;
    const entry = (id: string) => doc.questions.find((q) => q.id === id)!;
    entry(ids[0]!).answer = 1;
    entry(ids[1]!).answer = "It is hand-written, keep it";
    entry(ids[2]!).answer = 2;
    entry(host.id).answer = 1;
    entry(host.id).match = "*.payments.forge.internal";
    await writeFile(file, stringify(doc));
    // The third question changes after the sheet was written.
    const third = (await readQuestion(root, ids[2]!))!;
    await writeQuestion(root, { ...third, question: "Is docs/old.js generated, or vendored?" });
    const r = await run(root, ["sheet", "--apply", file, "--by", "priya.nair"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`Answered ${ids[0]}: Generated (as priya.nair).`);
    expect(r.out).toContain(`Answered ${ids[1]}: It is hand-written, keep it (as priya.nair).`);
    expect(r.out).toContain(
      `Answered ${host.id}: forge-customers (as priya.nair, by rule: *.payments.forge.internal).`,
    );
    expect(r.out).toContain(
      `Refused ${ids[2]}: the question changed since the sheet was written (its words, options or evidence): write a new sheet and read it again.`,
    );
    expect(r.out).toContain(
      "3 questions answered, 0 skipped, 1 refused. Wrote each answer to questions/<id>.yaml; commit them for review.",
    );
    const a = (await readQuestion(root, ids[0]!))!;
    expect(a.answer).toMatchObject({ option: 1, by: "priya.nair", at: AT });
    expect((await readQuestion(root, ids[2]!))!.state).toBe("open");
    const manifest = await readFile(
      join(root, "org-pack", "profiles", "forge", "repos.manifest.yaml"),
      "utf8",
    );
    expect(manifest).toContain("*.payments.forge.internal");
  });

  it("skips a blank entry and one answered since, and says why", async () => {
    const { root, ids } = await metarepo();
    await run(root, ["sheet"]);
    const file = join(root, "questions-sheet.yaml");
    const doc = parse(await readFile(file, "utf8")) as SheetDoc;
    doc.questions.find((q) => q.id === ids[0])!.answer = 2;
    await writeFile(file, stringify(doc));
    await run(root, ["answer", ids[0]!, "--option", "1", "--by", "dana.okafor"]);
    const r = await run(root, ["sheet", "--apply", file, "--by", "priya.nair"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      `Skipped ${ids[0]}: it is answered already (Generated, by dana.okafor).`,
    );
    expect(r.out).toContain(`Skipped ${ids[1]}: left blank.`);
    expect((await readQuestion(root, ids[0]!))!.answer!.by).toBe("dana.okafor");
  });

  it("refuses a file that isn't a sheet, or isn't there", async () => {
    const { root } = await metarepo();
    await writeFile(join(root, "x.yaml"), "hello: world\n");
    expect((await run(root, ["sheet", "--apply", join(root, "x.yaml")])).code).toBe(2);
    expect((await run(root, ["sheet", "--apply", join(root, "none.yaml")])).code).toBe(1);
  });
});

describe("atticus questions answer --match (ADR 0153, Q2)", () => {
  it("writes the rule with the answer and says what it covers", async () => {
    const { root, host } = await metarepo();
    const r = await run(root, [
      "answer",
      host.id,
      "--option",
      "1",
      "--match",
      "*.payments.forge.internal",
      "--by",
      "priya.nair",
    ]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      "It answers by rule: every call on a host matching *.payments.forge.internal, in this repo, forge-web, reads this answer, the calls found later too.",
    );
    expect((await readQuestion(root, host.id))!.answer!.match).toBe("*.payments.forge.internal");
  });

  it("refuses a rule on a question that isn't about where calls go", async () => {
    const { root, ids } = await metarepo();
    const r = await run(root, ["answer", ids[0]!, "--option", "1", "--match", "/docs/**"]);
    expect(r.code).toBe(2);
    expect(r.err.join(" ")).toMatch(/Only a question about where calls go/);
  });
});
