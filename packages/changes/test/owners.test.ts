import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  changeFilePath,
  changeStore,
  newChange,
  OWNER_ROLE_KEYS,
  setChangeOwners,
} from "../src/index.js";
import { forgeMetarepo } from "./helpers.js";

/**
 * Ninth UX walk: a person names a change's owners per role from the change page, written to
 * change.yaml through the change store, so the app knows whose questions are whose.
 */
describe("setChangeOwners", () => {
  it("names, replaces and clears the owners of each role, keeping the others", async () => {
    const root = await forgeMetarepo();
    const c = await newChange(root, {
      title: "Hold a transfer",
      type: "feature",
      by: "pat",
      owners: { "product-owner": ["pat"], qa: ["quinn"] },
      now: "2026-11-08T09:00:00Z",
    });
    expect(OWNER_ROLE_KEYS).toEqual([
      "product-owner",
      "architect",
      "business-analyst",
      "team-lead",
    ]);
    const next = await setChangeOwners(root, c.id, {
      architect: ["@Priya.Nair", " ari ", "ari"],
      "business-analyst": ["bea"],
      "product-owner": [],
    });
    expect(next.owners).toEqual({
      architect: ["Priya.Nair", "ari"],
      "business-analyst": ["bea"],
      qa: ["quinn"],
    });
    expect((await changeStore(root).read(c.id)).owners).toEqual(next.owners);
    expect(await readFile(changeFilePath(root, c.id), "utf8")).toContain("business-analyst:");
  });

  it("refuses a role it doesn't name owners for, and a handle that isn't one", async () => {
    const root = await forgeMetarepo();
    const c = await newChange(root, {
      title: "Hold a transfer",
      type: "feature",
      by: "pat",
      now: "2026-11-08T09:00:00Z",
    });
    const before = c.owners;
    await expect(setChangeOwners(root, c.id, { developer: ["dev"] })).rejects.toThrow(/developer/);
    await expect(setChangeOwners(root, c.id, { architect: ["not a handle"] })).rejects.toThrow(
      /handle/,
    );
    expect((await changeStore(root).read(c.id)).owners).toEqual(before);
  });
});
