import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { COVERS_FIELD_SPEC, MockRuntime, type AiRequest } from "@maycombhq/ai";
import {
  answerQuestion,
  fileJudgments,
  judgmentKey,
  listQuestions,
  parseRecord,
  QuestionDraft,
  raiseQuestions,
  readQuestion,
  recordPath,
  serializeRecord,
  type Question,
} from "@maycombhq/core";
import {
  architectureStage,
  COVERS_ANSWER_SPEC,
  coversInputs,
  EXPAND_AGENT,
  featureStage,
  PlannerError,
  storiesStage,
} from "../src/index.js";

/**
 * A live rerun of the stories stage on a chat app (the change pins a message), retold on Forge's
 * add-fraud-check change. V1: a person answered the judge's covers-field question "yes", and the
 * next run stopped saying the draft didn't follow the answer, with the judge's objections still
 * blocking. V0: questions in the old form (one per field) stayed open. V2: the judge wanted every
 * then clause to assert every field's value, lookup ids included.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const STAGES = join(HERE, "../../../fixtures/stages");
const FIX = join(HERE, "fixtures/context-flows");
const SPECS_CATALOG = join(HERE, "../../../fixtures/specs/catalog.yaml");
const NOW = new Date("2026-10-24T09:00:00Z");
const LATER = "2026-10-24T10:00:00Z";
const CHANGE = "add-fraud-check";
const REL = `openspec/changes/${CHANGE}`;
const fixture = (f: string) => readFileSync(join(FIX, f), "utf8");

async function writeRecords(root: string, under: string, file: string): Promise<void> {
  for (const r of parse(readFileSync(file, "utf8")) as unknown[]) {
    const p = parseRecord(r);
    if (!p.ok) throw new Error(`bad fixture record: ${JSON.stringify(p.issues)}`);
    const f = join(root, under, recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
}

async function estateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-person-verdict-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  await writeRecords(root, "catalog/generated", SPECS_CATALOG);
  await writeRecords(root, "catalog/generated", join(STAGES, "catalog-extra.yaml"));
  await writeRecords(root, "knowledge/items", join(STAGES, "knowledge.yaml"));
  await cp(join(STAGES, "specs"), join(root, "specs"), { recursive: true });
  await cp(join(FIX, "specs"), join(root, "specs"), { recursive: true });
  await cp(join(STAGES, "changes"), join(root, "openspec/changes"), { recursive: true });
  return root;
}

const dir = (root: string) => join(root, "openspec/changes", CHANGE);

function mock(drafts: string[]) {
  let n = 0;
  return new MockRuntime(
    (req: AiRequest) => {
      if (req.agent.id.endsWith("-critic")) return "findings: []";
      if (req.agent.id === EXPAND_AGENT) return "terms: []\nnames: []\n";
      return drafts[Math.min(n++, drafts.length - 1)]!;
    },
    { now: () => NOW },
  );
}

async function architected(root: string): Promise<void> {
  expect(
    (
      await featureStage(root, CHANGE, {
        runtime: mock([fixture("feature-answer.yaml")]),
        now: NOW,
      })
    ).state,
  ).toBe("done");
  expect(
    (
      await architectureStage(root, CHANGE, {
        runtime: mock([fixture("architecture-reads.yaml")]),
        now: NOW,
      })
    ).state,
  ).toBe("done");
}

const STORIES = `stories:
  - id: s1-place-order
    title: Screen each order for fraud
    asA: shop owner
    iWant: every new order screened by Northwind Pay
    soThat: stolen cards don't empty the stock
    tasks:
      - id: "1.1"
        criteria:
          - text: "Given a new order, when it is placed, then the screen passes"
            checks: [sku, quantity, cardToken, verdict]
      - id: "1.2"
        criteria:
          - text: "Given a rejected verdict, when the order is placed, then the verdict refuses it with 422 and no stock is reserved"
            checks: [verdict]
      - id: "1.3"
        criteria:
          - text: "Given an accepted order, when it is saved, then the orders row holds sku, quantity and fraud_verdict"
            checks: [sku, quantity, fraud_verdict]
`;
const CRITERION = "Given a new order, when it is placed, then the screen passes";
const WHY = "It says the screen passes, not what the fields hold.";
const PERSON =
  "Yes: the given clause fixes that value and the then clause states the result that follows from it, so the criterion checks it.";

/**
 * A runtime that calls a model directly: the drafter writes STORIES, the covers-field judge says
 * no to every claim, and the answer judge reads a person's words as `answer` says.
 */
