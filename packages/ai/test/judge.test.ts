import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { judgmentKey, memoryJudgments, type QuestionPair, type RuntimeKind } from "@maycombhq/core";
import {
  COVERS_FIELD_SPEC,
  HandoffRuntime,
  judgesDirectly,
  judge,
  settle,
  judgeInstructions,
  MockRuntime,
  questionJudge,
  ReplayRuntime,
  recordRun,
  SAME_QUESTION_SPEC,
  type AiRequest,
  type JudgeItem,
} from "../src/index.js";

/** ADR 0117: the judge step, through the runtime like any AI step. */

const NOW = new Date("2026-10-23T12:00:00Z");

const pair = (n: string, e: string, repo = "forge-chat"): JudgeItem => ({
  inputs: { v: 1, repo, new: n, existing: e },
  texts: { new: n, existing: e },
});

const answer = (
  rows: { item: number; verdict: string; quotes?: { of: string; text: string }[]; why?: string }[],
) => stringify({ judgments: rows });

describe("judge (ADR 0117)", () => {
  it("asks one closed question for a batch in one prompt, checks every quote, and keeps the verdict", async () => {
    const prompts: string[] = [];
    const rt = new MockRuntime(
      (r) => {
        prompts.push(r.pack.prompt);
        return answer([
          {
            item: 1,
            verdict: "same",
            quotes: [
              { of: "new", text: "an audit trail of earlier titles" },
              { of: "existing", text: "kept as a history" },
            ],
            why: "Both ask whether earlier titles are kept.",
          },
          {
            item: 2,
            verdict: "different",
            quotes: [
              { of: "new", text: "shown to the user" },
              { of: "existing", text: "nullable" },
            ],
          },
        ]);
      },
      { now: () => NOW },
    );
    const store = memoryJudgments();
    const items = [
      pair(
        "Does renaming a chat need an audit trail of earlier titles?",
        "Should renames be kept as a history?",
      ),
      pair("Is chat.title shown to the user?", "Is chat.title nullable?"),
    ];
    const r = await judge(SAME_QUESTION_SPEC, items, {
      runtime: rt,
      store,
      change: "rename-chat",
      now: NOW,
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Answer with one of these words, nothing else:");
    // The texts are data, wrapped like any ingested content.
    expect(prompts[0]).toContain("<atticus-data");
    expect([...r.results.values()].map((x) => [x.verdict, x.by])).toEqual([
      ["same", "model"],
      ["different", "model"],
    ]);
    const kept = store.all();
    expect(kept).toHaveLength(2);
    expect(kept[0]!.confirmedBy).toEqual({ by: "ai", run: r.runs[0]!.runId });
    expect(kept[0]!.key).toBe(judgmentKey("same-question", items[0]!.inputs));

    // Asked again with the same inputs: the stored verdicts, and no model call.
    const again = await judge(SAME_QUESTION_SPEC, items, {
      runtime: rt,
      store,
      change: "rename-chat",
      now: NOW,
    });
    expect(prompts).toHaveLength(1);
    expect([...again.results.values()].map((x) => x.by)).toEqual(["stored", "stored"]);
  });

  it("runs the veto first: renamedAt and renamedBy never reach the model", async () => {
    let calls = 0;
    const rt = new MockRuntime(() => {
      calls++;
      return answer([]);
    });
    const r = await judge(
      SAME_QUESTION_SPEC,
      [
        pair(
          "How is the new column renamedBy of forge-chat-db.chat classified?",
          "How is the new column renamedAt of forge-chat-db.chat classified?",
        ),
      ],
      { runtime: rt, store: memoryJudgments(), change: "rename-chat", now: NOW },
    );
    expect(calls).toBe(0);
    expect([...r.results.values()]).toEqual([
      expect.objectContaining({ verdict: "different", by: "veto" }),
    ]);
  });

  it("asks once more when a quote isn't word for word, then counts it unsure", async () => {
    const prompts: string[] = [];
    const rt = new MockRuntime((r) => {
      prompts.push(r.pack.prompt);
      return answer([
        {
          item: 1,
          verdict: "same",
          quotes: [
            { of: "new", text: "a log of renames" },
            { of: "existing", text: "kept as a history" },
          ],
        },
      ]);
    });
    const store = memoryJudgments();
    const r = await judge(
      SAME_QUESTION_SPEC,
      [
        pair(
          "Does renaming a chat need an audit trail of earlier titles?",
          "Should renames be kept as a history?",
        ),
      ],
      { runtime: rt, store, change: "rename-chat", now: NOW },
    );
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('item 1: "a log of renames" isn\'t word for word in new');
    expect([...r.results.values()][0]!.verdict).toBe("unsure");
    expect(store.all()[0]!.why).toMatch(/^Refused twice/);
  });

  it("refuses an answer outside the closed set", async () => {
    const rt = new MockRuntime(() => answer([{ item: 1, verdict: "probably", quotes: [] }]));
    const r = await judge(SAME_QUESTION_SPEC, [pair("Is a kept?", "Is b kept?")], {
      runtime: rt,
      store: memoryJudgments(),
      change: "c",
      now: NOW,
    });
    expect([...r.results.values()][0]!.verdict).toBe("unsure");
  });

  it("is handed off like any step: the run waits, and resuming it reads the verdicts in", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-judge-handoff-"));
    await mkdir(join(root, "openspec", "changes", "rename-chat"), { recursive: true });
    const rt = new HandoffRuntime({ root, validate: async () => [], now: () => NOW });
    const store = memoryJudgments();
    const items = [pair("Is chat.title shown to the user?", "Is chat.title nullable?")];
    const first = await judge(SAME_QUESTION_SPEC, items, {
      runtime: rt,
      store,
      change: "rename-chat",
      now: NOW,
    });
    expect(first.results.size).toBe(0);
    const runId = first.waiting!.runId;
    const dir = join(root, ".runs", "rename-chat", runId);
    expect(await readFile(join(dir, "prompt.md"), "utf8")).toContain(
      `Write the result to .runs/rename-chat/${runId}/judgments.yaml.`,
    );
    await writeFile(
      join(dir, "judgments.yaml"),
      answer([
        {
          item: 1,
          verdict: "different",
          quotes: [
            { of: "new", text: "shown to the user" },
            { of: "existing", text: "nullable" },
          ],
        },
      ]),
      "utf8",
    );
    await rt.done(runId);
    const resumed = await judge(SAME_QUESTION_SPEC, items, {
      runtime: rt,
      store,
      change: "rename-chat",
      now: NOW,
      resume: runId,
    });
    expect([...resumed.results.values()].map((x) => x.verdict)).toEqual(["different"]);
    expect(store.all()[0]!.confirmedBy).toEqual({ by: "ai", run: runId });
  });

  it("replays a recorded verdict by the prompt's hash, as CI does", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atticus-judge-rec-"));
    const items = [pair("Is chat.title shown to the user?", "Is chat.title nullable?")];
    // Record once (a stand-in for a live model, outside CI), then replay from the folder.
    const said = answer([
      {
        item: 1,
        verdict: "different",
        quotes: [
          { of: "new", text: "shown" },
          { of: "existing", text: "nullable" },
        ],
      },
    ]);
    let request: AiRequest | undefined;
    const live = new MockRuntime((r) => {
      request = r;
      return said;
    });
    await judge(SAME_QUESTION_SPEC, items, {
      runtime: live,
      store: memoryJudgments(),
      change: "c",
      now: NOW,
    });
    await recordRun(new MockRuntime(() => said), request!, dir, "recorded", NOW);
    const files = await readdir(join(dir, "judge")).catch(() => []);
    expect(files).toHaveLength(1);
    const replay = await ReplayRuntime.fromDir(dir);
    const r = await judge(SAME_QUESTION_SPEC, items, {
      runtime: replay,
      store: memoryJudgments(),
      change: "c",
      now: NOW,
    });
    expect([...r.results.values()].map((x) => x.verdict)).toEqual(["different"]);
  });

  it("judges raiseQuestions' open pairs (questionJudge)", async () => {
    const rt = new MockRuntime(() =>
      answer([
        {
          item: 1,
          verdict: "narrower",
          quotes: [
            { of: "new", text: "Which gateway" },
            { of: "existing", text: "Who calls POST /payments" },
          ],
        },
      ]),
    );
    const p = {
      key: judgmentKey("same-question", { a: 1 }),
      inputs: { a: 1 },
      repo: "forge-pay",
      draft: {
        question: "Which gateway does POST /payments come through?",
        options: [],
        evidence: ["a.yaml:1"],
        scope: "repo",
      },
      existing: {
        id: "q-000000000001",
        question: "Who calls POST /payments, and through which gateway?",
        evidence: ["a.yaml:1"],
        state: "open",
      },
    } as unknown as QuestionPair;
    const j = questionJudge({ runtime: rt, store: memoryJudgments(), change: "pay", now: NOW });
    expect([...(await j([p])).entries()]).toEqual([[p.key, "narrower"]]);
    expect(judgeInstructions(SAME_QUESTION_SPEC)).toContain("- narrower:");
  });
});

