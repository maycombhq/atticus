import { mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HashEmbedder } from "@maycombhq/ai";
import { openIndex, runContextTool, type CatalogIndex } from "../src/index.js";
import { retrievalRoot } from "./helpers.js";

// ADR 0116 phase 2: similar in meaning, with the tests' hashing embedder (no model, no network).

const links = (ix: CatalogIndex) =>
  (ix.db.prepare("SELECT count(*) AS n FROM links").get() as { n: number }).n;
const vectors = (ix: CatalogIndex) =>
  (
    ix.db.prepare("SELECT count(*) AS n FROM vec.vectors WHERE kind = 'document'").get() as {
      n: number;
    }
  ).n;

describe("similar in meaning (ADR 0116)", () => {
  it("is the bundled model by default; where it isn't installed, words and names only, and it says so", async () => {
    // This checkout doesn't carry @maycombhq/embed-model: the default falls back, never fails.
    const ix = await openIndex(await retrievalRoot());
    expect(ix.meaning().on).toBe(false);
    expect(ix.meaning().note).toMatch(
      /off: the bundled model \(@maycombhq\/embed-model\) isn't installed/,
    );
    const s = await ix.select({ text: "the most a customer may send per day" }, { budget: 2000 });
    expect(s.meaning).toMatch(/off/);
    expect(s.picked.some((p) => /meaning/.test(p.via))).toBe(false);
    const root = await retrievalRoot();
    const out = await runContextTool(ix, root, "similar", { id: "ledger-db.account" });
    expect(out).toMatch(/^Similar in meaning is off/);
    ix.close();
  });

  it("a model folder without onnxruntime beside it: the open still works, by words and names, and says why", async () => {
    // ADR 0116 addendum: a bank that hasn't approved onnxruntime gets lexical search, never a
    // failed step. The tiny model folder is invented; onnxruntime isn't installed here.
    const root = await retrievalRoot();
    const model = await mkdtemp(join(tmpdir(), "atticus-model-"));
    await writeFile(
      join(model, "atticus-model.yaml"),
      [
        "schemaVersion: 1",
        "name: tiny-model",
        "dtype: fp32",
        "sha256: 2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
        "dim: 4",
        "maxTokens: 16",
        "pooling: mean",
        "licence: Apache-2.0",
        "source: invented for the tests",
        "",
      ].join("\n"),
    );
    await writeFile(join(model, "model.onnx"), "foo");
    const rt = join(root, "org-pack/runtime.yaml");
    await writeFile(
      rt,
      `${await readFile(rt, "utf8")}retrieval: { embeddings: { model: ${JSON.stringify(model)} } }\n`,
    );
    const ix = await openIndex(root);
    expect(ix.meaning().on).toBe(false);
    expect(ix.meaning().note).toMatch(/similar in meaning is off/);
    const s = await ix.select({ text: "the renamed timestamp" }, { budget: 2000 });
    expect(s.picked.length).toBeGreaterThan(0);
    expect(s.picked.some((p) => /meaning/.test(p.via))).toBe(false);
    ix.close();
  });

  it("embeds every node once, keyed by its text's hash: a reopen embeds nothing, a moved file nothing, a changed file only its own", async () => {
    const root = await retrievalRoot();
    const e = new HashEmbedder();
    let ix = await openIndex(root, { embeddings: e });
    const total = ix.meaning().total;
    expect(ix.meaning()).toMatchObject({ on: true, embedded: total, model: e.id });
    expect(e.embedded).toBe(
      new Set(
        ix.db
          .prepare("SELECT text_sha FROM node_text")
          .all()
          .map((r) => (r as { text_sha: string }).text_sha),
      ).size,
    );
    expect(vectors(ix)).toBe(e.embedded);
    ix.close();
    const before = e.embedded;
    ix = await openIndex(root, { embeddings: e });
    expect(e.embedded).toBe(before);
    ix.close();
    // Moved: the same texts under another path.
    await rename(
      join(root, "inputs/documents/settlement-runbook.docx"),
      join(root, "inputs/runbook.docx"),
    );
    ix = await openIndex(root, { embeddings: e });
    expect(e.embedded).toBe(before);
    expect(ix.meaning().on).toBe(true);
    ix.close();
    // Changed: one column's type.
    const f = join(root, "catalog/generated/column/ledger-db.account.nickname.yaml");
    await writeFile(f, (await readFile(f, "utf8")).replace("varchar(60)", "varchar(80)"));
    ix = await openIndex(root, { embeddings: e });
    expect(e.embedded).toBe(before + 1);
    ix.close();
  });

  it("stays off until every node has a vector, and says how far it is", async () => {
    const root = await retrievalRoot();
    const ix = await openIndex(root, { embeddings: new HashEmbedder(), embedOnOpen: 3 });
    const m = ix.meaning();
    expect(m.on).toBe(false);
    expect(m.embedded).toBe(3);
    expect(m.note).toMatch(
      new RegExp(`3 of ${m.total} by hash-embedder@256 \\(atticus index embed\\)`),
    );
    const s = await ix.select({ text: "renamed timestamp" }, { budget: 2000 });
    expect(s.meaning).toMatch(/3 of/);
    await ix.embed();
    expect(ix.meaning().on).toBe(true);
    ix.close();
  });

  it("ranks by meaning as one more search, said in each seed's way, and in the version; never a link, a name or a gap", async () => {
    const root = await retrievalRoot();
    const plain = await openIndex(root, { embeddings: "off" });
    const without = await plain.select(
      { text: "Send `quillfeather-risk` the account's renamed timestamp" },
      { budget: 2000 },
    );
    const linksBefore = links(plain);
    plain.close();
    const ix = await openIndex(root, { embeddings: new HashEmbedder() });
    const s = await ix.select(
      { text: "Send `quillfeather-risk` the account's renamed timestamp" },
      { budget: 2000 },
    );
    expect(s.meaning).toMatch(/^similar in meaning by hash-embedder@256/);
    expect(s.version).toBe(`${ix.version}+hash-embedder@256`);
    expect(s.picked.some((p) => /similar in meaning #\d+ \(cos 0\.\d\d\)/.test(p.via))).toBe(true);
    expect(s.unknown).toEqual(without.unknown);
    expect(s.unknown).toEqual(["quillfeather-risk"]);
    expect(links(ix)).toBe(linksBefore);
    // The same index and input select the same, from the cache too.
    const again = await ix.select(
      { text: "Send `quillfeather-risk` the account's renamed timestamp" },
      { budget: 2000 },
    );
    expect(again.cached).toBe(true);
    expect(again.picked).toEqual(s.picked);
    ix.close();
  });

  it("the tools: search by words, meaning or both, and similar to an id, said as a hint", async () => {
    const root = await retrievalRoot();
    const ix = await openIndex(root, { embeddings: new HashEmbedder() });
    const meaning = await runContextTool(ix, root, "search", {
      text: "renamed timestamp",
      by: "meaning",
      limit: 3,
    });
    expect(meaning).toMatch(/similar in meaning, cos 0\.\d\d/);
    const words = await runContextTool(ix, root, "search", {
      text: "renamed timestamp",
      by: "words",
      limit: 3,
    });
    expect(words).not.toMatch(/similar in meaning/);
    await expect(runContextTool(ix, root, "search", { text: "x", by: "sound" })).rejects.toThrow(
      /words, meaning or both/,
    );
    const near = await runContextTool(ix, root, "similar", {
      id: "ledger-db.account.closedat",
      limit: 3,
    });
    expect(near).toMatch(
      /^Nearest ledger-db.account.closedat in meaning \(a hint where to look, not a link or a fact\):/,
    );
    expect(near).not.toMatch(/Column ledger-db.account.closedat:/);
    expect(near.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(3);
    ix.close();
  });
});
