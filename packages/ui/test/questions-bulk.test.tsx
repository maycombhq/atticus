import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { COPY } from "../src/copy.js";
import {
  bulkBody,
  countsOf,
  byRepo,
  QuestionCounts,
  questionCounts,
  QuestionList,
  type QuestionView,
} from "../src/screens/Questions.js";

/**
 * Beta.14: the Questions page counts what is open, answered and retired at the top, lists the
 * questions by repo, and lets a person pick several open ones and answer them the same way.
 */

const C = COPY.questions;
const q = (id: string, repo: string, state: "open" | "answered" | "retired"): QuestionView =>
  ({
    schemaVersion: 4,
    id,
    askedBy: {
      step: "facts-targets",
      command: "atticus verify x --write",
      at: "2026-11-01T10:00:00.000Z",
    },
    repo,
    question: `Which repo or system answers GET /x/${id}, which ${repo} calls?`,
    options: [],
    evidence: ["src/X.java:1"],
    scope: { level: "repo", id: repo },
    state,
    rerun: "atticus verify x --write",
  }) as QuestionView;

const qs = [
  q("q-000000000001", "forge-teller", "open"),
  q("q-000000000002", "forge-proxy", "open"),
  q("q-000000000003", "forge-proxy", "answered"),
  q("q-000000000004", "forge-proxy", "retired"),
];

describe("the counts at the top", () => {
  it("counts each state, in one repo when one is picked", () => {
    expect(questionCounts(qs)).toEqual({ open: 2, answered: 1, retired: 1, total: 4, repos: 2 });
    expect(questionCounts(qs, "forge-proxy")).toMatchObject({ open: 1, answered: 1, total: 3 });
  });

  it("takes them from the one list request when the server gives them (beta.21)", () => {
    const byRepo = {
      "forge-proxy": { open: 1, answered: 1, retired: 1, total: 3 },
      "forge-teller": { open: 1, answered: 0, retired: 0, total: 1 },
    };
    // The list shows only the open ones; the counts are every question's.
    const d = {
      questions: qs.filter((x) => x.state === "open"),
      problems: [],
      counts: { open: 2, answered: 1, retired: 1, total: 4, byRepo },
    };
    expect(countsOf(d)).toEqual({ open: 2, answered: 1, retired: 1, total: 4, repos: 2 });
    expect(countsOf(d, "forge-proxy")).toEqual({
      open: 1,
      answered: 1,
      retired: 1,
      total: 3,
      repos: 1,
    });
  });

  it("shows them, Open and All picking the list's filter, and how much is settled", () => {
    const out = renderToStaticMarkup(
      <QuestionCounts counts={questionCounts(qs)} filter="open" onFilter={() => {}} />,
    );
    expect(out).toContain(C.counts.open);
    expect(out).toContain(C.counts.answered);
    expect(out).toContain('aria-pressed="true"');
    expect(out).toContain(C.counts.progress(50));
  });
});

describe("the list, by repo, with picks", () => {
  it("groups by repo in order", () => {
    expect(byRepo(qs).map(([r, xs]) => [r, xs.length])).toEqual([
      ["forge-proxy", 3],
      ["forge-teller", 1],
    ]);
  });

  it("offers a pick on open questions only, and one for a repo's open questions", () => {
    const out = renderToStaticMarkup(
      <QuestionList
        of={{ state: "ready", data: { questions: qs, problems: [] }, reload: () => {} } as never}
        selected={new Set(["q-000000000002"])}
        onSelect={() => {}}
        all
      />,
    );
    expect(out).toContain(C.bulk.pick("q-000000000002"));
    expect(out).not.toContain(C.bulk.pick("q-000000000003"));
    expect(out).toContain(C.bulk.pickRepo("forge-proxy"));
    expect(out.match(/type="checkbox"/g)!.length).toBe(4); // 2 questions, 2 repos
  });

  it("answers each with the same target or words, scoped to its own repo", () => {
    expect(bulkBody({ how: "target", value: " core-api " })).toEqual({
      body: { target: "core-api", scope: "repo" },
    });
    expect(bulkBody({ how: "words", value: "the vendor" })).toEqual({
      body: { text: "the vendor", scope: "repo" },
    });
    expect(bulkBody({ how: "target", value: "" })).toEqual({ error: C.bulk.needTarget });
  });
});
