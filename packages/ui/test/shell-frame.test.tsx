import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { COPY } from "../src/copy.js";
import { layoutCommands, panelCommands } from "../src/app/App.js";
import { PANEL_EVENT } from "../src/app/shell/BottomPanel.js";
import { paletteItems } from "../src/app/palette.js";
import { morePagesCount } from "../src/app/nav.js";
import { screenOf } from "../src/app/screens.js";
import { ActivityBar, activeEntry } from "../src/app/shell/ActivityBar.js";
import {
  draftOf,
  typedOf,
  fieldKey,
  keptField,
  openToggles,
  putBack,
  reopen,
  type FieldLike,
} from "../src/app/shell/drafts.js";
import {
  clampSide,
  LAYOUT_KEY,
  readBottom,
  readLayout,
  readSide,
  saveBottom,
  saveLayout,
  saveSide,
  SIDE_DEFAULT,
  SIDE_MAX,
  SIDE_MIN,
  SIDE_KEY,
} from "../src/app/shell/layout.js";
import { Person } from "../src/app/chrome.js";
import { folderOf, healthFacts, StatusBar } from "../src/app/shell/StatusBar.js";
import { TabStrip, tabId } from "../src/app/shell/TabStrip.js";
import { initialTabs, openTab } from "../src/app/shell/tabs-model.js";
import { TitleBar } from "../src/app/shell/TitleBar.js";

/**
 * ADR 0194: the IDE layout's frame, rendered as markup: the activity bar, the tab strip, the
 * status bar and the title bar; the layout setting and its Ctrl+K command; what a tab keeps of
 * a page while another is shown. Invented Forge names.
 */

const T = COPY.ide;

function storage(init: Record<string, string> = {}, throws = false) {
  const saved = { ...init };
  return {
    saved,
    getItem: (k: string) => {
      if (throws) throw new Error("SecurityError");
      return saved[k] ?? null;
    },
    setItem: (k: string, v: string) => {
      if (throws) throw new Error("QuotaExceededError");
      saved[k] = v;
    },
  };
}

const bar = (hash: string, questions?: number) =>
  renderToStaticMarkup(
    <ActivityBar
      current={screenOf(hash)}
      hash={hash}
      badges={questions === undefined ? {} : { questions }}
    />,
  );

describe("the activity bar", () => {
  it("is the main navigation: the six sections by name, each opening its first page", () => {
    const html = bar("#/home");
    expect(html).toMatch(/^<nav aria-label="Main" class="sh-activity">/);
    for (const [href, name] of [
      ["#/home", "Home"],
      ["#/canvas", "Map"],
      ["#/changes", "Change"],
      ["#/questions", "Questions"],
      ["#/knowledge", "Knowledge"],
      ["#/repos", "Set up"],
    ])
      expect(html).toMatch(
        new RegExp(
          `href="${href}"[^>]*><span class="sh-tip" aria-hidden="true" data-tip="${name}"></span><svg[^>]*aria-hidden="true"`,
        ),
      );
    // Each icon is named for a screen reader, as its tooltip says.
    expect(html).toContain('<span class="sr">Set up</span>');
    // Settings at the foot.
    expect(html).toMatch(
      /href="#\/settings"[^>]*><span class="sh-tip" aria-hidden="true" data-tip="Settings">/,
    );
  });

  it("marks the section shown, and Settings on its own page", () => {
    expect(bar("#/trust")).toMatch(/href="#\/canvas" aria-current="page"/);
    expect(bar("#/stories?change=add-transfer-limit")).toMatch(
      /href="#\/changes" aria-current="page"/,
    );
    const settings = bar("#/settings");
    expect(settings).toMatch(/href="#\/settings" aria-current="page"/);
    expect(settings).not.toMatch(/href="#\/repos" aria-current/);
    expect(activeEntry(screenOf("#/runs"))).toBe("SetUp");
    expect(activeEntry(screenOf("#/evals"))).toBe("Atticus");
  });

  it("counts open questions when a page loaded them, and says so to a screen reader", () => {
    const html = bar("#/home", 36);
    expect(html).toContain('<span class="sr">Questions, 36 to answer</span>');
    expect(html).toContain('<span class="sh-badge" aria-hidden="true" data-n="36"></span>');
    expect(bar("#/home", 140)).toContain('data-n="99+"');
    // Unknown, or none: no badge.
    expect(bar("#/home")).not.toContain("sh-badge");
    expect(bar("#/home", 0)).not.toContain("sh-badge");
  });

  it("holds More pages: a closed disclosure with every page the sections' tabs don't show", () => {
    const html = bar("#/home");
    const n = morePagesCount();
    expect(html).toMatch(
      new RegExp(
        `<button type="button" class="sh-act" aria-expanded="false" aria-controls="more-pages"[^>]*>.*<span class="sr">More pages ${n}</span>`,
      ),
    );
    expect(html).toMatch(/class="sh-flyout" hidden=""/);
    expect(html).toContain('id="more-pages"');
    expect(html).toContain('href="#/estimate"');
    expect(html).toContain('href="#/evals"');
    // A page about a change keeps the change.
    expect(bar("#/stories?change=add-transfer-limit")).toContain(
      'href="#/estimate?change=add-transfer-limit"',
    );
  });
});

