import { describe, expect, it } from "vitest";
import { overRemovalLimits, removalsToConfirm } from "../src/build.js";

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
    expect(removalsToConfirm(before, removed, added)).toBeUndefined();
  });

  it("counts loose ends that share a line with the one paired (the re-review's probe)", () => {
    const before = [
      ...endpoints(15),
      rec("Unresolved", "u-a", { owner: "proxy" }, 7),
      rec("Unresolved", "u-b", { owner: "proxy" }, 7),
      rec("Unresolved", "u-c", { owner: "proxy" }, 7),
    ];
    // 18 records: the limit is 1.8; none of the three is told apart, so all three count.
    expect(removalsToConfirm(before, before.slice(15), [paired("if-a", 7)])).toBe(3);
  });

  it("counts a loose end an arrow of another caller, or an answer's arrow, cites", () => {
    const before = [...endpoints(8), rec("Unresolved", "u-a", { owner: "proxy" }, 7)];
    const removed = before.slice(8);
    expect(removalsToConfirm(before, removed, [paired("if-a", 7, "other")])).toBe(1);
    const answered = rec("Interface", "if-b", { from: "proxy", to: "svc" }, 7);
    expect(removalsToConfirm(before, removed, [answered])).toBe(1);
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
});
