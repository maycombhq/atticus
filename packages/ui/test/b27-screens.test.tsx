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
  FIT_MIN_ZOOM,
} from "../src/screens/architecture/Canvas.js";
import { WORDS } from "../src/screens/architecture/words.js";
import { stageMark } from "../src/screens/work/Cockpit.js";
import { StageThreadView } from "../src/screens/work/StageThread.js";
import { RaiseHandoff } from "../src/screens/know/Phase.js";
import { TrustRow } from "../src/screens/map/Trust.js";
import { askedKind, openingKind, OwnerQuestionCard } from "../src/screens/OwnerQuestions.js";
import { tabsOutOfView } from "../src/app/shell/TabStrip.js";
import { UpgradeOfferView } from "../src/app/upgrade.js";
import { onboardingStep } from "../src/screens/work/next.js";
import { byStage, homeStatus, waitingWords } from "../src/screens/CommandCenter.js";
import { phaseWord } from "../src/screens/home/HomePanels.js";
import { BrokenChangesView } from "../src/screens/work/BrokenChanges.js";
import { problemsOf } from "../src/app/shell/BottomPanel.js";
import { estateLabels, pageLabel, pinnedItems } from "../src/app/shell/explorer-model.js";
import { stateWords } from "../src/app/activity.js";

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
    expect(out).toContain(esc(COPY.appStep.storiesAgain));
    expect(out).not.toContain(`>${esc(COPY.thread.start)}<`);
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
    expect(rule).toMatch(/outline: 3px solid var\(--accent\)/);
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
    expect(out).toContain('role="alert"');
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
    expect(stateWords({ state: "done", outcome: "refused" })).toBe(COPY.activity.refused);
    expect(stateWords({ state: "failed" })).toBe(COPY.activity.states.failed);
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
