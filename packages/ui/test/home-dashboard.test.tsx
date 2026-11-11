import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { COPY } from "../src/copy.js";
import type { InboxItem } from "../src/app/inbox.js";
import { byStage, correctionsTile, waitingTiles } from "../src/screens/CommandCenter.js";
import { HomeTile, TileGroup, toneOf } from "../src/screens/home/HomeTiles.js";
import {
  GateStrip,
  HomeChanges,
  NeedsTop,
  topWaiting,
  TOP,
  TOP_CHANGES,
} from "../src/screens/home/HomePanels.js";

/**
 * beta.26: Home as one screen. Its tiles (a number, a label and one place to go; loading,
 * failed and quiet each said), its short panels with their top few and See all, over invented
 * Forge data.
 */

const T = COPY.commandCenter;
const H = T.home;
const html = (el: ReactElement) => renderToStaticMarkup(el);
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
const count = (out: string, re: RegExp) => out.match(re)?.length ?? 0;

describe("a tile", () => {
  it("is one link named by its label and number, its line under it as the description", () => {
    const out = html(
      <HomeTile
        t={{
          id: "in-flight",
          label: H.inFlight,
          href: "#/changes",
          state: "ready",
          value: 3,
          sub: "2 feature · 1 tasks",
        }}
      />,
    );
    expect(count(out, /<a /g)).toBe(1);
    expect(out).toContain('href="#/changes"');
    expect(out).toContain(`${H.inFlight}</span> <span class="hm-tile-n">3</span>`);
    expect(out).toContain('aria-describedby="hm-tile-in-flight-sub"');
    expect(out).toContain('id="hm-tile-in-flight-sub"');
    expect(out).not.toContain("aria-busy");
  });

  it("shows a skeleton while it loads, never a 0", () => {
    const out = html(
      <HomeTile
        t={{ id: "catalog", label: H.catalog, href: "#/trust", state: "loading", value: 0 }}
      />,
    );
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain('class="skeleton"');
    expect(out).toContain(H.tileLoading);
    expect(out).not.toContain(">0<");
    expect(out).toContain("hm-tile quiet");
  });

  it("says why it didn't load, on its own, with a dash for the number", () => {
    const out = html(
      <HomeTile
        t={{ id: "catalog", label: H.catalog, href: "#/trust", state: "error", error: "boom" }}
      />,
    );
    expect(out).toContain("hm-tile error");
    expect(out).toContain("–");
    expect(out).toContain(esc(COPY.app.notLoaded));
    expect(out).toContain(esc(H.tileError("boom")));
    expect(out).toContain('aria-describedby="hm-tile-catalog-sub"');
    // A server that is down is said once at the top of the page; here it is short.
    const down = html(
      <HomeTile
        t={{
          id: "catalog",
          label: H.catalog,
          href: "#/trust",
          state: "error",
          error: COPY.app.offline,
        }}
      />,
    );
    expect(down).toContain(esc(H.tileError(COPY.app.offlineShort)));
  });

  it("is quiet at nothing, amber when something waits, magenta when it blocks", () => {
    expect(toneOf(0, "waits")).toBe("quiet");
    expect(toneOf(undefined, "blocks")).toBe("quiet");
    expect(toneOf(2, "waits")).toBe("warn");
    expect(toneOf(1, "blocks")).toBe("bad");
    const out = html(
      <TileGroup
        id="hm-x"
        title={T.waitingOnYou}
        tiles={[
          { id: "a", label: T.waitSteps, href: "#/todo", state: "ready", value: 0, tone: "quiet" },
        ]}
      />,
    );
    expect(out).toContain('aria-labelledby="hm-x"');
    expect(out).toContain(`<h2 id="hm-x" class="hm-label">${T.waitingOnYou}</h2>`);
    expect(out).toContain("hm-tile quiet");
  });
});

