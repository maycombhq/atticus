import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HandoffRuntime } from "@maycombhq/ai";
import { GENERATED_MARK, planStories, STORY_PROSE_OUTPUT } from "../src/index.js";
import {
  CHANGE,
  FIXTURES,
  FORGE_CHANGE,
  NOW,
  changeDir,
  forgeChangeRoot,
  read,
} from "./helpers.js";

/**
 * `plan stories` in hand-off mode: the story writer's answer goes to a file in the run's own
 * folder, so finishing with `--resume <run>` needs no `--force` (the answer used to sit in
 * `stories.md`, the file the plan writes, and the guard took it for a person's).
 */

const RECORDING = join(
  FORGE_CHANGE,
  "recordings/story-writer/1ddb00eac2aaf91a5ec5d9dfd220116be9f75aec6546a4a3a3b050ed89af2864.json",
);
const answer = async () => (JSON.parse(await read(RECORDING)) as { output: string }).output;
const runtimeFor = (root: string) =>
  new HandoffRuntime({ root, validate: async () => [], now: () => new Date(NOW) });

describe("plan stories in hand-off mode", () => {
  it("asks for the prose in a file under the run folder, not in the change folder", async () => {
    const root = await forgeChangeRoot();
    const r = await planStories(root, CHANGE, { runtime: runtimeFor(root), now: new Date(NOW) });
    expect(r).toMatchObject({ state: "waiting", files: [] });
    const runId = r.waiting!.runId;
    const prompt = await read(join(root, ".runs", CHANGE, runId, "prompt.md"));
    expect(prompt).toContain(
      `Write the result to .runs/${CHANGE}/${runId}/${STORY_PROSE_OUTPUT}. Change no other files.`,
    );
    expect(prompt).not.toContain(`${CHANGE}/stories.md`);
    expect(await readdir(changeDir(root))).not.toContain("stories.md");
  });

  it("finishes with --resume and no --force, and the plan is the generated one", async () => {
    const root = await forgeChangeRoot();
    const rt = runtimeFor(root);
    const first = await planStories(root, CHANGE, { runtime: rt, now: new Date(NOW) });
    const runId = first.waiting!.runId;
    await writeFile(join(root, ".runs", CHANGE, runId, STORY_PROSE_OUTPUT), await answer());
    expect((await rt.done(runId)).state).toBe("validated");

    const done = await planStories(root, CHANGE, {
      runtime: runtimeFor(root),
      resume: runId,
      now: new Date(NOW),
    });
    expect(done.state).toBe("written");
    expect(done.fallback).toEqual([]);
    expect(done.discarded).toEqual([]);
    expect(done.run).toMatchObject({
      agent: "story-writer",
      runtime: "hand-off",
      state: "validated",
    });
    expect((await read(join(changeDir(root), "stories.md"))).startsWith(GENERATED_MARK)).toBe(true);
    // The same stories the replay path writes from the same recording.
    expect(await read(join(changeDir(root), "stories/s1-daily-transfer-limit.md"))).toBe(
      await read(join(FIXTURES, "expected/s1-daily-transfer-limit.md")),
    );
    await expect(readFile(join(changeDir(root), STORY_PROSE_OUTPUT))).rejects.toThrow();
  });

  it("still refuses to replace planning files a person wrote, with or without a hand-off", async () => {
    const root = await forgeChangeRoot({ plan: true });
    const p = join(changeDir(root), "stories.md");
    await writeFile(p, "# Stories by hand\n");
    await expect(
      planStories(root, CHANGE, { runtime: runtimeFor(root), now: new Date(NOW) }),
    ).rejects.toThrow(/already has planning files a person wrote: stories.md/);
  });
});
