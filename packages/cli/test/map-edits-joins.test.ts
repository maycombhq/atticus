import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { estateJoinHooks } from "../src/contract-check-files.js";
import { linkEstate, PROXY, REFUND_STATUS_ENTRY, type LinkEstate } from "./link-edit-estate.js";

/**
 * The integration review of beta.28.1 (S2b): Edit the map's Apply worked the estate's join out
 * once per pair edit (each edit wrote before the next one's pairing, so the join's stamp changed
 * and the kept join was missed), and once more inside the request, before the job: silent, with
 * no Stop. Now the request's check needs no join, and the Apply works out which pairs a call has
 * already once, before any write, as a step of its job. Files only, no network.
 */

let e: LinkEstate;
beforeAll(async () => {
  e = await linkEstate("atticus-map-edits-joins-");
}, 300_000);
afterAll(async () => {
  await e?.close();
  delete estateJoinHooks.onJoin;
});

describe("Edit the map's Apply joins the estate at most once", () => {
  it("two pair edits: one join, none in the request", async () => {
    let joins = 0;
    estateJoinHooks.onJoin = () => void joins++;
    const pair = (call: string) => ({
      kind: "add",
      pair: {
        from: PROXY,
        to: { repo: "forge-checkout" },
        pairs: [{ call, api: REFUND_STATUS_ENTRY }],
      },
    });
    const edits = [pair("call.get.refunds-id"), pair("call.post.payments")];
    // The check alone (a 422 for a bad edit) works out no join.
    const bad = await e.call("/api/map/edits", "POST", {
      edits: [...edits, { kind: "delete", delete: { interfaces: [], from: "a", to: "b" } }],
    });
    expect(bad.status, JSON.stringify(bad.body)).toBe(422);
    expect(joins).toBe(0);
    const ended = await e.job("/api/map/edits", { edits });
    expect(ended.state, JSON.stringify(ended)).toBe("done");
    expect(ended.result?.code, ended.result?.lines.join("\n")).toBe(0);
    expect(joins).toBeLessThanOrEqual(1);
  }, 300_000);
});
