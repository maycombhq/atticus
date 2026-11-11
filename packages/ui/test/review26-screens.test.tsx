import { readFileSync } from "node:fs";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { COPY } from "../src/copy.js";
import { CorrectionNextPanel } from "../src/app/correction-next.js";
import { CodeFigure, takesText } from "../src/app/ui.js";
import { Diff } from "../src/screens/architecture/Owner.js";
import { HomeTile } from "../src/screens/home/HomeTiles.js";
import { NeedsTop, topWaiting } from "../src/screens/home/HomePanels.js";
import { homeStatus } from "../src/screens/CommandCenter.js";
import { HomeEstate } from "../src/screens/work/Overview.js";
import { CanvasLegend, MapBar, readLegendOpen } from "../src/screens/architecture/MapBar.js";
import { revealOf } from "../src/screens/architecture/Architecture.js";
import { PaneSplit } from "../src/screens/Questions.js";
import { WORDS } from "../src/screens/architecture/words.js";
import type { InboxItem } from "../src/app/inbox.js";

/**
 * Beta.26 second review (Home, the map's canvas, Questions): a file's lines that can scroll are
 * reached by keyboard; a tile says nothing under it while it loads; what needs a person links to
 * its change; a disclosure points at nothing while closed; the legend starts folded; the question
 * panes are as tall as the page that holds them. On the invented Forge estate.
 */

const H = COPY.commandCenter.home;
const T = COPY.commandCenter;
const html = (el: ReactElement) => renderToStaticMarkup(el);
const esc = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");
const noop = () => undefined;

describe("a file's lines in a figure (axe: scrollable-region-focusable)", () => {
  it("is a region the keyboard reaches, named by its caption, its long lines wrapped", () => {
    const out = html(<CodeFigure caption="The change to facts/forge-ledger.jsonl">x</CodeFigure>);
    const cap = /<figcaption id="([^"]+)"/.exec(out)?.[1];
    expect(cap).toBeTruthy();
    expect(out).toMatch(
      new RegExp(`<pre class="mono" tabindex="0" role="region" aria-labelledby="${cap}"`),
    );
    expect(out).toContain("overflow-wrap:anywhere");
  });

  it("is what a correction's panel and an owner's diff show their lines in", () => {
    const line = '{"schemaVersion":1,"fact":"e-get-balance","action":"wrong","why":"moved"}';
    const panel = html(
      <CorrectionNextPanel
        file="facts/forge-ledger.corrections.jsonl"
        line={line}
        preview={{ state: "loading" }}
      />,
    );
    expect(panel).toMatch(
      /<figure[^>]*><figcaption id="[^"]+"[^>]*>[^<]+<\/figcaption><pre[^>]*tabindex="0" role="region"/,
    );
    expect(panel).toContain(esc(`+ ${line}`));
    const diff = html(
      <Diff
        r={
          {
            files: [{ file: "workspace.yaml", changes: [{ was: "owner: a", now: "owner: b" }] }],
          } as never
        }
      />,
    );
    expect(diff).toMatch(/<pre[^>]*tabindex="0" role="region" aria-labelledby="[^"]+"/);
  });

  it("wraps a scrolling page's pre at any point, so a long JSON line doesn't scroll sideways", () => {
    const css = readFileSync(
      new URL("../src/screens/knowledge/knowledge.css", import.meta.url),
      "utf8",
    );
    const rule = /:is\(\.kn, \.st\) pre \{[^}]*\}/.exec(css)![0];
    expect(rule).toContain("overflow-wrap: anywhere");
  });
});

describe("Esc in a drawer (finding 1)", () => {
  const el = (tagName: string, type?: string, editable = false) =>
    ({ tagName, isContentEditable: editable, ...(type ? { type } : {}) }) as never;
  it("is a text field's own only where text is typed", () => {
    expect(takesText(el("INPUT", "text"))).toBe(true);
    expect(takesText(el("INPUT", "search"))).toBe(true);
    expect(takesText(el("INPUT"))).toBe(true);
    expect(takesText(el("TEXTAREA"))).toBe(true);
    expect(takesText(el("DIV", undefined, true))).toBe(true);
    for (const t of ["checkbox", "radio", "range", "button", "color", "file"])
      expect(takesText(el("INPUT", t))).toBe(false);
    expect(takesText(el("SELECT"))).toBe(false);
    expect(takesText(el("BUTTON"))).toBe(false);
    expect(takesText(null)).toBe(false);
  });
});

