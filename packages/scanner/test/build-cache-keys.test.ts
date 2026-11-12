import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Question, serializeRecord, writeQuestion } from "@maycombhq/core";
import {
  baselineTarget,
  buildAndWrite,
  buildCacheDirOf,
  buildCacheHooks,
  buildCacheStats,
  buildCatalog,
  buildUndoDirOf,
  forgetSerializedTexts,
  loadBuildInputs,
  parseBuildManifest,
  parseReadersSlot,
  readersSlotPath,
  readersSlotRead,
  serializeBuildManifest,
  serializeReadersSlot,
  sha256Of,
} from "../src/index.js";
import {
  buildKeyOf,
  codeStampOf,
  sameJsonValue,
  encodeKept,
  decodeKept,
} from "../src/build-cache.js";

/**
 * The build cache's key and its guards (ADR 0195 point 9, the review of its first cut): every
 * input a build reads misses the last build when it changes (the org pack, an answer, a
 * repo's corrections, a file under inputs/ by its bytes, the helpers switched off, the code that
 * builds), a build gives what the same build without the cache gives (-0 included), a build
 * whose folders changed while it ran isn't kept, and the guards run on a build the cache gave
 * whole. The code's stamp: the bundle's build id, or a checkout's hash of what the scanner
 * reaches; none (the cache off) when neither can be worked out. Invented Forge estate only.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");
const SLOTS = join(FORGE, "slots");
const T = 240_000;
const made: string[] = [];
afterAll(async () => {
  buildCacheHooks.off = false;
  delete buildCacheHooks.stamp;
  delete process.env.ATTICUS_HELPERS_OFF;
  await Promise.all(made.map((d) => rm(d, { recursive: true, force: true })));
});
beforeEach(() => {
  buildCacheHooks.off = false;
  delete buildCacheHooks.stamp;
});

async function temp(prefix = "atticus-cache-keys-"): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix));
  made.push(d);
  return d;
}

/** The Forge metarepo with every golden slot and its inputs. */
async function forge(): Promise<string> {
  const root = await temp();
  await cp(join(FORGE, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
  await cp(join(FORGE, "inputs"), join(root, "inputs"), { recursive: true });
  for (const d of ["readers", "facts", "legacy"])
    await cp(join(SLOTS, d), join(root, "catalog/sources", d), { recursive: true });
  return root;
}

/** Built until nothing changes (the first build writes joins.json, an input of the next). */
async function settle(root: string) {
  let r = await buildAndWrite(root, { command: "atticus catalog build" });
  for (let n = 0; n < 3 && r.write && (r.write.written || r.write.slots.length); n++)
    r = await buildAndWrite(root, { command: "atticus catalog build" });
  if (r.guard.refused?.allowRemovals !== undefined)
    r = await buildAndWrite(root, {
      command: "atticus catalog build",
      allowRemovals: r.guard.refused.allowRemovals,
    });
  return r;
}

async function uncached(root: string, o: Parameters<typeof loadBuildInputs>[1] = {}) {
  buildCacheHooks.off = true;
  try {
    return await buildCatalog(await loadBuildInputs(root, o));
  } finally {
    buildCacheHooks.off = false;
  }
}

/** A build made now, and whether the cache gave it whole. */
async function cached(root: string) {
  const s0 = buildCacheStats();
  const b = await buildCatalog(await loadBuildInputs(root));
  return { b, hit: buildCacheStats().memoHits - s0.memoHits };
}

const LEDGER_CALL = {
  file: "src/main/java/forge/ledger/FxClient.java",
  line: 31,
  value: "/v1/rates/",
};

describe("every input a build reads is in its key (ADR 0195 point 9)", () => {
  it(
    "the org pack, an answer, a repo's corrections, an inputs/ file's bytes, the helpers switched off and the code's stamp each miss the last build; each build equals one without the cache",
    async () => {
      const root = await forge();
      await settle(root);
      expect((await cached(root)).hit).toBe(1);
      const pdf = join(root, "inputs", "partner-specs", "rates.pdf");
      const pdfBytes = (c: number) =>
        Buffer.concat([
          Buffer.from("%PDF-1.4\n1 0 obj << /Length 20 >> stream\nBT (Caf", "latin1"),
          Buffer.from([c]),
          Buffer.from(") Tj ET\nendstream endobj\n%%EOF\n", "latin1"),
        ]);
      const changes: [string, () => Promise<void>, (() => void)?][] = [
        [
          "the org pack",
          async () => {
            const f = join(root, "org-pack", "README.md");
            await writeFile(f, `${await readFile(f, "utf8").catch(() => "")}\nA line more.\n`);
          },
        ],
        [
          "an answer",
          () =>
            writeQuestion(
              root,
              Question.parse({
                schemaVersion: 5,
                id: "q-aaaaaaaaaaa1",
                askedBy: {
                  step: "facts-targets",
                  command: "atticus verify forge-ledger --write",
                  at: "2026-11-12T08:00:00Z",
                },
                repo: "forge-ledger",
                question: "Where does forge-ledger's call on line 31 go?",
                options: [
                  { label: "forge-portal-bff", means: "a path like it", changes: "joins it" },
                  { label: "None of these", means: "Nothing answers it", changes: "stays loose" },
                ],
                evidence: [`${LEDGER_CALL.file}:${LEDGER_CALL.line}`],
                scope: { level: "repo", id: "forge-ledger" },
                state: "answered",
                answer: {
                  option: 2,
                  by: "pat",
                  at: "2026-11-12T08:10:00.000Z",
                  scope: { level: "repo", id: "forge-ledger" },
                },
                rerun: "atticus verify forge-ledger --write",
              }),
            ),
        ],
        [
          "a repo's corrections",
          async () => {
            await mkdir(join(root, "facts"), { recursive: true });
            await writeFile(
              join(root, "facts", "forge-ledger.corrections.jsonl"),
              `${JSON.stringify({
                schemaVersion: 2,
                fact: "c-fx-rate",
                target: { kind: "call", ...LEDGER_CALL },
                action: "link",
                link: { repo: "forge-portal-bff", path: "/api/balance/{id}" },
                by: "pat",
                at: "2026-11-12T00:00:00.000Z",
              })}\n`,
            );
          },
        ],
        ["a binary file under inputs/", () => writeFile(pdf, pdfBytes(0xe9))],
        // The same file, a byte UTF-8 reads as the same replacement character.
        ["that file's bytes, where UTF-8 can't tell", () => writeFile(pdf, pdfBytes(0xe8))],
        [
          "the helpers switched off",
          async () => {
            process.env.ATTICUS_HELPERS_OFF = "readers";
            await Promise.resolve();
          },
          () => {
            delete process.env.ATTICUS_HELPERS_OFF;
          },
        ],
        [
          "the code's stamp",
          async () => {
            buildCacheHooks.stamp = "another code's stamp";
            await Promise.resolve();
          },
        ],
      ];
      for (const [what, change, after] of changes) {
        await change();
        try {
          const { b, hit } = await cached(root);
          expect(hit, what).toBe(0);
          const cold = await uncached(root);
          expect(b, what).toStrictEqual(cold);
          // Kept now: the same inputs again are the build just made.
          const w = await buildAndWrite(root, { command: "atticus catalog build" });
          if (w.guard.refused?.allowRemovals !== undefined)
            await buildAndWrite(root, {
              command: "atticus catalog build",
              allowRemovals: w.guard.refused.allowRemovals,
            });
          const again = await cached(root);
          expect(again.hit, `${what}, again`).toBe(1);
          expect(again.b, `${what}, again`).toStrictEqual(await uncached(root));
        } finally {
          after?.();
        }
      }
    },
    T,
  );

  it(
    "a build with a pending corrections file reads its pairs from it, as the build after the write does",
    async () => {
      const root = await forge();
      await settle(root);
      const path = join(root, "facts", "forge-ledger.corrections.jsonl");
      const line = JSON.stringify({
        schemaVersion: 2,
        fact: "c-fx-rate",
        target: { kind: "call", ...LEDGER_CALL },
        action: "link",
        link: { repo: "forge-portal-bff", path: "/api/balance/{id}" },
        by: "pat",
        at: "2026-11-12T00:00:00.000Z",
      });
      const pending = await uncached(root, { pending: new Map([[path, `${line}\n`]]) });
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${line}\n`);
      const after = await uncached(root);
      await rm(path);
      const none = await uncached(root);
      const joins = (b: typeof after) => JSON.stringify([...b.facts]);
      // The pairing changes the build at all (else this proves nothing).
      expect(joins(after) === joins(none), "the pairing changes nothing").toBe(false);
      expect(joins(pending)).toBe(joins(after));
      expect([...pending.files]).toEqual([...after.files]);
    },
    T,
  );

  it("-0 is kept as -0: not trusted as 0, and encoded apart", () => {
    expect(sameJsonValue(-0, 0)).toBe(false);
    expect(sameJsonValue({ a: [-0] }, { a: [-0] })).toBe(true);
    expect(sameJsonValue({ a: [0] }, { a: [-0] })).toBe(false);
    expect(Object.is(decodeKept(encodeKept({ a: -0 })) as { a: number }, -0)).toBe(false);
    expect(Object.is((decodeKept(encodeKept({ a: -0 })) as { a: number }).a, -0)).toBe(true);
    expect(Object.is((decodeKept(encodeKept({ a: 0 })) as { a: number }).a, 0)).toBe(true);
  });

  it("a readers slot with -0 reads the same, checked or trusted", async () => {
    const text = (await readFile(join(SLOTS, "readers", "forge-infra.json"), "utf8")).replace(
      '"replicas": 3,',
      '"replicas": -0,',
    );
    const yamlOf = (x: ReturnType<typeof readersSlotRead>) =>
      "slot" in x ? x.slot.records.map((r) => serializeRecord(r)).join("") : x.problem;
    const cold = yamlOf(readersSlotRead(text, "forge-infra"));
    const warm = yamlOf(readersSlotRead(text, "forge-infra"));
    expect(cold).toContain("replicas: -0");
    expect(warm).toBe(cold);
  });

  it(
    "a record with -0 after one with 0 is written with -0, and the build the cache gives keeps it",
    async () => {
      const root = await forge();
      await settle(root);
      const slot = join(root, "catalog/sources/readers/forge-infra.json");
      const text = await readFile(slot, "utf8");
      const infraFiles = (b: Awaited<ReturnType<typeof uncached>>) =>
        [...b.files].filter(([, t]) => /replicas: -?\d/.test(t)).map(([, t]) => t);
      await writeFile(slot, text.replace('"replicas": 3,', '"replicas": 0,'));
      await settle(root);
      expect(infraFiles((await cached(root)).b).join("")).toMatch(/replicas: 0\n/);
      await writeFile(slot, text.replace('"replicas": 3,', '"replicas": -0,'));
      const r = await settle(root);
      expect(infraFiles(r.build).join("")).toMatch(/replicas: -0\n/);
      forgetSerializedTexts();
      const { b, hit } = await cached(root);
      expect(hit).toBe(1);
      expect(infraFiles(b).join("")).toMatch(/replicas: -0\n/);
      expect(b).toStrictEqual(await uncached(root));
    },
    T,
  );

  it("a build whose folders changed while it ran isn't kept: the key's folders are hashed again", async () => {
    const root = await temp();
    const proposals = join(root, "catalog/proposals");
    await mkdir(proposals, { recursive: true });
    await writeFile(join(proposals, "a.md"), "one\n");
    const key = await buildKeyOf({
      inputs: { inputsDir: null },
      slots: {},
      proposalsDir: proposals,
      orgPackDir: join(root, "org-pack"),
      wikis: [],
    });
    expect(key).toBeDefined();
    expect(await key!.unchanged()).toBe(true);
    await writeFile(join(proposals, "a.md"), "two\n");
    expect(await key!.unchanged()).toBe(false);
  });

  it(
    "keeps the build in the state folder it was built for, not the metarepo's",
    async () => {
      const root = await forge();
      await settle(root);
      const state = await temp("atticus-cache-state-");
      const lastBuild = (d: string) => join(buildCacheDirOf(d), "last-build.jsonl");
      await rm(lastBuild(root));
      const b = await buildCatalog(await loadBuildInputs(root, { stateDir: state }));
      await buildAndWrite(root, { command: "atticus catalog build", build: b });
      expect(existsSync(lastBuild(state))).toBe(true);
      expect(existsSync(lastBuild(root))).toBe(false);
    },
    T,
  );
});

describe("a build the cache gives whole is guarded as any build (ADR 0195 point 4)", () => {
  it(
    "hand edits are listed",
    async () => {
      const root = await forge();
      await settle(root);
      const dir = join(root, "catalog/generated/setting");
      const f = join(dir, (await readdir(dir))[0]!);
      await writeFile(f, `${await readFile(f, "utf8")}# a person's note\n`);
      const s0 = buildCacheStats();
      const r = await buildAndWrite(root, { command: "atticus catalog build" });
      expect(buildCacheStats().memoHits).toBe(s0.memoHits + 1);
      expect(r.guard.refused?.reasons).toContain("hand-edits");
    },
    T,
  );

  it(
    "a large removal waits for its count, on the refused build kept",
    async () => {
      const root = await forge();
      await settle(root);
      const path = readersSlotPath(root, "forge-gateway");
      const p = parseReadersSlot(await readFile(path, "utf8"), "forge-gateway");
      if (!p.ok) throw new Error("slot doesn't read");
      await writeFile(
        path,
        serializeReadersSlot({ ...p.slot, records: p.slot.records.slice(0, 1) }),
      );
      const first = await buildAndWrite(root, { command: "atticus catalog build" });
      expect(first.guard.refused?.reasons).toEqual(["large-removals"]);
      const s0 = buildCacheStats();
      const again = await buildAndWrite(root, { command: "atticus catalog build" });
      expect(buildCacheStats().memoHits).toBe(s0.memoHits + 1);
      expect(again.guard.refused?.reasons).toEqual(["large-removals"]);
      expect(again.guard.refused?.allowRemovals).toBe(first.guard.refused?.allowRemovals);
      const wrong = await buildAndWrite(root, {
        command: "atticus catalog build",
        allowRemovals: first.guard.refused!.allowRemovals! + 1,
      });
      expect(wrong.guard.refused?.reasons).toEqual(["large-removals"]);
      expect(wrong.write).toBeUndefined();
    },
    T,
  );

  it(
    "a removal nothing explains is refused",
    async () => {
      const root = await forge();
      await settle(root);
      // build.json (read only by the guards, never a build input) lists a file this build
      // doesn't make, whose sources are all as they were: a removal nothing explains.
      const target = baselineTarget(root);
      const m = parseBuildManifest(await readFile(target.manifest, "utf8"));
      if (!m.ok) throw new Error("build.json doesn't read");
      const one = m.slot.files.find((f) => f.path.includes("/setting/"))!;
      const text = (await readFile(join(root, ...one.path.split("/")), "utf8")).replace(
        /^id: (.+)$/m,
        "id: $1-made-up",
      );
      const path = one.path.replace(/\.yaml$/, "-made-up.yaml");
      await writeFile(join(root, ...path.split("/")), text);
      await writeFile(
        target.manifest,
        serializeBuildManifest({
          ...m.slot,
          files: [...m.slot.files, { ...one, path, sha256: sha256Of(text) }].sort((a, b) =>
            a.path < b.path ? -1 : 1,
          ),
        }),
      );
      const s0 = buildCacheStats();
      const r = await buildAndWrite(root, { command: "atticus catalog build" });
      expect(buildCacheStats().memoHits).toBe(s0.memoHits + 1);
      expect(r.guard.refused?.reasons).toContain("unexplained-removals");
      expect(r.write).toBeUndefined();
    },
    T,
  );

  it(
    "a catalog with no build.json is one from before the slots",
    async () => {
      const root = await forge();
      await settle(root);
      await rm(baselineTarget(root).manifest);
      await rm(buildUndoDirOf(root), { recursive: true, force: true });
      const s0 = buildCacheStats();
      const r = await buildAndWrite(root, { command: "atticus catalog build" });
      expect(buildCacheStats().memoHits).toBe(s0.memoHits + 1);
      expect(r.guard.refused?.reasons).toEqual(["not-upgraded"]);
      expect(r.write).toBeUndefined();
    },
    T,
  );
});

describe("the code's stamp (ADR 0195 point 9)", () => {
  it("is the bundle's build id when it has one, and none when the id wasn't written", () => {
    const id = (c: string) => c.repeat(64);
    const a = codeStampOf({ buildId: id("a"), moduleUrl: "file:///nowhere/build-cache.js" });
    const b = codeStampOf({ buildId: id("b"), moduleUrl: "file:///nowhere/build-cache.js" });
    expect(a).toMatchObject({ from: "bundle" });
    expect(a.stamp).toMatch(/^[0-9a-f]{64}$/);
    expect(b.stamp).not.toBe(a.stamp);
    const placeholder = codeStampOf({
      buildId: `atticus-build-id:${"=".repeat(47)}`,
      moduleUrl: "file:///nowhere/build-cache.js",
    });
    expect(placeholder.stamp).toBeUndefined();
    expect(placeholder).toMatchObject({ why: expect.stringMatching(/wasn't written/) });
  });

  /** A checkout: the scanner, core (a workspace package, linked) and yaml (a third party). */
  async function checkout() {
    const ws = await temp("atticus-stamp-");
    const pkg = (dir: string, m: object) =>
      mkdir(dir, { recursive: true }).then(() =>
        writeFile(join(dir, "package.json"), JSON.stringify(m)),
      );
    const scanner = join(ws, "packages/scanner");
    const core = join(ws, "packages/core");
    const yaml = join(ws, "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml");
    await pkg(scanner, {
      name: "@maycombhq/scanner",
      version: "1.0.0",
      files: ["dist"],
      dependencies: { "@maycombhq/core": "workspace:*", yaml: "^2.9.1" },
    });
    await pkg(core, {
      name: "@maycombhq/core",
      version: "1.0.0",
      files: ["dist", "schema"],
      dependencies: { yaml: "^2.9.1" },
    });
    await pkg(yaml, { name: "yaml", version: "2.9.1" });
    for (const [d, f, t] of [
      [scanner, "dist/build-cache.js", "export {};\n"],
      [core, "dist/index.js", "export const a = 1;\n"],
      [core, "schema/record.json", "{}\n"],
      [core, "dist/index.js.map", "{}\n"],
    ] as const) {
      await mkdir(dirname(join(d, f)), { recursive: true });
      await writeFile(join(d, f), t);
    }
    await mkdir(join(scanner, "node_modules/@maycombhq"), { recursive: true });
    await symlink(core, join(scanner, "node_modules/@maycombhq/core"), "junction");
    await symlink(yaml, join(scanner, "node_modules/yaml"), "junction");
    await mkdir(join(core, "node_modules"), { recursive: true });
    await symlink(yaml, join(core, "node_modules/yaml"), "junction");
    const stampOf = () =>
      codeStampOf({
        buildId: undefined,
        moduleUrl: pathToFileURL(join(scanner, "dist/build-cache.js")).href,
      });
    return { ws, scanner, core, yaml, stampOf };
  }

  it("in a checkout, changes with any file a workspace package it reaches publishes, and with a third party's version", async () => {
    const c = await checkout();
    const first = c.stampOf();
    expect(first).toMatchObject({ from: "checkout" });
    expect(c.stampOf().stamp).toBe(first.stamp);
    // A source map isn't code that runs.
    await writeFile(join(c.core, "dist/index.js.map"), '{"x":1}\n');
    expect(c.stampOf().stamp).toBe(first.stamp);
    await writeFile(join(c.core, "dist/index.js"), "export const a = 2;\n");
    const second = c.stampOf();
    expect(second.stamp).not.toBe(first.stamp);
    await writeFile(join(c.core, "schema/record.json"), '{"a":1}\n');
    const third = c.stampOf();
    expect(third.stamp).not.toBe(second.stamp);
    await writeFile(
      join(c.yaml, "package.json"),
      JSON.stringify({ name: "yaml", version: "2.9.2" }),
    );
    expect(c.stampOf().stamp).not.toBe(third.stamp);
  });

  it("in a checkout, is none when a workspace dependency isn't found, or the module isn't the scanner's", async () => {
    const c = await checkout();
    await rm(join(c.scanner, "node_modules/@maycombhq/core"));
    expect(c.stampOf()).toMatchObject({ why: expect.stringMatching(/needs @maycombhq\/core/) });
    const other = codeStampOf({
      buildId: undefined,
      moduleUrl: pathToFileURL(join(c.core, "dist/index.js")).href,
    });
    expect(other).toMatchObject({ why: expect.stringMatching(/@maycombhq\/scanner/) });
  });

  /**
   * The offline bundle's layout (ADR 0052: `pnpm deploy` of the CLI, scripts/bundle/inventory.mjs):
   * the scanner and every @maycombhq package are real folders under node_modules, beside the
   * third-party ones, and no build id is written into their code.
   */
  async function deployed() {
    const root = await temp("atticus-stamp-deploy-");
    const nm = join(root, "node_modules");
    const pkg = (dir: string, m: object) =>
      mkdir(dir, { recursive: true }).then(() =>
        writeFile(join(dir, "package.json"), JSON.stringify(m)),
      );
    const scanner = join(nm, "@maycombhq/scanner");
    const core = join(nm, "@maycombhq/core");
    const yaml = join(nm, "yaml");
    await pkg(join(root), { name: "@maycombhq/cli", version: "1.0.0" });
    await pkg(scanner, {
      name: "@maycombhq/scanner",
      version: "1.0.0",
      private: true,
      main: "./dist/index.js",
      files: ["dist"],
      dependencies: { "@maycombhq/core": "1.0.0", yaml: "^2.9.1" },
    });
    await pkg(core, {
      name: "@maycombhq/core",
      version: "1.0.0",
      main: "./dist/index.js",
      files: ["dist"],
      dependencies: { yaml: "^2.9.1" },
    });
    await pkg(yaml, { name: "yaml", version: "2.9.1" });
    for (const [d, f, t] of [
      [scanner, "dist/build-cache.js", "export {};\n"],
      [scanner, "dist/index.js", "export {};\n"],
      [core, "dist/index.js", "export const a = 1;\n"],
    ] as const) {
      await mkdir(dirname(join(d, f)), { recursive: true });
      await writeFile(join(d, f), t);
    }
    const stampOf = (loadedAt?: number) =>
      codeStampOf({
        buildId: undefined,
        moduleUrl: pathToFileURL(join(scanner, "dist/build-cache.js")).href,
        ...(loadedAt === undefined ? {} : { loadedAt }),
      });
    return { root, scanner, core, yaml, stampOf };
  }

  it("installed by pnpm deploy (the offline bundle), hashes the files of every @maycombhq package, not their names and versions", async () => {
    const d = await deployed();
    const first = d.stampOf();
    expect(first).toMatchObject({
      from: "installed",
      stamp: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(d.stampOf().stamp).toBe(first.stamp);
    // A rebuilt bundle of the same version: the core's code changed, its version didn't.
    await writeFile(join(d.core, "dist/index.js"), "export const a = 2;\n");
    const second = d.stampOf();
    expect(second.stamp).not.toBe(first.stamp);
    await writeFile(join(d.scanner, "dist/index.js"), "export const b = 1;\n");
    const third = d.stampOf();
    expect(third.stamp).not.toBe(second.stamp);
    // A third party is named by its version.
    await writeFile(
      join(d.yaml, "package.json"),
      JSON.stringify({ name: "yaml", version: "2.9.2" }),
    );
    expect(d.stampOf().stamp).not.toBe(third.stamp);
  });

  it("is none when a package of ours has none of its code to hash (only its name and version)", async () => {
    const d = await deployed();
    await rm(join(d.core, "dist"), { recursive: true });
    expect(d.stampOf()).toMatchObject({
      why: expect.stringMatching(/@maycombhq\/core.*dist\/index\.js/),
    });
  });

  it("is none when a file it hashes changed after the code loaded (a dist rebuilt under a running app)", async () => {
    const d = await deployed();
    const loadedAt = Date.now() - 60_000;
    expect(d.stampOf(Date.now() + 60_000).stamp).toMatch(/^[0-9a-f]{64}$/);
    const r = d.stampOf(loadedAt);
    expect(r.stamp).toBeUndefined();
    expect(r).toMatchObject({ why: expect.stringMatching(/changed since this code loaded/) });
  });

  it(
    "with none, the cache is off: nothing is read from it or written to it",
    async () => {
      const root = await forge();
      buildCacheHooks.stamp = null;
      await settle(root);
      expect(existsSync(join(buildCacheDirOf(root), "last-build.jsonl"))).toBe(false);
      const s0 = buildCacheStats();
      await buildAndWrite(root, { command: "atticus catalog build" });
      const s1 = buildCacheStats();
      expect(s1.memoHits).toBe(s0.memoHits);
      expect(s1.readersTrusted).toBe(s0.readersTrusted);
      expect(existsSync(buildCacheDirOf(root))).toBe(false);
    },
    T,
  );
});
