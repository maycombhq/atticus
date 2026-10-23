import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Api } from "@maycombhq/core";
import {
  api,
  ApiError,
  isOffline,
  parseBody,
  SERVER_EVENT,
  serverAnswered,
  unreachable,
} from "../src/api/client.js";
import { ServerDown } from "../src/app/App.js";
import { FlowCanvas } from "../src/app/flow.js";
import { CheckAgain, ExternalLink, LoadError, View } from "../src/app/ui.js";
import { COPY } from "../src/copy.js";
import { FindingActions, type Finding } from "../src/screens/Changes.js";
import { ChangeWaiting, Note as KnowNote } from "../src/screens/know/common.js";
import { ItemList } from "../src/screens/knowledge/Items.js";
import { PartiesPage } from "../src/screens/knowledge/Parties.js";
import { WikiSearch } from "../src/screens/knowledge/Search.js";
import { Links } from "../src/screens/knowledge/shared.js";
import { evidenceOutcome } from "../src/screens/run/ReleaseViews.js";
import { forceHint, Note as RunNote } from "../src/screens/run/shared.js";
import { NoChangeYet } from "../src/screens/work/RunNext.js";
import { StagePage } from "../src/screens/work/Stage.js";

/**
 * The audit of every screen: no click leaves a person unsure. A load that fails says why and
 * offers Try again; a stopped server is named in words; an action says it started; a disabled
 * button says why; a link that leaves the app opens beside it; the empty states say what to do.
 */

const A = COPY.app;
const html = (el: ReactElement) => renderToStaticMarkup(el);
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");

describe("a stopped server, in words", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("names the server and how to start it again, never 'Failed to fetch'", async () => {
    vi.stubGlobal("document", { querySelector: () => null });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
    );
    const e = await api("/api/changes").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).message).toBe(A.offline);
    expect(A.offline).toContain("atticus ui");
    expect(unreachable().detail).toBe(A.offline);
    expect(unreachable(true).detail).toBe(A.offlinePanel);
  });

  it("tells the app once when the server stops answering, and once when it is back", () => {
    serverAnswered(true); // from whatever an earlier test left
    const page = new EventTarget();
    vi.stubGlobal("dispatchEvent", page.dispatchEvent.bind(page));
    const seen: boolean[] = [];
    page.addEventListener(SERVER_EVENT, (e) =>
      seen.push((e as CustomEvent<{ up: boolean }>).detail.up),
    );
    serverAnswered(true);
    serverAnswered(false);
    serverAnswered(false);
    serverAnswered(true);
    serverAnswered(true);
    expect(seen).toEqual([false, true]);
  });

  it("shows one note with the fix at the top, in a browser and in a VS Code panel", () => {
    expect(html(<ServerDown inPanel={false} />)).toContain(esc(A.offline));
    const panel = html(<ServerDown inPanel={true} />);
    expect(panel).toContain(esc(A.offlinePanel));
    expect(panel).toContain('role="alert"');
    expect(panel).toContain(A.tryAgain);
    expect(isOffline(A.offline) && isOffline(A.offlinePanel) && !isOffline("boom")).toBe(true);
  });

  it("says a reply that isn't JSON isn't Atticus's, with its status", () => {
    expect(parseBody("", 200)).toBeUndefined();
    expect(parseBody('{"a":1}', 200)).toEqual({ a: 1 });
    expect(() => parseBody("<html>Bad gateway</html>", 502)).toThrow(A.notJson(502));
  });
});

describe("a load that fails", () => {
  it("says why and offers Try again when the call can run again", () => {
    const out = html(
      <View of={{ state: "error", error: "boom", reload: () => undefined }}>{() => null}</View>,
    );
    expect(out).toContain('role="alert"');
    expect(out).toContain(esc(A.cantLoad("boom")));
    expect(out).toContain(A.tryAgain);
  });

  it("has no Try again when there is nothing to run again", () => {
    expect(html(<LoadError error="boom" />)).not.toContain(A.tryAgain);
  });

  it("an empty state can carry a link and a command, not only words", () => {
    const out = html(
      <View
        of={{ state: "ready", data: [] }}
        empty={(d) => d.length === 0}
        emptyContent={<a href="#/wikis">go</a>}
      >
        {() => null}
      </View>,
    );
    expect(out).toContain('href="#/wikis"');
  });
});

describe("a screen that works on a change, before it has one", () => {
  it("shows it is loading the changes", () => {
    const out = html(<ChangeWaiting list={{ state: "loading" }} title="Task board" />);
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain("Task board");
  });

  it("says why the changes didn't load, with Try again, instead of waiting forever", () => {
    const out = html(
      <ChangeWaiting
        list={{ state: "error", error: A.offline, reload: () => undefined }}
        title="Test trace"
      />,
    );
    expect(out).toContain('role="alert"');
    // The page-wide note says how to fix a stopped server; the panel only says it is down.
    expect(out).toContain(esc(A.cantLoad(A.offlineShort)));
    expect(out).toContain(A.tryAgain);
  });
});

describe("an action says it started", () => {
  it("shows Working on it while it runs, busy and in a neutral colour", () => {
    const n = { ok: true, text: A.working, working: true };
    const run = html(<RunNote note={n} />);
    expect(run).toContain('role="status"');
    expect(run).toContain('aria-busy="true"');
    expect(run).toContain("run-note working");
    expect(html(<KnowNote note={n} />)).toContain('aria-busy="true"');
  });

  it("a finished action is not busy", () => {
    expect(html(<RunNote note={{ ok: true, text: "Done." }} />)).not.toContain("aria-busy");
  });
});

