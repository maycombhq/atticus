import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  JOINED_TO_SHARED_MAP,
  loadOrgPack,
  NOT_IN_SHARED_MAP,
  parseFactsLines,
  SHARED_MAP_EVIDENCE,
  type CatalogRecord,
  type OrgPack,
  type SharedMap,
} from "@maycombhq/core";
import { catalogWithFacts } from "../src/index.js";

/**
 * O3 (ADR 0160): a write with another team's shared map marks the calls the join left to their
 * system, cited on their entry's line; the Interface stays ours, to their system; a write without
 * the map takes every mark off. On the invented fixtures/shared-maps.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FX = join(HERE, "../../../fixtures/shared-maps");
const FORGE = join(HERE, "../../../fixtures/forge/metarepo/org-pack");
let op: OrgPack;

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), "atticus-shared-cat-"));
  await cp(FORGE, join(root, "org-pack"), { recursive: true });
  await writeFile(join(root, "org-pack/sources.yaml"), "schemaVersion: 1\nwikis: []\n");
  await cp(join(FX, "org-pack/profiles/forge"), join(root, "org-pack/profiles/forge"), {
    recursive: true,
  });
  op = await loadOrgPack(join(root, "org-pack"));
});

const facts = async (p: string) => parseFactsLines(await readFile(join(FX, p), "utf8")).facts;

async function map(): Promise<SharedMap> {
  const entries = async (r: string) =>
    (await facts(`risk-team/facts/${r}.jsonl`)).filter((f) => f.kind === "entry");
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

type Iface = Extract<CatalogRecord, { kind: "Interface" }>;
const ifaces = (rs: readonly CatalogRecord[]) =>
  rs.filter((r): r is Iface => r.kind === "Interface").sort((a, b) => (a.id < b.id ? -1 : 1));

describe("catalogWithFacts with a shared map (O3)", () => {
  it("cites their entries on our Interfaces to their system, and takes the marks off without the map", async () => {
    const mine = await facts("facts/forge-lending.jsonl");
    const plain = catalogWithFacts({
      repo: "forge-lending",
      facts: mine,
      existing: [],
      op,
      decisions: [],
      estate: [],
    });
    const out = catalogWithFacts({
      repo: "forge-lending",
      facts: mine,
      existing: plain.records,
      op,
      decisions: [],
      estate: [],
      shared: [await map()],
    });
    const by = Object.fromEntries(ifaces(out.records).map((i) => [i.normalizedPath, i]));
    expect(by["/risk/v1/scores"]).toMatchObject({
      to: "forge-risk",
      flags: [JOINED_TO_SHARED_MAP],
    });
    expect(by["/risk/v1/scores"]!.evidence).toContainEqual(
      expect.objectContaining({
        repo: "forge-risk-scoring",
        path: "src/main/java/forge/risk/ScoresController.java",
        line: 12,
        side: "callee",
        extractor: SHARED_MAP_EVIDENCE,
        by: "forge-risk-team",
      }),
    );
    expect(by["/v1/limits/{}"]).toMatchObject({ to: "forge-risk", flags: [JOINED_TO_SHARED_MAP] });
    expect(by["/risk/v1/fraud-checks"]!.flags).toEqual([NOT_IN_SHARED_MAP]);
    // The same ids as without the map, and nothing of theirs is a record of ours.
    expect(ifaces(out.records).map((i) => i.id)).toEqual(ifaces(plain.records).map((i) => i.id));
    expect(out.records.map((r) => `${r.kind}|${r.id}`)).toEqual(
      plain.records.map((r) => `${r.kind}|${r.id}`),
    );
    expect(
      out.records.some(
        (r) =>
          (r as { repo?: string }).repo?.startsWith("forge-risk") ||
          (r.kind !== "Interface" &&
            (r.evidence as { repo?: string }[]).some((e) => e.repo?.startsWith("forge-risk"))),
      ),
    ).toBe(false);
    expect(out.shared?.matches.map((m) => m.entry.fact).sort()).toEqual([
      "entry.get.v1-limits-customerid",
      "entry.post.v1-scores",
    ]);
    expect(out.shared?.gaps.map((g) => g.call.fact)).toEqual(["call.post.risk-v1-fraud-checks"]);

    // The map taken away: the next write leaves the catalog as it was before it came.
    const again = catalogWithFacts({
      repo: "forge-lending",
      facts: mine,
      existing: out.records,
      op,
      decisions: [],
      estate: [],
    });
    expect(again.records).toEqual(plain.records);
    expect(again.shared).toBeUndefined();
  });
});
