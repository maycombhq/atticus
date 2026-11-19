import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { hostname } from "node:os";
import {
  acquireLock,
  factsDirOf,
  listQuestions,
  startTerminalRun,
  type Fact,
} from "@maycombhq/core";
import {
  buildAndWrite,
  buildCacheHooks,
  buildCatalog,
  refusalCommands,
  factsSnapshotWrites,
  loadBuildInputs,
} from "@maycombhq/scanner";
import { main } from "../src/main.js";
import {
  CHECK_FLAGS,
  CHECK_IDS,
  COST_BY_BAND,
  selfcheck,
  SELFCHECK_WORDS,
  selfcheckHooks,
} from "../src/selfcheck.js";
import { CARD_WORDS, SHAPE_FLAGS, shapeText, type Shape } from "../src/shape-words.js";
import { BIG_COMMIT } from "./big-estate.js";
import { makeFieldEstate, type FieldEstate } from "./field-estate.js";

/**
 * ADR 0202 point 10 (the field plan's Group 4): `atticus selfcheck` runs four named checks on
 * site, reads only, sends nothing, and prints a shape card made of fixed words. On the invented
 * field estate (field-estate.ts), made from the card's own words (CLAUDE.md rule 3).
 */

const T = 600_000;
const made: string[] = [];
afterAll(async () => {
  await Promise.all(made.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5 })));
});
afterEach(() => {
  delete selfcheckHooks.unaccounted;
  delete selfcheckHooks.second;
  delete selfcheckHooks.refusals;
  vi.unstubAllGlobals();
});

