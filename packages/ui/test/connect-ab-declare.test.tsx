import { describe, expect, it, vi } from "vitest";
import type { Api } from "@maycombhq/core";
import { all, mount, text } from "./support/hooks.js";
import { COPY } from "../src/copy.js";

/**
 * ADR 0204 decision 2 in the panel: one button previews, writes and applies (POST
 * /api/map/edits with one `link`), says the arrow is on the map with Show the arrow, Undo
 * (exactly what it wrote) and Propose; a refusal is said with its words. Invented Forge names.
 */

vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});
vi.mock("../src/app/propose.js", () => ({ Propose: () => null, RefusalLink: () => null }));
const { DeclareArrow } = await import("../src/screens/architecture/ConnectAB.js");

const W = COPY.connectAB;
const WHY = "The proxy's target is set at deploy time.";
const v: Api.ConnectViewT = {
  from: { repo: "forge-edge-proxy" },
  to: { repo: "forge-ledger-svc" },
  fromName: "forge-edge-proxy",
  toName: "forge-ledger-svc",
  mechanism: "declare",
  needs: [],
  existing: 0,
};
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const WROTE = [
  {
    edit: 0,
    file: "org-pack/profiles/forge/profile.yaml",
    link: { ...v, why: WHY, by: "pat", at: "2026-11-18T10:02:00Z", file: "x" },
  },
];

function open(fail?: string) {
  const sent: { path: string; body: unknown }[] = [];
  let shown = 0;
  const m = mount(
    DeclareArrow as never,
    {
      v,
      onShown: () => void shown++,
      io: {
        post: (path: string, body: unknown) => {
          sent.push({ path, body });
          return Promise.resolve({
            written: false,
            files: [
              { file: "org-pack/profiles/forge/profile.yaml", changes: [{ now: `why: ${WHY}` }] },
            ],
            verify: "",
            commit: "",
          });
        },
        follow: (path: string, body: unknown) => {
          sent.push({ path, body });
          if (fail) return Promise.reject(new Error(fail));
          return Promise.resolve({ code: 0, lines: [], result: { built: true, wrote: WROTE } });
        },
      },
    } as never,
  );
  const els = () => all(m.tree);
  const button = (name: string) =>
    els().find((e) => e.type === "button" && text(e.props.children) === name)!;
  return { m, els, button, sent, shown: () => shown };
}

describe("the declare button (ADR 0204 2.1 to 2.4)", () => {
  it("waits for a reason, then previews, writes and applies in one go, and offers Undo", async () => {
    const t = open();
    expect(t.button(W.declare).props.disabled).toBe(true);
    const why = t.els().find((e) => e.type === "textarea")!;
    (why.props.onChange as (e: unknown) => void)({ target: { value: WHY } });
    t.m.render();
    expect(t.button(W.declare).props.disabled).toBe(false);
    (t.button(W.declare).props.onClick as () => void)();
    for (let n = 0; n < 5; n++) await tick();
    t.m.render();
    expect(t.sent.map((x) => x.path)).toEqual(["/api/declared-links", "/api/map/edits"]);
    expect(t.sent[0]!.body).toMatchObject({ kind: "link", why: WHY, preview: true });
    expect(t.sent[1]!.body).toEqual({
      edits: [{ kind: "add", add: { kind: "link", from: v.from, to: v.to, why: WHY } }],
    });
    const said = text(t.m.tree);
    expect(said).toContain(W.connected("forge-edge-proxy", "forge-ledger-svc"));
    expect(said).toContain(W.notProposed);
    expect(said).toContain(`why: ${WHY}`);
    (t.button(W.show).props.onClick as () => void)();
    expect(t.shown()).toBe(1);
    (t.button(W.undo).props.onClick as () => void)();
    for (let n = 0; n < 5; n++) await tick();
    t.m.render();
    expect(t.sent.at(-1)).toEqual({ path: "/api/map/edits/undo", body: { wrote: WROTE } });
    expect(text(t.m.tree)).toContain(W.undone);
  });

  it("says a refusal in its words, and writes nothing more", async () => {
    const t = open("forge-edge-proxy already calls forge-ledger-svc: 2 calls read from code.");
    const why = t.els().find((e) => e.type === "textarea")!;
    (why.props.onChange as (e: unknown) => void)({ target: { value: WHY } });
    t.m.render();
    (t.button(W.declare).props.onClick as () => void)();
    for (let n = 0; n < 5; n++) await tick();
    t.m.render();
    const alert = t.els().find((e) => e.props.role === "alert");
    expect(text(alert)).toContain("already calls forge-ledger-svc");
  });
});

