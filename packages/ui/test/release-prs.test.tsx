import { expect, it, vi } from "vitest";
import { all, mount } from "./support/hooks.js";

/**
 * ADR 0184 (seventh UX walk, release): the Release page raises the release PRs, change/<id> into
 * each code repo's default branch, on the person's click, and lists each repo's PR, with an empty
 * state for a change with no code repo.
 */
vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});
const posted: { path: string; body: unknown }[] = [];
const ID = "add-transfer-limit";
const DETAIL = {
  change: {
    id: ID,
    title: "Add a daily transfer limit",
    type: "feature",
    state: "release-ready",
    owners: {},
  },
  status: {
    state: "release-ready",
    nextStep: "",
    risk: { level: "low", score: 1 },
    blockers: [],
    reasons: [],
  },
  openFindings: { blocking: 0, gap: 0, risk: 0, idea: 0 },
  requests: { total: 0, filed: 0, toFile: 0, list: [] },
  repos: [
    { id: "forge-ledger", branch: `change/${ID}`, build: { status: "not-run" } },
    {
      id: "forge-portal-bff",
      branch: `change/${ID}`,
      pr: {
        number: 4,
        state: "open",
        url: "https://git.example.com/forge/forge-portal-bff/pull/4",
      },
      build: { status: "passed" },
    },
  ],
  conflicts: [],
  archive: { pass: false, blockers: [], notes: [] },
  evidence: [],
};
vi.mock("../src/api/client.js", async () => ({
  ...(await vi.importActual<object>("../src/api/client.js")),
  useApi: () => ({ state: "ready", data: DETAIL, reload: () => undefined }),
  useLiveEvents: () => undefined,
  api: async (path: string, o: { body: unknown }) => {
    posted.push({ path, body: o.body });
    return { lines: [] };
  },
}));
const { Detail } = await import("../src/screens/run/Release.js");
const { View } = await import("../src/app/ui.js");
const { COPY } = await import("../src/copy.js");
const T = COPY.release;
type El = { type: unknown; props: Record<string, unknown> };
const text = (e: El) => JSON.stringify(e.props.children ?? "");

it("raises the release PRs on the person's click and lists each repo's PR", async () => {
  const m = mount(Detail as never, { id: ID } as never);
  const views = all(m.tree).filter((e) => e.type === View);
  const hero = views[0]!;
  const body = all((hero.props.children as (d: unknown) => unknown)(DETAIL));
  const raise = body.find((e) => e.type === "button" && text(e).includes(T.raiseReleasePrs))!;
  expect(raise.props.disabled).toBe(false);
  expect(raise.props.title).toBe(T.raisesReleasePrs);
  (raise.props.onClick as () => void)();
  await new Promise((r) => setTimeout(r, 0));
  expect(posted).toEqual([{ path: `/api/changes/${ID}/release-prs`, body: {} }]);

  const prs = views.find((v) => v.props.emptyText === T.noCodeRepos)!;
  expect((prs.props.empty as (d: unknown) => boolean)({ ...DETAIL, repos: [] })).toBe(true);
  const rows = all((prs.props.children as (d: unknown) => unknown)(DETAIL));
  expect(rows.some((e) => e.type === "span" && text(e).includes(T.notRaisedYet))).toBe(true);
  const link = rows.find((e) => e.type === "a")!;
  expect(link.props.href).toBe("https://git.example.com/forge/forge-portal-bff/pull/4");
  expect(text(link)).toContain("#4 OPEN");
});

it("can't raise them before the build is done, or once every repo has one", () => {
  const early = { ...DETAIL, change: { ...DETAIL.change, state: "build" } };
  const m = mount(Detail as never, { id: ID } as never);
  const hero = all(m.tree).filter((e) => e.type === View)[0]!;
  const find = (d: unknown) =>
    all((hero.props.children as (d: unknown) => unknown)(d)).find(
      (e) => e.type === "button" && text(e).includes(T.raiseReleasePrs),
    )!;
  expect(find(early).props.disabled).toBe(true);
  expect(find(early).props.title).toBe(T.releasePrsNotYet);
  const all3 = {
    ...DETAIL,
    repos: DETAIL.repos.map((r) => ({
      ...r,
      pr: { number: 1, state: "merged", url: "https://git.example.com/x/pull/1" },
    })),
  };
  expect(find(all3).props.disabled).toBe(true);
});
