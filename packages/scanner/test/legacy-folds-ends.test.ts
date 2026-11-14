import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { CatalogRecord } from "@maycombhq/core";
import { endGoneWords, endsGone, foldWords, foldsAway, withUnslottedEnds } from "../src/build.js";
import { buildCatalog, loadBuildInputs } from "../src/index.js";

/**
 * Beta.28.1, the review of fix/b281-seeds: what the legacy overlay does with an alias whose target
 * only the overlay keeps (seed 1539914139), and which repos a legacy arrow's end is of once prune
 * took its slot (seed 1542546636).
 */

const alias = (id: string, target: string, value: unknown) => ({ id, target, value });

const FORGE = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/forge");
const made: string[] = [];
afterAll(async () => {
  await Promise.all(made.map((d) => rm(d, { recursive: true, force: true })));
});
/** The Forge org pack and its golden readers slots: no legacy records at all. */
async function forge(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-folds-"));
  made.push(root);
  await cp(join(FORGE, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
  await cp(join(FORGE, "slots/readers"), join(root, "catalog/sources/readers"), {
    recursive: true,
  });
  return root;
}
const decision = (id: string, target: string, value: string) =>
  [
    "schemaVersion: 5",
    "kind: CuratedDecision",
    `id: ${id}`,
    "status: current",
    "confidence: asserted",
    `target: ${target}`,
    "action: alias",
    "value:",
    `  - ${value}`,
    "reason: A person's decision in a test.",
    "by: forge.dev",
    "at: 2026-11-11T10:00:00Z",
    "",
  ].join("\n");

describe("a feature an alias folds into a feature the overlay keeps (seed 1539914139)", () => {
  it("leaves out the folded feature while its target is kept and not detected", () => {
    const away = foldsAway(
      [alias("cd-alias-feature.entries", "feature.entries", ["feature.forge-payments"])],
      new Set(["feature.entries", "feature.forge-payments"]),
      new Set(["feature.forge-payments"]),
    );
    expect([...away]).toEqual([
      [
        "feature.forge-payments",
        { into: "feature.entries", decisions: ["cd-alias-feature.entries"] },
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

  it("follows a chain: X into Y into Z leaves out X and Y while Z is kept and not detected", () => {
    const away = foldsAway(
      [alias("cd-y", "feature.y", ["feature.x"]), alias("cd-z", "feature.z", ["feature.y"])],
      new Set(["feature.x", "feature.y", "feature.z"]),
      new Set(["feature.x", "feature.y"]),
    );
    expect(away.get("feature.x")).toEqual({ into: "feature.z", decisions: ["cd-y", "cd-z"] });
    expect(away.get("feature.y")).toEqual({ into: "feature.z", decisions: ["cd-z"] });
    // A cycle folds nothing away: no feature of it is the one kept.
    expect(
      foldsAway(
        [alias("cd-a", "feature.a", ["feature.b"]), alias("cd-b", "feature.b", ["feature.a"])],
        new Set(["feature.a", "feature.b"]),
        new Set(),
      ).size,
    ).toBe(0);
  });

  it("folds nothing away into a detected feature: what the features pass left is the pass's", () => {
    // cd-a (Y into Z) before cd-b (X into Y): the pass merges Y into Z, then has no Y for X.
    expect(
      foldsAway(
        [alias("cd-a", "feature.z", ["feature.y"]), alias("cd-b", "feature.y", ["feature.x"])],
        new Set(["feature.x", "feature.z"]),
        new Set(["feature.x", "feature.z"]),
      ).size,
    ).toBe(0);
  });

  it("stops at a kept feature when the chain goes on to one in no record", () => {
    // X into Y, Y into W; Y kept (by the overlay alone), W nowhere: X goes into Y, Y stays.
    const away = foldsAway(
      [alias("cd-y", "feature.y", ["feature.x"]), alias("cd-w", "feature.w", ["feature.y"])],
      new Set(["feature.x", "feature.y"]),
      new Set(["feature.x"]),
    );
    expect([...away]).toEqual([["feature.x", { into: "feature.y", decisions: ["cd-y"] }]]);
  });

  it("explains the removal once, and what to do about it", () => {
    expect(foldWords({ into: "feature.entries", decisions: ["cd-alias-feature.entries"] })).toBe(
      "folded by cd-alias-feature.entries into feature.entries, which isn't a detected feature now: its entry points are in no feature (remove the alias, or point it at a detected feature)",
    );
  });

  it("an estate with no legacy records builds what the features pass gives, chained aliases too", async () => {
    const root = await forge();
    const feats = (await buildCatalog(await loadBuildInputs(root))).records
      .filter((r) => r.kind === "Capability")
      .map((r) => r.id)
      .sort();
    expect(feats.length).toBeGreaterThanOrEqual(3);
    const [x, y, z] = feats as [string, string, string];
    await mkdir(join(root, "catalog/curated/curateddecision"), { recursive: true });
    await writeFile(
      join(root, "catalog/curated/curateddecision/cd-a.yaml"),
      decision("cd-a", z, y),
    );
    await writeFile(
      join(root, "catalog/curated/curateddecision/cd-b.yaml"),
      decision("cd-b", y, x),
    );
    const b = await buildCatalog(await loadBuildInputs(root));
    const after = b.records
      .filter((r) => r.kind === "Capability")
      .map((r) => r.id)
      .sort();
    // Y merged into Z; X stays, as the pass left it (its alias's target is gone).
    expect(after).toEqual(feats.filter((f) => f !== y));
    expect(b.curated.stranded ?? []).toEqual([]);
    expect(b.problems.some((p) => p.source === "features" && p.message.startsWith("cd-b:"))).toBe(
      true,
    );
  }, 300_000);
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

  it("the repos any arrow naming the end names, so an end of several repos stays while one is live", () => {
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
    expect(r.ends.get("orders-api")).toEqual(["forge-ledger", "forge-orders"]);
    expect(r.guessed).toEqual(["orders-api"]);
    // forge-orders archived, forge-ledger listed but unread for now: the arrow its own evidence
    // says may be of forge-ledger stays (ADR 0195 point 6), and so does the other (a superset).
    const live = new Set(["forge-ledger", "forge-payments"]);
    const [if1, if2] = [
      arrow("if-1", "orders-api", "payments-api", []),
      arrow("if-2", "orders-api", "payments-api", []),
    ];
    expect(endsGone(if1, r.ends, live)).toEqual([]);
    expect(endsGone(if2, r.ends, live)).toEqual([]);
    // Once neither may be live, both leave, by both repos.
    expect(endsGone(if1, r.ends, new Set(["forge-payments"]))).toEqual([
      "forge-ledger",
      "forge-orders",
    ]);
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

  it("words a guessed end of repos archived and removed as one line", () => {
    expect(
      endGoneWords(
        [
          { repo: "forge-ledger", archived: false },
          { repo: "forge-orders", archived: true },
        ],
        true,
      ),
    ).toEqual({
      words: ["its end is of forge-ledger or forge-orders, each archived or out of the manifests"],
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