describe("the tab strip", () => {
  let s = initialTabs();
  s = openTab(s, "#/canvas");
  s = openTab(s, "#/changes/add-transfer-limit");
  const html = renderToStaticMarkup(
    <TabStrip
      state={s}
      onShow={() => undefined}
      onClose={() => undefined}
      onMove={() => undefined}
      side={{ open: true, onToggle: () => undefined }}
    />,
  );

  it("is a tablist of the open pages, the one shown selected and in the Tab order", () => {
    expect(html).toContain(`role="tablist" aria-label="${T.tabs}"`);
    expect(html.match(/role="tab"/g)).toHaveLength(3);
    expect(html).toMatch(
      new RegExp(
        `id="${tabId("change:add-transfer-limit")}" type="button" role="tab" class="sh-tab" aria-selected="true" aria-controls="sh-panel"[^>]*tabindex="0"`,
      ),
    );
    expect(html).toMatch(/id="sh-tab-canvas"[^>]*aria-selected="false"[^>]*tabindex="-1"/);
    expect(html).toContain(">Estate canvas<");
    expect(html).toContain('title="add-transfer-limit · All changes"');
  });

  it("closes any tab but Home, with Delete or its ×, which a screen reader is told of", () => {
    expect(html).toMatch(/id="sh-tab-home"[^>]*>(?:(?!sh-tab-x).)*?<\/button>/);
    expect(html).toMatch(
      /id="sh-tab-canvas"[^>]*aria-describedby="sh-tab-hint"[^>]*aria-keyshortcuts="Delete"/,
    );
    expect(html).toContain('class="sh-tab-x" aria-hidden="true"');
    expect(html).toContain(`<span id="sh-tab-hint" class="sr">${T.tabHint}</span>`);
  });

  it("has the side panel's button before the tabs", () => {
    expect(html).toMatch(
      new RegExp(
        `^<div class="sh-tabbar"><button type="button" class="sh-tool" aria-expanded="true" aria-controls="sh-side" aria-label="${T.sideHide}"`,
      ),
    );
  });

  it("names a tab's element safely from a change's id", () => {
    expect(tabId("change:add.limit-2")).toBe("sh-tab-change_1m_add_1a_limit-2");
    expect(tabId("canvas")).toBe("sh-tab-canvas");
  });

  it("gives two changes whose ids differ only by a dot or an underscore two tab ids", () => {
    // A change's id allows dots and underscores: mapping both to "_" made these one id.
    const ids = ["change:add.limit", "change:add_limit", "change:add-limit"].map(tabId);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(id).toMatch(/^sh-tab-[A-Za-z0-9_-]+$/);
  });
});

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../src");

