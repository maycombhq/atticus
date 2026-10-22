import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { Sources } from "@maycombhq/core";
import { absorb, acceptAbsorbed, adopt, AdoptError, init } from "../src/index.js";
import { cleanup, copyFixture, fixture, tempDir } from "./helpers.js";

afterAll(cleanup);

let root: string;
beforeEach(async () => {
  root = join(await tempDir(), "shop-meta");
  await init(root, { name: "shop", platform: "shop", openspec: "folders" });
});

const sources = async (dir: string) =>
  Sources.parse(parse(await readFile(join(dir, "org-pack", "sources.yaml"), "utf8")));

describe("atticus absorb accept", () => {
  it("copies what the proposal adopts into the org pack and adds the absorbed entry", async () => {
    const r = await absorb(root, fixture("assistant-repo"), { id: "team-a" });
    const adopted = [
      ...new Set(
        r.items.filter((i) => i.action === "adopt" && i.artifact).map((i) => i.artifact!.path),
      ),
    ].sort();
    const a = await acceptAbsorbed(root, "team-a");
    expect(a.copied).toEqual(adopted);
    expect(a.copied.every((f) => f.startsWith("org-pack/"))).toBe(true);
    for (const f of a.copied)
      expect(await readFile(join(root, f), "utf8")).toBe(
        await readFile(join(root, "proposals", "absorb", "team-a", f), "utf8"),
      );
    expect(a.entry).toBe("added");
    expect((await sources(root)).absorbed).toEqual([r.entry]);
    // Linked items stay in the proposal as references: followed, not copied.
    expect(a.linked).toBeGreaterThan(0);
  });

  it("does it once: a second accept changes nothing", async () => {
    await absorb(root, fixture("assistant-repo"), { id: "team-a" });
    const first = await acceptAbsorbed(root, "team-a");
    const again = await acceptAbsorbed(root, "team-a");
    expect(again.copied).toEqual([]);
    expect(again.same).toEqual(first.copied);
    expect(again.entry).toBe("already");
    expect((await sources(root)).absorbed).toHaveLength(1);
  });

  it("keeps a file someone changed, unless asked to replace it", async () => {
    await absorb(root, fixture("assistant-repo"), { id: "team-a" });
    const first = await acceptAbsorbed(root, "team-a");
    const f = first.copied[0]!;
    await writeFile(join(root, f), "edited by a person\n");
    const kept = await acceptAbsorbed(root, "team-a");
    expect(kept.kept).toEqual([f]);
    expect(await readFile(join(root, f), "utf8")).toBe("edited by a person\n");
    const replaced = await acceptAbsorbed(root, "team-a", { replace: true });
    expect(replaced.copied).toEqual([f]);
    expect(await readFile(join(root, f), "utf8")).not.toBe("edited by a person\n");
  });

  it("writes nothing on a dry run", async () => {
    await absorb(root, fixture("assistant-repo"), { id: "team-a" });
    const before = await readFile(join(root, "org-pack", "sources.yaml"), "utf8");
    const a = await acceptAbsorbed(root, "team-a", { dryRun: true });
    expect(a.copied.length).toBeGreaterThan(0);
    expect(await readFile(join(root, "org-pack", "sources.yaml"), "utf8")).toBe(before);
    await expect(readFile(join(root, a.copied[0]!), "utf8")).rejects.toThrow();
  });

  it("federates another metarepo: nothing copied, the source followed", async () => {
    await absorb(root, fixture("atticus-metarepo"), { id: "payments" });
    const a = await acceptAbsorbed(root, "payments");
    expect(a.copied).toEqual([]);
    expect(a.entry).toBe("added");
    expect((await sources(root)).absorbed[0]).toMatchObject({ id: "payments", format: "atticus" });
  });

  it("imports adopted OpenSpec specs into the metarepo's openspec folder", async () => {
    await absorb(root, fixture("openspec-repo"), { id: "notes", mode: "adopt" });
    const a = await acceptAbsorbed(root, "notes");
    expect(a.copied.some((f) => f.startsWith("openspec/specs/"))).toBe(true);
  });

  it("puts files in .atticus/ for a repo adopted in place", async () => {
    const repo = await copyFixture("assistant-repo", "pricing-service");
    await adopt(repo);
    await absorb(repo, fixture("critic-prompts"), { id: "team-a" });
    const a = await acceptAbsorbed(repo, "team-a");
    expect(a.copied.length).toBeGreaterThan(0);
    expect(a.copied.every((f) => f.startsWith(".atticus/org-pack/"))).toBe(true);
    const s = Sources.parse(
      parse(await readFile(join(repo, ".atticus", "org-pack", "sources.yaml"), "utf8")),
    );
    expect(s.absorbed.map((x) => x.id)).toEqual(["team-a"]);
  });

  it("says how to make the proposal when there is none", async () => {
    await expect(acceptAbsorbed(root, "nobody")).rejects.toThrow(AdoptError);
    await expect(acceptAbsorbed(root, "nobody")).rejects.toThrow(/atticus absorb .* --id nobody/);
  });
});
