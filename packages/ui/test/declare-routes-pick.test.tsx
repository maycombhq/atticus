import { describe, expect, it, vi } from "vitest";
import type { Api } from "@maycombhq/core";
import { all, mount, text } from "./support/hooks.js";
import { COPY } from "../src/copy.js";

/**
 * ADR 0200: picking routes in Declare a link. Ticked routes are previewed together and written
 * in one request; Write it writes only what was previewed. On the invented Forge estate.
 */

vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});
const { DeclarePanel } = await import("../src/screens/architecture/Declare.js");

const D = COPY.declare;
type View = Api.DeclarableRoutesViewT;
type Route = NonNullable<View["target"]>["routes"][number];
const route = (n: number, o: Partial<Route> = {}): Route => ({
  id: `entry.get.r${n}`,
  method: n % 2 ? "GET" : "POST",
  path: `/edge/audit/v1/r${n}`,
  handler: `edge/R${n}`,
  at: `apiproxy/proxies/default.xml:${n}`,
  say: `${n % 2 ? "GET" : "POST"} /edge/audit/v1/r${n}`,
  ...o,
});
const routes = Array.from({ length: 10 }, (_, k) => route(k + 1));
const FILE = "org-pack/profiles/forge/profile.yaml";
const result = (written: boolean): Api.FileChangeResultT => ({
  written,
  files: [{ file: FILE, changes: [] }],
  verify: "atticus verify --all --write",
  commit: "",
});
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

const open = (
  o: { target?: string } = { target: "forge-edge" },
  gateways = [
    { repo: "forge-edge", routes: 10 },
    { repo: "forge-edge-partner", routes: 1 },
  ],
) => {
  const sent: Api.DeclareLinkRequestT[] = [];
  const asked: (string | undefined)[] = [];
  let reloads = 0;
  const data = (repo: string | undefined): View => ({
    system: "harbor-audit",
    gateways,
    ...(repo === "forge-edge"
      ? { target: { repo, gateway: true, routes, entries: 10 } }
      : repo
        ? { target: { repo, gateway: true, routes: [route(40)], entries: 1 } }
        : {}),
  });
  const m = mount(
    DeclarePanel as never,
    {
      system: "harbor-audit",
      label: "Harbor Audit",
      ...o,
      onClose: () => undefined,
      post: (b: Api.DeclareLinkRequestT) => {
        sent.push(b);
        return Promise.resolve(result(!b.preview));
      },
      routesOf: (path: string | undefined) => {
        asked.push(path);
        const repo = path ? (new URLSearchParams(path.split("?")[1]).get("repo") ?? undefined) : "";
        return path
          ? { state: "ready", data: data(repo), reload: () => void reloads++ }
          : { state: "loading" };
      },
    } as never,
  );
  const els = () => all(m.tree);
  const boxes = () => els().filter((e) => e.type === "input" && e.props.type === "checkbox");
  const button = (label: string) =>
    els().find((e) => e.type === "button" && text(e.props.children) === label)!;
  const change = (e: { props: Record<string, unknown> }, target: Record<string, unknown>) => {
    (e.props.onChange as (x: unknown) => void)({ target });
    m.render();
  };
  const click = async (label: string) => {
    (button(label).props.onClick as () => void)();
    await tick();
    m.render();
  };
  return { m, els, boxes, button, change, click, sent, asked, reloads: () => reloads };
};

