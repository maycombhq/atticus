import { createHash } from "node:crypto";
import type { RepoHandle } from "./plugin.js";

/**
 * The parse cache (ADR 0067): what a file parses to, made once per repo scan and shared by every
 * reader of that scan, built-in extractors, dialects and plugins alike. An entry is keyed by the
 * reader's kind (what was made: "yaml", "java", "tree:java"), the file's path and its content, so a
 * changed file or a different string under the same path (a rendered template) parses again.
 *
 * Values are deep-frozen before anyone sees them: a reader that changes what it was given fails
 * at once instead of changing what the next reader reads. Readers that need to change a value
 * copy it first. Memory is bounded twice over: plain values, and native values (tree-sitter
 * trees, which live in the WebAssembly heap and must be freed), each under their own size
 * bound, least recently used first out. A native value is freed when it leaves the cache, never
 * while a reader holds it, and everything is freed when the scan ends.
 */
export interface ParseCache {
  /** What `parse` makes of this text, parsed once; frozen unless `freeze: false`. */
  get<T>(kind: string, path: string, text: string, parse: (text: string) => T, o?: GetOptions): T;
  /** The same for a parser that is asynchronous; readers asking at once share one parse. */
  getAsync<T>(
    kind: string,
    path: string,
    text: string,
    parse: (text: string) => Promise<T> | T,
    o?: GetOptions,
  ): Promise<T>;
  /**
   * Hand the value to `use` and keep it alive until `use` is done, for values that are freed
   * (`dispose`): a syntax tree is never freed under a reader walking it. After the scan has
   * ended, the value is made, used and freed at once.
   */
  use<T, R>(
    kind: string,
    path: string,
    text: string,
    parse: (text: string) => Promise<T> | T,
    use: (value: T) => R | Promise<R>,
    o?: UseOptions<T>,
  ): Promise<R>;
  /** A file's text, read once (`withParseCache` reads through this). */
  text(path: string, read: () => Promise<string>): Promise<string>;
  stats(): ParseCacheStats;
  /** Free every value and keep nothing more: the end of the repo scan. Safe to call twice. */
  dispose(): void;
}

export interface GetOptions {
  /** Deep-freeze the value (default). Only values holding native handles pass false. */
  freeze?: boolean;
  /** "native" for values outside the JavaScript heap (syntax trees): a separate, smaller bound. */
  pool?: "values" | "native";
  /** What the value counts against its bound; the text's length when not given. */
  weight?: number;
}

export interface UseOptions<T> extends GetOptions {
  /** Free the value when it leaves the cache: `tree.delete()` for a syntax tree. */
  dispose?: (value: T) => void;
}

/**
 * The bounds, in characters of the source each value was parsed from. Measured: a parsed value
 * holds 10 (a JavaFile, an HCL file, flattened YAML) to 37 (YAML documents, a SourceFile) bytes of
 * JavaScript heap per source character, and a syntax tree up to 36 bytes of WebAssembly heap,
 * which never shrinks once grown. The defaults keep one repo scan's cache to about 300 MB of heap
 * and 36 MB of WebAssembly memory at worst, for a 7 GB laptop.
 */
export interface ParseCacheLimits {
  /** Plain values: the total length of the texts they were parsed from. Default 8M characters. */
  maxChars?: number;
  /** Plain values: how many. Default 20,000. */
  maxEntries?: number;
  /** Native values (syntax trees): total text length. Default 1M characters. */
  maxNativeChars?: number;
  /** Native values: how many. Default 2,000. */
  maxNativeEntries?: number;
  /** File texts kept by `text()`. Default 16M characters. */
  maxTextChars?: number;
}

export interface ParseCacheStats {
  hits: number;
  misses: number;
  evictions: number;
  /** Plain values held now, and the length of the texts they came from. */
  entries: number;
  chars: number;
  /** Native values held now, and their texts' length. */
  nativeEntries: number;
  nativeChars: number;
  /** File texts held now; reads served from the cache and from the repo. */
  texts: number;
  textHits: number;
  textReads: number;
  /** Misses and hits by kind, for measuring which readers share. */
  byKind: Record<string, { hits: number; misses: number }>;
}

export const DEFAULT_PARSE_CACHE_LIMITS: Required<ParseCacheLimits> = {
  maxChars: 8_000_000,
  maxEntries: 20_000,
  maxNativeChars: 1_000_000,
  maxNativeEntries: 2_000,
  maxTextChars: 16_000_000,
};

