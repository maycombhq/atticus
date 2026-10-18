import { cp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  atticus,
  CHANGE,
  changeDir,
  FORGE_CHANGE,
  forgeEstate,
  json,
  removeTop,
  T,
  writeExpectedCatalog,
  type Estate,
} from "./helpers.js";

/**
 * M3 exit: "generated stories meet the story bar on the fixture's eval set". The fixture
 * change at the plan phase with its hand-written stories, tasks and service-desk drafts
 * removed; the planner writes them from the approved design through the CLI, with the
 * story writer's prose from a recorded replay, and `plan bar` measures them against
 * fixtures/forge-change/expected/stories.yaml.
 */

let e: Estate;
const env = { ...process.env };
beforeAll(async () => {
  e = await forgeEstate();
  await writeExpectedCatalog(e.root);
  await cp(join(FORGE_CHANGE, "openspec/changes", CHANGE), changeDir(e.root), {
    recursive: true,
  });
  for (const f of ["stories.md", "tasks.md", "snow.md", "stories"])
    await rm(join(changeDir(e.root), f), { recursive: true, force: true });
  process.env.ATTICUS_REPLAY_DIR = e.replayDir;
}, T);
afterAll(async () => {
  process.env = env;
  await removeTop(e);
});

describe("M3 exit: the story bar on the fixture's eval set", () => {
  it(
    "plan stories writes five stories from the design with the replayed story writer, and leaves out the hop to a system the catalog doesn't know",
    async () => {
      const r = await atticus(e.root, "plan", "stories", CHANGE, "--mode", "replay");
      expect(r.code).toBe(0);
      expect(r.out[0]).toBe("Planned 5 stories and 9 tasks for add-transfer-limit in 3 repos.");
      expect(r.text).not.toMatch(/Discarded AI output/);
      expect(r.text).toMatch(/Not planned: POST \/risk\/assess \(ledger-api → risk-engine\)/);
      const snow = await atticus(e.root, "plan", "snow", CHANGE);
      expect(snow.out[0]).toBe(
        "Wrote 2 service-desk drafts to openspec/changes/add-transfer-limit/snow.md.",
      );
    },
    T,
  );

  it(
    "plan bar: 5 of 5 stories ready (bar 90%), every seeded gap covered by a story or the critic, nothing invented",
    async () => {
      const ev = join(FORGE_CHANGE, "expected/stories.yaml");
      // Before the critic has reviewed the plan, only the gaps the stories cover count.
      const before = await atticus(e.root, "plan", "bar", CHANGE, "--eval", ev);
      expect(before.out[0]).toMatch(/; 2 of 13 gaps covered; /);
      expect(before.code).toBe(1);
      // The critic's plan-gate round raises the other eleven as knowledge gaps.
      const c = await atticus(e.root, "critic", CHANGE, "--gate", "plan");
      expect(c.out[0]).toMatch(/: \d+ blocking, 11 gaps, /);
      const r = await atticus(e.root, "plan", "bar", CHANGE, "--eval", ev);
      expect(r.out[0]).toBe(
        "5 of 5 stories are ready (100%, the bar is 90%); 13 of 13 gaps covered; 0 invented names.",
      );
      expect(r.out.at(-1)).toBe("The story bar is met.");
      expect(r.code).toBe(0);
      const j = json<{ met: boolean }>(
        await atticus(e.root, "plan", "bar", CHANGE, "--eval", ev, "--json"),
      );
      expect(j.met).toBe(true);
    },
    T,
  );
});