describe("Home's tiles and rows", () => {
  it("says nothing under a tile while it loads (no 'None in flight' before the count)", () => {
    const out = html(
      <HomeTile
        t={{
          id: "in-flight",
          label: H.inFlight,
          href: "#/changes",
          state: "loading",
          value: 0,
          sub: H.inFlightNone,
        }}
      />,
    );
    expect(out).not.toContain(esc(H.inFlightNone));
    expect(out).not.toContain("aria-describedby");
    expect(out).toContain('class="skeleton"');
  });

  const item = (o: Partial<InboxItem>): InboxItem =>
    ({ kind: "need", id: "n", title: "x", blocking: false, href: "#/", ...o }) as InboxItem;
  const changes = [
    { id: "add-transfer-limit", title: "Add a daily transfer limit", state: "build" },
  ];
  const items = [
    item({ id: "n-1", change: "add-transfer-limit", href: "#/changes?across=needs" }),
    item({ kind: "step", id: "s-1", href: "#/todo" }),
  ];

  it("links each row of what needs a person to its change", () => {
    const { rows } = topWaiting(items, changes);
    expect(rows.find((r) => r.kind === "need")).toMatchObject({
      change: "Add a daily transfer limit",
      changeId: "add-transfer-limit",
    });
    const out = html(<NeedsTop items={items} changes={changes} state="ready" />);
    expect(out).toContain(
      `<a href="#/changes/add-transfer-limit">${esc("Add a daily transfer limit")}</a>`,
    );
    expect(out).toContain(esc(T.noChangeGroup));
  });

  it("makes the status line count what the Blocking findings tile counts", () => {
    expect(homeStatus("ready", 0)).toEqual({ text: T.nothingIsBlockedRight, bad: false });
    expect(homeStatus("ready", 2)).toEqual({ text: T.thingsNeedAttention(2), bad: true });
    expect(homeStatus("loading", 2).text).toBe(COPY.app.ccReading);
    expect(homeStatus("error", 2)).toEqual({ text: COPY.app.ccCantRead, bad: false });
  });

  it("can show the estate without its changes in flight (Home's own panel has them)", () => {
    const out = html(
      <HomeEstate
        onboarding={{ state: "loading" }}
        trust={{ state: "loading" }}
        changes={{ state: "ready", data: [] }}
        withInFlight={false}
      />,
    );
    expect(out).toContain(esc(COPY.work.estate));
    expect(out).not.toContain(`>${esc(COPY.work.inFlight)}<`);
  });
});

describe("the map's disclosures and legend", () => {
  const bar = (open: boolean) =>
    html(
      <MapBar
        lenses={[{ id: "repo", label: WORDS.lenses.repo }]}
        lens="repo"
        onLens={noop}
        crumbs={null}
        onAdd={noop}
        tools={{ open, bodyId: "tools-body", onToggle: noop, shown: 2, all: 2 }}
      />,
    );

  it("points the tools button at the drawer only while the drawer is there", () => {
    expect(bar(false)).not.toContain("aria-controls");
    expect(bar(true)).toContain('aria-expanded="true" aria-controls="tools-body"');
  });

  it("points the legend's button at its body only while it is open", () => {
    const shut = html(<CanvasLegend meta="2 links" links={[]} initialOpen={false} />);
    expect(shut).toContain('aria-expanded="false"');
    expect(shut).not.toContain("aria-controls");
    const open = html(<CanvasLegend meta="2 links" links={[]} initialOpen />);
    const id = /aria-controls="([^"]+)"/.exec(open)?.[1];
    expect(open).toContain(`id="${id}"`);
  });

  it("starts the legend folded (it covered a box at 1440 by 900), and opens it as this browser kept", () => {
    const store = (v: string | null) => ({ getItem: () => v });
    expect(readLegendOpen(store(null))).toBe(false);
    expect(readLegendOpen(store("open"))).toBe(true);
    expect(readLegendOpen(store("closed"))).toBe(false);
    expect(
      readLegendOpen({
        getItem: () => {
          throw new Error("denied");
        },
      }),
    ).toBe(false);
  });

  it("opens the details for a box picked, a link picked or a panel asked for, and for nothing else", () => {
    const none = {
      adding: false,
      connecting: undefined,
      declaring: undefined,
      owning: undefined,
      pickedLink: undefined,
      pickedBox: undefined,
    };
    expect(revealOf(none)).toBe("");
    expect(revealOf({ ...none, pickedBox: "forge-ledger" })).toBe("box:forge-ledger");
    expect(revealOf({ ...none, pickedLink: { id: "l-1" }, pickedBox: "forge-ledger" })).toBe(
      "box:forge-ledger|l-1",
    );
    expect(revealOf({ ...none, adding: true, owning: "forge-portal" })).toBe("add|forge-portal");
  });
});

describe("the question panes", () => {
  it("are as tall as the page that holds them, not the window", () => {
    const css = readFileSync(new URL("../src/screens/questions.css", import.meta.url), "utf8");
    const rule = /\.panel\.qs-pane \{[^}]*\}/.exec(css)![0];
    expect(rule).not.toMatch(/100d?vh/);
    expect(rule).toContain("max-height: var(--qs-pane-h");
    const out = html(
      <PaneSplit>
        <section className="panel qs-pane" />
      </PaneSplit>,
    );
    expect(out).toMatch(/^<div class="qs-split" style="--qs-pane-h:\d+px">/);
  });
});
