import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Api } from "@maycombhq/core";

/**
 * ADR 0181 (stage drafts): each stage draft says who wrote it last ("Drafted by AI" with its run,
 * until a person saves it), every draft and item has Correct, a correction offers Apply to
 * similar (on), the corrections waiting for the next run are listed with Run the stage again,
 * and what a run did with each is said. Empty, loading and error states too.
 */
vi.mock("../src/api/client.js", async () => ({
  ...(await vi.importActual<object>("../src/api/client.js")),
  useApi: () => ({ state: "loading", reload: () => {} }),
  useLiveEvents: () => undefined,
  useReloadOnFiles: () => undefined,
}));

const { COPY } = await import("../src/copy.js");
const { StageDraftsView, CorrectForm } = await import("../src/screens/work/StageDrafts.js");

const D = COPY.stageDrafts;
const CHANGE = "let-tellers-lock-a-card";
const REL = `openspec/changes/${CHANGE}`;
const FLOW = "target-flows/forge-cards.lock-card.yaml";
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");

const correction = (o: Partial<Api.CorrectionViewT>): Api.CorrectionViewT => ({
  id: "c-0123456789",
  stage: "architecture",
  file: FLOW,
  item: "step-2",
  label: "Step 2 (add call-out): Northwind Pay is told of the lock",
  text: "Northwind Pay isn't told; the card service only logs it.",
  scope: "similar",
  like: "northwind-pay",
  by: "Priya Nair <priya@forge.example>",
  at: "2026-11-08T10:00:00Z",
  state: "waiting",
  ...o,
});

const drafts = (o: Partial<Api.StageDraftsViewT> = {}): Api.StageDraftsViewT => ({
  change: CHANGE,
  page: "architecture",
  files: [
    {
      file: FLOW,
      path: `${REL}/${FLOW}`,
      stage: "architecture",
      drafted: {
        by: "ai",
        stage: "architecture",
        run: "run-arch-0001",
        at: "2026-11-08T09:00:00Z",
      },
      items: [
        { id: "step-1", label: "Step 1 (add lookup): The card is read", like: ["cards"] },
        {
          id: "step-2",
          label: "Step 2 (add call-out): Northwind Pay is told of the lock",
          like: ["northwind-pay"],
        },
      ],
    },
    {
      file: "design.md",
      path: `${REL}/design.md`,
      stage: "architecture",
      drafted: { by: "person", who: "Sam Okafor", at: "2026-11-08T11:00:00Z" },
      items: [{ id: "rollout", label: "Rollout" }],
    },
    {
      file: "data.md",
      path: `${REL}/data.md`,
      stage: "architecture",
      drafted: { by: "person" },
      items: [],
    },
  ],
  corrections: [],
  next: {
    stage: "architecture",
    command: `atticus change architecture ${CHANGE}`,
    slash: `/atticus-architecture ${CHANGE}`,
  },
  problems: [],
  ...o,
});

const render = (of: Parameters<typeof StageDraftsView>[0]["of"], handlers = true) =>
  renderToStaticMarkup(
    <StageDraftsView
      of={of}
      {...(handlers
        ? { onCorrect: () => Promise.reject(new Error("not here")), onRemove: async () => {} }
        : {})}
    />,
  );

