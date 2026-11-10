import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { COPY } from "../src/copy.js";
import { holdsPhase, inboxOf, levelsOfRoles } from "../src/app/inbox.js";
import { parseBrief, renderBrief } from "../src/screens/BriefForm.js";
import { acceptBody, suggestionFrom } from "../src/screens/change-owners.js";
import { ChangeWaitsLine, nonAdminRoles } from "../src/screens/HomeRoles.js";
import { KnowledgeAnswerBlock } from "../src/screens/KnowledgeAnswer.js";
import { RouteQuestion, asksWords } from "../src/screens/RouteQuestion.js";
import { WaitsOnLine } from "../src/screens/work/Cockpit.js";
import { shapeBody, shapeWords, storiesOf, workItemState } from "../src/screens/work/StoryShape.js";
import { SCREENS, tabsOf } from "../src/app/screens.js";

/** ADR 0191: roles and the business analyst, in the app. Invented Forge names. */

const W = COPY.roleWork;

const BRIEF = `# Add a daily transfer limit

<!-- Brief for add-transfer-limit (feature), started by pat on 2026-11-09. Replace every comment with your own words. -->

## Problem

<!-- What is wrong today, for whom. -->

## Outcome

Each account has a daily limit.

## Scope

<!-- In and out. -->
`;

describe("the brief as a form", () => {
  it("reads each section with its hint and its words", () => {
    const d = parseBrief(BRIEF);
    expect(d.sections.map((s) => [s.heading, s.hint, s.text])).toEqual([
      ["Problem", "What is wrong today, for whom.", ""],
      ["Outcome", "", "Each account has a daily limit."],
      ["Scope", "In and out.", ""],
    ]);
  });

  it("writes the same brief.md: untouched sections byte for byte, an edited one with its hint", () => {
    const d = parseBrief(BRIEF);
    expect(renderBrief(d, {})).toBe(BRIEF);
    const out = renderBrief(d, { 0: "Two accounts were drained last month." });
    expect(out).toContain(
      "## Problem\n\n<!-- What is wrong today, for whom. -->\n\nTwo accounts were drained last month.\n\n## Outcome",
    );
    expect(out.endsWith("## Scope\n\n<!-- In and out. -->\n")).toBe(true);
    expect(parseBrief(out).sections[0]!.text).toBe("Two accounts were drained last month.");
  });

  it("is a tab of a change", () => {
    expect(tabsOf("Change").map((s) => s.id)).toContain("brief");
    expect(SCREENS.find((s) => s.id === "brief")!.label).toBe("Brief");
  });
});

describe("a question routed by what it asks", () => {
  it("says what it asks, and offers the other roles", () => {
    expect(asksWords("business")).toBe("Asks about business");
    const html = renderToStaticMarkup(
      <RouteQuestion
        id="q-0123456789ab"
        role="architecture"
        asks="business"
        routed={{ from: "product", by: "ari", at: "2026-11-09T10:00:00Z" }}
      />,
    );
    expect(html).toContain("Asks about business");
    expect(html).toContain(">Send it to</label>");
    expect(html).toContain(">the product owner</option>");
    expect(html).not.toContain(">the architect</option>");
    expect(html).toContain("Moved from the product owner by ari on 2026-11-09.");
  });
});

describe("owners suggested from roles.yaml", () => {
  it("accepts a suggestion by adding its people to that role only", () => {
    // ADR 0191 review: the other roles aren't sent, so an owner someone else named meanwhile
    // (the page's copy is older) is never cleared by an Accept (an empty role is a removal).
    expect(
      acceptBody({ "product-owner": ["pat"] }, { role: "architect", people: ["lee"] }),
    ).toEqual({ owners: { architect: ["lee"] } });
    expect(
      acceptBody({ architect: ["ari"] }, { role: "architect", people: ["lee", "ari"] }),
    ).toEqual({ owners: { architect: ["ari", "lee"] } });
    expect(
      suggestionFrom({
        role: "architect",
        people: ["lee"],
        from: { team: "team-ledger", name: "Ledger team", repos: ["forge-ledger"] },
      }),
    ).toBe("from Ledger team, which owns forge-ledger");
    expect(
      suggestionFrom({ role: "business-analyst", people: ["bao"], from: { default: true } }),
    ).toBe(W.suggestedDefault);
  });
});

describe("who a change waits on", () => {
  it("names the people and the role, or says nobody is named", () => {
    expect(
      renderToStaticMarkup(
        <WaitsOnLine
          w={{ role: "architect", people: ["ari"], because: "handoff", phase: "define" }}
        />,
      ),
    ).toContain("Waits on: @ari (architect)");
    expect(
      renderToStaticMarkup(
        <WaitsOnLine
          w={{ role: "business-analyst", people: [], because: "phase", phase: "plan" }}
        />,
      ),
    ).toContain("Waits on the business analyst, but nobody is named for it yet");
  });

  it("says on Home when it waits on you", () => {
    const html = renderToStaticMarkup(
      <ul>
        <ChangeWaitsLine
          c={{ id: "add-holds", title: "Ledger holds", state: "define" }}
          waitsOn={{ role: "product-owner", people: ["pat"], because: "phase", phase: "define" }}
          me="@Pat"
        />
      </ul>,
    );
    expect(html).toContain(W.home.waitsOnYou);
  });
});

