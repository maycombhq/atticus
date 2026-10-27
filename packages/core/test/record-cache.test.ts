import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseRecord,
  readFlow,
  readParsedFiles,
  readRepoSpec,
  serializeRecord,
  specFlowFiles,
} from "../src/index.js";
import { EXAMPLES } from "./examples.js";

/**
 * Parses kept between runs (record-cache.ts): a file whose size and time haven't changed isn't
 * parsed again, a changed file is, and the cache is kept under the root the caller names and
 * nowhere else (ADR 0119 addendum: a read that names no root writes nothing). The flows a
 * command asks for by id are read one at a time, from the file names alone.
 */

async function metarepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-cache-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  return root;
}

/** Count the parses a read did, so a kept parse can be told from a fresh one. */
function counting() {
  const parsed: string[] = [];
  return {
    parsed,
    parse: (text: string, rel: string) => {
      parsed.push(rel);
      return text.startsWith("ok")
        ? ({ ok: true, value: text.trim() } as const)
        : ({ ok: false, message: `not ok: ${text.trim()}` } as const);
    },
  };
}

const read = (
  dir: string,
  files: string[],
  parse: ReturnType<typeof counting>["parse"],
  cacheRoot?: string,
) => readParsedFiles<string>({ dir, files, name: "test", version: "1", parse, cacheRoot });

describe("parses kept between runs", () => {
  it("reads every file the first time and none of them the second", async () => {
    const root = await metarepo();
    const dir = join(root, "things");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "a.yaml"), "ok a\n");
    await writeFile(join(dir, "b.yaml"), "no b\n");
    const first = counting();
    const one = await read(dir, ["a.yaml", "b.yaml"], first.parse, root);
    expect(first.parsed).toEqual(["a.yaml", "b.yaml"]);
    expect(one).toEqual([
      { rel: "a.yaml", value: "ok a" },
      { rel: "b.yaml", problem: "not ok: no b" },
    ]);
    const second = counting();
    const two = await read(dir, ["a.yaml", "b.yaml"], second.parse, root);
    expect(second.parsed).toEqual([]);
    expect(two).toEqual(one);
    // The cache is Atticus's own, on this machine only, and Git ignores it.
    expect((await readdir(join(root, ".atticus", "cache"))).length).toBe(1);
    expect(await readFile(join(root, ".atticus", ".gitignore"), "utf8")).toContain("cache/");
  });

  it("reads a file again once it changes, and only that one", async () => {
    const root = await metarepo();
    const dir = join(root, "things");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "a.yaml"), "ok a\n");
    await writeFile(join(dir, "b.yaml"), "ok b\n");
    await read(dir, ["a.yaml", "b.yaml"], counting().parse, root);
    await writeFile(join(dir, "a.yaml"), "ok a changed\n");
    const again = counting();
    const out = await read(dir, ["a.yaml", "b.yaml"], again.parse, root);
    expect(again.parsed).toEqual(["a.yaml"]);
    expect(out[0]).toEqual({ rel: "a.yaml", value: "ok a changed" });
    expect(out[1]).toEqual({ rel: "b.yaml", value: "ok b" });
  });

  it("writes nothing, and keeps nothing, when the caller names no root", async () => {
    // A read of someone else's metarepo: Atticus was asked to read it, so it writes nothing
    // into it, not even a cache of its own (ADR 0119 addendum, hard rule 6).
    const root = await metarepo();
    const dir = join(root, "things");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "a.yaml"), "ok a\n");
    for (const _ of [1, 2]) {
      const c = counting();
      expect(await read(dir, ["a.yaml"], c.parse)).toEqual([{ rel: "a.yaml", value: "ok a" }]);
      expect(c.parsed).toEqual(["a.yaml"]);
    }
    expect(await readdir(root)).toEqual(["org-pack", "things"]);
  });

  it("keeps the parses under the root it is given, and never under the folder's own", async () => {
    // The root is the one the command is working in, not the one the files happen to sit in:
    // ours, reading a folder we copied from theirs, keeps its cache in ours.
    const ours = await metarepo();
    const theirs = await metarepo();
    const dir = join(theirs, "things");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "a.yaml"), "ok a\n");
    const first = counting();
    await read(dir, ["a.yaml"], first.parse, ours);
    expect(first.parsed).toEqual(["a.yaml"]);
    expect(await readdir(theirs)).toEqual(["org-pack", "things"]);
    expect(await readdir(join(ours, ".atticus", "cache"))).toHaveLength(1);
    // And it is read back from there, so naming a root outside the files still keeps the speed.
    const again = counting();
    await read(dir, ["a.yaml"], again.parse, ours);
    expect(again.parsed).toEqual([]);
  });

  it("outside a metarepo, keeps the parses under the root it is given", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atticus-nocache-"));
    await writeFile(join(dir, "a.yaml"), "ok a\n");
    const c = counting();
    await read(dir, ["a.yaml"], c.parse);
    expect(c.parsed).toEqual(["a.yaml"]);
    expect(await readdir(dir)).toEqual(["a.yaml"]);
  });

  it("reads the files again when the cache file isn't one it wrote", async () => {
    const root = await metarepo();
    const dir = join(root, "things");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "a.yaml"), "ok a\n");
    await read(dir, ["a.yaml"], counting().parse, root);
    const cache = join(root, ".atticus", "cache");
    const name = (await readdir(cache))[0]!;
    await writeFile(join(cache, name), "not json at all");
    const again = counting();
    expect(await read(dir, ["a.yaml"], again.parse, root)).toEqual([
      { rel: "a.yaml", value: "ok a" },
    ]);
    expect(again.parsed).toEqual(["a.yaml"]);
  });
});

