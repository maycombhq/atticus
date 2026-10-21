import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CatalogRecord } from "@maycombhq/core";
import {
  defineExtractor,
  memoryRepo,
  pluginEntryHash,
  readPinnedEntry,
  sandboxedExtractor,
  scanRepo,
  type SandboxPlugin,
} from "../src/index.js";

/**
 * The scanner plugin sandbox (ADR 0080): a plugin runs in a worker thread with a time and
 * memory limit, reads files only through the repo handle (answered by the host), and can't
 * import, require or reach process, the network or the file system. A plugin that tries is
 * stopped and reported as a failed run; the other extractors of the scan still run.
 */
const PLUGINS = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures/scanner-plugins/metarepo/org-pack/plugins",
);
const AT = "2026-10-21T12:00:00Z";
const JAVA = `@AnvilService("/notes")\nclass NoteRoutes {\n  @Anvil.Get("/{id}")\n  Note one(String id) { return null; }\n}\n`;
const repo = memoryRepo("forge-anvil-notes", "a".repeat(40), {
  "src/main/java/forge/notes/NoteRoutes.java": JAVA,
  "README.md": "Notes\n",
});

/** A built-in stand-in that always produces one record, to show the scan goes on. */
const builtIn = defineExtractor({
  id: "readme",
  version: "1.0.0",
  claims: ["README.md"],
  async *scan(r) {
    yield {
      schemaVersion: 1,
      kind: "System",
      id: "notes",
      status: "current",
      confidence: "verified",
      evidence: [{ source: "config", path: "README.md" }],
      name: "Notes",
      boundary: "product",
      repos: [r.name],
      tags: [],
      accessGroup: "everyone",
    } as unknown as CatalogRecord;
  },
});

function plugin(source: string, patch: Partial<SandboxPlugin> = {}): SandboxPlugin {
  return {
    id: "forge-test",
    version: "1.0.0",
    emits: ["Endpoint"],
    limits: { timeoutMs: 5000, memoryMb: 64 },
    source,
    ...patch,
  };
}

/** A plugin body inside `scan`, for the plugins that misbehave. */
function body(code: string): string {
  return `export default {
  id: "forge-test",
  version: "1.0.0",
  claims: ["**/*"],
  async *scan(repo, ctx) {
${code}
  },
};`;
}

async function run(p: SandboxPlugin) {
  const s = await scanRepo({
    repo,
    extractors: [builtIn, sandboxedExtractor(p)],
    scannedAt: AT,
    repoInfo: { component: "notes-svc", repoType: "anvil-service" },
  });
  const pluginRun = s.runs.find((r) => r.extractor === "plugin-forge-test")!;
  return {
    s,
    status: pluginRun.status,
    error: pluginRun.error,
    // The other extractor's record is always there: the scan went on.
    builtInRan: s.records.some((r) => r.kind === "System"),
  };
}

