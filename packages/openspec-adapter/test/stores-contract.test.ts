/**
 * Contract tests for OpenSpec stores (beta, ADR 0126): the pinned OpenSpec CLI accepts the
 * store.yaml Atticus writes and the references: entry hand-down adds. The machine's store
 * registry is a temporary folder (XDG_DATA_HOME), so nothing outside the test is touched. If a
 * later OpenSpec changes the store format, these tests are where it shows.
 */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  addStoreReference,
  bundledOpenSpecBin,
  createOpenSpec,
  extractJson,
  openspecEnv,
  openspecHasStores,
  writeStoreMarker,
} from "../src/index.js";

const T = 60_000;

function openspec(
  args: string[],
  cwd: string,
  dataHome: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((done) => {
    execFile(
      process.execPath,
      [bundledOpenSpecBin(), ...args],
      { cwd, env: { ...openspecEnv(), XDG_DATA_HOME: dataHome }, encoding: "utf8" },
      (err, stdout, stderr) =>
        done({ stdout, stderr, code: err ? (typeof err.code === "number" ? err.code : 1) : 0 }),
    );
  });
}

describe("OpenSpec stores contract (beta)", () => {
  it(
    "the pinned OpenSpec has stores",
    async () => {
      expect(await openspecHasStores()).toBe(true);
    },
    T,
  );

  it(
    "registers a metarepo Atticus marked as a store, under the id Atticus wrote",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "atticus-store-meta-"));
      const data = await mkdtemp(join(tmpdir(), "atticus-store-data-"));
      await createOpenSpec({ root, timeoutMs: T }).init();
      await writeStoreMarker(root, {
        id: "forge",
        remote: "https://code.forge.example/forge/forge-meta.git",
      });
      const reg = await openspec(["store", "register", root, "--json"], root, data);
      expect(reg.code, reg.stderr).toBe(0);
      expect((extractJson(reg.stdout) as { store: { id: string } }).store.id).toBe("forge");
      const doc = await openspec(["store", "doctor", "forge", "--json"], root, data);
      expect(doc.code, doc.stderr).toBe(0);
      const s = (
        extractJson(doc.stdout) as {
          stores: { metadata: { valid: boolean; id: string; remote: string | null } }[];
        }
      ).stores[0]!;
      expect(s.metadata).toMatchObject({
        valid: true,
        id: "forge",
        remote: "https://code.forge.example/forge/forge-meta.git",
      });
      // Plain OpenSpec run elsewhere sees the metarepo's changes through the store.
      const away = await mkdtemp(join(tmpdir(), "atticus-store-away-"));
      const list = await openspec(["list", "--json", "--store", "forge"], away, data);
      expect(list.code, list.stderr).toBe(0);
      expect((extractJson(list.stdout) as { root: { store_id: string } }).root.store_id).toBe(
        "forge",
      );
    },
    T,
  );

  it(
    "reads the references: entry hand-down adds without a warning",
    async () => {
      const repo = await mkdtemp(join(tmpdir(), "atticus-store-repo-"));
      const data = await mkdtemp(join(tmpdir(), "atticus-store-data-"));
      await createOpenSpec({ root: repo, timeoutMs: T }).init();
      await mkdir(join(repo, "openspec", "changes"), { recursive: true });
      const file = join(repo, "openspec", "config.yaml");
      const r = addStoreReference(await readFile(file, "utf8"), {
        id: "forge",
        remote: "https://code.forge.example/forge/forge-meta.git",
      });
      if (!("text" in r)) throw new Error(r.problem);
      await writeFile(file, r.text, "utf8");
      const list = await openspec(["list", "--json"], repo, data);
      expect(list.code, list.stderr).toBe(0);
      expect(list.stderr).not.toMatch(/references/i);
    },
    T,
  );
});
