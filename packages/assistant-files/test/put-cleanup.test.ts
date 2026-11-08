import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { writeAssistantFiles } from "../src/write.js";

/** Windows review: a write that fails leaves no `.atticus-tmp` beside the file. */
it("takes its temporary file away when the write fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "put-"));
  // A folder where the file goes: the rename fails, as a held file's last try would.
  await mkdir(join(dir, "AGENTS.md", "inside"), { recursive: true });
  await writeFile(join(dir, "AGENTS.md", "inside", "x"), "x");
  await expect(
    writeAssistantFiles(dir, [
      { path: "AGENTS.md", content: "Atticus", source: "x", mode: "whole", style: "html" as never },
    ] as never),
  ).rejects.toThrow();
  expect(existsSync(join(dir, "AGENTS.md.atticus-tmp"))).toBe(false);
});
