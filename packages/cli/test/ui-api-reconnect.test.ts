import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Api } from "@maycombhq/core";
import { verifyCommand } from "../src/verify-commands.js";
import {
  A,
  AT,
  B,
  C,
  CALLS,
  COMMIT,
  GATEWAY,
  VENDOR,
  reconnectEstate,
  type Json,
  type ReconnectEstate,
} from "./reconnect-estate.js";

/**
 * Beta.30 (the owner's field report: "the map shows a connection to the wrong repo; when I try
 * to reconnect it with the actual one it refuses, saying 0 calls to pair"). On the invented
 * estate of `fixtures/reconnect/`, forge-orders' seven calls each go to the wrong box by a
 * different way: (a) its address, (b) the assistant's fact, (c) an answered question, (d) another
 * person's pairing, (e) the person's own pairing, (f) a gateway's route, (g) an outside system.
 * Connect forge-orders to forge-ledger lists every one with where it goes today and how that was
 * decided, previews its move with no refusal, writes the person's pairing, and Apply moves the
 * arrow with its removal explained and no removal confirm.
 */

const WHY = "The billing host is the old name: ledger serves these since the split.";
type Way = keyof typeof CALLS;
/** The calls whose cited line names another box: moved only with a reason. */
const NAMED: Way[] = ["host", "fact", "gateway", "outside"];
const pairOf = (k: Way) => ({ ...CALLS[k], ...(NAMED.includes(k) ? { reason: WHY } : {}) });

let e: ReconnectEstate;
let question: string;
const row = (v: Api.LinkCandidatesViewT, k: Way) => v.calls.find((c) => c.fact === CALLS[k].call)!;
const preview = (pairs: unknown[]) =>
  e.call("/api/links/connect", "POST", { from: A, to: { repo: B }, pairs, preview: true });
const apply = async () => {
  // As a person's Apply runs it: `atticus verify forge-orders --write`, nothing confirmed.
  const out: string[] = [];
  const code = await verifyCommand(
    e.root,
    A,
    { commit: COMMIT[A]!, dir: join(e.root, "workspace", A), write: true, now: () => AT },
    { out: (l) => out.push(l), err: (l) => out.push(`ERR ${l}`) },
  );
  return { code, out };
};

beforeAll(async () => {
  e = await reconnectEstate("b30-rc-api-");
  // (c): the question about the host nothing names, answered forge-billing; then applied.
  const q = ((await e.call("/api/questions")).body.questions as Json[]).find((x) =>
    String(x.question).includes("fees.forge.internal"),
  )!;
  question = q.id as string;
  const a = await e.call(`/api/questions/${question}/answer`, "POST", { option: 1 });
  expect(a.status, JSON.stringify(a.body)).toBe(200);
  await e.verify(A);
}, 300_000);
afterAll(async () => e?.close());