describe("the status bar", () => {
  const html = renderToStaticMarkup(
    <StatusBar
      facts={{
        root: "/work/forge-metarepo",
        version: "2.0.0-beta.28",
        apiVersion: "3.10.0",
        user: "pat",
        role: "Delivery",
        repos: 12,
        questions: 36,
        running: { id: "job-1", title: "Verify", done: 5, total: 12, more: 1 },
      }}
    />,
  );

  it("says the metarepo, the counts, what runs, the API, who you are and the version", () => {
    expect(html).toMatch(/^<footer class="sh-status" aria-label="Status">/);
    expect(html).toContain(">forge-metarepo<");
    expect(html).toContain('href="#/trust">12 repos<');
    expect(html).toContain('href="#/questions">36 questions to answer<');
    expect(html).toMatch(/<button type="button" class="sh-status-item">.*Verify running 5\/12 \+1/);
    expect(html).toContain(">local API 3.10.0<");
    expect(html).toContain(">pat · Delivery<");
    expect(html).toContain(">v2.0.0-beta.28<");
  });

  it("leaves out what isn't known yet, rather than asking for it", () => {
    const bare = renderToStaticMarkup(<StatusBar facts={{ user: "pat" }} />);
    expect(bare).not.toContain("repos");
    expect(bare).not.toContain("questions");
    expect(bare).not.toContain("running");
    expect(bare).toContain(">pat<");
  });

  it("reads the version from /api/health, as the classic bar does: never a version of its own", () => {
    // The server's health answers with the CLI's VERSION (atticus --version); before the merge
    // of beta.25 the bar read beta.24 because the build did. Both layouts show the same field.
    const health = {
      version: "2.0.0-beta.25",
      apiVersion: "3.11.0",
      root: "/work/forge-metarepo",
      user: "pat",
    };
    const f = healthFacts(health, { user: "pat" });
    expect(f).toEqual({
      root: "/work/forge-metarepo",
      version: "2.0.0-beta.25",
      apiVersion: "3.11.0",
      user: "pat",
    });
    expect(renderToStaticMarkup(<StatusBar facts={f} />)).toContain(">v2.0.0-beta.25<");
    expect(renderToStaticMarkup(<Person health={health} />)).toContain(" · v2.0.0-beta.25");
    // Nothing in the app's source spells a version out.
    for (const file of readdirSync(SRC, { recursive: true, encoding: "utf8" })) {
      if (!/\.(ts|tsx)$/.test(file)) continue;
      expect(readFileSync(join(SRC, file), "utf8"), file).not.toMatch(/["'`]v?\d+\.\d+\.\d+-beta/);
    }
  });

  it("names a metarepo by its folder, on Windows too", () => {
    expect(folderOf("C:\\work\\forge\\")).toBe("forge");
    expect(folderOf("/work/forge")).toBe("forge");
  });
});

describe("the title bar", () => {
  it("has the logo, the metarepo and a box that opens Ctrl+K", () => {
    const html = renderToStaticMarkup(<TitleBar root="/work/forge" />);
    expect(html).toMatch(/^<header class="sh-title">/);
    expect(html).toContain("forge · metarepo");
    expect(html).toMatch(
      new RegExp(`<button type="button" class="sh-search" aria-keyshortcuts="Control\\+K">`),
    );
    expect(html).toContain(`<span class="sh-search-text">${T.search}</span>`);
  });
});

describe("the layout, chosen per browser", () => {
  it("is the IDE layout until the classic one is chosen; storage that refuses is the default", () => {
    expect(readLayout(storage())).toBe("ide");
    expect(readLayout(storage({ [LAYOUT_KEY]: "sideways" }))).toBe("ide");
    expect(readLayout(storage({}, true))).toBe("ide");
    expect(readLayout(undefined)).toBe("ide");
    const st = storage();
    saveLayout("classic", st);
    expect(st.saved[LAYOUT_KEY]).toBe("classic");
    expect(readLayout(st)).toBe("classic");
    expect(() => saveLayout("ide", storage({}, true))).not.toThrow();
  });

  it("offers the other layout in Ctrl+K once something names it, never on an empty box", () => {
    const picked: string[] = [];
    const ide = layoutCommands("ide", (l) => picked.push(l));
    const items = paletteItems("classic", [], [], ide);
    expect(items[0]).toMatchObject({ kind: "command", label: T.layout.toClassic });
    items[0]!.run!();
    expect(picked).toEqual(["classic"]);
    expect(paletteItems("layout", [], [], ide)[0]!.label).toBe(T.layout.toClassic);
    expect(paletteItems("", [], [], ide).some((i) => i.kind === "command")).toBe(false);
    const classic = layoutCommands("classic", (l) => picked.push(l));
    expect(paletteItems("ide", [], [], classic)[0]!.label).toBe(T.layout.toIde);
  });

  it("runs the bottom panel's tabs from Ctrl+K, each only showing its tab", () => {
    const C = T.panelCommands;
    const cmds = panelCommands();
    expect(cmds.map((c) => c.label)).toEqual([C.console, C.questions, C.problems, C.runs]);
    expect(paletteItems("console", [], [], cmds)[0]).toMatchObject({
      kind: "command",
      label: C.console,
    });
    expect(paletteItems("failed", [], [], cmds)[0]!.label).toBe(C.problems);
    expect(paletteItems("", [], [], cmds).some((i) => i.kind === "command")).toBe(false);
    const told: unknown[] = [];
    const was = globalThis.dispatchEvent;
    globalThis.dispatchEvent = (e: Event) => {
      told.push([e.type, (e as CustomEvent).detail]);
      return true;
    };
    try {
      cmds[2]!.run();
    } finally {
      globalThis.dispatchEvent = was;
    }
    expect(told).toEqual([[PANEL_EVENT, "problems"]]);
  });

  it("keeps the side panel's width within bounds, and whether it is hidden", () => {
    expect(readSide(storage())).toEqual({ width: SIDE_DEFAULT, hidden: false });
    expect(readSide(storage({ [SIDE_KEY]: "{bad" }))).toEqual({
      width: SIDE_DEFAULT,
      hidden: false,
    });
    const st = storage();
    saveSide({ width: 9999, hidden: true }, st);
    expect(readSide(st)).toEqual({ width: SIDE_MAX, hidden: true });
    expect(clampSide(10)).toBe(SIDE_MIN);
    expect(clampSide(Number.NaN)).toBe(SIDE_DEFAULT);
    expect(readBottom(storage())).toBeUndefined();
    saveBottom(true, st);
    expect(readBottom(st)).toBe(true);
    expect(() => saveSide({ width: 300, hidden: false }, storage({}, true))).not.toThrow();
  });
});

describe("what a tab keeps of a page while another is shown", () => {
  const f = (o: Partial<FieldLike> & { tagName: string }): FieldLike => ({ value: "", ...o });
  const brief = f({ tagName: "TEXTAREA", id: "brief-text", value: "Limit transfers to 5,000" });
  const repo = f({ tagName: "SELECT", name: "repo", value: "forge-ledger" });
  const plain = f({ tagName: "INPUT", type: "text", value: "holds" });
  const secret = f({ tagName: "INPUT", type: "password", id: "token", value: "x" });
  const box = f({ tagName: "INPUT", type: "checkbox", id: "all", value: "on" });
  const fields = [brief, repo, plain, secret, box];

  it("keeps text boxes, text areas and pickers, never a password or a checkbox", () => {
    expect([brief, repo, plain].every(keptField)).toBe(true);
    expect(keptField(secret)).toBe(false);
    expect(keptField(box)).toBe(false);
    expect(fieldKey(brief, fields)).toBe("#brief-text");
    expect(fieldKey(repo, fields)).toBe("@repo");
    expect(fieldKey(plain, fields)).toBe("input:0");
    // A field named by useId keeps its name when the page comes back with new ids.
    const a = f({ tagName: "INPUT", type: "search", id: "_r_9_-f" });
    const b = f({ tagName: "INPUT", type: "search", id: "_r_k_-f" });
    expect(fieldKey(b, [a, b])).toBe("#~-f#1");
  });

  it("keeps only what the person changed, and the scroll", () => {
    const d = draftOf(fields, new Set(["#brief-text", "input:0", "#token"]), 420)!;
    expect(d).toEqual({
      fields: { "#brief-text": "Limit transfers to 5,000", "input:0": "holds" },
      scroll: 420,
    });
    expect(draftOf(fields, new Set(), 0)).toBeUndefined();
  });

  it("keeps a draft put back when the tab is left again without typing (two round trips)", () => {
    const d = draftOf(fields, new Set(["#brief-text"]), 0)!;
    // Back on the page: the field holds the draft's text, and nothing was typed since.
    expect(draftOf(fields, typedOf(d), 0)).toEqual(d);
  });

  it("opens again the disclosures that were open, by what they control, once each", () => {
    const toggle = (controls: string | null, expanded: boolean) => {
      const b = {
        clicks: 0,
        getAttribute: (n: string) =>
          n === "aria-controls" ? controls : n === "aria-expanded" ? String(expanded) : null,
        click: () => {
          b.clicks++;
          expanded = !expanded;
        },
      };
      return b;
    };
    // React's ids (useId) are counted afresh on each mount: they are no part of the name.
    const tools = toggle("_r_1a_-body", true);
    const editor = toggle("brief-editor", false);
    const nameless = toggle(null, true);
    expect(openToggles([tools, editor, nameless])).toEqual(["~-body#0"]);
    expect(draftOf([], new Set(), 0, ["~-body#0"])).toEqual({
      fields: {},
      scroll: 0,
      open: ["~-body#0"],
    });
    // Back on the page, the tools are closed (and named anew): they open, once.
    const again = toggle("_r_2f_-body", false);
    const left = reopen(new Set(["~-body#0", "later"]), [again, editor]);
    expect(again.clicks).toBe(1);
    expect(editor.clicks).toBe(0);
    expect([...left]).toEqual(["later"]);
    expect(reopen(new Set(["~-body#0"]), [again]).size).toBe(0);
    expect(again.clicks).toBe(1);
    expect(openToggles([toggle("«r3»-x", true), toggle(":r4:-x", true)])).toEqual([
      "~-x#0",
      "~-x#1",
    ]);
  });

  it("opens again a disclosure that names its panel only while open (data-controls), beta.26", () => {
    // The map's Tools: aria-controls only while the drawer is drawn; data-controls always.
    let expanded = false;
    let clicks = 0;
    const closed = {
      getAttribute: (n: string) =>
        n === "data-controls" ? "_r_9_-body" : n === "aria-expanded" ? String(expanded) : null,
      click: () => {
        clicks++;
        expanded = !expanded;
      },
    };
    expect(reopen(new Set(["~-body#0"]), [closed]).size).toBe(0);
    expect(clicks).toBe(1);
  });

  it("puts it back as the page's fields come in, as typing would", () => {
    const d = {
      fields: { "#brief-text": "Limit transfers to 5,000", "input:0": "holds" },
      scroll: 0,
    };
    const set: string[] = [];
    const typed = (el: FieldLike, v: string) => {
      set.push(`${el.id ?? el.tagName}=${v}`);
      el.value = v;
    };
    // The page is still loading: only the brief is there.
    const fresh = f({ tagName: "TEXTAREA", id: "brief-text" });
    const left = putBack(d, [fresh], typed);
    expect([...left]).toEqual(["input:0"]);
    // Then the search box comes.
    const search = f({ tagName: "INPUT", type: "search" });
    expect(putBack(d, [fresh, search], typed, left).size).toBe(0);
    expect(set).toEqual(["brief-text=Limit transfers to 5,000", "INPUT=holds"]);
  });
});
