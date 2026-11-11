import { describe, expect, it, vi } from "vitest";
import type { Api } from "@maycombhq/core";
import type { FactsView } from "../src/app/evidence.js";
import { all, mount, text } from "./support/hooks.js";

/**
 * Review of beta.24, round 4: All calls on this arrow are wrong never guesses which call on a
 * line is the arrow's. A line with exactly one call of the link's method and path is corrected; a
 * line with none, or several (two hosts, another arrow's call), lists its calls as checkboxes,
 * those of the link's path ticked at first, and the write sends exactly the ones ticked.
 */
vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});
const posted: { path: string; body: unknown }[] = [];
vi.mock("../src/api/client.js", async () => ({
  ...(await vi.importActual<object>("../src/api/client.js")),
  api: (path: string, o: { body: unknown }) => {
    posted.push({ path, body: o.body });
    return new Promise(() => {});
  },
  useApi: () => ({ state: "loading", reload: () => {} }),
}));
const { COPY } = await import("../src/copy.js");
const { ArrowWrong, ArrowWrongForm } = await import("../src/screens/architecture/WhyLinked.js");
const A = COPY.why.arrow;

type El = { type: unknown; props: Record<string, unknown> };
const call = (id: string, path: string, to: string, host?: string): Api.FactCiteViewT => ({
  id,
  kind: "call",
  label: `GET ${path} → ${to}`,
  claim: { method: "GET", path, to, value: path, ...(host ? { host } : {}) },
  cite: { file: "src/Ledger.java", line: 30, value: path },
  verified: "line",
  by: "assistant",
});
const facts = (...f: Api.FactCiteViewT[]): FactsView => ({
  repo: "forge-bridge",
  file: "facts/forge-bridge.jsonl",
  present: true,
  facts: f,
  corrections: { file: "facts/forge-bridge.corrections.jsonl", count: 0, stale: [] },
  questions: [],
  verify: "atticus verify forge-bridge",
  problems: [],
});
const join = (over: Partial<Api.HierJoinT>): Api.HierJoinT => ({
  interface: "if-accounts",
  from: "forge-bridge",
  to: "ledger-service",
  how: "host",
  gateway: false,
  verified: true,
  method: "GET",
  path: "/accounts/{}",
  caller: [{ source: "code", repo: "forge-bridge", at: "src/Ledger.java:30" }],
  callee: [],
  hops: [],
  other: [],
  ...over,
});
const edge = (joins: Api.HierJoinT[]): Api.HierEdgeT => ({
  id: "calls:system:bridge>system:ledger",
  from: "system:bridge",
  to: "system:ledger",
  type: "calls",
  count: joins.length,
  state: "current",
  gaps: [],
  evidence: [],
  joins,
});

/** The form, open, with `view` as the caller's facts; what it saves; its checkboxes by path. */
function form(joins: Api.HierJoinT[], view: FactsView) {
  const saved: Api.LinkCorrectionsRequestT[] = [];
  const m = mount(
    ArrowWrongForm as never,
    {
      link: edge(joins),
      viewOf: () => view,
      known: [],
      startOpen: true,
      onSave: (b: Api.LinkCorrectionsRequestT) => saved.push(b),
    } as never,
  );
  const els = () => all(m.tree) as El[];
  const boxes = () =>
    els()
      .filter((e) => e.type === "label" && e.props.className === "li-choice")
      .map((l) => ({
        text: text(l),
        input: all(l.props.children).find((e) => e.type === "input" && e.props.type === "checkbox"),
      }))
      .filter((b) => b.input);
  const tick = (part: string) => {
    const b = boxes().find((x) => x.text.includes(part))!;
    (b.input!.props.onChange as () => void)();
    m.render();
  };
  const ticked = () =>
    boxes()
      .filter((b) => b.input!.props.checked)
      .map((b) => b.text);
  const submit = () => {
    const reason = els().find((e) => e.type === "textarea")!;
    (reason.props.onChange as (e: unknown) => void)({ target: { value: "a probe" } });
    m.render();
    const notCall = els().find((e) => e.type === "input" && e.props.value === "not-a-call")!;
    (notCall.props.onChange as () => void)();
    m.render();
    const f = els().find((e) => e.type === "form")!;
    (f.props.onSubmit as (e: unknown) => void)({ preventDefault: () => {} });
    m.render();
  };
  const sent = () => saved.at(-1)?.items.map((i) => i.fact);
  return { m, boxes, tick, ticked, submit, sent, text: () => text(m.tree) };
}

