import { readFileSync, writeFileSync } from "node:fs";
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
    // The review: in the file's order, line 8 before line 10 and line 20.
    expect(v.calls.map((c) => Number(c.at.split(":")[1]))).toEqual([8, 10, 12, 14, 16, 18, 20]);
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
    // The review: the 409 names the pairs that lack a reason, not in prose only.
    const both = await preview([CALLS.host, CALLS.answer, CALLS.fact]);
    expect(both.status).toBe(409);
    expect(both.body.needsReason).toEqual([
      {
        call: CALLS.host.call,
        at: "src/main/java/forge/orders/OrdersClient.java:8",
        box: C,
        text: "billing.forge.example",
      },
      {
        call: CALLS.fact.call,
        at: "src/main/java/forge/orders/OrdersClient.java:10",
        box: C,
        text: C,
      },
    ]);
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
    // The review: Corrections and declarations says a pairing went over what the line names,
    // where it was moved from and why; one that didn't says only where the call goes.
    const mine = items.filter(
      (x) => x.kind === "link" && x.by === "pat" && x.at !== "2026-11-10T09:00:00.000Z",
    );
    const over = mine.find((x) => String(x.says).includes("OrdersClient.java:8"))!;
    expect(over.says).toBe(
      `call https://billing.forge.example/holds/{id} (src/main/java/forge/orders/OrdersClient.java:8) goes to GET /holds/{id} on ${B}, moved by pat from ${C} over what its line names (billing.forge.example): "${WHY}"`,
    );
    expect(over.over).toEqual({ box: C, text: "billing.forge.example", reason: WHY });
    const plain = mine.find((x) => String(x.says).includes("OrdersClient.java:12"))!;
    expect(plain.says).toBe(
      `call https://fees.forge.internal/fees/{id} (src/main/java/forge/orders/OrdersClient.java:12) goes to GET /fees/{id} on ${B}`,
    );
    expect(plain.over).toBeUndefined();
  });
});

