import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAP_OUTLINE, MAP_READ_WHOLE, mapWriteStep } from "@maycombhq/assistant-files";
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

const keyFile = (h: Here, repo: string) =>
  join(metarepoStateDir(h.root, h.env), "canaries", `${repo}.json`);
const keyOf = async (h: Here, repo: string): Promise<CanaryKeyT> =>
  CanaryKey.parse(JSON.parse(await readFile(keyFile(h, repo), "utf8")));
/** A key's run folder, its copy and its facts file, as the key names them by base name. */
const runOf = (h: Here, key: CanaryKeyT) => {
  const run = join(h.scratch, key.run);
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
    expect(a.run).toMatch(/^atticus-canary-forge-portal-bff-[A-Za-z0-9]{6}$/);
    expect(relative(h.root, ra.run).startsWith("..")).toBe(true);
    expect(await exists(join(ra.copy, ".git"))).toBe(false);

    // The prompt is /atticus-map's protocol aimed at the copy: it names the copy and the facts
    // file, and nothing planted or taken out, no metarepo and no test.
    const prompt = await readFile(ra.prompt, "utf8");
    expect(prompt).toContain(ra.copy);
    expect(prompt).toContain(ra.facts);
    expect(prompt).toContain(MAP_OUTLINE);
    expect(prompt).toContain(MAP_READ_WHOLE);
    expect(prompt).toContain("Run `atticus canary check forge-portal-bff`.");
    expect(prompt).not.toContain(h.root);
    expect(prompt).toContain(mapWriteStep());
    // its own words (the map's facts shape and rules aside): no scratch copy, nothing measured
    const own = prompt
      .split(ra.run)
      .join("<run>")
      .replace(mapWriteStep(), "")
      .replace(/atticus canary check/g, "<check>");
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
    expect(c.out).toContain("It plants into node (a call, a config key).");
    expect(c.out).toContain(
      "Not planted, as the repo can't serve them: a route in node (the build files declare no server (express): a browser app serves no route); a topic listened to and a topic published in node (the build files declare no Kafka client (kafkajs)).",
    );
    const key = await keyOf(h, "forge-portal-ui");
    expect(key.skipped.map((s) => s.what)).toEqual(["entry", "topic-in", "topic-out"]);
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
      expect(checked.out).toEqual([expect.stringMatching(/none rejected, every line read/)]);
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
      "This is the run folder of forge-appraise's canary, not forge-portal-ui's.",
    );
    const away = capture();
    expect(await canaryCheckHere(h.root, undefined, opts(h), away.io)).toBe(2);
    expect(away.err[0]).toMatch(/^This folder is in no canary's run folder/);
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
    // clean deletes a planted one without scoring it.
    const cleaned = capture();
    expect(await canaryClean(h.root, undefined, opts(h), cleaned.io)).toBe(0);
    expect(cleaned.out).toEqual(["Deleted 1 planted canary copy."]);
    expect(await exists(run)).toBe(false);

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
    expect(await readdir(h.scratch)).toEqual([]);
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
    expect(await readdir(h.scratch).catch(() => [])).toEqual([]);
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
      // the repo's own run folders, checked, went with the bad key
      expect(await exists(run)).toBe(false);
      expect(await readdir(h.scratch)).toEqual([]);
      expect(await exists(keyFile(h, "forge-portal-bff"))).toBe(false);
      await canaryPlant(h.root, "forge-portal-bff", opts(h, { seed: "adv" }), capture().io);
    }
    // clean with no repo says so, and doesn't skip a bad key
    await writeFile(
      keyFile(h, "forge-portal-bff"),
      JSON.stringify({ ...raw, run: join(v, "atticus-canary-precious") }),
    );
    const c = capture();
    expect(await canaryClean(h.root, undefined, opts(h), c.io)).toBe(0);
    expect(c.out).toEqual([
      "The key of forge-portal-bff's canary didn't read: deleted it, and 1 run folder of forge-portal-bff's.",
    ]);
    expect(await readdir(h.scratch)).toEqual([]);
    expect(await intact(v)).toEqual(KEEP);
    // score with a bad key: the same
    await canaryPlant(h.root, "forge-portal-bff", opts(h, { seed: "adv" }), capture().io);
    await writeFile(
      keyFile(h, "forge-portal-bff"),
      JSON.stringify({ ...raw, run: join(v, "plain") }),
    );
    expect(await canaryScore(h.root, "forge-portal-bff", opts(h), capture().io)).toBe(2);
    expect(await readdir(h.scratch)).toEqual([]);
    expect(await intact(v)).toEqual(KEEP);
  });

  it("a run folder that is a link is neither followed nor deleted through", async () => {
    const h = await metarepo();
    const v = await victims(h);
    await mkdir(h.scratch, { recursive: true });
    const name = "atticus-canary-forge-portal-bff-AbC123";
    await symlink(join(v, "plain"), join(h.scratch, name));
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
    expect((await lstat(join(h.scratch, name))).isSymbolicLink()).toBe(true);
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
    ];
    for (const f of secrets) {
      await mkdir(dirname(join(ws, f)), { recursive: true });
      await writeFile(join(ws, f), `SECRETFILE ${f}\n`);
    }
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
