import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAP_OUTLINE,
  MAP_READ_WHOLE,
  mapRecallStep,
  mapWriteStep,
} from "@maycombhq/assistant-files";
import {
  CanaryKey,
  canaryRate,
  parseCanaryReport,
  type CanaryKeyT,
  type Fact,
} from "@maycombhq/core";
import {
  canaryCheck,
  canaryCheckHere,
  canaryClean,
  canaryPlant,
  canaryRepoProblem,
  canaryReport,
  canaryScore,
  canaryView,
  rateWords,
  runHolding,
  silentSummary,
} from "../src/canary-commands.js";
import { main } from "../src/main.js";
import { metarepoStateDir } from "../src/user-state.js";

/**
 * atticus canary (plan item Z2, ADR 0196) on invented Forge repos, one per stack the templates
 * cover: plant a scratch copy outside the metarepo, read it (here by hand, as no model runs in
 * tests), check and score it, and write one report in the metarepo. Nothing else is written
 * there, nothing is fetched, and the copy goes whatever happens. The review's adversarial cases
 * (a repo name that climbs out, a key edited by hand, links in and around the run folder, files of
 * secrets) are here too.
 */

const FIX = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
const REPOS: Record<string, string> = {
  "forge-portal-bff": join(FIX, "canaries/repos/forge-portal-bff"),
  "forge-portal-ui": join(FIX, "forge/repos/forge-portal-ui"),
  "forge-appraise": join(FIX, "reachable/forge-appraise"),
};
const NOW = () => new Date("2026-11-11T10:00:00.000Z");

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
};

interface Here {
  top: string;
  root: string;
  env: NodeJS.ProcessEnv;
  scratch: string;
}

/** Every test's own folder (metarepo, state and scratch), removed once the file is done. */
const made: string[] = [];
afterAll(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true });
});

const manifestEntry = (id: string, type: string) =>
  [
    `  - id: ${id}`,
    `    url: https://git.example.com/forge/${id}.git`,
    `    type: ${type}`,
    "    owner: team-appraise",
    "    component: appraise",
    "    system: appraise",
    "",
  ].join("\n");

async function metarepo(): Promise<Here> {
  const top = await mkdtemp(join(tmpdir(), "atticus-canary-test-"));
  made.push(top);
  const root = join(top, "metarepo");
  await cp(join(FIX, "forge/metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
  await writeFile(join(root, "org-pack/sources.yaml"), "schemaVersion: 1\nwikis: []\n");
  const manifest = join(root, "org-pack/profiles/forge/repos.manifest.yaml");
  await writeFile(
    manifest,
    (await readFile(manifest, "utf8")) +
      manifestEntry("forge-appraise", "python-service") +
      manifestEntry("forge-tally", "go-service"),
  );
  for (const [repo, dir] of Object.entries(REPOS))
    await cp(dir, join(root, "workspace", repo), { recursive: true });
  await mkdir(join(root, "facts"), { recursive: true });
  for (const repo of Object.keys(REPOS))
    await cp(join(FIX, "canaries/facts", `${repo}.jsonl`), join(root, "facts", `${repo}.jsonl`));
  return {
    top,
    root,
    env: { XDG_STATE_HOME: join(top, "state") },
    scratch: join(top, "scratch"),
  };
}

const opts = (h: Here, x: Record<string, unknown> = {}) => ({
  by: "tom",
  now: NOW,
  env: h.env,
  scratch: h.scratch,
  ...x,
});

/** A repo's key file: its name and a digest of it, so names only case tells apart don't share one. */
const keyFile = (h: Here, repo: string) =>
  join(
    metarepoStateDir(h.root, h.env),
    "canaries",
    `${repo}.${createHash("sha256").update(repo).digest("hex").slice(0, 8)}.json`,
  );
const keyOf = async (h: Here, repo: string): Promise<CanaryKeyT> =>
  CanaryKey.parse(JSON.parse(await readFile(keyFile(h, repo), "utf8")));
/** The folder run folders are made in (second review of ADR 0196), and this metarepo's id. */
const readsOf = (h: Here) => join(h.scratch, "atticus-reads");
const idOf = (h: Here) => basename(metarepoStateDir(h.root, h.env)).slice(0, 8);
/** A key's run folder, its copy and its facts file, as the key names them by base name. */
const runOf = (h: Here, key: CanaryKeyT) => {
  const run = join(readsOf(h), key.run);
  return {
    run,
    copy: join(run, key.repo),
    prompt: join(run, "prompt.md"),
    facts: join(run, "facts.jsonl"),
  };
};

/** Every file under a folder, with a hash of its bytes. */
async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else
        out[relative(dir, p).split("\\").join("/")] = createHash("sha256")
          .update(await readFile(p))
          .digest("hex");
    }
  };
  await walk(dir);
  return out;
}

const exists = (p: string) =>
  lstat(p).then(
    () => true,
    () => false,
  );

