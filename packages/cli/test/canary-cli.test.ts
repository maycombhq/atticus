import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CanaryKey, parseCanaryReport, type CanaryKeyT, type Fact } from "@maycombhq/core";
import {
  canaryCheck,
  canaryClean,
  canaryPlant,
  canaryReport,
  canaryScore,
  canaryView,
  silentSummary,
} from "../src/canary-commands.js";
import { metarepoStateDir } from "../src/user-state.js";

/**
 * atticus canary (plan item Z2, ADR 0196) on invented Forge repos, one per stack the templates
 * cover: plant a scratch copy outside the metarepo, read it (here by hand, as no model runs in
 * tests), check and score it, and write one report in the metarepo. Nothing else is written
 * there, nothing is fetched, and the copy goes whatever happens.
 */

const FIX = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
const REPOS: Record<string, string> = {
  "forge-portal-bff": join(FIX, "forge/repos/forge-portal-bff"),
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
  root: string;
  env: NodeJS.ProcessEnv;
  scratch: string;
}

/** Every test's own folder (metarepo, state and scratch), removed once the file is done. */
const made: string[] = [];
afterAll(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true });
});

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
      [
        "  - id: forge-appraise",
        "    url: https://git.example.com/forge/forge-appraise.git",
        "    type: python-service",
        "    owner: team-appraise",
        "    component: appraise",
        "    system: appraise",
        "",
      ].join("\n"),
  );
  for (const [repo, dir] of Object.entries(REPOS))
    await cp(dir, join(root, "workspace", repo), { recursive: true });
  await mkdir(join(root, "facts"), { recursive: true });
  for (const repo of Object.keys(REPOS))
    await cp(join(FIX, "canaries/facts", `${repo}.jsonl`), join(root, "facts", `${repo}.jsonl`));
  return { root, env: { XDG_STATE_HOME: join(top, "state") }, scratch: join(top, "scratch") };
}

const opts = (h: Here, x: Record<string, unknown> = {}) => ({
  by: "tom",
  now: NOW,
  env: h.env,
  scratch: h.scratch,
  ...x,
});

const keyOf = async (h: Here, repo: string): Promise<CanaryKeyT> =>
  CanaryKey.parse(
    JSON.parse(
      await readFile(join(metarepoStateDir(h.root, h.env), "canaries", `${repo}.json`), "utf8"),
    ),
  );

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
  stat(p).then(
    () => true,
    () => false,
  );

