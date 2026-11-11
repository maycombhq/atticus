import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { COPY } from "../src/copy.js";
import { Inspector } from "../src/screens/architecture/Architecture.js";
import { ConnectPanel, Pairing } from "../src/screens/architecture/Connect.js";
import { popupFocus, type Focusable } from "../src/screens/architecture/popup.js";
import { WORDS } from "../src/screens/architecture/words.js";

/**
 * Beta.25: the map's details panel for a box, and the popups in it, laid out so nothing spills:
 * the name in its own case with its kind and state, the actions in two groups, each section the
 * same, a popup that names both ends, keeps its actions at the foot and gives focus back.
 * On the invented Forge estate.
 */

const un = (h: string) =>
  h
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
const C = COPY.connect;

const repo: Api.HierNodeT = {
  id: "repo:forge-proxy-payments-v1",
  kind: "repo",
  label: "forge-proxy-payments-v1",
  parent: "system:platform",
  childCount: 1,
  state: "current",
  gaps: ["inferred"],
  evidence: [{ source: "code", repo: "forge-proxy-payments-v1", at: "apiproxy/default.xml:4" }],
  properties: { name: "forge-proxy-payments-v1", repos: ["forge-a", "forge-b"] },
};

const panel = (extra: Partial<Parameters<typeof Inspector>[0]> = {}) =>
  un(
    renderToStaticMarkup(
      <Inspector
        node={repo}
        lens="repo"
        onOpen={() => undefined}
        onFocus={() => undefined}
        onConnect={() => undefined}
        onOwner={() => undefined}
        {...extra}
      />,
    ),
  );

describe("the box's details panel", () => {
  it("heads it with the name, its kind and state as tags (said to a screen reader), and the gaps counted", () => {
    const out = panel();
    expect(out).toContain('<h3 class="h box-name">forge-proxy-payments-v1</h3>');
    expect(out).toContain(`<span class="sr">${WORDS.kind}: </span>repo`);
    expect(out).toContain(`<span class="sr">${WORDS.stateLabel}: </span>Current`);
    expect(out).toContain(`1 ${WORDS.gapsBadge(1)}`);
    // Its properties stay, a list joined in words.
    expect(out).toContain("forge-a, forge-b");
  });

  it("groups what the box does apart from the pages it leads to, every action kept", () => {
    const out = panel({ here: { open: false, toggle: () => undefined } });
    const doing = out.indexOf('<div class="box-btns">');
    const going = out.indexOf('<div class="box-btns box-go">');
    expect(doing).toBeGreaterThan(-1);
    expect(going).toBeGreaterThan(doing);
    for (const w of [WORDS.open, WORDS.openHere, C.open, COPY.owner.open])
      expect(out.slice(doing, going)).toContain(`>${w}</button>`);
    for (const w of [COPY.flows.openFlows, WORDS.repoCounts])
      expect(out.slice(going)).toContain(`>${w}</a>`);
  });

  it("lays each section out the same, the fix beside a gap in words, not in capitals", () => {
    const out = panel();
    for (const h of [WORDS.gaps, WORDS.evidence, COPY.evidence.links])
      expect(out).toContain(`<section class="box-sec" aria-label="${h}"><h4 class="hud">${h}`);
    expect(out).toContain(`<span class="box-why">${WORDS.gapFix.inferred}</span>`);
    expect(out).toContain(COPY.evidence.noLinks);
  });

  it("shows only the actions a box has: none of a repo's on an outside system", () => {
    const out = un(
      renderToStaticMarkup(
        <Inspector
          node={{ ...repo, id: "system:northwind-pay", kind: "system", label: "Northwind Pay" }}
          lens="architecture"
          isCurrent
          onOpen={() => undefined}
          onFocus={() => undefined}
          onDeclare={() => undefined}
        />,
      ),
    );
    expect(out).toContain(`>${COPY.declare.open}</button>`);
    expect(out).not.toContain(COPY.flows.openFlows);
    expect(out).not.toContain("box-go");
  });
});

describe("the Connect popup", () => {
  const boxes = [{ label: "repo: forge-accounts", box: { repo: "forge-accounts" } }];
  it("names both ends, the box picked or what to pick", () => {
    const picked = un(
      renderToStaticMarkup(
        <ConnectPanel from="forge-cards" boxes={boxes} initial={boxes[0]} onClose={() => {}} />,
      ),
    );
    expect(picked).toContain(C.ends("forge-cards", "repo: forge-accounts"));
    expect(picked).toContain('tabindex="-1" class="h box-pop-title"');
    const none = un(
      renderToStaticMarkup(<ConnectPanel from="forge-cards" boxes={boxes} onClose={() => {}} />),
    );
    expect(none).toContain(C.ends("forge-cards", C.pickBoxNone));
  });

  it("lists each loose call as a row (method, path, where, now) with Preview and Write at the foot", () => {
    const view: Api.LinkCandidatesViewT = {
      from: "forge-cards",
      to: { repo: "forge-accounts" },
      toName: "forge-accounts",
      calls: [
        {
          fact: "call.get.ping",
          callType: "rest",
          method: "GET",
          path: "/ping",
          at: "src/main/java/forge/cards/CardsController.java:12",
          status: "unresolved",
        },
      ],
      apis: [{ id: "e-1", kind: "route", method: "GET", path: "/accounts/{id}" }],
    };
    const out = un(
      renderToStaticMarkup(
        <Pairing
          from="forge-cards"
          box={{ repo: "forge-accounts" }}
          cands={{ state: "ready", data: view }}
        />,
      ),
    );
    expect(out).not.toContain("<table");
    expect(out).toContain('<li class="box-call">');
    expect(out).toContain('<span class="box-method">GET</span><code class="mono">/ping</code>');
    // The whole call and its line on hover; a screen reader has them in the labels.
    expect(out).toContain('title="GET /ping\nsrc/main/java/forge/cards/CardsController.java:12"');
    expect(out).toContain(`<span class="sr">${C.col.status}: </span>${C.status.unresolved}`);
    const foot = out.indexOf('<div class="box-foot">');
    expect(foot).toBeGreaterThan(out.indexOf("</ul>"));
    expect(out.slice(foot)).toContain(`>${C.preview}</button>`);
  });
});

describe("a popup's focus", () => {
  const el = (log: string[], name: string, connected = true): Focusable => ({
    focus: () => log.push(`focus ${name}`),
    scrollIntoView: () => log.push(`show ${name}`),
    isConnected: connected,
  });

  it("brings the popup into view and focuses its heading; on close, focus goes back", () => {
    const log: string[] = [];
    const back = popupFocus(el(log, "heading"), el(log, "Connect to…"));
    expect(log).toEqual(["show heading", "focus heading"]);
    back();
    expect(log).toEqual(["show heading", "focus heading", "focus Connect to…"]);
  });

  it("gives focus back to nothing that has left the page, or when nothing had it", () => {
    const log: string[] = [];
    popupFocus(el(log, "heading"), el(log, "a box", false))();
    popupFocus(el(log, "heading"), null)();
    expect(log.filter((l) => l.startsWith("focus a box"))).toEqual([]);
  });
});
