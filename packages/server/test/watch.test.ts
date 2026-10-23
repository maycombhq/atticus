import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { watchMetarepo, type MetarepoWatch } from "../src/watch.js";

/**
 * The server follows the metarepo's files itself (ADR 0119), so the app in a browser or in
 * IntelliJ's panel hears what an assistant or the CLI wrote, as the VS Code panel does.
 */

const watches: MetarepoWatch[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const w of watches.splice(0)) w.close();
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});

async function metarepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-watch-"));
  roots.push(root);
  for (const d of [
    "org-pack",
    "catalog/generated",
    "openspec/changes/a",
    "workspace/repo",
    ".index",
  ])
    await mkdir(join(root, d), { recursive: true });
  return root;
}

function collect(root: string, delayMs = 60) {
  const events: { type: string; path?: unknown }[] = [];
  const w = watchMetarepo({ root, publish: (e) => events.push(e), delayMs });
  watches.push(w);
  return { events, w };
}

const until = async (ok: () => boolean, ms = 4000) => {
  const start = Date.now();
  while (!ok()) {
    if (Date.now() - start > ms) return;
    await new Promise((r) => setTimeout(r, 25));
  }
};

const paths = (es: { path?: unknown }[]) => es.map((e) => String(e.path));

describe("watchMetarepo", () => {
  it("sends file.changed with the path from the root when a change's file is written", async () => {
    const root = await metarepo();
    const { events } = collect(root);
    await writeFile(join(root, "openspec/changes/a/brief.md"), "# A\n");
    await until(() => paths(events).includes("openspec/changes/a/brief.md"));
    expect(events).toContainEqual({ type: "file.changed", path: "openspec/changes/a/brief.md" });
  });

  it("says one path once however often it was written while it waited", async () => {
    const root = await metarepo();
    const { events } = collect(root, 150);
    const f = join(root, "catalog/generated/system.yaml");
    for (let i = 0; i < 5; i++) await writeFile(f, `n: ${i}\n`);
    await until(() => events.length > 0);
    await new Promise((r) => setTimeout(r, 300));
    expect(paths(events).filter((p) => p === "catalog/generated/system.yaml")).toHaveLength(1);
  });

  it("leaves out the index, the base clones and Git, which change as the app reads", async () => {
    const root = await metarepo();
    const { events } = collect(root);
    await writeFile(join(root, ".index/catalog.sqlite"), "x");
    await writeFile(join(root, "workspace/repo/Main.java"), "class Main {}");
    await writeFile(join(root, "org-pack/pack.yaml"), "id: forge\n");
    await until(() => paths(events).includes("org-pack/pack.yaml"));
    expect(paths(events)).toContain("org-pack/pack.yaml");
    expect(paths(events).some((p) => p.startsWith(".index") || p.startsWith("workspace"))).toBe(
      false,
    );
  });

  it("starts following a folder that is made after it started", async () => {
    const root = await metarepo();
    const { events } = collect(root);
    await mkdir(join(root, "questions"), { recursive: true });
    // Give it a moment to see the new folder before writing in it.
    await new Promise((r) => setTimeout(r, 200));
    await writeFile(join(root, "questions/q-1.yaml"), "id: q-1\n");
    await until(() => paths(events).includes("questions/q-1.yaml"));
    expect(paths(events)).toContain("questions/q-1.yaml");
  });

  it("says each top folder once when very many files change together", async () => {
    const root = await metarepo();
    const { events } = collect(root, 200);
    await Promise.all(
      Array.from({ length: 80 }, (_, i) =>
        writeFile(join(root, `catalog/generated/r-${i}.yaml`), "x"),
      ),
    );
    await until(() => events.length > 0);
    await new Promise((r) => setTimeout(r, 400));
    // The burst is said as its folder (Windows may report the folder itself); an event the OS
    // reports late may follow on its own.
    expect(["catalog", "catalog/generated"]).toContain(paths(events)[0]);
    expect(paths(events).every((p) => p.startsWith("catalog"))).toBe(true);
    expect(events.length).toBeLessThan(20);
  });

  it("lists what it follows and stops when closed", async () => {
    const root = await metarepo();
    const { events, w } = collect(root);
    expect(w.following).toEqual(expect.arrayContaining(["catalog", "openspec", "org-pack"]));
    expect(w.following).not.toContain("workspace");
    w.close();
    await writeFile(join(root, "org-pack/pack.yaml"), "id: forge\n");
    await new Promise((r) => setTimeout(r, 300));
    expect(events).toEqual([]);
  });
});