interface Entry {
  key: string;
  text: string;
  weight: number;
  pool: Pool;
  /** Settled value, once the parse has finished. */
  value?: unknown;
  done: boolean;
  pending?: Promise<unknown>;
  dispose?: (value: unknown) => void;
  /** Readers inside `use` right now. */
  pins: number;
  /** Out of the cache; freed when the last reader lets go. */
  gone: boolean;
}

interface Pool {
  map: Map<string, Entry>;
  chars: number;
  maxChars: number;
  maxEntries: number;
}

/** Throws for any change to a frozen Map or Set. */
function refuse(this: unknown): never {
  throw new TypeError("a parsed value is shared by every reader and can't be changed; copy it");
}

/**
 * Freeze a value and everything it holds, so no reader can change it: objects, arrays and class
 * instances (their own properties; prototypes are shared and left alone), and Maps and Sets
 * (their set, delete, clear and add throw). Typed arrays can't be frozen and are left as they are;
 * functions are not walked into.
 */
export function deepFreeze<T>(value: T): T {
  const stack: unknown[] = [value];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const v = stack.pop();
    if (v === null || typeof v !== "object" || seen.has(v)) continue;
    seen.add(v);
    if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) continue;
    if (v instanceof Map) {
      for (const [k, x] of v) stack.push(k, x);
      for (const m of ["set", "delete", "clear"]) Object.defineProperty(v, m, { value: refuse });
    } else if (v instanceof Set) {
      for (const x of v) stack.push(x);
      for (const m of ["add", "delete", "clear"]) Object.defineProperty(v, m, { value: refuse });
    }
    for (const k of Object.keys(v)) stack.push((v as Record<string, unknown>)[k]);
    Object.freeze(v);
  }
  return value;
}

const hash = (text: string) => createHash("sha1").update(text).digest("base64");

