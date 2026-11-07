import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Api } from "@maycombhq/core";
import { all, mount, text } from "./support/hooks.js";

/**
 * ADR 0178 part 2: Match with Copilot in the Connect panel. The session proposes; the person
 * ticks; nothing is written here. Rendered with the tiny hooks runtime, no DOM.
 */

vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});
let onEvent: ((e: unknown) => void) | undefined;
vi.mock("../src/api/client.js", async () => {
  const real = await vi.importActual<object>("../src/api/client.js");
  return {
    ...real,
    useLiveEvents: (f: (e: unknown) => void) => {
      onEvent = f;
    },
  };
});

const { COPY } = await import("../src/copy.js");
const { MatchWithCopilot } = await import("../src/screens/architecture/Match.js");
const M = COPY.match;

const flush = () => new Promise((r) => setTimeout(r, 0));
const button = (tree: unknown, label: string) =>
  all(tree).find((e) => e.type === "button" && text(e.props.children) === label);
const click = async (m: { tree: unknown; render(): void }, label: string) => {
  (button(m.tree, label)!.props.onClick as () => void)();
  await flush();
  m.render();
};

const calls = [
  {
    fact: "call.a",
    callType: "rest",
    method: "POST",
    path: "captureChargePath",
    at: "x:1",
    status: "left" as const,
  },
];
const apis = [{ id: "e1", kind: "route" as const, method: "POST", path: "/charges/{id}/capture" }];
const view = (state: Api.MatchLinksViewT["state"], extra: Partial<Api.MatchLinksViewT> = {}) =>
  ({
    from: "forge-billing",
    to: { repo: "gw" },
    state,
    proposals: [],
    none: [],
    rejected: [],
    ...extra,
  }) as Api.MatchLinksViewT;

afterEach(() => vi.useRealTimers());

describe("Match with Copilot", () => {
  it("starts a session, follows it to done, lists the proposals with their lines, and ticks them on the person's say", async () => {
    let got: Api.MatchLinksViewT = view("idle");
    const taken: Api.MatchProposalT[][] = [];
    const m = mount(
      MatchWithCopilot as never,
      {
        from: "forge-billing",
        box: { repo: "gw" },
        toName: "gw",
        calls,
        apis,
        onTake: (ps: Api.MatchProposalT[]) => taken.push(ps),
        io: {
          get: async () => got,
          post: async () => {
            got = view("running", { jobId: "job-1", brief: "proposals/matching/b.md" });
            return got;
          },
        },
      } as never,
    );
    await flush();
    m.render();
    expect(button(m.tree, M.start)).toBeDefined();
    await click(m, M.start);
    expect(text(m.tree)).toContain(M.runningSay("forge-billing", "gw"));
    expect(button(m.tree, M.running)!.props.disabled).toBe(true);
    // The job's done event: the answer is read and checked.
    got = view("done", {
      brief: "proposals/matching/b.md",
      answer: "proposals/matching/b.yaml",
      proposals: [
        { call: "call.a", api: "e1", why: "the constant", lines: ["src/Routes.java:12"] },
      ],
      none: [],
      rejected: ["call.nope isn't one of forge-billing's loose calls."],
    });
    onEvent!({ type: "job.done", jobId: "job-1", state: "done" });
    await flush();
    m.render();
    const t = text(m.tree);
    expect(t).toContain(M.done(1, 0, 1));
    expect(t).toContain("POST captureChargePath");
    expect(t).toContain("POST /charges/{id}/capture");
    expect(t).toContain("src/Routes.java:12");
    expect(t).toContain(M.rejectedTitle(1));
    expect(taken).toEqual([]);
    await click(m, M.take(1));
    expect(taken).toEqual([
      [{ call: "call.a", api: "e1", why: "the constant", lines: ["src/Routes.java:12"] }],
    ]);
    expect(button(m.tree, M.taken)!.props.disabled).toBe(true);
    expect(button(m.tree, M.again)).toBeDefined();
  });

  it("hands the brief to Copilot Chat where copilot-acp isn't allowed, and reads the answer back", async () => {
    let got: Api.MatchLinksViewT = view("idle");
    const m = mount(
      MatchWithCopilot as never,
      {
        from: "forge-billing",
        box: { system: "northwind-pay" },
        toName: "Northwind Pay",
        calls,
        apis,
        onTake: () => undefined,
        io: {
          get: async () => got,
          post: async () => {
            got = view("handoff", {
              brief: "proposals/matching/b.md",
              answer: "proposals/matching/b.yaml",
            });
            return got;
          },
        },
      } as never,
    );
    await flush();
    m.render();
    await click(m, M.start);
    expect(text(m.tree)).toContain(M.handoff("proposals/matching/b.md"));
    expect(text(m.tree)).toContain(M.answerAt("proposals/matching/b.yaml"));
    got = view("failed", {
      brief: "proposals/matching/b.md",
      error: "The answer doesn't read as YAML: x",
    });
    await click(m, M.readAnswer);
    expect(
      all(m.tree).some((e) => e.props.role === "alert" && text(e).includes("doesn't read as YAML")),
    ).toBe(true);
  });

  it("renders without a DOM", () => {
    const out = renderToStaticMarkup(
      <MatchWithCopilot
        from="a"
        box={{ repo: "b" }}
        toName="b"
        calls={calls}
        apis={apis}
        onTake={() => undefined}
        io={{ get: async () => view("idle"), post: async () => view("idle") }}
      />,
    );
    expect(out).toContain(M.start);
    expect(out.replace(/&#x27;/g, "'")).toContain(M.intro);
  });
});