describe("the removal guard and a move (ADR 0195)", () => {
  let g: ReconnectEstate;
  beforeAll(async () => {
    g = await reconnectEstate("b30-rc-guard-");
  }, 300_000);
  afterAll(async () => g?.close());

  const edits = (pairs: unknown[]) =>
    g.call("/api/map/edits", "POST", {
      edits: [{ kind: "add", pair: { from: A, to: { repo: B }, pairs } }],
    });
  const corrections = () => readFileSync(join(g.root, "facts", `${A}.corrections.jsonl`), "utf8");

  it("Edit the map asks for the reason too: a pair over what the line names is a 409 until it says why (the review)", async () => {
    const before = corrections();
    const r = await edits([CALLS.host, CALLS.theirs]);
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body.problems).toEqual([
      {
        edit: 0,
        message: `call.get.holds-id's line (src/main/java/forge/orders/OrdersClient.java:8) names billing.forge.example, which is ${C}'s: pairing it with ${B} overrides what the code says. To do that, say why (a reason of a few words), and it is kept with your pairing.`,
        needsReason: [
          {
            call: CALLS.host.call,
            at: "src/main/java/forge/orders/OrdersClient.java:8",
            box: C,
            text: "billing.forge.example",
          },
        ],
      },
    ]);
    expect(corrections()).toBe(before);
    // Any other refusal is still the 422 it was.
    expect((await edits([{ call: "call.none", api: CALLS.host.api }])).status).toBe(422);
  });

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

  it("with its reason, Edit the map writes it on the pairing's line", async () => {
    const started = await edits([{ ...CALLS.host, reason: WHY }]);
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    let job: Json = {};
    for (let n = 0; n < 1200; n++) {
      job = (await g.call(`/api/jobs/${String(started.body.jobId)}`)).body;
      if (job.state !== "running" && job.state !== "queued") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(job.state, JSON.stringify(job)).toBe("done");
    const line = JSON.parse(corrections().trim().split("\n").at(-1)!) as Json;
    expect(line).toMatchObject({ fact: CALLS.host.call, link: { repo: B }, reason: WHY });
    expect(await g.arrows()).toEqual({ [C]: 2, [B]: 3, [VENDOR]: 1 });
  }, 120_000);

  it("a single Undo is under the limits; pairings taken back in bulk wait for the confirm, each with its true reason (the re-review)", async () => {
    const run = async (allow?: number) => {
      const out: string[] = [];
      const code = await verifyCommand(
        g.root,
        A,
        {
          commit: COMMIT[A]!,
          dir: join(g.root, "workspace", A),
          write: true,
          now: () => AT,
          ...(allow !== undefined ? { allowRemovals: allow } : {}),
        },
        { out: (l) => out.push(l), err: (l) => out.push(`ERR ${l}`) },
      );
      return { code, out, said: out.join("\n") };
    };
    const file = join(g.root, "facts", `${A}.corrections.jsonl`);
    const seeded = corrections().trim().split("\n").slice(0, 2).join("\n") + "\n";
    // One pairing undone: one arrow of the repo's records, under the 10% share.
    const last = corrections().trim().split("\n").at(-1)!;
    const u = await g.call(`/api/facts/${A}/corrections/undo`, "POST", { line: last });
    expect(u.status, JSON.stringify(u.body)).toBe(200);
    const one = await run();
    expect(one.code, one.said).toBe(0);
    expect(await g.arrows()).toEqual({ [C]: 3, [B]: 2, [VENDOR]: 1 });
    // Six calls moved and applied.
    const six = (["host", "fact", "answer", "theirs", "mine", "gateway"] as const).map((k) => ({
      ...CALLS[k],
      reason: WHY,
    }));
    const have = new Set(
      corrections()
        .trim()
        .split("\n")
        .slice(2)
        .map((l) => (JSON.parse(l) as Json).fact as string),
    );
    const w = await g.call("/api/links/connect", "POST", {
      from: A,
      to: { repo: B },
      pairs: six.filter((x) => !have.has(x.call)),
    });
    expect(w.status, JSON.stringify(w.body)).toBe(200);
    expect((await run()).code).toBe(0);
    expect(await g.arrows()).toEqual({ [B]: 6, [VENDOR]: 1 });
    // The corrections file reverted by hand, as a bad merge would: the guard can't tell that
    // from six Undos, so the six arrows wait for a confirm, and none is said moved by a person.
    writeFileSync(file, seeded);
    const r = await run();
    expect(r.code, r.said).toBe(1);
    const count = Number(/--allow-removals (\d+)\./.exec(r.said)?.[1]);
    const would = r.out.filter((l) => l.includes("would remove Interface/"));
    expect(would).toHaveLength(6);
    expect(count).toBeGreaterThanOrEqual(6);
    for (const l of would) expect(l).toContain("an input changed (facts/*.corrections.jsonl)");
    expect(r.said).toMatch(/\d+ of forge-orders's \d+/);
    expect(await g.arrows()).toEqual({ [B]: 6, [VENDOR]: 1 });
    // Confirmed with the count listed, it writes.
    const ok = await run(count);
    expect(ok.code, ok.said).toBe(0);
    expect(await g.arrows()).toEqual({ [C]: 5, [VENDOR]: 1 });
  }, 180_000);
});

describe("a move beside real removals, and moves that go stale (the review)", () => {
  let h: ReconnectEstate;
  const FILE = "src/main/java/forge/orders/OrdersClient.java";
  const factsFile = () => join(h.root, "facts", `${A}.jsonl`);
  const run = async (estate: ReconnectEstate, allow?: number) => {
    const out: string[] = [];
    const code = await verifyCommand(
      estate.root,
      A,
      {
        commit: COMMIT[A]!,
        dir: join(estate.root, "workspace", A),
        write: true,
        now: () => AT,
        ...(allow !== undefined ? { allowRemovals: allow } : {}),
      },
      { out: (l) => out.push(l), err: (l) => out.push(`ERR ${l}`) },
    );
    return { code, out, said: out.join("\n") };
  };
  beforeAll(async () => {
    h = await reconnectEstate("b30-rc-stale-");
  }, 300_000);
  afterAll(async () => h?.close());

  it("excuses only the moved call where three calls cite one line and the same build loses the other two", async () => {
    // Line 8 now makes three calls to forge-billing's host; the facts gain the two new ones.
    const src = join(h.root, "workspace", A, ...FILE.split("/"));
    const lines = readFileSync(src, "utf8").split("\n");
    lines[7] =
      '  Object call0(Object id, Object e, Object c) { http.get("https://billing.forge.example/fees/{id}", id); http.post("https://billing.forge.example/charges", c); return http.get("https://billing.forge.example/holds/{id}", id); }';
    writeFileSync(src, lines.join("\n"));
    const was = readFileSync(factsFile(), "utf8");
    const holds = JSON.parse(
      was.split("\n").find((l) => l.includes('"call.get.holds-id"'))!,
    ) as Json;
    const extra = (id: string, method: string, path: string) =>
      JSON.stringify({
        ...holds,
        id,
        method,
        path,
        cite: {
          ...holds.cite,
          value: `https://billing.forge.example${path}`,
          quote: `https://billing.forge.example${path}`,
        },
      });
    writeFileSync(
      factsFile(),
      was +
        [
          extra("call.get.fees-id-billing", "GET", "/fees/{id}"),
          extra("call.post.charges-billing", "POST", "/charges"),
        ].join("\n") +
        "\n",
    );
    await h.verify(A);
    expect(await h.arrows()).toEqual({ [C]: 7, [VENDOR]: 1 });
    // One of the three is moved; the read then loses the other two.
    const w = await h.call("/api/links/connect", "POST", {
      from: A,
      to: { repo: B },
      pairs: [{ ...CALLS.host, reason: WHY }],
    });
    expect(w.status, JSON.stringify(w.body)).toBe(200);
    writeFileSync(factsFile(), was);
    const r = await run(h);
    // Refused. Five records go: the moved arrow, the two lost arrows and their two features.
    // The four losses count against forge-orders; the move is the pairing's own and doesn't.
    expect(r.code, r.said).toBe(1);
    expect(r.said).toContain("This would remove 5 records (");
    expect(r.said).toContain("4 of forge-orders's 17, and adds 1)");
    const would = r.out.filter((l) => l.includes("would remove Interface/"));
    expect(would).toHaveLength(3);
    expect(would.filter((l) => l.includes(`its call goes to ${B} now`))).toHaveLength(1);
    expect(await h.arrows()).toEqual({ [C]: 7, [VENDOR]: 1 });
    // Confirmed with the count listed, it writes.
    const ok = await run(h, 5);
    expect(ok.code, ok.said).toBe(0);
    expect(await h.arrows()).toEqual({ [C]: 4, [B]: 1, [VENDOR]: 1 });
  }, 120_000);

  it("drops a move whose call the read no longer has, with a note and no error", async () => {
    const w = await h.call("/api/links/connect", "POST", {
      from: A,
      to: { repo: B },
      pairs: [CALLS.answer],
    });
    expect(w.status, JSON.stringify(w.body)).toBe(200);
    const was = readFileSync(factsFile(), "utf8");
    writeFileSync(
      factsFile(),
      was
        .split("\n")
        .filter((l) => !l.includes(`"${CALLS.answer.call}"`))
        .join("\n"),
    );
    const r = await run(h);
    // Not an error: the pairing is kept and said, and the call's loose end goes with the call.
    expect(r.code, r.said).toBe(0);
    expect(r.said).toContain(
      `correction: pat's pairing of call ${CALLS.answer.call} (${FILE}:12) with GET /fees/{id} on ${B} meets no call in this read; it is kept in the file and applied when the call is read again`,
    );
    expect(await h.arrows()).toEqual({ [C]: 4, [B]: 1, [VENDOR]: 1 });
    // Corrections and declarations marks it: kept, and its call isn't in the last read.
    const items = (await h.call(`/api/boxes/corrections?repo=${A}`)).body.items as Json[];
    const gone = items.filter((x) => x.stale);
    expect(gone.map((x) => x.says)).toEqual([
      `call https://fees.forge.internal/fees/{id} (${FILE}:12) goes to GET /fees/{id} on ${B} (its call isn't in the last read)`,
    ]);
    // Read again, the call is paired as the person said.
    writeFileSync(factsFile(), was);
    const again = await run(h);
    expect(again.code, again.said).toBe(0);
    expect(await h.arrows()).toEqual({ [C]: 4, [B]: 2, [VENDOR]: 1 });
  }, 120_000);

  it("counts the arrows of a move whose box is archived later, with a confirm", async () => {
    const manifest = join(h.root, "org-pack", "profiles", "forge", "repos.manifest.yaml");
    const text = readFileSync(manifest, "utf8");
    writeFileSync(
      manifest,
      text.replace("    owner: team-ledger\n", "    owner: team-ledger\n    archived: true\n"),
    );
    const r = await run(h);
    // The arrows to the archived box go with it: counted, said, and waiting for a confirm.
    expect(r.code, r.said).toBe(1);
    expect(r.said).toContain(`${B} is archived`);
    const count = /--allow-removals (\d+)\./.exec(r.said)?.[1];
    expect(count, r.said).toBeTruthy();
    expect(r.out.filter((l) => l.includes("would remove Interface/")).length).toBe(2);
    expect(await h.arrows()).toEqual({ [C]: 4, [B]: 2, [VENDOR]: 1 });
    const ok = await run(h, Number(count));
    console.log("ARCHIVED", ok.code, ok.said, JSON.stringify(await h.arrows()));
    expect(ok.code, ok.said).toBe(0);
    // No arrow to the archived box; the call its line's host places goes back to forge-billing,
    // and the pairing is kept and said not joined until the box is read again.
    expect(await h.arrows()).toEqual({ [C]: 5, [VENDOR]: 1 });
    expect(ok.said).toContain(`pat paired ${A}'s call with GET /holds/{id} on ${B}`);
    writeFileSync(manifest, text);
  }, 120_000);
});
