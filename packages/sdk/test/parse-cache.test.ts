import { describe, expect, it } from "vitest";
import {
  createParseCache,
  deepFreeze,
  defineExtractor,
  memoryRepo,
  scanRepo,
  withParseCache,
  type ParseCache,
  type RepoHandle,
} from "../src/index.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";

/** A parser that counts its calls. */
function counting<T>(make: (text: string) => T) {
  const calls: string[] = [];
  return {
    calls,
    parse: (text: string) => {
      calls.push(text);
      return make(text);
    },
  };
}

describe("parse cache", () => {
  it("parses a file once per path and content, and again when either changes", () => {
    const cache = createParseCache();
    const p = counting((t) => ({ length: t.length }));
    expect(cache.get("json", "a.json", "{}", p.parse)).toEqual({ length: 2 });
    expect(cache.get("json", "a.json", "{}", p.parse)).toEqual({ length: 2 });
    // Same text read again into a different string object: still a hit.
    expect(cache.get("json", "a.json", ["{", "}"].join(""), p.parse)).toEqual({ length: 2 });
    expect(p.calls).toEqual(["{}"]);
    // New content at the same path (a rendered template, a changed file): parsed again.
    cache.get("json", "a.json", "{ }", p.parse);
    // Another file with the same content, or another reader's kind: separate entries.
    cache.get("json", "b.json", "{}", p.parse);
    cache.get("yaml", "a.json", "{}", p.parse);
    expect(p.calls).toEqual(["{}", "{ }", "{}", "{}"]);
    expect(cache.stats()).toMatchObject({ hits: 2, misses: 4 });
  });

  it("hands every reader a frozen value, so one reader can't change what another reads", () => {
    const cache = createParseCache();
    const parse = () => ({
      kind: "Deployment",
      spec: { replicas: 2, ports: [{ port: 8080 }] },
      labels: new Map([["app", { name: "forge-ledger" }]]),
      tags: new Set(["a"]),
      bytes: new Int32Array([1, 2]),
    });
    const first = cache.get("yaml", "deploy.yaml", "x", parse);
    // A careless reader tries to change what it was given.
    const attempts = [
      () => ((first as { kind: string }).kind = "Job"),
      () => ((first.spec as { replicas: number }).replicas = 9),
      () => (first.spec.ports as { port: number }[]).push({ port: 1 }),
      () => ((first.spec.ports[0] as { port: number }).port = 1),
      () => first.labels.set("app", { name: "other" }),
      () => first.labels.delete("app"),
      () => first.labels.clear(),
      () => ((first.labels.get("app") as { name: string }).name = "other"),
      () => first.tags.add("b"),
      () => first.tags.delete("a"),
      () => delete (first as { kind?: string }).kind,
    ];
    for (const a of attempts) expect(a).toThrow(TypeError);
    // The next reader sees what the parser made.
    const second = cache.get("yaml", "deploy.yaml", "x", parse);
    expect(second).toBe(first);
    expect(second.kind).toBe("Deployment");
    expect(second.spec).toEqual({ replicas: 2, ports: [{ port: 8080 }] });
    expect([...second.labels]).toEqual([["app", { name: "forge-ledger" }]]);
    expect([...second.tags]).toEqual(["a"]);
    // Typed arrays can't be frozen; they are left as they are (readers treat them as read-only).
    expect([...second.bytes]).toEqual([1, 2]);
  });

  it("freezes class instances and their maps, but not functions or shared prototypes", () => {
    class Doc {
      readonly items: { k: string }[] = [{ k: "a" }];
      readonly index = new Map<string, number>([["a", 0]]);
      find(k: string) {
        return this.items.find((i) => i.k === k);
      }
    }
    const d = deepFreeze(new Doc());
    expect(Object.isFrozen(d)).toBe(true);
    expect(Object.isFrozen(d.items[0])).toBe(true);
    expect(() => d.index.set("b", 1)).toThrow(TypeError);
    expect(d.find("a")).toEqual({ k: "a" });
    expect(Object.isFrozen(Doc.prototype)).toBe(false);
    expect(Object.isFrozen(Map.prototype)).toBe(false);
    // Other maps still work.
    const m = new Map<string, number>();
    m.set("x", 1);
    expect(m.get("x")).toBe(1);
  });

  it("keeps values unfrozen only when asked, for objects that hold native handles", () => {
    const cache = createParseCache();
    const v = cache.get("tree", "a.java", "class A {}", () => ({ n: 1 }), {
      freeze: false,
      pool: "native",
    });
    expect(Object.isFrozen(v)).toBe(false);
  });

  it("stays under its size bound, dropping the least recently used entry first", () => {
    const parsed: string[] = [];
    const cache = createParseCache({ maxChars: 10 });
    const get = (path: string, text: string) =>
      cache.get("x", path, text, (t) => (parsed.push(t), { t }));
    get("a", "aaaa");
    get("b", "bbbb");
    get("a", "aaaa"); // a is now the most recent
    get("c", "cccc"); // 12 chars: b goes
    expect(cache.stats()).toMatchObject({ entries: 2, chars: 8, evictions: 1 });
    get("a", "aaaa");
    get("b", "bbbb");
    expect(parsed).toEqual(["aaaa", "bbbb", "cccc", "bbbb"]);
    // A value bigger than the whole bound is returned but never kept.
    expect(get("d", "dddddddddddd")).toEqual({ t: "dddddddddddd" });
    expect(cache.stats()).toMatchObject({ entries: 2, chars: 8 });
  });

  it("bounds entries by count as well as size", () => {
    const cache = createParseCache({ maxEntries: 2 });
    for (const p of ["a", "b", "c"]) cache.get("x", p, p, (t) => t);
    expect(cache.stats()).toMatchObject({ entries: 2, evictions: 1 });
  });

  it("gives native values (syntax trees) their own, smaller bound", () => {
    const freed: string[] = [];
    const cache = createParseCache({ maxChars: 1000, maxNativeChars: 6 });
    const tree = (path: string) =>
      cache.use(
        "tree",
        path,
        "abc",
        (t) => ({ t: `${path}:${t}` }),
        (v) => v.t,
        { pool: "native", freeze: false, dispose: (v) => freed.push(v.t) },
      );
    return Promise.all([tree("a"), tree("b")]).then(async () => {
      expect(freed).toEqual([]);
      await tree("c");
      expect(freed).toEqual(["a:abc"]);
      expect(cache.stats()).toMatchObject({ nativeEntries: 2, nativeChars: 6 });
    });
  });

  it("never frees a value while a reader is using it; frees it when the reader is done", async () => {
    const freed: string[] = [];
    const cache = createParseCache({ maxNativeChars: 3 });
    const opts = {
      pool: "native" as const,
      freeze: false,
      dispose: (v: { t: string }) => freed.push(v.t),
    };
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const using = cache.use(
      "tree",
      "a",
      "aaa",
      (t) => ({ t }),
      async (v) => {
        await held;
        return v.t;
      },
      opts,
    );
    // Another reader needs room: a is in use, so b goes back out once its reader is done.
    await cache.use(
      "tree",
      "b",
      "bbb",
      (t) => ({ t }),
      (v) => v.t,
      opts,
    );
    expect(freed).toEqual(["bbb"]);
    release();
    expect(await using).toBe("aaa");
    expect(freed).toEqual(["bbb"]);
    // Now a can go.
    await cache.use(
      "tree",
      "c",
      "ccc",
      (t) => ({ t }),
      (v) => v.t,
      opts,
    );
    expect(freed).toEqual(["bbb", "aaa"]);
  });

  it("shares one parse between readers that ask at the same time", async () => {
    const cache = createParseCache();
    let calls = 0;
    const parse = async (t: string) => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return { t };
    };
    const [a, b] = await Promise.all([
      cache.getAsync("x", "a", "text", parse),
      cache.getAsync("x", "a", "text", parse),
    ]);
    expect(a).toBe(b);
    expect(calls).toBe(1);
  });

  it("doesn't keep a parse that failed: the next reader gets the same error from a new parse", async () => {
    const cache = createParseCache();
    let calls = 0;
    const bad = () => {
      calls++;
      throw new Error("unclosed block");
    };
    expect(() => cache.get("hcl", "main.tf", "x {", bad)).toThrow("unclosed block");
    expect(() => cache.get("hcl", "main.tf", "x {", bad)).toThrow("unclosed block");
    expect(calls).toBe(2);
    const badAsync = async () => {
      calls++;
      throw new Error("no grammar");
    };
    await expect(cache.getAsync("t", "a", "x", badAsync)).rejects.toThrow("no grammar");
    await expect(cache.getAsync("t", "a", "x", badAsync)).rejects.toThrow("no grammar");
    expect(calls).toBe(4);
    expect(cache.stats().entries).toBe(0);
  });

  it("frees everything when the scan ends, and frees per use after that", async () => {
    const freed: string[] = [];
    const cache = createParseCache();
    const opts = {
      pool: "native" as const,
      freeze: false,
      dispose: (v: { t: string }) => freed.push(v.t),
    };
    await cache.use(
      "tree",
      "a",
      "a1",
      (t) => ({ t }),
      () => undefined,
      opts,
    );
    await cache.use(
      "tree",
      "b",
      "b1",
      (t) => ({ t }),
      () => undefined,
      opts,
    );
    cache.get("x", "b", "b1", (t) => ({ t }));
    cache.dispose();
    expect(freed.sort()).toEqual(["a1", "b1"]);
    expect(cache.stats()).toMatchObject({ entries: 0, nativeEntries: 0, chars: 0 });
    // A late reader still gets its value; nothing is kept, so nothing leaks.
    expect(
      await cache.use(
        "tree",
        "c",
        "c1",
        (t) => ({ t }),
        (v) => v.t,
        opts,
      ),
    ).toBe("c1");
    expect(freed).toContain("c1");
    expect(cache.stats().nativeEntries).toBe(0);
  });

  it("frees a value whose reader throws, when the scan ends", async () => {
    const freed: string[] = [];
    const cache = createParseCache();
    await expect(
      cache.use(
        "tree",
        "a",
        "a1",
        (t) => ({ t }),
        () => {
          throw new Error("reader bug");
        },
        { pool: "native", freeze: false, dispose: (v) => freed.push(v.t) },
      ),
    ).rejects.toThrow("reader bug");
    cache.dispose();
    expect(freed).toEqual(["a1"]);
  });
});

