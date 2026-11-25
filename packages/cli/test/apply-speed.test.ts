import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyOnce, makeApplyEstate, type Applied, type ApplyEstate } from "./apply-estate.js";

/**
 * Item 11 of docs/plan/ai-first.md: the two slow steps of each Apply (one repo's
 * `verify --write`), the guards' hash of every record file and the intake of inputs/, on a
 * generated estate of 60 repos (apply-estate.ts: 45 services and 15 gateway proxies, about
 * 13,500 record files, the owner's 41 repos had 12,846) with 30 partner specs and 30 diagrams in
 * inputs/. `pnpm test:speed` in packages/cli; ATTICUS_APPLY_REPOS gives another size.
 *
 * The budget is the wall-clock seconds of those two steps of a steady Apply (buildPhases'
 * clock): about three times what this build machine measured after the change (docs/plan/
 * v33-notes/item11.md), for a slow Windows runner. The counts (apply-counts.test.ts, in
 * `pnpm test`) are the sharp checks; this one says the seconds.
 */
const REPOS = Number(process.env.ATTICUS_APPLY_REPOS ?? 60);
const BUDGET_S = 3;

let dir: string;
let e: ApplyEstate;

const said = (edit: number, a: Applied) =>
  console.log(
    `apply-speed ${REPOS} repos, Apply ${edit}: ${a.total.toFixed(1)} s; hash ${a.hash.toFixed(2)} s (${a.opened} files opened), intake ${a.intake.toFixed(2)} s (${a.inputsRead.length} inputs read)\n  ${[
      ...a.phases,
    ]
      .map(([p, s]) => `${p} ${s.toFixed(2)}`)
      .join("; ")}`,
  );

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "atticus-apply-speed-"));
  e = await makeApplyEstate(dir, REPOS, { specs: 30, ops: 120, diagrams: 30, boxes: 200 });
  console.log(`apply-speed ${REPOS} repos: ${e.records.length} record files`);
}, 1_200_000);
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe(`each Apply on a ${REPOS}-repo estate (item 11)`, () => {
  it(`hashes the record files and takes in inputs/ in under ${BUDGET_S} s`, async () => {
    said(1, await applyOnce(e, 1)); // fills the caches, as the first command after a build does
    const steady = await applyOnce(e, 2);
    said(2, steady);
    expect(steady.written?.written).toBeGreaterThan(0);
    expect(steady.hash + steady.intake).toBeLessThan(BUDGET_S);
  }, 1_200_000);
});
