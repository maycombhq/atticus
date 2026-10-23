import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { COPY } from "../src/copy.js";
import {
  bySession,
  changesOf,
  HistoryView,
  historyHref,
  shownTurns,
} from "../src/screens/history/History.js";

/**
 * ADR 0110: the Prompt history screen. What people asked their assistant in the metarepo and what
 * it answered, by session, each prompt with its response, each in a <pre> as text; a filter box
 * and a change filter; whether recording is on; and what can't be recorded. Invented Forge data
 * (CLAUDE.md rule 3); no network (rule 5).
 */

const H = COPY.history;
const F = COPY.filter;
const html = (el: ReactElement) => renderToStaticMarkup(el);
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");

type Rec = Api.HistoryRecord;
const rec = (id: string, over: Partial<Rec>): Rec => ({
  id,
  at: "2026-10-23T10:15:00.000Z",
  surface: "claude-code",
  session: "5f1d7c0e",
  kind: "prompt",
  text: "",
  size: 0,
  ...over,
});
const turns: Api.HistoryTurn[] = [
  {
    session: "5f1d7c0e",
    surface: "claude-code",
    at: "2026-10-23T10:20:00.000Z",
    prompt: rec("h-20261023102000-0a0b0c", {
      at: "2026-10-23T10:20:00.000Z",
      text: "Which repos call forge-ledger?",
    }),
  },
  {
    session: "5f1d7c0e",
    surface: "claude-code",
    at: "2026-10-23T10:15:00.000Z",
    change: "add-transfer-limit",
    prompt: rec("h-20261023101500-a1b2c3", {
      text: "/atticus-needs add-transfer-limit",
      change: "add-transfer-limit",
      command: "/atticus-needs",
    }),
    response: rec("h-20261023101530-d4e5f6", {
      kind: "response",
      at: "2026-10-23T10:15:30.000Z",
      text: "add-transfer-limit needs a firewall rule to <Northwind Pay>.",
      truncated: true,
      size: 80000,
    }),
  },
  {
    session: "vscode-20261023091500-7a7a7a",
    surface: "vscode",
    at: "2026-10-23T09:15:00.000Z",
    change: "add-transfer-limit",
    prompt: rec("h-20261023091500-111111", {
      surface: "vscode",
      session: "vscode-20261023091500-7a7a7a",
      at: "2026-10-23T09:15:00.000Z",
      text: "@atticus /stories add-transfer-limit",
      command: "/stories",
    }),
    response: rec("h-20261023091610-222222", {
      surface: "vscode",
      session: "vscode-20261023091500-7a7a7a",
      kind: "response",
      at: "2026-10-23T09:16:10.000Z",
      text: "Done: 4 stories written. api_key=***",
      masked: true,
    }),
  },
  {
    session: "9e9e9e9e",
    surface: "claude-code",
    at: "2026-09-30T16:00:00.000Z",
    change: "refunds-through-northwind-pay",
    prompt: rec("h-20260930160000-0c0c0c", {
      session: "9e9e9e9e",
      at: "2026-09-30T16:00:00.000Z",
      text: "Draft the brief for refunds-through-northwind-pay",
    }),
  },
];
const list = (over: Partial<Api.HistoryList> = {}): Api.HistoryList => ({
  turns,
  total: turns.length,
  recording: { on: true },
  ...over,
});

describe("the prompt history's turns", () => {
  it("filters on the prompt, the response, the command, the change and the session", () => {
    const ids = (o: Parameters<typeof shownTurns>[1]) =>
      shownTurns(turns, o).map((t) => t.prompt?.id);
    expect(ids({ text: "" })).toHaveLength(4);
    expect(ids({ text: "FIREWALL northwind" })).toEqual(["h-20261023101500-a1b2c3"]);
    expect(ids({ text: "/stories" })).toEqual(["h-20261023091500-111111"]);
    expect(ids({ text: "", change: "add-transfer-limit" })).toEqual([
      "h-20261023101500-a1b2c3",
      "h-20261023091500-111111",
    ]);
    expect(ids({ text: "", session: "9e9e9e9e" })).toEqual(["h-20260930160000-0c0c0c"]);
    expect(ids({ text: "nothing like it" })).toEqual([]);
  });

  it("groups them by session, the session with the newest turn first", () => {
    expect(bySession(turns).map((s) => [s.session, s.turns.length])).toEqual([
      ["5f1d7c0e", 2],
      ["vscode-20261023091500-7a7a7a", 1],
      ["9e9e9e9e", 1],
    ]);
  });

  it("offers the changes the history is about, and links to them", () => {
    expect(changesOf(turns)).toEqual(["add-transfer-limit", "refunds-through-northwind-pay"]);
    expect(historyHref({ change: "add-transfer-limit" })).toBe(
      "#/history?change=add-transfer-limit",
    );
    expect(historyHref({ session: "9e9e9e9e", q: "brief" })).toBe(
      "#/history?session=9e9e9e9e&q=brief",
    );
    expect(historyHref({})).toBe("#/history");
  });
});

