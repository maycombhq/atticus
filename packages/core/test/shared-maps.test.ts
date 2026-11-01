import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applySharedMaps,
  JOIN_HOW_FLAGS,
  joinFacts,
  joinSharedMaps,
  JOINED_TO_SHARED_MAP,
  NOT_IN_SHARED_MAP,
  parseFactsLines,
  readSharedMaps,
  SHARED_MAP_EVIDENCE,
  stripSharedMaps,
  type CatalogRecord,
  type SharedMap,
} from "../src/index.js";

/**
 * Another team's map, read-only (O3, ADR 0160), on the invented fixtures/shared-maps: our
 * forge-lending calls the Forge Risk Team's system (forge-risk, boundary internal, its host
 * risk.forge.internal an alias). The team runs Atticus on forge-risk-scoring (on that host, under
 * /risk) and forge-risk-limits.
 */

const FX = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/shared-maps");
const facts = async (p: string) => parseFactsLines(await readFile(join(FX, p), "utf8")).facts;
const systems = [{ id: "forge-risk", name: "Forge Risk", aliases: ["risk.forge.internal"] }];

async function theirMap(): Promise<SharedMap> {
  const entries = async (repo: string) =>
    (await facts(`risk-team/facts/${repo}.jsonl`)).filter(
      (f) => f.kind === "entry" && f.verified !== "none",
    );
  return {
    team: "forge-risk-team",
    name: "Forge Risk Team",
    system: "forge-risk",
    commit: "9999abc",
    repos: [
      {
        repo: "forge-risk-scoring",
        component: "scoring-api",
        hosts: ["risk.forge.internal"],
        basePath: "/risk",
        entries: 2,
        facts: await entries("forge-risk-scoring"),
      },
      {
        repo: "forge-risk-limits",
        component: "limits-api",
        hosts: [],
        entries: 1,
        facts: await entries("forge-risk-limits"),
      },
    ],
  };
}

async function ours() {
  const repos = [
    {
      repo: "forge-lending",
      component: "lending-api",
      hosts: ["lending.forge.internal"],
      facts: await facts("facts/forge-lending.jsonl"),
    },
  ];
  const join = joinFacts({
    repos,
    outside: ["forge-risk", "Forge Risk", "risk.forge.internal"],
  });
  return { repos, join };
}

