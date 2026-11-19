import { describe, expect, it } from "vitest";
import {
  joinedArrowOf,
  looseEndsAt,
  movedArrows,
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
  // The review: a moved arrow is matched one to one with the arrow of the same call, never by
  // its line alone, so a pairing excuses exactly its own call's old arrow.
  describe("an arrow a person's pairing moves to another box", () => {
    const FILE = "src/OrdersClient.java";
    const arrow = (
      id: string,
      to: string,
      line: number,
      path: string,
      o: Record<string, unknown> = {},
      also: number[] = [],
    ) =>
      ({
        kind: "Interface",
        id,
        from: "orders",
        to,
        method: "GET",
        normalizedPath: path,
        evidence: [
          ...[line, ...also].map((l) => ({
            repo: "forge-orders",
            path: FILE,
            line: l,
            side: "caller",
          })),
          { repo: `forge-${to}`, path: "src/Controller.java", line: 9, side: "callee" },
        ],
        ...o,
      }) as never;
    const person = { flags: ["joined-by-person"] };
    const loose = (line: number) =>
      ({
        kind: "Unresolved",
        id: `u-${line}`,
        owner: "orders",
        evidence: [{ repo: "forge-orders", path: FILE, line }],
      }) as never;
    const moved = (removed: never[], added: never[], old: never[] = removed) =>
      Object.fromEntries(movedArrows(removed, added, old));

    it("is the pairing's own result: its removal names the new arrow and counts toward no limit", () => {
      const old = arrow("if-old", "billing", 8, "/holds/{}", { flags: ["joined-by-host"] });
      const m = movedArrows([old], [arrow("if-new", "ledger", 8, "/holds/{}", person)], [old]);
      expect(Object.fromEntries(m)).toEqual({ "Interface/if-old": { id: "if-new", to: "ledger" } });
      const had = new Map([["forge-orders", 5]]);
      expect(
        overRemovalLimits(had, [{ repos: ["forge-orders"], joined: m.has("Interface/if-old") }]),
      ).toMatchObject({ over: false, counted: 0 });
      // Not moved, the same removal is over the share (1 of 5).
      expect(overRemovalLimits(had, [{ repos: ["forge-orders"] }])).toMatchObject({ over: true });
    });

    it("excuses only the moved call's arrow where three calls cite one line and two are lost (the review's case)", () => {
      const a = arrow("if-a", "billing", 8, "/holds/{}");
      const b = arrow("if-b", "billing", 8, "/fees/{}");
      const c = arrow("if-c", "billing", 8, "/entries/{}");
      const added = [arrow("if-new", "ledger", 8, "/holds/{}", person)];
      expect(moved([a, b, c], added)).toEqual({ "Interface/if-a": { id: "if-new", to: "ledger" } });
      // And none where the new arrow's call can't be told from the lost ones (another path).
      expect(moved([a, b, c], [arrow("if-new", "ledger", 8, "/other", person)])).toEqual({});
    });

    it("excuses one arrow per pairing in a proxy bundle whose calls all cite one target line", () => {
      // Each call cites its own flow's line and the bundle's one target line (3).
      const olds = [4, 7, 10].map((l) => arrow(`if-${l}`, "billing", l, `/r${l}`, {}, [3]));
      const added = [arrow("if-new", "ledger", 4, "/r4", person, [3])];
      // One moved, the two others lost in the same build: only the moved one is excused.
      expect(moved(olds, added)).toEqual({ "Interface/if-4": { id: "if-new", to: "ledger" } });
      // All three moved: each by its own pairing.
      const all = [4, 7, 10].map((l) => arrow(`if-n${l}`, "ledger", l, `/r${l}`, person, [3]));
      expect(Object.keys(moved(olds, all)).sort()).toEqual([
        "Interface/if-10",
        "Interface/if-4",
        "Interface/if-7",
      ]);
    });

    it("takes a new arrow of another path only where the removed arrow is the caller's one call on the line", () => {
      const old = arrow("if-old", "billing", 8, "/billing/v1/holds/{}");
      const added = [arrow("if-new", "ledger", 8, "/holds/{}", person)];
      expect(moved([old], added)).toEqual({ "Interface/if-old": { id: "if-new", to: "ledger" } });
      // Another arrow of the caller stays on the line: the pairing may be that call's.
      const stays = arrow("if-stays", "billing", 8, "/fees/{}");
      expect(moved([old], added, [old, stays])).toEqual({});
      // A loose end was on the line: the pairing may have joined it, and the arrow is a loss.
      expect(moved([old], added, [old, loose(8)])).toEqual({});
    });

    it("is told by the caller's line only: never by the callee's, another caller's, or an arrow no person paired", () => {
      const old = arrow("if-old", "billing", 8, "/holds/{}");
      const callee = {
        kind: "Interface",
        id: "if-x",
        from: "orders",
        to: "ledger",
        method: "GET",
        normalizedPath: "/holds/{}",
        flags: ["joined-by-person"],
        evidence: [{ repo: "forge-billing", path: "src/Controller.java", line: 9, side: "caller" }],
      } as never;
      expect(moved([old], [callee])).toEqual({});
      expect(
        moved([old], [arrow("if-new", "ledger", 8, "/holds/{}", { ...person, from: "x" })]),
      ).toEqual({});
      expect(moved([old], [arrow("if-new", "ledger", 8, "/holds/{}")])).toEqual({});
      expect(moved([old], [arrow("if-new", "ledger", 9, "/holds/{}", person)])).toEqual({});
    });

    it("matches a pairing undone the same way: the person's arrow goes, and the call's arrow comes back", () => {
      const mine = arrow("if-mine", "ledger", 8, "/holds/{}", person);
      const back = arrow("if-back", "billing", 8, "/holds/{}", { flags: ["joined-by-host"] });
      const undone = (removed: never[], added: never[], old: never[] = removed) =>
        Object.fromEntries(movedArrows(removed, added, old, { undone: true }));
      expect(undone([mine], [back])).toEqual({
        "Interface/if-mine": { id: "if-back", to: "billing" },
      });
      // Only a person's pairing is undone, and only one to one: a lost arrow beside it counts.
      const lost = arrow("if-lost", "ledger", 8, "/fees/{}", person);
      expect(undone([mine, lost], [back])).toEqual({
        "Interface/if-mine": { id: "if-back", to: "billing" },
      });
      expect(undone([arrow("if-code", "ledger", 8, "/holds/{}")], [back])).toEqual({});
      // Without `undone`, an arrow no person paired excuses nothing.
      expect(moved([mine], [back])).toEqual({});
    });

    it("says nothing where two paired arrows could be the removed arrow's, and never of a loose end", () => {
      const old = arrow("if-old", "billing", 8, "/holds/{}");
      const two = [
        arrow("if-a", "ledger", 8, "/holds/{}", person),
        arrow("if-b", "risk", 8, "/holds/{}", person),
      ];
      expect(moved([old], two)).toEqual({});
      expect(moved([loose(8)], [two[0]!], [loose(8)])).toEqual({});
    });
  });
});
