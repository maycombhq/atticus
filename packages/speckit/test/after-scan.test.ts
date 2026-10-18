import { existsSync } from "node:fs";
import { cp } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { changeStore } from "@maycombhq/changes";
import { driftAfterScan, handDown } from "../src/index.js";
import { CHANGE, git, NOW, SPECKIT, speckitRoot, worktree } from "./helpers.js";

const T = 120_000;

/** After every scan, the drift check runs for each open change in build or qa. */
describe("drift after a scan", () => {
  it(
    "checks only changes in build or qa, and records their findings as a drift round",
    async () => {
      const { root } = await speckitRoot({ repos: ["forge-ledger"] });
      await handDown(root, CHANGE, "1.2", { git });
      await cp(
        join(SPECKIT, "drift/forge-ledger/specs/1.2"),
        join(worktree(root, "forge-ledger"), "specs/1.2"),
        { recursive: true },
      );
      const review = join(root, "openspec/changes", CHANGE, "review/drift");

      // The fixture change is in plan: not checked.
      expect(await driftAfterScan(root, { now: NOW })).toEqual([]);
      expect(existsSync(review)).toBe(false);

      const store = changeStore(root);
      const c = await store.read(CHANGE);
      await store.write({
        ...c,
        state: "build",
        history: [...c.history, { from: "plan", to: "build", at: NOW, by: "pat" }],
      });
      const [r, ...rest] = await driftAfterScan(root, { now: NOW });
      expect(rest).toEqual([]);
      expect(r).toMatchObject({ change: CHANGE, state: "build", round: 1, unchanged: false });
      expect(r!.open).toBeGreaterThan(0);
      expect(r!.blocking).toBeGreaterThan(0);
      expect(existsSync(join(review, "1/meta/round.yaml"))).toBe(true);

      // A second scan with nothing new writes no new round.
      const [again] = await driftAfterScan(root, { now: NOW });
      expect(again).toMatchObject({ round: 1, unchanged: true });
    },
    T,
  );
});
