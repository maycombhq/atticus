import { rm } from "node:fs/promises";
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

  it("takes the organisation's own brief for a type before the built-in default", () => {
    const own = { ...BUILT_IN_TEMPLATES[0]!, id: "a-forge-bug", changeType: "bug-fix" };
    // The type's id first, then its usual brief, then any of its type, then feature.
    expect(pickTemplate([own, ...BUILT_IN_TEMPLATES], "bug-fix")!.id).toBe("defect-fix");
    const without = BUILT_IN_TEMPLATES.filter((t) => t.id !== "defect-fix");
    expect(pickTemplate([own, ...without], "bug-fix")!.id).toBe("a-forge-bug");
    expect(pickTemplate([{ ...own, id: "bug-fix" }, ...BUILT_IN_TEMPLATES], "bug-fix")!.id).toBe(
      "bug-fix",
    );
    expect(pickTemplate(BUILT_IN_TEMPLATES, "something-new")!.id).toBe("feature");
  });
});
