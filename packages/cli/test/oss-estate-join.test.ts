import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  ContractsFile,
  JOIN_GUESS_FLAGS,
  loadOrgPack,
  parseFacts,
  type CatalogRecord,
  type Fact,
  type OrgPack,
} from "@maycombhq/core";
import {
  buildCacheHooks,
  buildCatalog,
  factsSnapshotWrites,
  loadBuildInputs,
  measureLinks,
  parseLinkReference,
  type LinkReference,
} from "@maycombhq/scanner";

/**
 * WP-12 (v31): a real estate of two public repos (fixtures/oss-estate/README.md), its verified
 * facts stored at pinned commits and no source checked out. The catalog is built from the
 * stored facts as Apply builds it, offline, and its arrows (Interface records) are compared with
 * the arrows a person wrote down from the source (reference-links.yaml); the estate join is also
 * scored with the link scorer (`measureLinks`). A change to the join that loses a true arrow, or
 * draws one nobody wrote down without saying it is a guess, fails here and names the arrow.
 */

const FIX = join(__dirname, "..", "..", "..", "fixtures", "oss-estate");
const COMMITS = {
  "spring-petclinic-rest": "afc8fc1d3b8ec8de69414482b3bd70a1da78cb95",
  "spring-petclinic-angular": "7c9f1ab259f0dbc8a987c4e21d97dc616607b362",
} as const;
type Repo = keyof typeof COMMITS;
const REPOS = Object.keys(COMMITS) as Repo[];
const CALLER: Repo = "spring-petclinic-angular";
const CALLEE: Repo = "spring-petclinic-rest";

