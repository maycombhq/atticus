import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CancelledError,
  filePoolHooks,
  writeFileAtomic,
  keepParses,
  type KeptParses,
  parseRecord,
  readFlow,
  readParsedFiles,
  readRepoSpec,
  recordCacheHooks,
  RACY_MS,
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
    // Both parsed, in whatever order the reads finish (they run at once; Windows CI saw b first).
    expect([...first.parsed].sort()).toEqual(["a.yaml", "b.yaml"]);
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

  it("with keep false, reads the parses kept and writes none (a preview, beta.28.1)", async () => {
    const root = await metarepo();
    const dir = join(root, "things");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "a.yaml"), "ok a\n");
    await writeFile(join(dir, "b.yaml"), "ok b\n");
    await read(dir, ["a.yaml", "b.yaml"], counting().parse, root);
    const [memo] = await readdir(join(root, ".atticus", "cache"));
    const kept = await readFile(join(root, ".atticus", "cache", memo!), "utf8");
    await writeFile(join(dir, "a.yaml"), "ok a changed\n");
    const look = (c: ReturnType<typeof counting>) =>
      readParsedFiles<string>({
        dir,
        files: ["a.yaml", "b.yaml"],
        name: "test",
        version: "1",
        parse: c.parse,
        cacheRoot: root,
        keep: false,
      });
    for (const _ of [1, 2]) {
      const c = counting();
      expect(await look(c)).toEqual([
        { rel: "a.yaml", value: "ok a changed" },
        { rel: "b.yaml", value: "ok b" },
      ]);
      // Only the changed file is parsed, every time: its parse isn't kept.
      expect(c.parsed).toEqual(["a.yaml"]);
    }
    expect(await readFile(join(root, ".atticus", "cache", memo!), "utf8")).toBe(kept);
    expect(await readdir(join(root, ".atticus", "cache"))).toEqual([memo]);
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

/**
 * beta.28.2: a writer that read a folder (keeping its parses) and then wrote some of its files
 * adds the parses of the texts it wrote, by each file's size and time after the write, so the
 * next read parses none of them again (a catalog's features and glossary terms are rewritten by
 * every write, and some are megabytes of YAML). A file changed after that is parsed again.
 */
