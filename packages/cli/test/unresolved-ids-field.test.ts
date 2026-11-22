import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { CatalogRecord } from "@maycombhq/core";
import { buildAndWrite, readCatalog } from "@maycombhq/scanner";
import { main } from "../src/main.js";
import { upgradeCommand } from "../src/upgrade.js";
import { makeFieldEstate } from "./field-estate.js";

/**
 * ADR 0124 addendum E-ids (the owner, 2026-11-19), found by the field-shaped estate: a loose
 * call's record was `unresolved.<fact id>`, so two repos' loose calls with one fact id made one
 * record and the other repo's call had none; impact's "call with no arrow" (beta.30's words;
 * "loose end Atticus couldn't follow" before, packages/index/src/graph.ts) never named it. With the repo in the id, every loose call has its
 * own record, and impact names each.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../../../fixtures/upgrade-b30/unresolved-ids/metarepo");
const T = 300_000;
const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const quiet = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
};
type Ev = { repo?: string; path?: string; line?: number };
const evOf = (r: CatalogRecord) => r.evidence as Ev[];

/** The calls a repo's facts leave loose that no person paired, by repo, fact id and line. */
async function looseCalls(root: string, host: RegExp) {
  const paired = new Set<string>();
  const calls: { repo: string; id: string; at: string }[] = [];
  for (const n of (await readdir(join(root, "facts"))).sort()) {
    if (!n.endsWith(".jsonl")) continue;
    const lines = (await readFile(join(root, "facts", n), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    if (n.endsWith(".corrections.jsonl"))
      for (const l of lines) paired.add(`${n.split(".corrections")[0]} ${String(l.fact)}`);
    else if (/^[^.]+(?:\.[^.]+)*\.jsonl$/.test(n) && !/\.(reviewed|rejected)\./.test(n))
      for (const f of lines as {
        kind: string;
        repo: string;
        id: string;
        host?: string;
        cite: { file: string; line: number };
      }[])
        if (f.kind === "call" && host.test(f.host ?? ""))
          calls.push({ repo: f.repo, id: f.id, at: `${f.repo} ${f.cite.file}:${f.cite.line}` });
  }
  return calls.filter((c) => !paired.has(`${c.repo} ${c.id}`));
}

/** The loose ends impact names, over an impact of every component: record id -> question. */
async function impactGaps(root: string, components: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const c of components) {
    const q = quiet();
    const code = await main(["impact", c, "--depth", "2", "--json", "--root", root], q.io);
    expect(code, `${c}: ${q.err.join("\n")}`).toBe(0);
    const j = JSON.parse(q.out.join("\n")) as {
      gaps: { record: string; field: string; question: string }[];
    };
    for (const g of j.gaps) if (g.field === "raw") out.set(g.record, g.question);
  }
  return out;
}

describe("every repo's loose call has a record of its own, and impact names it", () => {
  it(
    "on the field estate, where repos share call ids",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "b30-ids-field-"));
      dirs.push(dir);
      const e = await makeFieldEstate(dir, {
        services: 12,
        gateways: 2,
        entries: 20,
        calls: 60,
        fieldNames: 100,
        legacy: 2,
        questions: 8,
        links: 4,
        suppressed: 3,
        checkouts: 0,
      });
      const r = await buildAndWrite(e.root, { command: "atticus catalog build" });
      expect(r.guard.refused?.message).toBeUndefined();
      const read = new Set(e.repos);
      const loose = (await looseCalls(e.root, /^@forgeTargetUrl\d@$/)).filter((c) =>
        read.has(c.repo),
      );
      // The case: the same fact id loose in two repos.
      const ids = loose.map((c) => c.id);
      expect(ids.filter((id, k) => ids.indexOf(id) !== k).length).toBeGreaterThan(0);
      const records = (await readCatalog(join(e.root, "catalog", "generated"))).records;
      const unresolved = records.filter((x) => x.kind === "Unresolved");
      const cited = new Map<string, CatalogRecord>();
      for (const u of unresolved)
        for (const x of evOf(u)) cited.set(`${x.repo} ${x.path}:${x.line}`, u);
      // By what each record cites, never by its id: one record per loose call.
      expect(loose.filter((c) => !cited.has(c.at)).map((c) => c.at)).toEqual([]);
      const of = loose.map((c) => cited.get(c.at)!.id);
      expect(new Set(of).size).toBe(loose.length);
      for (const [k, c] of loose.entries()) expect(of[k]).toBe(`unresolved.${c.repo}.${c.id}`);
      // Impact names each, as a loose end of its component.
      const components = records
        .filter((x) => x.kind === "Component")
        .map((x) => x.id)
        .sort();
      const gaps = await impactGaps(e.root, components);
      expect(of.filter((id) => !gaps.has(id))).toEqual([]);
    },
    T,
  );

  it(
    "a catalog build of a metarepo beta.28.5 built: the loose ends renamed, the ${NAME} arrow asked",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "b30-ids-build-"));
      dirs.push(dir);
      const root = join(dir, "forge");
      await cp(FIXTURE, root, { recursive: true });
      // The owner, 2026-11-22 (ADR 0124 addendum E-ids): while an input names an old loose end's
      // id, the build that would rename it waits for atticus upgrade, writing nothing.
      const w = quiet();
      expect(await main(["catalog", "build", "--root", root], w.io)).toBe(1);
      expect([...w.out, ...w.err].join("\n")).toContain(
        "Run atticus upgrade: it renames 6 loose ends",
      );
      // With no input naming one, a build renames them itself.
      for (const rel of [
        "catalog/curated/curateddecision",
        "facts/forge-ledger.crosscheck.yaml",
        "openspec/changes/rates-from-ledger",
        "questions",
        "specs/forge-ledger/forge-ledger.read-the-rates.yaml",
      ])
        await rm(join(root, ...rel.split("/")), { recursive: true, force: true });
      const q = quiet();
      expect(await main(["catalog", "build", "--root", root], q.io), q.err.join("\n")).toBe(0);
      const records = (await readCatalog(join(root, "catalog", "generated"))).records;
      // forge-payments' call to ${FORGE_LEDGER_URL}, which nothing sets, at Client.java line 6.
      const at = (r: CatalogRecord) =>
        evOf(r).some(
          (x) =>
            x.repo === "forge-payments" &&
            x.path === "src/main/java/forge/client/Client.java" &&
            x.line === 6,
        );
      expect(records.filter((r) => r.kind === "Interface" && at(r))).toEqual([]);
      expect(records.filter((r) => r.kind === "Unresolved" && at(r)).map((r) => r.id)).toEqual([
        "unresolved.forge-payments.c-token",
      ]);
      const said = q.out.join("\n");
      expect(said).toContain(
        "the host is a deploy token nothing sets: asked now (Unresolved/unresolved.forge-payments.c-token)",
      );
      expect(said).toContain("renamed Unresolved/unresolved.forge-ledger.c-1 (the repo in its id)");
    },
    T,
  );

  it(
    "on a metarepo beta.28.5 built, once this Atticus builds it: impact names every loose call",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "b30-ids-impact-"));
      dirs.push(dir);
      const root = join(dir, "forge");
      await cp(FIXTURE, root, { recursive: true });
      const q = quiet();
      expect(
        await upgradeCommand(root, { by: "pat" }, q.io, "2.0.0-beta.30"),
        q.err.join("\n"),
      ).toBe(0);
      const loose = await looseCalls(root, /^(@[A-Za-z]+@|\$\{[A-Z_]+\})$/);
      // Taken off the map: forge-ledger's c-risk, and forge-notify's c-7, the record beta.28.5
      // showed for c-7 (forge-payments' c-7 is a loose end of its own now, nobody's decision).
      const suppressed = new Set(["forge-ledger c-risk", "forge-notify c-7"]);
      const want = loose
        .filter((c) => !suppressed.has(`${c.repo} ${c.id}`))
        .map((c) => `unresolved.${c.repo}.${c.id}`)
        .sort();
      expect(want).toEqual([
        "unresolved.forge-ledger.c-1",
        "unresolved.forge-ledger.c-solo",
        "unresolved.forge-payments.c-1",
        "unresolved.forge-payments.c-7",
        "unresolved.forge-payments.c-token",
      ]);
      const gaps = await impactGaps(root, ["forge-ledger", "forge-notify", "forge-payments"]);
      expect(want.filter((id) => !gaps.has(id))).toEqual([]);
      expect(gaps.get("unresolved.forge-payments.c-1")).toMatch(
        /forge-payments has a call with no arrow \(GET .*\/v1\/rates\/forge-payments\)/,
      );
    },
    T,
  );
});
