import { expect, it, vi } from "vitest";
import { all, mount, text } from "./support/hooks.js";

/** ADR 0183: Apply, then Propose for review: the list first, then exactly the ticked files. */
vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});
const calls: { path: string; body?: unknown }[] = [];
vi.mock("../src/api/client.js", async () => ({
  ...(await vi.importActual<object>("../src/api/client.js")),
  api: async (path: string, o?: { body?: unknown }) => {
    calls.push({ path, ...(o?.body ? { body: o.body } : {}) });
    if (path.startsWith("/api/propose?"))
      return {
        scope: "answers",
        files: [
          { path: "questions/q1.yaml", status: "??" },
          { path: "facts/forge-ledger.jsonl", status: "M" },
        ],
        branch: "propose/answers/2026-11-08-pat",
        title: "Answers to the map's questions",
      };
    if (path.endsWith("/apply")) return { code: 0, lines: ["forge-ledger: 12 facts kept"] };
    return { lines: ["PR #7 is open for review: https://git.example.com/pr/7"] };
  },
}));
const { COPY } = await import("../src/copy.js");
const { ApplyAndPropose, Propose } = await import("../src/app/propose.js");
const P = COPY.propose;
const tick = () => new Promise((r) => setTimeout(r, 0));

it("applies, lists, lets a file be left out, and proposes the rest", async () => {
  const m = mount(ApplyAndPropose as never, { scope: "answers", repo: "forge-ledger" } as never);
  const btn = (label: string) =>
    all(m.tree).find((e) => e.type === "button" && text(e.props.children) === label)!;
  (btn(P.apply("forge-ledger")).props.onClick as () => void)();
  await tick();
  m.render();
  expect(text(m.tree)).toContain("forge-ledger: 12 facts kept");
  const n = mount(Propose as never, { scope: "answers" } as never);
  const nbtn = (label: string) =>
    all(n.tree).find((e) => e.type === "button" && text(e.props.children) === label)!;
  (nbtn(P.propose).props.onClick as () => void)();
  await tick();
  n.render();
  expect(text(n.tree)).toContain("propose/answers/2026-11-08-pat");
  const boxes = all(n.tree).filter((e) => e.type === "input" && e.props.type === "checkbox");
  (boxes[1]!.props.onChange as (e: unknown) => void)({ target: { checked: false } });
  n.render();
  (nbtn(P.yes(1)).props.onClick as () => void)();
  await tick();
  n.render();
  expect(calls.map((c) => c.path)).toEqual([
    "/api/facts/forge-ledger/apply",
    "/api/propose?scope=answers",
    "/api/propose",
  ]);
  expect(calls[2]!.body).toEqual({
    scope: "answers",
    files: ["questions/q1.yaml"],
    branch: "propose/answers/2026-11-08-pat",
  });
  expect(text(n.tree)).toContain("PR #7 is open for review");
});
