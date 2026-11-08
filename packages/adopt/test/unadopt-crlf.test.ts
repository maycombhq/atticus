import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeAssistantFiles } from "@maycombhq/assistant-files";
import { adopt, unadopt } from "../src/index.js";

/**
 * Review round 31: on a Windows checkout (core.autocrlf), CLAUDE.md is CRLF. Atticus's section
 * goes in with the person's line endings kept, and unadopt takes it out to the file as it was.
 */
describe("a CRLF CLAUDE.md", () => {
  it("keeps its CRLF when the section goes in, and unadopt restores it byte for byte", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atticus-unadopt-crlf-"));
    const orig = "# Team rules\r\n\r\nUse Java 21.\r\n";
    await writeFile(join(dir, "CLAUDE.md"), orig);
    await mkdir(join(dir, "svc"));
    await writeFile(join(dir, "svc", "pom.xml"), "<project/>\n");
    await adopt(dir);
    await writeAssistantFiles(dir, [
      {
        path: "CLAUDE.md",
        content: "Atticus bits",
        source: "x",
        mode: "section",
        style: "html" as never,
      },
    ]);
    const mid = await readFile(join(dir, "CLAUDE.md"), "utf8");
    expect(mid).toContain("Atticus bits");
    expect(mid.replace(/\r\n/g, "")).not.toContain("\n");
    const r = await unadopt(dir);
    expect(r.restored).toContain("CLAUDE.md");
    expect(await readFile(join(dir, "CLAUDE.md"), "utf8")).toBe(orig);
  });
});