/** A read that finds every planted item and leaves out every removed one: the copy's own facts. */
async function perfectRead(h: Here, repo: string, key: CanaryKeyT): Promise<string> {
  const { copy, facts: factsFile } = runOf(h, key);
  const facts = (await readFile(join(h.root, "facts", `${repo}.jsonl`), "utf8"))
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Fact)
    .filter((f) => !key.removed.some((r) => r.fact === f.id))
    .map((f) => {
      // a removed fact is no longer there to come from
      const { verified: _v, ...rest } = f as Fact & { from?: string };
      return rest.from && key.removed.some((r) => r.fact === rest.from)
        ? (({ from: _f, ...x }) => x)(rest)
        : rest;
    }) as Fact[];
  const lines = async (file: string) =>
    (await readFile(join(copy, ...file.split("/")), "utf8")).split("\n");
  const commit = facts[0]?.commit ?? "b0b0001";
  for (const p of key.planted) {
    const text = (await lines(p.file))[p.line - 1]!;
    const quoted = /"([^"]+)"/.exec(text)?.[1] ?? "";
    const words = p.needle.split("-").slice(0, 2).join("-");
    const base = { id: `${p.kind}.${p.needle}`, repo, commit, by: "assistant", conf: "declared" };
    const cite = (value: string) => ({ file: p.file, line: p.line, value, quote: text.trim() });
    if (p.kind === "config") {
      const k = p.claim.split(" ")[1]!;
      const value = text.includes(k) ? k : k.split(".").pop()!;
      facts.push({
        ...base,
        kind: "config",
        settingKind: "config",
        key: k,
        cite: cite(value),
      } as unknown as Fact);
    } else if (p.what === "entry")
      facts.push({
        ...base,
        kind: "entry",
        entryType: "rest",
        method: "GET",
        path: quoted,
        cite: cite(quoted),
      } as unknown as Fact);
    else if (p.what === "call")
      facts.push({
        ...base,
        kind: "call",
        callType: "rest",
        method: "GET",
        path: `/${words}/{id}`,
        cite: cite(`/${words}/`),
      } as unknown as Fact);
    else
      facts.push({
        ...base,
        kind: p.kind,
        ...(p.kind === "entry" ? { entryType: "event-topic" } : { callType: "event-topic" }),
        path: quoted,
        cite: cite(quoted),
      } as unknown as Fact);
  }
  const text = facts.map((f) => JSON.stringify(f)).join("\n") + "\n";
  await writeFile(factsFile, text);
  return text;
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Forge",
      "-c",
      "user.email=dev@forge.example",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, stdio: "pipe", encoding: "utf8" },
  );

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  // No network: a canary reads files only (CLAUDE.md rule 5).
  fetchSpy = vi.fn(() => {
    throw new Error("a canary made a network call");
  });
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("atticus canary", { timeout: 60_000 }, () => {
  it("plants the same copy for the same seed, outside the metarepo, with the map's own prompt that doesn't say what", async () => {
    const h = await metarepo();
    const before = await tree(h.root);
    const c = capture();
    expect(await canaryPlant(h.root, "forge-portal-bff", opts(h, { seed: "s1" }), c.io)).toBe(0);
    expect(c.err).toEqual([]);
    const a = await keyOf(h, "forge-portal-bff");
    const ra = runOf(h, a);
    const copyA = await tree(ra.copy);
    // second review of ADR 0196: a neutral name with this metarepo's id, in a folder of its own
    expect(a.run).toMatch(new RegExp(`^forge-portal-bff-${idOf(h)}-[A-Za-z0-9]{6}$`));
    expect(a.run).not.toMatch(/canary/i);
    expect(relative(h.root, ra.run).startsWith("..")).toBe(true);
    expect(await exists(join(ra.copy, ".git"))).toBe(false);
    if (process.platform !== "win32") expect((await stat(readsOf(h))).mode & 0o777).toBe(0o700);

    // The prompt is /atticus-map's protocol aimed at the copy: it names the folder of the copy
    // and the facts file by their names in the workspace alone (no absolute path, which named
    // the run folder), nothing planted or taken out, no metarepo and no test, and the check by
    // its neutral name; the map's recall loop is in it.
    const prompt = await readFile(ra.prompt, "utf8");
    expect(prompt).not.toContain(ra.run);
    expect(prompt).not.toContain(h.scratch);
    expect(prompt).not.toMatch(/(^|[\s(])\/(tmp|home|var|Users)\//m);
    expect(prompt).toContain("folder `forge-portal-bff` of this workspace");
    expect(prompt).toContain("`facts.jsonl` in this workspace");
    expect(prompt).toContain(MAP_OUTLINE);
    expect(prompt).toContain(MAP_READ_WHOLE);
    expect(prompt).toContain("Run `atticus verify --here`.");
    expect(prompt).toContain(
      mapRecallStep({
        lists: "`verify.yaml` in this workspace",
        reviewed: "`reviewed.jsonl` in this workspace",
        all: "`atticus verify --here --skipped`",
      }),
    );
    expect(prompt).not.toContain(h.root);
    expect(prompt).toContain(mapWriteStep());
    // its own words (the map's facts shape and rules aside): no scratch copy, nothing measured
    const own = prompt.replace(mapWriteStep(), "");
    expect(own).not.toMatch(/scratch|measur|canar|plant|\btest|copy/i);
    for (const p of a.planted)
      for (const w of p.needle.split("-"))
        if (!["updated", "viewed", "url"].includes(w))
          expect(prompt).not.toMatch(new RegExp(`\\b${w}\\b`));
    for (const r of a.removed) expect(prompt).not.toContain(r.fact);
    const said = c.out.join("\n");
    expect(said).not.toMatch(/spruce|nutmeg|plant:\d/);
    // The person opens the run folder itself as the workspace.
    expect(said).toContain(`code ${ra.run}`);
    expect(said).toContain(`cd ${ra.run} && claude`);
    expect(said).toContain(
      "It plants into spring (a route, a call, a topic listened to, a topic published, a config key).",
    );

    // Again with the same seed: it replaces the first, and plants the same bytes.
    const again = capture();
    expect(await canaryPlant(h.root, "forge-portal-bff", opts(h, { seed: "s1" }), again.io)).toBe(
      0,
    );
    expect(again.out[0]).toBe(
      "An earlier canary of forge-portal-bff wasn't scored: its copy is deleted.",
    );
    expect(await exists(ra.run)).toBe(false);
    const b = await keyOf(h, "forge-portal-bff");
    expect({ planted: b.planted, removed: b.removed }).toEqual({
      planted: a.planted,
      removed: a.removed,
    });
    expect(await tree(runOf(h, b).copy)).toEqual(copyA);
    // Another seed plants other names.
    await canaryPlant(h.root, "forge-portal-bff", opts(h, { seed: "s2" }), capture().io);
    expect((await keyOf(h, "forge-portal-bff")).planted.map((p) => p.needle)).not.toEqual(
      a.planted.map((p) => p.needle),
    );
    // The metarepo is as it was: a plant writes nothing there.
    expect(await tree(h.root)).toEqual(before);
  });

  it("draws the seed at random unless given, keeps it in the key, and the seed plants it again", async () => {
    const h = await metarepo();
    await canaryPlant(h.root, "forge-appraise", opts(h), capture().io);
    const a = await keyOf(h, "forge-appraise");
    await canaryPlant(h.root, "forge-appraise", opts(h), capture().io);
    const b = await keyOf(h, "forge-appraise");
    expect(a.seed).toMatch(/^[0-9a-f]{12}$/);
    expect(b.seed).not.toBe(a.seed);
    expect(a.seed).not.toContain("forge-appraise");
    await canaryPlant(h.root, "forge-appraise", opts(h, { seed: a.seed }), capture().io);
    const c = await keyOf(h, "forge-appraise");
    expect({ planted: c.planted, removed: c.removed, seed: c.seed }).toEqual({
      planted: a.planted,
      removed: a.removed,
      seed: a.seed,
    });
  });

  it("says what it covers and what the repo can't serve: a browser app gets no route and no topic", async () => {
    const h = await metarepo();
    const c = capture();
    expect(await canaryPlant(h.root, "forge-portal-ui", opts(h, { seed: "s1" }), c.io)).toBe(0);
    // second review of ADR 0196: a browser app has no process.env either
    expect(c.out).toContain("It plants into node (a call).");
    expect(c.out).toContain(
      "Not planted, as the repo can't serve them: a config key in node (a browser app (its package declares no server) has no process.env); a route in node (its package declares no server (express): a browser app serves no route); a topic listened to and a topic published in node (its package declares no Kafka client (kafkajs)).",
    );
    const key = await keyOf(h, "forge-portal-ui");
    expect(key.skipped.map((s) => s.what)).toEqual(["config", "entry", "topic-in", "topic-out"]);
    const copy = await tree(runOf(h, key).copy);
    expect(Object.keys(copy).sort()).toEqual([
      "package.json",
      "src/api/balance.ts",
      expect.stringMatching(/^src\/api\/[a-z]+-[a-z]+\.ts$/),
    ]);
  });

  for (const repo of Object.keys(REPOS))
    it(`${repo}: a read that finds every planted item and claims nothing removed scores perfect`, async () => {
      const h = await metarepo();
      const before = await tree(h.root);
      expect(await canaryPlant(h.root, repo, opts(h, { seed: "s1" }), capture().io)).toBe(0);
      const key = await keyOf(h, repo);
      await perfectRead(h, repo, key);
      const checked = capture();
      const code = await canaryCheck(h.root, repo, opts(h), checked.io);
      expect(checked.out[0]).toMatch(/none rejected, every line read/);
      // the recall loop's coverage, as atticus verify says it, and its lists in verify.yaml
      expect(checked.out[1]).toMatch(/^Coverage \d+% \(\d+ read, \d+ unknown\)\.$/);
      expect(await exists(join(runOf(h, key).run, "verify.yaml"))).toBe(true);
      expect(code).toBe(0);
      const c = capture();
      expect(await canaryScore(h.root, repo, opts(h), c.io)).toBe(0);
      expect(c.err).toEqual([]);
      // Only the report is new in the metarepo.
      const after = await tree(h.root);
      const added = Object.keys(after).filter((f) => !(f in before));
      expect(added).toEqual([`reports/canaries/2026-11-11-${repo}.yaml`]);
      expect(Object.keys(before).every((f) => after[f] === before[f])).toBe(true);
      const text = await readFile(join(h.root, added[0]!), "utf8");
      const r = parseCanaryReport(text);
      if (!r.ok) throw new Error(r.issues.join("\n"));
      expect(r.report.recall).toMatchObject({
        k: key.planted.length,
        n: key.planted.length,
        rate: 1,
      });
      expect(r.report.fabrication).toMatchObject({ k: 0, n: key.removed.length, rate: 0 });
      expect(r.report.passed.k).toBe(0);
      expect(r.report.seed).toBe("s1");
      expect(r.report.skipped).toEqual(key.skipped);
      // The copy, the facts and the key are gone.
      expect(await exists(runOf(h, key).run)).toBe(false);
      expect(await exists(keyFile(h, repo))).toBe(false);
      // The report holds no line of the repo's code, and nothing of what was planted but its
      // kind, stack and result: no word, file or line of it.
      expect(text).not.toMatch(/quote|@GetMapping|httpx\.|router\.get/);
      for (const p of key.planted) {
        for (const w of p.needle.split("-"))
          if (!["updated", "viewed", "url"].includes(w)) expect(text).not.toContain(w);
        // a file the plant made (a new class or module) is named only in the key
        if (!(await exists(join(REPOS[repo]!, p.file)))) expect(text).not.toContain(p.file);
      }
      expect(
        r.report.planted.every((p) => Object.keys(p).sort().join() === "id,kind,result,stack,what"),
      ).toBe(true);
    });

  it("scores the hand-written read of forge-portal-bff (seed s1): a miss and three caught, side by side with the audit", async () => {
    const h = await metarepo();
    await cp(
      join(FIX, "canaries/facts/forge-portal-bff.audit.yaml"),
      join(h.root, "facts/forge-portal-bff.audit.yaml"),
    );
    await canaryPlant(h.root, "forge-portal-bff", opts(h, { seed: "s1" }), capture().io);
    const key = await keyOf(h, "forge-portal-bff");
    const { run, facts } = runOf(h, key);
    await cp(join(FIX, "canaries/reads/forge-portal-bff.s1.jsonl"), facts);
    const checked = capture();
    expect(await canaryCheck(h.root, "forge-portal-bff", opts(h), checked.io)).toBe(1);
    expect(checked.out[0]).toBe(
      `10 kept, 3 rejected, 0 unread: read each rejected fact in ${join(run, "rejected.jsonl")} again, rewrite it or drop it, and check again.`,
    );
    // The fact whose `cite.with` part named only the commented-out route is caught now.
    expect(checked.out).toContainEqual(
      expect.stringMatching(/^ {2}call\.post\.transfers: claim-in-comment: .*part 2/),
    );
    const c = capture();
    expect(await canaryScore(h.root, "forge-portal-bff", opts(h), c.io)).toBe(0);
    expect(c.out).toContain(
      "  Planted: 5, in spring (a route, a call, a topic listened to, a topic published, a config key); found 4, rejected 0, missed 1. Recall 80% (4 of 5; 95% interval 37.6% to 96.4%).",
    );
    expect(c.out).toContain("    missed: a topic listened to (spring)");
    expect(c.out).toContain(
      "    rejected: call POST /ledger/v1/transfers (src/main/java/forge/portal/LedgerClient.java:11, commented out)",
    );
    // Two numbers, never pooled: the audit's 1 wrong of 9, and 0 of 3 lines passed through.
    const misread = `  Audit misread rate (real lines read wrongly, of the sample audit's answers; 1 repo): ${rateWords(canaryRate(1, 9))}.`;
    const passed = `  Canary pass-through rate (lines taken out, still claimed and kept by the verifier, of those taken out; 1 repo): ${rateWords(canaryRate(0, 3))}.`;
    expect(c.out).toContain(misread);
    expect(c.out).toContain(passed);
    expect(c.out.join("\n")).not.toMatch(/Silent error rate|of 14|of 13/);
    const r = parseCanaryReport(
      await readFile(join(h.root, "reports/canaries/2026-11-11-forge-portal-bff.yaml"), "utf8"),
    );
    if (!r.ok) throw new Error(r.issues.join("\n"));
    expect(r.report.planted.map((p) => p.result)).toEqual([
      "found",
      "found",
      "missed",
      "found",
      "found",
    ]);
    expect(r.report.removed.map((x) => [x.fact, x.result])).toEqual([
      ["call.post.transfers", "rejected"],
      ["config.ledger-client-read-timeout", "rejected"],
      ["entry.get.api-balance-accountid", "rejected"],
    ]);
    expect(r.report.fabrication).toMatchObject({ k: 3, n: 3 });
    expect(r.report.passed).toMatchObject({ k: 0, n: 3 });

    // The report on file, as atticus canary report and the app read it: the same two numbers.
    const rep = capture();
    expect(await canaryReport(h.root, opts(h), rep.io)).toBe(0);
    expect(rep.out).toContain(misread);
    expect(rep.out).toContain(passed);
    const files = await silentSummary(h.root, { join: false });
    expect(files.rate).toEqual((await silentSummary(h.root)).rate);
    // GET /api/trust/canaries: the same numbers, from the files.
    const view = await canaryView(h.root, h.env);
    expect(view.rates.misread).toMatchObject({ k: 1, n: 9 });
    expect(view.rates.passed).toMatchObject({ k: 0, n: 3 });
    expect(view.rates).not.toHaveProperty("silent");
    expect(view.latest).toEqual([
      expect.objectContaining({
        repo: "forge-portal-bff",
        path: "reports/canaries/2026-11-11-forge-portal-bff.yaml",
        planted: { n: 5, found: 4, rejected: 0, missed: 1 },
        removed: { n: 3, absent: 0, kept: 0, rejected: 3, elsewhere: 0 },
        covers: [{ stack: "spring", what: ["entry", "call", "topic-in", "topic-out", "config"] }],
        skipped: [],
      }),
    ]);
    expect(view.pending).toEqual([]);
  });

  it("with no canary on file, the CLI and the app give the audit's number by the same name", async () => {
    const h = await metarepo();
    await cp(
      join(FIX, "canaries/facts/forge-portal-bff.audit.yaml"),
      join(h.root, "facts/forge-portal-bff.audit.yaml"),
    );
    const rep = capture();
    await canaryReport(h.root, opts(h), rep.io);
    expect(rep.out).toContain(
      `  Audit misread rate (real lines read wrongly, of the sample audit's answers; 1 repo): ${rateWords(canaryRate(1, 9))}.`,
    );
    expect(rep.out).toContain(
      "  Canary pass-through rate (lines taken out, still claimed and kept by the verifier, of those taken out; 0 repos): not measured.",
    );
    const view = await canaryView(h.root, h.env);
    expect(view.rates.misread).toEqual((await silentSummary(h.root)).rate.misread);
    expect(view.rates.passed.n).toBe(0);
  });

  it("checks from inside the run folder with no metarepo named, and only there", async () => {
    const h = await metarepo();
    await canaryPlant(h.root, "forge-appraise", opts(h, { seed: "s1" }), capture().io);
    const key = await keyOf(h, "forge-appraise");
    const { run, copy } = runOf(h, key);
    await perfectRead(h, "forge-appraise", key);
    const c = capture();
    expect(await canaryCheckHere(join(copy, "app"), undefined, opts(h), c.io)).toBe(0);
    expect(c.out[0]).toMatch(/none rejected/);
    expect(await exists(join(run, "rejected.jsonl"))).toBe(true);
    const other = capture();
    expect(await canaryCheckHere(run, "forge-portal-ui", opts(h), other.io)).toBe(2);
    expect(other.err[0]).toBe(
      "This folder holds a read of forge-appraise, not of forge-portal-ui.",
    );
    const away = capture();
    expect(await canaryCheckHere(h.root, undefined, opts(h), away.io)).toBe(2);
    expect(away.err[0]).toBe(
      "This folder holds no read to check: run atticus verify --here in the folder its prompt.md is in.",
    );
  });

  // Third review of ADR 0196: `atticus verify --help` gave the canary away; the alias is named
  // only in canary check's own help.
  it("verify's help words --here neutrally; canary check's names the alias", async () => {
    const v = capture();
    expect(await main(["verify", "--help"], v.io)).toBe(0);
    const verify = v.out.join("\n");
    expect(verify).toContain(
      "atticus verify --here                Check facts.jsonl in this read folder against its copy",
    );
    expect(verify).not.toMatch(/canar|plant/i);
    const c = capture();
    expect(await main(["canary", "check", "--help"], c.io)).toBe(0);
    expect(c.out.join("\n")).toMatch(/there it is also atticus verify --here/);
  });

  // Second review of ADR 0196: the read's own check, by the name the prompt gives it, says
  // nothing of a canary, names the run's files by their names alone, and keeps the map's recall
  // loop: the coverage, the files unknown, and the lines no fact cites, as atticus verify says.
  it("atticus verify --here: the read's own check, the map's recall loop and nothing of a canary", async () => {
    const h = await metarepo();
    await canaryPlant(h.root, "forge-appraise", opts(h, { seed: "s1" }), capture().io);
    const key = await keyOf(h, "forge-appraise");
    const { run } = runOf(h, key);
    // nothing written yet: said without a word of a canary
    const early = capture();
    expect(await canaryCheckHere(run, undefined, opts(h), early.io)).toBe(2);
    expect(early.err).toEqual([
      "No facts in facts.jsonl yet: write them there, then run atticus verify --here again.",
    ]);
    // a read that leaves the planted call out: the line is listed under skipped, as verify lists it
    const text = await perfectRead(h, "forge-appraise", key);
    const call = key.planted.find((p) => p.what === "call")!;
    await writeFile(
      join(run, "facts.jsonl"),
      text
        .split("\n")
        .filter((l) => !l.includes(`"id":"call.${call.needle}"`))
        .join("\n"),
    );
    // and a file it found nothing in, reviewed
    await writeFile(
      join(run, "reviewed.jsonl"),
      JSON.stringify({ path: "app/schemas/parcel.py", why: "a model only" }) + "\n",
    );
    const c = capture();
    expect(await canaryCheckHere(run, undefined, opts(h, { skipped: true }), c.io)).toBe(0);
    const said = [...c.out, ...c.err].join("\n");
    expect(said).not.toMatch(/canar|plant|score|atticus-reads/i);
    expect(said).not.toContain(run);
    expect(c.out[0]).toMatch(/^\d+ kept, none rejected, every line read\.$/);
    expect(c.out).toContainEqual(
      expect.stringMatching(
        /^Coverage \d+% \(\d+ read, 1 reviewed with nothing to record, \d+ unknown\)\.$/,
      ),
    );
    expect(c.out).toContainEqual(
      expect.stringMatching(
        /^\d+ lines? of the files read writes? a path, URL or topic no fact cites \(a note for the reader to check, not a rejection; under skipped in verify\.yaml; atticus verify --here --skipped prints every one\):$/,
      ),
    );
    expect(c.out).toContainEqual(expect.stringContaining(`${call.file}:${call.line} `));
    const yaml = await readFile(join(run, "verify.yaml"), "utf8");
    expect(yaml).toMatch(/^coverage:/m);
    expect(yaml).toMatch(/^skipped:/m);
    expect(yaml).toContain("app/schemas/parcel.py");
    // by the dispatcher too: `atticus verify --here` from the run folder, with no metarepo
    const out: string[] = [];
    const cwd = process.cwd();
    const tmp = process.env.TMPDIR;
    process.chdir(run);
    // third review of ADR 0196: found by its own folders, whatever the temporary folder is now
    process.env.TMPDIR = join(h.top, "elsewhere");
    try {
      const code = await main(["verify", "--here"], {
        out: (l: string) => out.push(l),
        err: (l: string) => out.push(l),
      });
      expect(out.join("\n")).not.toMatch(/canar/i);
      expect(code).toBe(0);
    } finally {
      process.chdir(cwd);
      if (tmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = tmp;
    }
  });

  it("counts lines that don't read: check exits 1 on them, and score says how many it left out", async () => {
    const h = await metarepo();
    await canaryPlant(h.root, "forge-appraise", opts(h, { seed: "s1" }), capture().io);
    const key = await keyOf(h, "forge-appraise");
    const text = await perfectRead(h, "forge-appraise", key);
    await writeFile(runOf(h, key).facts, text + "not a fact\n");
    const checked = capture();
    expect(await canaryCheck(h.root, "forge-appraise", opts(h), checked.io)).toBe(1);
    expect(checked.out[0]).toMatch(
      /^\d+ kept, 0 rejected, 1 unread: fix or drop each line of .* that doesn't read \(below\), and check again\.$/,
    );
    expect(checked.out).toContainEqual(expect.stringMatching(/^ {2}line \d+: /));
    const c = capture();
    expect(await canaryScore(h.root, "forge-appraise", opts(h), c.io)).toBe(0);
    expect(c.out[0]).toMatch(/^1 line of .* didn't read as facts and is left out of the score:$/);
    const r = parseCanaryReport(
      await readFile(join(h.root, "reports/canaries/2026-11-11-forge-appraise.yaml"), "utf8"),
    );
    expect(r.ok && r.report.read.unread).toBe(1);
  });

  it("cleans the scratch copy when the score fails, keeps it when nothing reads, and a failed plant leaves nothing", async () => {
    const h = await metarepo();
    await canaryPlant(h.root, "forge-portal-ui", opts(h), capture().io);
    const key = await keyOf(h, "forge-portal-ui");
    const { run, copy, facts } = runOf(h, key);
    // No read yet: refused, and the copy is kept for the read.
    const early = capture();
    expect(await canaryScore(h.root, "forge-portal-ui", opts(h), early.io)).toBe(2);
    expect(early.err[0]).toMatch(/^No facts at .* yet: give the prompt to your assistant first/);
    expect(await exists(copy)).toBe(true);
    // A read of which nothing reads as facts: nothing to score, and the copy is kept to fix it.
    await writeFile(facts, "not a fact\n");
    const bad = capture();
    expect(await canaryScore(h.root, "forge-portal-ui", opts(h), bad.io)).toBe(2);
    expect(bad.err.at(-1)).toBe(
      "Nothing was scored, and the copy is kept: fix the file and run atticus canary score forge-portal-ui again (atticus canary clean forge-portal-ui deletes it).",
    );
    expect(await exists(copy)).toBe(true);
    expect(await exists(keyFile(h, "forge-portal-ui"))).toBe(true);
    expect(await exists(join(h.root, "reports"))).toBe(false);
    // clean deletes a planted one without scoring it; every one only with --all (second review
    // of ADR 0196: a bare clean, or `-rf` read as flags, cleaned them all)
    const which = capture();
    expect(await canaryClean(h.root, undefined, opts(h), which.io)).toBe(2);
    expect(which.err[0]).toMatch(/^Say which canary to delete/);
    expect(await exists(run)).toBe(true);
    const flags = capture();
    expect(await main(["canary", "clean", "-rf", "--root", h.root], flags.io)).toBe(2);
    expect(await exists(run)).toBe(true);
    const cleaned = capture();
    expect(await canaryClean(h.root, undefined, opts(h, { all: true }), cleaned.io)).toBe(0);
    expect(cleaned.out).toEqual(["Deleted 1 planted canary: 1 run folder and 1 key."]);
    expect(await exists(run)).toBe(false);
    // a key whose run folder is already gone is counted as a key, not a copy (second review)
    await canaryPlant(h.root, "forge-portal-ui", opts(h), capture().io);
    await rm(runOf(h, await keyOf(h, "forge-portal-ui")).run, { recursive: true });
    const gone = capture();
    expect(await canaryClean(h.root, "forge-portal-ui", opts(h), gone.io)).toBe(0);
    expect(gone.out).toEqual([
      "Deleted 1 planted canary: 0 run folders and 1 key (1 run folder was already gone).",
    ]);

    // A plant that throws half way leaves no run folder and no key.
    await expect(
      canaryPlant(
        h.root,
        "forge-portal-ui",
        opts(h, {
          planner: () => {
            throw new Error("boom");
          },
        }),
        capture().io,
      ),
    ).rejects.toThrow("boom");
    expect(await readdir(readsOf(h))).toEqual([]);
    expect(await exists(keyFile(h, "forge-portal-ui"))).toBe(false);
  });

  it("refuses a repo with no facts, with unverified facts, or with no template", async () => {
    const h = await metarepo();
    const none = capture();
    expect(await canaryPlant(h.root, "forge-ledger", opts(h), none.io)).toBe(2);
    expect(none.err[0]).toMatch(/^forge-ledger has no facts \(facts\/forge-ledger\.jsonl\)/);
    const file = join(h.root, "facts/forge-appraise.jsonl");
    await writeFile(
      file,
      (await readFile(file, "utf8")).replace(/"verified":"line"/g, '"verified":"none"'),
    );
    const unverified = capture();
    expect(await canaryPlant(h.root, "forge-appraise", opts(h), unverified.io)).toBe(2);
    expect(unverified.err[0]).toMatch(/^2 of forge-appraise's facts aren't verified yet/);
    // A Go repo: no template plants into it.
    await mkdir(join(h.root, "workspace/forge-tally"), { recursive: true });
    await writeFile(join(h.root, "workspace/forge-tally/go.mod"), "module forge/tally\n");
    await writeFile(
      join(h.root, "workspace/forge-tally/main.go"),
      'package main\n\nfunc main() {\n\thttp.HandleFunc("/tallies", tallies)\n}\n',
    );
    await writeFile(
      join(h.root, "facts/forge-tally.jsonl"),
      JSON.stringify({
        kind: "entry",
        id: "entry.get.tallies",
        repo: "forge-tally",
        commit: "c0c0001",
        entryType: "rest",
        method: "GET",
        path: "/tallies",
        cite: { file: "main.go", line: 4, value: "/tallies" },
        verified: "line",
        by: "assistant",
        conf: "declared",
      }) + "\n",
    );
    const go = capture();
    expect(await canaryPlant(h.root, "forge-tally", opts(h), go.io)).toBe(2);
    expect(go.err[0]).toMatch(/^Atticus has no template for forge-tally's code/);
    expect(await readdir(readsOf(h)).catch(() => [])).toEqual([]);
    expect(await exists(keyFile(h, "forge-tally"))).toBe(false);
  });

  it("refuses to plant into a temporary folder inside a git work tree, and notes a checkout off the facts' commit or with changes", async () => {
    const h = await metarepo();
    const inGit = join(h.top, "checkout");
    await mkdir(inGit, { recursive: true });
    git(inGit, "init", "-q");
    const c = capture();
    expect(
      await canaryPlant(h.root, "forge-appraise", opts(h, { scratch: join(inGit, "tmp") }), c.io),
    ).toBe(2);
    expect(c.err[0]).toMatch(
      /is inside a git work tree, where a copy could be committed or pushed/,
    );
    expect(await readdir(join(inGit, "tmp"))).toEqual([]);

    const ws = join(h.root, "workspace/forge-appraise");
    git(ws, "init", "-q");
    git(ws, "add", "-A");
    git(ws, "commit", "-q", "-m", "forge-appraise");
    await writeFile(join(ws, "NOTES.md"), "uncommitted\n");
    const w = capture();
    expect(await canaryPlant(h.root, "forge-appraise", opts(h), w.io)).toBe(0);
    expect(w.err).toEqual([
      expect.stringMatching(
        /^Note: forge-appraise's facts were read at a0a0001, and its checkout is at [0-9a-f]{12};/,
      ),
      "Note: forge-appraise's checkout has changes not committed; the copy holds them as they are.",
    ]);
  });
});

describe("atticus canary: the review's adversarial cases", { timeout: 60_000 }, () => {
  /** Folders a tampered key or a crafted name might reach: none may lose a file. */
  async function victims(h: Here) {
    const v = join(h.top, "victim");
    await mkdir(join(v, "atticus-canary-precious"), { recursive: true });
    await mkdir(join(v, "plain"), { recursive: true });
    await writeFile(join(v, "atticus-canary-precious/important.txt"), "keep\n");
    await writeFile(join(v, "plain/important.txt"), "keep\n");
    await writeFile(join(v, "plain/out.txt"), "keep\n");
    await writeFile(join(v, "package.json"), '{"name":"victim"}\n');
    return v;
  }
  const intact = async (v: string) => ({
    precious: await readFile(join(v, "atticus-canary-precious/important.txt"), "utf8"),
    plain: await readFile(join(v, "plain/important.txt"), "utf8"),
    out: await readFile(join(v, "plain/out.txt"), "utf8"),
    pkg: await readFile(join(v, "package.json"), "utf8"),
  });
  const KEEP = { precious: "keep\n", plain: "keep\n", out: "keep\n", pkg: '{"name":"victim"}\n' };

  it("refuses a repo name that climbs out of the key folder, in every command and in the dispatcher", async () => {
    const h = await metarepo();
    const v = await victims(h);
    const kdir = join(metarepoStateDir(h.root, h.env), "canaries");
    await mkdir(kdir, { recursive: true });
    const climb = relative(kdir, join(v, "package"));
    expect(climb).toMatch(/^\.\.\//);
    expect(await canaryRepoProblem(h.root, climb, h.env)).toMatch(/isn't a repo's name/);
    expect(await canaryRepoProblem(h.root, "forge-nowhere", h.env)).toBe(
      "forge-nowhere is no repo of this metarepo: it is in no manifest, and it has no facts here.",
    );
    expect(await canaryRepoProblem(h.root, "forge-portal-bff", h.env)).toBeUndefined();
    for (const run of [canaryClean, canaryScore, canaryCheck, canaryPlant]) {
      const c = capture();
      expect(await run(h.root, climb, opts(h), c.io)).toBe(2);
      expect(c.err[0]).toMatch(/isn't a repo's name/);
    }
    const c = capture();
    expect(await main(["canary", "clean", climb, "--root", h.root], c.io)).toBe(2);
    expect(c.err.join("\n")).toMatch(/isn't a repo's name/);
    expect(await intact(v)).toEqual(KEEP);
  });

  it("a key edited to name another folder deletes and writes nothing outside the temporary folder", async () => {
    const h = await metarepo();
    const v = await victims(h);
    await canaryPlant(h.root, "forge-portal-bff", opts(h, { seed: "adv" }), capture().io);
    const key = await keyOf(h, "forge-portal-bff");
    const { run } = runOf(h, key);
    const raw = JSON.parse(await readFile(keyFile(h, "forge-portal-bff"), "utf8"));
    for (const name of [
      join(v, "atticus-canary-precious"),
      join(v, "plain"),
      "../victim/atticus-canary-precious",
      join(v, "plain") + "/../atticus-canary-precious",
    ]) {
      await writeFile(keyFile(h, "forge-portal-bff"), JSON.stringify({ ...raw, run: name }));
      const c = capture();
      expect(await canaryCheck(h.root, "forge-portal-bff", opts(h), c.io)).toBe(2);
      expect(c.err[0]).toMatch(/^The key of forge-portal-bff's canary doesn't read/);
      expect(await exists(join(v, "plain/rejected.jsonl"))).toBe(false);
      expect(await intact(v)).toEqual(KEEP);
      // this metarepo's run folder of the repo, checked, went with the bad key
      expect(await exists(run)).toBe(false);
      expect(await readdir(readsOf(h))).toEqual([]);
      expect(await exists(keyFile(h, "forge-portal-bff"))).toBe(false);
      await canaryPlant(h.root, "forge-portal-bff", opts(h, { seed: "adv" }), capture().io);
    }
    // clean --all says so, and doesn't skip a bad key
    await writeFile(
      keyFile(h, "forge-portal-bff"),
      JSON.stringify({ ...raw, run: join(v, "atticus-canary-precious") }),
    );
    const c = capture();
    expect(await canaryClean(h.root, undefined, opts(h, { all: true }), c.io)).toBe(0);
    expect(c.out).toEqual([
      "The key of forge-portal-bff's canary didn't read: deleted it, and 1 run folder of forge-portal-bff's this metarepo planted (another metarepo's are never touched).",
    ]);
    expect(await readdir(readsOf(h))).toEqual([]);
    expect(await intact(v)).toEqual(KEEP);
    // score with a bad key: the same
    await canaryPlant(h.root, "forge-portal-bff", opts(h, { seed: "adv" }), capture().io);
    await writeFile(
      keyFile(h, "forge-portal-bff"),
      JSON.stringify({ ...raw, run: join(v, "plain") }),
    );
    expect(await canaryScore(h.root, "forge-portal-bff", opts(h), capture().io)).toBe(2);
    expect(await readdir(readsOf(h))).toEqual([]);
    expect(await intact(v)).toEqual(KEEP);
  });

  // Second review of ADR 0196 (S1): two metarepos, the same repo, the same machine. A key of one
  // that doesn't read (or that names the other's run) never takes the other's run folder.
  it("cleans only this metarepo's run folders, whatever its key says", async () => {
    const h = await metarepo();
    const root2 = join(h.top, "metarepo2");
    await cp(h.root, root2, { recursive: true });
    const h2: Here = { ...h, root: root2 };
    expect(idOf(h2)).not.toBe(idOf(h));
    await canaryPlant(h.root, "forge-portal-bff", opts(h), capture().io);
    const k1 = await keyOf(h, "forge-portal-bff");
    await canaryPlant(h2.root, "forge-portal-bff", opts(h2), capture().io);
    const k2 = await keyOf(h2, "forge-portal-bff");
    // the second's key broken: its clean takes its own run only
    await writeFile(keyFile(h2, "forge-portal-bff"), "{not json");
    const c = capture();
    expect(await canaryClean(h2.root, "forge-portal-bff", opts(h2), c.io)).toBe(0);
    expect(c.out[0]).toMatch(/deleted it, and 1 run folder of forge-portal-bff's this metarepo/);
    expect(await exists(runOf(h, k1).run)).toBe(true);
    expect(await exists(runOf(h2, k2).run)).toBe(false);
    // a key edited to name the other metarepo's run (a valid name, another id): not touched
    await canaryPlant(h2.root, "forge-portal-bff", opts(h2), capture().io);
    const raw = JSON.parse(await readFile(keyFile(h2, "forge-portal-bff"), "utf8"));
    await writeFile(keyFile(h2, "forge-portal-bff"), JSON.stringify({ ...raw, run: k1.run }));
    for (const run of [canaryCheck, canaryScore, canaryClean])
      await run(h2.root, "forge-portal-bff", opts(h2), capture().io);
    expect(await exists(runOf(h, k1).run)).toBe(true);
    // a plant over a broken key spares the other too
    await writeFile(keyFile(h2, "forge-portal-bff"), "{not json");
    expect(await canaryPlant(h2.root, "forge-portal-bff", opts(h2), capture().io)).toBe(0);
    expect(await exists(runOf(h, k1).run)).toBe(true);
    // a folder of this metarepo's name but not a run's shape (no copy, no prompt) stays too
    const odd = join(readsOf(h), `forge-portal-bff-${idOf(h)}-Odd123`);
    await mkdir(odd);
    await writeFile(keyFile(h, "forge-portal-bff"), "{not json");
    await canaryClean(h.root, "forge-portal-bff", opts(h), capture().io);
    expect(await exists(runOf(h, k1).run)).toBe(false);
    expect(await exists(odd)).toBe(true);
  });

  it("keeps a key per repo name, case and all", async () => {
    const h = await metarepo();
    expect(keyFile(h, "forge-API")).not.toBe(keyFile(h, "forge-api"));
    expect(basename(keyFile(h, "forge-API")).toLowerCase()).not.toBe(
      basename(keyFile(h, "forge-api")).toLowerCase(),
    );
  });

  it("makes no run folder in a reads folder another user could write to, or that is a link", async () => {
    if (process.platform === "win32") return;
    const h = await metarepo();
    const v = await victims(h);
    await mkdir(h.scratch, { recursive: true });
    await symlink(join(v, "plain"), readsOf(h));
    const c = capture();
    expect(await canaryPlant(h.root, "forge-appraise", opts(h), c.io)).toBe(2);
    expect(c.err.at(-1)).toMatch(/isn't a folder only you can write to/);
    expect(await intact(v)).toEqual(KEEP);
    expect((await readdir(join(v, "plain"))).sort()).toEqual(["important.txt", "out.txt"]);
    await rm(readsOf(h));
    // ours but opened up: closed again before anything is made in it
    await mkdir(readsOf(h), { mode: 0o777 });
    await chmod(readsOf(h), 0o777);
    expect(await canaryPlant(h.root, "forge-appraise", opts(h), capture().io)).toBe(0);
    expect((await stat(readsOf(h))).mode & 0o777).toBe(0o700);
  });

  it("a run folder that is a link is neither followed nor deleted through", async () => {
    const h = await metarepo();
    const v = await victims(h);
    await mkdir(readsOf(h), { recursive: true, mode: 0o700 });
    const name = `forge-portal-bff-${idOf(h)}-AbC123`;
    await symlink(join(v, "plain"), join(readsOf(h), name));
    await mkdir(dirname(keyFile(h, "forge-portal-bff")), { recursive: true });
    await writeFile(
      keyFile(h, "forge-portal-bff"),
      JSON.stringify({
        schema: 1,
        repo: "forge-portal-bff",
        seed: "adv",
        run: name,
        stacks: [],
        planted: [],
        removed: [],
        at: NOW().toISOString(),
      }),
    );
    for (const run of [canaryCheck, canaryScore, canaryClean]) {
      await run(h.root, "forge-portal-bff", opts(h), capture().io);
      expect(await intact(v)).toEqual(KEEP);
      expect(await exists(join(v, "plain/rejected.jsonl"))).toBe(false);
    }
    // the link itself is left: it isn't a run folder Atticus made
    expect((await lstat(join(readsOf(h), name))).isSymbolicLink()).toBe(true);
  });

  // Third review of ADR 0196: the run folder was found again through tmpdir(), so a different
  // TMPDIR broke `verify --here` and made check and score delete the key and orphan the copy.
  it("finds a run through its key under another temporary folder, and never orphans its copy", async () => {
    const h = await metarepo();
    await canaryPlant(h.root, "forge-portal-bff", opts(h, { seed: "s1" }), capture().io);
    const key = await keyOf(h, "forge-portal-bff");
    expect(key.reads).toBe(await realpath(readsOf(h)));
    const { run, facts } = runOf(h, key);
    await cp(join(FIX, "canaries/reads/forge-portal-bff.s1.jsonl"), facts);
    const elsewhere = opts(h, { scratch: join(h.top, "elsewhere") });
    // check, from the metarepo, by the key's reads folder
    const c = capture();
    expect(await canaryCheck(h.root, "forge-portal-bff", elsewhere, c.io)).toBe(1);
    expect(await exists(keyFile(h, "forge-portal-bff"))).toBe(true);
    // `--here`, by the folder it is run in: a parent named atticus-reads, this user's, closed
    const deep = join(run, "forge-portal-bff", "src");
    expect(await runHolding(deep)).toEqual({ dir: run, repo: "forge-portal-bff" });
    expect(await runHolding(h.top)).toBeUndefined();
    if (process.platform !== "win32") {
      // a reads folder opened to others can't be trusted: nothing read or deleted, the key kept
      await chmod(readsOf(h), 0o777);
      expect(await runHolding(deep)).toBeUndefined();
      // each message names the key file and how to remove it (fourth review: clean keeps it too)
      const kept = keyFile(h, "forge-portal-bff");
      const wayOut = `chmod 700 ${await realpath(readsOf(h))}`;
      for (const cmd of [canaryCheck, canaryScore]) {
        const r = capture();
        expect(await cmd(h.root, "forge-portal-bff", elsewhere, r.io)).toBe(2);
        const said = r.err.join("\n");
        expect(said).toMatch(/isn't a folder only you can write to now/);
        expect(said).toContain(`the key is kept, at ${kept}`);
        expect(said).toContain(wayOut);
        expect(said).toContain(`then the key: rm ${kept}`);
        expect(said).not.toMatch(/atticus canary clean/);
      }
      const cl = capture();
      expect(await canaryClean(h.root, "forge-portal-bff", elsewhere, cl.io)).toBe(0);
      expect(cl.out.join("\n")).toMatch(/Kept the key of forge-portal-bff's canary, at /);
      expect(cl.out.join("\n")).toContain(`then the key: rm ${kept}`);
      const pl = capture();
      expect(await canaryPlant(h.root, "forge-portal-bff", elsewhere, pl.io)).toBe(2);
      expect(pl.err.join("\n")).toContain(`then the key: rm ${kept}`);
      expect(await exists(keyFile(h, "forge-portal-bff"))).toBe(true);
      expect(await exists(run)).toBe(true);
      await chmod(readsOf(h), 0o700);
    }
    // score, from another temporary folder: scored, and its own copy deleted
    const sc = capture();
    expect(await canaryScore(h.root, "forge-portal-bff", elsewhere, sc.io), sc.err.join("\n")).toBe(
      0,
    );
    expect(await exists(run)).toBe(false);
    expect(await exists(keyFile(h, "forge-portal-bff"))).toBe(false);
  });

  // Fourth review of ADR 0196: a reads folder that is gone (a reboot cleared /tmp, tmpfiles aged
  // it out, macOS cleaned /var/folders) took its run with it. The key went untrusted and stuck:
  // plant, check and score exited 2 and clean kept it. Gone is no run; the key goes.
  it("recovers when the reads folder is gone: check, score, clean and plant delete the key", async () => {
    const h = await metarepo();
    const plant = () => canaryPlant(h.root, "forge-portal-bff", opts(h), capture().io);
    const wipe = () => rm(readsOf(h), { recursive: true, force: true });
    // check
    expect(await plant()).toBe(0);
    await wipe();
    const c = capture();
    expect(await canaryCheck(h.root, "forge-portal-bff", opts(h), c.io)).toBe(2);
    expect(c.err).toEqual([
      `The run folder of forge-portal-bff's canary isn't there any more: ${await realpath(h.scratch).then((t) => join(t, "atticus-reads"))} is gone (a restart or the system's cleaning of the temporary folder takes it). Its key is deleted. Plant it again: atticus canary plant forge-portal-bff. (A session that still sees that folder, such as a service with a /tmp of its own, deletes the run folder there with atticus canary clean --all.)`,
    ]);
    expect(await exists(keyFile(h, "forge-portal-bff"))).toBe(false);
    // score
    expect(await plant()).toBe(0);
    await wipe();
    const s = capture();
    expect(await canaryScore(h.root, "forge-portal-bff", opts(h), s.io)).toBe(2);
    expect(s.err[0]).toMatch(/is gone .*Its key is deleted/);
    expect(await exists(keyFile(h, "forge-portal-bff"))).toBe(false);
    // clean, and clean --all: the key counted, its run folder already gone
    for (const how of [{ repo: "forge-portal-bff" }, { all: true }] as const) {
      expect(await plant()).toBe(0);
      await wipe();
      const cl = capture();
      expect(
        await canaryClean(
          h.root,
          "repo" in how ? how.repo : undefined,
          opts(h, "all" in how ? { all: true } : {}),
          cl.io,
        ),
      ).toBe(0);
      expect(cl.out).toEqual([
        "Deleted 1 planted canary: 0 run folders and 1 key (1 run folder was already gone).",
      ]);
      expect(await exists(keyFile(h, "forge-portal-bff"))).toBe(false);
    }
    // plant over it: the earlier key goes, and a new run is made
    expect(await plant()).toBe(0);
    await wipe();
    const p = capture();
    expect(await canaryPlant(h.root, "forge-portal-bff", opts(h), p.io), p.err.join("\n")).toBe(0);
    expect(p.out[0]).toBe(
      "An earlier canary of forge-portal-bff wasn't scored: its run folder wasn't there any more, and its key is deleted.",
    );
    const key = await keyOf(h, "forge-portal-bff");
    expect(await exists(runOf(h, key).run)).toBe(true);
    // fifth review: the whole temporary folder gone is no proof the run went (a drive not
    // mounted looks the same), so that key is kept; see the test below
  });

  // Fifth review of ADR 0196: a reads folder that isn't there is no proof its run went. The run
  // may be reached by another path (found by its name in this temporary folder's reads folder),
  // on a drive not mounted now, or (a key an earlier version wrote, with no reads folder) under
  // another TMPDIR. Only what was seen not to be there is said to be gone.
  it("keeps a key whose run it can't place, and finds a run by its name in this temporary folder", async () => {
    const h = await metarepo();
    const R = "forge-portal-bff";
    const setReads = async (reads: string | undefined) => {
      const raw = JSON.parse(await readFile(keyFile(h, R), "utf8"));
      if (reads === undefined) delete raw.reads;
      else raw.reads = reads;
      await writeFile(keyFile(h, R), JSON.stringify(raw));
    };
    // the key's reads folder isn't there, and the run is in this temporary folder's: found
    await canaryPlant(h.root, R, opts(h), capture().io);
    const { run, facts } = runOf(h, await keyOf(h, R));
    await cp(join(FIX, "canaries/reads/forge-portal-bff.s1.jsonl"), facts);
    await mkdir(join(h.top, "was-tmp"));
    await setReads(join(h.top, "was-tmp", "atticus-reads"));
    expect(await canaryCheck(h.root, R, opts(h), capture().io)).toBe(1);
    expect(await exists(keyFile(h, R))).toBe(true);
    const sc = capture();
    expect(await canaryScore(h.root, R, opts(h), sc.io), sc.err.join("\n")).toBe(0);
    expect(await exists(run)).toBe(false);
    expect(await exists(keyFile(h, R))).toBe(false);

    // a drive not mounted: neither the reads folder nor the folder it was made in is there, and
    // the run isn't in this temporary folder's. Every command keeps the key and says how to go on.
    await canaryPlant(h.root, R, opts(h), capture().io);
    const away = runOf(h, await keyOf(h, R)).run;
    const unmounted = join(h.top, "drive", "tmp", "atticus-reads");
    await setReads(unmounted);
    const elsewhere = opts(h, { scratch: join(h.top, "elsewhere") });
    const kept = keyFile(h, R);
    for (const cmd of [canaryCheck, canaryScore, canaryPlant]) {
      const c = capture();
      expect(await cmd(h.root, R, elsewhere, c.io)).toBe(2);
      const said = c.err.join("\n");
      expect(said).toContain(
        `which can't be reached now (${dirname(unmounted)} isn't there either`,
      );
      expect(said).toContain(`the key is kept, at ${kept}`);
      expect(said).toContain(`rm ${kept}`);
      expect(said).not.toMatch(/already gone|key is deleted|copy is deleted/);
    }
    const cl = capture();
    expect(await canaryClean(h.root, R, elsewhere, cl.io)).toBe(0);
    expect(cl.out.join("\n")).toContain(`the key is kept, at ${kept}`);
    expect(cl.out.join("\n")).not.toMatch(/already gone|Deleted/);
    expect(await exists(kept)).toBe(true);
    expect(await exists(away)).toBe(true);

    // a key an earlier version wrote (no reads folder): under another temporary folder its run
    // isn't found, and the key is kept; in its own temporary folder it is found and used
    await setReads(undefined);
    for (const cmd of [canaryCheck, canaryScore]) {
      const c = capture();
      expect(await cmd(h.root, R, elsewhere, c.io)).toBe(2);
      const said = c.err.join("\n");
      expect(said).toContain(
        `The key of ${R}'s canary, at ${kept}, was written by an earlier version`,
      );
      expect(said).toContain(`rm ${kept}`);
    }
    const legacy = capture();
    expect(await canaryClean(h.root, R, elsewhere, legacy.io)).toBe(0);
    expect(legacy.out.join("\n")).toMatch(/was written by an earlier version/);
    expect(await exists(kept)).toBe(true);
    expect(await exists(away)).toBe(true);
    const own = capture();
    expect(await canaryClean(h.root, R, opts(h), own.io)).toBe(0);
    expect(own.out).toEqual(["Deleted 1 planted canary: 1 run folder and 1 key."]);
    expect(await exists(away)).toBe(false);

    // the whole temporary folder gone, the key's reads folder with it: kept, as for a drive
    await canaryPlant(h.root, R, opts(h), capture().io);
    await rm(h.scratch, { recursive: true, force: true });
    const c = capture();
    expect(await canaryCheck(h.root, R, opts(h), c.io)).toBe(2);
    expect(c.err.join("\n")).toMatch(/can't be reached now/);
    expect(await exists(kept)).toBe(true);

    // a link where the run folder was: nothing in it touched, the key deleted, and said so
    await mkdir(readsOf(h), { recursive: true, mode: 0o700 });
    await canaryPlant(h.root, R, opts(h), capture().io);
    expect(await exists(kept)).toBe(true);
    const k2 = await keyOf(h, R);
    const target = join(h.top, "target");
    await mkdir(target);
    await rm(runOf(h, k2).run, { recursive: true });
    await symlink(target, runOf(h, k2).run);
    const ln = capture();
    expect(await canaryClean(h.root, R, opts(h), ln.io)).toBe(0);
    expect(ln.out).toEqual([
      "Deleted 1 planted canary: 0 run folders and 1 key (1 wasn't a real folder (a link or a file), left as it was).",
    ]);
    expect(await exists(target)).toBe(true);
  });

  // Sixth review of ADR 0196: a plant over a key that didn't read said "its run folder wasn't a
  // real folder"; a kept key's words said "isn't there" of a folder that is there, or a link.
  it("says what it found: a key that didn't read, a link above the reads folder, a reads folder not trusted", async () => {
    const h = await metarepo();
    const R = "forge-portal-bff";
    await canaryPlant(h.root, R, opts(h), capture().io);
    const first = runOf(h, await keyOf(h, R)).run;
    await writeFile(keyFile(h, R), "{not json");
    const p = capture();
    expect(await canaryPlant(h.root, R, opts(h), p.io), p.err.join("\n")).toBe(0);
    expect(p.out[0]).toBe(
      `An earlier canary of ${R} wasn't scored: its key didn't read, and is deleted, with 1 run folder of ${R}'s this metarepo planted.`,
    );
    expect(await exists(first)).toBe(false);
    // no run folder of its left: the key alone goes, and nothing is said of a folder
    await rm(runOf(h, await keyOf(h, R)).run, { recursive: true, force: true });
    await writeFile(keyFile(h, R), "{not json");
    const q = capture();
    expect(await canaryPlant(h.root, R, opts(h), q.io), q.err.join("\n")).toBe(0);
    expect(q.out[0]).toBe(
      `An earlier canary of ${R} wasn't scored: its key didn't read, and is deleted.`,
    );

    const setReads = async (reads: string | undefined) => {
      const raw = JSON.parse(await readFile(keyFile(h, R), "utf8"));
      if (reads === undefined) delete raw.reads;
      else raw.reads = reads;
      await writeFile(keyFile(h, R), JSON.stringify(raw));
    };
    const elsewhere = opts(h, { scratch: join(h.top, "elsewhere") });
    const said = async () => {
      const c = capture();
      expect(await canaryCheck(h.root, R, elsewhere, c.io)).toBe(2);
      return c.err.join("\n");
    };
    // the folder the reads folder was made in is a file: no "isn't there either"
    const file = join(h.top, "a-file");
    await writeFile(file, "");
    await setReads(join(file, "atticus-reads"));
    const notFolder = await said();
    expect(notFolder).toContain(
      `(${file} isn't a real folder (a link or a file is at its path): a drive not mounted`,
    );
    expect(notFolder).not.toContain("isn't there either");
    if (process.platform !== "win32") {
      // a link to nowhere, likewise
      const dangling = join(h.top, "dangling");
      await symlink(join(h.top, "nowhere"), dangling);
      await setReads(join(dangling, "atticus-reads"));
      expect(await said()).toContain(`(${dangling} isn't a real folder (a link or a file`);
    }
    // an earlier version's key, no reads folder: this temporary folder's absent, there but not
    // trusted, or looked in
    await setReads(undefined);
    const away = join(h.top, "elsewhere", "atticus-reads");
    expect(await said()).toContain(`and ${away} isn't there to look in:`);
    await mkdir(away, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") {
      await chmod(away, 0o777);
      expect(await said()).toContain(
        `and ${away} isn't a folder only you can write to (another user's, a link, or open to others), so it isn't looked in:`,
      );
      await chmod(away, 0o700);
    }
    expect(await said()).toContain(`and it isn't in ${await realpath(away)}:`);
  });

  it("clean --all sweeps this metarepo's run folders no key names, wherever its keys said", async () => {
    const h = await metarepo();
    const root2 = join(h.top, "metarepo2");
    await cp(h.root, root2, { recursive: true });
    const h2: Here = { ...h, root: root2 };
    await canaryPlant(h.root, "forge-portal-bff", opts(h), capture().io);
    const orphan = runOf(h, await keyOf(h, "forge-portal-bff")).run;
    // its key lost before its copy: the run folder no key names
    await rm(keyFile(h, "forge-portal-bff"));
    await canaryPlant(h.root, "forge-appraise", opts(h), capture().io);
    const live = runOf(h, await keyOf(h, "forge-appraise")).run;
    // another metarepo's run in the same reads folder, and a folder of this one's name not a run's shape
    await canaryPlant(h2.root, "forge-portal-bff", opts(h2), capture().io);
    const other = runOf(h2, await keyOf(h2, "forge-portal-bff")).run;
    const odd = join(readsOf(h), `forge-portal-bff-${idOf(h)}-Odd123`);
    await mkdir(odd);
    // fourth review: a run folder no key names yet that changed in the last ten minutes may be a
    // plant running now, so it is left; the orphan has been there longer
    const old = new Date(Date.now() - 11 * 60 * 1000);
    await utimes(orphan, old, old);
    const young = join(readsOf(h), `forge-portal-ui-${idOf(h)}-Young1`);
    await mkdir(join(young, "forge-portal-ui"), { recursive: true });
    await writeFile(join(young, "prompt.md"), "read\n");
    // from a temporary folder that holds no reads folder: the key says where
    const c = capture();
    const all = opts(h, { scratch: join(h.top, "elsewhere"), all: true });
    expect(await canaryClean(h.root, undefined, all, c.io)).toBe(0);
    expect(c.out).toEqual([
      "Deleted 1 planted canary: 1 run folder and 1 key.",
      "Deleted 1 run folder this metarepo planted that no key named any more.",
    ]);
    expect(await exists(live)).toBe(false);
    expect(await exists(orphan)).toBe(false);
    expect(await exists(young)).toBe(true);
    await utimes(young, old, old);
    const again = capture();
    expect(await canaryClean(h.root, undefined, opts(h, { all: true }), again.io)).toBe(0);
    expect(again.out).toEqual([
      "Deleted 1 run folder this metarepo planted that no key named any more.",
    ]);
    expect(await exists(young)).toBe(false);
    expect(await exists(other)).toBe(true);
    expect(await exists(odd)).toBe(true);
    // a repo's own clean sweeps nothing else
    await canaryPlant(h.root, "forge-portal-bff", opts(h), capture().io);
    const kept = runOf(h, await keyOf(h, "forge-portal-bff")).run;
    await rm(keyFile(h, "forge-portal-bff"));
    await canaryPlant(h.root, "forge-appraise", opts(h), capture().io);
    await canaryClean(h.root, "forge-appraise", opts(h), capture().io);
    expect(await exists(kept)).toBe(true);
  });

  it("links the read drops in the run folder aren't followed: not by check, score or clean", async () => {
    const h = await metarepo();
    const v = await victims(h);
    await canaryPlant(h.root, "forge-portal-bff", opts(h, { seed: "adv" }), capture().io);
    const key = await keyOf(h, "forge-portal-bff");
    const { run, copy, facts } = runOf(h, key);
    await symlink(join(v, "plain"), join(run, "evil-dir"));
    await symlink(join(v, "plain/important.txt"), join(copy, "evil-file"));
    // rejected.jsonl as a link: check replaces the link, never writes through it
    await symlink(join(v, "plain/out.txt"), join(run, "rejected.jsonl"));
    await cp(join(FIX, "canaries/reads/forge-portal-bff.s1.jsonl"), facts);
    expect(await canaryCheck(h.root, "forge-portal-bff", opts(h), capture().io)).toBe(1);
    expect(await intact(v)).toEqual(KEEP);
    expect((await lstat(join(run, "rejected.jsonl"))).isSymbolicLink()).toBe(false);
    // the facts file as a link: refused, not read through
    await rm(facts);
    await symlink(join(v, "plain/important.txt"), facts);
    const c = capture();
    expect(await canaryScore(h.root, "forge-portal-bff", opts(h), c.io)).toBe(2);
    expect(c.err[0]).toMatch(/isn't a plain file \(a link\?\)/);
    await canaryClean(h.root, "forge-portal-bff", opts(h), capture().io);
    expect(await exists(run)).toBe(false);
    expect(await intact(v)).toEqual(KEEP);
  });

  it("copies no file of secrets or credentials, no link and no file with a second name", async () => {
    const h = await metarepo();
    const v = await victims(h);
    const ws = join(h.root, "workspace/forge-portal-bff");
    const secrets = [
      ".env",
      ".env.prod",
      "prod.env",
      ".npmrc",
      ".pypirc",
      ".netrc",
      ".git-credentials",
      "kubeconfig",
      "id_rsa",
      "server.key",
      "server.pem",
      "credentials.json",
      "service-account.json",
      "secrets.yaml",
      "terraform.tfvars",
      "terraform.tfstate",
      ".htpasswd",
      "keystore.jks",
      "src/main/resources/application-secrets.yml",
      ".docker/config.json",
      ".kube/config",
      ".aws/credentials",
      ".ssh/id_rsa",
      "deploy/key.p8",
      "vault.kdbx",
      // second review of ADR 0196: the reviewer's list
      ".envrc",
      ".pgpass",
      ".my.cnf",
      ".s3cfg",
      ".boto",
      ".vault-token",
      "local.settings.json",
      "secrets.json",
      "appsettings.Secrets.json",
      "id_rsa.ppk",
      "prod.ovpn",
      "signing.gpg",
      "priv.asc",
      "host.keytab",
      ".dockercfg",
      ".terraformrc",
      "credentials.tfrc.json",
      ".gradle/gradle.properties",
      "settings-security.xml",
      ".cargo/credentials",
      ".config/gh/hosts.yml",
      ".netrc.bak",
      ".ssh/config",
      ".git-credentials.old",
      "auth.json",
      ".yarnrc",
      ".bowerrc",
      "wallet.dat",
      "sa-key.json",
      "gcp-key.json",
      "firebase-adminsdk.json",
      "client_secret_123.apps.googleusercontent.com.json",
    ];
    for (const f of secrets) {
      await mkdir(dirname(join(ws, f)), { recursive: true });
      await writeFile(join(ws, f), `SECRETFILE ${f}\n`);
    }
    // a secret by what the file holds, whatever it is named (built here: no key in the repo)
    const dash = "-".repeat(5);
    const byContent = {
      "src/main/resources/signing.txt": `${dash}BEGIN PRIVATE KEY${dash}\nSECRETFILE\n`,
      "config/cloud.ini": "[default]\naws_secret_access_key = SECRETFILE\n",
      "deploy/ledger.json": '{"type": "service_account", "private_key": "SECRETFILE"}\n',
      "web/registry.cfg": ["//registry.forge.example/:_auth", "Token=SECRETFILE\n"].join(""),
    };
    for (const [f, t] of Object.entries(byContent)) {
      await mkdir(dirname(join(ws, f)), { recursive: true });
      await writeFile(join(ws, f), t);
    }
    secrets.push(...Object.keys(byContent));
    await writeFile(join(v, "secret.txt"), "OUTSIDE-SECRET\n");
    await symlink(join(v, "secret.txt"), join(ws, "src/main/resources/leak.txt"));
    await symlink(v, join(ws, "linkdir"));
    await link(join(v, "secret.txt"), join(ws, "hardleak.txt"));
    expect(
      await canaryPlant(h.root, "forge-portal-bff", opts(h, { seed: "s1" }), capture().io),
    ).toBe(0);
    const { copy } = runOf(h, await keyOf(h, "forge-portal-bff"));
    const files = Object.keys(await tree(copy));
    const leaked: string[] = [];
    for (const f of files) {
      const t = await readFile(join(copy, f), "utf8");
      if (/OUTSIDE-SECRET|SECRETFILE/.test(t)) leaked.push(f);
    }
    expect(leaked).toEqual([]);
    for (const f of [...secrets, "hardleak.txt", "src/main/resources/leak.txt"])
      expect(files, f).not.toContain(f);
    expect(files.some((f) => f.startsWith("linkdir"))).toBe(false);
    // and the plant is the same as without them
    expect((await stat(join(copy, "pom.xml"))).isFile()).toBe(true);
  });
});