describe("what is missing, in the same write (ADR 0204 3.1, 1.3)", () => {
  const say = "GET /billing/v1/statements/{id}";
  const mountWith = (props: Record<string, unknown>) => {
    const sent: { path: string; body: unknown }[] = [];
    const m = mount(
      DeclareArrow as never,
      {
        ...props,
        io: {
          post: (path: string, body: unknown) => {
            sent.push({ path, body });
            return Promise.resolve({ written: false, files: [], verify: "", commit: "" });
          },
          follow: (path: string, body: unknown) => {
            sent.push({ path, body });
            return Promise.resolve({ code: 0, lines: [], result: { built: true, wrote: [] } });
          },
          routes: () => ({
            state: "ready",
            data: {
              system: "northwind-cards",
              inProfile: true,
              gateways: [],
              target: {
                repo: "forge-edge-proxy",
                gateway: true,
                entries: 1,
                routes: [{ id: "r-1", path: "/billing/v1/statements/{id}", at: "a.xml:4", say }],
              },
            },
          }),
        },
      } as never,
    );
    const els = () => all(m.tree);
    const button = () => els().find((e) => e.type === "button")!;
    return { m, els, button, sent };
  };

  it("adds the system only the code names with the arrow, its button saying so", async () => {
    const t = mountWith({
      v: { ...v, from: { system: "harbor-unknown" } },
      addSystem: { name: "harbor-unknown", boundary: "internal" },
    });
    expect(text(t.button().props.children)).toBe(W.addAndGo("harbor-unknown"));
    const why = t.els().find((e) => e.type === "textarea")!;
    (why.props.onChange as (e: unknown) => void)({ target: { value: WHY } });
    t.m.render();
    (t.button().props.onClick as () => void)();
    for (let n = 0; n < 5; n++) await tick();
    expect(t.sent[1]!.body).toMatchObject({
      edits: [
        { add: { kind: "link", addSystem: { name: "harbor-unknown", boundary: "internal" } } },
      ],
    });
  });

  it("declares the routes ticked under Say which routes, in place of the arrow", async () => {
    const t = mountWith({ v: { ...v, from: { system: "northwind-cards" }, routes: true } });
    // RoutesFold is its own component: render it with the form's own props.
    const fold = t.els().find((e) => typeof e.props.onPick === "function")!;
    (fold.props.onPick as (s: Set<string>) => void)(new Set([say]));
    t.m.render();
    expect(text(t.button().props.children)).toBe(W.declareRoutes(1));
    expect(t.button().props.disabled).toBe(false);
    (t.button().props.onClick as () => void)();
    for (let n = 0; n < 5; n++) await tick();
    expect(t.sent[0]).toEqual({
      path: "/api/declared-links",
      body: { kind: "call", system: "northwind-cards", routes: [say], preview: true },
    });
    expect(t.sent[1]!.body).toEqual({
      edits: [{ kind: "add", add: { kind: "call", system: "northwind-cards", route: say } }],
    });
  });
});

describe("Retire the declared arrow (ADR 0204 1.7, the review)", () => {
  it("previews the lines it removes, then takes the item out and builds through Undo's job", async () => {
    const { RetireArrow } = await import("../src/screens/architecture/ConnectAB.js");
    const d = { ...WROTE[0]!.link, file: "org-pack/profiles/forge/profile.yaml" };
    const sent: { path: string; body: unknown }[] = [];
    const m = mount(
      RetireArrow as never,
      {
        d,
        retire: true,
        io: {
          post: (path: string, body: unknown) => {
            sent.push({ path, body });
            return Promise.resolve({
              written: false,
              files: [{ file: d.file, changes: [{ was: `why: ${WHY}` }] }],
              verify: "",
              commit: "",
            });
          },
          follow: (path: string, body: unknown) => {
            sent.push({ path, body });
            return Promise.resolve({ code: 0, lines: [], result: { built: true } });
          },
        },
      } as never,
    );
    const button = (name: string) =>
      all(m.tree).find((e) => e.type === "button" && text(e.props.children) === name)!;
    (button(W.retire).props.onClick as () => void)();
    for (let n = 0; n < 4; n++) await tick();
    m.render();
    expect(text(m.tree)).toContain(`- why: ${WHY}`);
    expect(sent[0]).toMatchObject({
      path: "/api/declared-links/undo",
      body: { kind: "link", preview: true },
    });
    (button(W.retireConfirm(W.retire)).props.onClick as () => void)();
    for (let n = 0; n < 4; n++) await tick();
    m.render();
    expect(sent[1]).toEqual({
      path: "/api/map/edits/undo",
      body: { wrote: [{ edit: 0, file: d.file, link: d }] },
    });
    expect(text(m.tree)).toContain(W.retired);
  });
});

