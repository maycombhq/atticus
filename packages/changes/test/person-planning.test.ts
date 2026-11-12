import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  changeReport,
  DEFAULT_CHANGE_POLICY,
  GENERATED_MARK,
  personWrittenPlanning,
  stageCompletion,
  stageIdle,
  stageWorkDone,
} from "../src/index.js";
import { forgeMetarepo } from "./helpers.js";

/**
 * Beta.27 review (blocker): Forge's add-transfer-limit is in plan with stories.md and tasks.md a
 * person wrote and no stage ever run. The stories stage refuses to replace them ("already has
 * planning files a person wrote"), yet the next step offered that stage and At a glance said
 * "Stories: to come". One definition (personWrittenPlanning) now feeds the stage's completion, the
 * plan gate and the stage's refusal alike.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE_CHANGE = join(HERE, "../../../fixtures/forge-change");
const ID = "add-transfer-limit";

async function estate(): Promise<{ root: string; dir: string }> {
  const root = await forgeMetarepo();
  const dir = join(root, "openspec/changes", ID);
  await cp(join(FORGE_CHANGE, "openspec/changes", ID), dir, { recursive: true });
  return { root, dir };
}

const generated = async (dir: string, f: string) =>
  writeFile(
    join(dir, f),
    `${GENERATED_MARK} stories from the target flows. -->\n${await readFile(join(dir, f), "utf8")}`,
  );

describe("planning files a person wrote", () => {
  it("are the ones without the generated mark", async () => {
    const { dir } = await estate();
    expect(await personWrittenPlanning(dir)).toEqual(["stories.md", "tasks.md"]);
    await generated(dir, "stories.md");
    expect(await personWrittenPlanning(dir)).toEqual(["tasks.md"]);
  });

  it("stand for the stories stage's work, and the stages the change passed read as skipped", async () => {
    const { root } = await estate();
    const c = await stageCompletion(
      { root, policy: DEFAULT_CHANGE_POLICY },
      { id: ID, state: "plan" },
    );
    expect(c.map((s) => [s.stage, s.state])).toEqual([
      ["feature", "skipped"],
      ["architecture", "skipped"],
      ["stories", "person"],
    ]);
    expect(c[2]!.files).toEqual(["stories.md", "tasks.md"]);
    expect(stageWorkDone("person")).toBe(true);
    expect(stageIdle("skipped")).toBe(true);
    // Without the change's state, nothing is said skipped.
    const bare = await stageCompletion({ root, policy: DEFAULT_CHANGE_POLICY }, { id: ID });
    expect(bare[0]!.state).toBe("not-started");
  });

  it("generated planning files are the stage's to write: not started, never by a person", async () => {
    const { root, dir } = await estate();
    await generated(dir, "stories.md");
    await generated(dir, "tasks.md");
    const c = await stageCompletion(
      { root, policy: DEFAULT_CHANGE_POLICY },
      { id: ID, state: "plan" },
    );
    expect(c[2]!.state).toBe("not-started");
  });

  it("on the stage path, the plan gate takes them as the stage's work, and says so", async () => {
    const { root, dir } = await estate();
    await mkdir(join(dir, "stage"), { recursive: true });
    await writeFile(
      join(dir, "stage/architecture.yaml"),
      `schemaVersion: 1\nchange: ${ID}\nstage: architecture\niteration: 1\nstate: done\nupdatedAt: 2026-10-19T10:00:00Z\n`,
    );
    const r = await changeReport(root, ID);
    expect(r.blockers.map((b) => b.code)).not.toContain("stage-not-done");
    expect(r.progress?.summary).toMatch(/^Stories \(written by a person\) done/);
    // Written by Atticus and never run: the gate says the stage hasn't run.
    await generated(dir, "stories.md");
    await generated(dir, "tasks.md");
    const again = await changeReport(root, ID);
    expect(again.blockers.find((b) => b.code === "stage-not-done")?.message).toMatch(
      /The stories stage hasn't run yet/,
    );
  });
});
