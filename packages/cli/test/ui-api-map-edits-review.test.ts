import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acquireLock, LockHeldError, parseRecord, serializeRecord } from "@maycombhq/core";
import { listHooks, mapEditHooks } from "../src/catalog-build-commands.js";
import { linkEstate, PROXY, type Iface, type LinkEstate } from "./link-edit-estate.js";

/**
 * The review of beta.28's Edit the map, each finding as a test on `link-edit-estate.ts`'s
 * invented estate: a failed Apply puts every file back byte for byte with one outcome per change;
 * the build confirms only the removals this run's own decisions explain, and runs under the lock
 * the writes hold; two deletes are two links in Deleted links, whatever their names; a link a
 * person declared on the canvas is withdrawn from the profile, not suppressed; an arrow with no
 * call is a row's problem; a deleted link the build no longer makes says so. No network.
 */

let e: LinkEstate;
let root: string;
let lineless: Iface;
let lined: Iface;
const PROFILE = () => join(root, "org-pack", "profiles", "forge", "profile.yaml");
const DECISIONS = () => join(root, "catalog", "curated", "curateddecision");
const decisions = () =>
  existsSync(DECISIONS()) ? readdirSync(DECISIONS()).filter((n) => n.endsWith(".yaml")) : [];
/** A record parsed, or the test fails. */
const recordOf = (r: ReturnType<typeof parseRecord>) => {
  if (!r.ok) throw new Error(r.issues.map((i) => i.message).join("; "));
  return r.record;
};
const GET = "GET /northwind-pay/1.0/payments/{id}";
const POST = "POST /northwind-pay/1.0/payments";
const del = (i: Iface, from = "northwind-pay-proxy", to = i.to) => ({
  kind: "delete",
  delete: { interfaces: [i.id], from, to },
});

beforeAll(async () => {
  e = await linkEstate("atticus-map-edits-review-");
  ({ root, lineless, lined } = e);
}, 300_000);
afterAll(async () => {
  listHooks.afterList = undefined;
  mapEditHooks.beforeBuild = undefined;
  await e?.close();
});

