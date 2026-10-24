import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { judgmentTable, runJudgmentBench } from "../src/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("the judgments' eval (ADR 0117)", () => {
  it("scores each replaced judgment against the old heuristic, on the recorded verdicts", async () => {
    const rows = await runJudgmentBench(ROOT);
    console.log(`\n${judgmentTable(rows)}\n`);
    const by = Object.fromEntries(rows.map((r) => [r.kind, r]));
    // Every replaced judgment is at least as right as the rule it replaced, and never says yes
    // where the truth is no: no reused answer, no passed value, no untested field.
    for (const r of rows) {
      expect({ kind: r.kind, better: r.model.correct >= r.old.correct }).toEqual({
        kind: r.kind,
        better: true,
      });
      expect({ kind: r.kind, wrongYes: r.model.wrongYes }).toEqual({ kind: r.kind, wrongYes: 0 });
    }
    // The audit's failing examples, one by one.
    expect(by["same-question"]!.old.wrong).toEqual(
      expect.arrayContaining([
        "renamed-at-vs-renamed-by",
        "retry-timeout-vs-5xx",
        "nullable-vs-shown",
      ]),
    );
    expect(by["same-question"]!.model.wrong).toEqual([]);
    expect(by["covers-field"]!.old.wrong).toEqual(
      expect.arrayContaining([
        "id-inside-valid",
        "renamed-event-not-field",
        "given-fixes-lookup-id",
      ]),
    );
    // ADR 0117 addendum (V2): a given that fixes a lookup's key and a then that follows from it
    // checks the key; the judge says yes.
    expect(by["covers-field"]!.model.wrong).not.toContain("given-fixes-lookup-id");
    expect(by["states-value"]!.old.wrong).toEqual(
      expect.arrayContaining([
        "three-days-in-approvers",
        "no-sign-off-is-not-a-ban",
        "date-scattered",
      ]),
    );
    // The addendum's kinds (release views, critic, readiness bar, wiki facts): each word rule
    // failed both ways, and the judge, checked by its facts, gets every case.
    expect(by["breaking"]!.old.wrong).toEqual(
      expect.arrayContaining([
        "removed-inside-an-addition",
        "drop-off-is-not-a-drop",
        "always-present-now",
        "new-error-to-handle",
        "type-changes",
        "must-now-send",
      ]),
    );
    expect(by["undoes"]!.old.wrong).toEqual(
      expect.arrayContaining([
        "restore-is-a-feature",
        "undo-is-a-feature",
        "no-rollback-yet",
        "redeploy-paraphrase",
        "feature-flag-off",
      ]),
    );
    expect(by["names-secret"]!.old.wrong).toEqual(
      expect.arrayContaining([
        "token-bucket",
        "password-reset-link",
        "certificate-of-deposit",
        "hmac-signing-paraphrase",
        "client-secret-identifier",
        "access-key-in-the-text",
      ]),
    );
    expect(by["personal-data"]!.old.wrong).toEqual(
      expect.arrayContaining(["product-name", "ip-allowlist-flag", "msisdn", "given-names"]),
    );
    expect(by["asks-check"]!.old.wrong).toEqual(
      expect.arrayContaining([
        "acceptance-by-the-owner",
        "user-interface-copy",
        "waits-on-named",
        "services-and-codebases",
      ]),
    );
    expect(by["reaches"]!.old.wrong).toEqual(
      expect.arrayContaining([
        "directly-not-through",
        "over-the-api-gateway",
        "directly-owns",
        "no-longer-through-the-api",
        "api-only-in-other-words",
      ]),
    );
    for (const k of [
      "breaking",
      "undoes",
      "names-secret",
      "personal-data",
      "asks-check",
      "reaches",
    ]) {
      // The judge gets every case, in one batched call; the hand-off guesses none (an open item
      // is shown to a person, never a yes).
      expect({ k, wrong: by[k]!.model.wrong, prompts: by[k]!.prompts }).toEqual({
        k,
        wrong: [],
        prompts: 1,
      });
      expect({ k, handoffWrongYes: by[k]!.handoff.wrongYes }).toEqual({ k, handoffWrongYes: 0 });
    }
    // A hand-off spends no judge call and reuses no answer it hasn't been shown.
    expect(by["same-question"]!.handoff.wrongYes).toBe(0);
    // One batched call per kind with open items.
    expect(by["same-question"]!.prompts).toBeLessThanOrEqual(by["same-question"]!.cases);
    expect(by["covers-field"]!.prompts).toBe(1);
    expect(by["states-value"]!.prompts).toBeGreaterThan(0);
  });
});
