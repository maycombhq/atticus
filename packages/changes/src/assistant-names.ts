import { readdirSync } from "node:fs";
import { join } from "node:path";
import { orgPackDirOf } from "@maycombhq/core";
import type { ChangeContext } from "./context.js";

/**
 * Atticus's own agents, which draft, judge and review: a `by` that names one is an AI, never a
 * person (ADR 0203 A.4). Matched exactly (assistantActor); a hyphenated handle ending `-critic`
 * or `-naysayer` (every critic lens and every persona's naysayer) is matched by that suffix.
 * Every path that reads a resolution passes these at least; with a change context, the org
 * pack's names too (assistantNames). test/assistant-names.test.ts reads every agent id the code
 * defines and checks each is here.
 */
export const BUILT_IN_AGENTS: readonly string[] = [
  // The stages and the context engine.
  "feature-placer",
  "flow-architect",
  "story-writer-flows",
  "small-change-planner",
  "context-expander",
  "context-reranker",
  "change-drafter",
  "needs-finder",
  "story-writer",
  "template-writer",
  // Review, the task run and the tests.
  "judge",
  "critic-lenses",
  "critic",
  "naysayer",
  "task-runner",
  "test-writer",
  // Reading the estate and its knowledge.
  "repo-reader",
  "knowledge-reader",
  "knowledge-asker",
  "feature-namer",
  "glossary-definer",
  "explainer",
  "spec-drafter",
  "dialect-drafter",
  "dialect-writer",
  "framework-drafter",
  // The Copilot agents Atticus writes for the person's assistant (assistant-files).
  "atticus-repo-reader",
  "atticus-verifier",
  "atticus-repo-describer",
  "atticus-question-proposer",
  "atticus-stage-drafter",
  "atticus-task-runner",
  "atticus-knowledge-reader",
];

/**
 * The names that are an AI's in this metarepo, besides the built-in ones: Atticus's own agents,
 * the org pack's agents (its YAML definitions and, with the root, its persona files) and models.
 */
export function assistantNames(
  lifecycle: Pick<ChangeContext, "orgPack"> & { root?: string },
): string[] {
  const rt = lifecycle.orgPack.runtime as { models?: { allowed?: string[] } };
  const personas = lifecycle.root
    ? (() => {
        try {
          return readdirSync(join(orgPackDirOf(lifecycle.root), "agents"))
            .filter((f) => f.endsWith(".md"))
            .map((f) => f.slice(0, -3));
        } catch {
          return [];
        }
      })()
    : [];
  return [
    ...BUILT_IN_AGENTS,
    ...lifecycle.orgPack.agents.map((a) => a.id),
    ...personas,
    ...(rt.models?.allowed ?? []),
  ];
}