describe("Edit the map, the review of beta.28", () => {
  it("says an arrow that names no call as its row's problem, and writes nothing", async () => {
    const r = await e.call("/api/map/edits", "POST", {
      edits: [del(lined), { kind: "delete", delete: { interfaces: [], from: "a", to: "b" } }],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect((r.body.problems as { edit: number }[]).map((p) => p.edit)).toEqual([1]);
    expect(decisions()).toEqual([]);
  });

  it("puts every file back byte for byte when a later change fails, one outcome per change", async () => {
    // Between the check and the writes, a person declares the third change by hand, in their
    // own layout (which a write of the whole file would reformat).
    const base = readFileSync(PROFILE(), "utf8");
    const hand = base.replace(
      "    aliases: [api.northwind-pay.example, devapi.northwind-pay.example]\n",
      `    aliases: [api.northwind-pay.example, devapi.northwind-pay.example] # by hand\n    calls:\n      - { route: ${POST} } # by hand\n`,
    );
    expect(hand).not.toBe(base);
    listHooks.afterList = async () => writeFileSync(PROFILE(), hand);
    const failed = await e.job("/api/map/edits", {
      edits: [
        del(lineless),
        { kind: "add", add: { kind: "call", system: "northwind-pay", route: GET } },
        { kind: "add", add: { kind: "call", system: "northwind-pay", route: POST } },
      ],
    });
    expect(failed.state).toBe("failed");
    expect(failed.result?.built).toBe(false);
    expect(
      (failed.result?.edits as { state: string; message?: string }[]).map((x) => x.state),
    ).toEqual(["taken-back", "taken-back", "failed"]);
    expect((failed.result?.edits as { message?: string }[])[2]!.message).toContain(POST);
    expect(failed.result?.lines.join("\n")).toContain("each file as it was");
    // Byte for byte as the hand left it (its flow lists, its comments), and no decision left.
    expect(readFileSync(PROFILE(), "utf8")).toBe(hand);
    expect(decisions()).toEqual([]);
    writeFileSync(PROFILE(), base);
  }, 240_000);

  it("confirms only its own removals: a teammate's pending suppress leaves the build refused", async () => {
    // A teammate's suppress of another arrow, pulled in and not built yet.
    mkdirSync(DECISIONS(), { recursive: true });
    const theirs = join(DECISIONS(), "cd-teammate-suppress.yaml");
    const rec = parseRecord({
      kind: "CuratedDecision",
      id: "cd-teammate-suppress",
      schemaVersion: 2,
      status: "current",
      confidence: "asserted",
      action: "suppress",
      target: lineless.id,
      value: null,
      reason: "Not ours any more (a teammate's).",
      by: "sam",
      at: "2026-11-12T09:00:00Z",
    });
    expect(rec.ok).toBe(true);
    writeFileSync(theirs, serializeRecord(recordOf(rec)));
    const ended = await e.job("/api/map/edits", { edits: [del(lined)] });
    expect(ended.result?.built, ended.result?.lines.join("\n")).toBe(false);
    expect((ended.result?.edits as { state: string }[])[0]!.state).toBe("saved");
    // The build's own refusal, listed for Catalog builds, the teammate's removal in it.
    const refused = ended.result?.refused as { removals?: { id: string }[] } | undefined;
    expect(refused?.removals?.map((x) => x.id)).toContain(lineless.id);
    const now = await e.interfaces();
    expect(now.some((i) => i.id === lineless.id)).toBe(true);
    expect(now.some((i) => i.id === lined.id)).toBe(true);
    // Back as it was: the teammate's file gone, ours brought back.
    rmSync(theirs);
    const listed = (await e.call("/api/links/deleted")).body.links as {
      decisions: { id: string }[];
    }[];
    const back = await e.job("/api/links/deleted/undo", {
      decisions: listed.flatMap((l) => l.decisions.map((d) => d.id)),
    });
    expect(back.result?.code, back.result?.lines.join("\n")).toBe(0);
  }, 240_000);

  it("builds under the lock the writes hold: no other writer gets in between", async () => {
    let held: unknown;
    mapEditHooks.beforeBuild = async () => {
      held = await acquireLock(root, "scan", "a terminal's verify").then(
        async (l) => {
          await l.release();
          return "taken";
        },
        (x: unknown) => x,
      );
    };
    const ended = await e.job("/api/map/edits", { edits: [del(lineless)] });
    mapEditHooks.beforeBuild = undefined;
    expect(held).toBeInstanceOf(LockHeldError);
    expect(ended.result?.built, ended.result?.lines.join("\n")).toBe(true);
  }, 240_000);

  it("lists two deletes of one Apply as two links, whatever their names hold", async () => {
    // The lineless one is deleted already (above); bring it back first.
    const before = (await e.call("/api/links/deleted")).body.links as {
      decisions: { id: string }[];
    }[];
    await e.job("/api/links/deleted/undo", {
      decisions: before.flatMap((l) => l.decisions.map((d) => d.id)),
    });
    const ended = await e.job("/api/map/edits", {
      edits: [
        del(lineless, "Proxy → edge", "Refunds (v2) → api"),
        del(lined, "Proxy → edge", "Payments"),
      ],
    });
    expect(ended.result?.code, ended.result?.lines.join("\n")).toBe(0);
    const links = (await e.call("/api/links/deleted")).body.links as {
      from: string;
      to: string;
      calls: number;
      decisions: { target: string }[];
    }[];
    expect(links.map((l) => [l.from, l.to, l.calls, l.decisions.map((d) => d.target)])).toEqual(
      expect.arrayContaining([
        ["Proxy → edge", "Refunds (v2) → api", 1, [lineless.id]],
        ["Proxy → edge", "Payments", 1, [lined.id]],
      ]),
    );
    expect(links).toHaveLength(2);
  }, 240_000);

  it("says a deleted link the build no longer makes", async () => {
    // A suppress of an Interface no read makes any more (its code moved on).
    const gone = join(DECISIONS(), "cd-link-delete-if-0000000000000000.yaml");
    const rec = parseRecord({
      kind: "CuratedDecision",
      id: "cd-link-delete-if-0000000000000000",
      schemaVersion: 2,
      status: "current",
      confidence: "asserted",
      action: "suppress",
      target: "if-0000000000000000",
      value: null,
      reason: 'Deleted on the canvas: the link "a" → "b" (1 call) [d-1-1].',
      by: "pat",
      at: "2026-11-01T09:00:00Z",
    });
    writeFileSync(gone, serializeRecord(recordOf(rec)));
    const links = (await e.call("/api/links/deleted")).body.links as {
      from: string;
      gone?: boolean;
    }[];
    expect(links.find((l) => l.from === "a")?.gone).toBe(true);
    expect(links.filter((l) => l.from !== "a").every((l) => !l.gone)).toBe(true);
    rmSync(gone);
  }, 120_000);

  it("withdraws a link declared on the canvas from the profile, rather than suppressing it", async () => {
    // Declared calls are joined through the gateway's facts: read the proxy from them first.
    await e.verify(PROXY);
    const added = await e.job("/api/map/edits", {
      edits: [{ kind: "add", add: { kind: "call", system: "northwind-pay", route: GET } }],
    });
    expect(added.result?.code, added.result?.lines.join("\n")).toBe(0);
    const declared = (await e.interfaces()).find(
      (i) => i.from === "northwind-pay" && i.method === "GET",
    )!;
    expect(declared).toBeDefined();
    const withIt = readFileSync(PROFILE(), "utf8");
    const before = decisions();
    const ended = await e.job("/api/map/edits", {
      edits: [del(declared, "Northwind Pay", "northwind-pay-proxy")],
    });
    expect(ended.result?.code, ended.result?.lines.join("\n")).toBe(0);
    expect(decisions()).toEqual(before);
    // Only the declaration's lines went.
    const now = readFileSync(PROFILE(), "utf8");
    expect(now).not.toContain(GET);
    expect(withIt.split("\n").filter((l) => !now.split("\n").includes(l))).toEqual([
      expect.stringMatching(/^\s*calls:\s*$/),
      expect.stringContaining(GET),
      expect.stringContaining("# declared by pat on"),
    ]);
    // Every other line as it was, in order.
    expect(now.split("\n")).toEqual(
      withIt.split("\n").filter((l) => !/calls:|payments\/\{id\}|# declared by pat/.test(l)),
    );
    expect((await e.interfaces()).some((i) => i.id === declared.id)).toBe(false);
  }, 300_000);
});
