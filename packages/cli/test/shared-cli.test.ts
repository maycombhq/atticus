import { cp, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";
import { JOINED_TO_SHARED_MAP, NOT_IN_SHARED_MAP, SHARED_MAP_EVIDENCE } from "@maycombhq/core";
import { aliasArgv } from "../src/top-commands.js";
import { denyHash } from "../src/link-evidence-files.js";
import { headCommitOf, sharedImport, sharedList, sharedRefresh } from "../src/shared-commands.js";
import { outsideView } from "../src/ui-api-outside.js";
import { verifyCommand } from "../src/verify-commands.js";

/**
 * Another team's Atticus map, read-only (O3, ADR 0160), end to end on the invented
 * fixtures/shared-maps: the Forge Risk Team's metarepo is brought in as files, only their
 * verified entries are kept (quotes redacted), `atticus verify forge-lending --write` joins our
 * calls to their system to them, and the outside systems page lists them. Files only.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FX = join(HERE, "../../../fixtures/shared-maps");
const FORGE = join(HERE, "../../../fixtures/forge/metarepo/org-pack");
const NOW = new Date("2026-11-01T10:00:00Z");

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
};

async function metarepo(): Promise<{ root: string; theirs: string }> {
  const root = await mkdtemp(join(tmpdir(), "atticus-shared-cli-"));
  await cp(FORGE, join(root, "org-pack"), { recursive: true });
  await writeFile(join(root, "org-pack/sources.yaml"), "schemaVersion: 1\nwikis: []\n");
  await cp(join(FX, "org-pack/profiles/forge"), join(root, "org-pack/profiles/forge"), {
    recursive: true,
  });
  await cp(join(FX, "facts"), join(root, "facts"), { recursive: true });
  await cp(join(FX, "repos/forge-lending"), join(root, "workspace/forge-lending"), {
    recursive: true,
  });
  const theirs = await mkdtemp(join(tmpdir(), "atticus-risk-team-"));
  await cp(join(FX, "risk-team"), theirs, { recursive: true });
  return { root, theirs };
}

const imp = (root: string, dir: string, extra: Record<string, string> = {}) => {
  const c = capture();
  return sharedImport(
    root,
    dir,
    {
      team: "forge-risk-team",
      system: "forge-risk",
      name: "Forge Risk Team",
      now: NOW,
      ...extra,
    } as never,
    c.io,
  ).then((code) => ({ code, ...c }));
};

describe("atticus join shared (O3)", { timeout: 60_000 }, () => {
  let root: string;
  let theirs: string;
  beforeAll(async () => {
    ({ root, theirs } = await metarepo());
  });

  it("routes join shared to estate shared", () => {
    expect(aliasArgv(["join", "shared", "list"], [0, 1, 2])).toEqual(["estate", "shared", "list"]);
  });

  it("refuses a system the estate owns, an unknown commit, and a deny-listed word, writing nothing", async () => {
    let r = await imp(root, theirs, { system: "lending" });
    expect(r.code).toBe(1);
    expect(r.err[0]).toMatch(
      /lending isn't a system of your profiles that no estate repo belongs to/,
    );
    r = await imp(root, theirs);
    expect(r.code).toBe(1);
    expect(r.err[0]).toMatch(/--commit <sha>/);
    await writeFile(join(root, ".denylist"), `${denyHash("limits")}\n`);
    r = await imp(root, theirs, { commit: "9999abc" });
    expect(r.code).toBe(1);
    expect(r.err[0]).toMatch(/^Refused: the deny-list names a word in forge-risk-limits/);
    await writeFile(join(root, ".denylist"), "");
    expect(await readdir(root)).not.toContain("shared");
  });

  it("keeps only their verified entries, quotes redacted, at their commit read from the clone", async () => {
    await mkdir(join(theirs, ".git/refs/heads"), { recursive: true });
    await writeFile(join(theirs, ".git/HEAD"), "ref: refs/heads/main\n");
    await writeFile(
      join(theirs, ".git/refs/heads/main"),
      "9999abc0000000000000000000000000000000aa\n",
    );
    expect(await headCommitOf(theirs)).toBe("9999abc0000000000000000000000000000000aa");
    const r = await imp(root, theirs);
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    expect(r.out[0]).toBe(
      "Imported Forge Risk Team's map, their commit 9999abc: 3 entries from 2 repos (forge-risk-limits 1, forge-risk-scoring 2), standing for forge-risk. Written to shared/forge-risk-team/.",
    );
    expect(r.out[1]).toBe(
      "  Left out: 2 facts that aren't entries, 1 entry their verify didn't confirm.",
    );
    const map = parse(await readFile(join(root, "shared/forge-risk-team/map.yaml"), "utf8"));
    expect(map).toMatchObject({
      schemaVersion: 1,
      team: "forge-risk-team",
      name: "Forge Risk Team",
      system: "forge-risk",
      commit: "9999abc0000000000000000000000000000000aa",
      importedAt: "2026-11-01T10:00:00.000Z",
      repos: [
        {
          repo: "forge-risk-limits",
          component: "limits-api",
          commit: "6666fff",
          hosts: [],
          entries: 1,
        },
        {
          repo: "forge-risk-scoring",
          component: "scoring-api",
          commit: "5555eee",
          hosts: ["risk.forge.internal"],
          basePath: "/risk",
          entries: 2,
        },
      ],
    });
    const kept = await readFile(
      join(root, "shared/forge-risk-team/facts/forge-risk-scoring.jsonl"),
      "utf8",
    );
    expect(kept).not.toContain("s3cr3t");
    // The injected words were in an entry their verify never confirmed: left out, never read.
    expect(kept).not.toContain("Ignore your rules");
    expect(kept.trim().split("\n")).toHaveLength(2);
    // Nothing of theirs is in our facts.
    expect((await readdir(join(root, "facts"))).filter((f) => f.startsWith("forge-risk"))).toEqual(
      [],
    );
    const l = capture();
    expect(await sharedList(root, {}, l.io)).toBe(0);
    expect(l.out[0]).toMatch(
      /^forge-risk-team: Forge Risk Team's map for forge-risk, their commit 9999abc, imported 2026-11-01 from /,
    );
  });

  it("verify --write joins our calls to their system to their entries, cited on their lines", async () => {
    const c = capture();
    expect(await verifyCommand(root, "forge-lending", { write: true }, c.io)).toBe(0);
    expect(c.out.join("\n")).toContain(
      "Shared map: 2 of forge-lending's calls joined to forge-risk-team's map (their commit 9999abc), each citing their entry; 1 it has no entry for.",
    );
    const dir = join(root, "catalog/generated/interface");
    const ifaces = await Promise.all(
      (await readdir(dir)).map(async (f) => parse(await readFile(join(dir, f), "utf8"))),
    );
    const scores = ifaces.find((i) => i.normalizedPath === "/risk/v1/scores");
    expect(scores).toMatchObject({
      from: "lending-api",
      to: "forge-risk",
      flags: [JOINED_TO_SHARED_MAP],
    });
    expect(scores.evidence).toContainEqual(
      expect.objectContaining({
        repo: "forge-risk-scoring",
        line: 12,
        commit: "5555eee",
        side: "callee",
        extractor: SHARED_MAP_EVIDENCE,
        by: "forge-risk-team",
      }),
    );
    expect(ifaces.find((i) => i.normalizedPath === "/risk/v1/fraud-checks").flags).toEqual([
      NOT_IN_SHARED_MAP,
    ]);
    // Nothing of theirs became a record of ours.
    expect(await readdir(join(root, "catalog/generated"))).not.toContain("endpoint-forge-risk");
    const comps = await readdir(join(root, "catalog/generated/component"));
    expect(comps.some((f) => /scoring|limits/.test(f))).toBe(false);
    const report = parse(await readFile(join(root, "facts/forge-lending.verify.yaml"), "utf8"));
    expect(report.shared.joined).toHaveLength(2);
    expect(report.shared.unmatched[0]).toMatchObject({ call: "call.post.risk-v1-fraud-checks" });
  });

  it("lists their entries on the outside systems page, each with the calls that reach it", async () => {
    const v = await outsideView(root);
    const risk = v.systems.find((s) => s.id === "forge-risk")!;
    expect(risk.shared).toMatchObject({
      team: "forge-risk-team",
      name: "Forge Risk Team",
      commit: "9999abc0000000000000000000000000000000aa",
    });
    const entries = Object.fromEntries(risk.shared!.entries.map((e) => [e.fact, e]));
    expect(entries["entry.post.v1-scores"]).toMatchObject({
      repo: "forge-risk-scoring",
      component: "scoring-api",
      method: "POST",
      path: "/v1/scores",
      at: "src/main/java/forge/risk/ScoresController.java:12",
      calls: 1,
    });
    expect(entries["entry.get.v1-scores-id"]!.calls).toBe(0);
    expect(risk.shared!.unmatched).toEqual([
      expect.objectContaining({
        fact: "call.post.risk-v1-fraud-checks",
        message: expect.stringContaining("no entry"),
      }),
    ]);
    expect(risk.callers).toContainEqual(
      expect.objectContaining({
        fact: "call.post.risk-v1-scores",
        entry: {
          team: "forge-risk-team",
          repo: "forge-risk-scoring",
          fact: "entry.post.v1-scores",
          at: "src/main/java/forge/risk/ScoresController.java:12",
        },
      }),
    );
  });

  it("a newer import replaces the old commit", async () => {
    const c = capture();
    expect(
      await sharedRefresh(root, "forge-risk-team", { commit: "aaaa111", now: NOW }, c.io),
    ).toBe(0);
    expect(c.out[0]).toMatch(
      /^Replaced Forge Risk Team's map at 9999abc with their commit aaaa111:/,
    );
    const map = parse(await readFile(join(root, "shared/forge-risk-team/map.yaml"), "utf8"));
    expect(map.commit).toBe("aaaa111");
  });
});
