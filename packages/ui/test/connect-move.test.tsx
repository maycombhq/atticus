import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Api } from "@maycombhq/core";
import { COPY } from "../src/copy.js";
import { all, mount, text } from "./support/hooks.js";

/**
 * Beta.30 (the owner's field report: "the map shows a connection to the wrong repo; when I try
 * to reconnect it with the actual one it refuses, saying 0 calls to pair"). Connect A to B lists
 * A's calls that go to another box first, each with where it goes today and how that was decided
 * in plain words, none ticked; one action, Move to B, previews and then writes the person's
 * pairing. Overriding what the code names takes a reason; another person's pairing is replaced
 * only when the person says so. On the invented Forge estate: forge-orders, forge-billing (the
 * wrong box) and forge-ledger (the right one).
 */

vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});
const { Pairing, howWords, initialPicks, pairsOf, undoneWords } =
  await import("../src/screens/architecture/Connect.js");
const { JobFailed } = await import("../src/app/job.js");

type PairApply = import("../src/screens/architecture/Connect.js").PairApply;
vi.mock("../src/app/propose.js", async () => ({
  ...(await vi.importActual<object>("../src/app/propose.js")),
  Propose: () => null,
}));
const C = COPY.connect;
const un = (h: string) =>
  h
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

const AT = "src/main/java/forge/orders/OrdersClient.java";
const call = (
  n: number,
  path: string,
  o: Partial<Api.CandidateCallViewT> = {},
): Api.CandidateCallViewT => ({
  fact: `call.${n}`,
  callType: "rest",
  method: "GET",
  path,
  at: `${AT}:${n}`,
  status: "joined",
  joins: "forge-billing",
  suggestion: { api: `e${n}`, score: 1, why: "same-path" },
  suggestions: [{ api: `e${n}`, score: 1, why: "same-path" }],
  ...o,
});
const byAddress = call(8, "/holds/{id}", {
  how: { by: "address" },
  codeNames: { box: "forge-billing", text: "billing.forge.example" },
});
const byFact = call(10, "/holds/{id}/release", {
  how: { by: "code" },
  codeNames: { box: "forge-billing", text: "forge-billing" },
});
const byAnswer = call(12, "/fees/{id}", {
  how: { by: "answer", who: "pat", at: "2026-11-12T09:30:00.000Z", question: "q-00000000000c" },
});
const bySam = call(14, "/entries/{id}", {
  pairedBy: "sam",
  how: { by: "paired", who: "sam", at: "2026-11-10T09:00:00.000Z" },
});
const byMe = call(16, "/entries", {
  pairedBy: "pat",
  how: { by: "paired", who: "pat", at: "2026-11-11T09:00:00.000Z", reason: "as the wiki says" },
});
const byGateway = call(18, "/billing/v1/statements/{id}", {
  how: { by: "gateway", through: "forge_billing_1-0" },
  codeNames: { box: "forge_billing_1-0", text: "gw.forge.example" },
});
const outside = call(20, "/charges", {
  joins: "northwind-pay",
  how: { by: "code" },
  codeNames: { box: "northwind-pay", text: "northwind-pay" },
});
const loose = call(22, "/audits", { status: "unresolved", joins: undefined, confident: true });
const view = (calls: Api.CandidateCallViewT[]): Api.LinkCandidatesViewT => ({
  from: "forge-orders",
  to: { repo: "forge-ledger" },
  toName: "forge-ledger",
  calls,
  apis: calls.map((c) => ({
    id: c.suggestion!.api,
    kind: "entry" as const,
    method: "GET",
    path: c.path,
  })),
});
const every = [byAddress, byFact, byAnswer, bySam, byMe, byGateway, outside];
const box: Api.LinkBoxT = { repo: "forge-ledger" };