describe("Waiting on you, as tiles", () => {
  it("keeps each kind's link and count, and says loading and failed counts apart", () => {
    const t = waitingTiles({
      questions: undefined,
      needs: 2,
      steps: undefined,
      blocking: 1,
      status: { questions: { state: "loading" }, steps: { state: "error", error: "boom" } },
      blockingSub: H.findingsSub(1, 2, "security"),
    });
    const out = html(<TileGroup id="g" title="g" tiles={[t.wait, t.questions, t.blocking]} />);
    expect(out).toContain('href="#/questions"');
    expect(out).toContain('href="#/changes?across=needs"');
    expect(out).toContain('href="#/changes?across=findings"');
    // The needs and steps share a tile: a step that didn't load fails it, never a short count.
    expect(t.wait).toMatchObject({ state: "error", error: "boom", value: undefined });
    expect(out).toContain(esc(H.tileError("boom")));
    expect(out).toContain('aria-busy="true"');
    // Findings by lens and by source, folded into the Blocking findings tile.
    expect(out).toContain(esc(H.findingsSub(1, 2, "security")));
    expect(out).toContain("hm-tile bad");
    const ready = waitingTiles({ questions: 36, needs: 2, steps: 1, blocking: 0 });
    expect(ready.wait).toMatchObject({ value: 3, sub: H.waitOnYouSub(2, 1), tone: "warn" });
    expect(ready.blocking.tone).toBe("quiet");
    expect(html(<HomeTile t={ready.questions} />)).toContain(
      `${T.waitQuestions}</span> <span class="hm-tile-n">36</span>`,
    );
  });
});

describe("the estate's tiles", () => {
  it("counts the changes in flight by stage", () => {
    expect(byStage([{ state: "define" }, { state: "build" }, { state: "returned" }])).toBe(
      `${H.inStage(2, COPY.work.stage.feature)} · ${H.inStage(1, COPY.work.stage.tasks)}`,
    );
  });

  it("counts the corrections to apply on the map, and the files to propose", () => {
    const t = correctionsTile({
      state: "ready",
      data: {
        scope: "work",
        branch: "b",
        title: "t",
        files: [
          { path: "facts/forge-ledger.corrections.jsonl", status: "M" },
          { path: "questions/q-1.yaml", status: "M" },
          { path: "questions/q-2.yaml", status: "M", proposed: "propose/x" },
        ],
      },
    });
    expect(t).toMatchObject({ value: 1, href: "#/canvas", tone: "warn", sub: H.toPropose(2) });
    const none = correctionsTile({
      state: "ready",
      data: { scope: "work", branch: "b", title: "t", files: [], applyFirst: [] },
    });
    expect(none).toMatchObject({ value: 0, tone: "quiet", sub: H.toPropose(0) });
    expect(correctionsTile({ state: "loading" }).state).toBe("loading");
  });
});

const item = (over: Partial<InboxItem> & Pick<InboxItem, "kind">): InboxItem => ({
  title: "x",
  detail: "",
  href: "#/",
  ...over,
});

const changes = [
  { id: "add-transfer-limit", title: "Add a daily transfer limit", state: "build" },
  { id: "fix-northwind-timeout", title: "Fix the Northwind Pay timeout", state: "define" },
];
const items: InboxItem[] = [
  ...["q-1", "q-2", "q-3"].map((id) =>
    item({ kind: "question", id, repo: "forge-ledger", href: `#/questions/${id}` }),
  ),
  item({ kind: "question", id: "q-4", repo: "forge-notes", href: "#/questions/q-4" }),
  ...["q-5", "q-6"].map((id) =>
    item({ kind: "question", id, repo: "forge-portal", href: `#/questions/${id}` }),
  ),
  item({ kind: "need", id: "n-1", change: "add-transfer-limit", href: "#/changes?across=needs" }),
  item({ kind: "need", id: "n-2", change: "add-transfer-limit", href: "#/changes?across=needs" }),
  item({
    kind: "finding",
    id: "f-1",
    change: "fix-northwind-timeout",
    blocking: true,
    href: "#/brief?change=fix-northwind-timeout",
  }),
  item({ kind: "step", id: "s-1", href: "#/todo" }),
  item({ kind: "triage", id: "t-1", href: "#/intake" }),
  item({ kind: "phase", id: "add-transfer-limit", change: "add-transfer-limit" }),
];

