import { readdirSync, readFileSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Extractor } from "@maycombhq/sdk";
import {
  BuildManifest,
  CrossCheckDismissals,
  FactsSlotMeta,
  LegacyJoinsSlot,
  ReadersSlot,
  parseBuildManifest,
  parseDismissals,
  parseFactsSlotMeta,
  parseFactsSnapshot,
  parseLegacyJoins,
  parseReadersSlot,
  readersSlotOf,
  scanEstate,
  serializeBuildManifest,
  serializeDismissals,
  serializeFactsSlotMeta,
  serializeFactsSnapshot,
  serializeLegacyJoins,
  serializeReadersSlot,
  slotJsonSchemas,
  type ReadersObservation,
} from "../src/index.js";

/**
 * ADR 0195, ticket CS1: the slot formats (the readers slot, the facts slot with its meta, the
 * legacy joins slot, build.json and the cross-check's dismissals), each read and written again
 * byte for byte, and what the scan observes of each repo: a full read at a known commit, or
 * nothing, with why. Invented Forge estate (CLAUDE.md rule 3).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");
const SLOTS = join(FORGE, "slots");
const PLUGINS = join(HERE, "../../../fixtures/scanner-plugins");
const T = 180_000;
const read = (rel: string) => readFileSync(join(SLOTS, ...rel.split("/")), "utf8");
const FORGE_REPOS = readdirSync(join(FORGE, "repos")).sort();

describe("the slot formats read and write byte for byte (ADR 0195 point 1, CS1)", () => {
  it.each(FORGE_REPOS)("the readers slot of %s", (repo) => {
    const text = read(`readers/${repo}.json`);
    const p = parseReadersSlot(text);
    expect(p.ok, p.ok ? "" : JSON.stringify(p.issues)).toBe(true);
    if (!p.ok) return;
    expect(p.slot.repo).toBe(repo);
    expect(p.slot.kind).toBe("readers");
    expect(p.slot.status).toBe("read");
    expect(serializeReadersSlot(p.slot)).toBe(text);
    // The records are C1, sorted by kind then id; each evidence entry of the repo names it.
    const keys = p.slot.records.map((r) => `${r.kind}\u0000${r.id}`);
    expect(keys).toEqual([...keys].sort());
    expect(p.slot.records.length).toBeGreaterThan(0);
    // No time in the slot's own fields: a rescan of an unchanged repo writes the same bytes.
    expect(Object.keys(JSON.parse(text) as object)).toEqual([
      "slotVersion",
      "kind",
      "repo",
      "commit",
      "status",
      "extractors",
      "settings",
      "records",
    ]);
  });

  it("the facts snapshot and its meta", () => {
    const text = read("facts/forge-ledger.jsonl");
    const facts = parseFactsSnapshot(text);
    expect(facts.ok).toBe(true);
    if (!facts.ok) return;
    expect(serializeFactsSnapshot(facts.facts)).toBe(text);
    const metaText = read("facts/forge-ledger.meta.json");
    const meta = parseFactsSlotMeta(metaText);
    expect(meta.ok, meta.ok ? "" : JSON.stringify(meta.issues)).toBe(true);
    if (!meta.ok) return;
    expect(serializeFactsSlotMeta(meta.slot)).toBe(metaText);
    expect(meta.slot).toMatchObject({ slotVersion: 1, kind: "facts", repo: "forge-ledger" });
    expect(Object.keys(JSON.parse(metaText) as object)).toEqual([
      "slotVersion",
      "kind",
      "repo",
      "commit",
      "factsSchemaVersion",
      "factsHash",
      "contracts",
    ]);
  });

  it("the legacy joins slot", () => {
    const text = read("legacy/joins.json");
    const p = parseLegacyJoins(text);
    expect(p.ok, p.ok ? "" : JSON.stringify(p.issues)).toBe(true);
    if (!p.ok) return;
    expect(serializeLegacyJoins(p.slot)).toBe(text);
    expect(p.slot).toMatchObject({ slotVersion: 1, kind: "legacy-joins", status: "legacy" });
    expect(p.slot.records.length).toBeGreaterThan(0);
  });

  it("the build manifest", () => {
    const text = read("build.json");
    const p = parseBuildManifest(text);
    expect(p.ok, p.ok ? "" : JSON.stringify(p.issues)).toBe(true);
    if (!p.ok) return;
    expect(serializeBuildManifest(p.slot)).toBe(text);
    expect(p.slot.version).toBe(1);
  });

  it("the cross-check's dismissals", () => {
    const text = read("crosscheck/forge-ledger.crosscheck.yaml");
    const p = parseDismissals(text);
    expect(p.ok, p.ok ? "" : JSON.stringify(p.issues)).toBe(true);
    if (!p.ok) return;
    expect(serializeDismissals(p.slot)).toBe(text);
    expect(p.slot.version).toBe(1);
  });

  it("a Windows checkout's CRLF reads the same, and is written back with LF", () => {
    const text = read("readers/forge-ledger.json");
    const p = parseReadersSlot(text.replace(/\n/g, "\r\n"));
    expect(p.ok && serializeReadersSlot(p.slot)).toBe(text);
  });

  it("the serializers sort what they are given: the same slot in any order gives the same bytes", () => {
    const p = parseReadersSlot(read("readers/forge-ledger.json"));
    if (!p.ok) throw new Error("golden doesn't read");
    const shuffled = {
      ...p.slot,
      records: [...p.slot.records].reverse(),
      extractors: [...p.slot.extractors].reverse(),
    };
    expect(serializeReadersSlot(shuffled)).toBe(read("readers/forge-ledger.json"));
    const b = parseBuildManifest(read("build.json"));
    if (!b.ok) throw new Error("golden doesn't read");
    expect(serializeBuildManifest({ ...b.slot, files: [...b.slot.files].reverse() })).toBe(
      read("build.json"),
    );
  });

  it("refuses what isn't a slot: another version, a partial status, a record that isn't C1", () => {
    const slot = JSON.parse(read("readers/forge-ledger.json")) as Record<string, unknown>;
    expect(parseReadersSlot(JSON.stringify({ ...slot, slotVersion: 2 })).ok).toBe(false);
    // There is no partial: a partial read writes nothing.
    expect(parseReadersSlot(JSON.stringify({ ...slot, status: "partial" })).ok).toBe(false);
    expect(
      parseReadersSlot(JSON.stringify({ ...slot, records: [{ kind: "Component", id: "x" }] })).ok,
    ).toBe(false);
    expect(parseReadersSlot(JSON.stringify({ ...slot, settings: "not a hash" })).ok).toBe(false);
    expect(parseReadersSlot("{").ok).toBe(false);
    const meta = JSON.parse(read("facts/forge-ledger.meta.json")) as Record<string, unknown>;
    expect(parseFactsSlotMeta(JSON.stringify({ ...meta, kind: "readers" })).ok).toBe(false);
    expect(parseFactsSlotMeta(JSON.stringify({ ...meta, factsHash: "abc" })).ok).toBe(false);
    expect(parseDismissals("version: 2\ndismissed: []\n").ok).toBe(false);
  });

  it("the JSON Schema of each format is generated from its zod schema", () => {
    const s = slotJsonSchemas() as Record<string, { $id: string; title: string }>;
    expect(Object.keys(s).sort()).toEqual([
      "BuildManifest",
      "CrossCheckDismissals",
      "FactsSlotMeta",
      "LegacyJoinsSlot",
      "ReadersSlot",
    ]);
    expect(s.ReadersSlot!.$id).toBe(
      "https://maycombhq.github.io/atticus/schema/sources/v1/ReadersSlot.json",
    );
    for (const z of [ReadersSlot, FactsSlotMeta, LegacyJoinsSlot, BuildManifest])
      expect(z).toBeDefined();
    expect(CrossCheckDismissals).toBeDefined();
  });
});

async function scanFixture(o: {
  fixture: string;
  orgPack?: string;
  repos?: string[];
  extractors?: Extractor[];
  repoDir?: (id: string) => string;
  /** null: read each clone with git, as a real scan does. */
  repoState?: ((id: string) => Promise<{ commit: string; dirty: boolean }>) | null;
}) {
  const root = await mkdtemp(join(tmpdir(), "atticus-slots-"));
  const state =
    o.repoState === null
      ? undefined
      : (o.repoState ?? (async () => ({ commit: "a".repeat(40), dirty: false })));
  try {
    return await scanEstate({
      root,
      orgPack: o.orgPack ?? join(o.fixture, "metarepo/org-pack"),
      repoDir: o.repoDir ?? ((id) => join(o.fixture, "repos", id)),
      ...(state ? { repoState: state } : {}),
      cache: null,
      inputsDir: null,
      scannedAt: "2026-10-18T09:00:00Z",
      ...(o.repos ? { repos: o.repos } : {}),
      ...(o.extractors ? { extractors: o.extractors } : {}),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const byRepo = (obs: readonly ReadersObservation[]) =>
  Object.fromEntries(obs.map((x) => [x.repo, x.full ? "full" : x.why]));

describe("what a scan observes of each repo: a full read, or nothing (ADR 0195 point 1)", () => {
  it(
    "every Forge repo read in full: its readers' records before the merge, the commit, the extractors that ran and a hash of what steered them",
    async () => {
      const scan = await scanFixture({ fixture: FORGE });
      expect(byRepo(scan.observations)).toEqual(
        Object.fromEntries(FORGE_REPOS.map((r) => [r, "full"])),
      );
      for (const o of scan.observations) {
        if (!o.full) continue;
        expect(o.slot.commit).toBe("a".repeat(40));
        expect(o.slot.settings).toMatch(/^[0-9a-f]{64}$/);
        const ids = o.slot.extractors.map((x) => x.id);
        expect(ids).toEqual([...ids].sort());
        // Each record is the readers' own, of this repo: nothing joined in from another.
        for (const r of o.slot.records)
          for (const e of r.evidence) if (e.repo) expect(e.repo).toBe(o.repo);
        // The readers' records before the merge (no repo has facts here, so the scan's own).
        const own = scan.repos.find((s) => s.repo === o.repo)!.records;
        expect(o.slot.records).toEqual(readersSlotOf({ ...o.slot, records: own }).records);
      }
    },
    T,
  );

  it(
    "outside --repos, not cloned, and a reader that throws: no observation, each with why",
    async () => {
      const boom: Extractor = {
        id: "northwind-reader",
        version: "1.0.0",
        claims: ["**/*"],
        // eslint-disable-next-line require-yield
        async *scan(repo) {
          if (repo.name === "forge-portal-bff") throw new Error("stopped on a file it can't parse");
        },
      };
      const scan = await scanFixture({
        fixture: FORGE,
        repos: FORGE_REPOS.filter((r) => r !== "forge-infra"),
        extractors: [boom],
        repoState: async (id) => {
          if (id === "forge-ledger") throw new Error("not a git repository");
          return { commit: "a".repeat(40), dirty: false };
        },
      });
      const why = byRepo(scan.observations);
      expect(why).toEqual({
        "forge-events": "full",
        "forge-gateway": "full",
        "forge-infra": "not-asked",
        "forge-ledger": "unreadable",
        "forge-portal-bff": "run-failed",
        "forge-portal-ui": "full",
        "forge-reports-job": "full",
      });
      // No clone at all: the scan reads git only where the folder is.
      const bare = await scanFixture({
        fixture: FORGE,
        repoDir: (id) => join(FORGE, "repos", id === "forge-events" ? "no-such-clone" : id),
        repoState: null,
      });
      expect(byRepo(bare.observations)["forge-events"]).toBe("not-cloned");
    },
    T,
  );

  it(
    "the readers switched off (ATTICUS_HELPERS_OFF=readers) observe nothing: no slot over a good one",
    async () => {
      const was = process.env.ATTICUS_HELPERS_OFF;
      process.env.ATTICUS_HELPERS_OFF = "readers";
      try {
        const scan = await scanFixture({ fixture: FORGE });
        expect(new Set(Object.values(byRepo(scan.observations)))).toEqual(new Set(["readers-off"]));
      } finally {
        if (was === undefined) delete process.env.ATTICUS_HELPERS_OFF;
        else process.env.ATTICUS_HELPERS_OFF = was;
      }
    },
    T,
  );

  it(
    "a plugin that times out, and a plugin refused (changed since its pin), leave the repos they apply to unobserved",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "atticus-slots-op-"));
      try {
        const op = join(root, "org-pack");
        await cp(join(PLUGINS, "metarepo/org-pack"), op, { recursive: true });
        for (const id of [
          "forge-reads-outside",
          "forge-writes-file",
          "forge-opens-socket",
          "forge-spawns",
          "forge-hogs-memory",
        ])
          await rm(join(op, "plugins", id), { recursive: true, force: true });
        // forge-loops runs past its time limit on the anvil service.
        const loops = await scanFixture({ fixture: PLUGINS, orgPack: op });
        expect(byRepo(loops.observations)).toEqual({
          "forge-anvil-notes": "run-failed",
          "forge-notes-ui": "full",
        });
        // The good plugin changed after its pin: it isn't used, so the anvil service isn't
        // read in full, though the scan itself (beta.26) has nothing unread to say.
        await rm(join(op, "plugins", "forge-loops"), { recursive: true, force: true });
        const entry = join(op, "plugins", "forge-anvil-routes", "index.js");
        await writeFile(entry, (await readFile(entry, "utf8")) + "\n// an unreviewed edit\n");
        const refused = await scanFixture({ fixture: PLUGINS, orgPack: op });
        expect(refused.unread).toEqual([]);
        expect(byRepo(refused.observations)).toEqual({
          "forge-anvil-notes": "plugin-refused",
          "forge-notes-ui": "full",
        });
        const o = refused.observations.find((x) => x.repo === "forge-anvil-notes")!;
        expect(!o.full && o.detail).toMatch(/forge-anvil-routes/);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    T,
  );
});
