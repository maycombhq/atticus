import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { COPY } from "../src/copy.js";
import { ACROSS } from "../src/screens/Across.js";
import { WaitingSections } from "../src/screens/CommandCenter.js";
import {
  needsAcross,
  NeedsAcrossView,
  openChanges,
  type ChangeNeeds,
} from "../src/screens/knowledge/NeedsAcross.js";

/** ADR 0105: every open need of every open change in one view, over invented Forge data. */

const T = COPY.across;
const N = COPY.knowledge.needs;
const html = (el: ReactElement) => renderToStaticMarkup(el);
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");

type Need = Api.NeedViewT;
const need = (item: string, over: Partial<Need> = {}): Need => ({
  item,
  kind: "request",
  title: item,
  for: "change",
  why: "The ledger calls Northwind Pay through a new route.",
  from: "assistant",
  inputs: [],
  steps: [],
  rules: [],
  urls: [],
  status: "open",
  ...over,
});
const view = (change: string, needs: Need[], present = true): Api.ChangeNeedsViewT => ({
  change,
  file: `openspec/changes/${change}/needs.yaml`,
  present,
  needs,
  considered: [],
  command: `atticus change needs ${change}`,
  slash: `/atticus-needs ${change}`,
});

const rows: ChangeNeeds[] = [
  {
    change: "add-transfer-limit",
    title: "Add a daily transfer limit",
    needs: view("add-transfer-limit", [
      need("firewall-rule-request", {
        title: "Network firewall rule",
        leadTime: "10 working days",
        handledBy: "Network team",
        review: {
          state: "verified",
          verdict: "verified",
          by: "priya.nair",
          at: "2026-10-22T10:00:00Z",
        },
      }),
      need("json-logging", {
        kind: "standard",
        title: "Log as JSON",
        status: "done",
        by: "priya.nair",
      }),
    ]),
  },
  {
    change: "fix-timeout",
    title: "Raise the audit timeout",
    needs: view("fix-timeout", [need("northwind-pay", { kind: "vendor", title: "Northwind Pay" })]),
  },
  {
    change: "new-portal-page",
    title: "A new portal page",
    needs: view("new-portal-page", [], false),
  },
  { change: "broken", title: "Broken needs file", error: "needs.yaml isn't a valid needs file." },
];

describe("needs across changes", () => {
  it("is one of the cross-change views", () => {
    expect(ACROSS.map((a) => a.id)).toContain("needs");
  });

  it("takes the open changes only", () => {
    expect(
      openChanges([
        { id: "a", title: "A", state: "plan" },
        { id: "b", title: "B", state: "archived" },
      ]).map((c) => c.id),
    ).toEqual(["a"]);
  });

  it("groups the open needs by change, and says which changes have none yet or can't be read", () => {
    const d = needsAcross(rows, { all: false, text: "" });
    expect(d.groups.map((g) => [g.change, g.needs.map((n) => n.item)])).toEqual([
      ["add-transfer-limit", ["firewall-rule-request"]],
      ["fix-timeout", ["northwind-pay"]],
    ]);
    expect(d.open).toBe(2);
    expect(d.notYet.map((c) => c.change)).toEqual(["new-portal-page"]);
    expect(d.errors.map((c) => c.change)).toEqual(["broken"]);
  });

  it("shows the done and not-needed ones too when asked, or those marked just now", () => {
    expect(needsAcross(rows, { all: true, text: "" }).groups[0]!.needs).toHaveLength(2);
    const kept = new Set(["add-transfer-limit|json-logging|change"]);
    expect(needsAcross(rows, { all: false, text: "", kept }).groups[0]!.needs).toHaveLength(2);
  });

  it("filters by every word, across the need and its change", () => {
    const d = needsAcross(rows, { all: false, text: "northwind timeout" });
    expect(d.groups.map((g) => g.change)).toEqual(["fix-timeout"]);
    expect(needsAcross(rows, { all: false, text: "nothing-like-this" }).groups).toEqual([]);
  });

  it("renders each change with its needs, their facts, tick and actions", () => {
    const out = html(
      <NeedsAcrossView
        of={{ state: "ready", data: rows }}
        all={false}
        text=""
        onMark={() => undefined}
      />,
    );
    expect(out).toContain('href="#/changes/add-transfer-limit"');
    expect(out).toContain(esc("Add a daily transfer limit"));
    expect(out).toContain("10 working days");
    expect(out).toContain("Network team");
    expect(out).toContain(esc(COPY.knowledge.review.verified("priya.nair", "2026-10-22")));
    expect(out).toContain(`aria-label="${esc(N.markDoneOf("Network firewall rule"))}"`);
    expect(out).toContain(`aria-label="${esc(N.markSkipOf("Northwind Pay"))}"`);
    expect(out).not.toContain("Log as JSON");
    expect(out).toContain(esc(T.needsCount(2, 4)));
    expect(out).toContain("atticus change needs new-portal-page");
    expect(out).toContain('role="alert"');
    // Ids stay unique when two changes need the same item.
    const ids = [...out.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("offers Reopen on a need already done", () => {
    const out = html(
      <NeedsAcrossView of={{ state: "ready", data: rows }} all text="" onMark={() => undefined} />,
    );
    expect(out).toContain(`aria-label="${esc(N.reopenOf("Log as JSON"))}"`);
  });

  it("has loading, error and empty states", () => {
    const at = (of: Parameters<typeof NeedsAcrossView>[0]["of"]) =>
      html(<NeedsAcrossView of={of} all={false} text="" />);
    expect(at({ state: "loading" })).toContain('aria-busy="true"');
    expect(at({ state: "error", error: "boom" })).toContain('role="alert"');
    expect(at({ state: "ready", data: [] })).toContain(esc(T.needsNoChanges));
    expect(at({ state: "ready", data: [rows[2]!] })).toContain(esc(T.needsNone));
    expect(
      html(<NeedsAcrossView of={{ state: "ready", data: rows }} all={false} text="zzz" />),
    ).toContain(esc(T.nothingMatches("zzz")));
  });
});

describe("Waiting on you", () => {
  it("links to each kind of thing that waits, with its count", () => {
    const out = html(<WaitingSections questions={3} needs={2} steps={0} blocking={undefined} />);
    expect(out).toContain('href="#/questions"');
    expect(out).toContain('href="#/changes?across=needs"');
    expect(out).toContain('href="#/todo"');
    expect(out).toContain('href="#/changes?across=findings"');
    expect(out).toContain(">3<");
    expect(out).toContain(">2<");
    expect(out).toContain(esc(COPY.app.notLoaded));
  });
});