describe("All calls on this arrow are wrong: the calls the person confirms", () => {
  it("a base path's call is corrected alone, beside another arrow's call", () => {
    const f = form(
      [join({ to: "forge-edge", how: "base-path" })],
      facts(
        call("c-via-edge", "/api/ledger/accounts/{id}", "forge-edge"),
        call("c-rates", "/rates", "northwind-fx"),
      ),
    );
    // Clear: nothing to ask.
    expect(f.boxes()).toEqual([]);
    expect(f.text()).not.toContain(A.pick.legend);
    f.submit();
    expect(f.sent()).toEqual(["c-via-edge"]);
  });

  it("two hosts of one method and path: the form asks, and sends exactly what is ticked", () => {
    const f = form(
      [join({})],
      facts(
        call("c-ledger-a", "/accounts/{id}", "ledger-a", "a.forge.example"),
        call("c-ledger-b", "/accounts/{id}", "ledger-b", "b.forge.example"),
      ),
    );
    expect(f.text()).toContain(A.pick.legend);
    expect(f.text()).toContain(A.pick.intro);
    // Each is said with its method, path, host and line; both of the path, so both ticked at first.
    expect(f.boxes().map((b) => b.text)).toEqual([
      A.pick.call("GET /accounts/{id}", "a.forge.example", "src/Ledger.java:30"),
      A.pick.call("GET /accounts/{id}", "b.forge.example", "src/Ledger.java:30"),
    ]);
    expect(f.ticked()).toHaveLength(2);
    expect(f.text()).toContain(A.save(2));
    f.tick("b.forge.example");
    expect(f.text()).toContain(A.save(1));
    f.submit();
    expect(f.sent()).toEqual(["c-ledger-a"]);
  });

  it("another arrow's /rates call on the line is never sent unless ticked", () => {
    const view = facts(
      call("c-quotes-a", "/accounts/{id}", "ledger-a", "a.forge.example"),
      call("c-quotes-b", "/accounts/{id}", "ledger-b", "b.forge.example"),
      call("c-rates", "/v1/rates/{pair}", "northwind-fx"),
    );
    const f = form([join({})], view);
    expect(f.ticked()).toEqual([
      A.pick.call("GET /accounts/{id}", "a.forge.example", "src/Ledger.java:30"),
      A.pick.call("GET /accounts/{id}", "b.forge.example", "src/Ledger.java:30"),
    ]);
    f.submit();
    expect(f.sent()).toEqual(["c-quotes-a", "c-quotes-b"]);
    // Ticked by the person, it is sent.
    const g = form([join({})], view);
    g.tick("/v1/rates/");
    g.submit();
    expect(g.sent()).toEqual(["c-quotes-a", "c-quotes-b", "c-rates"]);
  });

  it("no call of the link's path on the line: none ticked, and nothing written until one is", () => {
    const f = form(
      [join({ path: "/v2/quotes" })],
      facts(
        call("c-rates", "/v1/rates/{pair}", "northwind-fx"),
        call("c-limits", "/v1/limits", "x"),
      ),
    );
    expect(f.boxes()).toHaveLength(2);
    expect(f.ticked()).toEqual([]);
    f.submit();
    expect(f.sent()).toBeUndefined();
    expect(f.text()).toContain(A.pick.need);
    f.tick("/v1/limits");
    f.submit();
    expect(f.sent()).toEqual(["c-limits"]);
  });

  it("ArrowWrong posts exactly what the form confirmed", () => {
    const m = mount(ArrowWrong as never, { link: edge([join({})]), known: [] } as never);
    const el = m.tree as El;
    expect(el.type).toBe(ArrowWrongForm);
    const body = {
      items: [{ repo: "forge-bridge", fact: "c-ledger-a", action: "wrong" as const }],
    };
    (el.props.onSave as (b: unknown, l: string[]) => void)(body, [
      "forge-bridge:src/Ledger.java:30",
    ]);
    expect(posted.at(-1)).toEqual({ path: "/api/links/corrections", body });
  });
});
