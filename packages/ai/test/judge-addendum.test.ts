import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { judgmentKey, makeJudgment, memoryJudgments } from "@maycombhq/core";
import {
  ASKS_CHECK_SPEC,
  BREAKING_SPEC,
  CLASSIFIED_PERSONAL,
  HandoffRuntime,
  judgeItemsOf,
  judgeStandIn,
  judgesDirectly,
  MockRuntime,
  NAMES_SECRET_SPEC,
  PERSONAL_DATA_SPEC,
  personalItem,
  REACHES_SPEC,
  settle,
  tokenFormatIn,
  UNDOES_SPEC,
  type JudgeItem,
} from "../src/index.js";

/** ADR 0117 addendum: the kinds that replaced the release, critic, bar and facts word rules. */

const NOW = new Date("2026-10-23T12:00:00Z");
const item = (inputs: Record<string, unknown>, texts: Record<string, string>): JudgeItem => ({
  inputs,
  texts,
});

describe("the addendum's vetoes: facts settle an item before the model", () => {
  it("breaking: a retired operation breaks its callers, a new one has none", () => {
    expect(BREAKING_SPEC.veto!(item({ change: "planned-retire" }, { notes: "" }))).toEqual({
      verdict: "yes",
      rule: "veto:retired-operation",
    });
    expect(BREAKING_SPEC.veto!(item({ change: "planned-new" }, { notes: "" }))?.verdict).toBe("no");
    expect(BREAKING_SPEC.veto!(item({ change: "planned-modify" }, { notes: "x" }))).toBeUndefined();
  });

  it("undoes: a sentence naming another step and not this one is about that step", () => {
    const s = "To roll back ledger-api, redeploy the previous ledger-api image.";
    expect(
      UNDOES_SPEC.veto!(
        item({ sentence: s, names: ["portal-bff"], others: ["ledger-api"] }, { sentence: s }),
      )?.verdict,
    ).toBe("no");
    // Its own name, or no name at all: the judge reads it.
    expect(
      UNDOES_SPEC.veto!(
        item({ sentence: s, names: ["ledger-api"], others: ["portal-bff"] }, { sentence: s }),
      ),
    ).toBeUndefined();
    // A name inside another word is not a name: "api" isn't in "rapid".
    expect(
      UNDOES_SPEC.veto!(
        item({ sentence: "A rapid rollback.", names: ["x"], others: ["api"] }, { sentence: "" }),
      ),
    ).toBeUndefined();
  });

  it("names-secret: a token in a known format is a fact; words about secrets are not", () => {
    expect(tokenFormatIn("key AKIAABCDEFGHIJKLMNOP here")).toBe("a cloud access key");
    expect(tokenFormatIn("-----BEGIN RSA PRIVATE KEY-----")).toBe("a private key");
    expect(tokenFormatIn("rotate the shared secret")).toBeUndefined();
    expect(
      NAMES_SECRET_SPEC.veto!(item({ line: "use AKIAABCDEFGHIJKLMNOP" }, { line: "" }))?.rule,
    ).toBe("veto:token-format");
    expect(NAMES_SECRET_SPEC.veto!(item({ line: "a token bucket" }, { line: "" }))).toBeUndefined();
  });

  it("personal-data: a column classified personal is settled; the key leaves that fact out", () => {
    const a = personalItem({ column: "payee_reference", table: "transfer", type: "varchar(35)" });
    const b = personalItem({
      column: "payee_reference",
      table: "transfer",
      type: "varchar(35)",
      classifiedPersonal: true,
    });
    expect(judgmentKey(PERSONAL_DATA_SPEC.kind, a.inputs)).toBe(
      judgmentKey(PERSONAL_DATA_SPEC.kind, b.inputs),
    );
    expect(b.facts).toContain(CLASSIFIED_PERSONAL);
    expect(PERSONAL_DATA_SPEC.veto!(b)?.verdict).toBe("yes");
    expect(PERSONAL_DATA_SPEC.veto!(a)).toBeUndefined();
  });

  it("asks-check: an item in Atticus's default wording has the checks it was written with", () => {
    const known = (check: string) =>
      ASKS_CHECK_SPEC.veto!(
        item({ item: "Dependencies named", check, known: ["depends"] }, { item: "" }),
      )?.verdict;
    expect(known("depends")).toBe("yes");
    expect(known("tests")).toBe("no");
    expect(
      ASKS_CHECK_SPEC.veto!(item({ item: "Edge cases listed", check: "tests" }, { item: "" })),
    ).toBeUndefined();
  });

  it("reaches has no veto: the pair is the mention index's fact, the meaning the judge's", () => {
    expect(REACHES_SPEC.veto).toBeUndefined();
    expect(REACHES_SPEC.verdicts).toEqual(["gateway", "direct", "api-only", "none"]);
  });
});