describe("the parses of files a writer wrote, kept for the next read", () => {
  it("the next read parses nothing it wrote, takes what it kept, and parses a later change", async () => {
    const root = await metarepo();
    const dir = join(root, "things");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "a.yaml"), "ok a\n");
    await writeFile(join(dir, "b.yaml"), "ok b\n");
    await writeFile(join(dir, "c.yaml"), "ok c\n");
    let kept: KeptParses<string> | undefined;
    const first = counting();
    await readParsedFiles<string>({
      dir,
      files: ["a.yaml", "b.yaml", "c.yaml"],
      name: "test",
      version: "1",
      parse: first.parse,
      cacheRoot: root,
      kept: (k) => (kept = k),
    });
    expect(kept).toBeDefined();
    // The writer writes b (a new text), adds d, and removes c, each file's size and time taken
    // as it was written.
    const at: Record<string, { size: number; mtimeMs: number }> = {};
    await writeFileAtomic(join(dir, "b.yaml"), "ok b, written\n", { stat: (s) => (at.b = s) });
    await writeFileAtomic(join(dir, "d.yaml"), "no d\n", { stat: (s) => (at.d = s) });
    await rm(join(dir, "c.yaml"));
    await keepParses(kept!, {
      files: [
        { rel: "b.yaml", value: "ok b, written", at: at.b! },
        { rel: "d.yaml", problem: "not ok: no d", at: at.d! },
      ],
      removed: ["c.yaml"],
    });
    const next = counting();
    const got = await read(dir, ["a.yaml", "b.yaml", "d.yaml"], next.parse, root);
    expect(next.parsed).toEqual([]);
    expect(got).toEqual([
      { rel: "a.yaml", value: "ok a" },
      { rel: "b.yaml", value: "ok b, written" },
      { rel: "d.yaml", problem: "not ok: no d" },
    ]);
    // A change after the write (another size) is parsed again.
    await writeFile(join(dir, "b.yaml"), "ok b, changed by hand\n");
    const again = counting();
    expect((await read(dir, ["a.yaml", "b.yaml", "d.yaml"], again.parse, root))[1]).toEqual({
      rel: "b.yaml",
      value: "ok b, changed by hand",
    });
    expect(again.parsed).toEqual(["b.yaml"]);
  });

  it("a read that keeps nothing (no root, or keep: false) gives nothing to add to", async () => {
    const root = await metarepo();
    const dir = join(root, "things");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "a.yaml"), "ok a\n");
    const told: unknown[] = [];
    for (const o of [{}, { cacheRoot: root, keep: false }])
      await readParsedFiles<string>({
        dir,
        files: ["a.yaml"],
        name: "test",
        version: "1",
        parse: counting().parse,
        ...o,
        kept: (k) => told.push(k),
      });
    expect(told).toEqual([]);
    expect((await readdir(root)).sort()).toEqual(["org-pack", "things"]);
  });

  it("a file changed by hand (the same size) between its write and the keep isn't kept as written", async () => {
    // The review of beta.28.2: the parses were kept by the size and time the files had seconds
    // after the write, so a same-size edit in between was served the writer's text.
    const root = await metarepo();
    const dir = join(root, "things");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "b.yaml"), "ok a\n");
    let kept: KeptParses<string> | undefined;
    await readParsedFiles<string>({
      dir,
      files: ["b.yaml"],
      name: "test",
      version: "1",
      parse: counting().parse,
      cacheRoot: root,
      kept: (k) => (kept = k),
    });
    let at: { size: number; mtimeMs: number } | undefined;
    await writeFileAtomic(join(dir, "b.yaml"), "ok b\n", { stat: (s) => (at = s) });
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(join(dir, "b.yaml"), "ok X\n");
    await keepParses(kept!, { files: [{ rel: "b.yaml", value: "ok b", at: at! }], removed: [] });
    const next = counting();
    expect(await read(dir, ["b.yaml"], next.parse, root)).toEqual([
      { rel: "b.yaml", value: "ok X" },
    ]);
    expect(next.parsed).toEqual(["b.yaml"]);
  });

  it("a file gone or changed again before its size and time are taken isn't kept as written", async () => {
    const root = await metarepo();
    const dir = join(root, "things");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "a.yaml"), "ok a\n");
    let kept: KeptParses<string> | undefined;
    await readParsedFiles<string>({
      dir,
      files: ["a.yaml"],
      name: "test",
      version: "1",
      parse: counting().parse,
      cacheRoot: root,
      kept: (k) => (kept = k),
    });
    // The writer wrote "ok a2", then the file was written again (another size), and one it says
    // it wrote is gone.
    let at: { size: number; mtimeMs: number } | undefined;
    await writeFileAtomic(join(dir, "a.yaml"), "ok a2\n", { stat: (s) => (at = s) });
    await writeFile(join(dir, "a.yaml"), "ok a, edited meanwhile\n");
    await keepParses(kept!, {
      files: [
        { rel: "a.yaml", value: "ok a2", at: at! },
        { rel: "gone.yaml", value: "ok gone", at: at! },
      ],
      removed: [],
    });
    const next = counting();
    expect(await read(dir, ["a.yaml"], next.parse, root)).toEqual([
      { rel: "a.yaml", value: "ok a, edited meanwhile" },
    ]);
    expect(next.parsed).toEqual(["a.yaml"]);
  });
});

/**
 * The final review of beta.28.2: on a file system whose times are coarse (FAT 2 s, HFS+ 1 s, some
 * SMB and NFS mounts) a same-size edit made soon after a file was read or written keeps the same
 * time, so a parse kept by size and time alone served the old text. As Git's "racily clean" rule:
 * a parse kept of a file whose time was within `RACY_MS` of the moment it was kept is reused only
 * when the file's bytes still hash to the ones parsed; an older one is trusted by size and time.
 */