class Direct extends MockRuntime {
  override readonly kind = "model" as const;
  covers = 0;
  constructor(answer = "checks", drafts: string[] = [STORIES]) {
    let n = 0;
    super(
      (req: AiRequest) => {
        if (req.agent.id.endsWith("-critic")) return "findings: []";
        if (req.agent.id === EXPAND_AGENT) return "terms: []\nnames: []\n";
        if (req.agent.id === "judge") {
          const items = (req.pack.prompt.match(/^item \d+:/gm) ?? []).length;
          if (req.pack.prompt.includes(COVERS_FIELD_SPEC.ask)) {
            this.covers += items;
            return `judgments:\n${Array.from(
              { length: items },
              (_, i) =>
                `  - item: ${i + 1}\n    verdict: no\n    quotes: [{ of: criterion, text: "then the screen passes" }]\n    why: ${WHY}\n`,
            ).join("")}`;
          }
          if (req.pack.prompt.includes(COVERS_ANSWER_SPEC.ask))
            return `judgments:\n${Array.from(
              { length: items },
              (_, i) =>
                `  - item: ${i + 1}\n    verdict: ${answer}\n    quotes: [{ of: answer, text: "Yes" }]\n    why: The person says it checks it.\n`,
            ).join("")}`;
          return "judgments: []\n";
        }
        return drafts[Math.min(n++, drafts.length - 1)]!;
      },
      { now: () => NOW },
    );
  }
}

