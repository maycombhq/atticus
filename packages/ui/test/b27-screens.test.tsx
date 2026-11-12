import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { COPY } from "../src/copy.js";
import { availableHeightIn, CANVAS_MAX_TOP, DiagramFrame, MAX_TOP } from "../src/app/viewer.js";
import {
  boundsOf,
  boxesOutside,
  canvasFit,
  canvasFitAll,
  contentRects,
  ANNOUNCE_AFTER_MS,
  boxFocused,
  FIT_MIN_ZOOM,
  keyboardFocus,
  releasePointerOn,
} from "../src/screens/architecture/Canvas.js";
import { WORDS } from "../src/screens/architecture/words.js";
import { stageMark } from "../src/screens/work/Cockpit.js";
import { ReplacePersonFiles, StageThreadView } from "../src/screens/work/StageThread.js";
import { RaiseHandoff } from "../src/screens/know/Phase.js";
import { TrustRow } from "../src/screens/map/Trust.js";
import {
  askedKind,
  localDay,
  openingKind,
  OwnerQuestionCard,
  ownerWords,
} from "../src/screens/OwnerQuestions.js";
import { moreMenuKey, tabsOutOfView } from "../src/app/shell/TabStrip.js";
import { manifestEmpty } from "../src/app/shell/Explorer.js";
import { UpgradeOfferView } from "../src/app/upgrade.js";
import { onboardingStep } from "../src/screens/work/next.js";
import { noChangeBody, noChangeTitle } from "../src/screens/work/RunNext.js";
import { byStage, homeStatus, waitingWords } from "../src/screens/CommandCenter.js";
import { phaseWord } from "../src/screens/home/HomePanels.js";
import { BrokenChangesView } from "../src/screens/work/BrokenChanges.js";
import { problemsOf } from "../src/app/shell/BottomPanel.js";
import { estateLabels, pageLabel, pinnedItems } from "../src/app/shell/explorer-model.js";
import { isStopping, stateWords } from "../src/app/activity.js";
import { nextCell } from "../src/screens/Across.js";
import { nextStepWords, sentenceInAppWords } from "../src/app/app-words.js";

/**
 * Beta.27 review of the screens, over invented Forge names: the stage state a person's planning
 * files make, one next step, the map's canvas (its height, Fit, the boxes out of view, the empty
 * details at 420 px, a box's focus ring), Trust's counts, a broken change, Questions' opening
 * kind, a refused scan, the upgrade panel, onboarding's first step, the tab strip, owner
 * questions, Home's words, and the words of a pinned page and of what is to propose.
 */

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
const css = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");
const C = COPY.cockpit;
const ready = <T,>(data: T) => ({ state: "ready" as const, data, reload: () => undefined });

describe("1: planning files a person wrote", () => {
  it("At a glance marks the stage written by a person, and the stages the change passed skipped", () => {
    const s = (state: string) =>
      ({ stage: "stories", state, drafts: 0, rounds: 0, openQuestions: 0 }) as const;
    expect(stageMark(s("person"))).toBe("person");
    expect(stageMark(s("skipped"))).toBe("skipped");
    expect(stageMark(s("not-started"))).toBe("todo");
    expect(C.stage(C.stages.stories!, C.marks.person!)).toBe("Stories: written by a person");
    expect(C.stage(C.stages.feature!, C.marks.skipped!)).toBe("Placement: skipped");
  });

  it("the Stories page says so, offers going on from them, and drafting again in place of Start", () => {
    const v: Api.StageThreadViewT = {
      change: "add-transfer-limit",
      stage: "stories",
      state: "done",
      headline:
        "A person wrote stories.md and tasks.md outside the app, so the stories stage never ran and this conversation has nothing in it.",
      items: [],
      step: ["plan", "stories", "add-transfer-limit"],
      byPerson: ["stories.md", "tasks.md"],
      reply: { open: true },
      problems: [],
    };
    const out = renderToStaticMarkup(<StageThreadView of={ready(v)} stage="stories" />);
    expect(out).toContain(esc(v.headline));
    expect(out).toContain('href="#/cockpit?change=add-transfer-limit"');
    expect(out).toContain(esc(COPY.thread.byPersonGoOn));
    // Review of the fix: the button names the files it replaces, and asks once first.
    expect(out).toContain(esc("Draft the stories again, replacing stories.md and tasks.md…"));
    expect(out).not.toContain(esc(COPY.appStep.storiesAgain) + "<");
    expect(out).not.toContain(`>${esc(COPY.thread.start)}<`);
    const asked = renderToStaticMarkup(
      <ReplacePersonFiles files={v.byPerson!} args={[...v.step, "--force"]} asking />,
    );
    expect(asked).toContain(
      esc(
        "This replaces stories.md and tasks.md, which a person wrote. A copy of each is kept first in the change's stage/stories-by-person/ folder",
      ),
    );
    expect(asked).toContain(`>${esc(COPY.appStep.storiesAgain)}<`);
    expect(asked).toContain(`>${esc(COPY.thread.byPersonKeep)}<`);
    expect(asked).toMatch(/role="group" aria-labelledby="[^"]+"/);
  });
});

