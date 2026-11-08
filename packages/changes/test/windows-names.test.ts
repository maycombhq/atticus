import { describe, expect, it } from "vitest";
import { newChange, slugify, windowsUnsafeName } from "../src/index.js";
import { forgeMetarepo } from "./helpers.js";

/**
 * A change folder Windows can open (beta.21; the id rule itself is C1's, unchanged until an ADR):
 * a title such as "Con" is given another id, and an id typed as one is refused with another.
 */
describe("change ids on Windows", () => {
  it("knows the names Windows can't give a folder", () => {
    for (const n of ["con", "nul", "aux", "prn", "com1", "lpt9", "nul.txt", "fix.", "CON"])
      expect(windowsUnsafeName(n), n).toBe(true);
    for (const n of ["console", "add-fraud-check", "com10", "null", "auxiliary-ledger", "v1.2"])
      expect(windowsUnsafeName(n), n).toBe(false);
  });

  it("gives a title like Con an id Windows can open", () => {
    expect(slugify("Con")).toBe("con-change");
    expect(slugify("NUL")).toBe("nul-change");
    expect(slugify("Add a fraud check")).toBe("add-a-fraud-check");
  });

  it("refuses an id typed as one, and names another", async () => {
    const root = await forgeMetarepo();
    await expect(
      newChange(root, {
        id: "aux",
        title: "Aux ledger",
        type: "small-change",
        by: "pat",
        now: "2026-10-23T09:00:00Z",
      }),
    ).rejects.toThrow(
      "\"aux\" can't be a change id: Windows can't open a folder named that (con, nul, com1 and the like, or a name ending in a dot). Pick another, such as aux-change.",
    );
    // A dot inside: the suggestion is one Windows can open too.
    await expect(
      newChange(root, {
        id: "con.v2",
        title: "Con v2",
        type: "small-change",
        by: "pat",
        now: "2026-10-23T09:00:00Z",
      }),
    ).rejects.toThrow(/Pick another, such as con-change\.v2\.$/);
    const c = await newChange(root, {
      title: "Con",
      type: "small-change",
      by: "pat",
      now: "2026-10-23T09:00:00Z",
    });
    expect(c.id).toBe("con-change");
  });
});
