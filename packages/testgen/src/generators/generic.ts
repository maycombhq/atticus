import type { AcceptanceCase, TestCase } from "../model.js";
import { oneLine } from "../words.js";
import { layout, type TestGenerator } from "./types.js";

/** Gherkin: the story's acceptance criteria as a feature, in the repo that serves the story. */
export const gherkinGenerator: TestGenerator = {
  id: "gherkin",
  version: "1.0.0",
  generic: true,
  appliesTo: () => true,
  render(model, repo, ctx) {
    const scenarios = repo.cases.filter((c): c is AcceptanceCase => c.type === "acceptance");
    if (!scenarios.length) return [];
    const s = model.story;
    const lines = [
      `@change-${model.change} @story-${s.id}`,
      `Feature: ${oneLine(s.title)}`,
      ...(s.asA && s.iWant && s.soThat
        ? [
            `  As ${/^an?\s/i.test(s.asA) ? s.asA : `a ${s.asA}`}`,
            `  I want ${s.iWant}`,
            `  So that ${s.soThat}`,
          ]
        : []),
      ...(s.tracesTo ? [`  Traces to ${s.tracesTo}.`] : []),
    ];
    for (const c of scenarios) {
      lines.push("");
      if (c.trace)
        lines.push(
          `  # ${c.trace.file}:${c.trace.line}${c.trace.name ? ` (${c.trace.name})` : ""}`,
        );
      lines.push(`  ${[`@criterion-${c.criterion}`, ...c.tags.map((t) => `@${t}`)].join(" ")}`);
      lines.push(`  Scenario: ${oneLine(c.name)}`);
      if (c.given) lines.push(`    Given ${c.given}`);
      if (c.when) lines.push(`    When ${c.when}`);
      lines.push(`    Then ${c.then}`);
    }
    return [
      {
        path: `${layout(repo).features}/${s.id}.feature`,
        content: `${lines.join("\n")}\n`,
        style: "hash",
        source: ctx.source,
        cases: scenarios.map((c) => c.id),
      },
    ];
  },
};

/** One case as the JSON test-case format writes it. */
function jsonCase(c: TestCase): Record<string, unknown> {
  const { title: _t, ...rest } = c;
  void _t;
  return rest;
}

/**
 * The JSON test-case format any runner can consume (`format: atticus-tests/1`): the story,
 * the test strategy and every case of this repo with its request, expectations and checks.
 */
export const jsonGenerator: TestGenerator = {
  id: "json",
  version: "1.0.0",
  generic: true,
  appliesTo: () => true,
  render(model, repo, ctx) {
    const doc = {
      format: "atticus-tests/1",
      change: model.change,
      story: model.story,
      ...(repo.repo ? { repo: repo.repo } : {}),
      ...(repo.component ? { component: repo.component } : {}),
      strategy: model.strategy.required,
      cases: repo.cases.map(jsonCase),
    };
    return [
      {
        path: `${layout(repo).json}/${model.story.id}.tests.json`,
        content: `${JSON.stringify(doc, null, 2)}\n`,
        style: "json",
        source: ctx.source,
        cases: repo.cases.map((c) => c.id),
      },
    ];
  },
};