/** A runtime that calls a model directly: the mock, under another kind. */
class DirectRuntime extends MockRuntime {
  constructor(
    respond: (r: AiRequest) => string,
    override readonly kind: RuntimeKind = "model",
  ) {
    super(respond, { now: () => NOW });
  }
}

describe("settle (ADR 0117): judged where a model is called directly, never guessed", () => {
  // The criterion from a real metarepo: the count depends on lastReadAt without naming it.
  const criterion =
    "Given a room never opened, when four messages arrive after joinedAt, then unreadCount is 4, counting messages after joinedAt";
  const item: JudgeItem = {
    inputs: { v: 1, field: "lastReadAt", criterion },
    texts: { criterion },
    facts: ["the field: lastReadAt"],
  };

  it("with a hand-off asks nothing and leaves the item unjudged; a stored verdict still settles it", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-settle-"));
    const rt = new HandoffRuntime({ root, validate: async () => [], now: () => NOW });
    expect(judgesDirectly(rt)).toBe(false);
    const store = memoryJudgments();
    const r = await settle(COVERS_FIELD_SPEC, [item], {
      runtime: rt,
      store,
      change: "c",
      now: NOW,
    });
    const key = judgmentKey(COVERS_FIELD_SPEC.kind, item.inputs);
    // Nothing settled it: the item is open (unjudged), not a yes or a no.
    expect(r.has(key)).toBe(false);
    expect(r.size).toBe(0);
    // No run was handed off: no prompt for the person.
    await expect(readdir(join(root, ".runs"))).rejects.toThrow();
    // A verdict on file (a person's, or an earlier model's) settles it with no call.
    await store.put({
      schemaVersion: 1,
      kind: COVERS_FIELD_SPEC.kind,
      key,
      verdict: "yes",
      quotes: [{ of: "criterion", text: "unreadCount is 4, counting messages after joinedAt" }],
      inputs: item.inputs,
      confirmedBy: { by: "person", name: "pat" },
      at: "2026-10-23T12:00:00Z",
    });
    const again = await settle(COVERS_FIELD_SPEC, [item], {
      runtime: rt,
      store,
      change: "c",
      now: NOW,
    });
    expect(again.get(key)).toMatchObject({ verdict: "yes", by: "stored" });
  });

  it("with a direct model asks the judge once, and keeps its verdict", async () => {
    let calls = 0;
    const rt = new DirectRuntime(() => {
      calls++;
      return answer([
        {
          item: 1,
          verdict: "yes",
          quotes: [{ of: "criterion", text: "unreadCount is 4, counting messages after joinedAt" }],
          why: "The count is of messages after the last read; never opened, that is joinedAt.",
        },
      ]);
    });
    expect(judgesDirectly(rt)).toBe(true);
    const store = memoryJudgments();
    const r = await settle(COVERS_FIELD_SPEC, [item], {
      runtime: rt,
      store,
      change: "c",
      now: NOW,
    });
    expect(calls).toBe(1);
    expect([...r.values()].map((x) => [x.verdict, x.by])).toEqual([["yes", "model"]]);
    expect(
      (await store.get(COVERS_FIELD_SPEC.kind, judgmentKey(COVERS_FIELD_SPEC.kind, item.inputs)))
        ?.confirmedBy.by,
    ).toBe("ai");
  });
});
