import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { COPY } from "../src/copy.js";
import { ArchitectureReview, StagePage } from "../src/screens/work/Stage.js";

/**
 * A stage's findings are on its thread (ADR 0189). The stage tab's own review panel
 * (screens/work/StageReview.tsx: StageReviewPanel, StageReviewView, FindingCard) was mounted
 * nowhere since, and offered Apply on a stage's own findings, which only a fix to the draft or an
 * acceptance settles: it was deleted (the review of b30/review2-fixes). The thread's findings are
 * tested in stage-thread.test.tsx and stage-accept.test.tsx.
 */

const S = COPY.stageReview;
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");

const CHANGE = "add-transfer-limit";

describe("a stage tab's findings", () => {
  // ADR 0189: the stage tabs show the stage's thread, which holds the findings, in its place.
  it("its place on Feature design, Stories and Architecture is the stage's thread now, not on Tasks", () => {
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
    const T = COPY.thread;
    expect(page("feature")).toContain(esc(T.title("feature")));
    expect(page("stories")).toContain(esc(T.title("stories")));
    expect(page("feature")).not.toContain(esc(S.title));
    expect(page("tasks")).not.toContain(esc(T.title("stories")));
    const pick = renderToStaticMarkup(<ArchitectureReview list={list} wanted={undefined} />);
    expect(pick).toContain(esc(S.pickForArchitecture));
    expect(pick).toContain(`href="#/architecture?change=${CHANGE}"`);
    expect(renderToStaticMarkup(<ArchitectureReview list={list} wanted={CHANGE} />)).toContain(
      esc(T.title("architecture")),
    );
  });
});
