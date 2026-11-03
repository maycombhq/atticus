import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Fact } from "@maycombhq/core";
import { dirSource, verifyFacts } from "../src/index.js";

/**
 * verify and reachable-first reading (ADR 0169), on the invented forge-house service: model files
 * the read plan left out (no entry point or call reaches them) are counted apart in coverage, not
 * as unknown and not in the ratio; and a reviewed glob over an entry point no fact cites is
 * refused, so a read can't sweep its controllers away as "nothing to record".
 */

const repo = dirSource(join(__dirname, "..", "..", "..", "fixtures", "reachable", "forge-house"));
const COMMIT = "0123abc";
const J = "src/main/java/forge/house";
const UNREACHED = [
  "AgentProfile",
  "InspectionReport",
  "LegacyListing",
  "MortgageQuote",
  "OpenHouseSlot",
].map((n) => `${J}/model/${n}.java`);

const entry = {
  kind: "entry",
  id: "entry.post.houses-listings",
  repo: "forge-house",
  commit: COMMIT,
  entryType: "rest",
  method: "POST",
  path: "/houses/listings",
  cite: {
    file: `${J}/api/HouseController.java`,
    line: 17,
    value: "/listings",
    with: [{ file: `${J}/api/HouseController.java`, line: 9, value: "/houses" }],
  },
} as unknown as Fact;

describe("coverage with model files left out (ADR 0169)", () => {
  it("counts the model files nothing reaches apart, and leaves them out of the ratio", async () => {
    const r = await verifyFacts({
      facts: [entry],
      source: repo,
      commit: COMMIT,
      notReached: UNREACHED,
    });
    expect(r.rejected).toEqual([]);
    expect(r.coverage.notReached).toEqual(UNREACHED);
    for (const p of UNREACHED) expect(r.coverage.unknown).not.toContain(p);
    const { read, reviewed, unknown } = r.coverage;
    expect(r.coverage.ratio).toBe(
      Math.round((read.length / (read.length + reviewed.length + unknown.length)) * 1000) / 1000,
    );
  });

  it("counts a left-out model file a fact cites as read", async () => {
    const field = {
      kind: "field",
      id: "field.slot.starts-at",
      repo: "forge-house",
      commit: COMMIT,
      owner: "entry.post.houses-listings",
      side: "response",
      name: "startsAt",
      type: "String",
      cite: { file: `${J}/model/OpenHouseSlot.java`, line: 4, value: "startsAt" },
    } as unknown as Fact;
    const r = await verifyFacts({
      facts: [entry, field],
      source: repo,
      commit: COMMIT,
      notReached: UNREACHED,
    });
    expect(r.coverage.read).toContain(`${J}/model/OpenHouseSlot.java`);
    expect(r.coverage.notReached).not.toContain(`${J}/model/OpenHouseSlot.java`);
  });

  it("has no notReached without a plan that leaves files out", async () => {
    const r = await verifyFacts({ facts: [entry], source: repo, commit: COMMIT });
    expect(r.coverage.notReached).toEqual([]);
    expect(r.coverage.unknown).toEqual(expect.arrayContaining(UNREACHED));
  });
});

describe("a reviewed glob over an entry point (ADR 0169)", () => {
  it("is refused when it covers an entry point no fact cites: read it", async () => {
    const r = await verifyFacts({
      facts: [],
      source: repo,
      commit: COMMIT,
      reviewed: [{ path: `${J}/**`, why: "DTOs, nothing to record", line: 1 }],
    });
    expect(r.reviewedProblems).toHaveLength(1);
    expect(r.reviewedProblems[0]!.message).toMatch(
      new RegExp(`covers ${J}/api/HouseController\\.java, an entry point .*: read it`),
    );
    expect(r.coverage.reviewed).toEqual([]);
  });

  it("holds when every entry point it covers is cited by a fact, or names files that aren't entry points", async () => {
    const r = await verifyFacts({
      facts: [entry],
      source: repo,
      commit: COMMIT,
      reviewed: [
        { path: `${J}/api/*`, why: "the controller, read", line: 1 },
        { path: `${J}/service/*`, why: "no I/O", line: 2 },
      ],
    });
    expect(r.reviewedProblems).toEqual([]);
    expect(r.coverage.reviewed).toEqual([`${J}/service/ListingService.java`]);
  });

  it("lets one entry-point file be reviewed by its own path", async () => {
    const r = await verifyFacts({
      facts: [],
      source: repo,
      commit: COMMIT,
      reviewed: [{ path: `${J}/api/HouseController.java`, why: "read: a stub", line: 1 }],
    });
    expect(r.reviewedProblems).toEqual([]);
  });
});