describe("a page's stage drafts", () => {
  it("says who wrote each draft last: the AI with its run, a person who saved it, or an edit outside the app", () => {
    const html = render({ state: "ready", data: drafts() });
    expect(html).toContain(D.title);
    expect(html).toContain(`${REL}/${FLOW}`);
    expect(html).toContain(`<span class="chip ai">${D.draftedByAi}</span>`);
    expect(html).toContain('href="#/runs?run=run-arch-0001"');
    expect(html).toContain(D.draftedByAiRun("run-arch-0001"));
    expect(html).toContain(esc(D.editedBy("Sam Okafor", "2026-11-08")));
    expect(html).toContain(D.editedByPerson);
    expect(html).toContain(D.editedOutside);
  });

  it("offers Correct on each draft and each of its items, with names a screen reader reads", () => {
    const html = render({ state: "ready", data: drafts() });
    expect(html).toContain(`aria-label="${esc(D.correctFile(FLOW))}"`);
    expect(html).toContain(
      `aria-label="${esc(D.correctItem("Step 2 (add call-out): Northwind Pay is told of the lock"))}"`,
    );
    expect(html).toContain(`<summary>${esc(D.items(FLOW))}</summary>`);
    expect(html).toContain('aria-expanded="false"');
    // Not only with findings: no critic finding is needed to correct a draft.
    expect(html).not.toContain(COPY.stageReview.title);
    // Read-only without handlers: no Correct.
    expect(render({ state: "ready", data: drafts() }, false)).not.toContain(
      D.correct + "</button>",
    );
  });

  it("lists the corrections waiting for the next run, with Take back and Run the stage again", () => {
    const html = render({
      state: "ready",
      data: drafts({ corrections: [correction({})] }),
    });
    expect(html).toContain(D.waitingTitle);
    expect(html).toContain(D.state.waiting);
    expect(html).toContain(esc("“Northwind Pay isn't told; the card service only logs it.”"));
    expect(html).toContain(D.scope.similar);
    expect(html).toContain(D.likeOf("northwind-pay"));
    expect(html).toContain(
      `aria-label="${esc(D.removeFor("Step 2 (add call-out): Northwind Pay is told of the lock"))}"`,
    );
    expect(html).toContain(D.runAgain);
    expect(html).toContain(`atticus change architecture ${CHANGE}`);
    expect(html).toContain(`/atticus-architecture ${CHANGE}`);
    expect(html).not.toContain(D.waitingNone);
  });

  it("says what a run did with each correction: applied with the items it touched, or read without a change", () => {
    const html = render({
      state: "ready",
      data: drafts({
        corrections: [
          correction({
            id: "c-aaaaaaaaaa",
            state: "applied",
            run: "run-arch-0002",
            appliedAt: "2026-11-08T12:00:00Z",
            touched: [`${FLOW}#step-4`, "design.md#rollout"],
          }),
          correction({ id: "c-bbbbbbbbbb", state: "read", run: "run-arch-0002", scope: "one" }),
        ],
      }),
    });
    expect(html).toContain(D.doneTitle);
    expect(html).toContain(D.state.applied);
    expect(html).toContain(D.appliedIn("run-arch-0002"));
    expect(html).toContain(D.touched(2));
    expect(html).toContain(`${FLOW}#step-4`);
    expect(html).toContain(esc(D.state.read!));
    expect(html).toContain(esc(D.readNotApplied));
    expect(html).toContain(D.waitingNone);
    // A correction a run read is kept: no Take back.
    expect(html).not.toContain(D.remove + "</button>");
  });

  it("has an empty, a loading and an error state", () => {
    expect(render({ state: "ready", data: drafts({ files: [] }) })).toContain(esc(D.none));
    expect(render({ state: "loading" })).toContain(D.title);
    const err = render({ state: "error", error: "The drafts file doesn't read." });
    expect(err).toContain("The drafts file doesn&#x27;t read.");
    const bad = render({
      state: "ready",
      data: drafts({
        problems: [{ file: `${REL}/stage/corrections.yaml`, message: "doesn't read" }],
      }),
    });
    expect(bad).toContain('role="alert"');
  });
});

describe("the correction form", () => {
  it("asks what to say instead, with Apply to similar on and what similar items name", () => {
    const html = renderToStaticMarkup(
      <CorrectForm
        target={{ file: FLOW, item: "step-2", label: "Step 2", like: "northwind-pay" }}
        onSave={() => Promise.reject(new Error("not here"))}
        onClose={() => {}}
      />,
    );
    expect(html).toContain(esc(D.formTitle("Step 2")));
    expect(html).toMatch(/<label for="[^"]+-text">What should it say or do instead\?<\/label>/);
    expect(html).toContain(esc(D.textHint));
    expect(html).toMatch(/<input type="checkbox"[^>]*checked=""/);
    expect(html).toContain(D.similar);
    expect(html).toContain('value="northwind-pay"');
    expect(html).toContain(D.likeLabel);
    expect(html).toContain(`>${D.save}</button>`);
    expect(html).toContain(`>${D.cancel}</button>`);
  });
});