describe("Needs a person, its top few", () => {
  it("puts what blocks first, then the most waiting, one row per repo's questions", () => {
    const { rows, total } = topWaiting(items, changes);
    expect(total).toBe(11);
    expect(rows[0]).toMatchObject({
      kind: "finding",
      blocking: true,
      change: "Fix the Northwind Pay timeout",
      href: "#/brief?change=fix-northwind-timeout",
    });
    expect(rows[1]).toMatchObject({ title: T.sectionQuestions("forge-ledger"), count: 3 });
    expect(rows.map((r) => r.count).slice(1)).toEqual([3, 2, 2, 1, 1, 1]);
    // A repo's questions open the Questions page, not one question.
    expect(rows[1]!.href).toBe("#/questions");
    expect(rows.find((r) => r.kind === "need")!.href).toBe("#/changes?across=needs");
    expect(rows.find((r) => r.kind === "step")!.href).toBe("#/todo");
  });

  it("shows the top five and how many more, never the whole list", () => {
    const out = html(<NeedsTop items={items} changes={changes} state="ready" />);
    expect(count(out, /<li>/g)).toBe(TOP);
    expect(out).toContain(esc(H.needsMore(2)));
    expect(out).toContain(esc(T.blocked));
    expect(out).toContain(
      `${esc(H.inChangeLead)}<a href="#/changes/add-transfer-limit">Add a daily transfer limit</a>`,
    );
    expect(out).toContain(esc(T.noChangeGroup));
  });

  it("says loading, failed, partly loaded and nothing waiting, each in the panel", () => {
    expect(html(<NeedsTop items={[]} changes={[]} state="loading" />)).toContain(
      'aria-busy="true"',
    );
    const failed = html(<NeedsTop items={[]} changes={[]} state="error" error="boom" />);
    expect(failed).toContain('role="alert"');
    expect(failed).toContain(esc(T.couldntLoadWhatNeeds("boom")));
    const empty = html(<NeedsTop items={[]} changes={[]} state="ready" />);
    expect(empty).toContain(esc(T.nothingNeedsAPerson));
    expect(empty).not.toContain('role="alert"');
    const partly = html(
      <NeedsTop items={items} changes={changes} state="ready" partial={["the triage (boom)"]} />,
    );
    expect(partly).toContain(esc(T.partlyLoaded(["the triage (boom)"])));
  });
});

const flight = Array.from({ length: 7 }, (_, k) => ({
  id: `add-limit-${k}`,
  title: `Add limit ${k}`,
  state: k === 0 ? "build" : "define",
  ...(k === 0 ? { openFindings: { blocking: 1 } } : {}),
}));

describe("the changes panel", () => {
  it("shows the current change's gates, the top four with their stage, See all and the map", () => {
    const out = html(
      <HomeChanges
        changes={{ state: "ready", data: flight }}
        inFlight={flight}
        yours={undefined}
        me="pat"
      />,
    );
    expect(count(out, /<li>/g)).toBe(TOP_CHANGES);
    expect(out).toContain(`aria-label="${esc(H.gatesOf("Add limit 0"))}"`);
    expect(count(out, /aria-current="step"/g)).toBe(1);
    expect(out).toContain('href="#/changes/add-limit-0"');
    expect(out).not.toContain('href="#/changes/add-limit-4"');
    expect(out).toContain(`<a href="#/changes">${H.seeAllChanges}</a>`);
    expect(out).toContain(esc(H.changesMore(3)));
    expect(out).toContain(`<a href="#/canvas">${H.mapSub}</a>`);
    expect(out).toContain(COPY.work.stage.tasks);
    expect(out).toContain(esc(T.blocked));
  });

  it("says when no change names the person, and when none is in flight", () => {
    const none = html(
      <HomeChanges
        changes={{ state: "ready", data: flight }}
        inFlight={flight}
        yours={[]}
        me="pat"
      />,
    );
    expect(none).toContain(esc(COPY.roleWork.home.noneYours));
    expect(none).toContain(`<a href="#/changes">${H.seeAllChanges}</a>`);
    const empty = html(
      <HomeChanges
        changes={{ state: "ready", data: [] }}
        inFlight={[]}
        yours={undefined}
        me="pat"
      />,
    );
    expect(empty).toContain(esc(COPY.work.noChanges));
    expect(empty).not.toContain('role="alert"');
  });

  it("loads and fails in its own panel", () => {
    const loading = html(
      <HomeChanges changes={{ state: "loading" }} inFlight={[]} yours={undefined} me="pat" />,
    );
    expect(loading).toContain('aria-busy="true"');
    const failed = html(
      <HomeChanges
        changes={{ state: "error", error: "boom" }}
        inFlight={[]}
        yours={undefined}
        me="pat"
      />,
    );
    expect(failed).toContain('role="alert"');
  });
});

describe("the gate pipeline", () => {
  it("marks the gates done, the current one, and those to come, in words too", () => {
    const out = html(<GateStrip state="plan" />);
    expect(count(out, /hm-gate done/g)).toBe(2);
    expect(count(out, /aria-current="step"/g)).toBe(1);
    expect(out).toContain(esc(T.currentPhase(T.plan)));
    expect(count(out, new RegExp(T.toCome, "g"))).toBe(3);
  });
});
