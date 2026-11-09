import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { editedByPerson } from "../src/act.js";

const sha = (t: string) => createHash("sha256").update(t).digest("hex");

/**
 * Review round 50: proposal.md is written by the feature stage and its Capabilities by the
 * stories stage, so each stage's loop file has a hash of it; and a tick in tasks.md is progress,
 * not an edit. A file is a person's edit only when no stage wrote it as it is now.
 */
describe("the critic's edited files, when two stages write one file", () => {
  it("proposal.md as the stories stage wrote it last is no edit; a change to it is", async () => {
    const folder = await mkdtemp(join(tmpdir(), "atticus-edited-two-"));
    await mkdir(join(folder, "stage"), { recursive: true });
    const feature = "# Proposal\n\n## Capabilities\n\nThe stories stage names them.\n";
    const stories = "# Proposal\n\n## Capabilities\n\n- `place-order`\n";
    await writeFile(
      join(folder, "stage/feature.yaml"),
      `written:\n  proposal.md: ${sha(feature)}\n`,
    );
    await writeFile(
      join(folder, "stage/stories.yaml"),
      `written:\n  proposal.md: ${sha(stories)}\n`,
    );
    await writeFile(join(folder, "proposal.md"), stories);
    expect(await editedByPerson(folder)).toEqual([]);
    await writeFile(join(folder, "proposal.md"), `${stories}\nA person's line.\n`);
    expect(await editedByPerson(folder)).toEqual(["proposal.md"]);
  });

  it("tasks.md with a task ticked is no edit; a reworded task is", async () => {
    const folder = await mkdtemp(join(tmpdir(), "atticus-edited-tick-"));
    await mkdir(join(folder, "stage"), { recursive: true });
    const tasks =
      "# Tasks\n\n## forge-orders\n\n- [ ] 1.1 Screen the order (story s1-place-order)\n";
    await writeFile(join(folder, "stage/stories.yaml"), `written:\n  tasks.md: ${sha(tasks)}\n`);
    await writeFile(join(folder, "tasks.md"), tasks.replace("[ ]", "[x]").replace(/\n/g, "\r\n"));
    expect(await editedByPerson(folder)).toEqual([]);
    await writeFile(join(folder, "tasks.md"), tasks.replace("Screen", "Check"));
    expect(await editedByPerson(folder)).toEqual(["tasks.md"]);
  });
});