const factsOf = (repo: Repo): Fact[] => {
  const r = parseFacts(readFileSync(join(FIX, "facts", `${repo}.jsonl`), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};

const referenceText = readFileSync(join(FIX, "reference-links.yaml"), "utf8");
const reference = (): LinkReference => {
  const r = parseLinkReference(referenceText);
  if (!r.ok) throw new Error(r.issues.join("\n"));
  return r.reference;
};

/** One true arrow: the caller's line, to the callee's entry (its method, path and line). */
interface Arrow {
  at: string;
  method: string;
  path: string;
  entryAt: string;
}
const NOTE = /^(\S+) (\S+) at (\S+:\d+)$/;
/** The reference's arrows, each call's `note` naming the entry it reaches. */
function referenceArrows(): Arrow[] {
  const raw = parse(referenceText) as {
    repos: { repo: string; calls?: { at: string; note: string }[] }[];
  };
  return raw.repos
    .filter((r) => r.repo === CALLER)
    .flatMap((r) => r.calls ?? [])
    .map((c) => {
      const m = NOTE.exec(c.note);
      if (!m)
        throw new Error(`reference-links.yaml: note "${c.note}" is not METHOD /path at file:line`);
      return { at: c.at, method: m[1]!, path: m[2]!, entryAt: m[3]! };
    });
}

const params = (p: string) => p.replace(/\{[^}]*\}/g, "{}");
const label = (a: Arrow) => `${a.at} -> ${a.method} ${a.path}`;

type Interface = Extract<CatalogRecord, { kind: "Interface" }>;
/** A drawn arrow as the reference writes one: one per caller line it cites. */
function drawnArrows(records: readonly CatalogRecord[]) {
  return records
    .filter((r): r is Interface => r.kind === "Interface")
    .flatMap((i) => {
      const end = (side: string) => i.evidence.filter((e) => e.side === side);
      const callee = end("callee")[0];
      return end("caller").map((c) => ({
        at: `${c.path}:${c.line}`,
        from: i.from,
        to: i.to,
        method: i.method ?? "",
        path: i.normalizedPath ?? "",
        entryAt: callee ? `${callee.path}:${callee.line}` : "",
        flags: i.flags ?? [],
        confidence: i.confidence,
      }));
    });
}
type Drawn = ReturnType<typeof drawnArrows>[number];

const same = (want: Arrow, got: Drawn) =>
  got.from === CALLER &&
  got.to === CALLEE &&
  got.at === want.at &&
  got.method === want.method &&
  params(got.path) === params(want.path) &&
  got.entryAt === want.entryAt;

/** The reference's arrows not drawn, and the drawn ones not in the reference with no guess flag. */
function compare(want: readonly Arrow[], drawn: readonly Drawn[]) {
  const guess = new Set<string>(JOIN_GUESS_FLAGS);
  return {
    notDrawn: want.filter((w) => !drawn.some((d) => same(w, d))).map(label),
    unflagged: drawn
      .filter((d) => !want.some((w) => same(w, d)))
      .filter((d) => d.confidence !== "inferred" && !d.flags.some((f) => guess.has(f)))
      .map((d) => `${d.from} ${d.at} -> ${d.to} ${d.method} ${d.path} (${d.entryAt})`),
  };
}

let root: string;
let op: OrgPack;
let records: CatalogRecord[];

beforeAll(async () => {
  // A metarepo of the fixture's org pack and the stored facts in their slots: no workspace, no
  // clone, so the build reads nothing but these.
  root = await mkdtemp(join(tmpdir(), "oss-estate-"));
  await cp(join(FIX, "org-pack"), join(root, "org-pack"), { recursive: true });
  await writeFile(
    join(root, "org-pack", "pack.yaml"),
    "schemaVersion: 1\nname: petclinic\nversion: 0.1.0\nowner: team-clinic\n",
  );
  const contracts = ContractsFile.parse(
    parse(readFileSync(join(FIX, "facts", `${CALLEE}.contracts.yaml`), "utf8")),
  );
  for (const repo of REPOS) {
    const writes = factsSnapshotWrites(root, repo, factsOf(repo), {
      commit: COMMITS[repo],
      contracts: repo === CALLEE ? contracts : null,
    });
    for (const w of writes) {
      await mkdir(dirname(w.path), { recursive: true });
      await writeFile(w.path, w.text!);
    }
  }
  op = await loadOrgPack(join(root, "org-pack"));
  buildCacheHooks.off = true;
  try {
    records = (await buildCatalog(await loadBuildInputs(root, { op }))).records;
  } finally {
    buildCacheHooks.off = false;
  }
}, 120_000);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("the public estate (spring-petclinic-angular and -rest), built from stored facts offline", () => {
  it("the reference lists every call the Angular services make, each to one REST entry", () => {
    const want = referenceArrows();
    expect(want).toHaveLength(31);
    expect(new Set(want.map((a) => a.at)).size).toBe(31);
    // Every listed entry line is the line of a REST entry fact: the reference and the facts agree.
    const entries = new Set(
      factsOf(CALLEE)
        .filter((f) => f.kind === "entry")
        .map((f) => `${f.cite.file}:${f.cite.line}`),
    );
    expect(want.filter((a) => !entries.has(a.entryAt)).map(label)).toEqual([]);
  });

  it("draws every true arrow, and none the reference lacks without a guess flag", () => {
    const drawn = drawnArrows(records);
    const { notDrawn, unflagged } = compare(referenceArrows(), drawn);
    expect(notDrawn, `true arrows not drawn:\n${notDrawn.join("\n")}`).toEqual([]);
    expect(unflagged, `arrows drawn that the reference lacks:\n${unflagged.join("\n")}`).toEqual(
      [],
    );
    // 31 calls, two of them (GET /owners, and the search by last name) on one Interface.
    expect(records.filter((r) => r.kind === "Interface")).toHaveLength(30);
    expect(drawn).toHaveLength(31);
  });

  it("names the arrow when a join loses one", () => {
    const drawn = drawnArrows(records);
    const lost = drawn.find((d) => d.at === "src/app/visits/visit.service.ts:65")!;
    expect(lost).toBeDefined();
    const { notDrawn } = compare(
      referenceArrows(),
      drawn.filter((d) => d !== lost),
    );
    expect(notDrawn).toEqual([
      "src/app/visits/visit.service.ts:65 -> POST /petclinic/api/owners/{ownerId}/pets/{petId}/visits",
    ]);
  });

  it("names an arrow drawn to the wrong entry, and one nobody wrote down", () => {
    const drawn = drawnArrows(records);
    const moved = drawn.map((d) =>
      d.at === "src/app/vets/vet.service.ts:49"
        ? { ...d, entryAt: "src/main/resources/openapi.yml:1680" }
        : d,
    );
    const extra = { ...drawn[0]!, at: "src/app/app.component.ts:1" };
    const { notDrawn, unflagged } = compare(referenceArrows(), [...moved, extra]);
    expect(notDrawn).toEqual(["src/app/vets/vet.service.ts:49 -> GET /petclinic/api/vets"]);
    expect(unflagged).toHaveLength(2);
    // A guess flag is the one way an arrow absent from the reference may stand.
    expect(
      compare(referenceArrows(), [...drawn, { ...extra, flags: ["joined-by-path"] }]).unflagged,
    ).toEqual([]);
  });

  it("scores 1.0 precision and recall with the link scorer, every listed entry and call read", () => {
    const m = measureLinks({
      op,
      repos: REPOS.map((repo) => ({ repo, facts: factsOf(repo) })),
      reference: reference(),
    });
    expect(m.notes).toEqual([]);
    expect(m.reading).toEqual({
      entries: { want: 37, found: 37 },
      calls: { want: 31, found: 31 },
      missed: [],
    });
    expect(m.calls.filter((c) => !c.right).map((c) => `${c.call} at ${c.at}`)).toEqual([]);
    expect(m.links).toMatchObject({
      want: 31,
      joined: 31,
      right: 31,
      precision: 1,
      recall: 1,
      asked: 0,
      missed: 0,
      unlinked: 0,
      notRead: 0,
      inferred: { joined: 0, right: 0 },
    });
  });

  it("stores no source: only facts, with short quotes", () => {
    for (const repo of REPOS)
      for (const f of factsOf(repo)) expect(f.cite.quote?.length ?? 0).toBeLessThanOrEqual(120);
  });
});
