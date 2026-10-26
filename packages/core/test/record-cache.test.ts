import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  metarepoRootOf,
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
 * parsed again, a changed file is, and a folder outside a metarepo keeps nothing. The flows a
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

const read = (dir: string, files: string[], parse: ReturnType<typeof counting>["parse"]) =>
  readParsedFiles<string>({ dir, files, name: "test", version: "1", parse });

describe("parses kept between runs", () => {
  it("reads every file the first time and none of them the second", async () => {
    const root = await metarepo();
    const dir = join(root, "things");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "a.yaml"), "ok a\n");
    await writeFile(join(dir, "b.yaml"), "no b\n");
    const first = counting();
    const one = await read(dir, ["a.yaml", "b.yaml"], first.parse);
    expect(first.parsed).toEqual(["a.yaml", "b.yaml"]);
    expect(one).toEqual([
      { rel: "a.yaml", value: "ok a" },
      { rel: "b.yaml", problem: "not ok: no b" },
    ]);
    const second = counting();
    const two = await read(dir, ["a.yaml", "b.yaml"], second.parse);
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
    await read(dir, ["a.yaml", "b.yaml"], counting().parse);
    await writeFile(join(dir, "a.yaml"), "ok a changed\n");
    const again = counting();
    const out = await read(dir, ["a.yaml", "b.yaml"], again.parse);
    expect(again.parsed).toEqual(["a.yaml"]);
    expect(out[0]).toEqual({ rel: "a.yaml", value: "ok a changed" });
    expect(out[1]).toEqual({ rel: "b.yaml", value: "ok b" });
  });

  it("parses every time outside a metarepo, and keeps nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atticus-nocache-"));
    await writeFile(join(dir, "a.yaml"), "ok a\n");
    expect(metarepoRootOf(dir)).toBeUndefined();
    for (const _ of [1, 2]) {
      const c = counting();
      await read(dir, ["a.yaml"], c.parse);
      expect(c.parsed).toEqual(["a.yaml"]);
    }
    expect(await readdir(dir)).toEqual(["a.yaml"]);
  });

  it("reads the files again when the cache file isn't one it wrote", async () => {
    const root = await metarepo();
    const dir = join(root, "things");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "a.yaml"), "ok a\n");
    await read(dir, ["a.yaml"], counting().parse);
    const cache = join(root, ".atticus", "cache");
    const name = (await readdir(cache))[0]!;
    await writeFile(join(cache, name), "not json at all");
    const again = counting();
    expect(await read(dir, ["a.yaml"], again.parse)).toEqual([{ rel: "a.yaml", value: "ok a" }]);
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
    const spec = await readRepoSpec(root, "forge-notes");
    expect(spec.flows.map((f) => f.id)).toEqual(["forge-notes.get-note", "forge-notes.save-note"]);
    expect(spec.problems.map((p) => p.file)).toEqual(["specs/forge-notes/forge-notes.broken.yaml"]);
    // Read again from the kept parses: the same answer, to the letter.
    expect(await readRepoSpec(root, "forge-notes")).toEqual(spec);
    await rm(join(root, ".atticus"), { recursive: true, force: true });
    expect(await readRepoSpec(root, "forge-notes")).toEqual(spec);
  });
});