describe("joinSharedMaps (O3)", () => {
  it("joins the calls left to the team's system to the entry of their map that serves each", async () => {
    const { repos, join } = await ours();
    // The estate join leaves all three to the outside system, as before.
    expect(join.outside?.map((o) => o.call.fact).sort()).toEqual([
      "call.get.v1-limits-customerid",
      "call.post.risk-v1-fraud-checks",
      "call.post.risk-v1-scores",
    ]);
    const r = joinSharedMaps({ outside: join.outside!, repos, maps: [await theirMap()], systems });
    expect(r.matches).toEqual([
      {
        call: {
          repo: "forge-lending",
          fact: "call.get.v1-limits-customerid",
          component: "lending-api",
          at: "src/main/java/forge/lending/RiskClient.java:15",
        },
        team: "forge-risk-team",
        system: "forge-risk",
        entry: {
          team: "forge-risk-team",
          repo: "forge-risk-limits",
          fact: "entry.get.v1-limits-customerid",
          component: "limits-api",
          at: "src/main/java/forge/risk/limits/LimitsController.java:10",
          commit: "6666fff",
        },
        method: "GET",
        path: "/v1/limits/{customerId}",
      },
      // On their host, under the base path their manifest gives.
      expect.objectContaining({
        call: expect.objectContaining({ fact: "call.post.risk-v1-scores" }),
        entry: expect.objectContaining({
          repo: "forge-risk-scoring",
          fact: "entry.post.v1-scores",
          component: "scoring-api",
          commit: "5555eee",
        }),
        method: "POST",
        path: "/v1/scores",
      }),
    ]);
    // Their map serves nothing like the fraud check: a gap, theirs to answer.
    expect(r.gaps).toEqual([
      expect.objectContaining({
        call: expect.objectContaining({ fact: "call.post.risk-v1-fraud-checks" }),
        team: "forge-risk-team",
        message: expect.stringContaining(
          "Forge Risk Team's map (their commit 9999abc) has no entry",
        ),
      }),
    ]);
    expect(r.asks).toEqual([]);
  });

  it("asks when two of their entries answer a call equally well, and leaves other systems alone", async () => {
    const { repos, join } = await ours();
    const map = await theirMap();
    const twin = {
      ...map.repos[1]!,
      repo: "forge-risk-limits-v2",
      facts: map.repos[1]!.facts.map((f) => ({ ...f, repo: "forge-risk-limits-v2" })),
    };
    const r = joinSharedMaps({
      outside: join.outside!,
      repos,
      maps: [{ ...map, repos: [...map.repos, twin] }],
      systems,
    });
    expect(r.asks).toHaveLength(1);
    expect(r.asks[0]!.candidates.map((c) => c.repo)).toEqual([
      "forge-risk-limits",
      "forge-risk-limits-v2",
    ]);
    expect(r.asks[0]!.question).toMatch(/^Which of Forge Risk Team's entries answers GET/);
    // A map for another system takes none of these calls.
    const none = joinSharedMaps({
      outside: join.outside!,
      repos,
      maps: [{ ...map, system: "northwind-pay" }],
      systems: [...systems, { id: "northwind-pay", name: "Northwind Pay", aliases: [] }],
    });
    expect(none).toEqual({ matches: [], gaps: [], asks: [] });
  });
});

describe("the marks on the catalog (O3)", () => {
  const iface = (line: number, to = "forge-risk"): CatalogRecord =>
    ({
      kind: "Interface",
      schemaVersion: 3,
      id: `if-${line}`,
      status: "current",
      confidence: "inferred",
      conflicts: [],
      evidence: [
        {
          source: "code",
          repo: "forge-lending",
          path: "src/main/java/forge/lending/RiskClient.java",
          line,
          commit: "1111aaa",
          side: "caller",
          by: "assistant",
        },
      ],
      from: "lending-api",
      to,
      via: "direct",
      method: "POST",
      normalizedPath: "/x",
      sync: "sync",
      direction: "outbound",
    }) as CatalogRecord;

  it("cites their entry on the Interface, flags it, keeps its id, to and confidence, and comes off again", async () => {
    const { repos, join } = await ours();
    const r = joinSharedMaps({ outside: join.outside!, repos, maps: [await theirMap()], systems });
    const before = [iface(14), iface(15), iface(16), iface(14, "somewhere-else")];
    const after = applySharedMaps(before, r, systems);
    const at14 = after[0] as CatalogRecord & { flags?: string[] };
    expect(at14).toMatchObject({ id: "if-14", to: "forge-risk", confidence: "inferred" });
    expect(at14.flags).toEqual([JOINED_TO_SHARED_MAP]);
    expect(at14.evidence.at(-1)).toEqual({
      source: "code",
      repo: "forge-risk-scoring",
      path: "src/main/java/forge/risk/ScoresController.java",
      line: 12,
      commit: "5555eee",
      side: "callee",
      extractor: SHARED_MAP_EVIDENCE,
      by: "forge-risk-team",
    });
    expect((after[2] as { flags?: string[] }).flags).toEqual([NOT_IN_SHARED_MAP]);
    // An Interface to something else at the same line is not theirs to mark.
    expect(after[3]).toEqual(before[3]);
    // Applying twice is applying once; stripping gives the records back as they were.
    expect(applySharedMaps(after, r, systems)).toEqual(after);
    expect(stripSharedMaps(after)).toEqual(before);
    // Joined to a shared map is how a link was made, never a gap; no entry is a gap.
    expect(JOIN_HOW_FLAGS.has(JOINED_TO_SHARED_MAP)).toBe(true);
    expect(JOIN_HOW_FLAGS.has(NOT_IN_SHARED_MAP)).toBe(false);
  });
});

describe("readSharedMaps (O3)", () => {
  it("reads each team's map.yaml and their entries only, and says what doesn't read", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-shared-"));
    expect(await readSharedMaps(root)).toEqual({ maps: [], problems: [] });
    await mkdir(join(root, "shared/forge-risk-team/facts"), { recursive: true });
    await writeFile(
      join(root, "shared/forge-risk-team/map.yaml"),
      [
        "schemaVersion: 1",
        "team: forge-risk-team",
        "name: Forge Risk Team",
        "system: forge-risk",
        "source: ../risk-team",
        "commit: 9999abc",
        "importedAt: 2026-11-01T10:00:00Z",
        "repos:",
        "  - { repo: forge-risk-scoring, component: scoring-api, commit: 5555eee, hosts: [risk.forge.internal], basePath: /risk, entries: 2 }",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(root, "shared/forge-risk-team/facts/forge-risk-scoring.jsonl"),
      await readFile(join(FX, "risk-team/facts/forge-risk-scoring.jsonl"), "utf8"),
    );
    await mkdir(join(root, "shared/broken"), { recursive: true });
    await writeFile(join(root, "shared/broken/map.yaml"), "schemaVersion: 1\nteam: other\n");
    const { maps, problems } = await readSharedMaps(root);
    expect(maps.map((m) => [m.team, m.system, m.commit])).toEqual([
      ["forge-risk-team", "forge-risk", "9999abc"],
    ]);
    // A call and a field in the file are never read: their entries only.
    expect(maps[0]!.repos[0]!.facts.every((f) => f.kind === "entry")).toBe(true);
    expect(problems).toEqual([
      {
        team: "broken",
        message: expect.stringContaining("shared/broken/map.yaml isn't a shared map"),
      },
    ]);
  });
});
