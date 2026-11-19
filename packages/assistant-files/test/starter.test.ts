import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { starterPersonaFiles } from "../src/index.js";

/**
 * ADR 0201, decision 7: the starter is `agents/<name>.md` and `skills/<name>/SKILL.md`, and
 * nothing else under the folder is an org pack's: a README beside them, notes inside a skill's
 * folder and a file deeper down are never seeded.
 */

const made: string[] = [];
afterAll(async () => {
  for (const d of made.splice(0)) await rm(d, { recursive: true, force: true });
});

async function starter(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "atticus-starter-"));
  made.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    const to = join(dir, ...rel.split("/"));
    await mkdir(dirname(to), { recursive: true });
    await writeFile(to, text);
  }
  return dir;
}

describe("the starter personas' files", () => {
  it("are the 15 agents and the define-change skill, in path order", async () => {
    const paths = (await starterPersonaFiles()).map((f) => f.path);
    expect(paths).toHaveLength(16);
    expect(paths).toEqual([...paths].sort());
    expect(paths.filter((p) => /^agents\/[a-z-]+\.md$/.test(p))).toHaveLength(15);
    expect(paths).toContain("skills/define-change/SKILL.md");
  });

  it("takes only agents/*.md and skills/*/SKILL.md: never a README or a file beside them", async () => {
    const dir = await starter({
      "README.md": "Not copied.\n",
      "notes.md": "Not copied.\n",
      "agents/qa.md": "---\r\nname: qa\r\n---\r\n",
      "agents/README.md": "About this folder.\n",
      "agents/qa.yaml": "id: qa\n",
      "agents/drafts/later.md": "Not yet.\n",
      "skills/README.md": "About this folder.\n",
      "skills/define-change/SKILL.md": "---\nname: define-change\n---\n",
      "skills/define-change/notes.md": "Not copied.\n",
      "skills/define-change/more/SKILL.md": "Not copied.\n",
      "skills/empty/readme.md": "No skill here.\n",
      "docs/agents/qa.md": "Not copied.\n",
    });
    expect(await starterPersonaFiles(dir)).toEqual([
      { path: "agents/qa.md", text: "---\nname: qa\n---\n" },
      { path: "skills/define-change/SKILL.md", text: "---\nname: define-change\n---\n" },
    ]);
  });

  it("has none where a folder is empty, and says the folder isn't there when it is missing", async () => {
    expect(await starterPersonaFiles(await starter({ "agents/qa.md": "x\n" }))).toEqual([
      { path: "agents/qa.md", text: "x\n" },
    ]);
    const gone = join(await starter({}), "starter");
    await expect(starterPersonaFiles(gone)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
