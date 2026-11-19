import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUILT_IN_TEMPLATES,
  changeFolder,
  loadChangeContext,
  newChange,
  pickTemplate,
} from "../src/index.js";
import { forgeMetarepo, readText } from "./helpers.js";

const T0 = "2026-10-19T09:00:00Z";

/**
 * Beta.30, from a trial run: `atticus change new --type integration` said it was created "from
 * the decommission template", and it was: no template had the type's id, so the first one of
 * its type was taken, and the only one was the brief for retiring a system. A plain bug fix got
 * the data-fix brief the same way (the first of its type by id). Each built-in type now has its
 * own brief by default.
 */
describe("the brief a new change starts from, by its type", () => {
  it("gives a new integration the integration brief, not the one for retiring a system", async () => {
    const root = await forgeMetarepo();
    try {
      const c = await newChange(root, {
        title: "Send refunds through Northwind Pay",
        type: "integration",
        by: "pat",
        now: T0,
      });
      expect(c.template).toBe("integration");
      expect(c.history[0]!.reason).toBe("Created from the integration template");
      const brief = await readText(join(changeFolder(root, c.id), "brief.md"));
      expect(brief).toContain("# Send refunds through Northwind Pay");
      expect(brief).toContain("## What connects");
      expect(brief).not.toContain("## What retires");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("still gives the decommission brief when it is asked for", async () => {
    const root = await forgeMetarepo();
    try {
      const c = await newChange(root, {
        title: "Retire the batch export",
        type: "integration",
        template: "decommission",
        by: "pat",
        now: T0,
      });
      expect(c.template).toBe("decommission");
      expect(await readText(join(changeFolder(root, c.id), "brief.md"))).toContain(
        "## What retires",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("gives each of the organisation's types its usual brief, as the metarepo lists them (by id)", async () => {
    const root = await forgeMetarepo();
    try {
      const { templates } = await loadChangeContext(root);
      const picked = (type: string) => pickTemplate(templates, type)!.id;
      expect({
        feature: picked("feature"),
        integration: picked("integration"),
        "bug-fix": picked("bug-fix"),
        "emergency-fix": picked("emergency-fix"),
        "config-change": picked("config-change"),
        "tech-debt": picked("tech-debt"),
        "small-change": picked("small-change"),
      }).toEqual({
        feature: "feature",
        integration: "integration",
        // Not data-fix, which sorts first among the bug-fix briefs.
        "bug-fix": "defect-fix",
        "emergency-fix": "emergency-fix",
        "config-change": "config-flag",
        "tech-debt": "tech-debt",
        "small-change": "small-change",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("takes the organisation's own brief for a type before the built-in default", async () => {
    // Review of beta.30 (hard rule 7): an org pack's template for a type wins over a built-in
    // one, whatever it is named; the built-in defaults are only for a type the org has none for.
    const root = await forgeMetarepo();
    try {
      const dir = join(root, "org-pack/process/change-templates");
      const own = (id: string, changeType: string) =>
        writeFile(
          join(dir, `${id}.md`),
          `---\nid: ${id}\nname: Forge ${id}\nchangeType: ${changeType}\ndescription: Forge's own.\n---\n# {{title}}\n\n## Forge's own\n`,
        );
      await own("bug-triage", "bug-fix");
      await own("app-config", "config-change");
      await own("api-onboarding", "integration");
      const ctx = await loadChangeContext(root);
      expect(ctx.problems).toEqual([]);
      const picked = (type: string) => pickTemplate(ctx.templates, type)!.id;
      expect(picked("bug-fix")).toBe("bug-triage");
      expect(picked("config-change")).toBe("app-config");
      expect(picked("integration")).toBe("api-onboarding");
      // A type the organisation wrote no brief for keeps the built-in default.
      expect(picked("emergency-fix")).toBe("emergency-fix");
      expect(picked("tech-debt")).toBe("tech-debt");
      const c = await newChange(root, {
        title: "Onboard Northwind Pay's refunds",
        type: "integration",
        by: "pat",
        now: T0,
      });
      expect(c.template).toBe("api-onboarding");
      expect(await readText(join(changeFolder(root, c.id), "brief.md"))).toContain(
        "## Forge's own",
      );
      // Among the organisation's own for a type: the one with the type's id, then the one that
      // replaces the type's usual built-in, then the first.
      await own("defect-fix", "bug-fix");
      expect(pickTemplate((await loadChangeContext(root)).templates, "bug-fix")!.id).toBe(
        "defect-fix",
      );
      await own("bug-fix", "bug-fix");
      expect(pickTemplate((await loadChangeContext(root)).templates, "bug-fix")!.id).toBe(
        "bug-fix",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    expect(pickTemplate(BUILT_IN_TEMPLATES, "something-new")!.id).toBe("feature");
  });
});