describe("it's connected to the wrong box: Connect forge-orders to forge-ledger", () => {
  it("starts with every call joined to the wrong box", async () => {
    expect(await e.arrows()).toEqual({ [C]: 6, [VENDOR]: 1 });
  });

  it("lists each call with where it goes today and how that was decided, none picked for the person", async () => {
    const v = await e.candidates({ repo: B });
    expect(v.calls).toHaveLength(7);
    for (const k of Object.keys(CALLS) as Way[]) {
      const c = row(v, k);
      expect([k, c.status, c.joins]).toEqual([k, "joined", k === "outside" ? VENDOR : C]);
      // The API it most likely is, offered and never ticked.
      expect([k, c.suggestion?.api, c.confident]).toEqual([k, CALLS[k].api, undefined]);
    }
    // (a) matched by its address: the line writes forge-billing's host.
    expect(row(v, "host").how).toEqual({ by: "address" });
    expect(row(v, "host").codeNames).toEqual({ box: C, text: "billing.forge.example" });
    // (b) the assistant's fact names forge-billing.
    expect(row(v, "fact").how).toEqual({ by: "code" });
    expect(row(v, "fact").codeNames).toEqual({ box: C, text: C });
    // (c) a person's answer to a question: who, when and which.
    expect(row(v, "answer").how).toMatchObject({ by: "answer", who: "pat", question });
    expect(Date.parse(row(v, "answer").how!.at!)).not.toBeNaN();
    expect(row(v, "answer").codeNames).toBeUndefined();
    // (d), (e) a person's pairing: who and when.
    expect(row(v, "theirs").how).toEqual({
      by: "paired",
      who: "sam",
      at: "2026-11-10T09:00:00.000Z",
    });
    expect(row(v, "mine").how).toMatchObject({ by: "paired", who: "pat" });
    expect(row(v, "theirs").codeNames).toBeUndefined();
    // (f) through the gateway's route, which forwards it to forge-billing.
    expect(row(v, "gateway").how).toEqual({ by: "gateway", through: GATEWAY });
    expect(row(v, "gateway").codeNames).toEqual({ box: GATEWAY, text: "gw.forge.example" });
    // (g) an outside system the fact names.
    expect(row(v, "outside").how).toEqual({ by: "code" });
    expect(row(v, "outside").codeNames).toEqual({ box: VENDOR, text: VENDOR });
  });

  it.each(Object.keys(CALLS) as Way[])(
    "previews the move of the call joined by %s: its line, the arrow moved, and no refusal",
    async (k) => {
      const p = await preview([pairOf(k)]);
      expect(p.status, JSON.stringify(p.body)).toBe(200);
      const r = Api.ConnectLinksResult.parse(p.body);
      expect(r.written).toBe(false);
      expect(r.lines).toHaveLength(1);
      expect(JSON.parse(r.lines[0]!)).toMatchObject({
        fact: CALLS[k].call,
        action: "link",
        link: { repo: B, entry: CALLS[k].api },
        by: "pat",
        ...(NAMED.includes(k) ? { reason: WHY } : {}),
      });
      const v = Api.VerifyPreviewView.parse(r.preview).preview!;
      // Exactly what Apply changes: this call's arrow goes from the wrong box to forge-ledger.
      expect(v.links?.moved?.map((m) => [m.was, m.to])).toEqual([
        [k === "outside" ? VENDOR : C, B],
      ]);
      expect(v.catalog?.removed).toBe(1);
      // Never "Apply will refuse": the removal is the move's own.
      expect(v.confirm, JSON.stringify(v.confirm)).toBeUndefined();
    },
  );

  it("asks for a reason before overriding what the code names, and takes any other move without", async () => {
    for (const k of NAMED) {
      const p = await preview([CALLS[k]]);
      expect([k, p.status]).toEqual([k, 409]);
      expect(String(p.body.detail)).toContain("say why");
    }
    expect(String((await preview([CALLS.host])).body.detail)).toBe(
      `call.get.holds-id's line (src/main/java/forge/orders/OrdersClient.java:8) names billing.forge.example, which is ${C}'s: pairing it with ${B} overrides what the code says. To do that, say why (a reason of a few words), and it is kept with your pairing.`,
    );
    for (const k of ["answer", "theirs", "mine"] as const)
      expect([k, (await preview([CALLS[k]])).status]).toEqual([k, 200]);
  });

  it("moves them all: the pairings written, and Apply moves every arrow, each removal explained, nothing to confirm", async () => {
    const pairs = (Object.keys(CALLS) as Way[]).map(pairOf);
    const w = await e.call("/api/links/connect", "POST", { from: A, to: { repo: B }, pairs });
    expect(w.status, JSON.stringify(w.body)).toBe(200);
    expect(Api.ConnectLinksResult.parse(w.body).lines).toHaveLength(7);
    // The facts are as read: the assistant's fact still names forge-billing (hard rule 6).
    const fact = readFileSync(join(e.root, "facts", `${A}.jsonl`), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Json)
      .find((f) => f.id === CALLS.fact.call)!;
    expect(fact).toMatchObject({ to: C, by: "assistant", verified: "line" });
    const { code, out } = await apply();
    const said = out.join("\n");
    expect(code, said).toBe(0);
    expect(said).not.toContain("waits for you");
    expect(said).not.toContain("--allow-removals");
    // ADR 0195: nothing removed unexplained: each old arrow says where its call goes now.
    const removed = out.filter((l) => l.trim().startsWith("removed Interface/"));
    expect(removed).toHaveLength(7);
    for (const l of removed) expect(l).toContain(`its call goes to ${B} now`);
    expect(await e.arrows()).toEqual({ [B]: 7 });
    for (const i of (await e.interfaces()).filter((x) => x.from === A)) {
      expect(i.flags).toEqual(["joined-by-person"]);
      expect(i.evidence.some((x) => x.repo === A && x.path?.endsWith("OrdersClient.java"))).toBe(
        true,
      );
    }
  }, 120_000);

  it("then says each is paired here and drawn, by whom, with the reason and what the code names", async () => {
    const v = await e.candidates({ repo: B });
    expect(v.calls.map((c) => [c.status, c.drawn, c.pairedBy])).toEqual(
      Array(7).fill(["paired", true, "pat"]),
    );
    expect(row(v, "host").how).toMatchObject({ by: "paired", who: "pat", reason: WHY });
    expect(row(v, "host").codeNames).toEqual({ box: C, text: "billing.forge.example" });
    expect(row(v, "theirs").how?.reason).toBeUndefined();
    // And from the wrong box's side: nothing goes there any more.
    const c = await e.candidates({ repo: C });
    expect(c.calls.map((x) => [x.status, x.joins, x.how?.by])).toEqual(
      Array(7).fill(["joined", B, "paired"]),
    );
  });

  it("keeps the fact as read, with the person's pairing beside it (Map › Trust › facts)", async () => {
    const f = await e.call(`/api/facts/${A}`);
    const fact = (f.body.facts as Json[]).find((x) => x.id === CALLS.fact.call)!;
    expect(fact).toMatchObject({ verified: "line", by: "assistant", claim: { to: C } });
    const items = (await e.call(`/api/boxes/corrections?repo=${A}`)).body.items as Json[];
    expect(items.filter((x) => x.kind === "link").length).toBeGreaterThanOrEqual(7);
  });
});

describe("the removal guard and a move (ADR 0195)", () => {
  let g: ReconnectEstate;
  beforeAll(async () => {
    g = await reconnectEstate("b30-rc-guard-");
  }, 300_000);
  afterAll(async () => g?.close());

  it("Edit the map's pairing moves a call the same way, in one build with no confirm", async () => {
    const started = await g.call("/api/map/edits", "POST", {
      edits: [
        { kind: "add", pair: { from: A, to: { repo: B }, pairs: [CALLS.theirs, CALLS.mine] } },
      ],
    });
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    let job: Json = {};
    for (let n = 0; n < 1200; n++) {
      job = (await g.call(`/api/jobs/${String(started.body.jobId)}`)).body;
      if (job.state !== "running" && job.state !== "queued") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(job.state, JSON.stringify(job)).toBe("done");
    expect(job.result?.code, (job.result?.lines as string[]).join("\n")).toBe(0);
    expect(job.result?.built, (job.result?.lines as string[]).join("\n")).toBe(true);
    expect(await g.arrows()).toEqual({ [C]: 3, [B]: 2, [VENDOR]: 1 });
  }, 120_000);
});
