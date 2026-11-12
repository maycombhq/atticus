import { beforeEach, describe, expect, it, vi } from "vitest";
import { all, mount, text } from "./support/hooks.js";

/**
 * Beta.26 second review (Home): the estate is a fold at the foot for every role; an estate not
 * set up says so in one line and keeps its checklist in a fold, so Home doesn't scroll; Next for
 * you shows its top few, the rest one link away; Show the whole list takes the keyboard to the
 * list it opens. On the invented Forge estate.
 */
vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});

const answers: Record<string, unknown> = {};
vi.mock("../src/api/client.js", async () => ({
  ...(await vi.importActual<object>("../src/api/client.js")),
  useApi: (path?: string) =>
    path !== undefined && path in answers
      ? { state: "ready", data: answers[path], reload: () => undefined }
      : { state: "loading", reload: () => undefined },
  useLiveEvents: () => undefined,
  useReloadOnFiles: () => undefined,
  useFileChanges: () => undefined,
}));
vi.mock("../src/app/me.js", async () => ({
  ...(await vi.importActual<object>("../src/app/me.js")),
  useMe: () => ({ me: { user: "pat" } }),
}));
vi.mock("../src/screens/knowledge/NeedsAcross.js", async () => ({
  ...(await vi.importActual<object>("../src/screens/knowledge/NeedsAcross.js")),
  useNeedsAcross: () => ({ state: "ready", data: [], reload: () => undefined }),
}));

const { COPY } = await import("../src/copy.js");
const CC = await import("../src/screens/CommandCenter.js");
const { HomeEstate } = await import("../src/screens/work/Overview.js");
const { TileGroup } = await import("../src/screens/home/HomeTiles.js");
const { HomePanel, TOP } = await import("../src/screens/home/HomePanels.js");
const { renderToStaticMarkup } = await import("react-dom/server");
const { YourRoleQuestions } = await import("../src/screens/RoleQuestions.js");
const { PendingProposals } = await import("../src/app/propose.js");

const H = COPY.commandCenter.home;
const T = COPY.commandCenter;
const el = (tree: unknown, type: unknown) => all(tree).filter((e) => e.type === type);
const byClass = (tree: unknown, c: string) =>
  all(tree).filter((e) =>
    String(e.props.className ?? "")
      .split(" ")
      .includes(c),
  );

const change = (id: string, state = "build") => ({
  id,
  title: id,
  type: "feature",
  state,
  repos: ["forge-ledger"],
  openFindings: { blocking: 0, gap: 0, risk: 0, idea: 0 },
  updatedAt: "2026-11-01",
});
const finding = (id: string, severity: string, lens?: string) => ({
  id,
  change: "add-transfer-limit",
  gate: "build",
  layer: "code",
  severity,
  kind: "x",
  artifact: "brief.md",
  summary: "s",
  state: "open",
  ...(lens ? { lens } : {}),
});

beforeEach(() => {
  for (const k of Object.keys(answers)) delete answers[k];
  answers["/api/changes"] = [change("add-transfer-limit")];
  answers["/api/findings?state=open"] = [];
  answers["/api/catalog/kinds"] = [
    { kind: "Interface", count: 96, stale: 0 },
    { kind: "Table", count: 30, stale: 0 },
    { kind: "System", count: 12, stale: 0 },
    { kind: "Topic", count: 4, stale: 0 },
  ];
  answers["/api/questions?state=open"] = { questions: [], problems: [] };
  answers["/api/owner-questions"] = { questions: [], open: 0 };
  answers["/api/todo"] = { steps: [] };
  answers["/api/view/triage"] = { data: null };
});

describe("Home's foot", () => {
  const estateFold = (tree: unknown) =>
    all(tree).find((e) => e.type === "details" && el(e.props.children, HomeEstate).length === 1);

  it("has the estate as a fold for a developer: coverage, trust, the top kinds and the lenses", () => {
    answers["/api/findings?state=open"] = [
      finding("f-1", "gap", "security"),
      finding("f-2", "risk", "security"),
      finding("f-3", "idea"),
    ];
    const m = mount(CC.CommandCenter as never, {} as never);
    const fold = estateFold(m.tree)!;
    expect(fold).toBeDefined();
    expect(String(fold.props.className)).toContain("hm-fold");
    // In the foot, one line until it is opened.
    const foot = byClass(m.tree, "hm-folds")[0]!;
    expect(all(foot).includes(fold)).toBe(true);
    const words = text(fold.props.children);
    expect(words).toContain(COPY.work.estate);
    expect(words).toContain(
      H.topKinds(
        [H.count(96, "Interface"), H.count(30, "Table"), H.count(12, "System")].join(" · "),
      ),
    );
    expect(words).toContain(H.byLens([H.count(2, "security"), H.count(1, "checks")].join(" · ")));
    expect(el(fold.props.children, HomeEstate)[0]!.props.withInFlight).toBe(false);
    const hrefs = all(fold.props.children)
      .filter((e) => e.type === "a")
      .map((e) => e.props.href);
    expect(hrefs).toEqual(expect.arrayContaining(["#/explore", "#/changes?across=findings"]));
  });

  it("keeps the estate fold for a product owner too, outside Setting up Atticus", () => {
    const m = mount(CC.CommandCenter as never, {} as never);
    const roles = el(m.tree, YourRoleQuestions)[0]!.props.onRoles as (
      r: Record<string, string[]>,
    ) => void;
    roles({ "add-transfer-limit": ["product"] });
    m.render();
    const fold = estateFold(m.tree);
    expect(fold).toBeDefined();
    expect(String(fold!.props.className)).toContain("hm-fold");
    // Once: not again inside the set-up fold.
    expect(el(m.tree, HomeEstate)).toHaveLength(1);
  });
});