async function stopOf(p: Promise<unknown>): Promise<PlannerError> {
  const e = await p.then(
    () => undefined,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(PlannerError);
  return e as PlannerError;
}

/** The stage asked the one covers-field question for task 1.1's criterion. */
async function asked(root: string) {
  const r = await storiesStage(root, CHANGE, { runtime: new Direct(), now: NOW });
  expect(r.state).toBe("questions");
  const q = r.questions.find((x) => x.question.includes(CRITERION))!;
  expect(q).toBeDefined();
  return q;
}

const FIELDS = ["sku", "quantity", "cardToken", "verdict"];

describe("V1: a person's answer to the judge's question settles the judgment", () => {
  it("'yes, it checks them' is stored as the person's verdict, and the judge is never asked again about it", async () => {
    const root = await estateRoot();
    await architected(root);
    const q = await asked(root);
    await answerQuestion(root, q.id, { option: 1, by: "priya.nair", at: LATER });
    const rt = new Direct();
    const r = await storiesStage(root, CHANGE, { runtime: rt, now: NOW });
    expect(r.state).toBe("done");
    expect(rt.covers).toBe(0);
    const store = fileJudgments(root);
    for (const field of FIELDS) {
      const j = await store.get(
        COVERS_FIELD_SPEC.kind,
        judgmentKey(COVERS_FIELD_SPEC.kind, coversInputs(field, CRITERION)),
      );
      expect(j).toMatchObject({
        verdict: "yes",
        confirmedBy: { by: "person", name: "priya.nair" },
        at: LATER,
      });
    }
  });

  it("an answer in the person's own words is read by a judge of the answer, and settles it the same way", async () => {
    const root = await estateRoot();
    await architected(root);
    const q = await asked(root);
    await answerQuestion(root, q.id, { text: PERSON, by: "priya.nair", at: LATER });
    const rt = new Direct("checks");
    const r = await storiesStage(root, CHANGE, { runtime: rt, now: NOW });
    expect(r.state).toBe("done");
    expect(rt.covers).toBe(0);
    expect(r.findings.some((f) => f.rule === "stories.check-not-in-criterion")).toBe(false);
  });

  it("'no: change the criterion' asks for a change; a draft that doesn't make it stops saying exactly that", async () => {
    const root = await estateRoot();
    await architected(root);
    const q = await asked(root);
    await answerQuestion(root, q.id, { option: 2, by: "priya.nair", at: LATER });
    const e = await stopOf(storiesStage(root, CHANGE, { runtime: new Direct(), now: NOW }));
    expect(e.message).toContain(
      `a person answered ${q.id} ("no: change the criterion"), and your assistant's draft still doesn't make the change it asks for`,
    );
    expect(e.message).not.toContain("still doesn't follow the answer");
  });
});

describe("V0: judge questions in the old form, one per field", () => {
  it("open ones are retired, naming what replaced them, and regrouped one per criterion; an answered one is the person's verdict", async () => {
    const root = await estateRoot();
    await architected(root);
    // The old form: one question per field, from before the one-per-criterion change.
    const old = (field: string) =>
      QuestionDraft.parse({
        question: `Does the criterion "${CRITERION}" of task 1.1 check ${field}? A judge read it and says no.`,
        evidence: [`${REL}/stage/stories.yaml:1`],
        options: [],
        scope: "repo",
      });
    const by = {
      step: "change-stories",
      repo: "forge-orders",
      command: `atticus plan stories ${CHANGE}`,
      rerun: `atticus plan stories ${CHANGE}`,
      at: "2026-10-24T08:00:00Z",
    };
    await mkdir(join(dir(root), "stage"), { recursive: true });
    await writeFile(join(dir(root), "stage/stories-answer.yaml"), STORIES);
    const qs: Question[] = [];
    for (const f of FIELDS) qs.push((await raiseQuestions(root, [old(f)], by)).raised[0]!);
    await answerQuestion(root, qs[0]!.id, { text: "Yes, it checks sku.", by: "pat", at: LATER });
    await writeFile(
      join(dir(root), "stage/stories.yaml"),
      stringify({
        schemaVersion: 1,
        change: CHANGE,
        stage: "stories",
        iteration: 3,
        state: "questions",
        updatedAt: "2026-10-24T08:00:00Z",
        questions: qs.map((q) => q.id).sort(),
        findings: FIELDS.map((f, i) => ({
          fingerprint: `${i}`.padStart(12, "0"),
          rule: "stories.check-not-in-criterion",
          target: `1.1:${f}`,
          message: `Task 1.1: the criterion "${CRITERION}" says it checks ${f}, but a judge read its then clause and says it doesn't assert that field's value: make the then clause assert it, or check it in another criterion.`,
          blocking: true,
          source: "stage",
          seenIn: [1, 2, 3],
          question: qs[i]!.id,
          kind: "decision",
        })),
      }),
    );
    const rt = new Direct("checks");
    const r = await storiesStage(root, CHANGE, { runtime: rt, now: NOW });
    for (const q of qs.slice(1)) {
      const now = (await readQuestion(root, q.id))!;
      expect(now.state).toBe("retired");
      expect(now.retired?.why).toContain("one question per criterion");
      expect(now.retired?.replacedBy?.length).toBe(1);
    }
    expect((await readQuestion(root, qs[0]!.id))!.state).toBe("answered");
    const open = (await listQuestions(root, { state: "open" })).questions;
    expect(open).toHaveLength(1);
    expect(open[0]!.question).toContain(`check quantity, cardToken and verdict`);
    expect(r.state).toBe("questions");
    expect(r.notes.join("\n")).toContain(
      `Retired 3 questions in the old form (one per field) for task 1.1's criterion; ${open[0]!.id} asks them as one.`,
    );
    const j = await fileJudgments(root).get(
      COVERS_FIELD_SPEC.kind,
      judgmentKey(COVERS_FIELD_SPEC.kind, coversInputs("sku", CRITERION)),
    );
    expect(j).toMatchObject({ verdict: "yes", confirmedBy: { by: "person", name: "pat" } });
  });
});

describe("V2: a criterion checks a field when its outcome depends on that field's value", () => {
  it("the judge's question says so, and the stories prompt asks for a refusal criterion per checked key from the first draft", async () => {
    expect(COVERS_FIELD_SPEC.ask).toContain("depend on the value of the field");
    expect(COVERS_FIELD_SPEC.ask).toContain("a value its given clause fixes");
    const root = await estateRoot();
    await architected(root);
    const seen: string[] = [];
    const rt = new MockRuntime(
      (req: AiRequest) => {
        if (req.agent.id.endsWith("-critic")) return "findings: []";
        if (req.agent.id === EXPAND_AGENT) return "terms: []\nnames: []\n";
        seen.push(req.pack.prompt);
        return STORIES;
      },
      { now: () => NOW },
    );
    await storiesStage(root, CHANGE, { runtime: rt, now: NOW });
    expect(seen[0]).toContain(
      "A criterion checks a field when its outcome depends on the field's value: its then clause states the value, or a result that follows from a value its given clause fixes.",
    );
    expect(seen[0]).toContain(
      "For each key a step matches rows by or checks (its fields.checks), add one criterion of its own for the refusal: what happens when that key doesn't match.",
    );
    void readFile;
  });
});