describe("picking the routes a system calls", () => {
  it("previews the ticked routes together, writes only what was previewed, in one request", async () => {
    const p = open();
    expect(p.boxes()).toHaveLength(10);
    expect(p.button(D.preview).props.disabled).toBe(true);
    p.change(p.boxes()[3]!, { checked: true });
    p.change(p.boxes()[0]!, { checked: true });
    expect(text(p.m.tree)).toContain(D.picked(2));
    expect(p.button(D.preview).props.disabled).toBe(false);
    // Nothing is written before a preview.
    expect(p.button(D.confirmN(2)).props.disabled).toBe(true);
    await p.click(D.preview);
    expect(p.sent).toEqual([
      {
        kind: "call",
        system: "harbor-audit",
        routes: ["GET /edge/audit/v1/r1", "POST /edge/audit/v1/r4"],
        preview: true,
      },
    ]);
    expect(p.button(D.confirmN(2)).props.disabled).toBe(false);
    // A tick changed after the preview: the write waits for a new preview.
    p.change(p.boxes()[1]!, { checked: true });
    expect(p.button(D.confirmN(3)).props.disabled).toBe(true);
    p.change(p.boxes()[1]!, { checked: false });
    expect(p.button(D.confirmN(2)).props.disabled).toBe(true);
    await p.click(D.preview);
    expect(p.button(D.confirmN(2)).props.disabled).toBe(false);
    await p.click(D.confirmN(2));
    expect(p.sent[2]).toEqual({
      kind: "call",
      system: "harbor-audit",
      routes: ["GET /edge/audit/v1/r1", "POST /edge/audit/v1/r4"],
    });
    // One request wrote both: the preview's, with nothing changed since.
    expect(p.sent).toHaveLength(3);
    expect({ ...p.sent[1], preview: undefined }).toEqual({ ...p.sent[2], preview: undefined });
    // Written: the routes are read again (they are declared now) and nothing stays ticked.
    expect(p.reloads()).toBe(1);
    expect(p.boxes().filter((b) => b.props.checked)).toHaveLength(0);
    expect(p.button(D.preview).props.disabled).toBe(true);
  });

  it("narrows the list as the person types, keeps what is ticked in sight, and ticks all shown", () => {
    const p = open();
    const search = () => p.els().find((e) => e.type === "input" && e.props.type === "search")!;
    p.change(p.boxes()[1]!, { checked: true });
    p.change(search(), { value: "get r7" });
    // GET …/r7, and the POST …/r2 ticked before.
    expect(p.boxes()).toHaveLength(2);
    expect(text(p.m.tree)).toContain(D.shown(2, 10));
    (p.button(D.pickShown(2)).props.onClick as () => void)();
    p.m.render();
    expect(text(p.m.tree)).toContain(D.picked(2));
    p.change(search(), { value: "edge/R9" });
    expect(p.boxes()).toHaveLength(3);
    p.change(search(), { value: "nothing-like-this" });
    expect(text(p.m.tree)).toContain(D.noMatch("nothing-like-this"));
    (p.button(D.unpickAll).props.onClick as () => void)();
    p.m.render();
    expect(text(p.m.tree)).toContain(D.picked(0));
  });

  it("on the system's own box: Calls a gateway route lists the gateways first, then the routes of the one picked", () => {
    const p = open({});
    expect(p.asked.at(-1)).toBeUndefined();
    const radio = () => p.els().filter((e) => e.type === "input" && e.props.type === "radio")[2]!;
    (radio().props.onChange as () => void)();
    p.m.render();
    expect(p.asked.at(-1)).toBe("/api/declared-links/routes?system=harbor-audit");
    const select = () => p.els().find((e) => e.type === "select")!;
    const options = () => all(select().props.children).filter((e) => e.type === "option");
    expect(options().map((o) => [o.props.value, text(o.props.children)])).toEqual([
      ["", D.gatewayNone],
      ["forge-edge", D.gatewayOption("forge-edge", 10)],
      ["forge-edge-partner", D.gatewayOption("forge-edge-partner", 1)],
    ]);
    expect(p.boxes()).toHaveLength(0);
    p.change(select(), { value: "forge-edge" });
    expect(p.asked.at(-1)).toBe("/api/declared-links/routes?system=harbor-audit&repo=forge-edge");
    expect(p.boxes()).toHaveLength(10);
    // Another gateway: what was ticked for the first isn't carried over.
    p.change(p.boxes()[0]!, { checked: true });
    p.change(select(), { value: "forge-edge-partner" });
    expect(p.boxes()).toHaveLength(1);
    expect(text(p.m.tree)).toContain(D.picked(0));
  });

  it("says when no repo read so far has a gateway route, and keeps the typed form", () => {
    const p = open({}, []);
    const radio = p.els().filter((e) => e.type === "input" && e.props.type === "radio")[2]!;
    (radio.props.onChange as () => void)();
    p.m.render();
    expect(text(p.m.tree)).toContain(D.noGateways);
    expect(p.els().find((e) => e.type === "select")).toBeUndefined();
    expect(text(p.m.tree)).toContain(D.route);
    expect(text(p.m.tree)).toContain(D.pickFirst);
  });

  it("still takes a route typed by hand, alone as before", async () => {
    const p = open();
    const typed = () =>
      p
        .els()
        .find(
          (e) => e.type === "input" && e.props.className === "field" && e.props.type !== "search",
        )!;
    p.change(typed(), { value: "POST /edge/audit/v1/not-read-yet" });
    await p.click(D.preview);
    expect(p.sent).toEqual([
      {
        kind: "call",
        system: "harbor-audit",
        route: "POST /edge/audit/v1/not-read-yet",
        preview: true,
      },
    ]);
  });
});
