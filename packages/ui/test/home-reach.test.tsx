import { beforeEach, expect, it, vi } from "vitest";
import { all, mount, text } from "./support/hooks.js";

/**
 * beta.26: Home as one screen keeps every action it had. What left the page (the map, the
 * catalog's bars, the findings' charts, the slash commands, the digest, the whole list of what
 * needs a person) is a tile, a fold or a menu one click away; and Home asks for no graph or
 * diagram, and for /api/setup and /api/propose once each.
 */
vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});

const asked: string[] = [];
const answers: Record<string, unknown> = {};
vi.mock("../src/api/client.js", async () => ({
  ...(await vi.importActual<object>("../src/api/client.js")),
  useApi: (path?: string) => {
    if (path !== undefined) asked.push(path);
    return path !== undefined && path in answers
      ? { state: "ready", data: answers[path], reload: () => undefined }
      : { state: "loading", reload: () => undefined };
  },
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
const { BringIn, PendingProposals } = await import("../src/app/propose.js");
const { HomeNext, SlashCommands } = await import("../src/screens/work/Overview.js");
const { YourRoleQuestions } = await import("../src/screens/RoleQuestions.js");
const { TileGroup } = await import("../src/screens/home/HomeTiles.js");
const { HomeChanges, NeedsTop } = await import("../src/screens/home/HomePanels.js");

const H = COPY.commandCenter.home;

beforeEach(() => {
  asked.length = 0;
  for (const k of Object.keys(answers)) delete answers[k];
  answers["/api/changes"] = [
    {
      id: "add-transfer-limit",
      title: "Add a daily transfer limit",
      type: "feature",
      state: "build",
      repos: ["forge-ledger"],
      openFindings: { blocking: 0, gap: 0, risk: 0, idea: 0 },
      updatedAt: "2026-11-01",
    },
  ];
  answers["/api/findings?state=open"] = [];
  answers["/api/catalog/kinds"] = [
    { kind: "Interface", count: 96, stale: 0 },
    { kind: "System", count: 12, stale: 0 },
  ];
  answers["/api/questions?state=open"] = {
    questions: [{ id: "q-1", question: "Does the ledger retry?", repo: "forge-ledger" }],
    problems: [],
  };
  answers["/api/owner-questions"] = { questions: [], open: 0 };
  answers["/api/todo"] = { steps: [] };
  answers["/api/view/triage"] = { data: null };
});

const el = (tree: unknown, type: unknown) => all(tree).filter((e) => e.type === type);

it("keeps every former action of Home reachable", () => {
  const m = mount(CC.CommandCenter as never, {} as never);
  const t = m.tree;
  // Run next, what to propose, the role's questions and Bring in what merged: Next for you.
  expect(el(t, HomeNext)).toHaveLength(1);
  expect(el(t, PendingProposals)[0]!.props.plan).toBeDefined();
  expect(el(t, YourRoleQuestions)[0]!.props.compact).toBe(true);
  expect(el(t, BringIn)).toHaveLength(1);
  // What needs a person, and the changes with the current one's gates (and the map's link).
  expect(el(t, HomeChanges)).toHaveLength(1);
  expect(el(t, NeedsTop)).toHaveLength(1);
  // Six tiles, each a link: what waits by kind, the changes, the corrections, the catalog.
  const tiles = el(t, TileGroup).flatMap((g) => g.props.tiles as { id: string; href: string }[]);
  expect(Object.fromEntries(tiles.map((x) => [x.id, x.href]))).toEqual({
    wait: "#/todo",
    questions: "#/questions",
    "in-flight": "#/changes",
    corrections: "#/canvas",
    blocking: "#/changes?across=findings",
    catalog: "#/trust",
  });
  // The digest is in Needs a person's menu; the slash commands in a fold.
  const menu = all(t).find((e) => e.type === "details" && e.props.className === "hm-menu")!;
  expect(all(menu.props.children).some((e) => e.type === CC.DigestButtons)).toBe(true);
  const folds = all(t).filter((e) => e.type === "details" && e.props.className === "hm-fold");
  expect(text(folds[0]!.props.children)).toContain(H.assistant);
  expect(all(folds[0]!.props.children).some((e) => e.type === SlashCommands)).toBe(true);
  // See all questions goes to the Questions page.
  expect(
    all(t).some(
      (e) => e.type === "a" && e.props.href === "#/questions" && text(e) === H.seeAllQuestions,
    ),
  ).toBe(true);
});

it("opens the whole list of what needs a person, with its filter and bulk actions, on a click", () => {
  const m = mount(CC.CommandCenter as never, {} as never);
  expect(el(m.tree, CC.WaitingList)).toHaveLength(0);
  const show = all(m.tree).find((e) => e.type === "button" && e.props["aria-expanded"] === false)!;
  expect(text(show)).toBe(H.wholeList(1));
  (show.props.onClick as () => void)();
  m.render();
  const list = el(m.tree, CC.WaitingList);
  expect(list).toHaveLength(1);
  expect(list[0]!.props.onBulk).toBeTypeOf("function");
  const hide = all(m.tree).find((e) => e.type === "button" && e.props["aria-expanded"] === true)!;
  expect(hide.props["aria-controls"]).toBe("hm-whole");
  expect(text(hide)).toBe(H.hideWholeList);
});

it("asks for no graph or diagram, and for set-up and the work to propose once each", () => {
  mount(CC.CommandCenter as never, {} as never);
  expect(asked.filter((p) => /graph|diagram/.test(p))).toEqual([]);
  // As often as the changes are asked for (once a render): the tiles and panels share a load.
  const renders = asked.filter((p) => p === "/api/changes").length;
  expect(asked.filter((p) => p === "/api/setup")).toHaveLength(renders);
  expect(asked.filter((p) => p === "/api/propose?scope=work")).toHaveLength(renders);
});
