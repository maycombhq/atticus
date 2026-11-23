import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import { beforeEach, describe, expect, it } from "vitest";
import { readBatch, readQuestion, writeQuestion, type Api } from "@maycombhq/core";
import {
  correctDecision,
  decideAnswers,
  ONLY_THIS_ARROW,
  onlyThisArrow,
  spreadPairing,
  undoBatch,
} from "../src/ai-decide.js";
import { deleteLink } from "../src/catalog-build-commands.js";
import { candidatesOf } from "../src/ui-api-links.js";
import {
  AT,
  BFF,
  CAPTURE,
  correctionsEstate,
  correctionsOn,
  FILE,
  GW,
  LINES,
  pairLine,
  REFUNDS,
  targetsQuestion,
  toBff,
  toCapture,
} from "./corrections-estate.js";

/**
 * ADR 0208 (WP-04): every correction kind the canvas and the Decisions screen offer, performed,
 * and either spread to like cases with a count and one Undo, or said to apply to its arrow only
 * with the reason. A person-touched call is never changed by a spread. On the invented Forge
 * estate (corrections-estate.ts), no network.
 */

let root: string;
beforeEach(async () => {
  root = await correctionsEstate("atticus-spread-");
});

const ai = (fact: string, line: number, value: string) =>
  pairLine(fact, line, value, toBff, { run: "r0" });
const person = (fact: string, line: number, value: string, by = "pat") =>
  pairLine(fact, line, value, toCapture, { by, at: "2026-11-08T10:00:00.000Z" });

async function lines(...ls: string[]) {
  await writeFile(join(root, LINES), ls.join("\n") + "\n");
}

/** A spread: the count, its batch, and one Undo that takes back exactly the spread's lines. */
async function expectSpread(r: Api.CorrectDecisionResultT, n: number) {
  expect(r.batch, r.noRule).toBeDefined();
  expect(r.spread).toHaveLength(n);
  const b = await readBatch(root, r.batch!);
  expect(b).toMatchObject({ kind: "rule", correction: { item: r.item } });
  const u = await undoBatch(root, r.batch!, { by: "pat", now: AT });
  expect(u.skipped).toEqual([]);
  expect(u.removed).toBeGreaterThanOrEqual(n);
}

const QUOTE: Record<number, string> = {
  40: 'post("/charges/" + id + "/capture", body);',
  41: 'post("/charges/" + id + "/refunds", body);',
};
const PAIR = { repo: "forge-billing", to: GW, api: CAPTURE };

