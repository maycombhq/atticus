import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api, Finding } from "@maycombhq/core";
import { COPY } from "../src/copy.js";
import { StageReviewView } from "../src/screens/work/StageReview.js";
import { ArchitectureReview, StagePage } from "../src/screens/work/Stage.js";

/** A stage tab's findings with their options and a comment box (ADR 0124 addendum D-app, B10). */

const S = COPY.stageReview;
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");

const CHANGE = "add-transfer-limit";
const finding = (o: Partial<Finding>): Finding =>
  ({
    schemaVersion: 1,
    id: "f-0000000a",
    kind: "issue",
    change: CHANGE,
    gate: "plan",
    round: 2,
    rule: "review.outcome-has-story",
    layer: "org",
    lens: "complete",
    severity: "blocking",
    artifact: "stories.md",
    locator: { line: 4 },
    summary: "The refusal outcome has no story.",
    why: "Every outcome the brief names needs a story.",
    fix: { text: "Add a story for refusing a transfer over the limit." },
    evidence: [{ source: "artifact", path: "stories.md", line: 4 }],
    waivable: true,
    state: "open",
    createdAt: "2026-10-24T09:00:00Z",
    ...o,
  }) as Finding;

const VIEW: Api.StageReviewViewT = {
  change: CHANGE,
  stage: "stories",
  gate: "plan",
  round: 2,
  loop: {
    file: `openspec/changes/${CHANGE}/stage/stories.yaml`,
    present: true,
    state: "questions",
    iteration: 2,
  },
  findings: [
    {
      finding: finding({}),
      file: `openspec/changes/${CHANGE}/review/plan/2/f-0000000a.yaml`,
      options: {
        fix: "Add a story for refusing a transfer over the limit.",
        apply: true,
        dismiss: true,
        waive: true,
      },
      comments: [
        {
          question: "q-0123456789ab",
          text: "It is s1's second criterion.",
          by: "Priya Nair",
          at: "2026-10-24T10:00:00Z",
          read: false,
        },
      ],
    },
    {
      finding: finding({
        id: "f-0000000b",
        layer: "constitution",
        waivable: false,
        summary: "The limits entry names no auth.",
      }),
      file: `openspec/changes/${CHANGE}/review/plan/2/f-0000000b.yaml`,
      options: { fix: "Name the entry's auth.", apply: true, dismiss: true, waive: false },
      comments: [],
    },
    {
      finding: finding({
        id: "f-0000000c",
        kind: "knowledge-gap",
        severity: "gap",
        summary: "No SLO is known for the ledger.",
        question: { text: "What is the ledger's latency SLO?", owner: "ledger-team" },
      }),
      file: `openspec/changes/${CHANGE}/review/plan/2/f-0000000c.yaml`,
      options: {
        fix: "Ask the ledger team.",
        apply: false,
        dismiss: false,
        waive: false,
        ask: { text: "What is the ledger's latency SLO?", owner: "ledger-team" },
      },
      comments: [],
    },
  ],
  questions: [
    {
      schemaVersion: 2,
      id: "q-aaaaaaaaaaaa",
      askedBy: {
        step: "change-stories",
        command: `atticus plan stories ${CHANGE}`,
        at: "2026-10-24T09:00:00Z",
      },
      repo: CHANGE,
      question: "Does the daily limit reset at midnight UTC?",
      options: [],
      evidence: [`openspec/changes/${CHANGE}/stories.md:1`],
      scope: { level: "repo", id: CHANGE },
      state: "open",
      rerun: `atticus plan stories ${CHANGE}`,
    },
  ],
  next: { command: `atticus plan stories ${CHANGE}`, slash: `/atticus-stories ${CHANGE}` },
  problems: [],
};
const ready = { state: "ready" as const, data: VIEW };
const render = (
  of: Parameters<typeof StageReviewView>[0]["of"],
  wrote?: Parameters<typeof StageReviewView>[0]["wrote"],
) => renderToStaticMarkup(<StageReviewView of={of} {...(wrote ? { wrote } : {})} />);

