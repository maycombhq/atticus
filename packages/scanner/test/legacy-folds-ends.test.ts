import { describe, expect, it } from "vitest";
import type { CatalogRecord } from "@maycombhq/core";
import { endGoneWords, foldWords, foldsAway, withUnslottedEnds } from "../src/build.js";

/**
 * Beta.28.1, the review of fix/b281-seeds: what the legacy overlay does with an alias whose target
 * only the overlay keeps (seed 1539914139), and which repos a legacy arrow's end is of once prune
 * took its slot (seed 1542546636).
 */

const alias = (id: string, target: string, value: unknown) => ({ id, target, value });

describe("a feature an alias folds into a feature the overlay keeps (seed 1539914139)", () => {
  it("leaves out the folded feature while its target is kept, and says whether it was detected", () => {
    const away = foldsAway(
      [alias("cd-alias-feature.entries", "feature.entries", ["feature.forge-payments"])],
      new Set(["feature.entries", "feature.forge-payments"]),
      new Set(["feature.forge-payments"]),
    );
    expect([...away]).toEqual([
      [
        "feature.forge-payments",
        { into: "feature.entries", detected: false, decisions: ["cd-alias-feature.entries"] },
      ],
    ]);
  });

  it("keeps the folded feature when the target isn't in the catalog", () => {
    expect(
      foldsAway(
        [alias("cd-a", "feature.entries", ["feature.forge-payments"])],
        new Set(["feature.forge-payments"]),
        new Set(["feature.forge-payments"]),
      ).size,
    ).toBe(0);
  });

  it("takes only feature ids from an alias's value, as the features pass does", () => {
    expect(
      foldsAway(
        [alias("cd-a", "feature.entries", ["forge-payments", "payments-api"])],
        new Set(["feature.entries", "forge-payments", "payments-api"]),
        new Set(),
      ).size,
    ).toBe(0);
    expect(
      foldsAway(
        [alias("cd-a", "feature.entries", "feature.forge-payments")],
        new Set(["feature.entries", "feature.forge-payments"]),
        new Set(),
      ).has("feature.forge-payments"),
    ).toBe(true);
  });

  it("follows a chain: X into Y into Z leaves out X and Y while Z is kept", () => {
    const away = foldsAway(
      [alias("cd-y", "feature.y", ["feature.x"]), alias("cd-z", "feature.z", ["feature.y"])],
      new Set(["feature.x", "feature.y", "feature.z"]),
      new Set(["feature.x", "feature.y"]),
    );
    expect(away.get("feature.x")).toEqual({
      into: "feature.z",
      detected: false,
      decisions: ["cd-y", "cd-z"],
    });
    expect(away.get("feature.y")).toEqual({
      into: "feature.z",
      detected: false,
      decisions: ["cd-z"],
    });
    // A cycle folds nothing away: no feature of it is the one kept.
    expect(
      foldsAway(
        [alias("cd-a", "feature.a", ["feature.b"]), alias("cd-b", "feature.b", ["feature.a"])],
        new Set(["feature.a", "feature.b"]),
        new Set(),
      ).size,
    ).toBe(0);
  });

  it("explains the removal by what happened to the entry points, beside the alias's problem", () => {
    expect(
      foldWords({
        into: "feature.entries",
        detected: false,
        problems: [
          "cd-alias-feature.entries: feature.entries isn't a detected feature, so nothing can be merged into it",
        ],
      }),
    ).toBe(
      "folded by an alias into a feature that isn't detected now (feature.entries): its entry points are in no feature (cd-alias-feature.entries: feature.entries isn't a detected feature, so nothing can be merged into it)",
    );
    expect(foldWords({ into: "feature.z", detected: true, problems: [] })).toBe(
      "folded by an alias into feature.z, which couldn't take it: its entry points are in no feature",
    );
  });
});