describe("Home by role", () => {
  const changes = [{ id: "add-holds", title: "Ledger holds", type: "feature", state: "define" }];
  const finding = (id: string, asks: string) => ({
    id,
    gate: "define",
    severity: "blocking",
    artifact: "brief.md",
    summary: id,
    state: "open",
    change: "add-holds",
    asks,
  });
  it("shows the product owner only business findings, and a design one never holds Define", () => {
    expect(levelsOfRoles(["product"])).toEqual(["business"]);
    expect(levelsOfRoles([])).toBeUndefined();
    const all = inboxOf({
      changes,
      findings: [finding("no-circuit-breaker", "design"), finding("who-approves", "business")],
      questions: [],
      triage: [],
      steps: [],
    });
    const f = all.filter((x) => x.kind === "finding");
    expect(f.map((x) => [x.id, x.blocking ?? false])).toEqual([
      ["no-circuit-breaker", false],
      ["who-approves", true],
    ]);
    const po = inboxOf({
      changes,
      findings: [finding("no-circuit-breaker", "design"), finding("who-approves", "business")],
      levels: ["business"],
      questions: [],
      triage: [],
      steps: [],
    });
    expect(po.filter((x) => x.kind === "finding").map((x) => x.id)).toEqual(["who-approves"]);
    expect(holdsPhase("design", "design")).toBe(true);
    expect(holdsPhase("delivery", "design")).toBe(false);
  });

  it("folds set-up away for a product owner or business analyst only", () => {
    expect(nonAdminRoles(["product"])).toBe(true);
    expect(nonAdminRoles(["product", "analysis"])).toBe(true);
    expect(nonAdminRoles(["product", "architecture"])).toBe(false);
    expect(nonAdminRoles([])).toBe(false);
  });
});

describe("the business analyst shapes the stories", () => {
  it("sends a split with its other part, and says what is missing first", () => {
    const base = {
      op: "split" as const,
      story: "",
      stories: [],
      name: "Summarise",
      words: "",
      part: "",
      partWords: "",
    };
    expect(shapeBody(base)).toEqual({ error: W.shape.needStory });
    expect(shapeBody({ ...base, story: "s2-summarise-order" })).toEqual({
      error: W.shape.needPart,
    });
    expect(shapeBody({ ...base, story: "s2-summarise-order", part: "Price it" })).toEqual({
      body: {
        op: "split",
        story: "s2-summarise-order",
        name: "Summarise",
        parts: [{ name: "Price it" }],
      },
    });
    expect(shapeBody({ ...base, op: "merge", stories: ["s1"] })).toEqual({
      error: W.shape.needTwo,
    });
  });

  it("says each shaping in words, and lists the stories from the work items", () => {
    expect(
      shapeWords({
        id: "sh-1",
        op: "split",
        story: "s2",
        name: "Summarise",
        parts: [{ id: "s4-price", name: "Price" }],
        by: "bea",
        at: "x",
        state: "waiting",
      }),
    ).toBe('Split s2 into "Summarise", s4-price "Price"');
    expect(
      storiesOf({
        change: "c",
        tracker: "manual",
        command: "x",
        items: [
          { key: "feature", type: "feature", title: "F", action: "create" },
          { key: "story:s1-a", type: "story", title: "A", action: "create" },
        ],
      }),
    ).toEqual([{ id: "s1-a", title: "A" }]);
  });

  it("says each work item's standing", () => {
    expect(
      workItemState({
        key: "story:s1",
        type: "story",
        title: "A",
        action: "unchanged",
        id: "manual:create-story-a",
      }),
    ).toBe(W.workItems.waiting);
    expect(
      workItemState({
        key: "story:s1",
        type: "story",
        title: "A",
        action: "unchanged",
        id: "4711",
      }),
    ).toBe(`${W.workItems.created}: 4711`);
    expect(workItemState({ key: "story:s1", type: "story", title: "A", action: "create" })).toBe(
      W.workItems.toCreate,
    );
  });
});

describe("Ask answered from knowledge", () => {
  it("shows each passage with where it is from, and the AI step to word it", () => {
    const html = renderToStaticMarkup(
      <KnowledgeAnswerBlock
        k={{
          items: [],
          passages: [
            {
              source: "inputs",
              page: "wiki/snow-firewall-request.md",
              path: "inputs/wiki/snow-firewall-request.md",
              heading: "Firewall rules › Requesting a firewall rule",
              line: 5,
              text: "Raise a Network Access request in the service desk.",
            },
          ],
          command: 'atticus knowledge ask "How do I request a firewall rule?"',
        }}
      />,
    );
    expect(html).toContain("<strong>Requesting a firewall rule</strong>");
    expect(html).toContain("From wiki/snow-firewall-request.md (inputs)");
    expect(html).toContain("Raise a Network Access request");
    expect(html).toContain("atticus knowledge ask");
  });
});
