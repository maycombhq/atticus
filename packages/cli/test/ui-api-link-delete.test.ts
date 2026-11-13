import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { linkEstate, type Iface, type LinkEstate } from "./link-edit-estate.js";

/**
 * Beta.28 (the owner's decision of 2026-11-12: "an arrow for an architect must be as simple as
 * clicking delete"): Delete this link on any link of the canvas, lined or lineless, derived or
 * adopted from a catalog before the slots. The metarepo is `link-edit-estate.ts`'s, with an
 * adopted arrow that cites no line of its caller's: the arrow This link is wrong can't correct. Delete writes the person's curated suppress of each Interface
 * behind the link (the decision `atticus catalog edits --curate` writes for a deleted file) and
 * builds, as one local job whose lines are its Console entry; Bring back removes the decision and
 * builds again. Files only, no network (CLAUDE.md rule 5).
 */

let e: LinkEstate;
let root: string;
let lineless: Iface;
let lined: Iface;
const call = (path: string, method?: string, body?: unknown) => e.call(path, method, body);
const job = (path: string, body: unknown) => e.job(path, body);
const interfaces = () => e.interfaces();

beforeAll(async () => {
  e = await linkEstate("atticus-link-delete-");
  ({ root, lineless, lined } = e);
}, 300_000);
afterAll(async () => {
  await e?.close();
});

const decisionFile = (id: string) =>
  join(root, "catalog", "curated", "curateddecision", `${id}.yaml`);

describe("Delete this link (beta.28)", () => {
  it("refuses an empty list, a record that isn't an Interface of the catalog, and a bad body", async () => {
    expect((await call("/api/links/delete", "POST", { interfaces: [] })).status).toBe(400);
    expect(
      (await call("/api/links/delete", "POST", { interfaces: ["if-nothing"], from: "a", to: "b" }))
        .status,
    ).toBe(404);
    expect((await call("/api/links/delete", "POST", { interfaces: "x" })).status).toBe(400);
    expect((await call("/api/links/deleted/undo", "POST", { decisions: ["cd-x"] })).status).toBe(
      404,
    );
    // Nothing deleted yet.
    expect((await call("/api/links/deleted")).body).toEqual({ links: [] });
  });

  it("takes away a lineless arrow adopted from a beta.26 catalog, as a curated suppress, and brings it back", async () => {
    // The arrow is one the upgrade adopted into the legacy joins slot, not one the facts derive.
    const legacy = join(root, "catalog", "sources", "legacy", "joins.json");
    expect(readFileSync(legacy, "utf8")).toContain(lineless.id);

    const ended = await job("/api/links/delete", {
      interfaces: [lineless.id],
      from: "northwind-pay-proxy",
      to: "refunds-api",
    });
    expect(ended.state, JSON.stringify(ended)).toBe("done");
    expect(ended.result?.code, ended.result?.lines.join("\n")).toBe(0);
    // Its lines are the job's Console entry: the decision written, then the build's own.
    expect(ended.result?.lines.some((l) => l.includes("curateddecision"))).toBe(true);
    expect((await interfaces()).some((i) => i.id === lineless.id)).toBe(false);
    expect((await interfaces()).some((i) => i.id === lined.id)).toBe(true);

    // The decision is the one a deleted generated file becomes: a suppress of the Interface.
    const listed = await call("/api/links/deleted");
    expect(listed.status).toBe(200);
    expect(listed.body.links).toHaveLength(1);
    const link = listed.body.links[0];
    expect(link).toMatchObject({ from: "northwind-pay-proxy", to: "refunds-api", by: "pat" });
    expect(link.decisions).toHaveLength(1);
    const d = link.decisions[0];
    expect(d.target).toBe(lineless.id);
    const rec = parse(readFileSync(decisionFile(d.id), "utf8")) as Record<string, unknown>;
    expect(rec).toMatchObject({
      kind: "CuratedDecision",
      action: "suppress",
      target: lineless.id,
      value: null,
      status: "current",
      confidence: "asserted",
      by: "pat",
    });
    expect(d.file).toBe(`catalog/curated/curateddecision/${d.id}.yaml`);

    // Deleting it again: it isn't on the map any more.
    const again = await call("/api/links/delete", "POST", {
      interfaces: [lineless.id],
      from: "northwind-pay-proxy",
      to: "refunds-api",
    });
    expect(again.status).toBe(404);

    // Bring back: the decision goes, and the next build draws the arrow again.
    const back = await job("/api/links/deleted/undo", { decisions: [d.id] });
    expect(back.state, JSON.stringify(back)).toBe("done");
    expect(back.result?.code, back.result?.lines.join("\n")).toBe(0);
    expect(existsSync(decisionFile(d.id))).toBe(false);
    expect((await interfaces()).some((i) => i.id === lineless.id)).toBe(true);
    expect((await call("/api/links/deleted")).body).toEqual({ links: [] });
  }, 240_000);

  it("takes away a lined arrow the facts derive, every call of the link in one job", async () => {
    const both = (await interfaces()).filter(
      (i) => i.from === "northwind-pay-proxy" && i.to === "payments-api",
    );
    expect(both.length).toBeGreaterThan(1);
    const ended = await job("/api/links/delete", {
      interfaces: both.map((i) => i.id),
      from: "northwind-pay-proxy",
      to: "payments-api",
    });
    expect(ended.result?.code, ended.result?.lines.join("\n")).toBe(0);
    const now = await interfaces();
    for (const i of both) expect(now.some((x) => x.id === i.id)).toBe(false);
    const listed = (await call("/api/links/deleted")).body.links;
    expect(listed).toHaveLength(1);
    expect(listed[0].decisions.map((x: { target: string }) => x.target).sort()).toEqual(
      both.map((i) => i.id).sort(),
    );
    const back = await job("/api/links/deleted/undo", {
      decisions: listed[0].decisions.map((x: { id: string }) => x.id),
    });
    expect(back.result?.code, back.result?.lines.join("\n")).toBe(0);
    const after = await interfaces();
    for (const i of both) expect(after.some((x) => x.id === i.id)).toBe(true);
  }, 240_000);
});
