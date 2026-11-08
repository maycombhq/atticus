import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  changeFolder,
  changeSize,
  changeStore,
  loadChangeContext,
  newChange,
} from "../src/index.js";
import { forgeMetarepo } from "./helpers.js";

/** ADR 0113: a change's size decides its path. */
describe("changeSize", () => {
  it("puts a small change type on the fast path, its critic at the plan gate", async () => {
    const root = await forgeMetarepo();
    const c = await newChange(root, {
      title: "Return the order's time",
      type: "small-change",
      by: "pat",
      now: "2026-10-23T09:00:00Z",
    });
    // A small type's first phase is plan: the one step and its hand-off.
    expect(c.state).toBe("plan");
    const s = await changeSize(await loadChangeContext(root), c);
    expect(s).toMatchObject({ fast: true, why: "type", gate: "plan" });
    // The brief template is still a template: nothing in it says standard.
    expect(await readFile(join(changeFolder(root, c.id), "brief.md"), "utf8")).toMatch(
      /## Done when/,
    );
  });

  it("lets a brief say small only where the type allows it, and says why not", async () => {
    const root = await forgeMetarepo();
    const cfg = await newChange(root, {
      title: "Raise the timeout",
      type: "config-change",
      by: "pat",
      now: "2026-10-23T09:00:00Z",
    });
    const ctx = await loadChangeContext(root);
    expect((await changeSize(ctx, cfg)).fast).toBe(false);
    await writeFile(
      join(changeFolder(root, cfg.id), "brief.md"),
      "# Raise the timeout\n\nSize: small\n",
    );
    expect(await changeSize(ctx, cfg)).toMatchObject({ fast: true, why: "brief", gate: "plan" });
    const feat = await newChange(root, {
      title: "Screen orders",
      type: "feature",
      by: "pat",
      now: "2026-10-23T09:00:00Z",
    });
    await writeFile(
      join(changeFolder(root, feat.id), "brief.md"),
      "# Screen orders\n\nSize: small\n",
    );
    const f = await changeSize(ctx, feat);
    expect(f).toMatchObject({ fast: false, why: "brief-not-allowed" });
    expect(f.words).toMatch(/smallWhenBriefSays/);
  });
});

describe("a change's folder", () => {
  it("is named by a folder name, never a path; a stray folder is skipped, never an error", async () => {
    expect(() => changeFolder("/m", "../../etc")).toThrow(/isn't a change id/);
    expect(() => changeFolder("/m", "a/b")).toThrow(/isn't a change id/);
    expect(() => changeFolder("/m", "C:x")).toThrow(/isn't a change id/);
    expect(changeFolder("/m", "add-fraud-check")).toMatch(/add-fraud-check$/);
    expect(changeFolder("/m", "_templates")).toMatch(/_templates$/);
    // An archived change is read as archive/<folder>, and only one folder deep.
    expect(changeFolder("/m", "archive/2026-10-01-c4")).toMatch(/2026-10-01-c4$/);
    expect(() => changeFolder("/m", "archive/..")).toThrow(/isn't a change id/);
    expect(() => changeFolder("/m", "archive/a/b")).toThrow(/isn't a change id/);
    expect(() => changeFolder("/m", "archive\\x")).toThrow(/isn't a change id/);
    const root = await forgeMetarepo();
    const c = await newChange(root, {
      title: "Return the order's time",
      type: "small-change",
      by: "pat",
      now: "2026-10-23T09:00:00Z",
    });
    for (const stray of ["_templates", "WIP", "My Change"])
      await mkdir(join(changeFolder(root, c.id), "..", stray), { recursive: true });
    expect((await changeStore(root).list()).map((x) => x.id)).toEqual([c.id]);
    expect(await changeStore(root).tryRead("My Change")).toBeUndefined();
  });
});
