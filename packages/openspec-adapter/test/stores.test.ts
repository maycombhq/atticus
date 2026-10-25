/**
 * OpenSpec stores (beta, ADR 0126): the store.yaml shape, the references editor and the
 * read-only store reader, against the Forge fixtures in fixtures/openspec-stores. No OpenSpec
 * run here: stores-contract.test.ts runs the pinned CLI.
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  addStoreReference,
  parseStoreMarker,
  purposeLine,
  readStore,
  readStoreMarker,
  STORE_MARKER,
  storeIdOf,
  storeMarkerText,
  writeStoreMarker,
} from "../src/index.js";

const FX = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/openspec-stores");
const fx = (rel: string) => readFile(join(FX, rel), "utf8");

describe("store.yaml (the shape OpenSpec 1.14.0 reads)", () => {
  it("is version 1, the id and, when known, the remote: nothing else", () => {
    expect(STORE_MARKER).toBe(".openspec-store/store.yaml");
    expect(storeMarkerText({ id: "forge" })).toBe("version: 1\nid: forge\n");
    expect(
      parse(
        storeMarkerText({ id: "forge", remote: "https://code.forge.example/forge/forge-meta.git" }),
      ),
    ).toEqual({
      version: 1,
      id: "forge",
      remote: "https://code.forge.example/forge/forge-meta.git",
    });
  });

  it("refuses an id OpenSpec would refuse", () => {
    expect(() => storeMarkerText({ id: "Forge_Meta" })).toThrow(/kebab-case/);
  });

  it("turns an org pack name into a store id OpenSpec accepts", () => {
    expect(storeIdOf("forge")).toBe("forge");
    expect(storeIdOf("forge.platform_meta")).toBe("forge-platform-meta");
    expect(storeIdOf("forge--meta.")).toBe("forge-meta");
    expect(storeIdOf("...")).toBeUndefined();
  });

  it("reads a store's own store.yaml", async () => {
    const r = parseStoreMarker(await fx("forge-payments-store/.openspec-store/store.yaml"));
    expect(r).toEqual({
      marker: {
        id: "forge-payments",
        remote: "https://code.forge.example/forge/forge-payments-store.git",
      },
      notes: [],
    });
  });

  it("reads the id of a later format it doesn't know, and says so (the format is beta)", async () => {
    const r = parseStoreMarker(await fx("future-store/.openspec-store/store.yaml"));
    expect(r.marker).toEqual({
      id: "forge-statements",
      remote: "https://code.forge.example/forge/forge-statements-store.git",
    });
    expect(r.notes).toEqual([
      "store.yaml is version 2, newer than the version 1 Atticus knows; read its id and remote only (the store format is beta)",
    ]);
  });

  it("says what is wrong with one it can't read, and never throws", () => {
    expect(parseStoreMarker("version: 1\n").marker).toBeUndefined();
    expect(parseStoreMarker("version: 1\n").notes).toEqual(["store.yaml has no id"]);
    expect(parseStoreMarker(": : :\n  - [").notes[0]).toMatch(/^store\.yaml isn't YAML/);
  });

  it("writes store.yaml once and never replaces one that is there", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atticus-store-"));
    expect(await readStoreMarker(dir)).toEqual({ missing: true, notes: [] });
    expect(await writeStoreMarker(dir, { id: "forge" })).toEqual({
      action: "created",
      marker: { id: "forge" },
    });
    expect(await readFile(join(dir, ".openspec-store", "store.yaml"), "utf8")).toBe(
      "version: 1\nid: forge\n",
    );
    expect(await writeStoreMarker(dir, { id: "forge" })).toEqual({
      action: "present",
      marker: { id: "forge" },
    });
    expect(await writeStoreMarker(dir, { id: "forge-meta" })).toEqual({
      action: "differs",
      marker: { id: "forge" },
    });
    expect(await readFile(join(dir, ".openspec-store", "store.yaml"), "utf8")).toBe(
      "version: 1\nid: forge\n",
    );
  });
});

describe("references: in a code repo's openspec/config.yaml", () => {
  it("adds the metarepo with its remote, keeping comments, order and every other key", async () => {
    const r = addStoreReference(await fx("forge-ledger/openspec/config.yaml"), {
      id: "forge",
      remote: "https://code.forge.example/forge/forge-meta.git",
    });
    expect(r).toEqual({
      action: "added",
      text: await fx("references/forge-ledger-expected.yaml"),
    });
  });

  it("starts the list when there is none, as a plain id when there is no remote", async () => {
    const r = addStoreReference(await fx("references/no-references.yaml"), { id: "forge" });
    expect(r).toEqual({
      action: "added",
      text: await fx("references/no-references-expected.yaml"),
    });
  });

  it("leaves a reference that is there as it is, plain or with a remote", async () => {
    const text = await fx("forge-ledger/openspec/config.yaml");
    expect(
      addStoreReference(text, { id: "forge-payments", remote: "https://x.example/a.git" }),
    ).toEqual({
      action: "present",
      text,
    });
    expect(addStoreReference(text, { id: "forge-statements" })).toEqual({
      action: "present",
      text,
    });
  });

  it("changes nothing in a file it can't edit safely", () => {
    expect(addStoreReference("references: forge-payments\n", { id: "forge" })).toEqual({
      problem: "references: in openspec/config.yaml isn't a list; left as it is",
    });
    expect(addStoreReference("- a\n- b\n", { id: "forge" })).toEqual({
      problem: "openspec/config.yaml isn't a mapping; left as it is",
    });
    expect(addStoreReference("schema: [\n", { id: "forge" })).toMatchObject({
      problem: expect.stringMatching(/^openspec\/config\.yaml isn't YAML/),
    });
  });
});

describe("reading a store (read-only)", () => {
  it("lists its open changes and its specs, with the id from store.yaml", async () => {
    const v = await readStore(join(FX, "forge-payments-store"));
    expect(v.id).toBe("forge-payments");
    expect(v.remote).toBe("https://code.forge.example/forge/forge-payments-store.git");
    expect(v.notes).toEqual([]);
    expect(v.changes).toEqual([
      {
        id: "add-refund-window",
        title: "Add a refund window",
        tasks: { done: 1, total: 2 },
        dir: join(FX, "forge-payments-store", "openspec", "changes", "add-refund-window"),
      },
    ]);
    expect(v.specs).toEqual([
      {
        id: "ledger-postings",
        purpose: "Every Forge transfer posts a debit and a credit to the ledger.",
        file: join(FX, "forge-payments-store", "openspec", "specs", "ledger-postings", "spec.md"),
      },
      {
        id: "refunds",
        purpose: "Refunds of settled Forge transfers, back to the account that paid.",
        file: join(FX, "forge-payments-store", "openspec", "specs", "refunds", "spec.md"),
      },
    ]);
  });

  it("reads a folder with no store.yaml, and one with a newer store.yaml, each with a note", async () => {
    const plain = await readStore(join(FX, "unmarked-store"));
    expect(plain.id).toBeUndefined();
    expect(plain.notes).toEqual(["no .openspec-store/store.yaml: read as a plain OpenSpec folder"]);
    expect(plain.changes.map((c) => [c.id, c.title])).toEqual([["rename-fee-codes", undefined]]);
    const future = await readStore(join(FX, "future-store"));
    expect(future.id).toBe("forge-statements");
    expect(future.notes[0]).toMatch(/version 2, newer than the version 1/);
    expect(future.specs.map((s) => s.id)).toEqual(["statements"]);
  });

  it("says when the folder isn't there or holds no openspec/", async () => {
    const gone = await readStore(join(FX, "no-such-store"));
    expect(gone.notes).toEqual([`${join(FX, "no-such-store")} isn't there`]);
    expect(gone.changes).toEqual([]);
    const empty = await readStore(join(FX, "references"));
    expect(empty.notes).toContain("no openspec/ folder: nothing to read");
  });

  it("never writes into the store", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atticus-store-ro-"));
    await writeFile(join(dir, "README.md"), "x\n");
    await readStore(dir);
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(dir)).toEqual(["README.md"]);
  });

  it("takes the first Purpose line, outside code blocks and with closing hashes", () => {
    expect(purposeLine("# x\n\n## Purpose ##\n\n```\n## Purpose\nno\n```\n\nYes.\n")).toBe("Yes.");
    expect(purposeLine("# x\n\n## Requirements\n")).toBeUndefined();
  });
});
