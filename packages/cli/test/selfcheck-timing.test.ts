import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { buildPhases } from "@maycombhq/scanner";
import { main } from "../src/main.js";
import { TIMING_WORDS } from "../src/selfcheck-timing.js";
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
/** Every file under the metarepo, with its bytes, but this machine's log. */
async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (d: string, rel: string) => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const r = `${rel}${e.name}`;
      if (r === ".atticus/logs") continue;
      if (e.isDirectory()) await walk(join(d, e.name), `${r}/`);
      else out[r] = await readFile(join(d, e.name), "latin1");
    }
  };
  await walk(dir, "");
  return out;
}

/** A phase line: two spaces, a phase name of fixed words, then wall and CPU seconds. */
const PHASE_LINE = /^ {2}[a-z0-9 :.,'-]+? {2,}\d+\.\d s wall, \d+\.\d s CPU$/;

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
      // The read an Apply makes first, then the build's own inputs and passes.
      expect(phases[0]).toMatch(/^ {2}read: the catalog on disk /);
      // Then the hash of every record file the write's guards make: where antivirus shows.
      expect(phases[1]).toMatch(/^ {2}guards: hash the catalog on disk /);
      expect(phases.some((l) => l.startsWith("  inputs: "))).toBe(true);
      expect(phases.some((l) => l.startsWith("  build: "))).toBe(true);
      expect(r.out).toContainEqual(
        expect.stringMatching(/^One build: \d+\.\d s wall, \d+\.\d s CPU\.$/),
      );
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
        const ok =
          fixed.has(l) ||
          PHASE_LINE.test(l) ||
          /^One build: \d+\.\d s wall, \d+\.\d s CPU\.$/.test(l);
        expect(ok, l).toBe(true);
      }
      // Phase names are the build's own fixed words: none names a repo of this estate.
      const text = plain.out.join("\n");
      expect(text).not.toMatch(/forge-/);

      const named = await run(["selfcheck", "--timing", "--names", "--root", e.root]);
      expect(named.code).toBe(0);
      const line = named.out.find((l) => l.startsWith("Repos with facts: "));
      expect(line).toMatch(
        /^Repos with facts: \d+\. Apply to every repo, at one build each: (under a minute|about \d+ min|about \d+ h( \d+ min)?), before the writes\.$/,
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
      expect(j.phases[0]!.phase).toBe("read: the catalog on disk");
      expect(j.phases[1]!.phase).toBe("guards: hash the catalog on disk");
      for (const p of j.phases) {
        expect(p.ms).toBeGreaterThanOrEqual(0);
        expect(p.cpuMs).toBeGreaterThanOrEqual(0);
      }
      expect(j.totalMs).toBeGreaterThan(0);
      expect(Object.keys(j).sort()).toEqual(["cpuMs", "phases", "totalMs"]);
    },
    T,
  );

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
