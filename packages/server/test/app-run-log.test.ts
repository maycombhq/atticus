import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readTerminalRuns, runningDirOf } from "@maycombhq/core";
import { appRunRecorder, JobManager } from "../src/index.js";

/**
 * Beta.27 re-review: the app's jobs were kept in the run log where a command run wouldn't be (a
 * bare folder, ATTICUS_RUN_LOG=off), and titled with the app's own words (a diagram's name, a
 * team's, the words a request sent) past every rule a terminal run's title follows.
 */

const made: string[] = [];
afterEach(async () => {
  for (const d of made.splice(0)) await rm(d, { recursive: true, force: true });
});
const folder = async (metarepo: boolean) => {
  const root = await mkdtemp(join(tmpdir(), "atticus-app-run-log-"));
  made.push(root);
  if (metarepo) mkdirSync(join(root, "org-pack"));
  return root;
};

describe("an app job in the run log", () => {
  it("a bare folder: nothing is made there", async () => {
    const root = await folder(false);
    expect(appRunRecorder(root, { id: "job-1", kind: "sync" }, {}, {})).toBeUndefined();
    expect(readdirSync(root)).toEqual([]);
  });

  it("ATTICUS_RUN_LOG=off: nothing is kept, as for a command run", async () => {
    const root = await folder(true);
    const env = { ATTICUS_RUN_LOG: "off" };
    expect(appRunRecorder(root, { id: "job-1", kind: "sync" }, {}, env)).toBeUndefined();
    expect(existsSync(join(root, ".atticus"))).toBe(false);
  });

  it("a metarepo: kept, titled by its kind and the ids it names, never the job's own title", async () => {
    const root = await folder(true);
    const jobs = new JobManager(() => undefined, undefined, {
      record: (job, _meta, log) => appRunRecorder(root, job, log, {}),
    });
    const secret = "sk-" + "Zx9Kq2Lm".repeat(5);
    await jobs.track("reconcile", async () => undefined, {
      title: `Reconcile ${secret} my diagram`,
      log: { ids: ["forge-ledger-context", secret, "my diagram"] },
    });
    await jobs.track("work", async () => undefined, { title: "A question for the Payments Guild" });
    const runs = readTerminalRuns(root, { alive: () => true });
    expect(runs.map((r) => r.title).sort()).toEqual([
      "Reconcile forge-ledger-context …",
      "Request",
    ]);
    for (const f of readdirSync(runningDirOf(root))) {
      const text = readFileSync(join(runningDirOf(root), f), "utf8");
      expect(text).not.toContain(secret);
      expect(text).not.toContain("my diagram");
      expect(text).not.toContain("Payments Guild");
    }
  });
});
