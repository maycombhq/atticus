import { describe, expect, it } from "vitest";
import {
  CARD_WORDS,
  cardLines,
  countBand,
  platformWord,
  RECORD_BANDS,
  recordBand,
  REPO_BANDS,
  repoBand,
  SHAPE_FLAGS,
  shapeText,
  timeBand,
  type ShapeCard,
} from "../src/shape-words.js";
import { fieldOptionsOf, parseShape, RECORDS_AT, REPOS_AT, SHAPE_REPOS } from "./field-estate.js";

/** ADR 0202 point 10: the shape card's words are a fixed list, and a shape is made only of them. */
describe("the shape card's fixed words", () => {
  it("are the ADR's, and no others", () => {
    expect(REPO_BANDS).toEqual(["1-5", "6-20", "21-50", "51-100", "over-100"]);
    expect(RECORD_BANDS).toEqual(["under-1k", "1k-10k", "10k-50k", "50k-200k", "over-200k"]);
    expect(SHAPE_FLAGS).toEqual([
      "gateway-proxies",
      "deploy-token-hosts",
      "repos-with-no-system",
      "dotted-ids",
      "nested-payloads",
      "ssh-origins",
      "https-origins",
      "non-gateway-callee",
      "legacy-slots",
      "hand-pairings",
      "empty-repo",
      "unread-repo",
    ]);
  });

  it("each count falls in one band, and each band is made at a size inside it", () => {
    expect([0, 5, 6, 20, 21, 50, 51, 100, 101].map(repoBand)).toEqual([
      "1-5",
      "1-5",
      "6-20",
      "6-20",
      "21-50",
      "21-50",
      "51-100",
      "51-100",
      "over-100",
    ]);
    expect([999, 1_000, 9_999, 10_000, 49_999, 50_000, 199_999, 200_000].map(recordBand)).toEqual([
      "under-1k",
      "1k-10k",
      "1k-10k",
      "10k-50k",
      "10k-50k",
      "50k-200k",
      "50k-200k",
      "over-200k",
    ]);
    expect(
      [4_999, 5_000, 29_999, 30_000, 119_999, 120_000, 599_999, 600_000].map(timeBand),
    ).toEqual(["under-5s", "5-30s", "5-30s", "30s-2m", "30s-2m", "2-10m", "2-10m", "over-10m"]);
    for (const b of REPO_BANDS) expect(repoBand(REPOS_AT[b])).toBe(b);
    for (const b of RECORD_BANDS) expect(recordBand(RECORDS_AT[b])).toBe(b);
    expect(
      [0, 1, 9, 10, 99, 100, 999, 1_000, 9_999, 10_000, 99_999, 100_000].map(countBand),
    ).toEqual([
      "0",
      "1-9",
      "1-9",
      "10-99",
      "10-99",
      "100-999",
      "100-999",
      "1k-10k",
      "1k-10k",
      "10k-100k",
      "10k-100k",
      "over-100k",
    ]);
    expect(["win32", "darwin", "linux", "freebsd"].map(platformWord)).toEqual([
      "windows",
      "macos",
      "linux",
      "linux",
    ]);
  });

  it("a card's lines hold only words of the list", () => {
    const card: ShapeCard = {
      repos: "21-50",
      records: "10k-50k",
      flags: ["legacy-slots", "gateway-proxies"],
      platform: "windows",
      slowest: { step: "build", time: "2-10m" },
    };
    expect(cardLines(card)).toEqual([
      "repos: 21-50",
      "records: 10k-50k",
      "flags: gateway-proxies legacy-slots",
      "platform: windows",
      "slowest step: build 2-10m",
    ]);
    const none: ShapeCard = { ...card, flags: [], slowest: { step: "none" } };
    for (const l of [...cardLines(card), ...cardLines(none)])
      for (const w of l.split(/[\s:]+/).filter(Boolean)) expect(CARD_WORDS.has(w), w).toBe(true);
  });

  it("a shape's text reads back as the shape, and a word off the list is refused", () => {
    const shape = {
      repos: "6-20",
      records: "1k-10k",
      flags: ["gateway-proxies", "dotted-ids", "hand-pairings"],
    } as const;
    const text = shapeText({ ...shape, flags: [...shape.flags].reverse() });
    expect(text).toBe("6-20,1k-10k,gateway-proxies,dotted-ids,hand-pairings");
    expect(parseShape(text)).toEqual({ ...shape, flags: [...shape.flags] });
    // The card as printed reads back too: its other words are allowed and ignored.
    expect(
      parseShape(
        "repos: 6-20 records: 1k-10k flags: gateway-proxies dotted-ids hand-pairings platform: linux slowest step: build 30s-2m",
      ),
    ).toEqual({ ...shape, flags: [...shape.flags] });
    expect(() => parseShape("6-20 forge-ledger")).toThrow(/not a word of the shape card/);
  });

  it("a shape that can't be made as asked is refused, never made larger", () => {
    expect(() =>
      fieldOptionsOf({ repos: "1-5", records: "under-1k", flags: [...SHAPE_FLAGS] }),
    ).toThrow(/more than the band 1-5 holds/);
    expect(() =>
      fieldOptionsOf({ repos: "6-20", records: "under-1k", flags: ["hand-pairings"] }),
    ).toThrow(/add gateway-proxies, or non-gateway-callee/);
    const all = fieldOptionsOf({ repos: "6-20", records: "1k-10k", flags: [...SHAPE_FLAGS] });
    expect(all.services! + all.gateways! + Object.keys(SHAPE_REPOS).length).toBe(REPOS_AT["6-20"]);
  });
});