describe("4: one next step", () => {
  it("Raise hand-off is held while another step comes first, with At a glance's sentence", () => {
    const first = 'Not ready to raise "Plan ready" yet: the step below comes first.';
    const out = renderToStaticMarkup(
      <RaiseHandoff change="add-transfer-limit" blockers={0} first={first} />,
    );
    expect(out).toMatch(/<button[^>]*disabled=""/);
    expect(out).toContain(esc(first));
    const free = renderToStaticMarkup(<RaiseHandoff change="add-transfer-limit" blockers={0} />);
    expect(free).not.toMatch(/<button[^>]*disabled=""/);
  });

  it("away from At a glance, says the step's own words and links to At a glance", () => {
    const said =
      'Not ready to raise "Plan ready" yet: first, 1 question is waiting for a person (see Questions).';
    const row = { change: "add-transfer-limit", changeTitle: "", changeState: "plan" };
    const held = renderToStaticMarkup(<>{nextCell({ ...row, nextStep: said, stepFirst: true })}</>);
    expect(held).toContain(esc(said));
    expect(held).not.toContain("the step below");
    expect(held).toContain('href="#/cockpit?change=add-transfer-limit"');
    expect(held).toContain(COPY.changes.seeGlance);
    const free = renderToStaticMarkup(
      <>{nextCell({ ...row, nextStep: 'Ready to raise "Plan ready".' })}</>,
    );
    expect(free).not.toContain("#/cockpit");
    // The held Raise hand-off on All changes says why in words it points at, not a title.
    const src = readFileSync(new URL("../src/screens/Changes.tsx", import.meta.url), "utf8");
    expect(src).toMatch(/<p id=\{heldId\} className="cw-held">/);
    expect(src).toMatch(
      /aria-describedby=\{\s*s\.blockers\.length > 0 \|\| s\.stepFirst \? heldId/,
    );
    expect(src).not.toMatch(/title=\{\s*s\.blockers\.length > 0/);
  });

  it("says the step that comes first in the app's words on every page but At a glance (review of the fix)", () => {
    const row = { change: "add-transfer-limit", changeTitle: "", changeState: "plan" };
    const said = [
      'Not ready to raise "Plan ready" yet: first, add-transfer-limit adds a new flow, and its starting spec adds it too.',
      "Then run the change's stories stage again (atticus plan stories add-transfer-limit) so it modifies the seeded requirement (ADR 0156).",
      "Raise each need, then record it with atticus needs done add-transfer-limit <item>.",
      "Or run `atticus plan stories add-transfer-limit` again.",
    ].join(" ");
    // Final round: the server's app-words form (nextStepApp, built from the help catalog's
    // commands) is what the page says.
    const app =
      'Not ready to raise "Plan ready" yet: first, add-transfer-limit adds a new flow, and its starting spec adds it too. Then run the change\'s stories stage again so it modifies the seeded requirement. Raise each need, then record it.';
    const held = renderToStaticMarkup(
      <>{nextCell({ ...row, nextStep: said, stepFirst: true, nextStepApp: app })}</>,
    );
    expect(held).toContain("then record it.");
    expect(held).not.toMatch(/atticus [a-z]/);
    // With no app-words form, the page takes out only what is plainly a command (in brackets)
    // and the ADRs: it never cuts prose it can't tell from a command.
    const fallback = renderToStaticMarkup(
      <>{nextCell({ ...row, nextStep: said, stepFirst: true })}</>,
    );
    expect(fallback).not.toMatch(/\(ADR \d{4}\)/);
    expect(fallback).not.toContain("(atticus plan stories");
    expect(fallback).toContain("so it modifies the seeded requirement.");
    expect(sentenceInAppWords("Atticus checks it (ADR 0101).")).toBe("Atticus checks it.");
    for (const prose of [
      "Fill the gap with atticus questions owner q.x --text 'y', then rerun.",
      "approval comes from atticus approve design or the Gate, then build",
      "Ask the owner what atticus knows about it.",
      "Atticus checks `org-pack/runtime.yaml` and `atticus knows`.",
    ])
      expect(sentenceInAppWords(prose)).toBe(prose);
    expect(
      sentenceInAppWords(
        "Task 1.2 of add-transfer-limit is the first one not done. /atticus-task gives your assistant its context (atticus task context add-transfer-limit 1.2): the story, the criteria.",
      ),
    ).toBe(
      "Task 1.2 of add-transfer-limit is the first one not done. /atticus-task gives your assistant its context: the story, the criteria.",
    );
    // When nothing comes first, the sentence is as the server said it.
    expect(nextStepWords('Ready to raise "Plan ready".')).toBe('Ready to raise "Plan ready".');
    expect(nextStepWords(said, true, app)).toBe(app);
    // Changes, the brief's Gate (and its held Raise hand-off), Across and Release say it so.
    for (const [file, re] of [
      ["../src/screens/Changes.tsx", /nextStepWords\(s\.nextStep, s\.stepFirst, s\.nextStepApp\)/],
      [
        "../src/screens/know/Phase.tsx",
        /nextStepWords\(s\.nextStep, s\.stepFirst, s\.nextStepApp\)/,
      ],
      [
        "../src/screens/know/Phase.tsx",
        /first: nextStepWords\(s\.nextStep, true, s\.nextStepApp\)/,
      ],
      [
        "../src/screens/run/Release.tsx",
        /nextStepWords\(r\.status\.nextStep, r\.status\.stepFirst, r\.status\.nextStepApp\)/,
      ],
    ] as const)
      expect(readFileSync(new URL(file, import.meta.url), "utf8")).toMatch(re);
  });
});

describe("5 and 6: the map's canvas", () => {
  it("counts a notice above the picture, so its foot stays above the bottom panel", () => {
    // The IDE page from 76 to 843 px; the picture starts at 314 under the >~60 boxes notice.
    const view = { top: 76, bottom: 843 };
    const before = availableHeightIn(view, 314, 420, MAX_TOP);
    const now = availableHeightIn(view, 314, 320, CANVAS_MAX_TOP);
    expect(314 + before).toBeGreaterThan(843);
    expect(314 + now).toBeLessThanOrEqual(843);
  });

  it("opens legibly, while Fit fits every box however small", () => {
    const content = { x: 0, y: 0, w: 4000, h: 3000 };
    const view = { width: 1000, height: 600 };
    expect(canvasFit(content, view).k).toBe(FIT_MIN_ZOOM);
    const all = canvasFitAll(content, view);
    expect(all.k).toBeLessThan(FIT_MIN_ZOOM);
    expect(boxesOutside([{ x: 3900, y: 2900, width: 100, height: 100 }], all, view)).toBe(0);
  });

  it("opens a picture too big for the view on its first box, not its bounds' empty corner", () => {
    const content = { x: 0, y: 0, w: 4000, h: 3000 };
    const view = { width: 1000, height: 600 };
    const rects = [
      { x: 0, y: 0, width: 4000, height: 3000, group: true },
      { x: 2000, y: 100, width: 100, height: 50 },
      { x: 1500, y: 900, width: 100, height: 50 },
    ];
    const corner = canvasFit(content, view);
    expect(boxesOutside(rects, corner, view)).toBe(2);
    const v = canvasFit(content, view, rects);
    expect(v.k).toBe(FIT_MIN_ZOOM);
    expect(boxesOutside(rects.slice(1, 2), v, view)).toBe(0);
    // The first box in the middle across.
    expect(v.x + (2000 + 50) * v.k).toBeCloseTo(view.width / 2);
  });

  it("places a box inside a group where it is, and says how many boxes the view leaves out", () => {
    const box = (id: string, x: number, y: number, parentId?: string, group = false) => ({
      id,
      position: { x, y },
      width: 100,
      height: 50,
      ...(parentId ? { parentId } : {}),
      data: { box: { group } },
    });
    const rects = contentRects([
      box("system:portal", 100, 100, undefined, true),
      box("repo:forge-portal-bff", 20, 30, "system:portal"),
      box("system:ledger", 2000, 0),
    ] as never);
    expect(rects[1]).toMatchObject({ x: 120, y: 130, group: false });
    expect(boundsOf(rects)).toEqual({ x: 100, y: 0, w: 2000, h: 180 });
    // The view shows 0..1000 across: the ledger box is out of it; a group isn't counted.
    expect(boxesOutside(rects, { x: 0, y: 0, k: 1 }, { width: 1000, height: 600 })).toBe(1);
    expect(WORDS.outside(1, 2)).toBe("1 of 2 boxes is outside the view");
    expect(WORDS.fitAll).toBe("Fit to see all");
  });
});

describe("7: the empty details in a narrow frame", () => {
  const was = globalThis.window;
  afterEach(() => {
    (globalThis as { window?: unknown }).window = was;
  });
  const frame = () =>
    renderToStaticMarkup(
      <DiagramFrame
        title="Estate canvas"
        full={false}
        height={500}
        toolbar={null}
        aside={<p>Pick a box to see its details.</p>}
        asideBeside
        asideIdle
        onKeyAction={() => undefined}
      >
        <div />
      </DiagramFrame>,
    );
  it("start closed when nothing is picked at 420 px, and open beside a wide picture", () => {
    (globalThis as { window?: unknown }).window = {
      innerWidth: 420,
      matchMedia: (q: string) => ({ matches: /max-width: 1000px/.test(q) }),
    };
    expect(frame()).toMatch(/<aside[^>]*hidden=""/);
    (globalThis as { window?: unknown }).window = {
      innerWidth: 1440,
      matchMedia: () => ({ matches: false }),
    };
    expect(frame()).not.toMatch(/<aside[^>]*hidden=""/);
  });
});

describe("8: a box reached by the keyboard shows its focus", () => {
  it("puts a ring back on a focused node, which React Flow takes off", () => {
    const hud = css("../src/styles/hud.css");
    const at = hud.indexOf(".arch-canvas .react-flow .react-flow__node:focus-visible");
    expect(at).toBeGreaterThan(0);
    const rule = hud.slice(at, hud.indexOf("}", at));
    expect(rule).toMatch(/outline: 3px dashed var\(--accent\)/);
    // Review of the fix: a picked box looks otherwise: a solid ring inside its border, no outline.
    const p = hud.indexOf(".arch-box.picked {");
    const picked = hud.slice(p, hud.indexOf("}", p));
    expect(picked).toMatch(/box-shadow: inset 0 0 0 3px var\(--accent-soft\)/);
    expect(picked).not.toMatch(/outline/);
  });

  it("puts React Flow's scrolled wrapper back and pans to a box Tab reached out of view", () => {
    const el = (o: Record<string, unknown>) => o as unknown as Element;
    const wrapper = { scrollTop: 140, scrollLeft: 30, parentElement: null as unknown };
    const view = { left: 0, top: 0, right: 600, bottom: 400 };
    const stageEl = el({
      contains: () => true,
      getBoundingClientRect: () => view,
      parentElement: null,
    });
    wrapper.parentElement = stageEl;
    const node = (r: { left: number; top: number; right: number; bottom: number }) =>
      el({
        closest: (s: string) => (s === ".react-flow__node" ? node(r) : null),
        parentElement: wrapper,
        getBoundingClientRect: () => r,
        getAttribute: (a: string) => (a === "data-id" ? "ledger-api" : null),
      });
    const centred: string[] = [];
    const keys = { keyboard: true };
    // Out of view (below): the wrapper's scroll is undone and the view pans to it.
    expect(
      boxFocused(
        node({ left: 10, top: 500, right: 120, bottom: 540 }),
        stageEl,
        (id) => centred.push(id),
        keys,
      ),
    ).toBe(true);
    expect([wrapper.scrollTop, wrapper.scrollLeft]).toEqual([0, 0]);
    expect(centred).toEqual(["ledger-api"]);
    // Review of the fix: a click's focus (no keyboard) puts the scroll back and never pans.
    wrapper.scrollTop = 90;
    expect(
      boxFocused(node({ left: 10, top: 500, right: 120, bottom: 540 }), stageEl, (id) =>
        centred.push(id),
      ),
    ).toBe(false);
    expect(wrapper.scrollTop).toBe(0);
    expect(centred).toEqual(["ledger-api"]);
    // In view: nothing moves.
    expect(
      boxFocused(
        node({ left: 10, top: 10, right: 120, bottom: 50 }),
        stageEl,
        (id) => centred.push(id),
        keys,
      ),
    ).toBe(false);
    expect(centred).toEqual(["ledger-api"]);
    // Not a box (a button in the tools): left alone.
    const button = el({ closest: () => null });
    expect(boxFocused(button, stageEl, () => centred.push("x"), keys)).toBe(false);
  });

  it("hears the pointer come up anywhere, so Tab into a box out of view pans after a click (final round)", () => {
    // A pointer down on the canvas, up over the toolbar (the window hears it, not the canvas).
    const win = new EventTarget();
    const down = { current: false };
    const stop = releasePointerOn(win, down);
    const el = (o: Record<string, unknown>) => o as unknown as Element;
    const stageEl = el({
      contains: () => true,
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 600, bottom: 400 }),
      parentElement: null,
    });
    const box = el({
      closest: (s: string) => (s === ".react-flow__node" ? box : null),
      parentElement: stageEl,
      getBoundingClientRect: () => ({ left: 10, top: 500, right: 120, bottom: 540 }),
      getAttribute: (a: string) => (a === "data-id" ? "ledger-api" : null),
      matches: (s: string) => s === ":focus-visible",
    });
    const centred: string[] = [];
    const tab = () =>
      boxFocused(box, stageEl, (id) => centred.push(id), {
        keyboard: !down.current && keyboardFocus(box),
      });
    down.current = true; // pointerdown on the canvas
    expect(tab()).toBe(false);
    win.dispatchEvent(new Event("pointerup"));
    expect(down.current).toBe(false);
    expect(tab()).toBe(true);
    expect(centred).toEqual(["ledger-api"]);
    // Cancelled, or a key pressed (a captured keydown), it is up too.
    down.current = true;
    win.dispatchEvent(new Event("pointercancel"));
    expect(down.current).toBe(false);
    down.current = true;
    win.dispatchEvent(new Event("keydown"));
    expect(down.current).toBe(false);
    // Stopped listening: nothing changes it any more.
    stop();
    down.current = true;
    win.dispatchEvent(new Event("pointerup"));
    expect(down.current).toBe(true);
    const src = readFileSync(
      new URL("../src/screens/architecture/Canvas.tsx", import.meta.url),
      "utf8",
    );
    expect(src).toMatch(/releasePointerOn\(window, pointerDown\)/);
    expect(src).not.toMatch(/onPointerUpCapture/);
  });

  it("tells the keyboard's focus by :focus-visible, and the canvas pans only for it (review of the fix)", () => {
    const el = (m: (s: string) => boolean) => ({ matches: m }) as unknown as Element;
    expect(keyboardFocus(el((s) => s === ":focus-visible"))).toBe(true);
    expect(keyboardFocus(el(() => false))).toBe(false);
    // A browser (or jsdom) that can't parse :focus-visible: not the keyboard.
    expect(
      keyboardFocus(
        el(() => {
          throw new SyntaxError("unknown pseudo-class");
        }),
      ),
    ).toBe(false);
    expect(keyboardFocus({} as Element)).toBe(false);
    const src = readFileSync(
      new URL("../src/screens/architecture/Canvas.tsx", import.meta.url),
      "utf8",
    );
    // Never during a drag or with a pointer down, and no animated pan mid-drag.
    expect(src).toMatch(
      /keyboard: !pointerDown\.current && !dragging\.current && keyboardFocus\(t\)/,
    );
    expect(src).toMatch(/onNodeDragStart=\{\(\) => \{\s*dragging\.current = true;/);
    expect(src).toMatch(/if \(!i \|\| !n \|\| dragging\.current\) return;/);
  });

  it("announces the boxes out of view once the view settles, not at every step of a pan", () => {
    const src = readFileSync(
      new URL("../src/screens/architecture/Canvas.tsx", import.meta.url),
      "utf8",
    );
    expect(src).not.toMatch(/className="arch-outside viewer-own" role="status"/);
    expect(src).toMatch(/setTimeout\(\(\) => setAnnounced\(outside\), ANNOUNCE_AFTER_MS\)/);
    expect(src).toMatch(/<span className="sr" role="status">/);
    expect(ANNOUNCE_AFTER_MS).toBeGreaterThanOrEqual(500);
  });
});

describe("9: Trust's questions open", () => {
  it("says the count once: None, or the list's own count", () => {
    const repo = {
      repo: "forge-portal-ui",
      facts: { path: "facts/forge-portal-ui.jsonl", present: false, count: 0, unverified: 0 },
      verify: { path: "facts/forge-portal-ui.verify.yaml", report: null },
      checkout: { path: "workspace/forge-portal-ui", present: false },
      sameCommit: null,
      catalog: { from: "readers", fromFacts: 0, fromReaders: 0 },
      state: "not-read",
      lists: { rejected: [], excluded: [], asked: [], unverified: [] },
    } as unknown as Api.TrustRepoT;
    const none = renderToStaticMarkup(<TrustRow r={repo} />);
    expect(none).not.toContain(`0${esc(COPY.trust.none)}`);
    const three = renderToStaticMarkup(
      <TrustRow
        r={
          {
            ...repo,
            lists: {
              ...repo.lists!,
              asked: [1, 2, 3].map((i) => ({ id: `q-${i}`, question: `Q${i}`, lines: [] })),
            },
          } as Api.TrustRepoT
        }
      />,
    );
    expect(three).toContain(esc(COPY.trust.show(3, COPY.trust.what.asked!)));
    expect(three).not.toContain(`3${esc(COPY.trust.show(3, COPY.trust.what.asked!))}`);
  });
});

describe("12: a change whose change.yaml doesn't read", () => {
  const broken = [
    {
      id: "add-transfer-limit",
      file: "openspec/changes/add-transfer-limit/change.yaml",
      line: 3,
      message: "invalid YAML: Nested mappings are not allowed in compact mappings at line 3",
    },
  ];
  it("is listed as broken, with its file, line and why", () => {
    const out = renderToStaticMarkup(<BrokenChangesView of={ready(broken)} />);
    // Review of the fix: a labelled region, never an alert on every load, and no fixed id.
    expect(out).not.toContain('role="alert"');
    expect(out).toMatch(/<section class="cw-broken" aria-labelledby="([^"]+)"><h3 id="\1"/);
    expect(out).not.toContain("cw-broken-head");
    expect(out).toContain(esc(COPY.brokenChanges.title(1)));
    expect(out).toContain(esc(COPY.brokenChanges.fileLine(broken[0]!.file, 3)));
    expect(out).toContain(esc(broken[0]!.message));
    expect(renderToStaticMarkup(<BrokenChangesView of={ready([])} />)).toBe("");
  });
  it("is one of Problems' problems", () => {
    const p = problemsOf({ entries: [], broken });
    expect(p.broken).toEqual(broken);
  });
  it("the empty At a glance points at New change in the app", () => {
    expect(COPY.work.noChangeYet).toMatch(/New change/);
    expect("none" in C).toBe(false);
    // Review of the fix: with a broken change and none that reads, not "No change yet".
    expect(noChangeTitle(0)).toBe(COPY.work.noChangeTitle);
    expect(noChangeTitle(1)).toBe("No change reads");
    expect(noChangeTitle(1, "Pick one")).toBe("Pick one");
    // The words under the title agree with it.
    expect(noChangeBody(1)).toBe(COPY.work.noChangeReadsBody);
    expect(noChangeBody(1)).toMatch(/^No change reads/);
    expect(noChangeBody(0)).toBe(COPY.work.noChangeYet);
  });
});

describe("13: Questions opens on the kind that has questions", () => {
  it("opens the owner questions when no step's question is open, unless the address says", () => {
    expect(askedKind("#/questions")).toBeUndefined();
    expect(openingKind(undefined, 0, 3)).toBe("owner");
    expect(openingKind(undefined, 2, 3)).toBe("steps");
    expect(openingKind(undefined, undefined, 3)).toBe("steps");
    expect(openingKind(askedKind("#/questions?kind=steps"), 0, 3)).toBe("steps");
  });
});

describe("14: a scan that refused", () => {
  it("reads as refused, nothing written, never failed", () => {
    expect(stateWords({ state: "done", where: "app", outcome: "refused" })).toBe(
      COPY.activity.refused,
    );
    expect(stateWords({ state: "failed", where: "app" })).toBe(COPY.activity.states.failed);
    // Merge prep: fix/b27-plumbing's object form, its words for an app run's end and a stop.
    expect(stateWords({ state: "done" })).toBe(COPY.activity.states.done);
    expect(stateWords({ state: "ended", where: "app" })).toBe(COPY.activity.appClosedState);
    expect(stateWords({ state: "running", stopping: true })).toBe(COPY.activity.stoppingState);
    // Refused comes first, whatever else the entry says.
    expect(stateWords({ state: "running", stopping: true, outcome: "refused" })).toBe(
      COPY.activity.refused,
    );
    const e = { id: "job-1", state: "running" } as Parameters<typeof isStopping>[1];
    expect(isStopping({ stopping: "job-1" }, e)).toBe(true);
    expect(isStopping({}, { ...e, stopping: true })).toBe(true);
    expect(isStopping({}, { ...e, state: "done", stopping: true })).toBe(false);
    expect(problemsOf({ entries: [] }).failed).toEqual([]);
  });
});

describe("17: the upgrade panel", () => {
  const view = {
    pending: [{ id: "runtime-2", summary: "runtime.yaml at version 2", files: ["runtime.yaml"] }],
    atticus: "2.0.0-beta.27",
  } as unknown as Api.UpgradeViewT;
  it("reads left to right, and once done offers Propose", () => {
    const idle = renderToStaticMarkup(
      <UpgradeOfferView view={view} run={{ state: "idle" }} onRun={() => undefined} />,
    );
    expect(idle).toMatch(/text-align:start/);
    const done = renderToStaticMarkup(
      <UpgradeOfferView
        view={{ ...view, pending: [] }}
        run={{ state: "done", lines: ["Done: runtime.yaml at version 2"] }}
        onRun={() => undefined}
      />,
    );
    expect(done).toContain(esc(COPY.upgrade.done));
    expect(done).toMatch(/<button[^>]*>[^<]*(Propose|propose)/);
    // Final round: the GET from before the run (upgraded: [] there) never says "only the stamp
    // changed": the run's own result does.
    const before = renderToStaticMarkup(
      <UpgradeOfferView
        view={{ ...view, pending: [], upgraded: [] }}
        run={{ state: "done", lines: [] }}
        onRun={() => undefined}
      />,
    );
    expect(before).not.toContain(esc(COPY.upgrade.doneStampOnly));
    expect(before).toContain(esc(COPY.upgrade.done));
    // Only the stamp changed (the job's result): said so, and the stamp is still proposed
    // (scope upgrade carries it, ADR 0051).
    const stampOnly = renderToStaticMarkup(
      <UpgradeOfferView
        view={{ ...view, pending: [], upgraded: ["org-pack/runtime.yaml"] }}
        run={{ state: "done", lines: [], upgraded: [] }}
        onRun={() => undefined}
      />,
    );
    expect(stampOnly).toContain(esc(COPY.upgrade.doneStampOnly));
    expect(COPY.upgrade.doneStampOnly).toMatch(/propose the stamp so everyone's Atticus sees/);
    expect(stampOnly).toMatch(/<button[^>]*>[^<]*(Propose|propose)/);
    const withFiles = renderToStaticMarkup(
      <UpgradeOfferView
        view={{ ...view, pending: [] }}
        run={{ state: "done", lines: [], upgraded: ["org-pack/runtime.yaml"] }}
        onRun={() => undefined}
      />,
    );
    expect(withFiles).toContain(esc(COPY.upgrade.done));
    expect(withFiles).toMatch(/<button[^>]*>[^<]*(Propose|propose)/);
  });

  it("reads what the run changed from the job's result (final round)", async () => {
    const { followJob } = await import("../src/app/job.js");
    expect(followJob.toString()).toMatch(/result: j\.result/);
    const src = readFileSync(new URL("../src/app/upgrade.tsx", import.meta.url), "utf8");
    expect(src).toMatch(/const upgraded = r\.result\?\.upgraded;/);
    expect(src).not.toMatch(/view\.upgraded/);
  });
});

describe("18: a fresh metarepo's first step", () => {
  it("is the app's Add repos form, the command under Or in a terminal", () => {
    const s = onboardingStep({ repos: [], manifests: [], problems: [] } as never, 0);
    expect(s.link).toEqual({ href: "#/repos", label: COPY.work.addReposInApp });
    expect(s.command).toBe("atticus repos discover <folder>");
  });
});

describe("19: the tab strip in a narrow panel", () => {
  it("lists the tabs out of view, keeps Home, and never shows a cut tab's ×", () => {
    const tabs = [
      { key: "home", left: 0, width: 70 },
      { key: "changes", left: 70, width: 120 },
      { key: "trust", left: 190, width: 120 },
      { key: "canvas", left: 310, width: 120 },
      { key: "scans", left: 430, width: 120 },
    ];
    // Scrolled 150 px in a 300 px strip, Home held at the left: 220..450 shown.
    expect(tabsOutOfView(tabs, { scroll: 150, width: 300 }, 70)).toEqual({
      hidden: ["changes"],
      cut: ["trust", "scans"],
    });
    expect(COPY.ide.moreTabs(3)).toBe("3 more");
    // A strip narrower than Home lists Home too.
    expect(tabsOutOfView(tabs.slice(0, 2), { scroll: 0, width: 50 }, 70).hidden).toEqual([
      "home",
      "changes",
    ]);
  });

  it("its N more menu goes Home and End, wraps, and closes on Escape or a click away", () => {
    expect(moreMenuKey("Home", 2, 4)).toBe(0);
    expect(moreMenuKey("End", 0, 4)).toBe(3);
    expect(moreMenuKey("ArrowDown", 3, 4)).toBe(0);
    expect(moreMenuKey("ArrowUp", 0, 4)).toBe(3);
    expect(moreMenuKey("Escape", 1, 4)).toBe("close");
    expect(moreMenuKey("Tab", 1, 4)).toBe("leave");
    expect(moreMenuKey("a", 1, 4)).toBeUndefined();
    const src = readFileSync(new URL("../src/app/shell/TabStrip.tsx", import.meta.url), "utf8");
    expect(src).toMatch(/document\.addEventListener\("pointerdown", away\)/);
  });
});

describe("6c: an empty metarepo's Explorer", () => {
  it("doesn't ask for the estate when the manifest names no repo", () => {
    expect(manifestEmpty({ repos: [] })).toBe(true);
    expect(manifestEmpty({ repos: [{ repo: "forge-ledger" }] })).toBe(false);
    // Not known yet: it asks.
    expect(manifestEmpty(undefined)).toBe(false);
  });
});

describe("20: an owner question", () => {
  it("names the team and the channel in words, and says it was sent, sending again second", () => {
    const q = {
      id: "q.owner-named.ledger",
      system: "ledger",
      owner: "team-ledger",
      ownerName: "Ledger team",
      question: "Who owns ledger-db?",
      neededFact: "Its owning team",
      channel: "ado",
      state: "sent" as const,
      sentAt: "2026-11-09T10:00:00Z",
      records: ["ledger-db"],
      file: "catalog/curated/ownerquestion/q.owner-named.ledger.yaml",
    };
    const out = renderToStaticMarkup(<OwnerQuestionCard q={q} onAnswered={() => undefined} />);
    const O = COPY.questions.ownerQuestions;
    expect(out).toContain(esc(O.ask("Ledger team", "ledger", "Azure DevOps")));
    expect(out).toContain(esc(O.sentTo("Ledger team", "Azure DevOps", "2026-11-09")));
    expect(out).toContain(`>${O.sent}<`);
    expect(out).toContain(esc(COPY.roleWork.send.again("Ledger team")));
    expect(out).not.toContain("Ask team-ledger");
  });

  it("says Not sent yet, with Send first, for a question nobody sent (review of the fix)", () => {
    const O = COPY.questions.ownerQuestions;
    const q = {
      id: "q.owner-named.reports",
      system: "reports",
      owner: "team-reports",
      question: "Who owns reports-db?",
      neededFact: "Its owning team",
      channel: "teams",
      state: "sent" as const,
      records: ["reports-db"],
      file: "catalog/curated/ownerquestion/q.owner-named.reports.yaml",
    };
    const out = renderToStaticMarkup(<OwnerQuestionCard q={q} onAnswered={() => undefined} />);
    expect(out).toContain(`>${O.notSent}<`);
    expect(out).not.toContain(`>${O.sent}<`);
    // A team teams.yaml doesn't name reads as words, never its id alone.
    expect(out).toContain(esc(O.notSentTo("Reports team", "Microsoft Teams")));
    expect(out).toMatch(
      new RegExp(`class="btn primary"[^>]*>${esc(COPY.roleWork.send.button("Reports team"))}<`),
    );
    expect(out).not.toContain(esc(COPY.roleWork.send.again("Reports team")));
    // Nobody owns it: said so, and who it goes to.
    const none = renderToStaticMarkup(
      <OwnerQuestionCard
        q={{ ...q, owner: "unassigned", routeTo: "architect" }}
        onAnswered={() => undefined}
      />,
    );
    expect(none).toContain(esc(O.ask(O.nobody, "reports", "Microsoft Teams")));
    expect(none).not.toContain("unassigned");
  });

  it("says the day it was sent in local time, not UTC's", () => {
    // 01:30 UTC on the 10th is the 9th west of UTC; the page says the person's own day.
    const at = "2026-11-10T01:30:00Z";
    const d = new Date(at);
    const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    expect(localDay(at)).toBe(local);
    expect(localDay("not a time")).toBeUndefined();
    expect(ownerWords("team-ledger")).toBe("Ledger team");
    expect(ownerWords("team-north-wind")).toBe("North wind team");
    expect(ownerWords("@pat")).toBe("@pat");
    expect(ownerWords("unassigned")).toBe(COPY.questions.ownerQuestions.nobody);
  });
});

describe("21: Home's words agree", () => {
  it("says what waits when nothing blocks, and changes by gate", () => {
    const waits = [
      ...Array.from({ length: 7 }, () => ({ kind: "triage" })),
      ...Array.from({ length: 3 }, () => ({ kind: "question" })),
    ];
    expect(waitingWords(waits)).toBe("7 to sort out, 3 questions");
    expect(homeStatus("ready", 0, waits).text).toBe(
      COPY.commandCenter.nothingBlockedButWaiting(10, "7 to sort out, 3 questions"),
    );
    expect(homeStatus("ready", 0, []).text).toBe(COPY.commandCenter.nothingIsBlockedRight);
    expect(byStage([{ state: "plan" }])).toBe("1 at Plan");
    expect(phaseWord("plan")).toBe(COPY.commandCenter.plan);
  });
});

describe("22 and 23: narrow and keyboard layout", () => {
  it("never breaks a chip's word in a narrow table, and scrolls focus clear of the panel", () => {
    const hud = css("../src/styles/hud.css");
    const narrow = hud.slice(hud.indexOf("@media (max-width: 640px)"));
    const chip = narrow.slice(
      narrow.indexOf(".chip {"),
      narrow.indexOf("}", narrow.indexOf(".chip {")),
    );
    expect(chip).toMatch(/overflow-wrap: break-word/);
    expect(chip).not.toMatch(/anywhere/);
    // A table cell's word-break: break-word would break it all the same.
    expect(chip).toMatch(/word-break: normal/);
    const shell = css("../src/app/shell/shell.css");
    const main = shell.slice(
      shell.indexOf(".sh-main {"),
      shell.indexOf("}", shell.indexOf(".sh-main {")),
    );
    expect(main).toMatch(/scroll-padding-bottom: \d+px/);
  });
});

describe("25 and 27: a pinned page's name, and what is to propose", () => {
  it("names a box by its name, and a changed file without saying where it changed", () => {
    const labels = estateLabels({ children: [{ id: "system:portal", label: "Portal" }] });
    expect(pageLabel("#/canvas?node=system:portal", labels)).toMatch(/Portal$/);
    expect(pageLabel("#/canvas?node=system:portal")).toMatch(/› portal$/);
    expect(pinnedItems(["#/canvas?node=system:portal"], labels)[0]!.label).not.toMatch(
      /system:portal/,
    );
    expect(COPY.propose.pending(1)).toBe("1 changed file isn't proposed for review yet.");
  });
});
