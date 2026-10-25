import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { MockRuntime, type AiRequest } from "@maycombhq/ai";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import {
  architectureStage,
  EXPAND_AGENT,
  featureStage,
  PAST_CORRECTIONS_RULE,
  pastCorrectionsText,
  storiesStage,
} from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "../../../fixtures/stages");
const SPECS_CATALOG = join(HERE, "../../../fixtures/specs/catalog.yaml");
const NOW = new Date("2026-10-21T09:00:00Z");
const CHANGE = "add-fraud-check";

async function estateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-past-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  const rows = [
    ...(parse(readFileSync(SPECS_CATALOG, "utf8")) as unknown[]),
    ...(parse(readFileSync(join(FIX, "catalog-extra.yaml"), "utf8")) as unknown[]),
  ];
  for (const r of rows) {
    const p = parseRecord(r);
    if (!p.ok) throw new Error(`bad fixture record: ${JSON.stringify(p.issues)}`);
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  for (const r of parse(readFileSync(join(FIX, "knowledge.yaml"), "utf8")) as unknown[]) {
    const p = parseRecord(r);
    if (!p.ok) throw new Error(`bad knowledge record: ${JSON.stringify(p.issues)}`);
    const f = join(root, "knowledge/items", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  await cp(join(FIX, "specs"), join(root, "specs"), { recursive: true });
  await cp(join(FIX, "changes"), join(root, "openspec/changes"), { recursive: true });
  return root;
}

const EXPANSION = `terms: [fraud screen, place order, reserve stock]
names:
  - { name: Northwind Pay, id: northwind-pay, quote: screened by Northwind Pay }
`;

function assistant(drafts: string[], seen: string[] = []) {
  let n = 0;
  return new MockRuntime(
    (req: AiRequest) => {
      if (req.agent.id.endsWith("-critic")) return "findings: []";
      if (req.agent.id === EXPAND_AGENT) return EXPANSION;
      seen.push(req.pack.prompt);
      return drafts[Math.min(n++, drafts.length - 1)]!;
    },
    { now: () => NOW },
  );
}

const PLACED = readFileSync(join(FIX, "corrections/answers/feature.yaml"), "utf8");
const DELTAS = readFileSync(join(FIX, "corrections/answers/architecture.yaml"), "utf8");
const STORIES = readFileSync(join(FIX, "corrections/answers/stories.yaml"), "utf8");

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** The three stages' first prompts for the fraud check. */
async function prompts(root: string): Promise<{ feature: string; arch: string; stories: string }> {
  const f: string[] = [];
  expect(
    (await featureStage(root, CHANGE, { runtime: assistant([PLACED], f), now: NOW })).state,
  ).toBe("done");
  const a: string[] = [];
  expect(
    (await architectureStage(root, CHANGE, { runtime: assistant([DELTAS], a), now: NOW })).state,
  ).toBe("done");
  const s: string[] = [];
  expect(
    (await storiesStage(root, CHANGE, { runtime: assistant([STORIES], s), now: NOW })).state,
  ).toBe("done");
  return { feature: f[0]!, arch: a[0]!, stories: s[0]! };
}

/**
 * The prompts' sha256 before H2, with no past pair (recorded from the code before this change):
 * a metarepo without kept pairs, or with none that differs, sends these exact prompts, so
 * recorded replays keep matching.
 */
const BEFORE = {
  // B2 (a): re-pinned when the feature stage began to select and send the org's knowledge (its
  // items, a new rule to name them where they bear on a gap); the hand-written answer
  // (corrections/answers/feature.yaml) was re-written for it: its gap names the two items.
  feature: "4e3363a5f6c7bb3a8f1b0861534d478e0cf1249773800e99ef02e85334b0c47f",
  // re-pinned after B-places asked the architect for an added step's place (`at`); and in B2,
  // because its input, the feature answer above, changed (its code didn't; the architecture
  // answer still fits and is unchanged)
  arch: "7d8cd9985953fb192c68debdbe110dd6ff09f873e6c733304b819c2f3a69396a",
  stories: "2e4b6a0bf2c1f970b3bd4e50aca99ead1f0db3cf43a2039788c12aa3c397658b",
};

const ARCHIVE = join(FIX, "corrections/changes/archive");

async function withPast(names: string[]): Promise<string> {
  const root = await estateRoot();
  for (const n of names)
    await cp(join(ARCHIVE, n), join(root, "openspec/changes/archive", n), { recursive: true });
  return root;
}

const hashes = (p: { feature: string; arch: string; stories: string }) => ({
  feature: sha(p.feature),
  arch: sha(p.arch),
  stories: sha(p.stories),
});

describe("past corrections in a stage's prompt (H2)", () => {
  it("leaves every stage's prompt byte for byte as it was when no past pair exists", async () => {
    expect(hashes(await prompts(await estateRoot()))).toEqual(BEFORE);
  });

  it("leaves it as it was when the only past pair merged as drafted", async () => {
    expect(hashes(await prompts(await withPast(["2026-10-04-reserve-later"])))).toEqual(BEFORE);
  });

  it("gives each stage the closest past pairs, at most two, as data with the rule to learn from them", async () => {
    const p = await prompts(
      await withPast([
        "2026-09-06-screen-orders",
        "2026-09-19-bulk-orders",
        "2026-10-04-reserve-later",
      ]),
    );
    for (const prompt of [p.feature, p.arch, p.stories]) {
      expect(prompt).toContain(PAST_CORRECTIONS_RULE);
      expect(prompt).not.toContain("## reserve-later");
    }
    // Feature: before placement only the system and the entry are known; both share them, newest first.
    expect(p.feature).toContain(
      "## bulk-orders, feature stage (PR #7, merged 2026-09-15); shares system forge, entry brief",
    );
    expect(p.feature.indexOf("## bulk-orders")).toBeLessThan(p.feature.indexOf("## screen-orders"));
    expect(p.feature).toContain(
      [
        "feature.yaml, line 14: the draft said",
        "      how: changed",
        "      why: Reserving stock waits for the screen.",
        "the team changed it to",
        "      how: read",
        "      why: Reserving stock happens only after the screen passes.",
      ].join("\n"),
    );
    expect(p.feature.match(/^## [a-z-]+, feature stage/gm)).toHaveLength(2);
    // Architecture: only screen-orders kept a target flow; it shares the table the fraud check writes.
    expect(p.arch).toContain(
      "## screen-orders, architecture stage (PR #4, merged 2026-09-03); shares repo forge-orders, table forge-orders-db.orders, flow forge-orders.place-order, system forge",
    );
    expect(p.arch).toContain("varchar(10) }, migration: V4__verdict.sql");
    expect(p.arch).toContain(
      "varchar(20) }, classification: { fraud_verdict: internal }, migration: V4__add_fraud_verdict.sql",
    );
    // Stories: the criterion the team took out, and the one they put in.
    expect(p.stories).toContain("- Given any order, when it is placed, then it is logged.");
    expect(p.stories).toContain(
      "- Given a rejected verdict, when the order is placed, then 422 says the verdict refused it and no stock is reserved.",
    );
    expect(p.stories.match(/^## [a-z-]+, stories stage/gm)).toHaveLength(2);
  });
});

describe("the past corrections' text", () => {
  it("fits its share of the budget, and is nothing when not even one block fits", () => {
    const past = [
      {
        change: "screen-orders",
        folder: "openspec/changes/archive/2026-09-06-screen-orders",
        stage: "feature",
        pr: 3,
        mergedAt: "2026-09-01T10:00:00Z",
        shares: ["repo forge-orders"],
        score: 2,
        files: [
          {
            path: "feature.yaml",
            status: "edited",
            hunks: [
              { at: 3, drafted: ["a: 1"], merged: ["a: 2"] },
              { at: 9, drafted: [], merged: Array.from({ length: 20 }, (_, i) => `x${i}`) },
            ],
          },
        ],
      },
    ];
    expect(pastCorrectionsText(past, 10)).toBeUndefined();
    const all = pastCorrectionsText(past, 10_000)!;
    expect(all).toContain("feature.yaml, line 9: the team added");
    expect(all).toContain("  … 12 more lines");
    const one = pastCorrectionsText(past, 110)!;
    expect(one).toContain("feature.yaml, line 3: the draft said");
    expect(one).not.toContain("line 9");
  });
});