describe("Check again says what it did", () => {
  it("is a button with its label, and a status line for the time it answered", () => {
    const out = html(
      <CheckAgain of={{ reload: () => undefined, refreshing: false }} label="Check again" />,
    );
    expect(out).toContain(">Check again</button>");
    expect(out).toContain('role="status"');
  });

  it("says Checking while the call runs, and can't be pressed twice", () => {
    const out = html(
      <CheckAgain of={{ reload: () => undefined, refreshing: true }} label="Check again" />,
    );
    expect(out).toContain(A.checking);
    expect(out).toContain("disabled");
  });
});

describe("a disabled button says why", () => {
  const f: Finding = {
    id: "gap-1",
    gate: "plan",
    severity: "gap",
    lens: "architecture",
    artifact: "interfaces.md",
    message: "x",
    why: "y",
    waivable: false,
  } as unknown as Finding;

  it("Not relevant and Waive name the reason they need, and a rule that can't be waived", () => {
    const out = html(<FindingActions change="add-transfer-limit" f={f} done={() => undefined} />);
    expect(out).toContain('aria-describedby="why-gap-1"');
    expect(out).toContain(esc(COPY.findings.needsReason));
    expect(out).toContain(esc(COPY.findings.cantWaive));
  });

  it("the wiki search button is never a silent disabled button", () => {
    const out = html(<WikiSearch hash="#/wiki-search" />);
    expect(out).toMatch(/<button type="submit" class="btn primary">Search<\/button>/);
  });
});

describe("links that leave the app", () => {
  it("open beside the app and say so to a screen reader", () => {
    const out = html(<ExternalLink href="https://git.example.com/pr/7">PR #7</ExternalLink>);
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noreferrer noopener"');
    expect(out).toContain(A.newTab);
  });

  it("a knowledge item's links use them", () => {
    const out = html(
      <Links urls={[{ url: "https://servicedesk.example.com/kafka", label: "Form" }]} />,
    );
    expect(out).toContain('target="_blank"');
    expect(out).toContain(A.newTab);
  });
});

describe("the CLI's --force, in the app's words", () => {
  it("replaces the advice with what to do here", () => {
    const t =
      "add-transfer-limit already has planning files a person wrote: snow.md. Re-run with --force to replace them.";
    expect(forceHint(t, A.forceSnow)).toBe(
      `add-transfer-limit already has planning files a person wrote: snow.md. ${A.forceSnow}`,
    );
    expect(forceHint("Nothing to replace.", A.forceSnow)).toBe("Nothing to replace.");
    expect(A.forceStories("add-transfer-limit")).toContain(
      "atticus plan stories add-transfer-limit --force",
    );
  });
});

describe("the evidence pack in a VS Code panel (ADR 0097)", () => {
  const pack = { markdown: "# Evidence", files: [1, 2] };
  it("is saved as a file in a browser", () => {
    expect(evidenceOutcome("add-transfer-limit", pack, false)).toEqual({
      saved: true,
      text: expect.stringContaining("Saved evidence-add-transfer-limit.md") as unknown as string,
    });
  });

  it("is shown to copy in a panel, which can save no file, with the command that writes it", () => {
    const r = evidenceOutcome("add-transfer-limit", pack, true);
    expect(r.saved).toBe(false);
    expect(r.text).toContain("atticus release evidence add-transfer-limit --out <folder>");
  });
});

describe("knowledge empty states say what to do next", () => {
  const none: Api.KnowledgeItemListT = {
    items: [],
    problems: [],
  } as unknown as Api.KnowledgeItemListT;

  it("Knowledge items link to Knowledge sources and give the knowledge scan to copy", () => {
    const out = html(<ItemList of={{ state: "ready", data: none }} text="" kind="" />);
    expect(out).toContain(esc(COPY.knowledge.items.empty));
    expect(out).toContain('href="#/wikis"');
    expect(out).toContain("atticus knowledge scan");
    expect(out).toContain("/atticus-knowledge");
  });

  it("Teams, vendors and products show the same, in a panel", () => {
    const out = html(<PartiesPage of={{ state: "ready", data: none }} />);
    expect(out).toContain('class="panel');
    expect(out).toContain(esc(COPY.knowledge.parties.empty));
    expect(out).toContain('href="#/wikis"');
    expect(out).toContain("atticus knowledge scan");
  });
});

describe("a picture whose boxes are buttons", () => {
  it("is a labelled group, not an image (axe: no control nested in an image)", () => {
    const out = html(
      <FlowCanvas
        view={{
          type: "context",
          title: "Context view",
          groups: [],
          nodes: [
            { id: "ledger", label: "Ledger", kind: "system" },
            { id: "northwind-pay", label: "Northwind Pay", kind: "system" },
          ],
          edges: [{ id: "e1", from: "ledger", to: "northwind-pay", label: "calls", async: false }],
        }}
      />,
    );
    expect(out).toMatch(/<svg role="group" aria-label="Context view: 2 nodes/);
    expect(out).not.toMatch(/<svg role="img"/);
    expect(out).toContain('role="button"');
  });
});

describe("a page that works on a change, when there is none", () => {
  it("is a panel with the command to start one, Copy, and the way to Changes", () => {
    const out = html(
      <StagePage
        stage="stories"
        list={{ state: "ready", data: [] }}
        detail={undefined}
        tasks={undefined}
      />,
    );
    expect(out).toContain('class="panel"');
    expect(out).toContain(esc(COPY.work.noChangeYet));
    expect(out).toContain(esc(COPY.work.noChangeCommand));
    expect(out).toContain(">Copy</button>");
    expect(out).toContain('href="#/changes"');
    expect(html(<NoChangeYet />)).toContain(esc(COPY.work.noChangeCommand));
  });
});