describe("a stage tab's findings", () => {
  it("shows each finding with where, why, the fix and only the options it allows", () => {
    const out = render(ready);
    expect(out).toContain(esc(S.title));
    expect(out).toContain(esc(S.round("plan", 2, 3)));
    expect(out).toContain(esc("The refusal outcome has no story."));
    expect(out).toContain("stories.md:4");
    expect(out).toContain(esc("Add a story for refusing a transfer over the limit."));
    expect(out).toContain(`aria-label="${esc(S.applyFor("f-0000000a"))}"`);
    expect(out).toContain(`aria-label="${esc(S.dismissFor("f-0000000a"))}"`);
    expect(out).toContain(`aria-label="${esc(S.waiveFor("f-0000000a"))}"`);
    // A constitution rule offers no waive, and says why.
    expect(out).not.toContain(`aria-label="${esc(S.waiveFor("f-0000000b"))}"`);
    expect(out).toContain(esc(S.cantWaive));
    // A knowledge gap is asked of its owner, nothing else.
    expect(out).toContain(`aria-label="${esc(S.askFor("f-0000000c", "ledger-team"))}"`);
    expect(out).not.toContain(`aria-label="${esc(S.applyFor("f-0000000c"))}"`);
    // Severity in words, not colour alone.
    expect(out).toContain(esc(S.severity.blocking!));
    expect(out).toContain(esc(S.severity.gap!));
  });

  // ADR 0115 addendum (2026-10-25): an assistant only proposes; the finding stays open for a person.
  it("says what an assistant proposed about an open finding, waiting on a person, with its options", () => {
    const [first, ...rest] = VIEW.findings;
    const out = render({
      state: "ready",
      data: {
        ...VIEW,
        findings: [
          {
            ...first!,
            proposal: {
              claim: "not-relevant",
              by: "claude",
              at: "2026-10-24T09:30:00Z",
              reason: "The refusal is the same story.",
            },
          },
          ...rest,
        ],
      },
    });
    expect(out).toContain(
      esc(`${S.proposed("claude", "not-relevant")}: The refusal is the same story.`),
    );
    expect(out).toContain("waiting on a person");
    // A person still has every option the finding allows.
    expect(out).toContain(`aria-label="${esc(S.dismissFor("f-0000000a"))}"`);
    expect(render(ready)).not.toContain("waiting on a person");
  });

  it("has a labelled comment box per finding and lists the comments with whether a draft read them", () => {
    const out = render(ready);
    for (const id of ["f-0000000a", "f-0000000b", "f-0000000c"])
      expect(out).toContain(esc(S.comment(id)));
    expect(out).toMatch(
      /<label for="[^"]+"[^>]*>Your comment on f-0000000a<\/label><textarea id="[^"]+"/,
    );
    expect(out).toContain(esc("It is s1's second criterion."));
    expect(out).toContain(esc(S.unread));
  });

  it("lists the stage's open questions to answer here, and the stage's command and slash command", () => {
    const out = render(ready);
    expect(out).toContain(esc(S.answerIt("Does the daily limit reset at midnight UTC?")));
    expect(out).toContain(esc(`atticus plan stories ${CHANGE}`));
    expect(out).toContain(esc(`/atticus-stories ${CHANGE}`));
    expect(out).toContain(esc(S.loopState.questions!));
  });

  it("says what a comment or an action wrote, with the git command, and why one failed", () => {
    const commented = render(ready, {
      "f-0000000a": {
        state: "commented",
        result: {
          comment: VIEW.findings[0]!.comments[0]!,
          files: ["questions/q-0123456789ab.yaml", `openspec/changes/${CHANGE}/stage/stories.yaml`],
          commit: `git add questions/q-0123456789ab.yaml && git commit -m "x"`,
          next: VIEW.next,
        },
      },
    });
    expect(commented).toContain(
      esc(
        S.commented(`questions/q-0123456789ab.yaml, openspec/changes/${CHANGE}/stage/stories.yaml`),
      ),
    );
    expect(commented).toContain("git add questions/q-0123456789ab.yaml");
    expect(render(ready, { "f-0000000a": { state: "acted", action: "waive" } })).toContain(
      esc(S.acted(S.actions.waive!)),
    );
    expect(render(ready, { "f-0000000a": { state: "error", text: "nope" } })).toContain(
      'role="alert"',
    );
    expect(render(ready, { "f-0000000a": { state: "working" } })).toContain('aria-busy="true"');
  });

  it("has loading, error and empty states; before the stage ran it gives the stage's command", () => {
    expect(render({ state: "loading" })).toContain('aria-busy="true"');
    expect(render({ state: "error", error: "boom" })).toContain('role="alert"');
    const notRun = render({
      state: "ready",
      data: {
        ...VIEW,
        loop: { file: VIEW.loop.file, present: false },
        findings: [],
        questions: [],
      },
    });
    expect(notRun).toContain(esc(S.notRun));
    expect(notRun).toContain(esc(`atticus plan stories ${CHANGE}`));
    const noRound = render({ state: "ready", data: { ...VIEW, round: null, findings: [] } });
    expect(noRound).toContain(esc(S.noRound("plan")));
    const noGate = render({
      state: "ready",
      data: { ...VIEW, gate: null, round: null, findings: [] },
    });
    expect(noGate).toContain(esc(S.noRound(null)));
    const clean = render({ state: "ready", data: { ...VIEW, findings: [], questions: [] } });
    expect(clean).toContain(esc(S.clean("plan", 2)));
    expect(clean).toContain(esc(S.noQuestions));
  });

  it("is on Feature design and Stories, not Tasks; Architecture shows it for the change named, else a list", () => {
    const list = {
      state: "ready" as const,
      data: [{ id: CHANGE, title: "Add a daily transfer limit", state: "plan" }],
    };
    const page = (stage: "feature" | "stories" | "tasks") =>
      renderToStaticMarkup(
        <StagePage
          stage={stage}
          list={list}
          wanted={CHANGE}
          detail={undefined}
          tasks={undefined}
        />,
      );
    expect(page("feature")).toContain(esc(S.title));
    expect(page("stories")).toContain(esc(S.title));
    expect(page("tasks")).not.toContain(esc(S.title));
    const pick = renderToStaticMarkup(<ArchitectureReview list={list} wanted={undefined} />);
    expect(pick).toContain(esc(S.pickForArchitecture));
    expect(pick).toContain(`href="#/architecture?change=${CHANGE}"`);
    expect(renderToStaticMarkup(<ArchitectureReview list={list} wanted={CHANGE} />)).toContain(
      esc(S.title),
    );
  });
});
