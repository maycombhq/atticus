import { describe, expect, it } from "vitest";
import { checkContracts, type Fact, type FactJoin } from "../src/index.js";

/**
 * The contract check's cost (review item 4, ADR 0164): an estate of 40 generated Forge repos,
 * each with 60 entries and 60 calls of 10 fields a side (2,520 facts a repo, 2,400 links), is
 * checked well under a second. Every repo's facts are indexed once, not scanned per link.
 */

const C = { verified: "line", by: "assistant", conf: "declared", commit: "abc1234" } as const;
const REPOS = 40;
const ENTRIES = 60;
const FIELDS = 10;

function estate() {
  const repos: { repo: string; facts: Fact[] }[] = [];
  const joins: FactJoin[] = [];
  for (let r = 0; r < REPOS; r++) {
    const repo = `forge-gen-${r}`;
    const next = `forge-gen-${(r + 1) % REPOS}`;
    const facts: Fact[] = [];
    for (let e = 0; e < ENTRIES; e++) {
      const cite = { file: "src/app.ts", line: e + 1, value: "x" };
      facts.push({
        kind: "entry",
        id: `entry.${e}`,
        repo,
        entryType: "rest",
        method: "GET",
        path: `/r${r}/e${e}`,
        cite,
        ...C,
      } as Fact);
      facts.push({
        kind: "call",
        id: `call.${e}`,
        repo,
        callType: "rest",
        method: "GET",
        path: `/r${(r + 1) % REPOS}/e${e}`,
        cite,
        ...C,
      } as Fact);
      for (let f = 0; f < FIELDS; f++)
        for (const [owner, side] of [
          [`entry.${e}`, "request"],
          [`entry.${e}`, "response"],
          [`call.${e}`, "request"],
          [`call.${e}`, "response"],
        ] as const)
          facts.push({
            kind: "field",
            id: `field.${owner}.${side}.${f}`,
            repo,
            owner,
            side,
            // every tenth call reads a field its entry never returns
            name:
              f === 0 && side === "response" && owner.startsWith("call") && e % 10 === 0
                ? "gone"
                : `n${f}`,
            type: "string",
            cite: { file: "src/dto.ts", line: f + 1, value: "n" },
            ...C,
          } as Fact);
    }
    for (let e = 0; e < ENTRIES; e++)
      joins.push({
        how: "host",
        callType: "rest",
        interface: `if-${r}-${e}`,
        call: { repo, fact: `call.${e}`, component: repo, at: "src/app.ts:1" },
        entry: { repo: next, fact: `entry.${e}`, component: next, at: "src/app.ts:1" },
        path: `/r${(r + 1) % REPOS}/e${e}`,
      });
    repos.push({ repo, facts });
  }
  return { repos, join: { joins, asks: [], misses: [], lineage: [], gaps: [] } };
}

describe("the contract check on a 40-repo estate", () => {
  it("checks 2,400 links well under a second", () => {
    const input = estate();
    expect(input.repos[0]!.facts).toHaveLength(2520);
    // CPU time, not the clock: a shared CI machine's other work doesn't count against it. A
    // scan per link took several seconds here; indexed, it is a fraction of one.
    const t = process.cpuUsage();
    const r = checkContracts(input);
    const used = process.cpuUsage(t);
    const ms = (used.user + used.system) / 1000;
    expect(r.counts).toMatchObject({ links: 2400, compared: 2400, mismatches: 240 });
    expect(ms).toBeLessThan(1000);
  });
});
