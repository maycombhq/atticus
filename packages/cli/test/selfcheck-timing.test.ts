import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { buildPhases } from "@maycombhq/scanner";
import { main } from "../src/main.js";
import { FACTS_SIDE, TIMING_WORDS } from "../src/selfcheck-timing.js";
import { FACTS_SIDE_FILES } from "../src/verify-commands.js";
import type { Shape } from "../src/shape-words.js";
import { makeFieldEstate, type FieldEstate } from "./field-estate.js";

/**
 * Gate 1 of the v31 plan: `atticus selfcheck --timing` times one catalog build in memory, the
 * build each repo's Apply runs, phase by phase. It is for the owner to read off the screen on
 * site, where nothing may be sent out: like selfcheck, it reads only, writes nothing, and prints
 * fixed words and numbers, with no name, id, path, host or count of the estate unless the person
 * asks for `--names`. On the invented field estate (field-estate.ts; CLAUDE.md rule 3).
 */

const T = 600_000;
const made: string[] = [];
afterAll(async () => {
  await Promise.all(made.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5 })));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const SMALL: Shape = {
  repos: "6-20",
  records: "under-1k",
  flags: ["gateway-proxies", "deploy-token-hosts", "https-origins", "legacy-slots"],
};

async function estate(): Promise<FieldEstate> {
  const dir = await mkdtemp(join(tmpdir(), "b31-st-tm-"));
  made.push(dir);
  return makeFieldEstate(dir, { shape: SMALL, checkouts: 0 });
}
async function run(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err };
}
/**
 * Every file under the metarepo, with its bytes and its modification time, but the one log line
 * every command appends (`.atticus/logs/atticus.log`): a rewrite with the same bytes shows too.
 */
async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (d: string, rel: string) => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const r = `${rel}${e.name}`;
      if (r === ".atticus/logs/atticus.log") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p, `${r}/`);
      else out[r] = `${(await stat(p)).mtimeMs} ${await readFile(p, "latin1")}`;
    }
  };
  await walk(dir, "");
  return out;
}