/** A read that finds every planted item and leaves out every removed one: the copy's own facts. */
async function perfectRead(h: Here, repo: string, key: CanaryKeyT): Promise<string> {
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
    (await readFile(join(key.copy, ...file.split("/")), "utf8")).split("\n");
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
  await writeFile(key.facts, text);
  return text;
}

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
  it("plants the same copy for the same seed, outside the metarepo, with a prompt that doesn't say what", async () => {
    const h = await metarepo();
    const before = await tree(h.root);
    const c = capture();
    expect(await canaryPlant(h.root, "forge-portal-bff", opts(h, { seed: "s1" }), c.io)).toBe(0);
    expect(c.err).toEqual([]);
    const a = await keyOf(h, "forge-portal-bff");
    const copyA = await tree(a.copy);
    expect(relative(h.root, a.run).startsWith("..")).toBe(true);
    expect(relative(h.scratch, a.run).startsWith("..")).toBe(false);
    expect(await exists(join(a.copy, ".git"))).toBe(false);

    // The prompt names the copy and the facts file, and nothing planted or taken out.
    const prompt = await readFile(a.prompt, "utf8");
    expect(prompt).toContain(a.copy);
    expect(prompt).toContain(a.facts);
    expect(prompt).toContain("atticus canary check forge-portal-bff");
    for (const p of a.planted)
      for (const w of p.needle.split("-"))
        if (!["updated", "viewed", "url"].includes(w))
          expect(prompt).not.toMatch(new RegExp(`\\b${w}\\b`));
    for (const r of a.removed) expect(prompt).not.toContain(r.fact);
    expect(c.out.join("\n")).not.toMatch(/spruce|nutmeg|plant:\d/);

    // Again with the same seed: it replaces the first, and plants the same bytes.
    const again = capture();
    expect(await canaryPlant(h.root, "forge-portal-bff", opts(h, { seed: "s1" }), again.io)).toBe(
      0,
    );
    expect(again.out[0]).toBe(
      "An earlier canary of forge-portal-bff wasn't scored: its copy is deleted.",
    );
    expect(await exists(a.run)).toBe(false);
    const b = await keyOf(h, "forge-portal-bff");
    expect({ planted: b.planted, removed: b.removed }).toEqual({
      planted: a.planted,
      removed: a.removed,
    });
    expect(await tree(b.copy)).toEqual(copyA);
    // Another seed plants other names.
    await canaryPlant(h.root, "forge-portal-bff", opts(h, { seed: "s2" }), capture().io);
    expect((await keyOf(h, "forge-portal-bff")).planted.map((p) => p.needle)).not.toEqual(
      a.planted.map((p) => p.needle),
    );
    // The metarepo is as it was: a plant writes nothing there.
    expect(await tree(h.root)).toEqual(before);
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
      expect(checked.out).toEqual([expect.stringMatching(/none rejected/)]);
      expect(code).toBe(0);
      const c = capture();
      expect(await canaryScore(h.root, repo, opts(h), c.io)).toBe(0);
      expect(c.err).toEqual([]);
      // Only the report is new in the metarepo.
      const after = await tree(h.root);
      const added = Object.keys(after).filter((f) => !(f in before));
      expect(added).toEqual([`reports/canaries/2026-11-11-${repo}.yaml`]);
      expect(Object.keys(before).every((f) => after[f] === before[f])).toBe(true);
      const r = parseCanaryReport(await readFile(join(h.root, added[0]!), "utf8"));
      if (!r.ok) throw new Error(r.issues.join("\n"));
      expect(r.report.recall).toMatchObject({
        k: key.planted.length,
        n: key.planted.length,
        rate: 1,
      });
      expect(r.report.fabrication).toMatchObject({ k: 0, n: key.removed.length, rate: 0 });
      expect(r.report.passed.k).toBe(0);
      // The copy, the facts and the key are gone.
      expect(await exists(key.run)).toBe(false);
      expect(await exists(join(metarepoStateDir(h.root, h.env), "canaries", `${repo}.json`))).toBe(
        false,
      );
      // The report holds no line of the repo's code: claims and places only.
      expect(JSON.stringify(r.report)).not.toMatch(/quote|@GetMapping|httpx\.|router\.get/);
    });

  it("scores the hand-written read of forge-portal-bff (seed s1): a miss, two caught, one kept", async () => {
    const h = await metarepo();
    await cp(
      join(FIX, "canaries/facts/forge-portal-bff.audit.yaml"),
      join(h.root, "facts/forge-portal-bff.audit.yaml"),
    );
    await canaryPlant(h.root, "forge-portal-bff", opts(h, { seed: "s1" }), capture().io);
    const key = await keyOf(h, "forge-portal-bff");
    await cp(join(FIX, "canaries/reads/forge-portal-bff.s1.jsonl"), key.facts);
    const checked = capture();
    expect(await canaryCheck(h.root, "forge-portal-bff", opts(h), checked.io)).toBe(1);
    expect(checked.out[0]).toBe(
      `11 kept, 2 rejected: read each in ${join(key.run, "rejected.jsonl")} again, rewrite it or drop it, and check again.`,
    );
    const c = capture();
    expect(await canaryScore(h.root, "forge-portal-bff", opts(h), c.io)).toBe(0);
    expect(c.out).toContain(
      "  Planted: 5; found 4, rejected 0, missed 1. Recall 80% (4 of 5; 95% interval 37.6% to 96.4%).",
    );
    expect(c.out).toContain(
      "    kept: call POST /ledger/v1/transfers (src/main/java/forge/portal/LedgerClient.java:11, commented out)",
    );
    // Pooled with the sample audit's 1 wrong of 9: (1 + 1) wrong of (9 + 4 found + 1 kept).
    expect(c.out).toContain(
      "Silent error rate (wrong claims graded as backed): 14.3% (2 of 14; 95% interval 4% to 39.9%).",
    );
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
      ["call.post.transfers", "kept"],
      ["config.ledger-client-read-timeout", "rejected"],
      ["entry.get.api-balance-accountid", "rejected"],
    ]);
    expect(r.report.fabrication).toMatchObject({ k: 3, n: 3 });
    expect(r.report.passed).toMatchObject({ k: 1, n: 3 });

    // The report on file, as atticus canary report and the app read it.
    const rep = capture();
    expect(await canaryReport(h.root, opts(h), rep.io)).toBe(0);
    expect(rep.out).toContain(
      "Silent error rate (wrong claims graded as backed): 14.3% (2 of 14; 95% interval 4% to 39.9%).",
    );
    const files = await silentSummary(h.root, { join: false });
    expect(files.rate.silent).toEqual((await silentSummary(h.root)).rate.silent);
    // GET /api/trust/canaries: the same numbers, from the files.
    const view = await canaryView(h.root, h.env);
    expect(view.silent.silent).toMatchObject({ k: 2, n: 14 });
    expect(view.latest).toEqual([
      expect.objectContaining({
        repo: "forge-portal-bff",
        path: "reports/canaries/2026-11-11-forge-portal-bff.yaml",
        planted: { n: 5, found: 4, rejected: 0, missed: 1 },
        removed: { n: 3, absent: 0, kept: 1, rejected: 2 },
      }),
    ]);
    expect(view.pending).toEqual([]);
  });

  it("cleans the scratch copy even when the score fails, and a failed plant leaves nothing", async () => {
    const h = await metarepo();
    await canaryPlant(h.root, "forge-portal-ui", opts(h), capture().io);
    const key = await keyOf(h, "forge-portal-ui");
    // No read yet: refused, and the copy is kept for the read.
    const early = capture();
    expect(await canaryScore(h.root, "forge-portal-ui", opts(h), early.io)).toBe(2);
    expect(early.err[0]).toMatch(/^No facts at .* yet: give the prompt to your assistant first/);
    expect(await exists(key.copy)).toBe(true);
    // A read that isn't facts: refused, and everything is deleted all the same.
    await writeFile(key.facts, "not a fact\n");
    const bad = capture();
    expect(await canaryScore(h.root, "forge-portal-ui", opts(h), bad.io)).toBe(2);
    expect(await exists(key.run)).toBe(false);
    expect(
      await exists(join(metarepoStateDir(h.root, h.env), "canaries", "forge-portal-ui.json")),
    ).toBe(false);
    expect(await exists(join(h.root, "reports"))).toBe(false);

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
    expect(
      await exists(join(metarepoStateDir(h.root, h.env), "canaries", "forge-portal-ui.json")),
    ).toBe(false);

    // clean deletes a planted one without scoring it.
    await canaryPlant(h.root, "forge-portal-ui", opts(h), capture().io);
    const c = capture();
    expect(await canaryClean(h.root, undefined, opts(h), c.io)).toBe(0);
    expect(c.out).toEqual(["Deleted 1 planted canary copy."]);
    expect(await readdir(h.scratch)).toEqual([]);
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
    expect(await readdir(h.scratch).catch(() => [])).toEqual([]);
  });
});
