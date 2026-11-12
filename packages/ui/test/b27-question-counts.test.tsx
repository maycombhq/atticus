import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { COPY } from "../src/copy.js";
import { inboxOf } from "../src/app/inbox.js";
import {
  openStepQuestions,
  questionsToAnswer,
  questionsToAnswerOf,
} from "../src/app/question-counts.js";
import { questionItems } from "../src/app/shell/explorer-model.js";
import { ActivityBar } from "../src/app/shell/ActivityBar.js";
import { StatusBar } from "../src/app/shell/StatusBar.js";
import { shellCounts } from "../src/app/shell/Shell.js";
import { screenOf } from "../src/app/screens.js";
import {
  panelCountIsStepsOnly,
  panelQuestionCount,
  QuestionsList,
} from "../src/app/shell/BottomPanel.js";
import { homeQuestionsOf, waitingTiles } from "../src/screens/CommandCenter.js";
import { topWaiting } from "../src/screens/home/HomePanels.js";
import { waitingQuestions } from "../src/screens/OwnerQuestions.js";
import {
  countsOf,
  QuestionsToAnswerLine,
  type QuestionListView,
} from "../src/screens/Questions.js";

/**
 * Beta.27: one count of the questions to answer, the same wherever it shows. Beta.26's Home said
 * 7 to answer and 14 needing a person, the Questions page 4 open of 5 while its two tabs added
 * up to 7. One estate (the invented Forge one) and every place that counts it.
 */

const q = (id: string, repo: string, state: "open" | "answered" | "retired" = "open") => ({
  id,
  repo,
  state,
  question: `Which repo answers ${id}?`,
});

// GET /api/questions?state=open: the four open questions from the steps, with the server's
// counts of every state (one more is answered).
const steps = {
  questions: [
    q("q-000000000001", "forge-teller"),
    q("q-000000000002", "forge-teller"),
    q("q-000000000003", "add-transfer-limit"),
    q("q-000000000004", "northwind_rates_1-0"),
  ],
  problems: [],
  counts: { open: 4, answered: 1, retired: 0, total: 5, byRepo: {} },
} as unknown as QuestionListView;
// GET /api/owner-questions: three to answer, one answered.
const owner = {
  empty: false,
  open: 3,
  questions: [
    { id: "oq-1", system: "audit", owner: "team-audit", question: "?", state: "sent" },
    { id: "oq-2", system: "ledger", owner: "team-ledger", question: "?", state: "overdue" },
    { id: "oq-3", system: "reports", owner: "team-reports", question: "?", state: "sent" },
    { id: "oq-4", system: "portal", owner: "team-portal", question: "?", state: "answered" },
  ],
};
// Seven items to sort out (triage), which need a person but are no question.
const triage = Array.from({ length: 7 }, (_, i) => ({
  id: `t-${i}`,
  kind: "unknown",
  summary: "x",
}));

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/'/g, "&#x27;");