describe("settle: what a step can know without spending a person's prompt", () => {
  const items = [
    item(
      { v: 1, change: "planned-modify", notes: "The field acct is renamed." },
      {
        notes: "The field acct is renamed.",
      },
    ),
    item({ v: 1, change: "planned-new", notes: "" }, { notes: "" }),
  ];

  it("asks the judge in one batched prompt where the runtime calls a model, and keeps it", async () => {
    const j = judgeStandIn(
      (it) =>
        it.texts.notes?.includes("renamed")
          ? { verdict: "yes", quotes: [{ of: "notes", text: "is renamed" }] }
          : undefined,
      { now: () => NOW },
    );
    expect(judgesDirectly(j.runtime)).toBe(true);
    const store = memoryJudgments();
    const r = await settle(BREAKING_SPEC, items, {
      runtime: j.runtime,
      store,
      change: "c",
      now: NOW,
    });
    expect(j.calls()).toBe(1);
    expect([...r.values()].map((x) => [x.verdict, x.by])).toEqual([
      ["no", "veto"],
      ["yes", "model"],
    ]);
    expect(store.all()).toHaveLength(1);
  });

  it("with the hand-off runtime asks nothing: the veto and judgments on file only", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-settle-"));
    await mkdir(join(root, "openspec", "changes", "c"), { recursive: true });
    const rt = new HandoffRuntime({ root, validate: async () => [], now: () => NOW });
    expect(judgesDirectly(rt)).toBe(false);
    expect(judgesDirectly(new MockRuntime(() => ""))).toBe(false);
    const store = memoryJudgments();
    const open = await settle(BREAKING_SPEC, items, { runtime: rt, store, change: "c", now: NOW });
    // The renamed field is open: no word rule stands in for the judgment.
    expect([...open.values()].map((x) => [x.verdict, x.by])).toEqual([["no", "veto"]]);
    await store.put(
      makeJudgment({
        kind: BREAKING_SPEC.kind,
        inputs: items[0]!.inputs,
        verdict: "yes",
        confirmedBy: { by: "person", name: "dana" },
        at: "2026-10-23T12:00:00Z",
      }),
    );
    const read = await settle(BREAKING_SPEC, items, { runtime: rt, store, change: "c", now: NOW });
    expect([...read.values()].map((x) => [x.verdict, x.by])).toEqual([
      ["yes", "stored"],
      ["no", "veto"],
    ]);
  });

  it("reads the items of a judge prompt back, texts and facts, as a stand-in model does", () => {
    const prompt = [
      "item 1:",
      '  column: "changed_by_email"',
      "  facts:",
      "    - table: limit_change",
      "    - type: varchar(200)",
      "item 2:",
      '  column: "daily_limit"',
    ].join("\n");
    expect(judgeItemsOf(prompt)).toEqual([
      {
        texts: { column: "changed_by_email" },
        facts: ["table: limit_change", "type: varchar(200)"],
      },
      { texts: { column: "daily_limit" }, facts: [] },
    ]);
  });
});
