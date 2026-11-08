import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { orgPackDirOf } from "@maycombhq/core";
import { setOrgPackOwner } from "../src/orgpack-owner.js";

/** Round 44: a pack.yaml with Windows line endings keeps them when the owner is set. */
it("keeps CRLF in pack.yaml when the owner is set", async () => {
  const root = await mkdtemp(join(tmpdir(), "atticus-owner-eol-"));
  const dir = orgPackDirOf(root);
  await mkdir(dir, { recursive: true });
  const file = join(dir, "pack.yaml");
  await writeFile(file, "# Forge org pack\r\nname: forge\r\nowner: unassigned\r\nversion: 1\r\n");
  await setOrgPackOwner(root, "priya.nair");
  const text = await readFile(file, "utf8");
  expect(text).toContain("owner: priya.nair\r\n");
  expect(text.replace(/\r\n/g, "")).not.toContain("\n");
});
