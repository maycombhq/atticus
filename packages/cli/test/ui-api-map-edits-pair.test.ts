import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listUndo, undoDirOf } from "@maycombhq/scanner";
import {
  linkEstate,
  PROXY,
  REFUND_STATUS_ENTRY,
  type Iface,
  type LinkEstate,
} from "./link-edit-estate.js";

/**
 * Beta.28, Edit the map from a repo's box: an add or a redirect whose link starts in a repo is
 * Connect to…'s pairing (ADR 0174), exactly its `link` lines in `facts/<repo>.corrections.jsonl`,
 * the person's word that the repo's call goes to the other box's API. A redirect of a repo's
 * arrow is Delete this link's suppress of the old Interfaces and a pairing of the caller's call
 * to the new target. A lineless arrow (adopted, no caller's line) names no call, so the person
 * picks the caller's call it is; the pairing cites that call's own line. Files only, no network.
 */

let e: LinkEstate;
let root: string;
let lineless: Iface;
let lined: Iface;
const correctionsText = () => {
  try {
    return readFileSync(join(root, "facts", `${PROXY}.corrections.jsonl`), "utf8");
  } catch {
    return "";
  }
};
const lastBuild = async () => (await listUndo(await undoDirOf(root)))[0]?.n ?? 0;
/** The proxy's forwarding call the lineless arrow is (GET /refunds/{id}, default.xml:13). */
const CALL = "call.get.refunds-id";
const REDIRECT = () => ({
  kind: "redirect",
  delete: { interfaces: [lineless.id], from: "northwind-pay-proxy", to: "refunds-api" },
  pair: {
    from: PROXY,
    to: { repo: "forge-checkout" },
    pairs: [{ call: CALL, api: REFUND_STATUS_ENTRY }],
  },
});

beforeAll(async () => {
  e = await linkEstate("atticus-map-edits-pair-");
  ({ root, lineless, lined } = e);
}, 300_000);
afterAll(async () => {
  await e?.close();
});

describe("Edit the map from a repo's box: Connect to…'s pairing (beta.28)", () => {
  it("refuses a pairing of a call the repo hasn't, an API the box hasn't, or from another repo", async () => {
    const r = await e.call("/api/map/edits", "POST", {
      edits: [
        {
          kind: "add",
          pair: {
            from: PROXY,
            to: { repo: "forge-checkout" },
            pairs: [{ call: "call.nothing", api: REFUND_STATUS_ENTRY }],
          },
        },
        {
          kind: "add",
          pair: {
            from: PROXY,
            to: { repo: "forge-checkout" },
            pairs: [{ call: CALL, api: "entry.nothing" }],
          },
        },
        { ...REDIRECT(), pair: { ...REDIRECT().pair, from: "forge-checkout" } },
      ],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    const problems = r.body.problems as { edit: number; message: string }[];
    expect(problems.map((p) => p.edit)).toEqual([0, 1, 2]);
    expect(problems[0]!.message).toContain("call.nothing");
    expect(problems[1]!.message).toContain("entry.nothing");
    expect(problems[2]!.message).toContain(PROXY);
    expect(correctionsText()).toBe("");
  });

  it("refuses a lined arrow's redirect that pairs a call that isn't the arrow's", async () => {
    // The lined arrow is the proxy's POST /payments (default.xml:7); GET /refunds/{id} isn't it.
    const r = await e.call("/api/map/edits", "POST", {
      edits: [
        {
          kind: "redirect",
          delete: { interfaces: [lined.id], from: "northwind-pay-proxy", to: "payments-api" },
          pair: {
            from: PROXY,
            to: { repo: "forge-checkout" },
            pairs: [{ call: CALL, api: REFUND_STATUS_ENTRY }],
          },
        },
      ],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    const problems = r.body.problems as { edit: number; message: string }[];
    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toContain(`${CALL} (apiproxy/proxies/default.xml:13)`);
    // Its own call is fine.
    const ok = await e.call("/api/map/edits", "POST", {
      edits: [
        {
          kind: "redirect",
          delete: { interfaces: [lined.id], from: "northwind-pay-proxy", to: "payments-api" },
          pair: {
            from: PROXY,
            to: { repo: "forge-checkout" },
            pairs: [{ call: "call.post.payments", api: REFUND_STATUS_ENTRY }],
          },
        },
        { kind: "delete", delete: { interfaces: [], from: "a", to: "b" } },
      ],
    });
    // Only the empty delete (kept there so nothing is written) is a problem.
    expect((ok.body.problems as { edit: number }[]).map((x) => x.edit)).toEqual([1]);
    expect(correctionsText()).toBe("");
  });

  it("redirects a lineless adopted arrow to another repo: a suppress and a pairing, one build", async () => {
    const before = await lastBuild();
    const ended = await e.job("/api/map/edits", { edits: [REDIRECT()] });
    expect(ended.state, JSON.stringify(ended)).toBe("done");
    expect(ended.result?.code, ended.result?.lines.join("\n")).toBe(0);
    expect(ended.result?.built).toBe(true);
    expect(ended.result?.callers).toEqual([PROXY]);
    // The checkout isn't read from its facts yet (adopted): the new arrow waits on it too.
    expect(ended.result?.waitsOn).toEqual(["forge-checkout"]);
    expect(await lastBuild()).toBe(before + 1);
    expect((await e.interfaces()).some((i) => i.id === lineless.id)).toBe(false);
    // Deleted links says the old link was redirected, not just deleted.
    const listed = (await e.call("/api/links/deleted")).body.links as { redirect?: boolean }[];
    expect(listed.map((l) => l.redirect)).toEqual([true]);
    // Connect to…'s line, exactly: the call's own cited line, linked to the checkout's entry.
    const lines = correctionsText().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const c = JSON.parse(lines[0]!) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- a corrections line, read loosely
    expect(c).toMatchObject({
      fact: CALL,
      action: "link",
      target: { kind: "call", file: "apiproxy/proxies/default.xml", line: 13 },
      link: {
        repo: "forge-checkout",
        entry: REFUND_STATUS_ENTRY,
        method: "GET",
        path: "/refund-status/{id}",
      },
      by: "pat",
    });
    // The checkout box lists it as a pairing, with Undo, as for any Connect to….
    const box = (await e.call(`/api/boxes/corrections?repo=${PROXY}`)).body.items as {
      kind: string;
    }[];
    expect(box.map((x) => x.kind)).toEqual(["link"]);
  }, 240_000);

  it("draws the new arrow and keeps the old one gone after verify --write of the caller and a build", async () => {
    // The caller read again (Re-read the repos these touch), and the repo it waits on.
    await e.verify(PROXY);
    await e.verify("forge-checkout");
    const { main } = await import("../src/main.js");
    const said: string[] = [];
    expect(
      await main(["catalog", "build", "--root", root], {
        out: (l) => said.push(l),
        err: (l) => said.push(l),
      }),
      said.join("\n"),
    ).toBe(0);
    const now = await e.interfaces();
    expect(now.some((i) => i.id === lineless.id)).toBe(false);
    const drawn = now.filter((i) => i.from === "northwind-pay-proxy" && i.to === "checkout-api");
    expect(drawn.map((i) => `${i.method} ${i.normalizedPath}`)).toEqual(["GET /refund-status/{}"]);
    // Its caller's line is the call's own.
    expect(drawn[0]!.evidence.some((x) => x.side === "caller")).toBe(true);
  }, 300_000);
});
