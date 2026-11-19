import { describe, expect, it } from "vitest";
import {
  joinedArrowOf,
  looseEndsAt,
  movedArrowOf,
  overRemovalLimits,
  pairedArrowsAt,
} from "../src/build.js";

/**
 * Beta.28.1 (field hunt G1, its re-reviews): the large-removal limits, one rule for the guard and
 * a preview. A loose end a person's pairing joins now counts toward neither limit, matched by
 * line: an Unresolved carries no call id, so only a loose end that is its caller's only one on
 * that line is the pairing's; two on one line count as any removal.
 */

const ev = (line: number) => [{ repo: "forge-proxy", path: "src/client.ts", line }];
const rec = (kind: string, id: string, extra: Record<string, unknown> = {}, line = 1) =>
  ({ kind, id, evidence: ev(line), ...extra }) as never;
const endpoints = (n: number) =>
  Array.from({ length: n }, (_, i) => rec("Endpoint", `e${i}`, {}, 100 + i));
const paired = (id: string, line: number, from = "proxy") =>
  rec("Interface", id, { from, to: "svc", flags: ["joined-by-person"] }, line);

/** What the guard counts toward the limits: each removal's repos, and whether it is joined now. */
const counted = (before: never[], removed: never[], added: never[]) => {
  const at = pairedArrowsAt(added);
  const loose = looseEndsAt(before);
  const had = new Map([["forge-proxy", before.length]]);
  return overRemovalLimits(
    had,
    removed.map((r) => ({ repos: ["forge-proxy"], joined: !!joinedArrowOf(r, at, loose) })),
  );
};

describe("the removal limits (ADR 0195 point 4)", () => {
  it("counts no loose end its pairing joins, alone on its line", () => {
    const before = [
      ...endpoints(15),
      rec("Unresolved", "u-a", { owner: "proxy" }, 7),
      rec("Unresolved", "u-b", { owner: "proxy" }, 8),
      rec("Unresolved", "u-c", { owner: "proxy" }, 9),
    ];
    const removed = before.slice(15);
    const added = [paired("if-a", 7), paired("if-b", 8), paired("if-c", 9)];
    expect(counted(before, removed, added)).toMatchObject({ over: false, counted: 0 });
    expect(joinedArrowOf(removed[0]!, pairedArrowsAt(added), looseEndsAt(before))).toBe(
      "Interface/if-a",
    );
  });

  it("counts loose ends that share a line with the one paired (the re-review's probe)", () => {
    const before = [
      ...endpoints(15),
      rec("Unresolved", "u-a", { owner: "proxy" }, 7),
      rec("Unresolved", "u-b", { owner: "proxy" }, 7),
      rec("Unresolved", "u-c", { owner: "proxy" }, 7),
    ];
    // 18 records: the limit is 1.8; none of the three is told apart, so all three count.
    expect(looseEndsAt(before).get("proxy\u0000forge-proxy\u0000src/client.ts\u00007")).toBe(3);
    for (const r of before.slice(15))
      expect(joinedArrowOf(r, pairedArrowsAt([paired("if-a", 7)]), looseEndsAt(before))).toBe(
        undefined,
      );
    expect(counted(before, before.slice(15), [paired("if-a", 7)])).toMatchObject({
      over: true,
      counted: 3,
    });
  });

  it("counts a loose end an arrow of another caller, or an answer's arrow, cites", () => {
    const before = [...endpoints(8), rec("Unresolved", "u-a", { owner: "proxy" }, 7)];
    const removed = before.slice(8);
    expect(counted(before, removed, [paired("if-a", 7, "other")])).toMatchObject({ counted: 1 });
    const answered = rec("Interface", "if-b", { from: "proxy", to: "svc" }, 7);
    expect(counted(before, removed, [answered])).toMatchObject({ counted: 1 });
  });

  it("says each repo over the share, and the count over 200", () => {
    const had = new Map([["forge-proxy", 10]]);
    expect(overRemovalLimits(had, [{ repos: ["forge-proxy"] }])).toMatchObject({ over: false });
    expect(
      overRemovalLimits(had, [{ repos: ["forge-proxy"] }, { repos: ["forge-proxy"] }]),
    ).toMatchObject({ over: true, big: [["forge-proxy", 2]] });
    const many = Array.from({ length: 201 }, () => ({ repos: [] as string[] }));
    expect(overRemovalLimits(new Map(), many)).toMatchObject({ over: true, counted: 201 });
  });

  // Beta.30 (the owner's field report: a call joined to the wrong box, moved by a pairing).
  describe("an arrow a person's pairing moves to another box", () => {
    const arrow = (id: string, to: string, line: number, o: Record<string, unknown> = {}) =>
      ({
        kind: "Interface",
        id,
        from: "orders",
        to,
        evidence: [
          { repo: "forge-orders", path: "src/OrdersClient.java", line, side: "caller" },
          { repo: `forge-${to}`, path: "src/Controller.java", line: 9, side: "callee" },
        ],
        ...o,
      }) as never;
    const person = { flags: ["joined-by-person"] };

    it("is the pairing's own result: its removal names the new arrow and counts toward no limit", () => {
      const old = arrow("if-old", "billing", 8, { flags: ["joined-by-host"] });
      const at = pairedArrowsAt([arrow("if-new", "ledger", 8, person)]);
      expect(movedArrowOf(old, at)).toEqual({ id: "if-new", to: "ledger" });
      const had = new Map([["forge-orders", 5]]);
      expect(
        overRemovalLimits(had, [{ repos: ["forge-orders"], joined: !!movedArrowOf(old, at) }]),
      ).toMatchObject({ over: false, counted: 0 });
      // Not moved, the same removal is over the share (1 of 5).
      expect(overRemovalLimits(had, [{ repos: ["forge-orders"] }])).toMatchObject({ over: true });
    });

    it("is told by the caller's line only: never by the callee's, another caller's, or an arrow no person paired", () => {
      const old = arrow("if-old", "billing", 8);
      // The new arrow cites the callee's line of the old one, not its caller's.
      const callee = {
        kind: "Interface",
        id: "if-x",
        from: "orders",
        to: "ledger",
        flags: ["joined-by-person"],
        evidence: [{ repo: "forge-billing", path: "src/Controller.java", line: 9, side: "caller" }],
      } as never;
      expect(movedArrowOf(old, pairedArrowsAt([callee]))).toBeUndefined();
      expect(
        movedArrowOf(old, pairedArrowsAt([arrow("if-new", "ledger", 8, { ...person, from: "x" })])),
      ).toBeUndefined();
      expect(movedArrowOf(old, pairedArrowsAt([arrow("if-new", "ledger", 8)]))).toBeUndefined();
      expect(
        movedArrowOf(old, pairedArrowsAt([arrow("if-new", "ledger", 9, person)])),
      ).toBeUndefined();
    });

    it("says nothing where two paired arrows cite the line (two calls on one line): each counts", () => {
      const old = arrow("if-old", "billing", 8);
      const at = pairedArrowsAt([
        arrow("if-a", "ledger", 8, person),
        arrow("if-b", "risk", 8, person),
      ]);
      expect(movedArrowOf(old, at)).toBeUndefined();
      // A loose end is never a moved arrow, and a moved arrow never a joined loose end.
      expect(
        movedArrowOf({ kind: "Unresolved", id: "u", owner: "orders", evidence: [] } as never, at),
      ).toBeUndefined();
    });
  });
});
