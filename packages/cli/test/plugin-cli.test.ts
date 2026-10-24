import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { pluginEntryHash } from "@maycombhq/sdk";
import { pluginPin, pluginTest } from "../src/plugin-commands.js";

/** atticus plugin test and atticus plugin pin (ADR 0080), on fixtures/scanner-plugins. */
const FX = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/scanner-plugins");

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
};

async function metarepo() {
  const root = await mkdtemp(join(tmpdir(), "atticus-plugin-cli-"));
  await cp(join(FX, "metarepo"), root, { recursive: true });
  return root;
}

describe("atticus plugin test and pin (ADR 0080)", () => {
  it("tests a plugin against its golden files and says whether its pin holds", async () => {
    const root = await metarepo();
    const t = io();
    expect(await pluginTest(root, "forge-anvil-routes", t.io)).toBe(0);
    expect(t.out).toEqual([
      "Testing plugin forge-anvil-routes 1.0.0: 1 test",
      "  pass  notes",
      "1 test passed. The pin matches index.js.",
    ]);
  }, 60_000);

  it("prints what fails, and says when the entry file changed since the pin", async () => {
    const root = await metarepo();
    const dir = join(root, "org-pack", "plugins", "forge-anvil-routes");
    await writeFile(
      join(dir, "index.js"),
      (await readFile(join(dir, "index.js"), "utf8")).replace("method,\n", 'method: "PUT",\n'),
    );
    const t = io();
    expect(await pluginTest(root, "forge-anvil-routes", t.io)).toBe(1);
    expect(t.out).toContain("  FAIL  notes");
    expect(t.out).toContain('          notes.get-notes.method: expected "GET", got "PUT"');
    expect(t.out.at(-1)).toBe(
      "1 of 1 test failed. index.js changed since it was pinned: the scan won't use it until it is reviewed and pinned again.",
    );
  }, 60_000);

  it("pins the entry file's sha256 into plugin.yaml, keeping the comments", async () => {
    const root = await metarepo();
    const dir = join(root, "org-pack", "plugins", "forge-anvil-routes");
    const entry = join(dir, "index.js");
    await writeFile(entry, (await readFile(entry, "utf8")) + "// reviewed edit\n");
    const t = io();
    expect(await pluginPin(root, "forge-anvil-routes", t.io)).toBe(0);
    const hash = pluginEntryHash(await readFile(entry, "utf8"));
    const yaml = await readFile(join(dir, "plugin.yaml"), "utf8");
    expect(yaml).toContain(`sha256: ${hash}`);
    expect(yaml).toMatch(/^# A scanner plugin \(ADR 0080\)/);
    expect(t.out).toEqual([
      `Pinned forge-anvil-routes 1.0.0: index.js has sha256 ${hash}.`,
      "Commit plugin.yaml with the code, in the same reviewed change.",
    ]);
  });

  it("explains an unknown plugin", async () => {
    const root = await metarepo();
    const t = io();
    expect(await pluginTest(root, "forge-nothing", t.io)).toBe(1);
    expect(await pluginPin(root, "forge-nothing", t.io)).toBe(1);
    expect(t.err[0]).toBe(
      "No plugin forge-nothing in org-pack/plugins/ or org-pack/plugins/model-providers/. Plugins here: forge-anvil-routes, forge-hogs-memory, forge-loops, forge-opens-socket, forge-reads-outside, forge-spawns, forge-writes-file",
    );
  });
});
