import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { COPY } from "../src/copy.js";
import { ChangeKnowledgeView } from "../src/screens/work/Knowledge.js";
import { StagePage } from "../src/screens/work/Stage.js";

/** Change › Feature: the org knowledge that applies to the change (ADR 0124, Part 5). */

const K = COPY.changeKnowledge;
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");

const VIEW: Api.ChangeKnowledgeViewT = {
  change: "add-limit",
  file: "openspec/changes/add-limit/knowledge.yaml",
  present: true,
  items: [
    {
      id: "json-logging",
      kind: "Pattern",
      status: "confirmed",
      stages: ["feature"],
      score: 4,
      why: "named in the brief",
    },
    {
      id: "kafka-topic-request",
      kind: "ProcessDefinition",
      status: "suggested",
      stages: ["feature", "stories"],
      score: 2,
    },
    { id: "old-adr", kind: "Decision", status: "excluded", stages: [], score: 1, why: "a person" },
  ],
  nearMisses: [{ id: "northwind-pay", kind: "Party", score: 1.5, stage: "feature" }],
  command: "atticus change knowledge add-limit",
};
const ready = { state: "ready" as const, data: VIEW };

describe("the knowledge that applies, on Change › Feature", () => {
  it("lists each item with why, its stages and status, and Confirm and Exclude buttons named for it", () => {
    const out = renderToStaticMarkup(<ChangeKnowledgeView change="add-limit" of={ready} />);
    expect(out).toContain(esc(K.title));
    expect(out).toContain("json-logging");
    expect(out).toContain(esc("named in the brief · feature"));
    expect(out).toContain(esc("feature, stories"));
    expect(out).toContain(esc(K.statuses.confirmed!));
    expect(out).toContain(`aria-label="${esc(K.confirmItem("kafka-topic-request"))}"`);
    expect(out).toContain(`aria-label="${esc(K.excludeItem("kafka-topic-request"))}"`);
    // A button for the status an item already has is off.
    expect(out).toMatch(/disabled=""[^>]*aria-label="Confirm json-logging"/);
    expect(out).toContain(esc(K.nearMisses(1)));
    expect(out).toContain(esc(K.nearMissStage("feature")));
    expect(out).toContain(`aria-label="${esc(K.confirmItem("northwind-pay"))}"`);
  });

  it("shows the git command to commit the file after a write, and why a write failed", () => {
    const done = renderToStaticMarkup(
      <ChangeKnowledgeView
        change="add-limit"
        of={ready}
        written={{
          state: "done",
          id: "kafka-topic-request",
          status: "confirmed",
          result: {
            knowledge: VIEW,
            file: VIEW.file,
            commit:
              'git add openspec/changes/add-limit/knowledge.yaml && git commit -m "add-limit: the knowledge that applies"',
          },
        }}
      />,
    );
    expect(done).toContain('role="status"');
    expect(done).toContain(esc(K.set("kafka-topic-request", "confirmed", VIEW.file)));
    expect(done).toContain(esc("git add openspec/changes/add-limit/knowledge.yaml && git commit"));
    expect(done).toContain(esc(K.copyCommit));
    const failed = renderToStaticMarkup(
      <ChangeKnowledgeView
        change="add-limit"
        of={ready}
        written={{ state: "error", text: "nope" }}
      />,
    );
    expect(failed).toContain('role="alert"');
    const working = renderToStaticMarkup(
      <ChangeKnowledgeView change="add-limit" of={ready} written={{ state: "working" }} />,
    );
    expect(working).toContain(esc(K.working));
    expect(working).not.toMatch(/<button(?![^>]*disabled)[^>]*>Confirm</);
  });

  it("has loading, error and empty states; empty gives the feature stage's command", () => {
    const of = (o: Parameters<typeof ChangeKnowledgeView>[0]["of"]) =>
      renderToStaticMarkup(<ChangeKnowledgeView change="add-limit" of={o} />);
    expect(of({ state: "loading" })).toContain('aria-busy="true"');
    expect(of({ state: "error", error: "boom" })).toContain('role="alert"');
    const empty = of({
      state: "ready",
      data: { ...VIEW, present: false, items: [], nearMisses: [] },
    });
    expect(empty).toContain(esc(K.none));
    expect(empty).toContain("atticus change feature add-limit");
  });

  it("is on the feature tab only; At a glance and All changes are Change's tabs, not links here", () => {
    const list = {
      state: "ready" as const,
      data: [
        {
          id: "add-limit",
          title: "Add a limit",
          type: "feature",
          state: "define",
          repos: [],
          openFindings: { blocking: 0, gap: 0, risk: 0, idea: 0 },
          updatedAt: "2026-10-24T00:00:00Z",
        },
      ],
    };
    const feature = renderToStaticMarkup(
      <StagePage
        stage="feature"
        list={list}
        wanted="add-limit"
        detail={{ state: "loading" }}
        tasks={undefined}
      />,
    );
    expect(feature).toContain(esc(K.title));
    expect(feature).not.toContain('href="#/cockpit?change=add-limit"');
    expect(feature).not.toContain('href="#/changes"');
    const stories = renderToStaticMarkup(
      <StagePage
        stage="stories"
        list={list}
        wanted="add-limit"
        detail={{ state: "loading" }}
        tasks={undefined}
      />,
    );
    expect(stories).not.toContain(esc(K.title));
  });
});