describe("a repo's flows read one at a time", () => {
  /** A metarepo with two flows in one repo's spec, and a file that isn't a flow at all. */
  async function withFlows(): Promise<string> {
    const root = await metarepo();
    const dir = join(root, "specs", "forge-notes");
    await mkdir(dir, { recursive: true });
    for (const id of ["forge-notes.get-note", "forge-notes.save-note"]) {
      const r = parseRecord({ ...EXAMPLES.Flow, id, component: "forge-notes" });
      if (!r.ok) throw new Error(JSON.stringify(r.issues));
      await writeFile(join(dir, `${id}.yaml`), serializeRecord(r.record), "utf8");
    }
    await writeFile(join(dir, "forge-notes.broken.yaml"), "kind: Flow\nid: nope\n");
    return root;
  }

  it("indexes the flow files by id without reading one", async () => {
    const root = await withFlows();
    const files = await specFlowFiles(root);
    expect([...files.keys()].sort()).toEqual([
      "forge-notes.broken",
      "forge-notes.get-note",
      "forge-notes.save-note",
    ]);
    expect(files.get("forge-notes.get-note")!.repo).toBe("forge-notes");
  });

  it("reads one flow by id, and nothing for a file that isn't that flow", async () => {
    const root = await withFlows();
    expect((await readFlow(root, "forge-notes", "forge-notes.get-note"))?.id).toBe(
      "forge-notes.get-note",
    );
    expect(await readFlow(root, "forge-notes", "forge-notes.broken")).toBeUndefined();
    expect(await readFlow(root, "forge-notes", "forge-notes.missing")).toBeUndefined();
  });

  it("gives the same flows and problems as reading the whole spec", async () => {
    const root = await withFlows();
    const spec = await readRepoSpec(root, "forge-notes", { cacheRoot: root });
    expect(spec.flows.map((f) => f.id)).toEqual(["forge-notes.get-note", "forge-notes.save-note"]);
    expect(spec.problems.map((p) => p.file)).toEqual(["specs/forge-notes/forge-notes.broken.yaml"]);
    // Read again from the kept parses: the same answer, to the letter.
    expect(await readRepoSpec(root, "forge-notes", { cacheRoot: root })).toEqual(spec);
    await rm(join(root, ".atticus"), { recursive: true, force: true });
    expect(await readRepoSpec(root, "forge-notes", { cacheRoot: root })).toEqual(spec);
  });

  it("reads a spec with no cache root at all, and writes nothing into it", async () => {
    // Their estate, read-only: the same flows, and not a file left behind (hard rule 6).
    const root = await withFlows();
    const spec = await readRepoSpec(root, "forge-notes", { cacheRoot: root });
    await rm(join(root, ".atticus"), { recursive: true, force: true });
    expect(await readRepoSpec(root, "forge-notes")).toEqual(spec);
    expect(await readRepoSpec(root, "forge-notes")).toEqual(spec);
    expect((await readdir(root)).sort()).toEqual(["org-pack", "specs"]);
  });
});
