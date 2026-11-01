import { describe, expect, it } from "vitest";
import { GAP_CONTEXT_LINES, planGaps, type GapsFrom } from "../src/index.js";

/**
 * R2: a second pass on the gaps only. The lists the last verify wrote (`<repo>.verify.yaml`) are
 * turned into a read plan for a fresh session: the files no fact cites, read whole, and the lines
 * the first pass left (skipped lines, reviewed globs that hold some, spec operations no entry
 * covers, entries no flow follows), each with a few lines round it. The repo is the invented
 * Forge ledger.
 */

const J = "src/main/java/forge/ledger";
const sizes: Record<string, { tokens: number; lines: number }> = {
  [`${J}/LedgerClient.java`]: { tokens: 4_000, lines: 400 },
  [`${J}/EntryController.java`]: { tokens: 2_000, lines: 200 },
  [`${J}/calc/Rounding.java`]: { tokens: 1_000, lines: 100 },
  [`${J}/calc/Fees.java`]: { tokens: 1_000, lines: 100 },
  "oas/ledger.yaml": { tokens: 3_000, lines: 300 },
  [`${J}/Unread.java`]: { tokens: 500, lines: 50 },
  [`${J}/Huge.java`]: { tokens: 250_000, lines: 25_000 },
};
const size = (f: string) => sizes[f];

const from: GapsFrom = {
  unknown: [`${J}/Unread.java`, `${J}/Gone.java`],
  skipped: [
    { cite: `${J}/LedgerClient.java:120`, kind: "url", value: "https://pay.northwind.example/v2" },
    { cite: `${J}/LedgerClient.java:130`, kind: "path", value: "/v2/charges" },
    { cite: `${J}/LedgerClient.java:390`, kind: "path", value: "/v2/refunds" },
  ],
  skippedCount: 5,
  reviewedHolds: [
    {
      path: `${J}/calc/*`,
      why: "pure arithmetic",
      count: 1,
      skipped: [{ cite: `${J}/calc/Fees.java:10`, kind: "topic", value: "ledger.fees" }],
    },
  ],
  specOpsUncovered: [
    {
      spec: "oas/ledger.yaml",
      method: "DELETE",
      path: "/entries/{id}",
      cite: "oas/ledger.yaml:42",
    },
  ],
  entriesNoFlowFollows: [
    {
      id: "e-post-entry",
      entryType: "rest",
      method: "POST",
      path: "/entries",
      cite: `${J}/EntryController.java:5`,
    },
  ],
};

describe("planGaps (R2)", () => {
  it("reads unknown files whole and the rest round their lines, every reason said", () => {
    const plan = planGaps(from, size, 100_000);
    expect(plan.sessions).toHaveLength(1);
    const reads = plan.sessions[0]!.reads;
    expect(reads.map((r) => r.path)).toEqual([
      "oas/ledger.yaml#L22-L62",
      `${J}/EntryController.java#L1-L25`,
      `${J}/LedgerClient.java#L100-L150`,
      `${J}/LedgerClient.java#L370-L400`,
      `${J}/Unread.java`,
      `${J}/calc/Fees.java#L1-L30`,
    ]);
    expect(GAP_CONTEXT_LINES).toBe(20);
    const client = reads[2]!;
    expect(client.why).toEqual([
      "line 120 writes the url https://pay.northwind.example/v2, which no fact cites",
      "line 130 writes the path /v2/charges, which no fact cites",
    ]);
    // A window's tokens are its lines' share of the file.
    expect(client.tokens).toBe(Math.ceil((4_000 * 51) / 400));
    expect(reads[4]!.why).toEqual(["no fact cites it: read it whole"]);
    expect(reads[1]!.why[0]).toBe(
      "line 5 is e-post-entry (rest POST /entries), which no flow follows: write its flow",
    );
    expect(reads[5]!.why[0]).toContain(`${J}/calc/* is reviewed as "pure arithmetic"`);
    expect(reads[0]!.why[0]).toBe(
      "line 42 declares DELETE /entries/{id}, which no entry covers: find the code that serves it",
    );
    // What verify.yaml counts but doesn't list, and the files gone since.
    expect(plan.unlisted).toBe(2);
    expect(plan.gone).toEqual([`${J}/Gone.java`]);
    expect(plan.tokens).toBe(reads.reduce((n, r) => n + r.tokens, 0));
    expect(plan.files).toBe(5);
  });

  it("splits into sessions within the room, and an unknown file bigger than it into ranges", () => {
    const plan = planGaps({ unknown: [`${J}/Huge.java`, `${J}/Unread.java`] }, size, 100_000);
    expect(plan.sessions.length).toBeGreaterThan(2);
    for (const s of plan.sessions) expect(s.tokens).toBeLessThanOrEqual(100_000);
    const paths = plan.sessions.flatMap((s) => s.reads.map((r) => r.path));
    expect(paths[0]).toMatch(/Huge\.java#L1-L\d+$/);
    expect(paths.filter((p) => p.includes("Huge")).length).toBeGreaterThan(2);
    expect(paths.at(-1)).toBe(`${J}/Unread.java`);
  });

  it("has nothing to read when verify left no gap", () => {
    expect(planGaps({}, size, 100_000)).toEqual({
      sessions: [],
      files: 0,
      tokens: 0,
      unlisted: 0,
      gone: [],
    });
  });

  it("is the same plan for the same lists in any order", () => {
    const reversed: GapsFrom = {
      ...from,
      unknown: [...from.unknown!].reverse(),
      skipped: [...from.skipped!].reverse(),
    };
    expect(planGaps(reversed, size, 100_000)).toEqual(planGaps(from, size, 100_000));
  });
});