describe("the questions to answer: one definition", () => {
  it("is the open questions from the steps and the owner questions not answered yet", () => {
    expect(questionsToAnswerOf(steps, owner)).toEqual({ total: 7, steps: 4, owner: 3 });
    // The server's count when it gives one, else the open ones listed.
    expect(openStepQuestions({ questions: [{ state: "open" }, { state: "answered" }] })).toBe(1);
    expect(openStepQuestions({ questions: [], counts: { open: 9 } })).toBe(9);
    // One kind alone is never shown as the whole.
    expect(questionsToAnswer(4, undefined)).toBeUndefined();
    expect(questionsToAnswerOf(steps, undefined)).toBeUndefined();
    expect(questionsToAnswerOf(undefined, owner)).toBeUndefined();
  });

  it("is the same number on the badge, the status bar, the Explorer, Home and Questions", () => {
    const n = questionsToAnswerOf(steps, owner)!.total;
    // The shell's counts (badge and status bar).
    const shell = shellCounts(steps, owner, { repos: [1, 2, 3, 4, 5, 6, 7] });
    expect(shell).toEqual({ questions: n, repos: 7 });
    const bar = renderToStaticMarkup(<StatusBar facts={shell} />);
    expect(bar).toContain(`href="#/questions">${COPY.ide.questions(n)}<`);
    const act = renderToStaticMarkup(
      <ActivityBar current={screenOf("home")} hash="#/home" badges={{ questions: n }} />,
    );
    expect(act).toContain(`, ${COPY.ide.openCount(n)}`);
    expect(act).toContain(`data-n="${n}"`);
    // The Explorer: its rows add up to it.
    const rows = questionItems(steps, owner);
    expect(rows.reduce((a, r) => a + (r.count ?? 0), 0)).toBe(n);
    // Home's tile, with what it is made of under it: from Home's two reads, as Home computes it.
    const tiles = waitingTiles({
      ...homeQuestionsOf(steps, owner),
      needs: 0,
      steps: 0,
      blocking: 0,
    });
    expect(tiles.questions).toMatchObject({
      label: COPY.commandCenter.waitQuestions,
      value: n,
      sub: COPY.commandCenter.home.questionsSub(4, 3),
      href: "#/questions",
    });
    // Only owner questions waiting: the tile opens on them.
    expect(homeQuestionsOf({ questions: [], counts: { open: 0 } }, owner).questionsHref).toBe(
      waitingQuestions(0, 3).href,
    );
    // The bottom panel's Questions tab, and its list adding up to it.
    const ready = <T,>(data: T) => ({ state: "ready" as const, data });
    expect(panelQuestionCount(ready(steps), ready(owner))).toBe(n);
    expect(panelQuestionCount(ready(steps), { state: "loading" })).toBeUndefined();
    expect(panelCountIsStepsOnly(ready(steps), ready(owner))).toBe(false);
    // Beta.27 re-review: the owner questions couldn't be read: the steps' count, said as theirs.
    const failed = { state: "error" as const, error: "The server didn't answer." };
    expect(panelQuestionCount(ready(steps), failed)).toBe(4);
    expect(panelCountIsStepsOnly(ready(steps), failed)).toBe(true);
    expect(panelQuestionCount({ state: "loading" }, failed)).toBeUndefined();
    expect(COPY.bottomPanel.countStepsOnly(4)).toBe(
      "4 questions from the steps; the owner questions couldn't be read",
    );
    const panel = renderToStaticMarkup(
      <QuestionsList of={ready(steps)} owner={owner.open} onRetry={() => undefined} />,
    );
    expect(panel).toContain(esc(COPY.questions.toAnswer(n, 4, 3)));
    expect(panel).toContain(COPY.bottomPanel.questions.ownerRow(3));
    expect(panel).toContain('href="#/questions?kind=owner"');
    expect((panel.match(/class="bp-row"/g) ?? []).length).toBe(4 + 1);
    // The Questions page: the line at its top, and its two kinds' tabs.
    const line = renderToStaticMarkup(
      <QuestionsToAnswerLine of={questionsToAnswerOf(steps, owner)} />,
    );
    expect(line).toContain(esc(COPY.questions.toAnswer(n, 4, 3)));
    expect(countsOf(steps).open + owner.open).toBe(n);
    expect(COPY.questions.kindSteps(countsOf(steps).open)).toBe("From the steps (4)");
    expect(COPY.questions.kindOwner(owner.open)).toBe("Owner questions (3)");
  });

  it("names the Questions page's counts as the steps' only", () => {
    expect(COPY.questions.counts.label()).toMatch(/from the steps/i);
    expect(COPY.questions.counts.caption).toMatch(/from the steps/i);
  });

  it("says Needs a person counts everything waiting, the questions to answer among it", () => {
    const items = inboxOf({
      changes: [],
      findings: [],
      questions: owner.questions.filter((x) => x.state !== "answered"),
      triage,
      steps: [],
      questionFiles: steps.questions,
    });
    const top = topWaiting(items, []);
    expect(top.total).toBe(14);
    const questions = top.rows.filter((r) => r.kind === "question");
    expect(questions.reduce((a, r) => a + r.count, 0)).toBe(7);
    expect(COPY.commandCenter.home.needsMeta(top.total)).toBe("14 waiting");
  });
});