describe("Remove it's words outlive the view it reloads (ADR 0204 1.7, journey 39)", () => {
  it("hands its words up when the panel reloads, and says them only there", async () => {
    const { RetireArrow } = await import("../src/screens/architecture/ConnectAB.js");
    const d = { ...WROTE[0]!.link, file: "org-pack/profiles/forge/profile.yaml" };
    const said: string[] = [];
    const m = mount(
      RetireArrow as never,
      {
        d,
        retire: false,
        onDone: (w: string) => said.push(w),
        io: {
          post: () =>
            Promise.resolve({
              written: false,
              files: [{ file: d.file, changes: [{ was: `why: ${WHY}` }] }],
              verify: "",
              commit: "",
            }),
          follow: () => Promise.resolve({ code: 0, lines: [], result: { built: true } }),
        },
      } as never,
    );
    const button = (name: string) =>
      all(m.tree).find((e) => e.type === "button" && text(e.props.children) === name)!;
    (button(W.remove).props.onClick as () => void)();
    for (let n = 0; n < 4; n++) await tick();
    m.render();
    (button(W.retireConfirm(W.remove)).props.onClick as () => void)();
    for (let n = 0; n < 4; n++) await tick();
    m.render();
    expect(said).toEqual([W.retired]);
    // Said once, by the panel that outlives the reload, never twice while both are drawn.
    expect(text(m.tree)).not.toContain(W.retired);
    // Nothing left to press twice while the panel reads the boxes again.
    expect(all(m.tree).some((e) => e.type === "button")).toBe(false);
  });

  it("keeps the words for these two boxes through the reload that drops the declared arrow", async () => {
    const { ConnectAB } = await import("../src/screens/architecture/ConnectAB.js");
    const a = { label: "repo: forge-edge-proxy", box: v.from };
    const b = { label: "repo: forge-ledger-svc", box: v.to };
    let view: Api.ConnectViewT = {
      ...v,
      mechanism: "declared",
      declared: { ...WROTE[0]!.link, file: "org-pack/profiles/forge/profile.yaml" },
    };
    const m = mount(
      ConnectAB as never,
      {
        a,
        b,
        boxes: [a, b],
        onClose: () => undefined,
        io: { read: () => ({ state: "ready", data: view, reload: () => undefined }) },
      } as never,
    );
    const mech = () => all(m.tree).find((e) => typeof e.props.onSaid === "function")!;
    (mech().props.onSaid as (w: string) => void)(W.retired);
    view = { ...v, mechanism: "declare" };
    m.render();
    expect(text(m.tree)).toContain(W.retired);
  });
});

describe("a find whose build refused (ADR 0204 A.2, the second review)", () => {
  it("says saved, not built, tells no outcome, and reads the answer again on", async () => {
    const { FindButton } = await import("../src/screens/architecture/ConnectAB.js");
    const asked: Api.ConnectFindRequestT[] = [];
    let reloads = 0;
    const notBuilt = {
      message: "Saved, not built",
      lines: ["The build found records edited by hand."],
      refused: {
        reasons: ["hand-edits" as const],
        message: "edited by hand",
        command: "atticus verify forge-edge-proxy --write --discard-edits 1",
      },
      command: "atticus connect find forge-edge-proxy --to forge-ledger-svc --read",
    };
    const m = mount(
      FindButton as never,
      {
        v: { ...v, mechanism: "declared" },
        reload: () => void reloads++,
        io: {
          find: (body: Api.ConnectFindRequestT) => {
            asked.push(body);
            return Promise.resolve({ brief: "facts/x.find.md", leftOut: [], notBuilt });
          },
        },
      } as never,
    );
    const button = (name: string) =>
      all(m.tree).find((e) => e.type === "button" && text(e.props.children) === name);
    (button(W.find)!.props.onClick as () => void)();
    for (let n = 0; n < 4; n++) await tick();
    m.render();
    expect(text(m.tree)).toContain(W.findNotBuilt("forge-edge-proxy"));
    expect(text(m.tree)).toContain("The build found records edited by hand.");
    // WCAG 1.4.10: verify's lines wrap.
    expect(all(m.tree).find((e) => e.type === "pre")?.props.style).toMatchObject({
      whiteSpace: "pre-wrap",
    });
    expect(reloads).toBe(0);
    (button(W.readAnswer)!.props.onClick as () => void)();
    for (let n = 0; n < 4; n++) await tick();
    expect(asked.at(-1)).toMatchObject({ read: true });
  });
});