describe("how a call's box was decided, in plain words", () => {
  it("says each way as it is", () => {
    expect(howWords(byAddress, "pat")).toBe(
      "matched by its address (its line names billing.forge.example)",
    );
    expect(howWords(byFact, "pat")).toBe("read from code (the call's fact names forge-billing)");
    expect(howWords(byAnswer, "pat")).toBe("your answer to a question on 2026-11-12");
    expect(howWords(byAnswer, "sam")).toBe("pat's answer to a question on 2026-11-12");
    expect(howWords(bySam, "pat")).toBe("paired by sam on 2026-11-10");
    expect(howWords(byMe, "pat")).toBe('paired by you on 2026-11-11: "as the wiki says"');
    expect(howWords(byGateway, "pat")).toBe(
      "it goes through forge_billing_1-0, a gateway whose route forwards it there",
    );
    expect(howWords(outside, "pat")).toBe("read from code (the call's fact names northwind-pay)");
    expect(howWords(call(1, "/x", { how: { by: "path" } }), "pat")).toBe(
      "matched by its path alone (a guess: nothing names the box)",
    );
    expect(howWords(call(1, "/x", { how: { by: "ai", who: "run-7" } }), "pat")).toBe(
      "decided by AI (run-7), not confirmed by a person",
    );
    expect(howWords(call(1, "/x", { how: { by: "kept" } }), "pat")).toBe(
      "an arrow kept from an earlier read (this read doesn't say where the call goes)",
    );
    // An older server says only where it goes: nothing is made up.
    expect(howWords(call(1, "/x"), "pat")).toBeUndefined();
  });
});

describe("Connect forge-orders to forge-ledger, its calls joined to the wrong box", () => {
  const render = (calls: Api.CandidateCallViewT[]) =>
    un(
      renderToStaticMarkup(
        <Pairing
          from="forge-orders"
          box={box}
          me="pat"
          cands={{ state: "ready", data: view(calls) }}
        />,
      ),
    );

  it("lists them first, each with where it goes today and how, and never says nothing can be paired", () => {
    const out = render([...every, loose]);
    expect(out).toContain(
      C.moveFirst(7, "forge-orders", "forge-billing (6), northwind-pay (1)", "forge-ledger"),
    );
    expect(out).toContain(
      "goes to forge-billing today: matched by its address (its line names billing.forge.example)",
    );
    expect(out).toContain("goes to forge-billing today: your answer to a question on 2026-11-12");
    expect(out).toContain("goes to forge-billing today: paired by sam on 2026-11-10");
    expect(out).toContain(
      "goes to northwind-pay today: read from code (the call's fact names northwind-pay)",
    );
    // Before the loose calls, and open: nothing to unfold.
    expect(out.indexOf(C.moveCaption("forge-orders", "forge-ledger"))).toBeLessThan(
      out.indexOf(C.caption("forge-orders", "forge-ledger")),
    );
    expect(out).not.toContain("<details");
    expect(out).not.toContain("nothing is loose");
    expect(out).not.toContain("Write 0 pairs");
  });

  it("ticks none of them, picks the likeliest API for each, and holds Move to forge-ledger back with why", () => {
    const i = initialPicks(view([...every, loose]));
    expect([...i.ticked]).toEqual(["call.22"]);
    expect(i.picked["call.8"]).toBe("e8");
    const out = render(every);
    expect(out).not.toMatch(/<input[^>]*type="checkbox"[^>]*checked=""/);
    expect(out).toContain(C.moveTickFirst("forge-ledger"));
    expect(out).toMatch(
      new RegExp(`<button[^>]*disabled=""[^>]*>${C.moveTo("forge-ledger")}</button>`),
    );
  });

  it("names every control: each tick, each API pick, and the list by its caption", () => {
    const out = render(every);
    expect(out).toContain(`aria-label="${C.movePick("GET /holds/{id}", "forge-ledger")}"`);
    expect(out).toContain(`aria-label="${C.col.api}: GET /holds/{id}"`);
    expect(out).toMatch(/<ul class="box-calls" aria-labelledby="[^"]+-m"/);
  });

  it("keeps the states it had: loading, an error, nothing on record", () => {
    const state = (cands: Record<string, unknown>) =>
      un(renderToStaticMarkup(<Pairing from="forge-orders" box={box} cands={cands as never} />));
    expect(state({ state: "loading" })).toContain(C.loading);
    expect(state({ state: "error", error: "no such repo" })).toContain(C.failed("no such repo"));
    const none = state({
      state: "ready",
      data: { ...view([]), noCalls: { command: "atticus map --all --gaps --repos forge-orders" } },
    });
    expect(none).toContain(C.noCalls("forge-orders"));
    expect(none).not.toContain(C.moveTo("forge-ledger"));
  });
});