describe("every correction kind spreads to like cases, or says why not (ADR 0208, WP-04)", () => {
  it("an AI pairing corrected to the right API (Decisions): spreads, one Undo", async () => {
    await lines(
      ai("call.post.charges-capture", 40, "/charges/{id}/capture"),
      ai("call.post.charges-refunds", 41, "/charges/{id}/refunds"),
    );
    const r = await correctDecision(
      root,
      { item: "link:forge-billing:call.post.charges-capture", api: CAPTURE, repo: GW },
      { by: "pat", now: AT },
    );
    expect(r.rule?.match).toBe("/charges/**");
    await expectSpread(r, 2);
  });

  it("an AI pairing corrected to none (Decisions): spreads, one Undo", async () => {
    await lines(
      ai("call.post.charges-capture", 40, "/charges/{id}/capture"),
      ai("call.post.charges-refunds", 41, "/charges/{id}/refunds"),
    );
    const r = await correctDecision(
      root,
      { item: "link:forge-billing:call.post.charges-capture", none: true },
      { by: "pat", now: AT },
    );
    await expectSpread(r, 2);
  });

  it("an AI answer corrected to the right option (Decisions): spreads, one Undo", async () => {
    await writeQuestion(root, targetsQuestion("q-aaaaaaaaaaa1", 40));
    await writeQuestion(root, targetsQuestion("q-bbbbbbbbbbb2", 41));
    await mkdir(join(root, "proposals/questions"), { recursive: true });
    for (const [id, line] of [
      ["q-aaaaaaaaaaa1", 40],
      ["q-bbbbbbbbbbb2", 41],
    ] as const)
      await writeFile(
        join(root, `proposals/questions/${id}.yaml`),
        stringify({
          schemaVersion: 1,
          answer: { option: 1 },
          why: "The client posts to it.",
          cites: [{ file: FILE, line, quote: QUOTE[line] }],
          by: "copilot",
          at: "2026-11-08T10:00:00.000Z",
        }),
      );
    await decideAnswers(root, { run: "r2", now: AT });
    const r = await correctDecision(root, { item: "q-aaaaaaaaaaa1", option: 2 }, { by: "pat" });
    expect((await readQuestion(root, "q-bbbbbbbbbbb2"))!.answer).toMatchObject({ by: "pat" });
    await expectSpread(r, 1);
  });

  it("a pairing made on the canvas (Connect to…, Edit the map's add): spreads, one Undo", async () => {
    await lines(person("call.post.charges-capture", 40, "/charges/{id}/capture"));
    const r = await spreadPairing(
      root,
      { ...PAIR, call: "call.post.charges-capture" },
      { by: "pat", now: AT },
    );
    expect(r.rule).toMatchObject({ match: "/charges/**", derived: true });
    // The loose calls under /charges are paired as the person's rule, each with the API the
    // shapes rank first; they name the pairing they came from.
    expect(r.spread.map((s) => [s.item, s.change])).toEqual([
      ["link:forge-billing:call.post.charges-refunds", "applied"],
      ["link:forge-billing:call.post.charges", "applied"],
    ]);
    const spread = (await correctionsOn(root)).filter((c) => c.batch === r.batch);
    expect(spread.map((c) => [c.fact, c.link?.entry, c.rule?.from])).toContainEqual([
      "call.post.charges-refunds",
      REFUNDS,
      "link:forge-billing:call.post.charges-capture",
    ]);
    await expectSpread(r, 2);
    // The person's own pairing is the Apply's, never the spread's: it stays.
    expect((await correctionsOn(root)).map((c) => c.fact)).toEqual(["call.post.charges-capture"]);
  });

  it("an AI arrow re-pointed on the canvas (Edit the map's redirect): spreads over the AI's siblings", async () => {
    await lines(
      ai("call.post.charges-capture", 40, "/charges/{id}/capture"),
      ai("call.post.charges-refunds", 41, "/charges/{id}/refunds"),
      person("call.post.charges-capture", 40, "/charges/{id}/capture"),
    );
    const r = await spreadPairing(
      root,
      { ...PAIR, call: "call.post.charges-capture" },
      { by: "pat", now: AT },
    );
    expect(r.spread.find((s) => s.item.endsWith("charges-refunds"))).toMatchObject({
      was: `${BFF} POST /checkout`,
      change: "replaced",
    });
    await expectSpread(r, 2);
  });

  it("a delete, a declaration, an arrow to an outside system and a redirect's delete half say why they don't spread", () => {
    const del = { interfaces: ["if-1"], from: "billing-api", to: "partner-gateway" };
    const pair = { from: "forge-billing", to: { repo: GW }, pairs: [{ call: "c", api: CAPTURE }] };
    const sys = { ...pair, to: { system: "northwind-pay" } };
    const topic = { kind: "topic", system: "billing", topic: "t", side: "publishes" } as const;
    const link = {
      kind: "link",
      from: { repo: "forge-billing" },
      to: { repo: GW },
      why: "it calls it",
    } as const;
    expect(onlyThisArrow({ kind: "delete", delete: del })).toBe(ONLY_THIS_ARROW.delete);
    expect(onlyThisArrow({ kind: "add", add: topic })).toBe(ONLY_THIS_ARROW.declare);
    expect(onlyThisArrow({ kind: "add", add: link })).toBe(ONLY_THIS_ARROW.link);
    expect(onlyThisArrow({ kind: "add", pair: sys })).toBe(ONLY_THIS_ARROW.system);
    expect(onlyThisArrow({ kind: "add", pair })).toBeUndefined();
    expect(onlyThisArrow({ kind: "redirect", delete: del, pair })).toBe(ONLY_THIS_ARROW.redirect);
    expect(ONLY_THIS_ARROW.redirect).toMatch(/delete half/);
  });

  it("never re-points a call the join ties somewhere already (joined, here, undrawn)", async () => {
    // The shop serves the refunds call's path: the join ties the call there by its path.
    await appendFile(
      join(root, "facts/forge-shop-bff.jsonl"),
      JSON.stringify({
        kind: "entry",
        id: "entry.post.charges-id-refunds",
        repo: BFF,
        commit: "aaa1111",
        entryType: "rest",
        method: "POST",
        path: "/charges/{id}/refunds",
        handler: "Refunds",
        cite: {
          file: "src/main/java/forge/shop/Refunds.java",
          line: 4,
          value: "/charges/{id}/refunds",
        },
        verified: "line",
        by: "assistant",
        conf: "declared",
      }) + "\n",
    );
    await lines(person("call.post.charges-capture", 40, "/charges/{id}/capture"));
    const status = (await candidatesOf(root, "forge-billing", { repo: GW })).view.calls.find(
      (c) => c.fact === "call.post.charges-refunds",
    )?.status;
    expect(["joined", "here", "undrawn"]).toContain(status);
    const r = await spreadPairing(
      root,
      { ...PAIR, call: "call.post.charges-capture" },
      { by: "pat", now: AT },
    );
    expect(r.spread.map((s) => s.item)).not.toContain(
      "link:forge-billing:call.post.charges-refunds",
    );
    expect(r.spread.length).toBeGreaterThan(0);
  });

  it("never pairs a call with a box whose arrow from the repo a person deleted", async () => {
    await lines(person("call.post.charges-capture", 40, "/charges/{id}/capture"));
    const quiet = { out: () => undefined, err: () => undefined };
    await deleteLink(
      root,
      {
        interfaces: ["if-0000000000000001"],
        from: "billing-api",
        to: "partner-gateway",
        by: "dee",
      },
      quiet,
    );
    const r = await spreadPairing(
      root,
      { ...PAIR, call: "call.post.charges-capture" },
      { by: "pat", now: AT },
    );
    expect(r).toMatchObject({ written: false, spread: [] });
    expect(r.noRule).toMatch(/dee deleted the arrow billing-api → partner-gateway/);
  });

  it("takes its lines back when its batch can't be written", async () => {
    await lines(person("call.post.charges-capture", 40, "/charges/{id}/capture"));
    const before = await readFile(join(root, LINES), "utf8");
    // A file where the batches' folder goes: the batch can't be written.
    await writeFile(join(root, "decisions"), "not a folder");
    await expect(
      spreadPairing(root, { ...PAIR, call: "call.post.charges-capture" }, { by: "pat", now: AT }),
    ).rejects.toThrow();
    expect(await readFile(join(root, LINES), "utf8")).toBe(before);
  });

  it("a canvas pairing with nothing like it says it applies to this call only", async () => {
    await lines(person("call.post.charges-capture", 40, "/charges/{id}/capture"));
    // Every other call under /charges is a person's already.
    await writeFile(
      join(root, LINES),
      (await readFile(join(root, LINES), "utf8")) +
        person("call.post.charges-refunds", 41, "/charges/{id}/refunds") +
        "\n" +
        pairLine(
          "call.post.charges",
          42,
          "/charges",
          { repo: GW, entry: "entry.post.partners-northwind-charges", path: "/x" },
          { by: "dee" },
        ) +
        "\n",
    );
    const r = await spreadPairing(
      root,
      { ...PAIR, call: "call.post.charges-capture" },
      { by: "pat", now: AT },
    );
    expect(r.written).toBe(false);
    expect(r.noRule).toBe("no other call of the repo is like it");
  });

  it("never changes a call a person paired, declined or answered", async () => {
    await lines(
      person("call.post.charges-capture", 40, "/charges/{id}/capture"),
      JSON.stringify({
        schemaVersion: 2,
        fact: "call.post.charges-refunds",
        target: { kind: "call", file: FILE, line: 41, value: "/charges/{id}/refunds" },
        action: "unlink",
        by: "dee",
        at: "2026-11-08T09:30:00.000Z",
      }),
    );
    const r = await spreadPairing(
      root,
      { ...PAIR, call: "call.post.charges-capture" },
      { by: "pat", now: AT },
    );
    expect(r.spread.map((s) => s.item)).toEqual(["link:forge-billing:call.post.charges"]);
    const refunds = (await correctionsOn(root)).filter(
      (c) => c.fact === "call.post.charges-refunds",
    );
    expect(refunds.map((c) => [c.action, c.by])).toEqual([["unlink", "dee"]]);
  });

  it("refuses inside a Copilot session, and spreads nothing for a pairing not on file", async () => {
    await expect(
      spreadPairing(
        root,
        { ...PAIR, call: "call.post.charges-capture" },
        {
          by: "pat",
          env: { ATTICUS_ACP_SESSION: "1" },
        },
      ),
    ).rejects.toThrow(/acts as no one/);
    const r = await spreadPairing(
      root,
      { ...PAIR, call: "call.post.charges-capture" },
      { by: "pat" },
    );
    expect(r).toMatchObject({ written: false, spread: [] });
    expect(r.noRule).toMatch(/isn't the call's standing line/);
  });
});
