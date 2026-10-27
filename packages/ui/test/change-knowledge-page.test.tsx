import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { COPY } from "../src/copy.js";
import { SCREENS } from "../src/app/screens.js";
import { SCREEN_COMPONENTS } from "../src/screens/registry.js";
import { ChangeKnowledgeView } from "../src/screens/work/Knowledge.js";
import { ChangeKnowledgePageView } from "../src/screens/work/KnowledgePage.js";
import { StagePage } from "../src/screens/work/Stage.js";
import type { ChangeRow } from "../src/screens/work/next.js";

/**
 * Change › Knowledge (2026-10-27): the knowledge attached to a change on a page of its own, beside
 * Feature design, since the product owner couldn't find it at the foot of the Feature page.
 */

const K = COPY.changeKnowledge;
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");

const CHANGE: ChangeRow = {
  id: "add-limit",
  title: "Add a limit",
  type: "feature",
  state: "define",
  repos: [],
  openFindings: { blocking: 0, gap: 0, risk: 0, idea: 0 },
  updatedAt: "2026-10-24T00:00:00Z",
} as ChangeRow;
const list = { state: "ready" as const, data: [CHANGE] };

const VIEW: Api.ChangeKnowledgeViewT = {
  change: "add-limit",
  file: "openspec/changes/add-limit/knowledge.yaml",
  present: true,
  items: [
    {
      id: "forge-wiki/fraud.md#Timeouts",
      kind: "WikiSection",
      status: "suggested",
      stages: ["feature"],
      score: 1.2,
      title: "Fraud screen › Timeouts",
      reason: "Its words match the change's words.",
      source: "forge-wiki",
      authority: "standard",
      tasks: ["1.1"],
    },
  ],
  nearMisses: [{ id: "northwind-pay", kind: "Party", score: 1.5, stage: "feature" }],
  command: "atticus change knowledge add-limit",
};

const page = (
  knowledge: Parameters<typeof ChangeKnowledgeView>[0]["of"],
  l: Parameters<typeof ChangeKnowledgePageView>[0]["list"] = list,
  wanted: string | undefined = "add-limit",
) =>
  renderToStaticMarkup(
    <ChangeKnowledgePageView
      list={l}
      wanted={wanted}
      panel={(c) => <ChangeKnowledgeView change={c} of={knowledge} />}
    />,
  );

describe("Change › Knowledge: a change's knowledge on its own page", () => {
  it("is a page of Change, in Define beside Feature design, with its label from the copy file", () => {
    const s = SCREENS.find((x) => x.id === "change-knowledge")!;
    expect(s).toMatchObject({
      section: "Change",
      group: "Define",
      label: COPY.nav.screens.changeKnowledge,
    });
    expect(s.full).toBeUndefined();
    expect(s.aside).toBeUndefined();
    expect(SCREEN_COMPONENTS["change-knowledge"]).toBeDefined();
  });

  it("shows loading while the changes or the knowledge load", () => {
    expect(page({ state: "loading" }, { state: "loading" })).toContain('aria-busy="true"');
    const out = page({ state: "loading" });
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain(esc(CHANGE.title));
  });

  it("says why when the changes or the knowledge can't be read", () => {
    expect(page({ state: "loading" }, { state: "error", error: "boom" })).toContain('role="alert"');
    expect(page({ state: "error", error: "boom" })).toContain('role="alert"');
  });

  it("with no knowledge attached yet, says so and what to run", () => {
    const out = page({
      state: "ready",
      data: { ...VIEW, present: false, items: [], nearMisses: [] },
    });
    expect(K.none).toMatch(/^No knowledge is attached to this change yet/);
    expect(out).toContain(esc(K.none));
    expect(out).toContain("atticus change feature add-limit");
  });

  it("with no change, or none picked, says how to get one", () => {
    expect(page({ state: "loading" }, { state: "ready", data: [] })).toContain(
      esc(COPY.work.noChangeTitle),
    );
    expect(page({ state: "loading" }, list, "no-such-change")).toContain(
      esc(COPY.work.pickAChange),
    );
  });

  it("lists a change's pages with their source, authority, tasks, near-misses and a picker", () => {
    const out = page({ state: "ready", data: VIEW });
    expect(out).toContain(esc(K.title));
    expect(out).toContain(esc("Fraud screen › Timeouts"));
    expect(out).toContain(esc(K.fromSource("forge-wiki", "standard")));
    expect(out).toContain(esc(K.tasks(["1.1"])));
    expect(out).toContain(esc(K.nearMisses(1)));
    expect(out).toContain(`aria-label="${esc(K.confirmItem("Fraud screen › Timeouts"))}"`);
    expect(out).toContain('id="pick-change-knowledge"');
  });

  it("leaves Feature design a short link to the page, not the panel a second time", () => {
    const feature = renderToStaticMarkup(
      <StagePage
        stage="feature"
        list={list}
        wanted="add-limit"
        detail={{ state: "loading" }}
        tasks={undefined}
      />,
    );
    expect(feature).toContain('href="#/change-knowledge?change=add-limit"');
    expect(feature).toContain(esc(K.openPage));
    expect(feature).not.toContain(esc(K.intro));
    expect(feature).not.toContain(esc(K.caption));
  });
});
