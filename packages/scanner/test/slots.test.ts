import { createHash } from "node:crypto";
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
  manifestOfFiles,
  manifestToV1,
  NewerBuildManifestError,
  sourceSetIds,
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
  serializeBuildManifestV1,
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
/** The Forge golden build.json (version 2), and the same build as beta.28.1 wrote it (version 1). */
const V2 = join(SLOTS, "build.json");
const readV2 = () => readFileSync(V2, "utf8");
const readV1 = () => readFileSync(join(FORGE, "build-json", "build.v1.json"), "utf8");
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

  it("a facts meta may say its read is complete (readComplete: true), and nothing else", () => {
    // Beta.27.2, the review (ADR 0195 addendum "a legacy join its caller's facts place
    // elsewhere"): verify --write records its own verdict that every source file is read or
    // reviewed, so the build can tell a whole read from one in parts.
    const meta = JSON.parse(read("facts/forge-ledger.meta.json")) as Record<string, unknown>;
    const done = parseFactsSlotMeta(JSON.stringify({ ...meta, readComplete: true }));
    expect(done.ok, done.ok ? "" : JSON.stringify(done.issues)).toBe(true);
    if (!done.ok) return;
    expect(done.slot.readComplete).toBe(true);
    const text = serializeFactsSlotMeta(done.slot);
    expect(Object.keys(JSON.parse(text) as object)).toEqual([
      "slotVersion",
      "kind",
      "repo",
      "commit",
      "factsSchemaVersion",
      "factsHash",
      "contracts",
      "readComplete",
    ]);
    // A read in parts says nothing: the field is left out, never false.
    expect(parseFactsSlotMeta(JSON.stringify({ ...meta, readComplete: false })).ok).toBe(false);
    const s = slotJsonSchemas() as Record<string, { properties: Record<string, unknown> }>;
    expect(Object.keys(s.FactsSlotMeta!.properties)).toContain("readComplete");
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

  it("the build manifest (version 2, ADR 0197)", () => {
    const text = readV2();
    const p = parseBuildManifest(text);
    expect(p.ok, p.ok ? "" : JSON.stringify(p.issues)).toBe(true);
    if (!p.ok) return;
    expect(serializeBuildManifest(p.slot)).toBe(text);
    expect(p.slot.version).toBe(2);
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
    const b = parseBuildManifest(readV2());
    if (!b.ok) throw new Error("golden doesn't read");
    const reversed = <V>(o: Record<string, V>) => Object.fromEntries(Object.entries(o).reverse());
    expect(
      serializeBuildManifest({
        ...b.slot,
        files: [...b.slot.files].reverse(),
        sources: reversed(b.slot.sources),
        sourceSets: Object.fromEntries(
          Object.entries(b.slot.sourceSets)
            .reverse()
            .map(([id, paths]) => [id, [...paths].reverse()]),
        ),
      }),
    ).toBe(readV2());
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
      "BuildManifestV1",
      "CrossCheckDismissals",
      "FactsSlotMeta",
      "LegacyJoinsSlot",
      "ReadersSlot",
    ]);
    expect(s.ReadersSlot!.$id).toBe(
      "https://maycombhq.github.io/atticus/schema/sources/v1/ReadersSlot.json",
    );
    // ADR 0197: build.json's schema is version 2's; version 1, still read, is exported too.
    expect(s.BuildManifest!.$id).toBe(
      "https://maycombhq.github.io/atticus/schema/sources/v2/BuildManifest.json",
    );
    expect(s.BuildManifestV1!.$id).toBe(
      "https://maycombhq.github.io/atticus/schema/sources/v1/BuildManifestV1.json",
    );
    // ADR 0197: atticus schema export writes build.json's version 2.
    const bm = s.BuildManifest as unknown as {
      properties: Record<string, { const?: unknown }>;
      required: string[];
    };
    expect(Object.keys(bm.properties).sort()).toEqual([
      "buildVersion",
      "files",
      "sourceSets",
      "sources",
      "version",
    ]);
    expect(bm.properties.version!.const).toBe(2);
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
    "the readers are off by default (ADR 0210 part 6): an org pack without readers: on observes nothing",
    async () => {
      const pack = await mkdtemp(join(tmpdir(), "atticus-readers-off-"));
      try {
        await cp(join(FORGE, "metarepo/org-pack"), pack, { recursive: true });
        await rm(join(pack, "conventions.yaml"));
        const off = await scanFixture({ fixture: FORGE, orgPack: pack });
        expect(new Set(Object.values(byRepo(off.observations)))).toEqual(new Set(["readers-off"]));
        // The fixture's own pack says readers: "on": every repo is read in full.
        const on = await scanFixture({ fixture: FORGE });
        expect(Object.values(byRepo(on.observations))).not.toContain("readers-off");
      } finally {
        await rm(pack, { recursive: true, force: true });
      }
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

/**
 * ADR 0197: build.json version 2 lists each source once and each set of sources once. Version 1
 * (fixtures/forge/build-json/build.v1.json: the Forge golden as beta.28.1 wrote it) reads as the
 * version 2 golden (fixtures/forge/slots/build.json, what the build writes: build.test.ts), and
 * version 2 gives version 1 back byte for byte; a later version is refused.
 */
describe("build.json lists each source once (ADR 0197)", () => {
  it("version 1 reads as the version 2 golden, and gives version 1 back byte for byte", async () => {
    const v1 = readV1();
    const p = parseBuildManifest(v1);
    expect(p.ok, p.ok ? "" : JSON.stringify(p.issues)).toBe(true);
    if (!p.ok) return;
    // The same build, but the build's own version: beta.28.1 wrote v1, and the v2 golden is what
    // today's build writes (2.0.0-beta.30, ADR 0124 addendum E-ids), the same files and sources.
    const same = (t: string) => t.replace(/"buildVersion": "[^"]*"/, '"buildVersion": "*"');
    expect(same(serializeBuildManifest(p.slot))).toBe(same(readV2()));
    expect(serializeBuildManifestV1(manifestToV1(p.slot))).toBe(v1);
    // A Windows checkout's CRLF reads the same.
    const crlf = parseBuildManifest(readV2().replace(/\n/g, "\r\n"));
    expect(crlf.ok && serializeBuildManifest(crlf.slot)).toBe(readV2());
    const v = JSON.parse(readV2()) as { files: unknown[]; sources: object; sourceSets: object };
    expect(v.files.length).toBe((JSON.parse(v1) as { files: unknown[] }).files.length);
    expect(Object.keys(v.sourceSets).length).toBeLessThan(v.files.length);
    expect(readV2().length).toBeLessThan(v1.length / 3);
  });

  it("each set's id is the start of its paths' hash; only ids that collide are lengthened", () => {
    // Worked out by hand: printf 'catalog/sources/facts/r0.jsonl\n' | sha256sum, and the same
    // with 'catalog/sources/joins.json\n' after it.
    expect(sourceSetIds([["catalog/sources/facts/r0.jsonl"]])).toEqual(["dc63dcc663511559"]);
    expect(
      sourceSetIds([["catalog/sources/facts/r0.jsonl", "catalog/sources/joins.json"]]),
    ).toEqual(["e16dfd862b211162"]);
    const sets = Array.from({ length: 40 }, (_, k) => [`catalog/sources/facts/r${k}.jsonl`]);
    const full = sets.map((paths) =>
      createHash("sha256")
        .update(paths.map((x) => `${x}\n`).join(""))
        .digest("hex"),
    );
    // 1 digit for 40 sets can't be unique: the ids that share a start are lengthened, 4 digits at
    // a time, and only they.
    const ids = sourceSetIds(sets, 1);
    expect(new Set(ids).size).toBe(40);
    ids.forEach((id, k) => {
      expect(full[k]!.startsWith(id)).toBe(true);
      expect((id.length - 1) % 4).toBe(0);
      // Each lengthened id was lengthened because, 4 digits shorter, another set shared it.
      if (id.length > 1) {
        const shorter = id.slice(0, id.length - 4);
        expect(full.filter((h, j) => j !== k && h.startsWith(shorter)).length).toBeGreaterThan(0);
      }
    });
    // A set that shares no start with any other keeps the shortest id; the others are longer.
    const solo = sets.map((_, k) => full.every((h, j) => j === k || h[0] !== full[k]![0]));
    ids.forEach((id, k) => expect(id.length === 1).toBe(solo[k]));
    expect(new Set(ids.map((x) => x.length)).size).toBeGreaterThan(1);
    // The same sets in any order get the same ids.
    expect(sourceSetIds([...sets].reverse(), 1)).toEqual([...ids].reverse());
    expect(sourceSetIds(sets)[0]).toMatch(/^[0-9a-f]{16}$/);
    // A manifest made with short ids reads and writes back as any other.
    const p = parseBuildManifest(readV1());
    if (!p.ok) throw new Error("golden doesn't read");
    const v1 = manifestToV1(p.slot);
    const short = manifestOfFiles(v1.buildVersion, v1.files, { idDigits: 1 });
    expect(Object.keys(short.sourceSets).every((id) => id.length < 16)).toBe(true);
    // An id shorter than 16 digits isn't one version 2 reads: the writer starts at 16.
    expect(parseBuildManifest(serializeBuildManifest(short)).ok).toBe(false);
    const long = manifestOfFiles(v1.buildVersion, v1.files, { idDigits: 17 });
    const back = parseBuildManifest(serializeBuildManifest(long));
    expect(back.ok && serializeBuildManifestV1(manifestToV1(back.slot))).toBe(readV1());
  });

  it("refuses a later version (a newer Atticus wrote it), and a set or source not listed", () => {
    const v2 = JSON.parse(readV2()) as Record<string, unknown> & {
      files: { sources: string }[];
      sourceSets: Record<string, string[]>;
    };
    const newer = parseBuildManifest(JSON.stringify({ ...v2, version: 3 }));
    expect(newer.ok).toBe(false);
    expect(!newer.ok && newer.newer).toBe(3);
    expect(String(new NewerBuildManifestError("catalog/sources/build.json", 3).message)).toBe(
      "catalog/sources/build.json was written by a newer Atticus (version 3): upgrade Atticus to build here.",
    );
    const noSet = { ...v2, files: [{ ...v2.files[0]!, sources: "0".repeat(16) }] };
    expect(parseBuildManifest(JSON.stringify(noSet)).ok).toBe(false);
    const [id, paths] = Object.entries(v2.sourceSets)[0]!;
    const noSource = { ...v2, sourceSets: { ...v2.sourceSets, [id]: [...paths, "nowhere"] } };
    expect(parseBuildManifest(JSON.stringify(noSource)).ok).toBe(false);
    // Version 1 listing one source with two hashes can't be listed once: it doesn't read.
    const v1 = JSON.parse(readV1()) as {
      files: { sources: { path: string; sha256: string }[] }[];
    };
    const two = structuredClone(v1);
    two.files[1]!.sources[0]!.sha256 = "f".repeat(64);
    const twice = parseBuildManifest(JSON.stringify(two));
    expect(twice.ok).toBe(false);
    // It says what happened (edited or merged by hand), never that it is a later version.
    expect(!twice.ok && twice.issues).toEqual([
      { path: "files", message: "build.json was edited or merged by hand: build again" },
    ]);
    expect(!twice.ok && twice.newer).toBeUndefined();
  });
});