describe("the Prompt history screen", () => {
  it("shows each prompt with its response, by session, each as text in its own box", () => {
    const out = html(<HistoryView of={{ state: "ready", data: list() }} text="" />);
    expect(out).toContain(`placeholder="${F.placeholder}"`);
    expect(out).toContain(esc(H.session("5f1d7c0e")));
    expect(out).toContain(H.surfaces["claude-code"]);
    expect(out).toContain(H.surfaces.vscode);
    // As text, never markup.
    expect(out).toContain("&lt;Northwind Pay&gt;");
    expect(out).not.toContain("<Northwind Pay>");
    expect(out).toMatch(/<pre[^>]*tabindex="0"[^>]*>/);
    expect(out).toContain(esc(H.box(H.prompt, "h-20261023101500-a1b2c3")));
    expect(out).toContain(esc(H.box(H.response, "h-20261023101530-d4e5f6")));
    expect(out).toContain(H.noResponse);
    expect(out).toContain(esc(H.truncated(80000)));
    expect(out).toContain(H.masked);
    expect(out).toContain('href="#/history?change=add-transfer-limit"');
    expect(out).toContain("/atticus-needs");
    // Newest session first.
    expect(out.indexOf("5f1d7c0e")).toBeLessThan(out.indexOf("9e9e9e9e"));
    expect(out).toContain(esc(H.recordingOn));
    expect(out).toContain(esc(H.what));
  });

  it("has a change filter, and says when it shows one change or session only", () => {
    const one = html(
      <HistoryView of={{ state: "ready", data: list() }} text="" change="add-transfer-limit" />,
    );
    expect(one).toContain(H.change);
    expect(one).toContain(H.everyChange);
    expect(one).toMatch(/<option value="add-transfer-limit" selected="">/);
    expect(one).not.toContain("9e9e9e9e");
    const s = html(
      <HistoryView of={{ state: "ready", data: list() }} text="" session="9e9e9e9e" />,
    );
    expect(s).toContain(esc(H.onlySession("9e9e9e9e")));
    expect(s).toContain(H.showAll);
  });

  it("says what was filtered, and offers to clear it", () => {
    const none = html(<HistoryView of={{ state: "ready", data: list() }} text="nothing like it" />);
    expect(none).toContain(F.clear);
    expect(none).toContain(esc(F.words("nothing like it")));
  });

  it("says why recording is off, by the org pack or on this machine", () => {
    const org = html(
      <HistoryView
        of={{ state: "ready", data: list({ recording: { on: false, offBy: "org-pack" } }) }}
        text=""
      />,
    );
    expect(org).toContain(esc(H.offOrgPack));
    const mine = html(
      <HistoryView
        of={{ state: "ready", data: list({ recording: { on: false, offBy: "local" } }) }}
        text=""
      />,
    );
    expect(mine).toContain(esc(H.offLocal));
  });

  it("has empty, loading and error states, and says when it shows only the newest", () => {
    const empty = html(
      <HistoryView of={{ state: "ready", data: list({ turns: [], total: 0 }) }} text="" />,
    );
    expect(empty).toContain(esc(H.empty));
    expect(empty).toContain(esc(H.what));
    expect(html(<HistoryView of={{ state: "loading" }} text="" />)).toContain('aria-busy="true"');
    const err = html(<HistoryView of={{ state: "error", error: "The server stopped." }} text="" />);
    expect(err).toContain("The server stopped.");
    const more = html(<HistoryView of={{ state: "ready", data: list({ total: 900 }) }} text="" />);
    expect(more).toContain(esc(H.newest(4, 900)));
  });
});
