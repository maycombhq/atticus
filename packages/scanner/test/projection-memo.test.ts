import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  appMemory,
  appMemoryHeld,
  loadOrgPack,
  parseFacts,
  releaseAppMemory,
  startAppMemory,
  stopAppMemory,
  type Fact,
  type OrgPack,
} from "@maycombhq/core";
import {
  factsEstateRecords,
  projectionHooks,
  projectionStats,
  type FactsEstateRepo,
} from "../src/index.js";

/**
 * ADR 0205's addendum (accepted 2026-11-22), step 1: in the app's server each repo's projection
 * (`factsRecords`) is kept in memory by exactly its inputs (its facts slot's hash, its targets,
 * its component renames and its manifest entry), and the next build takes it from there for a
 * repo whose inputs are the same. The proof: the kept projection is what a projection now gives
 * (checked both ways with the hook), a change of each input misses for the repos it reaches, and
 * outside a server nothing is kept. Invented Forge estates (CLAUDE.md rule 3).
 */
const FIXTURES = join(__dirname, "..", "..", "..", "fixtures", "estate-facts");

const slot = (dir: string, repo: string, sub = "facts"): FactsEstateRepo & { text: string } => {
  const text = readFileSync(join(dir, sub, `${repo}.jsonl`), "utf8");
  const r = parseFacts(text);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return { repo, facts: r.facts, sha: createHash("sha256").update(text).digest("hex"), text };
};

let op: OrgPack;
let collisionOp: OrgPack;
beforeAll(async () => {
  op = await loadOrgPack(join(FIXTURES, "org-pack"));
  collisionOp = await loadOrgPack(join(FIXTURES, "collision", "org-pack"));
});
// The machine's memory as roomy, whatever else runs on it: these tests are of what is kept.
beforeEach(() => {
  appMemory.system = () => ({ free: 64 * 2 ** 30, total: 64 * 2 ** 30 });
});
afterEach(() => {
  while (appMemory.on) stopAppMemory();
  delete appMemory.system;
  delete projectionHooks.check;
  delete projectionHooks.off;
});

const estate = () => ["forge-web", "forge-customers", "forge-ledger"].map((r) => slot(FIXTURES, r));
/** What the projection gives, as data. */
const view = (p: ReturnType<typeof factsEstateRecords>) =>
  JSON.parse(
    JSON.stringify({
      records: p.records,
      repos: p.repos,
      whole: p.whole,
      per: [...p.per].map(([k, v]) => [k, { ...v, looseFact: [...v.looseFact] }]),
      remap: [...p.remap],
      stepTo: [...p.stepTo],
      heard: [...p.heard],
    }),
  ) as unknown;

describe("each repo's projection kept by its inputs in the app's memory (ADR 0205 addendum, step 1)", () => {
  it("projects again only a repo whose inputs changed, and gives what a projection now gives", () => {
    startAppMemory();
    projectionHooks.check = true;
    const given = estate();
    const was = { ...projectionStats };
    const first = factsEstateRecords(op, given);
    expect(projectionStats.projected - was.projected).toBe(3);
    const second = factsEstateRecords(op, given);
    expect(projectionStats.kept - was.kept, "all three from memory").toBe(3);
    expect(view(second)).toEqual(view(first));
    // One repo's facts changed: its slot's hash is another; the others are kept.
    const changed = given.map((g) =>
      g.repo === "forge-web" ? { ...g, facts: g.facts.slice(0, -1), sha: `${g.sha}-changed` } : g,
    );
    const p = { ...projectionStats };
    const third = factsEstateRecords(op, changed);
    expect(projectionStats.projected - p.projected).toBe(1);
    expect(projectionStats.kept - p.kept).toBe(2);
    projectionHooks.off = true;
    expect(view(third)).toEqual(view(factsEstateRecords(op, changed)));
  });

  it("misses on another target, another manifest entry, and with no slot hash", () => {
    startAppMemory();
    projectionHooks.check = true;
    const given = estate();
    factsEstateRecords(op, given);
    const call = given[0]!.facts.find(
      (f): f is Extract<Fact, { kind: "call" }> => f.kind === "call",
    )!;
    let p = { ...projectionStats };
    factsEstateRecords(
      op,
      given.map((g, i) => (i === 0 ? { ...g, targets: { [call.id]: "forge-ledger" } } : g)),
    );
    expect(projectionStats.projected - p.projected, "another target").toBe(1);
    // The manifest's component for forge-ledger is another one.
    const op2: OrgPack = structuredClone(op);
    const entry = op2.profiles
      .flatMap((x) => x.repos?.repos ?? [])
      .find((r) => r.id === "forge-ledger")!;
    (entry as { component?: string }).component = "ledger-core";
    p = { ...projectionStats };
    factsEstateRecords(op2, given);
    expect(
      projectionStats.projected - p.projected,
      "another manifest entry",
    ).toBeGreaterThanOrEqual(1);
    // A repo with no slot hash (a caller that read no slot) is projected every time.
    p = { ...projectionStats };
    factsEstateRecords(
      op,
      given.map(({ sha: _sha, ...g }) => g),
    );
    expect(projectionStats.projected - p.projected).toBe(3);
  });

  it("misses for both repos when a rename comes or goes (a component id a second repo uses)", () => {
    startAppMemory();
    projectionHooks.check = true;
    const dir = join(FIXTURES, "collision");
    const shop = slot(dir, "forge-shop", ".");
    const admin = slot(dir, "forge-admin", ".");
    factsEstateRecords(collisionOp, [shop]);
    factsEstateRecords(collisionOp, [shop, admin]);
    // With forge-admin in, forge-shop's `frontend` is renamed: projected again, not kept.
    let p = { ...projectionStats };
    const both = factsEstateRecords(collisionOp, [shop, admin]);
    expect(projectionStats.kept - p.kept).toBe(2);
    expect(both.records.some((r) => r.id === "forge-shop-frontend")).toBe(true);
    p = { ...projectionStats };
    factsEstateRecords(collisionOp, [shop]);
    expect(projectionStats.projected - p.projected, "the rename gone").toBe(1);
  });

  it("keeps nothing outside a server, and lets go by the app's rule", () => {
    const given = estate();
    let p = { ...projectionStats };
    factsEstateRecords(op, given);
    factsEstateRecords(op, given);
    expect(projectionStats.kept - p.kept).toBe(0);
    startAppMemory();
    factsEstateRecords(op, given);
    expect(appMemoryHeld()["each repo's projection (records kept, a count)"]).toBeGreaterThan(0);
    releaseAppMemory();
    expect(appMemoryHeld()["each repo's projection (records kept, a count)"] ?? 0).toBe(0);
    p = { ...projectionStats };
    factsEstateRecords(op, given);
    expect(projectionStats.projected - p.projected).toBe(3);
  });

  it("with the check on, a kept projection is frozen: a pass that changed one would throw", () => {
    startAppMemory();
    projectionHooks.check = true;
    const given = estate();
    factsEstateRecords(op, given);
    const again = factsEstateRecords(op, given);
    const rec = again.per.get("forge-web")!.newRecords[0]!;
    expect(Object.isFrozen(rec)).toBe(true);
    expect(Object.isFrozen(rec.evidence)).toBe(true);
  });
});
