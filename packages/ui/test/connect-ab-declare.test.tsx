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
vi.mock("../src/app/propose.js", () => ({ Propose: () => null }));
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