/** A parse cache for one repo scan. */
export function createParseCache(limits: ParseCacheLimits = {}): ParseCache {
  const l = { ...DEFAULT_PARSE_CACHE_LIMITS, ...limits };
  const values: Pool = { map: new Map(), chars: 0, maxChars: l.maxChars, maxEntries: l.maxEntries };
  const native: Pool = {
    map: new Map(),
    chars: 0,
    maxChars: l.maxNativeChars,
    maxEntries: l.maxNativeEntries,
  };
  const texts = new Map<string, string>();
  const reading = new Map<string, Promise<string>>();
  let textChars = 0;
  let disposed = false;
  const st = { hits: 0, misses: 0, evictions: 0, textHits: 0, textReads: 0 };
  const byKind: Record<string, { hits: number; misses: number }> = {};
  const count = (kind: string, hit: boolean) => {
    const k = (byKind[kind] ??= { hits: 0, misses: 0 });
    if (hit) {
      k.hits++;
      st.hits++;
    } else {
      k.misses++;
      st.misses++;
    }
  };

  const free = (e: Entry) => {
    if (e.done && e.dispose) e.dispose(e.value);
  };
  const remove = (e: Entry) => {
    if (e.pool.map.get(e.key) !== e) return;
    e.pool.map.delete(e.key);
    e.pool.chars -= e.weight;
    e.gone = true;
    if (e.pins === 0) free(e);
  };
  /** Drop least recently used entries no reader holds until the pool is within its bound. */
  const trim = (pool: Pool) => {
    if (pool.chars <= pool.maxChars && pool.map.size <= pool.maxEntries) return;
    for (const e of [...pool.map.values()]) {
      if (pool.chars <= pool.maxChars && pool.map.size <= pool.maxEntries) break;
      if (e.pins > 0 || !e.done) continue;
      remove(e);
      st.evictions++;
    }
  };
  const touch = (e: Entry) => {
    // Map order is recency order: move to the end.
    e.pool.map.delete(e.key);
    e.pool.map.set(e.key, e);
  };

  /** The entry for this text, or a new one being parsed. */
  const entry = (
    kind: string,
    path: string,
    text: string,
    o: UseOptions<unknown>,
  ): { e: Entry; hit: boolean } => {
    const pool = o.pool === "native" ? native : values;
    const key = `${kind}\u0000${path}\u0000${text.length}\u0000${hash(text)}`;
    const found = pool.map.get(key);
    if (found && found.text === text) {
      touch(found);
      count(kind, true);
      return { e: found, hit: true };
    }
    if (found) remove(found);
    count(kind, false);
    const e: Entry = {
      key,
      text,
      weight: o.weight ?? text.length,
      pool,
      done: false,
      pins: 0,
      gone: false,
      ...(o.dispose ? { dispose: o.dispose } : {}),
    };
    if (!disposed && pool.maxChars > 0 && pool.maxEntries > 0 && e.weight <= pool.maxChars) {
      pool.map.set(key, e);
      pool.chars += e.weight;
    } else e.gone = true;
    return { e, hit: false };
  };
  const settle = (e: Entry, value: unknown, freeze: boolean) => {
    e.value = freeze ? deepFreeze(value) : value;
    e.done = true;
    delete e.pending;
  };
  const fail = (e: Entry) => {
    // A failed parse isn't kept: the next reader parses again and gets the same error.
    if (e.pool.map.get(e.key) === e) {
      e.pool.map.delete(e.key);
      e.pool.chars -= e.weight;
    }
    e.gone = true;
  };
  /** The entry's value, waiting for a parse in flight. */
  const valueOf = async (e: Entry, hit: boolean, parse: (t: string) => unknown, o: GetOptions) => {
    if (hit) return e.done ? e.value : await e.pending;
    const p = (async () => parse(e.text))();
    e.pending = p;
    try {
      const v = await p;
      settle(e, v, o.freeze !== false);
      return e.value;
    } catch (err) {
      fail(e);
      throw err;
    }
  };

  return {
    get(kind, path, text, parse, o = {}) {
      const { e, hit } = entry(kind, path, text, o);
      if (hit && e.done) return e.value as never;
      if (hit) throw new Error(`${kind} of ${path} is being parsed asynchronously; use getAsync`);
      let v: unknown;
      try {
        v = parse(text);
      } catch (err) {
        fail(e);
        throw err;
      }
      settle(e, v, o.freeze !== false);
      trim(e.pool);
      return e.value as never;
    },

    async getAsync(kind, path, text, parse, o = {}) {
      const { e, hit } = entry(kind, path, text, o);
      const v = await valueOf(e, hit, parse, o);
      trim(e.pool);
      return v as never;
    },

    async use(kind, path, text, parse, use, o = {}) {
      const { e, hit } = entry(kind, path, text, o as UseOptions<unknown>);
      e.pins++;
      try {
        const v = await valueOf(e, hit, parse, o);
        return await use(v as never);
      } finally {
        e.pins--;
        if (e.pins === 0 && e.gone) free(e);
        else trim(e.pool);
      }
    },

    async text(path, read) {
      const t = texts.get(path);
      if (t !== undefined) {
        st.textHits++;
        texts.delete(path);
        texts.set(path, t);
        return t;
      }
      // Readers asking for a file at once share one read.
      const inFlight = reading.get(path);
      if (inFlight) {
        st.textHits++;
        return inFlight;
      }
      st.textReads++;
      const p = read();
      reading.set(path, p);
      let text: string;
      try {
        text = await p;
      } finally {
        reading.delete(path);
      }
      if (disposed || l.maxTextChars <= 0 || text.length > l.maxTextChars) return text;
      texts.set(path, text);
      textChars += text.length;
      for (const [p, x] of texts) {
        if (textChars <= l.maxTextChars) break;
        texts.delete(p);
        textChars -= x.length;
      }
      return text;
    },

    stats() {
      return {
        ...st,
        entries: values.map.size,
        chars: values.chars,
        nativeEntries: native.map.size,
        nativeChars: native.chars,
        texts: texts.size,
        byKind: structuredClone(byKind),
      };
    },

    dispose() {
      disposed = true;
      for (const pool of [values, native]) for (const e of [...pool.map.values()]) remove(e);
      texts.clear();
      textChars = 0;
    },
  };
}

/**
 * The repo handle with a parse cache: readText reads each file once, and readers find the cache
 * at `parseCache`. Everything else is the wrapped handle's (an fsRepo's skipped files too).
 */
export function withParseCache<R extends RepoHandle>(repo: R, cache: ParseCache): R {
  const wrapped = Object.create(repo) as R & { parseCache: ParseCache };
  Object.defineProperties(wrapped, {
    parseCache: { value: cache, enumerable: true },
    readText: { value: (path: string) => cache.text(path, () => repo.readText(path)) },
  });
  return wrapped;
}
