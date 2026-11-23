import { describe, expect, it } from "vitest";
import { starterPersonaFiles } from "../src/index.js";

/**
 * What the real-model persona check of 2.0.0-beta.30 found the starter personas got wrong, held
 * in their words: what `conflicts <id>` answers, that reading a repo into the map is never a
 * task, and what design.md's Data changes gives for each new table and column.
 */

const text = async (path: string) =>
  (await starterPersonaFiles()).find((f) => f.path === path)!.text.replace(/\s+/g, " ");

describe("the starter personas after the persona check", () => {
  it("say what conflicts answers, and changes then show as the other way", async () => {
    for (const name of [
      "product-owner",
      "product-owner-naysayer",
      "application-architect",
      "application-architect-naysayer",
      "developer",
      "developer-naysayer",
    ]) {
      const t = await text(`agents/${name}.md`);
      expect(t, name).toContain("each open change whose tasks or flows name");
      expect(t, name).toContain("`changes`, then `show <change id>`");
      expect(t, name).not.toMatch(/conflicts <id>` for where they already overlap/);
    }
  });

  it("never make reading a repo into the map a task", async () => {
    const dev = await text("agents/developer.md");
    expect(dev).not.toContain("the first task is to read it");
    expect(dev).toContain(
      "a person reads it into the map (`/atticus-map <repo>`, then `atticus verify <repo> --write`) before its tasks run; that is not a task.",
    );
    expect(await text("agents/spec-writer.md")).toContain(
      "Reading a repo into the map is never a task: say it above the tasks, as for a new repo",
    );
  });

  it("ask, under Data changes, each new table and column's classification and migration", async () => {
    const writer = await text("agents/spec-writer.md");
    expect(writer).toContain(
      "Under `## Data changes`, name each new table and each new or changed column",
    );
    expect(writer).toContain('say "assumed" when security\'s section gives it as an assumption');
    expect(writer).toContain("the migration that creates or changes it");
    const skill = await text("skills/define-change/SKILL.md");
    expect(skill).toContain(
      'Under `## Data changes`, each new table and column with its classification, from security\'s section (marked "assumed" where it is an assumption), and the migration that creates it',
    );
  });

  it("list the three map tools of ADR 0207: owners, consumers_of and similar_changes", async () => {
    for (const f of await starterPersonaFiles()) {
      if (!/^agents\/(?!.*-naysayer\.md$).+\.md$/.test(f.path)) continue;
      for (const tool of ["owners", "consumers_of", "similar_changes"])
        expect(f.text, f.path).toContain(`  - atticus/${tool}\n`);
    }
  });
});
