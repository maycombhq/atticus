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
  PROJECTION_MEMO_ENV,
  projectionHooks,
  projectionMemoOn,
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
 *
 * The owner's decision of 2026-11-22: the step is off by default, kept with its proof, and on only
 * by a setting (`ATTICUS_PROJECTION_MEMO=on` in the server's environment) where measurements show
 * a real gain. Its proof tests run with it on (`projectionHooks.on`, as the setting does).
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
const envWas = process.env[PROJECTION_MEMO_ENV];
beforeEach(() => {
  appMemory.system = () => ({ free: 64 * 2 ** 30, total: 64 * 2 ** 30 });
  delete process.env[PROJECTION_MEMO_ENV];
  // The proof's tests: the step on, as the setting turns it on.
  projectionHooks.on = true;
});
afterEach(() => {
  while (appMemory.on) stopAppMemory();
  delete appMemory.system;
  delete projectionHooks.check;
  delete projectionHooks.off;
  delete projectionHooks.on;
  if (envWas === undefined) delete process.env[PROJECTION_MEMO_ENV];
  else process.env[PROJECTION_MEMO_ENV] = envWas;
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

describe("a kept projection can't be changed by a later pass, with the step on and no check", () => {
  it("is deep-frozen and its maps refuse a change, in the build that keeps it and the next", () => {
    startAppMemory();
    const given = estate();
    for (const build of [factsEstateRecords(op, given), factsEstateRecords(op, given)]) {
      const per = build.per.get("forge-web")!;
      const rec = per.newRecords[0]!;
      expect(Object.isFrozen(rec)).toBe(true);
      expect(Object.isFrozen(rec.evidence)).toBe(true);
      expect(Object.isFrozen(per.facts)).toBe(true);
      expect(Object.isFrozen(per.projected.records)).toBe(true);
      const loose = per.looseFact as Map<string, string>;
      const was = [...loose];
      expect(() => loose.set("unresolved.added-later", "call.added-later")).toThrow();
      expect(() => loose.delete(was[0]?.[0] ?? "any")).toThrow();
      expect(() => loose.clear()).toThrow();
      expect([...loose]).toEqual(was);
    }
    expect(projectionStats.kept).toBeGreaterThan(0);
  });
});

describe("the step is off by default, on only by its setting (the owner's decision of 2026-11-22)", () => {
  it("is off with no setting: in the app's server every repo is projected every build, nothing kept", () => {
    delete projectionHooks.on;
    expect(projectionMemoOn({})).toBe(false);
    expect(projectionMemoOn()).toBe(false);
    startAppMemory();
    const given = estate();
    const p = { ...projectionStats };
    factsEstateRecords(op, given);
    factsEstateRecords(op, given);
    expect(projectionStats.kept - p.kept, "nothing taken from memory").toBe(0);
    expect(projectionStats.projected - p.projected).toBe(6);
    expect(appMemoryHeld()["each repo's projection (records kept, a count)"] ?? 0).toBe(0);
  });

  it(`${PROJECTION_MEMO_ENV}=on switches it on in the app's server; any other value leaves it off`, () => {
    delete projectionHooks.on;
    expect(PROJECTION_MEMO_ENV).toBe("ATTICUS_PROJECTION_MEMO");
    expect(projectionMemoOn({ [PROJECTION_MEMO_ENV]: "on" })).toBe(true);
    for (const v of ["", "off", "1", "true", "ON "])
      expect(projectionMemoOn({ [PROJECTION_MEMO_ENV]: v }), JSON.stringify(v)).toBe(false);
    process.env[PROJECTION_MEMO_ENV] = "on";
    expect(projectionMemoOn()).toBe(true);
    const given = estate();
    // Outside a server, still nothing kept.
    let p = { ...projectionStats };
    factsEstateRecords(op, given);
    factsEstateRecords(op, given);
    expect(projectionStats.kept - p.kept).toBe(0);
    startAppMemory();
    projectionHooks.check = true;
    factsEstateRecords(op, given);
    p = { ...projectionStats };
    factsEstateRecords(op, given);
    expect(projectionStats.kept - p.kept, "all three from memory").toBe(3);
  });

  it("the off hook (the equivalence tests' way before the step) wins over the setting", () => {
    process.env[PROJECTION_MEMO_ENV] = "on";
    projectionHooks.off = true;
    expect(projectionMemoOn()).toBe(false);
    startAppMemory();
    const given = estate();
    factsEstateRecords(op, given);
    const p = { ...projectionStats };
    factsEstateRecords(op, given);
    expect(projectionStats.kept - p.kept).toBe(0);
  });
});
