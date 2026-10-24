import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evidenceExcerpts } from "../src/question-evidence.js";

/**
 * Evidence beside a question (WP7.2): the lines around each line a question cites, from the
 * repo's base clone (or the metarepo, for a change's question), so a person answers looking at
 * the code. Read-only, and never outside the folder the question is about.
 */

const JAVA = [
  "package forge.notes;",
  "",
  "@RestController",
  '@RequestMapping("/notes")',
  "public class NoteController {",
  "  @GetMapping",
  "  public List<Note> list() {",
  "    return List.of();",
  "  }",
  "}",
].join("\n");

async function metarepo() {
  const root = await mkdtemp(join(tmpdir(), "atticus-q-evidence-"));
  await mkdir(join(root, "workspace", "forge-notes", "src"), { recursive: true });
  await writeFile(join(root, "workspace", "forge-notes", "src", "NoteController.java"), JAVA);
  await mkdir(join(root, "openspec", "changes", "add-tags"), { recursive: true });
  await writeFile(
    join(root, "openspec", "changes", "add-tags", "feature.yaml"),
    "a: 1\nb: 2\nc: 3\n",
  );
  return root;
}

describe("evidence beside a question (WP7.2)", () => {
  it("gives the lines around each cited line, from the repo's base clone", async () => {
    const root = await metarepo();
    const [e] = await evidenceExcerpts(root, {
      repo: "forge-notes",
      evidence: ["src/NoteController.java:6"],
    });
    expect(e).toMatchObject({ ref: "src/NoteController.java:6", line: 6, start: 3, found: true });
    expect(e!.lines).toEqual(JAVA.split("\n").slice(2, 9));
  });

  it("reads a change's question from the metarepo, and says when a line can't be shown", async () => {
    const root = await metarepo();
    const [change, missing, outside, past] = await evidenceExcerpts(root, {
      repo: "add-tags",
      evidence: [
        "openspec/changes/add-tags/feature.yaml:2",
        "src/Nowhere.java:3",
        "../../etc/passwd:1",
        "openspec/changes/add-tags/feature.yaml:99",
      ],
    });
    expect(change).toMatchObject({ found: true, start: 1, lines: ["a: 1", "b: 2", "c: 3"] });
    expect(missing).toMatchObject({ found: false, lines: [] });
    expect(outside).toMatchObject({ found: false, lines: [] });
    expect(past).toMatchObject({ found: false });
  });
});