const arrow = (id: string, from: string, to: string, evidence: Record<string, unknown>[]) =>
  ({
    kind: "Interface",
    id,
    schemaVersion: 5,
    status: "current",
    confidence: "inferred",
    from,
    to,
    via: "direct",
    direction: "outbound",
    method: "GET",
    normalizedPath: "/payments",
    sync: "sync",
    evidence,
  }) as unknown as CatalogRecord;
const ev = (repo: string, side: string) => ({
  repo,
  side,
  path: "src/Client.java",
  line: 9,
  commit: "0".repeat(40),
  extractor: "spring@1.2.0",
  scannedAt: "2026-11-01T09:00:00+00:00",
  source: "code",
});
// forge-ledger and forge-orders had a readers slot at the upgrade and have none now (pruned).
const inputs = {
  "catalog/sources/readers/forge-ledger.json": "a".repeat(64),
  "catalog/sources/readers/forge-orders.json": "b".repeat(64),
  "catalog/sources/readers/forge-payments.json": "c".repeat(64),
};
const slots = {
  readers: new Map([["forge-payments", {}]]),
  facts: new Map(),
} as unknown as Parameters<typeof withUnslottedEnds>[4];
const held = new Set(["payments-api"]);

describe("which repos an end of a legacy arrow is of, its slot pruned (seed 1542546636)", () => {
  it("the repos the arrow's evidence names on the end's side", () => {
    const r = withUnslottedEnds(
      new Map(),
      [arrow("if-1", "orders-api", "payments-api", [ev("forge-orders", "caller")])],
      held,
      inputs,
      slots,
    );
    expect([...r.ends]).toEqual([["orders-api", ["forge-orders"]]]);
    expect(r.guessed).toEqual([]);
  });

  it("what every arrow naming the end agrees on, not the first arrow's", () => {
    const r = withUnslottedEnds(
      new Map(),
      [
        arrow("if-1", "orders-api", "payments-api", [
          ev("forge-orders", "caller"),
          ev("forge-ledger", "caller"),
        ]),
        arrow("if-2", "orders-api", "payments-api", [ev("forge-orders", "caller")]),
      ],
      held,
      inputs,
      slots,
    );
    expect(r.ends.get("orders-api")).toEqual(["forge-orders"]);
    // Arrows that disagree say nothing: every repo it can be of.
    const odd = withUnslottedEnds(
      new Map(),
      [
        arrow("if-1", "orders-api", "payments-api", [ev("forge-orders", "caller")]),
        arrow("if-2", "orders-api", "payments-api", [ev("forge-ledger", "caller")]),
      ],
      held,
      inputs,
      slots,
    );
    expect(odd.ends.get("orders-api")).toEqual(["forge-ledger", "forge-orders"]);
    expect(odd.guessed).toEqual(["orders-api"]);
  });

  it("with no evidence on its side, every repo it can be of, and that it is a guess", () => {
    const r = withUnslottedEnds(
      new Map(),
      [arrow("if-1", "orders-api", "payments-api", [ev("forge-payments", "callee")])],
      held,
      inputs,
      slots,
    );
    expect(r.ends.get("orders-api")).toEqual(["forge-ledger", "forge-orders"]);
    expect(r.guessed).toEqual(["orders-api"]);
  });

  it("words a guessed end of repos archived and removed as one line, archived or removed", () => {
    expect(
      endGoneWords(
        [
          { repo: "forge-ledger", archived: false },
          { repo: "forge-orders", archived: true },
        ],
        true,
      ),
    ).toEqual({
      words: ["its end is of forge-ledger or forge-orders, each archived or removed"],
      kinds: ["manifest", "archived"],
    });
    // One repo, or repos gone the same way, keep their own words.
    expect(endGoneWords([{ repo: "forge-orders", archived: true }], true)).toEqual({
      words: ["forge-orders is archived"],
      kinds: ["archived"],
    });
    expect(
      endGoneWords(
        [
          { repo: "forge-ledger", archived: false },
          { repo: "forge-orders", archived: true },
        ],
        false,
      ),
    ).toEqual({
      words: ["forge-ledger isn't in the manifests any more", "forge-orders is archived"],
      kinds: ["manifest", "archived"],
    });
  });
});