/** A phase line: two spaces, a phase name of fixed words, then wall and CPU seconds. */
const PHASE_LINE = /^ {2}[a-z0-9 :.,'-]+? {2,}\d+\.\d s wall, \d+\.\d s CPU$/;
const TOTAL_LINE = /^One Apply, before its writes: \d+\.\d s wall, \d+\.\d s CPU\.$/;

describe("atticus selfcheck --timing", () => {
  it(
    "times one build in memory, phase by phase, writes nothing and sends nothing",
    async () => {
      const e = await estate();
      const fetched = vi.fn(() => Promise.reject(new Error("selfcheck touched the network")));
      vi.stubGlobal("fetch", fetched);
      const before = await tree(e.root);
      const r = await run(["selfcheck", "--timing", "--root", e.root]);
      expect(r.code, [...r.out, ...r.err].join("\n")).toBe(0);
      expect(fetched).not.toHaveBeenCalled();
      expect(await tree(e.root)).toEqual(before);
      // Nobody is left listening to the build's phases after it.
      expect(buildPhases.on).toBeUndefined();

      expect(r.out[0]).toBe(TIMING_WORDS.head);
      const phases = r.out.filter((l) => PHASE_LINE.test(l));
      // The read-only steps of one Apply, in its order (the hash is where antivirus shows),
      // then the build's own phases.
      // Item 11: the hash's own two phases (where its seconds go) come before its total.
      expect(phases.slice(0, 7).map((l) => l.trim().split(/ {2,}/)[0])).toEqual([
        "read: the org pack",
        "read: the catalog on disk",
        "hash: walk",
        "hash: read and sha256",
        "guards: hash the catalog on disk",
        "read: the questions",
        "join: every repo's facts",
      ]);
      expect(phases.some((l) => l.startsWith("  inputs: "))).toBe(true);
      expect(phases.some((l) => l.startsWith("  build: 1 sources"))).toBe(true);
      expect(r.out).toContainEqual(expect.stringMatching(TOTAL_LINE));
      expect(r.out.at(-1)).toBe(TIMING_WORDS.apply);
    },
    T,
  );

  it(
    "prints fixed words and numbers only; the count of repos is for --names, on screen",
    async () => {
      const e = await estate();
      const plain = await run(["selfcheck", "--timing", "--root", e.root]);
      expect(plain.code).toBe(0);
      const fixed = new Set<string>([
        TIMING_WORDS.head,
        TIMING_WORDS.apply,
        TIMING_WORDS.notWritten,
      ]);
      for (const l of plain.out) {
        const ok = fixed.has(l) || PHASE_LINE.test(l) || TOTAL_LINE.test(l);
        expect(ok, l).toBe(true);
      }
      // Phase names are the build's own fixed words: none names a repo of this estate.
      const text = plain.out.join("\n");
      expect(text).not.toMatch(/forge-/);

      const named = await run(["selfcheck", "--timing", "--names", "--root", e.root]);
      expect(named.code).toBe(0);
      const line = named.out.find((l) => l.startsWith("Repos with facts: "));
      // beta.32: no "at that each" estimate. Since beta.31 Apply to every repo builds once, so
      // one Apply times the repos was hours too many (1 h 20 min said on the owner's estate).
      expect(line).toMatch(/^Repos with facts: \d+\.$/);
      expect(named.out.join("\n")).not.toMatch(/at that each/);
      // beta.32: how many record files the guards' hash read again, with --names only. The
      // estate was built by its maker, never hashed with a cache here, so every one is read.
      expect(named.out).toContainEqual(
        expect.stringMatching(
          /^The guards' hash read \d+ of \d+ record files again; the rest were kept by their size and times\.$/,
        ),
      );
      expect(plain.out.join("\n")).not.toMatch(/guards' hash read/);
      // The intake's stages are timed as phases of their own.
      expect(plain.out).toContainEqual(
        expect.stringMatching(/^ {2}intake: read, hash and classify +\d/),
      );
    },
    T,
  );

  it(
    "--json gives the phases as numbers, and nothing --names would show",
    async () => {
      const e = await estate();
      const r = await run(["selfcheck", "--timing", "--json", "--root", e.root]);
      expect(r.code).toBe(0);
      const j = JSON.parse(r.out.join("\n")) as {
        phases: { phase: string; ms: number; cpuMs: number }[];
        totalMs: number;
        cpuMs: number;
      };
      expect(j.phases.length).toBeGreaterThan(3);
      expect(j.phases[1]!.phase).toBe("read: the catalog on disk");
      expect(j.phases[4]!.phase).toBe("guards: hash the catalog on disk");
      for (const p of j.phases) {
        expect(p.ms).toBeGreaterThanOrEqual(0);
        expect(p.cpuMs).toBeGreaterThanOrEqual(0);
      }
      expect(j.totalMs).toBeGreaterThan(0);
      expect(Object.keys(j).sort()).toEqual(["cpuMs", "phases", "totalMs"]);
    },
    T,
  );

  it(
    "after a build was kept (an Apply, catalog build), it still times a whole build, not the cache",
    async () => {
      const e = await estate();
      const built = await run(["catalog", "build", "--root", e.root]);
      expect(built.code, [...built.out, ...built.err].join("\n")).toBe(0);
      const before = await tree(e.root);
      const r = await run(["selfcheck", "--timing", "--root", e.root]);
      expect(r.code, [...r.out, ...r.err].join("\n")).toBe(0);
      const names = r.out.filter((l) => PHASE_LINE.test(l)).map((l) => l.trim().split(/ {2,}/)[0]);
      for (const pass of ["build: 1 sources", "build: 3 merge", "build: 6 curated"])
        expect(names, pass).toContain(pass);
      // With a kept build and kept parses on disk, still nothing is written.
      expect(await tree(e.root)).toEqual(before);
    },
    T,
  );

  it(
    "says when the guards' hash can't keep what it read (item 11)",
    async () => {
      const e = await estate();
      const cache = join(e.root, ".atticus", "cache");
      await rm(cache, { recursive: true, force: true });
      await mkdir(dirname(cache), { recursive: true });
      // Where the cache's folder should be, a file: nothing can be kept in it.
      await writeFile(cache, "");
      const r = await run(["selfcheck", "--timing", "--root", e.root]);
      expect(r.code, [...r.out, ...r.err].join("\n")).toBe(0);
      expect(r.out).toContainEqual(
        expect.stringMatching(/^The guards' hash couldn't keep what it read \(E[A-Z]+\)/),
      );
      const j = JSON.parse(
        (await run(["selfcheck", "--timing", "--json", "--root", e.root])).out.join("\n"),
      ) as { hashCacheWrite?: string };
      expect(j.hashCacheWrite).toMatch(/^E[A-Z]+$/);
    },
    T,
  );

  it.skipIf(process.platform === "win32")(
    "a step that fails says one fixed sentence and exits 2; its message only with --names",
    async () => {
      const e = await estate();
      // A record file that can't be opened, as a file another program holds would be.
      const held = join(e.root, "catalog/generated/capability/forge-svc-held.yaml");
      await mkdir(dirname(held), { recursive: true });
      await symlink(join(e.root, "no-such-file.yaml"), held);
      const plain = await run(["selfcheck", "--timing", "--root", e.root]);
      expect(plain.code).toBe(2);
      expect(plain.err).toEqual([TIMING_WORDS.failed]);
      expect([...plain.out, ...plain.err].join("\n")).not.toMatch(/forge-svc-held|catalog\//);
      const json = await run(["selfcheck", "--timing", "--json", "--root", e.root]);
      expect(json.code).toBe(2);
      expect(JSON.parse(json.out.join("\n"))).toEqual({ error: TIMING_WORDS.failed });
      expect([...json.out, ...json.err].join("\n")).not.toMatch(/forge-svc-held/);
      const named = await run(["selfcheck", "--timing", "--names", "--root", e.root]);
      expect(named.code).toBe(2);
      expect(named.err.join("\n")).toMatch(/forge-svc-held/);
      // The lock was let go: with the file gone, the next run takes it and finishes.
      await rm(held);
      expect((await run(["selfcheck", "--timing", "--root", e.root])).code).toBe(0);
    },
    T,
  );

  it("its facts-file test is verify's own", () => {
    expect(FACTS_SIDE.source).toBe(FACTS_SIDE_FILES.source);
  });

  it("a folder that is no metarepo: exit 2", async () => {
    const dir = await mkdtemp(join(tmpdir(), "b31-st-tm-none-"));
    made.push(dir);
    const r = await run(["selfcheck", "--timing", "--root", dir]);
    expect(r.code).toBe(2);
  });

  it("loads no adapter, no model runtime and no network module (CLAUDE.md rule 5)", async () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
    const text = await readFile(join(src, "selfcheck-timing.ts"), "utf8");
    const from = [...text.matchAll(/(?:from|import\()\s*"([^"]+)"/g)].map((m) => m[1]!);
    expect(from.length).toBeGreaterThan(0);
    for (const m of from)
      expect(m, `selfcheck-timing.ts imports ${m}`).not.toMatch(
        /adapters|model-providers|@maycombhq\/ai\b|node:(http|https|http2|net|tls|dgram|dns)|undici/,
      );
  });
});