describe("a file kept within the timestamp's grain is checked by its hash", () => {
  const mine: string[] = [];
  afterEach(async () => {
    delete recordCacheHooks.now;
    await Promise.all(mine.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });
  const root = async () => {
    const r = await metarepo();
    mine.push(r);
    const dir = join(r, "things");
    await mkdir(dir, { recursive: true });
    return { root: r, dir };
  };
  /** Rewrite a file with a text of the same size and put its time back, as a coarse clock would. */
  const sameSizeSameTime = async (file: string, text: string) => {
    const s = await stat(file);
    await writeFile(file, text);
    await utimes(file, s.atimeMs / 1000, s.mtimeMs / 1000);
    const now = await stat(file);
    expect([now.size, Math.floor(now.mtimeMs)]).toEqual([s.size, Math.floor(s.mtimeMs)]);
  };

  it("the grain is 2 s", () => {
    expect(RACY_MS).toBe(2000);
  });

  it("a same-size edit with the same time, soon after a read, is parsed again", async () => {
    const { root: r, dir } = await root();
    await writeFile(join(dir, "a.yaml"), "ok a\n");
    await writeFile(join(dir, "b.yaml"), "ok b\n");
    await read(dir, ["a.yaml", "b.yaml"], counting().parse, r);
    await sameSizeSameTime(join(dir, "a.yaml"), "ok X\n");
    const next = counting();
    expect(await read(dir, ["a.yaml", "b.yaml"], next.parse, r)).toEqual([
      { rel: "a.yaml", value: "ok X" },
      { rel: "b.yaml", value: "ok b" },
    ]);
    // b's bytes still hash the same: it isn't parsed again.
    expect(next.parsed).toEqual(["a.yaml"]);
  });

  it("a same-size edit with the same time, soon after a writer kept its parse, is parsed again", async () => {
    const { root: r, dir } = await root();
    await writeFile(join(dir, "b.yaml"), "ok a\n");
    let kept: KeptParses<string> | undefined;
    await readParsedFiles<string>({
      dir,
      files: ["b.yaml"],
      name: "test",
      version: "1",
      parse: counting().parse,
      cacheRoot: r,
      kept: (k) => (kept = k),
    });
    let at: { size: number; mtimeMs: number } | undefined;
    await writeFileAtomic(join(dir, "b.yaml"), "ok b\n", { stat: (s) => (at = s) });
    await keepParses(kept!, { files: [{ rel: "b.yaml", value: "ok b", at: at! }], removed: [] });
    // Unchanged: the kept parse is taken (its hash matches), nothing is parsed.
    const same = counting();
    expect(await read(dir, ["b.yaml"], same.parse, r)).toEqual([{ rel: "b.yaml", value: "ok b" }]);
    expect(same.parsed).toEqual([]);
    await sameSizeSameTime(join(dir, "b.yaml"), "ok X\n");
    const next = counting();
    expect(await read(dir, ["b.yaml"], next.parse, r)).toEqual([{ rel: "b.yaml", value: "ok X" }]);
    expect(next.parsed).toEqual(["b.yaml"]);
  });

  it("a writer's stat with no hash (an older caller) keeps nothing that can be trusted while racy", async () => {
    const { root: r, dir } = await root();
    await writeFile(join(dir, "b.yaml"), "ok a\n");
    let kept: KeptParses<string> | undefined;
    await readParsedFiles<string>({
      dir,
      files: ["b.yaml"],
      name: "test",
      version: "1",
      parse: counting().parse,
      cacheRoot: r,
      kept: (k) => (kept = k),
    });
    let at: { size: number; mtimeMs: number } | undefined;
    await writeFileAtomic(join(dir, "b.yaml"), "ok b\n", {
      stat: (s) => (at = { size: s.size, mtimeMs: s.mtimeMs }),
    });
    await keepParses(kept!, { files: [{ rel: "b.yaml", value: "ok b", at: at! }], removed: [] });
    await sameSizeSameTime(join(dir, "b.yaml"), "ok X\n");
    expect(await read(dir, ["b.yaml"], counting().parse, r)).toEqual([
      { rel: "b.yaml", value: "ok X" },
    ]);
  });

  it("a file whose time was well before it was kept is trusted by its size and time (no hash)", async () => {
    const { root: r, dir } = await root();
    const old = new Date("2026-01-01T00:00:00Z");
    await writeFile(join(dir, "a.yaml"), "ok a\n");
    await utimes(join(dir, "a.yaml"), old, old);
    await read(dir, ["a.yaml"], counting().parse, r);
    // Not something a real clock allows (an edit now has a time of now): it shows the stat alone
    // decides, as before, so an unchanged estate costs one stat a file.
    await sameSizeSameTime(join(dir, "a.yaml"), "ok X\n");
    const next = counting();
    expect(await read(dir, ["a.yaml"], next.parse, r)).toEqual([{ rel: "a.yaml", value: "ok a" }]);
    expect(next.parsed).toEqual([]);
  });

  it("a racy parse whose hash matches is kept again as of now, and once past the grain the stat decides", async () => {
    const { root: r, dir } = await root();
    await writeFile(join(dir, "a.yaml"), "ok a\n");
    await read(dir, ["a.yaml"], counting().parse, r);
    const memoOf = async () => {
      const [f] = await readdir(join(r, ".atticus", "cache"));
      return JSON.parse(await readFile(join(r, ".atticus", "cache", f!), "utf8")) as {
        entries: Record<string, { sha?: string; at?: number }>;
      };
    };
    expect((await memoOf()).entries["a.yaml"]!.sha).toMatch(/^[0-9a-f]{64}$/);
    // A read straight after: checked by its hash, still racy, so the cache isn't written again.
    const [f] = await readdir(join(r, ".atticus", "cache"));
    const bytes = await readFile(join(r, ".atticus", "cache", f!));
    const straight = counting();
    expect(await read(dir, ["a.yaml"], straight.parse, r)).toEqual([
      { rel: "a.yaml", value: "ok a" },
    ]);
    expect(straight.parsed).toEqual([]);
    expect((await readFile(join(r, ".atticus", "cache", f!))).equals(bytes)).toBe(true);
    // The next command, a few seconds on.
    const later = Date.now() + 5_000;
    recordCacheHooks.now = () => later;
    const next = counting();
    expect(await read(dir, ["a.yaml"], next.parse, r)).toEqual([{ rel: "a.yaml", value: "ok a" }]);
    expect(next.parsed).toEqual([]);
    const e = (await memoOf()).entries["a.yaml"]!;
    expect(e.at).toBe(later);
    // No longer racy: its hash isn't kept, and the stat alone decides from now on.
    expect(e.sha).toBeUndefined();
  });
});

/**
 * Beta.28.3: Stop during a first read of a large folder. Nothing was heard until every file was
 * read and parsed; with the job's signal the read ends part way (while the sizes and times are
 * read, or between two lots of files parsed) with CancelledError, and keeps nothing: the next
 * read parses every file, as a first one does.
 */
describe("a first read of many files, stopped part way (beta.28.3)", () => {
  const MANY = 6_000;
  async function many() {
    const root = await metarepo();
    const dir = join(root, "things");
    await mkdir(dir, { recursive: true });
    const files = Array.from({ length: MANY }, (_, i) => `forge-${i}.yaml`);
    for (let i = 0; i < files.length; i += 200)
      await Promise.all(files.slice(i, i + 200).map((f) => writeFile(join(dir, f), `ok ${f}\n`)));
    return { root, dir, files };
  }
  afterEach(() => {
    delete filePoolHooks.onRead;
    delete filePoolHooks.workers;
  });

  it("a Stop while the files are parsed ends the read, most files unparsed, and nothing is kept", async () => {
    const { root, dir, files } = await many();
    const stop = new AbortController();
    const c = counting();
    let at = 0;
    const parse = (text: string, rel: string) => {
      if (c.parsed.length === 500) {
        at = Date.now();
        stop.abort();
      }
      return c.parse(text, rel);
    };
    await expect(
      readParsedFiles<string>({
        dir,
        files,
        name: "test",
        version: "1",
        parse,
        cacheRoot: root,
        signal: stop.signal,
      }),
    ).rejects.toBeInstanceOf(CancelledError);
    expect(Date.now() - at).toBeLessThan(1_000);
    expect(c.parsed.length).toBeLessThan(1_000);
    // Nothing kept of the stopped read: no cache file, and the next read parses every file.
    expect(await readdir(join(root, ".atticus", "cache")).catch(() => [])).toEqual([]);
    const next = counting();
    const all = await read(dir, files, next.parse, root);
    expect(next.parsed).toHaveLength(MANY);
    expect(all).toHaveLength(MANY);
  }, 120_000);

  for (const workers of [0, 2])
    it(`a Stop while the sizes and times are read (${workers ? "workers" : "this thread"}) ends the read before any file is parsed`, async () => {
      const { root, dir, files } = await many();
      filePoolHooks.workers = workers;
      const stop = new AbortController();
      filePoolHooks.onRead = (n) => {
        if (n >= 256) stop.abort();
      };
      const c = counting();
      await expect(
        readParsedFiles<string>({
          dir,
          files,
          name: "test",
          version: "1",
          parse: c.parse,
          cacheRoot: root,
          signal: stop.signal,
        }),
      ).rejects.toBeInstanceOf(CancelledError);
      expect(c.parsed).toEqual([]);
      expect(await readdir(join(root, ".atticus", "cache")).catch(() => [])).toEqual([]);
    }, 120_000);
});
