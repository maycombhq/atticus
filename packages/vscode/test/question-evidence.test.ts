import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evidenceRows } from "../src/question-evidence";

/** Evidence beside a question in VS Code (WP7.2): each cited line's text, and where it opens. */

const root = join("C:", "meta");
const clone = join(root, "workspace", "forge-notes");
const files: Record<string, string> = {
  [join(clone, "src", "NoteController.java")]: "package forge.notes;\n\n  @GetMapping\n",
  [join(root, "openspec", "changes", "add-tags", "feature.yaml")]: "a: 1\nb: 2\n",
};
const read = (f: string) => files[f];
const paths = { root, codeRoot: (r: string) => (r === "forge-notes" ? clone : undefined) };

describe("evidence rows for answering in VS Code (WP7.2)", () => {
  it("shows each cited line's text, opening the file at that line", () => {
    const [row] = evidenceRows(
      { repo: "forge-notes", evidence: ["src/NoteController.java:3"] },
      paths,
      read,
    );
    expect(row).toEqual({
      label: "src/NoteController.java:3",
      description: "@GetMapping",
      open: { path: join(clone, "src", "NoteController.java"), line: 3 },
    });
  });

  it("reads a change's question from the metarepo, and says when the line isn't there", () => {
    const [change, gone] = evidenceRows(
      {
        repo: "add-tags",
        evidence: ["openspec/changes/add-tags/feature.yaml:2", "src/Gone.java:4"],
      },
      paths,
      read,
    );
    expect(change!.description).toBe("b: 2");
    expect(gone).toMatchObject({ label: "src/Gone.java:4", description: "not here" });
    expect(gone!.open).toBeUndefined();
  });
});
