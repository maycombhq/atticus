import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { answerQuestion, loadOrgPack, raiseQuestions, TARGETS_STEP_ID } from "@maycombhq/core";
import { ruleLineOf, rulesCovering } from "../src/map-commands.js";

/**
 * ADR 0162 (F8): /atticus-map is given the answers by rule that cover the repo, from other repos'
 * questions (its type's, or its own), beside the repo's own answered questions, so the reader
 * doesn't ask what one settles. On the invented bank-shaped estate (fixtures/link-estate).
 */

const FIX = join(__dirname, "..", "..", "..", "fixtures", "link-estate");
const AT = "2026-11-01T12:00:00.000Z";

describe("rulesCovering (ADR 0162)", () => {
  it("gives a repo the rules of its type from other repos' answers, and not another type's", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-map-rules-"));
    await cp(join(FIX, "org-pack"), join(root, "org-pack"), { recursive: true });
    const { raised } = await raiseQuestions(
      root,
      [
        {
          question:
            "Which repo or system answers the calls forge-accounts makes under /notifications?",
          options: [
            { label: "forge-notifications", means: "it serves them", changes: "they join it" },
            { label: "None of these", means: "nothing", changes: "loose ends" },
          ],
          evidence: ["src/main/java/forge/accounts/NotifyClient.java:16"],
          scope: "repo",
        },
      ],
      {
        step: TARGETS_STEP_ID,
        repo: "forge-accounts",
        command: "atticus verify forge-accounts --write",
        rerun: "atticus verify forge-accounts --write",
        at: AT,
      },
    );
    const q = raised[0]!;
    await answerQuestion(root, q.id, {
      option: 1,
      match: "/notifications/**",
      scope: "repo-type",
      repoType: "spring-boot",
      by: "pat",
      at: AT,
    });
    const op = await loadOrgPack(join(root, "org-pack"));
    const rules = await rulesCovering(root, "forge-payments", op);
    expect(rules).toEqual([
      {
        id: q.id,
        from: "forge-accounts",
        match: "/notifications/**",
        answer: "forge-notifications",
        scope: "every spring-boot repo",
      },
    ]);
    expect(ruleLineOf(rules[0]!)).toBe(
      `Rule ${q.id} (answered for forge-accounts, covers every spring-boot repo): the calls matching /notifications/** go to forge-notifications.`,
    );
    // The repo that answered has it among its own questions; a gateway isn't of that type.
    expect(await rulesCovering(root, "forge-accounts", op)).toEqual([]);
    expect(await rulesCovering(root, "forge-proxy-accounts-v1", op)).toEqual([]);
  });
});
