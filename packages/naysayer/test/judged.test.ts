import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HandoffRuntime, judgeStandIn } from "@maycombhq/ai";
import { runCritic } from "../src/index.js";
import { CHANGE, NOW, forgeChangeRoot } from "./helpers.js";

/**
 * ADR 0117 addendum: whether a new column holds personal data is a judgment, not a word list
 * (looksPersonal is deleted). The critic settles it before layer 1: a personal class written by
 * name, a judgment on file, the judge where the runtime calls a model; else it asks a person.
 */

const rule = "constitution.data-columns-classified";
const personalOf = (r: Awaited<ReturnType<typeof runCritic>>) =>
  r.findings.filter((f) => f.finding.rule === rule).map((f) => [f.finding.kind, f.finding.summary]);

describe("the critic's personal-data judgment", () => {
  it("asks the judge in one prompt where a model can be called, and keeps each verdict", async () => {
    const root = await forgeChangeRoot({ judgments: false });
    const judge = judgeStandIn(
      (it) => ({
        verdict: it.texts.column === "changed_by_email" ? "yes" : "no",
        quotes: [{ of: "column", text: it.texts.column! }],
      }),
      { now: () => new Date(NOW) },
    );
    const r = await runCritic(root, CHANGE, { now: NOW, runtime: judge.runtime });
    // One judge prompt for all seven columns (the AI lenses' prompts aside).
    expect(
      judge.prompts.filter((p) => p.includes("Does the column hold personal data")),
    ).toHaveLength(1);
    expect(personalOf(r)).toEqual([
      [
        "issue",
        "changed_by_email in limit_change looks like personal data but is not classified as personal.",
      ],
    ]);
    expect(readdirSync(join(root, "judgments", "personal-data"))).toHaveLength(7);
  });

  it("reads a person's verdicts on file, the same on every round, with no model", async () => {
    const root = await forgeChangeRoot();
    const r = await runCritic(root, CHANGE, { now: NOW });
    expect(personalOf(r)).toEqual([
      [
        "issue",
        "changed_by_email in limit_change looks like personal data but is not classified as personal.",
      ],
    ]);
  });

  it("with the hand-off runtime and nothing on file asks a person, never a word list", async () => {
    const root = await forgeChangeRoot({ judgments: false });
    await mkdir(join(root, ".runs"), { recursive: true });
    const runtime = new HandoffRuntime({
      root,
      validate: async () => [],
      now: () => new Date(NOW),
    });
    const r = await runCritic(root, CHANGE, { now: NOW, runtime });
    // The lenses are handed off as ever; no judge prompt is: it would cost the person a round.
    const prompts = readdirSync(join(root, ".runs", CHANGE)).map((id) =>
      readFileSync(join(root, ".runs", CHANGE, id, "prompt.md"), "utf8"),
    );
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts.some((p) => p.includes("Does the column hold personal data"))).toBe(false);
    expect(existsSync(join(root, "judgments"))).toBe(false);
    const found = r.findings.filter((f) => f.finding.rule === rule);
    expect(found.map((f) => f.finding.kind)).toEqual(["knowledge-gap", "knowledge-gap"]);
    expect(found.map((f) => f.finding.summary)).toEqual([
      "No one has judged whether daily_limit in account holds personal data.",
      "No one has judged whether id, account_id, old_limit, new_limit, changed_by_email, changed_at in limit_change hold personal data.",
    ]);
    expect(found[1]!.finding.question?.text).toBe(
      "Which of id, account_id, old_limit, new_limit, changed_by_email, changed_at in limit_change hold personal data?",
    );
  });
});