describe("withParseCache", () => {
  it("reads each file once and hands the same text to every reader", async () => {
    let reads = 0;
    const base = memoryRepo("forge-ledger", SHA, { "a.yaml": "a: 1", "b.yaml": "b: 2" });
    const counted: RepoHandle = {
      ...base,
      readText: (p) => {
        reads++;
        return base.readText(p);
      },
    };
    const cache = createParseCache();
    const repo = withParseCache(counted, cache);
    expect(repo.parseCache).toBe(cache);
    expect(repo.name).toBe("forge-ledger");
    expect(await repo.readText("a.yaml")).toBe("a: 1");
    expect(await repo.readText("a.yaml")).toBe("a: 1");
    expect(reads).toBe(1);
    // Readers asking at the same time share one read.
    expect(await Promise.all([repo.readText("b.yaml"), repo.readText("b.yaml")])).toEqual([
      "b: 2",
      "b: 2",
    ]);
    expect(reads).toBe(2);
    const files: string[] = [];
    for await (const f of repo.listFiles(["*.yaml"])) files.push(f);
    expect(files).toEqual(["a.yaml", "b.yaml"]);
    // A file that can't be read fails every time, as before.
    await expect(repo.readText("missing.yaml")).rejects.toThrow("no such file");
    await expect(repo.readText("missing.yaml")).rejects.toThrow("no such file");
  });

  it("keeps texts under their own bound, least recently read out first", async () => {
    const cache = createParseCache({ maxTextChars: 8 });
    const read = (t: string) => () => Promise.resolve(t);
    await cache.text("a", read("aaaa"));
    await cache.text("b", read("bbbb"));
    await cache.text("a", read("aaaa"));
    await cache.text("c", read("cccc")); // b goes
    expect(cache.stats()).toMatchObject({ texts: 2, textReads: 3, textHits: 1 });
    await cache.text("b", read("bbbb"));
    expect(cache.stats().textReads).toBe(4);
  });

  it("keeps what the wrapped handle offers beyond RepoHandle (an fsRepo's skipped files)", () => {
    const base = Object.assign(memoryRepo("r", SHA, {}), {
      maxFileBytes: 5,
      skippedFiles: () => [{ path: "big.js", bytes: 9 }],
    });
    const repo = withParseCache(base, createParseCache()) as typeof base;
    expect(repo.maxFileBytes).toBe(5);
    expect(repo.skippedFiles()).toEqual([{ path: "big.js", bytes: 9 }]);
  });
});