describe("scanner plugin sandbox (ADR 0080)", () => {
  it("runs a good plugin: the Forge Anvil house framework's routes become endpoints", async () => {
    const source = await readFile(join(PLUGINS, "forge-anvil-routes", "index.js"), "utf8");
    const s = await scanRepo({
      repo,
      extractors: [
        builtIn,
        sandboxedExtractor(plugin(source, { id: "forge-anvil-routes", version: "1.0.0" })),
      ],
      scannedAt: AT,
      repoInfo: { component: "notes-svc" },
    });
    expect(s.runs.map((r) => [r.extractor, r.status, r.error])).toEqual([
      ["plugin-forge-anvil-routes", "ran", undefined],
      ["readme", "ran", undefined],
    ]);
    const ep = s.records.find((r) => r.kind === "Endpoint") as unknown as Record<string, unknown>;
    expect(ep).toMatchObject({
      id: "notes-svc.get-notes-id",
      method: "GET",
      pathOrTopic: "/notes/{id}",
      normalizedPath: "/notes/{}",
      evidence: [
        {
          source: "code",
          path: "src/main/java/forge/notes/NoteRoutes.java",
          line: 3,
          repo: "forge-anvil-notes",
          commit: "a".repeat(40),
          extractor: "plugin-forge-anvil-routes@1.0.0",
        },
      ],
    });
  }, 30_000);

  it("passes the scan context in and takes warnings out", async () => {
    const r = await run(
      plugin(
        body(`    ctx.warn("component " + ctx.component + ", type " + ctx.repoType, "README.md");
    ctx.warn("dialects " + ctx.dialects.length);`),
      ),
    );
    expect(r.status).toBe("ran");
    expect(r.s.warnings.filter((w) => w.extractor === "plugin-forge-test")).toEqual([
      {
        extractor: "plugin-forge-test",
        message: "component notes-svc, type anvil-service",
        path: "README.md",
      },
      { extractor: "plugin-forge-test", message: "dialects 0" },
    ]);
  }, 30_000);

  const blocked: [string, string, RegExp][] = [
    [
      "reads a file outside the repo",
      `    await repo.readText("../../org-pack/pack.yaml");`,
      /blocked: tried to read "\.\.\/\.\.\/org-pack\/pack\.yaml", which is outside the repo/,
    ],
    [
      "reads an absolute path",
      `    await repo.readText("C:/Windows/win.ini");`,
      /blocked: tried to read "C:\/Windows\/win\.ini", which is outside the repo/,
    ],
    [
      "lists files outside the repo",
      `    for await (const _ of repo.listFiles(["../**"])) {}`,
      /blocked: tried to list "\.\.\/\*\*", which is outside the repo/,
    ],
    [
      "writes a file (dynamic import of node:fs)",
      `    const fs = await import("node:fs");
    fs.writeFileSync("x.txt", "x");`,
      /blocked: tried to import node:fs/,
    ],
    [
      "opens a socket (require of node:net)",
      `    require("node:net").connect(80, "collector.example.com");`,
      /blocked: tried to use require/,
    ],
    [
      "starts a process (through process)",
      `    process.getBuiltinModule("node:child_process").execSync("whoami");`,
      /blocked: tried to use process/,
    ],
    [
      "reaches the network with fetch",
      `    await fetch("https://collector.example.com/");`,
      /blocked: tried to use fetch/,
    ],
    [
      "compiles code from a string to escape",
      `    const f = ({}).constructor.constructor("return process");
    f().exit(0);`,
      /blocked: tried to compile code from a string/,
    ],
    ["uses eval", `    eval("1 + 1");`, /blocked: tried to compile code from a string/],
    [
      "reads the clock, which would make the same commit read differently",
      `    ctx.warn(String(Date.now()));`,
      /blocked: tried to use Date/,
    ],
    [
      "uses randomness",
      `    ctx.warn(String(Math.random()));`,
      /blocked: tried to use Math\.random/,
    ],
    [
      "changes a built-in the sandbox relies on",
      `    Promise.prototype.then = function () {};`,
      /failed: Cannot assign to read only property 'then'/,
    ],
    [
      "hooks stack traces to find the host's functions",
      `    Error.prepareStackTrace = (e, frames) => frames;`,
      /failed: Cannot assign to read only property 'prepareStackTrace'|failed: Cannot add property prepareStackTrace/,
    ],
  ];
  for (const [what, code, message] of blocked)
    it(`blocks and reports a plugin that ${what}; the scan goes on`, async () => {
      const r = await run(plugin(body(code)));
      expect(r.status).toBe("failed");
      expect(r.error).toMatch(message);
      expect(r.builtInRan).toBe(true);
    }, 30_000);

  it("blocks a static import of anything, before the plugin runs", async () => {
    const r = await run(
      plugin(`import { writeFileSync } from "node:fs";
export default { id: "forge-test", version: "1.0.0", claims: ["**/*"], async *scan() { writeFileSync("x", "y"); } };`),
    );
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/blocked: tried to import node:fs/);
    expect(r.builtInRan).toBe(true);
  }, 30_000);

  it("can't reach the host through the objects it is given", async () => {
    const r = await run(
      plugin(
        body(`    const seen = [];
    for (const o of [repo, ctx, repo.readText, ctx.warn, repo.listFiles([]), globalThis]) {
      const F = o.constructor && o.constructor.constructor;
      try { F("return 1")(); seen.push("compiled"); } catch (e) { seen.push(e.name); }
    }
    ctx.warn(seen.join(","));`),
      ),
    );
    // Every Function constructor it can reach is the sandbox's own, which can't compile strings.
    expect(r.error).toMatch(/blocked: tried to compile code from a string/);
  }, 30_000);

  it("stops a plugin that loops forever, at its time limit", async () => {
    const started = Date.now();
    const r = await run(
      plugin(body(`    for (;;) {}`), { limits: { timeoutMs: 500, memoryMb: 64 } }),
    );
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/stopped after 500 ms, its time limit/);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(r.builtInRan).toBe(true);
  }, 30_000);

  it("stops a plugin that loops while it loads, before it exports anything", async () => {
    const r = await run(
      plugin(`for (;;) {}\nexport default {};`, { limits: { timeoutMs: 500, memoryMb: 64 } }),
    );
    expect(r.error).toMatch(/stopped after 500 ms, its time limit/);
    expect(r.builtInRan).toBe(true);
  }, 30_000);

  it("stops a plugin that allocates too much memory, at its memory limit", async () => {
    const r = await run(
      plugin(
        body(`    const hoard = [];
    for (;;) hoard.push(new Array(100000).fill("x"));`),
        { limits: { timeoutMs: 30_000, memoryMb: 32 } },
      ),
    );
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/stopped: it used more than its 32 MB memory limit/);
    expect(r.builtInRan).toBe(true);
  }, 60_000);

  it("fails a plugin that emits a kind its manifest doesn't name, or isn't the plugin it says", async () => {
    const db = await run(
      plugin(
        body(
          `    yield { schemaVersion: 1, kind: "Database", id: "notes-db", status: "current", confidence: "verified", evidence: [{ source: "code", path: "README.md" }] };`,
        ),
      ),
    );
    expect(db.error).toMatch(/emitted a Database record; its manifest allows Endpoint/);
    const other = await run(plugin(body(""), { id: "forge-test", version: "2.0.0" }));
    expect(other.error).toMatch(
      /exports forge-test 1\.0\.0, but its manifest says forge-test 2\.0\.0/,
    );
    const none = await run(plugin(`export default 42;`));
    expect(none.error).toMatch(/default export isn't an extractor/);
  }, 60_000);

  it("rejects an invalid record like any extractor's, and reports a plugin's own error", async () => {
    const bad = await run(
      plugin(body(`    yield { schemaVersion: 1, kind: "Endpoint", id: "Not A Slug" };`)),
    );
    expect(bad.status).toBe("ran");
    expect(bad.s.rejected.map((r) => r.extractor)).toEqual(["plugin-forge-test"]);
    const thrown = await run(plugin(body(`    throw new Error("can't parse the route table");`)));
    expect(thrown.error).toMatch(/failed: can't parse the route table/);
    const missing = await run(
      plugin(
        body(
          `    try { await repo.readText("no/such/file.txt"); } catch (e) { ctx.warn(e.message); }`,
        ),
      ),
    );
    expect(missing.status).toBe("ran");
    expect(missing.s.warnings.map((w) => w.message)).toEqual(["no such file: no/such/file.txt"]);
  }, 60_000);

  it("loads an entry file only when its sha256 matches the pin", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atticus-plugin-pin-"));
    const source = "export default {};\n";
    await writeFile(join(dir, "index.js"), source);
    const manifest = { entry: "index.js", sha256: pluginEntryHash(source) };
    expect(await readPinnedEntry(dir, manifest)).toEqual({ ok: true, source });
    // Line endings don't change the hash, so a Windows checkout matches a Linux one.
    expect(pluginEntryHash("a\r\nb\n")).toBe(pluginEntryHash("a\nb\n"));
    await writeFile(join(dir, "index.js"), source + "// changed\n");
    expect(await readPinnedEntry(dir, manifest)).toEqual({
      ok: false,
      message:
        "index.js changed after it was pinned: its sha256 isn't the one in plugin.yaml. Review the change, then run atticus plugin pin",
    });
    expect(await readPinnedEntry(dir, { entry: "index.js" })).toEqual({
      ok: false,
      message: "isn't pinned: run atticus plugin pin once it is reviewed",
    });
    expect((await readPinnedEntry(dir, { entry: "gone.js", sha256: "0".repeat(64) })).ok).toBe(
      false,
    );
  });
});