describe("an estate not set up yet", () => {
  beforeEach(() => {
    answers["/api/setup"] = {
      baselined: false,
      steps: [
        { id: "repos", label: "Repos are listed", done: true, detail: "4 repos" },
        { id: "clones", label: "Clones", done: false, detail: "0 of 4" },
        { id: "scan", label: "Read", done: false, detail: "0 of 4" },
      ],
    };
  });

  it("says so in one line at the top and keeps the checklist folded at the foot", () => {
    const m = mount(CC.CommandCenter as never, {} as never);
    const line = el(m.tree, CC.SetupLine);
    expect(line).toHaveLength(1);
    // Above the tiles: the line, not the checklist.
    const kids = all(m.tree);
    expect(kids.indexOf(line[0]!)).toBeLessThan(kids.indexOf(el(m.tree, TileGroup)[0]!));
    const lists = el(m.tree, CC.SetupChecklist);
    expect(lists).toHaveLength(1);
    const foot = byClass(m.tree, "hm-folds")[0]!;
    const fold = all(foot).find(
      (e) => e.type === "details" && el(e.props.children, CC.SetupChecklist).length === 1,
    )!;
    expect(fold).toBeDefined();
    expect(text(fold.props.children)).toContain(T.setUpAtticus);
  });

  it("opens the fold and takes the keyboard to it from the line", () => {
    const m = mount(
      CC.SetupLine as never,
      {
        setup: { state: "ready", data: answers["/api/setup"], reload: () => undefined },
        onShow: vi.fn(),
      } as never,
    );
    expect(text(m.tree)).toContain(H.setupLine(1, 3));
    const b = all(m.tree).find((e) => e.type === "button")!;
    expect(text(b)).toBe(H.setupShow);
    expect(
      mount(
        CC.SetupLine as never,
        {
          setup: { state: "ready", data: { baselined: true, steps: [] }, reload: () => undefined },
          onShow: () => undefined,
        } as never,
      ).tree,
    ).toBeNull();
    // The opener: the fold opened, its summary focused.
    const summary = { focus: vi.fn() };
    const details = { open: false, querySelector: () => summary };
    CC.openFold(details as never);
    expect(details.open).toBe(true);
    expect(summary.focus).toHaveBeenCalled();
  });
});

describe("Next for you", () => {
  it("passes its cap to the role's questions and to what to propose", () => {
    const m = mount(CC.CommandCenter as never, {} as never);
    expect(el(m.tree, YourRoleQuestions)[0]!.props.max).toBe(TOP);
    expect(el(m.tree, PendingProposals)[0]!.props.max).toBe(TOP);
  });

  it("shows the role's questions up to its cap, the rest one link to Questions", () => {
    const changes = Array.from({ length: 4 }, (_, k) => ({
      id: `change-${k}`,
      state: "build",
      yourRoles: ["delivery"],
    }));
    const m = mount(YourRoleQuestions as never, { changes, compact: true, max: 5 } as never);
    const rows = () =>
      all(m.tree).filter(
        (e) =>
          typeof e.type === "function" &&
          (e.type as { name?: string }).name === "ChangeRoleQuestions",
      );
    const onOpen = rows()[0]!.props.onOpen as (c: string, n: number) => void;
    onOpen("change-0", 3);
    onOpen("change-1", 2);
    onOpen("change-2", 4);
    m.render();
    expect(rows().map((r) => r.props.limit)).toEqual([5, 2, 0, 0]);
    const more = all(m.tree).find((e) => e.type === "a" && e.props.href === "#/questions")!;
    expect(text(more)).toBe(H.more(4));
  });
});

describe("the whole list of what needs a person", () => {
  it("takes the keyboard to its heading when it opens", () => {
    answers["/api/todo"] = { steps: [{ id: "s-1", title: "Approve the PR", change: "x" }] };
    const m = mount(CC.CommandCenter as never, {} as never);
    const show = all(m.tree).find(
      (e) => e.type === "button" && e.props["aria-expanded"] === false,
    )!;
    (show.props.onClick as () => void)();
    m.render();
    const panel = el(m.tree, HomePanel).find((e) => e.props.sectionId === "hm-whole")!;
    expect(panel.props.title).toBe(H.wholeListTitle);
    const ref = panel.props.headRef as (x: unknown) => void;
    const focus = vi.fn();
    ref({ focus });
    expect(focus).toHaveBeenCalledTimes(1);
    // Only once, for the click that opened it.
    ref({ focus });
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("gives the panel's heading the focus it can take, and the id its button controls", () => {
    const out = renderToStaticMarkup(
      <HomePanel sectionId="hm-whole" id="hm-whole-t" title={H.wholeListTitle} headRef={() => {}}>
        x
      </HomePanel>,
    );
    expect(out).toMatch(
      /^<section id="hm-whole" class="panel hm-panel" aria-labelledby="hm-whole-t">/,
    );
    expect(out).toMatch(/<h2 id="hm-whole-t" class="hm-label" tabindex="-1">/);
  });
});

describe("the status line", () => {
  it("says nothing is blocked when the Blocking findings tile counts none, gaps or not", () => {
    answers["/api/findings?state=open"] = [finding("f-1", "gap"), finding("f-2", "gap")];
    const m = mount(CC.CommandCenter as never, {} as never);
    const status = byClass(m.tree, "hm-status")[0]!;
    // Beta.27 review: and what waits on a person, when something does (here the two gaps).
    expect(text(status)).toMatch(/^Nothing is blocked/);
    expect(status.props.className).not.toMatch(/\bbad\b/);
  });
});