describe("scanRepo and the parse cache", () => {
  const files = { "a.txt": "forge" };
  const reader = (id: string, seen: (ParseCache | undefined)[]) =>
    defineExtractor({
      id,
      version: "1.0.0",
      claims: ["**/*"],
      async *scan(repo) {
        seen.push(repo.parseCache);
        repo.parseCache?.get("text", "a.txt", await repo.readText("a.txt"), (t) => t.length);
        yield* [];
      },
    });

  it("gives every extractor of one repo scan the same cache, and frees it after", async () => {
    const seen: (ParseCache | undefined)[] = [];
    await scanRepo({
      repo: memoryRepo("r", SHA, files),
      extractors: [reader("one", seen), reader("two", seen)],
    });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBeDefined();
    expect(seen[1]).toBe(seen[0]);
    // One parse for both extractors; emptied when the scan ended.
    expect(seen[0]!.stats()).toMatchObject({ misses: 1, hits: 1, entries: 0 });
  });

  it("frees the cache when an extractor fails", async () => {
    const seen: (ParseCache | undefined)[] = [];
    const failing = defineExtractor({
      id: "failing",
      version: "1.0.0",
      claims: ["**/*"],
      async *scan(repo) {
        seen.push(repo.parseCache);
        repo.parseCache!.get("text", "a.txt", "forge", (t) => t);
        yield* [];
        throw new Error("boom");
      },
    });
    const scan = await scanRepo({ repo: memoryRepo("r", SHA, files), extractors: [failing] });
    expect(scan.runs[0]!.status).toBe("failed");
    expect(seen[0]!.stats().entries).toBe(0);
  });

  it("uses the cache the caller gave the repo, and leaves freeing it to the caller", async () => {
    const seen: (ParseCache | undefined)[] = [];
    const cache = createParseCache();
    await scanRepo({
      repo: withParseCache(memoryRepo("r", SHA, files), cache),
      extractors: [reader("one", seen)],
    });
    expect(seen[0]).toBe(cache);
    expect(cache.stats().entries).toBe(1);
    cache.dispose();
  });
});