describe("Move to forge-ledger", () => {
  const start = (calls: Api.CandidateCallViewT[], apply?: PairApply) => {
    const sent: Api.ConnectLinksRequestT[] = [];
    const post = (body: Api.ConnectLinksRequestT) => {
      sent.push(body);
      return Promise.resolve({
        written: !body.preview,
        file: "facts/forge-orders.corrections.jsonl",
        lines: body.pairs.map((p) => JSON.stringify(p)),
        verify: "atticus verify forge-orders --write",
        commit: "git add facts",
      } as Api.ConnectLinksResultT);
    };
    const undone: string[] = [];
    const m = mount(
      Pairing as never,
      {
        from: "forge-orders",
        box,
        me: "pat",
        post,
        ...(apply ? { apply } : {}),
        undoLine: (line: string) => {
          undone.push(line);
          return Promise.resolve();
        },
        cands: { state: "ready", data: view(calls), reload: () => undefined },
      } as never,
    );
    const els = () => all(m.tree);
    const tick = (label: string, on = true) => {
      const e = els().find(
        (x) => x.type === "input" && x.props.type === "checkbox" && x.props["aria-label"] === label,
      )!;
      (e.props.onChange as (ev: unknown) => void)({ target: { checked: on } });
      m.render();
    };
    const button = (label: string) =>
      els().find((x) => x.type === "button" && text(x.props.children) === label);
    const click = async (label: string) => {
      (button(label)!.props.onClick as () => void)();
      await new Promise((r) => setTimeout(r, 0));
      m.render();
    };
    const said = () => text(m.tree);
    return { m, els, tick, button, click, said, sent, undone };
  };
  const pick = (c: Api.CandidateCallViewT) => C.movePick(`GET ${c.path}`, "forge-ledger");

  it("previews exactly the ticked calls, then writes them on the person's confirm", async () => {
    const t = start([byAnswer, byMe]);
    expect(t.button(C.moveTo("forge-ledger"))!.props.disabled).toBe(true);
    t.tick(pick(byAnswer));
    expect(t.button(C.moveTo("forge-ledger"))!.props.disabled).toBe(false);
    // An answered question: the pairing moves this call; the answer itself is said to stand.
    expect(t.said()).toContain(C.answerStays("q-00000000000c", "forge-billing"));
    // Before anything is written, no Apply of this panel's is on the page.
    expect(t.els().some((x) => x.props.scope === "corrections")).toBe(false);
    await t.click(C.moveTo("forge-ledger"));
    expect(t.sent).toEqual([
      {
        from: "forge-orders",
        to: box,
        pairs: [{ call: "call.12", api: "e12" }],
        preview: true,
      },
    ]);
    // Nothing is written until the person confirms what the preview said.
    const confirm = C.moveConfirm(1, "forge-ledger");
    expect(t.button(confirm)!.props.disabled).toBe(false);
    await t.click(confirm);
    expect(t.sent[1]).toEqual({
      from: "forge-orders",
      to: box,
      pairs: [{ call: "call.12", api: "e12" }],
    });
    expect(
      t.els().some((x) => x.props.said === C.written(1, "facts/forge-orders.corrections.jsonl")),
    ).toBe(true);
  });

  // ADR 0204 decision 2: the confirm writes and applies in one job, and Undo takes it back.
  it("writes and applies the move in one job, then Undo takes back exactly what it wrote", async () => {
    const applied: Api.MapEditT[][] = [];
    const undone: unknown[] = [];
    const wrote = [
      { edit: 0, file: "facts/forge-orders.corrections.jsonl", lines: ['{"fact":"call.12"}'] },
    ];
    const t = start([byAnswer, byMe], {
      apply: (edits) => {
        applied.push(edits);
        return Promise.resolve({ wrote, built: true });
      },
      undo: (w) => {
        undone.push(w);
        return Promise.resolve();
      },
    });
    t.tick(pick(byAnswer));
    await t.click(C.moveTo("forge-ledger"));
    await t.click(C.moveConfirm(1, "forge-ledger"));
    // The preview went through the pairing's own route; the write is one Apply of the map.
    expect(t.sent).toHaveLength(1);
    expect(applied).toEqual([
      [
        {
          kind: "add",
          pair: { from: "forge-orders", to: box, pairs: [{ call: "call.12", api: "e12" }] },
        },
      ],
    ]);
    expect(t.said()).toContain(COPY.connectAB.connected("forge-orders", "forge-ledger"));
    expect(t.said()).toContain(COPY.connectAB.notProposed);
    expect(
      t.els().some((x) => x.props.said === C.written(1, "facts/forge-orders.corrections.jsonl")),
    ).toBe(false);
    await t.click(C.undo);
    expect(undone).toEqual([wrote]);
    expect(t.said()).toContain(COPY.connectAB.undone);
  });

  it("says an Undo over the removal limits is taken back and waits for the person's confirm (ADR 0195 addendum)", async () => {
    const wrote = [
      { edit: 0, file: "facts/forge-orders.corrections.jsonl", lines: ['{"fact":"call.12"}'] },
    ];
    const refused = {
      reasons: ["large-removals"],
      message: "This would remove 4 records…",
      removals: [],
    } as unknown as Api.BuildRefusalViewT;
    const t = start([byAnswer, byMe], {
      apply: () => Promise.resolve({ wrote, built: true }),
      undo: () => Promise.reject(new JobFailed("Refused", [], undefined, 1, { refused })),
    });
    t.tick(pick(byAnswer));
    await t.click(C.moveTo("forge-ledger"));
    await t.click(C.moveConfirm(1, "forge-ledger"));
    await t.click(C.undo);
    expect(t.said()).toContain(COPY.connectAB.undoneWaits);
    // A pairing taken back counts toward the limits like any removal: the words say the build
    // waits for the person, never that the removals are someone else's.
    expect(COPY.connectAB.undoneWaits).toMatch(/confirm/);
    expect(COPY.connectAB.undoneWaits).not.toMatch(/didn't change/);
    expect(t.els().some((x) => x.props.refused === refused)).toBe(true);
  });

  it("moves only the ticked moves: a loose call that started ticked is left for Preview", async () => {
    const t = start([byAnswer, loose]);
    t.tick(pick(byAnswer));
    await t.click(C.moveTo("forge-ledger"));
    expect(t.sent[0]!.pairs).toEqual([{ call: "call.12", api: "e12" }]);
    await t.click(C.moveConfirm(1, "forge-ledger"));
    expect(t.sent[1]).toEqual({
      from: "forge-orders",
      to: box,
      pairs: [{ call: "call.12", api: "e12" }],
    });
    // Written: the button is the loose call's again, never a count of none.
    expect(t.button(C.moveConfirm(0, "forge-ledger"))).toBeUndefined();
    // Preview takes every ticked pair, and its write says so.
    const u = start([byAnswer, loose]);
    u.tick(pick(byAnswer));
    await u.click(C.preview);
    expect(u.sent[0]!.pairs.map((x) => x.call)).toEqual(["call.12", "call.22"]);
    expect(u.button(C.confirm(2, false))!.props.disabled).toBe(false);
  });

  it("asks why before overriding what the code names, and sends the reason with the pair", async () => {
    const t = start([byAddress, byAnswer]);
    t.tick(pick(byAddress));
    expect(t.said()).toContain(
      C.overridesCode("billing.forge.example", "forge-billing", "forge-ledger"),
    );
    expect(t.said()).toContain(C.moveNeedsReason);
    expect(t.button(C.moveTo("forge-ledger"))!.props.disabled).toBe(true);
    const why = t
      .els()
      .find(
        (x) => x.type === "input" && x.props["aria-label"] === C.reasonLabel("GET /holds/{id}"),
      )!;
    (why.props.onChange as (e: unknown) => void)({
      target: { value: "Ledger serves holds since the split." },
    });
    t.m.render();
    expect(t.button(C.moveTo("forge-ledger"))!.props.disabled).toBe(false);
    await t.click(C.moveTo("forge-ledger"));
    expect(t.sent[0]!.pairs).toEqual([
      { call: "call.8", api: "e8", reason: "Ledger serves holds since the split." },
    ]);
  });

  it("replaces another person's pairing only when the person says so, and their own without asking", () => {
    const t = start([bySam, byMe]);
    t.tick(pick(byMe));
    expect(t.button(C.moveTo("forge-ledger"))!.props.disabled).toBe(false);
    t.tick(pick(bySam));
    expect(t.said()).toContain(
      C.replacesPairing("sam", "forge-billing", "forge-ledger", false, "forge-billing"),
    );
    expect(t.said()).toContain(C.moveNeedsReplace);
    expect(t.button(C.moveTo("forge-ledger"))!.props.disabled).toBe(true);
    t.tick(C.replaceConfirm("sam", false, "GET /entries/{id}"));
    expect(t.button(C.moveTo("forge-ledger"))!.props.disabled).toBe(false);
  });

  it("offers Answer it again on a call an answer placed, and says new calls still follow the answer (the review)", () => {
    const t = start([byAnswer]);
    t.tick(pick(byAnswer));
    expect(t.said()).toContain(
      "Moving it pairs this call only. The answer to q-00000000000c stands: the other calls it covers, and new calls that match it, still go to forge-billing until it is answered again.",
    );
    const again = t
      .els()
      .find((x) => x.type === "a" && text(x.props.children) === C.answerAgain("q-00000000000c"))!;
    expect(again.props.href).toBe("#/questions/q-00000000000c");
  });

  it("says after Undo that the map still draws the move until the repo is applied, and offers that Apply (the review)", async () => {
    const t = start([byAnswer]);
    t.tick(pick(byAnswer));
    await t.click(C.moveTo("forge-ledger"));
    await t.click(C.moveConfirm(1, "forge-ledger"));
    await t.click(C.undo);
    expect(t.undone).toEqual([JSON.stringify({ call: "call.12", api: "e12" })]);
    expect(t.said()).toContain(
      "Undone: the line is removed. The map still draws what forge-orders's last Apply drew. Apply forge-orders again to draw it without the pairing; Atticus asks you to confirm when that removes many arrows:",
    );
    // The re-review: four lines undone are said as four.
    expect(undoneWords({ lines: ["a", "b", "c", "d"] })).toBe("Undone: the 4 lines are removed.");
    expect(C.undoneApply("forge-orders", 4)).toBe(
      "The map still draws what forge-orders's last Apply drew. Apply forge-orders again to draw it without the pairings; Atticus asks you to confirm when that removes many arrows:",
    );
    // The Apply that redraws the map, for this repo's corrections.
    expect(
      t.els().some((x) => x.props.scope === "corrections" && x.props.repo === "forge-orders"),
    ).toBe(true);
  });

  it("says where to correct a gateway's own forwarding, beside moving the one call", () => {
    const t = start([byGateway]);
    t.tick(pick(byGateway));
    expect(t.said()).toContain(C.gatewayHint("forge_billing_1-0", "forge-ledger"));
  });

  it("sends a reason only with the pair it is for", () => {
    expect(
      pairsOf({ a: "e1", b: "e2" }, new Set(["a", "b"]), { a: " because ", c: "stray" }),
    ).toEqual([
      { call: "a", api: "e1", reason: "because" },
      { call: "b", api: "e2" },
    ]);
  });
});