async function estate(shape: Shape): Promise<FieldEstate> {
  const dir = await mkdtemp(join(tmpdir(), "b30-st-sc-"));
  made.push(dir);
  return makeFieldEstate(dir, { shape, checkouts: 0 });
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
/** A finished run on record: a long command that printed a line every `quietMs`. */
function ranOnce(root: string, command: string[], quietMs: number, totalMs = 90_000) {
  const t0 = Date.UTC(2026, 10, 18, 9, 0, 0);
  const lines = Math.max(1, Math.floor(totalMs / quietMs));
  let k = 0;
  // The start, each line, then the end: every gap is quietMs, and the run takes totalMs.
  const at = () => new Date(Math.min(t0 + k++ * quietMs, t0 + totalMs));
  const rec = startTerminalRun(root, {
    positionals: command,
    flags: [],
    pid: 4242 + Math.floor(quietMs / 1000),
    now: at,
  })!;
  for (let i = 0; i < lines; i++) rec.line("Reading…");
  k = Math.ceil(totalMs / quietMs);
  rec.end(0);
}

const SMALL: Shape = {
  repos: "6-20",
  records: "under-1k",
  flags: ["gateway-proxies", "deploy-token-hosts", "https-origins", "legacy-slots"],
};

describe("atticus selfcheck on the invented field estate", () => {
  it(
    "all four checks pass, nothing is written but the log, and nothing touches the network",
    async () => {
      const e = await estate(SMALL);
      ranOnce(e.root, ["verify", "forge-svc-00"], 4_000);
      // Any network call would go through one of these: none is ever made (CLAUDE.md rule 5).
      const fetched = vi.fn(() => Promise.reject(new Error("selfcheck touched the network")));
      vi.stubGlobal("fetch", fetched);
      const before = await tree(e.root);
      const r = await run(["selfcheck", "--root", e.root]);
      expect(r.code, [...r.out, ...r.err].join("\n")).toBe(0);
      expect(fetched).not.toHaveBeenCalled();
      expect(await tree(e.root)).toEqual(before);
      expect(r.out[0]).toBe("atticus selfcheck: 4 of 4 checks passed. Nothing was sent anywhere.");
      expect(r.out.slice(1, 5).map((l) => l.split(":")[0])).toEqual([
        "passed calls-accounted",
        "passed refusals-have-next-step",
        "passed build-is-repeatable",
        "passed no-long-silence",
      ]);
      // Counts in bands only: no exact number of the estate above a card that promises none.
      expect(r.out[1]).toMatch(
        /^passed calls-accounted: every call the join left has a reason: (0|1-9|10-99|100-999|1k-10k) joined or placed outside, (0|1-9|10-99|100-999) asked, (0|1-9|10-99|100-999) left with a reason, 0 with none\.$/,
      );
      expect(r.out[3]).toBe(
        "passed build-is-repeatable: two builds in memory listed the same files, byte for byte.",
      );
      expect(r.out[4]).toBe(
        "passed no-long-silence: the newest run of each command on record printed a line at least every 30 seconds.",
      );
      // The exact numbers are for the person on site, with --names, on screen only.
      const named = await run(["selfcheck", "--names", "--root", e.root]);
      const exact = named.out.filter((l) => l.startsWith("  Exact, on this screen only: "));
      expect(exact).toHaveLength(4);
      expect(exact[0]).toMatch(
        /: \d+ joined or placed outside, \d+ asked, \d+ left with a reason, 0 with none\.$/,
      );
      expect(exact[2]).toMatch(/: \d+ files listed, 0 differ\.$/);
      // None of the estate's exact counts (calls, files) is in the checks' own lines.
      const numbers = [exact[0]!, exact[2]!].flatMap((l) => l.match(/\d{2,}/g) ?? []);
      expect(numbers.length).toBeGreaterThan(1);
      const lines = r.out
        .slice(1, 5)
        .join("\n")
        .replace(/\d+k?-\d+k?/g, "");
      for (const n of numbers) expect(lines, n).not.toContain(n);
      // The card, after the checks: the shape the estate was made from.
      expect(r.out.slice(5)).toEqual([
        "",
        "Shape card: fixed words only; no name, id, path, hash or count of this estate.",
        "  repos: 6-20",
        "  records: under-1k",
        "  flags: gateway-proxies deploy-token-hosts https-origins legacy-slots",
        `  platform: ${{ win32: "windows", darwin: "macos" }[process.platform as string] ?? "linux"}`,
        "  slowest step: verify 30s-2m",
      ]);
      // --json: the same checks and card, in the same words.
      const j = await run(["selfcheck", "--json", "--root", e.root]);
      expect(j.code).toBe(0);
      const json = JSON.parse(j.out.join("\n")) as {
        checks: { id: string; state: string; sentence: string }[];
        card: Record<string, unknown>;
      };
      expect(Object.keys(json)).toEqual(["checks", "card"]);
      expect(json.checks.map((c) => `${c.state} ${c.id}: ${c.sentence}`)).toEqual(
        r.out.slice(1, 5),
      );
      expect(json.card).toEqual({
        repos: "6-20",
        records: "under-1k",
        flags: SMALL.flags,
        platform: expect.any(String),
        slowest: { step: "verify", time: "30s-2m" },
      });
      // The usual one line a run in the log: the command and its flag names.
      const log = (await readFile(join(e.root, ".atticus", "logs", "atticus.log"), "utf8"))
        .trim()
        .split("\n");
      expect(log).toHaveLength(3);
      // Only the command's word: never the folder given after --root.
      for (const l of log) expect((JSON.parse(l) as { command: string }).command).toBe("selfcheck");
      for (const l of log) expect(JSON.parse(l)).toMatchObject({ event: "command", code: 0 });
      expect(log.join("\n")).not.toMatch(/forge-svc|forge-gw|drawn|repos:/);
    },
    T,
  );

  it(
    "a run from before beta.30 has no silence on record: the check is skipped, and says what to do",
    async () => {
      const e = await estate({ repos: "1-5", records: "under-1k", flags: ["https-origins"] });
      const none = await selfcheck(e.root);
      expect(none.checks.find((c) => c.id === "no-long-silence")).toEqual({
        id: "no-long-silence",
        state: "skipped",
        sentence:
          "No run on record since this Atticus was installed: run the command once, then selfcheck again.",
      });
      expect(none.card.slowest).toEqual({ step: "none" });
      // A record an older Atticus wrote: finished, with no longestQuietMs.
      ranOnce(e.root, ["scan"], 1_000, 3_000);
      const dir = join(e.root, ".atticus", "logs", "running");
      for (const n of await readdir(dir)) {
        const rec = JSON.parse(await readFile(join(dir, n), "utf8")) as Record<string, unknown>;
        delete rec.longestQuietMs;
        await writeFile(join(dir, n), JSON.stringify(rec));
      }
      const old = await selfcheck(e.root);
      expect(old.checks.find((c) => c.id === "no-long-silence")!.state).toBe("skipped");
      expect(old.card.slowest).toEqual({ step: "scan", time: "under-5s" });
      const r = await run(["selfcheck", "--root", e.root]);
      expect(r.code).toBe(0);
      expect(r.out[0]).toBe("atticus selfcheck: 3 of 4 checks passed. Nothing was sent anywhere.");
      expect(r.out[4]).toBe(
        "skipped no-long-silence: No run on record since this Atticus was installed: run the command once, then selfcheck again.",
      );
    },
    T,
  );

  it(
    "each check fails on a made fault and names its closest invented shape",
    async () => {
      const e = await estate(SMALL);
      const make = shapeText(SMALL);
      // 1. A long command that printed nothing for 45 seconds.
      ranOnce(e.root, ["scan"], 45_000);
      // 2. A call the join left with no reason (a test's switch: no estate makes one).
      selfcheckHooks.unaccounted = (d) =>
        d.unaccounted.push("forge-svc-00: src/main/java/forge/client/Client0.java:3");
      // 3. A second build that lists another hash for one file.
      selfcheckHooks.second = (b) => ({
        ...b,
        manifest: {
          ...b.manifest,
          files: b.manifest.files.map((f, k) => (k === 0 ? { ...f, sha256: "f".repeat(64) } : f)),
        },
      });
      const r = await run(["selfcheck", "--root", e.root]);
      expect(r.code).toBe(1);
      const failed = r.out.filter((l) => l.startsWith("failed "));
      expect(failed.map((l) => l.split(":")[0])).toEqual([
        "failed calls-accounted",
        "failed build-is-repeatable",
        "failed no-long-silence",
      ]);
      expect(r.out[0]).toBe("atticus selfcheck: 1 of 4 checks passed. Nothing was sent anywhere.");
      const under = (id: string) =>
        r.out[r.out.findIndex((l) => l.startsWith(`failed ${id}:`)) + 1];
      // The check about how calls join names the first of its flags the card finds present.
      expect(under("calls-accounted")).toBe(
        `  Closest invented shape: deploy-token-hosts. Make it: ATTICUS_FIELD_SHAPE=${make}`,
      );
      // A build that isn't repeatable and a long silence are not explained by a shape flag:
      // none is guessed (a slow answer to a question was once blamed on gateway-proxies).
      for (const id of ["build-is-repeatable", "no-long-silence"] as const) {
        expect(CHECK_FLAGS[id]).toBeUndefined();
        expect(under(id)).toBe(
          `  Closest invented shape: none: this check is not about the estate's shape. The estate's: ATTICUS_FIELD_SHAPE=${make}`,
        );
      }
      expect(r.out.join("\n")).toMatch(
        /failed calls-accounted: a call the join left has no reason: .* 1-9 with none\./,
      );
      expect(r.out).toContain(
        "failed build-is-repeatable: two builds in memory listed files whose hashes differ.",
      );
      expect(r.out).toContain(
        "failed no-long-silence: the newest run of a command on record went over 30 seconds without a line.",
      );
      // Without --names, nothing of the estate is said; with it, on screen only.
      expect(r.out.join("\n")).not.toContain("forge-svc-00");
      const named = await run(["selfcheck", "--names", "--root", e.root]);
      expect(named.out).toContain("  The first 1, on this screen only:");
      expect(named.out).toContain("    forge-svc-00: src/main/java/forge/client/Client0.java:3");
      const j = await run(["selfcheck", "--names", "--json", "--root", e.root]);
      expect(j.code).toBe(1);
      expect(j.out.join("\n")).not.toContain("forge-svc-00");
      expect(j.out.join("\n")).not.toContain("Exact");
      expect(JSON.parse(j.out.join("\n")).checks[0]).toMatchObject({
        id: "calls-accounted",
        state: "failed",
        closest: "deploy-token-hosts",
        make,
      });
    },
    T,
  );

  it(
    "a build over a catalog its sources no longer make names its next step, and so does a scan that read nothing",
    async () => {
      const e = await estate({ repos: "1-5", records: "under-1k", flags: ["https-origins"] });
      expect((await run(["catalog", "build", "--root", e.root])).code).toBe(0);
      // Every repo's read is taken away: the build would be empty, over a catalog that is not.
      for (const sub of ["facts", "readers", "legacy"])
        await rm(join(e.root, "catalog", "sources", sub), { recursive: true, force: true });
      await rm(factsDirOf(e.root), { recursive: true, force: true });
      const guard = await buildAndWrite(e.root, { command: "atticus catalog build", check: true });
      expect(guard.guard.refused?.reasons).toEqual(["empty"]);
      expect(refusalCommands(guard.guard.refused!, "atticus catalog build")).toEqual([
        "atticus doctor --counts",
      ]);
      expect(refusalCommands({ reasons: ["nothing-read"], message: "" }, "atticus scan")).toEqual([
        "atticus workspace sync",
      ]);
      // That command says, here, that no repo is read: the thing to put right.
      const counts = await run(["doctor", "--counts", "--root", e.root]);
      expect(counts.code).toBe(0);
      expect(counts.out.join("\n")).toMatch(/Repos: \d+ in all, 0 read, \d+ unread/);
      const r = await run(["selfcheck", "--root", e.root]);
      expect(r.out).toContain(
        "passed refusals-have-next-step: every refusal here names a command to go on.",
      );
      // No call facts are left to check: skipped, never passed.
      expect(r.out).toContain("skipped calls-accounted: no call facts to check.");
    },
    T,
  );

  it(
    "a refusal that names no command fails refusals-have-next-step, and names the closest shape",
    async () => {
      const e = await estate({
        repos: "6-20",
        records: "under-1k",
        flags: ["https-origins", "unread-repo"],
      });
      // No refusal of Atticus's own is left without a command, so a test makes one.
      selfcheckHooks.refusals = (list) => list.push({ what: "forge-made-refusal", next: [] });
      const r = await run(["selfcheck", "--root", e.root]);
      expect(r.code).toBe(1);
      const at = r.out.findIndex((l) => l.startsWith("failed refusals-have-next-step:"));
      expect(r.out[at]).toBe(
        "failed refusals-have-next-step: a refusal here names no command to go on.",
      );
      expect(r.out[at + 1]).toBe(
        "  Closest invented shape: unread-repo. Make it: ATTICUS_FIELD_SHAPE=6-20,under-1k,https-origins,unread-repo",
      );
      const named = await run(["selfcheck", "--names", "--root", e.root]);
      expect(named.out).toContain("    forge-made-refusal");
      expect(named.out.join("\n")).toMatch(
        /Exact, on this screen only: \d refused, \d with a command/,
      );
    },
    T,
  );

  it(
    "--quick leaves out the check that builds twice; a large catalog says what the two builds cost first",
    async () => {
      const e = await estate({ repos: "1-5", records: "under-1k", flags: ["https-origins"] });
      const quick = await run(["selfcheck", "--quick", "--root", e.root]);
      expect(quick.code).toBe(0);
      expect(quick.out).toContain(
        "skipped build-is-repeatable: left out with --quick: it builds the catalog twice in memory.",
      );
      expect(quick.err).toEqual(["Building in memory…", "Running the build's guard…"]);
      expect(quick.out).toContain("  records: under-1k");
      // A small catalog is built twice with no word about cost.
      const small = await run(["selfcheck", "--root", e.root]);
      expect(small.err.join("\n")).not.toContain("about");
      // 10,000 record files on disk: the cost is said, by the card's band, before the first
      // build starts. It holds no number of the estate: only the band and the table's words.
      const dir = join(e.root, "catalog", "generated", "system");
      await mkdir(dir, { recursive: true });
      await Promise.all(
        Array.from({ length: 10_000 }, (_, k) => writeFile(join(dir, `forge-${k}.yaml`), "")),
      );
      const big = await run(["selfcheck", "--root", e.root]);
      expect(big.err[0]).toBe(
        "build-is-repeatable builds the catalog twice in memory. An estimate for 10k-50k records: about half a minute and under 1 GB. atticus selfcheck --quick leaves it out.",
      );
      for (const band of ["10k-50k", "50k-200k", "over-200k"] as const) {
        const line = SELFCHECK_WORDS.cost(band);
        const rest = line.replace(band, "").replace(COST_BY_BAND[band]!, "");
        expect(rest, line).not.toMatch(/\d/);
      }
      expect(Object.keys(COST_BY_BAND)).toEqual(["10k-50k", "50k-200k", "over-200k"]);
      expect(big.err.join("\n")).not.toMatch(/10,?000|10\.0|\b1\.\d GB/);
      expect(big.err[1]).toBe("Building in memory (1 of 2)…");
    },
    T,
  );

  it(
    "while another command holds the lock it says only that, with nothing of the holder, and exits 2",
    async () => {
      const e = await estate({ repos: "1-5", records: "under-1k", flags: [] });
      const lock = await acquireLock(e.root, "scan", "atticus verify forge-svc-00 --write");
      try {
        const r = await run(["selfcheck", "--root", e.root]);
        expect(r.code).toBe(2);
        expect(r.out).toEqual([]);
        expect(r.err).toHaveLength(1);
        expect(r.err[0]).toMatch(
          /^Another Atticus command is running on this metarepo \(since [0-9T:.Z-]+\), so selfcheck couldn't run\. Run it again when that command has finished\.$/,
        );
        expect(r.err[0]).not.toMatch(/forge-svc|verify|process \d|\.json/);
        expect(r.err[0]).not.toContain(hostname());
        expect(r.err[0]).not.toContain(e.root);
      } finally {
        await lock.release();
      }
    },
    T,
  );

  it(
    "a shape nobody has made yet is said so",
    async () => {
      const e = await estate({ repos: "1-5", records: "under-1k", flags: [] });
      selfcheckHooks.unaccounted = (d) => d.unaccounted.push("forge-svc-00: Client0.java:3");
      const r = await run(["selfcheck", "--root", e.root]);
      expect(r.code).toBe(1);
      expect(r.out).toContain(
        "  Closest invented shape: none known: this is a new shape. Make it: ATTICUS_FIELD_SHAPE=1-5,under-1k",
      );
      expect(r.out).toContain("  flags: none");
    },
    T,
  );

  it("loads no adapter, no model runtime and no network module (CLAUDE.md rule 5)", async () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
    // The card's words read no file and load nothing at all.
    expect(await readFile(join(src, "shape-words.ts"), "utf8")).not.toMatch(/^import /m);
    for (const f of ["selfcheck.ts", "standing.ts", "doctor-counts.ts"]) {
      const text = await readFile(join(src, f), "utf8");
      const from = [...text.matchAll(/(?:from|import\()\s*"([^"]+)"/g)].map((m) => m[1]!);
      expect(from.length, f).toBeGreaterThan(0);
      for (const m of from)
        expect(m, `${f} imports ${m}`).not.toMatch(
          /adapters|model-providers|@maycombhq\/ai\b|node:(http|https|http2|net|tls|dgram|dns)|undici/,
        );
    }
  });

  it("a folder that is no metarepo: exit 2, and nothing is written there", async () => {
    const dir = await mkdtemp(join(tmpdir(), "b30-st-selfcheck-none-"));
    made.push(dir);
    const r = await run(["selfcheck", "--root", dir]);
    expect(r.code).toBe(2);
    expect(r.out).toEqual([]);
    expect(r.err.join("\n")).toContain("isn't an Atticus metarepo");
    expect(await readdir(dir)).toEqual([]);
  });
});

describe("the card of an estate made from a shape gives that shape back", () => {
  const shapes: Shape[] = [
    { repos: "1-5", records: "under-1k", flags: ["ssh-origins"] },
    {
      repos: "6-20",
      records: "1k-10k",
      flags: [
        "gateway-proxies",
        "repos-with-no-system",
        "dotted-ids",
        "nested-payloads",
        "ssh-origins",
        "https-origins",
        "hand-pairings",
        "empty-repo",
        "unread-repo",
      ],
    },
    {
      repos: "6-20",
      records: "under-1k",
      flags: ["deploy-token-hosts", "non-gateway-callee", "legacy-slots", "hand-pairings"],
    },
  ];
  for (const shape of shapes)
    it(
      shapeText(shape),
      async () => {
        const e = await estate(shape);
        const { card } = await selfcheck(e.root);
        expect({ repos: card.repos, records: card.records, flags: card.flags }).toEqual(shape);
      },
      T,
    );

  it(
    "ATTICUS_FIELD_SHAPE is the same words",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "b30-st-selfcheck-env-"));
      made.push(dir);
      process.env.ATTICUS_FIELD_SHAPE = "1-5,under-1k,https-origins,dotted-ids";
      let e: FieldEstate;
      try {
        e = await makeFieldEstate(dir, { checkouts: 0 });
      } finally {
        delete process.env.ATTICUS_FIELD_SHAPE;
      }
      const { card } = await selfcheck(e.root);
      expect(shapeText(card)).toBe("1-5,under-1k,dotted-ids,https-origins");
    },
    T,
  );
});

