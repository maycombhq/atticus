import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { editedByPerson } from "../src/act.js";

/** Review round 25B: a Windows checkout (core.autocrlf) of a stage's file is not a person's edit. */
describe("the critic's edited files", () => {
  it("takes CRLF line endings as the same file, and a real change as an edit", async () => {
    const folder = await mkdtemp(join(tmpdir(), "atticus-edited-"));
    await mkdir(join(folder, "stage"), { recursive: true });
    const text = "# Design\n\nThe ledger checks the limit.\n";
    const sha = createHash("sha256").update(text).digest("hex");
    await writeFile(
      join(folder, "stage/architecture.yaml"),
      `written:\n  design.md: ${sha}\n  data.md: ${sha}\n`,
    );
    await writeFile(join(folder, "design.md"), text.replace(/\n/g, "\r\n"));
    await writeFile(join(folder, "data.md"), text.replace("limit", "daily limit"));
    expect(await editedByPerson(folder)).toEqual(["data.md"]);
  });
});
