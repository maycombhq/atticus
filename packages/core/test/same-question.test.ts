import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  answerQuestion,
  differentThings,
  fileJudgments,
  judgmentKey,
  listQuestions,
  makeJudgment,
  namedIdentifiers,
  QuestionDraft,
  raiseQuestions,
  SAME_QUESTION,
  sameQuestionInputs,
  type QuestionJudge,
  type SameVerdict,
} from "../src/index.js";

/** ADR 0117: a question is the same as one on file by the veto, then a judgment, kept. */

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures/judgments/same-question.yaml",
);
interface Case {
  id: string;
  repo?: string;
  new: { question: string; evidence: string[] };
  existing: { question: string; evidence: string[]; state: "open" | "answered" };
  truth: SameVerdict;
  recorded?: { verdict: SameVerdict };
}
const cases = async () => parse(await readFile(FIXTURE, "utf8")) as { repo: string; cases: Case[] };

const AT = "2026-10-23T12:00:00Z";
const by = (step: string, repo: string = "forge-chat") => ({
  step,
  repo,
  command: `atticus ${step} ${repo}`,
  rerun: `atticus ${step} ${repo}`,
  run: `run-20261023120000-${step === "first" ? "0001" : "0002"}`,
  at: AT,
});

async function metarepo() {
  const root = await mkdtemp(join(tmpdir(), "atticus-same-q-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  return root;
}

const draft = (q: { question: string; evidence: string[] }, extra: object = {}) =>
  QuestionDraft.parse({
    question: q.question,
    evidence: q.evidence,
    options: [],
    scope: "repo",
    ...extra,
  });

/** A judge that replays the recorded verdicts, by the existing question's words. */
const replay =
  (all: Case[], calls: number[] = []): QuestionJudge =>
  async (pairs) => {
    calls.push(pairs.length);
    const out = new Map<string, SameVerdict>();
    for (const p of pairs) {
      const c = all.find(
        (x) => x.existing.question === p.existing.question && x.new.question === p.draft.question,
      );
      if (c?.recorded) out.set(p.key, c.recorded.verdict);
    }
    return out;
  };

async function onFile(root: string, c: Case) {
  const first = await raiseQuestions(root, [draft(c.existing)], by("first", c.repo));
  const q = first.raised[0]!;
  if (c.existing.state === "answered")
    await answerQuestion(root, q.id, { text: "Internal", by: "priya.nair", at: AT });
  return q;
}

describe("the veto (ADR 0117)", () => {
  it("names the ids, fields, paths and numbers a question writes", () => {
    expect([
      ...namedIdentifiers("How is the new column renamedAt of forge-chat-db.chat classified?"),
    ]).toEqual(["renamedat", "forge-chat-db.chat"]);
    expect(namedIdentifiers("Is renamed_at kept?").has("renamedat")).toBe(true);
    expect([...namedIdentifiers("Who calls POST /payments?")]).toEqual(["/payments"]);
    expect([...namedIdentifiers("Is it limited to 1000 messages?")]).toEqual(["1000"]);
    expect([...namedIdentifiers("Should renames be kept as a history?")]).toEqual([]);
  });

  it("says two questions that each name something the other doesn't are different", () => {
    const q = (question: string) => ({ question });
    expect(
      differentThings(
        q("How is the new column renamedAt of forge-chat-db.chat classified?"),
        q("How is the new column renamedBy of forge-chat-db.chat classified?"),
      ),
    ).toMatch(/renamedat.*renamedby/);
    expect(
      differentThings(q("Is forge-legacy still used?"), q("Is forge-admin still used?")),
    ).toBeDefined();
    // One naming more than the other isn't a veto: that is for the judge (narrower).
    expect(
      differentThings(
        q("Which gateway does POST /payments come through?"),
        q("Who calls POST /payments?"),
      ),
    ).toBeUndefined();
    expect(
      differentThings(q("Kept as a history?"), q("An audit trail of titles?")),
    ).toBeUndefined();
  });
});

describe("a question weighed against the questions on file (ADR 0117)", () => {
  it("reuses only what a person reading both would call the same, on the recorded verdicts", async () => {
    const { cases: all } = await cases();
    for (const c of all) {
      const root = await metarepo();
      const existing = await onFile(root, c);
      const r = await raiseQuestions(root, [draft(c.new)], by("second", c.repo), {
        judge: replay(all),
      });
      const reused = r.reused.some((q) => q.id === existing.id);
      expect({ id: c.id, reused }).toEqual({ id: c.id, reused: c.truth === "same" });
      if (c.truth !== "same") {
        expect(r.raised).toHaveLength(1);
        const related = r.raised[0]!.related ?? [];
        expect({ id: c.id, related: related.map((x) => x.verdict) }).toEqual({
          id: c.id,
          related: c.truth === "narrower" ? ["narrower"] : [],
        });
      }
      expect(r.of[0]).toBeDefined();
    }
  });

  it("never reuses renamedAt's classification for renamedBy, even when a model says same", async () => {
    const { cases: all } = await cases();
    const c = all.find((x) => x.id === "renamed-at-vs-renamed-by")!;
    const root = await metarepo();
    await onFile(root, c);
    const asked: number[] = [];
    const yes: QuestionJudge = async (pairs) => {
      asked.push(pairs.length);
      return new Map(pairs.map((p) => [p.key, "same" as const]));
    };
    const r = await raiseQuestions(
      root,
      [draft(c.new, { sameAs: { id: "q-000000000000", verdict: "same", quote: "classified" } })],
      by("second"),
      { judge: yes },
    );
    expect(r.reused).toEqual([]);
    expect(r.raised).toHaveLength(1);
    expect(asked).toEqual([]);
  });

  it("raises a question as related, never reused, when no judge ran", async () => {
    const { cases: all } = await cases();
    const c = all.find((x) => x.id === "rename-history-paraphrase")!;
    const root = await metarepo();
    const existing = await onFile(root, c);
    const r = await raiseQuestions(root, [draft(c.new)], by("second"));
    expect(r.reused).toEqual([]);
    expect(r.raised[0]!.related).toEqual([{ id: existing.id, verdict: "unsure" }]);
    expect(r.raised[0]!.schemaVersion).toBe(2);
  });

  it("follows the step's own reading when its words are in the earlier question, and keeps it", async () => {
    const { cases: all } = await cases();
    const c = all.find((x) => x.id === "rename-history-paraphrase")!;
    const root = await metarepo();
    const existing = await onFile(root, c);
    // A quote that isn't in the earlier question isn't followed.
    const wrong = await raiseQuestions(
      root,
      [draft(c.new, { sameAs: { id: existing.id, verdict: "same", quote: "a log of renames" } })],
      by("second"),
    );
    expect(wrong.reused).toEqual([]);
    const root2 = await metarepo();
    const existing2 = await onFile(root2, c);
    const right = await raiseQuestions(
      root2,
      [
        draft(c.new, {
          sameAs: { id: existing2.id, verdict: "same", quote: "kept as a  history" },
        }),
      ],
      by("second"),
    );
    expect(right.reused.map((q) => q.id)).toEqual([existing2.id]);
    const kept = await fileJudgments(root2).list(SAME_QUESTION);
    expect(kept.judgments).toHaveLength(1);
    expect(kept.judgments[0]).toMatchObject({
      verdict: "same",
      confirmedBy: { by: "ai", run: "run-20261023120000-0002" },
      quotes: [{ of: "existing", text: "kept as a  history" }],
    });
  });

  it("reads a stored verdict instead of asking again: a person's decision on file is followed", async () => {
    const { cases: all } = await cases();
    const c = all.find((x) => x.id === "nullable-vs-shown")!;
    const root = await metarepo();
    const existing = await onFile(root, c);
    const store = fileJudgments(root);
    const inputs = sameQuestionInputs("forge-chat", c.new, {
      id: existing.id,
      question: c.existing.question,
      evidence: c.existing.evidence,
    });
    await store.put(
      makeJudgment({
        kind: SAME_QUESTION,
        inputs,
        verdict: "same",
        confirmedBy: { by: "person", name: "priya.nair" },
        at: AT,
      }),
    );
    const never: QuestionJudge = async () => {
      throw new Error("the stored verdict should have been read");
    };
    const r = await raiseQuestions(root, [draft(c.new)], by("second"), { judge: never });
    expect(r.reused.map((q) => q.id)).toEqual([existing.id]);
    expect(judgmentKey(SAME_QUESTION, inputs)).toMatch(/^[0-9a-f]{24}$/);
    // A changed input is its own judgment: the new words aren't the stored ones.
    const changed = await raiseQuestions(
      root,
      [draft({ ...c.new, question: "Is chat.title shown in the chat list?" })],
      by("second"),
      { judge: replay(all) },
    );
    expect(changed.reused).toEqual([]);
    expect((await listQuestions(root)).questions).toHaveLength(2);
  });
});