/**
 * The card and `--json` hold nothing of the estate. A metarepo full of distinctive invented
 * names is fed in (repo ids, systems, hosts, owners, fact ids, files, paths, a commit, question
 * text), with every id and hash the build makes of it; none of them, and no run of six or more
 * characters of any of them, may appear in what selfcheck prints, passing or failing.
 */
describe("nothing of the estate is in the card, the default output or --json", () => {
  const NAMES = {
    repos: ["zephyrquill-vaultline", "quorvex.mirabeth.svc", "brindlewick-tollgate"],
    systems: ["zephyrquill", "quorvex-mirabeth", "brindlewick"],
    hosts: [
      "vaultline.zephyrquill.example",
      "mirabeth.quorvex.example",
      "tollgate.brindlewick.example",
    ],
    owner: "team-okapiglen",
    files: [
      "src/main/java/zephyrquill/vaultline/WyvernhollowController.java",
      "src/main/java/quorvex/mirabeth/ThistledownClient.java",
    ],
    paths: ["/v7/wyvernhollow/{id}", "/v9/thistledown/{id}/umberfax"],
    commit: "5e7a9c1d3f0b2468ace013579bdf02468ace0135",
    question: "Which squirrelbrook serves the umberfax ledgers of zephyrquill?",
  };

  async function distinctive(): Promise<{ root: string; tokens: string[] }> {
    const e = await estate({
      repos: "1-5",
      records: "under-1k",
      flags: ["deploy-token-hosts", "https-origins"],
    });
    const root = e.root;
    const base = { commit: BIG_COMMIT, verified: "line", by: "assistant", conf: "declared" };
    for (const [k, repo] of NAMES.repos.entries()) {
      await appendFile(
        join(root, "org-pack/profiles/github/repos.manifest.yaml"),
        [
          `  - id: ${repo}`,
          `    url: https://git.example.test/${NAMES.systems[k]}/${repo}.git`,
          "    type: spring-boot",
          `    owner: ${NAMES.owner}`,
          `    system: ${NAMES.systems[k]}`,
          `    hosts: [${NAMES.hosts[k]}]`,
          "",
        ].join("\n"),
      );
      const facts = [
        {
          ...base,
          repo,
          kind: "entry",
          id: `e-wyvernhollow-${k}`,
          entryType: "rest",
          method: "GET",
          path: NAMES.paths[0],
          handler: "WyvernhollowController.fetch",
          cite: { file: NAMES.files[0], line: 11 + k, value: NAMES.paths[0], quote: "@GetMapping" },
        },
        {
          ...base,
          repo,
          kind: "call",
          id: `c-thistledown-${k}`,
          callType: "rest",
          method: "POST",
          path: NAMES.paths[1],
          host: k === 0 ? "@umberfaxTargetUrl@" : NAMES.hosts[(k + 1) % 3],
          cite: { file: NAMES.files[1], line: 23 + k, value: NAMES.paths[1], quote: "rest.post" },
        },
      ] as unknown as Fact[];
      await writeFile(
        join(factsDirOf(root), `${repo}.jsonl`),
        facts.map((f) => JSON.stringify(f)).join("\n") + "\n",
      );
      for (const w of factsSnapshotWrites(root, repo, facts, {
        commit: BIG_COMMIT,
        contracts: null,
      })) {
        await mkdir(dirname(w.path), { recursive: true });
        await writeFile(w.path, w.text!);
      }
    }
    // Every id, path and hash the build makes of it, and every name that went in.
    buildCacheHooks.off = true;
    let build: Awaited<ReturnType<typeof buildCatalog>>;
    try {
      build = await buildCatalog(await loadBuildInputs(root));
    } finally {
      delete buildCacheHooks.off;
    }
    const questions = (await listQuestions(root, {})).questions;
    const tokens = new Set<string>([
      ...NAMES.repos,
      ...NAMES.systems,
      ...NAMES.hosts,
      NAMES.owner,
      NAMES.commit,
      BIG_COMMIT,
      ...NAMES.files.flatMap((f) => [f, ...f.split("/")]),
      ...NAMES.paths.flatMap((p) => [p, ...p.split("/")]),
      ...NAMES.question.split(/\W+/),
      ...e.repos,
      ...e.legacy,
      ...build.records.map((r) => r.id),
      ...[...build.files.keys()].flatMap((p) => p.split("/").slice(1)),
      ...build.manifest.files.map((f) => f.sha256),
      ...Object.values(build.manifest.sources),
      ...Object.keys(build.manifest.sourceSets),
      ...questions.flatMap((q) => [q.id, ...q.evidence]),
      root,
    ]);
    return { root, tokens: [...tokens].filter((t) => t.length >= 6) };
  }

  /** Every word selfcheck may print of its own: its sentences with numbers only, and the card's. */
  const W = SELFCHECK_WORDS;
  const OWN = [
    W.head(1, 4),
    W.closest(undefined, ""),
    W.names(1),
    W.card,
    W.notRun,
    W.noShape(""),
    W.exact(""),
    W.calls({ ok: true, joined: 1, asked: 1, left: 1, none: 0 }),
    W.calls({ ok: false, joined: 1, asked: 1, left: 1, none: 1 }),
    W.callsNone,
    W.callsUnread(1),
    W.refusals({ refusals: 0, named: 0 }),
    W.refusals({ refusals: 1, named: 1 }),
    W.refusals({ refusals: 2, named: 1 }),
    W.repeatable(true),
    W.repeatable(false),
    W.repeatableQuick,
    W.cost("10k-50k"),
    W.cost("50k-200k"),
    W.cost("over-200k"),
    W.quiet(true),
    W.quiet(false),
    W.quietNone,
    W.building(1, 1),
    W.building(1, 2),
    W.building(2, 2),
    W.guarding,
    "passed failed skipped checks sentence state closest make slowest",
    ...CHECK_IDS,
    ...CARD_WORDS,
  ]
    .join(" ")
    .toLowerCase();

  /** Every run of six characters of every token, checked against the text. */
  function leaks(text: string, tokens: readonly string[]): string[] {
    const lower = text.toLowerCase();
    const found = new Set<string>();
    for (const t of tokens) {
      const s = t.toLowerCase();
      for (let i = 0; i + 6 <= s.length; i++) {
        const run = s.slice(i, i + 6);
        // A run that is part of selfcheck's own fixed words is those words, not the estate's.
        if (OWN.includes(run)) continue;
        if (lower.includes(run)) found.add(`${run} (of ${t})`);
      }
    }
    return [...found];
  }

  it(
    "passing or failing, with the card and with --json",
    async () => {
      const { root, tokens } = await distinctive();
      expect(tokens.length).toBeGreaterThan(200);
      ranOnce(root, ["verify", NAMES.repos[0]!], 45_000);
      const outputs: string[] = [];
      const passing = await run(["selfcheck", "--root", root]);
      outputs.push([...passing.out, ...passing.err].join("\n"));
      outputs.push((await run(["selfcheck", "--json", "--root", root])).out.join("\n"));
      // Failing: every sentence, the closest shape and the words to make it.
      selfcheckHooks.unaccounted = (d) =>
        d.unaccounted.push(`${NAMES.repos[0]}: ${NAMES.files[1]}:23`);
      selfcheckHooks.second = (b) => ({
        ...b,
        manifest: {
          ...b.manifest,
          files: b.manifest.files.map((f, k) => (k === 0 ? { ...f, sha256: "e".repeat(64) } : f)),
        },
      });
      const failing = await run(["selfcheck", "--root", root]);
      expect(failing.code).toBe(1);
      expect(failing.out.filter((l) => l.startsWith("failed "))).toHaveLength(3);
      outputs.push([...failing.out, ...failing.err].join("\n"));
      const json = await run(["selfcheck", "--json", "--names", "--root", root]);
      outputs.push([...json.out, ...json.err].join("\n"));
      for (const text of outputs) expect(leaks(text, tokens), text).toEqual([]);
      // The check itself can see a leak: --names does print the estate's names, on screen.
      const named = await run(["selfcheck", "--names", "--root", root]);
      expect(leaks(named.out.join("\n"), tokens).length).toBeGreaterThan(0);
      expect(named.out.join("\n")).toContain(NAMES.repos[0]);
      // Every word of the card is one of the list's.
      const at = failing.out.indexOf(
        "Shape card: fixed words only; no name, id, path, hash or count of this estate.",
      );
      for (const l of failing.out.slice(at + 1))
        for (const w of l.split(/[\s:]+/).filter(Boolean)) expect(CARD_WORDS.has(w), w).toBe(true);
      expect(SHAPE_FLAGS.length).toBe(12);
      expect(CHECK_IDS).toHaveLength(4);
    },
    T,
  );
});
