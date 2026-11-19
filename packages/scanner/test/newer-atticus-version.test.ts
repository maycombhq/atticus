import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  atticusHooks,
  BUILD_MANIFEST_READS,
  BUILD_MANIFEST_VERSION,
  BuildManifest,
  NEWER_ATTICUS_COMMAND,
  newerAtticusCommand,
  newerAtticusWords,
  newerFileAt,
  parseBuildManifest,
  refusalCommands,
} from "../src/index.js";

/**
 * ADR 0202 point 7, the read side (beta.30): a build.json a newer Atticus wrote may say which
 * Atticus that was, as its second key, `atticus`. Where it does, the refusal's command names
 * that exact version; where it doesn't, or the value isn't a version, the command is `@beta` as
 * before. Beta.30 doesn't write the field, and its own version 2 reader stays strict.
 */

const M = BUILD_MANIFEST_READS;
const N = M + 1;
const made: string[] = [];
afterAll(async () => {
  await Promise.all(made.map((d) => rm(d, { recursive: true, force: true })));
});
afterEach(() => {
  delete atticusHooks.version;
});

const REL = "catalog/sources/build.json";
async function fileOf(text: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "b30-st-newer-"));
  made.push(dir);
  const p = join(dir, "build.json");
  await writeFile(p, text);
  return p;
}
const manifest = (head: Record<string, unknown>) =>
  `${JSON.stringify({ ...head, buildVersion: "3.0.0", sources: {}, sourceSets: {}, files: [] }, null, 2)}\n`;

describe("a newer build.json that names the Atticus that wrote it (ADR 0202 point 7)", () => {
  it("gives the exact install command, in the refusal's words and its command", async () => {
    const p = await fileOf(manifest({ version: N, atticus: "2.0.0-beta.31" }));
    const files = await newerFileAt(p, REL, "build.json");
    expect(files).toEqual([
      {
        path: REL,
        name: "build.json",
        field: "version",
        version: N,
        reads: M,
        atticus: "2.0.0-beta.31",
      },
    ]);
    const command = "npm install -g @maycombhq/atticus@2.0.0-beta.31";
    expect(newerAtticusCommand(files)).toBe(command);
    expect(newerAtticusWords(files)).toBe(
      `This metarepo's catalog was built by Atticus 2.0.0-beta.31 (build.json version ${N}; this Atticus reads up to ${M}): install it (${command}), don't run \`atticus upgrade\`.`,
    );
    expect(
      refusalCommands(
        { reasons: ["newer-atticus"], message: "", newer: files },
        "atticus catalog build",
      ),
    ).toEqual([command]);
  });

  it("without the field the command is @beta and the words are beta.28.5's", async () => {
    const files = await newerFileAt(await fileOf(manifest({ version: N })), REL, "build.json");
    expect(files[0]).not.toHaveProperty("atticus");
    expect(newerAtticusCommand(files)).toBe(NEWER_ATTICUS_COMMAND);
    expect(newerAtticusWords(files)).toBe(
      `This metarepo's catalog was built by a newer Atticus (build.json version ${N}; this Atticus reads up to ${M}): upgrade Atticus (npm i -g @maycombhq/atticus@beta), don't run \`atticus upgrade\`.`,
    );
  });

  it("ignores a value that isn't a version: it would go into a command a person copies", async () => {
    for (const bad of [
      "latest",
      "2.0.0; rm -rf ~",
      "2.0.0-beta.31 && curl forge.example",
      "$(whoami)",
      "2.0",
      "",
      31,
      null,
      ["2.0.0"],
    ]) {
      const files = await newerFileAt(
        await fileOf(manifest({ version: N, atticus: bad })),
        REL,
        "build.json",
      );
      expect(files).toHaveLength(1);
      expect(files[0], JSON.stringify(bad)).not.toHaveProperty("atticus");
      expect(newerAtticusCommand(files)).toBe(NEWER_ATTICUS_COMMAND);
    }
  });

  it("ignores a version that is not newer than this Atticus, when this Atticus is known", async () => {
    const p = await fileOf(manifest({ version: N, atticus: "2.0.0-beta.31" }));
    atticusHooks.version = "2.0.0-beta.31";
    expect((await newerFileAt(p, REL, "build.json"))[0]).not.toHaveProperty("atticus");
    atticusHooks.version = "2.0.0-beta.32";
    expect((await newerFileAt(p, REL, "build.json"))[0]).not.toHaveProperty("atticus");
    atticusHooks.version = "2.0.0-beta.30";
    expect((await newerFileAt(p, REL, "build.json"))[0]!.atticus).toBe("2.0.0-beta.31");
    // A release is above its own pre-releases.
    atticusHooks.version = "2.0.0";
    expect((await newerFileAt(p, REL, "build.json"))[0]).not.toHaveProperty("atticus");
  });

  it("reads it only as the second key, inside the first bytes; elsewhere it is ignored", async () => {
    const late = `${JSON.stringify({ version: N, buildVersion: "3.0.0", atticus: "2.0.0-beta.31" }, null, 2)}\n`;
    const files = await newerFileAt(await fileOf(late), REL, "build.json");
    expect(files[0]).not.toHaveProperty("atticus");
  });

  it("a slot never takes it: only build.json says the Atticus that wrote the catalog", async () => {
    const rel = "catalog/sources/readers/forge-ledger.json";
    const p = await fileOf(`${JSON.stringify({ slotVersion: 99, atticus: "2.0.0-beta.31" })}\n`);
    const files = await newerFileAt(p, rel);
    expect(files).toHaveLength(1);
    expect(files[0]).not.toHaveProperty("atticus");
  });

  it("among several newer files, the build.json's version is the one named", () => {
    const slot = {
      path: "catalog/sources/readers/forge-ledger.json",
      name: "catalog/sources/readers/forge-ledger.json",
      field: "slotVersion",
      version: 2,
      reads: 1,
    };
    const bj = {
      path: REL,
      name: "build.json",
      field: "version",
      version: N,
      reads: M,
      atticus: "2.1.0",
    };
    expect(newerAtticusCommand([slot, bj])).toBe("npm install -g @maycombhq/atticus@2.1.0");
    expect(newerAtticusWords([slot, bj])).toContain("built by Atticus 2.1.0 (");
    expect(newerAtticusWords([slot, bj])).toContain(", and 1 more of its files)");
  });
});

describe("beta.30 doesn't write the field, and its version 2 reader stays strict", () => {
  it("build.json stays version 2", () => {
    expect(BUILD_MANIFEST_VERSION).toBe(2);
    expect(Object.keys(BuildManifest.shape)).toEqual([
      "version",
      "buildVersion",
      "sources",
      "sourceSets",
      "files",
    ]);
  });
  it("a version 2 file with the key is not read as this Atticus's own", () => {
    const r = parseBuildManifest(manifest({ version: BUILD_MANIFEST_VERSION, atticus: "2.0.0" }));
    expect(r.ok).toBe(false);
  });
});
