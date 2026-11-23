import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  ContractsFile,
  JOIN_GUESS_FLAGS,
  JOINED_BY_REPO,
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
 *
 * Each arrow is checked by the Endpoint it reaches (its id, and that Endpoint's method and path
 * against the entry the reference writes), not by the callee's line: every method on one
 * OpenAPI path cites the same path-key line, so a GET joined to the POST entry has the right
 * line and the wrong Endpoint. The catalog is built twice, with the REST repo's stored
 * contracts (as Apply stores them) and with none, so the facts join alone is scored too.
 *
 * A true arrow must also be the estate join's: it carries the join's how, `joined-by-repo` (each
 * call names its repo). The catalog's merge has a linker of its own (core's `mergeCatalog`
 * matches a projected call that names its callee to an Endpoint by method and path), which
 * draws the same Interfaces with no join flag when the join asks instead. Without this check
 * that linker hid join regressions; the stored contracts did not (the facts-only build drew the
 * same). Proved to bite (2026-11-22, by editing core's built dist/facts-join.js and restoring
 * it): `sameMethod` always true fails "draws every true arrow" on both builds, naming 28 arrows
 * (the join asks, ambiguous), and `routeScore` 0 on an exact match fails it naming all 31;
 * the link scorer's figures fail beside them.
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
  /** The id of the Endpoint record the catalog gives that entry. */
  endpoint: string;
}
const NOTE = /^(\S+) (\S+) at (\S+:\d+), endpoint (\S+)$/;
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
        throw new Error(
          `reference-links.yaml: note "${c.note}" is not METHOD /path at file:line, endpoint <id>`,
        );
      return { at: c.at, method: m[1]!, path: m[2]!, entryAt: m[3]!, endpoint: m[4]! };
    });
}

const params = (p: string) => p.replace(/\{[^}]*\}/g, "{}");
const label = (a: Arrow) => `${a.at} -> ${a.method} ${a.path}`;

type Interface = Extract<CatalogRecord, { kind: "Interface" }>;
type Endpoint = Extract<CatalogRecord, { kind: "Endpoint" }>;
/**
 * A drawn arrow as the reference writes one: one per caller line it cites, with the method and
 * path of the Endpoint record it reaches (not the Interface's own, which are the call's).
 */
function drawnArrows(records: readonly CatalogRecord[]) {
  const endpoints = new Map(
    records.filter((r): r is Endpoint => r.kind === "Endpoint").map((e) => [e.id, e] as const),
  );
  return records
    .filter((r): r is Interface => r.kind === "Interface")
    .flatMap((i) => {
      const end = (side: string) => i.evidence.filter((e) => e.side === side);
      const callee = end("callee")[0];
      const ep = i.endpoint ? endpoints.get(i.endpoint) : undefined;
      return end("caller").map((c) => ({
        at: `${c.path}:${c.line}`,
        from: i.from,
        to: i.to,
        endpoint: i.endpoint ?? "",
        method: ep?.method ?? "",
        path: ep?.normalizedPath ?? "",
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
  got.flags.includes(JOINED_BY_REPO) &&
  got.endpoint === want.endpoint &&
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
      .map((d) => `${d.from} ${d.at} -> ${d.to} ${d.endpoint} ${d.method} ${d.path}`),
  };
}

let root: string;
let op: OrgPack;
/** The catalog built with the REST repo's stored contracts, and with none (the facts join alone). */
const builds: Record<"with contracts" | "facts only", CatalogRecord[]> = {
  "with contracts": [],
  "facts only": [],
};
const BUILDS = Object.keys(builds) as (keyof typeof builds)[];
let records: CatalogRecord[];

async function writeSlots(withContracts: boolean) {
  const contracts = ContractsFile.parse(
    parse(readFileSync(join(FIX, "facts", `${CALLEE}.contracts.yaml`), "utf8")),
  );
  for (const repo of REPOS) {
    const writes = factsSnapshotWrites(root, repo, factsOf(repo), {
      commit: COMMITS[repo],
      contracts: repo === CALLEE && withContracts ? contracts : null,
    });
    for (const w of writes) {
      await mkdir(dirname(w.path), { recursive: true });
      await writeFile(w.path, w.text!);
    }
  }
}

beforeAll(async () => {
  // A metarepo of the fixture's org pack and the stored facts in their slots: no workspace, no
  // clone, so the build reads nothing but these.
  root = await mkdtemp(join(tmpdir(), "oss-estate-"));
  await cp(join(FIX, "org-pack"), join(root, "org-pack"), { recursive: true });
  await writeFile(
    join(root, "org-pack", "pack.yaml"),
    "schemaVersion: 1\nname: petclinic\nversion: 0.1.0\nowner: team-clinic\n",
  );
  op = await loadOrgPack(join(root, "org-pack"));
  buildCacheHooks.off = true;
  try {
    for (const name of BUILDS) {
      await writeSlots(name === "with contracts");
      builds[name] = (await buildCatalog(await loadBuildInputs(root, { op }))).records;
    }
  } finally {
    buildCacheHooks.off = false;
  }
  records = builds["with contracts"];
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

  it.each(BUILDS)(
    "%s: draws every true arrow, and none the reference lacks without a guess flag",
    (name) => {
      const records = builds[name];
      const drawn = drawnArrows(records);
      const { notDrawn, unflagged } = compare(referenceArrows(), drawn);
      expect(notDrawn, `true arrows not drawn:\n${notDrawn.join("\n")}`).toEqual([]);
      expect(unflagged, `arrows drawn that the reference lacks:\n${unflagged.join("\n")}`).toEqual(
        [],
      );
      // 31 calls, two of them (GET /owners, and the search by last name) on one Interface.
      expect(records.filter((r) => r.kind === "Interface")).toHaveLength(30);
      expect(drawn).toHaveLength(31);
    },
  );

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
    // GET /vets joined to POST /vets: the same path-key line, another Endpoint.
    const post = drawn.find((d) => d.at === "src/app/vets/vet.service.ts:70")!;
    const moved = drawn.map((d) =>
      d.at === "src/app/vets/vet.service.ts:49"
        ? { ...d, endpoint: post.endpoint, method: post.method, entryAt: post.entryAt }
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
    // These counts carry the precision guarantee for inferred arrows: no arrow here is a guess,
    // so one that becomes inferred, or a guess that is wrong, changes them and fails.
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
