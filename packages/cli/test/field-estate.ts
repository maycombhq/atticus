import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  catalogDirOf,
  factsDirOf,
  QuestionDraft,
  raiseQuestions,
  type CatalogRecord,
  type Fact,
} from "@maycombhq/core";
import {
  buildCacheHooks,
  buildCatalog,
  factsSlotPaths,
  legacyJoinsPath,
  loadBuildInputs,
  readersSlotPath,
  serializeLegacyJoins,
  serializeReadersSlot,
} from "@maycombhq/scanner";
import { BIG_COMMIT, bigRepoFacts, bigRepoId, makeBigEstate } from "./big-estate.js";

/**
 * An estate in the shape of the owner's field report of beta.28.3 (one repo's Apply took over
 * ten minutes on 40 repos and 12,846 records, where the 60-repo benchmark builds 100,000 in under
 * a minute): not large, but unlike big-estate.ts's in what it holds. Invented names only.
 *
 * - 40 repos: 25 services and 15 gateway proxies that front some of them (big-estate.ts).
 * - Payloads that name thousands of things: `fieldNames` distinct two-word field names (6,000),
 *   each a glossary term. big-estate.ts gives every entry the same four names, so its glossary
 *   has two dozen terms however large it is; this is what made the build slow (the naming hints
 *   read every term for each term).
 * - The 15 proxies each hold the same access file of 90 profiles, read as `term` facts with no
 *   role, so 90 values are written in 15 repos at the same lines (90 possible links).
 * - `legacy` services (4) are not read from facts yet: their records are kept from before the
 *   upgrade (a legacy readers slot each), and the arrows between them and the other repos are in
 *   the legacy joins slot.
 * - `questions` open questions (240), `links` calls a person paired by hand (corrections files
 *   with `link` lines, 48), and `suppressed` arrows a person took off the map (curated
 *   decisions, 30).
 *
 * At the defaults the build makes about 14,000 records. Deterministic for a seed.
 */
export interface FieldEstateOptions {
  services?: number;
  gateways?: number;
  entries?: number;
  calls?: number;
  fieldNames?: number;
  legacy?: number;
  questions?: number;
  links?: number;
  suppressed?: number;
  /** Services (the first ones) given a checkout under workspace/. */
  checkouts?: number;
  seed?: number;
}

export interface FieldEstate {
  root: string;
  options: Awaited<ReturnType<typeof makeBigEstate>>["options"];
  /** The repos read from facts. */
  repos: string[];
  /** The services whose records are legacy. */
  legacy: string[];
  links: number;
  suppressed: string[];
}

const reposOf = (r: CatalogRecord) => new Set(r.evidence.flatMap((e) => (e.repo ? [e.repo] : [])));

export async function makeFieldEstate(
  dir: string,
  given: FieldEstateOptions = {},
): Promise<FieldEstate> {
  const services = given.services ?? 25;
  const gateways = given.gateways ?? 15;
  const made = await makeBigEstate(dir, {
    repos: services,
    gateways,
    entries: given.entries ?? 60,
    calls: given.calls ?? 40,
    tables: 8,
    settings: 40,
    routes: 20,
    checkouts: given.checkouts ?? 2,
    seed: given.seed ?? 1,
    fieldNames: given.fieldNames ?? 6000,
    termRepos: gateways,
    termValues: 90,
  });
  const { root, options } = made;

  // The catalog as every repo's facts give it, in memory: what the legacy slots and the curated
  // decisions below are made from, as an upgrade adopts the catalog it finds.
  buildCacheHooks.off = true;
  let first: Awaited<ReturnType<typeof buildCatalog>>;
  try {
    first = await buildCatalog(await loadBuildInputs(root));
  } finally {
    buildCacheHooks.off = false;
  }

  // ---- the legacy services: the last ones (the first have checkouts and are the ones changed)
  const legacy = Array.from({ length: Math.min(given.legacy ?? 4, services - 2) }, (_, k) =>
    bigRepoId(services - 1 - k),
  ).sort();
  const isLegacy = new Set(legacy);
  for (const repo of legacy) {
    const records = first.records.filter((r) => {
      const of = reposOf(r);
      return of.size === 1 && of.has(repo) && r.kind !== "GlossaryTerm" && r.kind !== "Capability";
    });
    const path = readersSlotPath(root, repo);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      serializeReadersSlot({
        slotVersion: 1,
        kind: "readers",
        repo,
        commit: BIG_COMMIT,
        status: "legacy",
        extractors: [],
        settings: null,
        records,
      }),
    );
    const slot = factsSlotPaths(root, repo);
    for (const p of [slot.facts, slot.meta, join(factsDirOf(root), `${repo}.jsonl`)])
      await rm(p, { force: true });
  }
  // The arrows between a legacy service and another repo, as the upgrade adopted them.
  const joins = first.records.filter((r) => {
    if (r.kind !== "Interface") return false;
    const of = reposOf(r);
    return of.size > 1 && [...of].some((repo) => isLegacy.has(repo));
  });
  if (legacy.length) {
    await mkdir(dirname(legacyJoinsPath(root)), { recursive: true });
    await writeFile(
      legacyJoinsPath(root),
      serializeLegacyJoins({
        slotVersion: 1,
        kind: "legacy-joins",
        status: "legacy",
        records: joins,
        inputs: {},
      }),
    );
  }
  const read = made.repos.filter((r) => !isLegacy.has(r));

  // ---- open questions, as a survey of each repo leaves them
  const perRepo = Math.ceil((given.questions ?? 240) / read.length);
  let asked = 0;
  for (const repo of read) {
    const n = Math.min(perRepo, (given.questions ?? 240) - asked);
    if (n <= 0) break;
    asked += n;
    await raiseQuestions(
      root,
      Array.from({ length: n }, (_, q) =>
        QuestionDraft.parse({
          question: `Which system serves GET /v1/items-${q}/{id} for ${repo}?`,
          options: [
            { label: "forge-svc-00", means: "the service serves it", changes: "the call joins it" },
            { label: "Outside", means: "a vendor", changes: "the call is drawn outside" },
          ],
          evidence: [`src/main/java/forge/client/Client${q}.java:${10 + q}`],
        }),
      ),
      {
        step: "scan-survey",
        repo,
        command: `atticus scan survey ${repo}`,
        rerun: `atticus scan survey ${repo} --force`,
        at: "2026-11-06T12:00:00.000Z",
      },
    );
  }

  // ---- calls a person paired by hand: the calls to a deploy token nothing sets (loose ends),
  //      each linked to an entry of the next service read from facts
  let links = 0;
  const want = given.links ?? 48;
  for (let r = 2; r < services && links < want; r++) {
    const repo = bigRepoId(r);
    if (isLegacy.has(repo)) continue;
    let to = (r + 1) % services;
    while (isLegacy.has(bigRepoId(to))) to = (to + 1) % services;
    const entry = bigRepoFacts(to, options).facts.find((f) => f.kind === "entry")! as Fact & {
      method: string;
      path: string;
    };
    const lines: string[] = [];
    for (const f of bigRepoFacts(r, options).facts) {
      if (links >= want) break;
      if (f.kind !== "call" || !(f.host ?? "").startsWith("@forgeTargetUrl")) continue;
      links++;
      lines.push(
        JSON.stringify({
          schemaVersion: 1,
          fact: f.id,
          target: { kind: "call", file: f.cite.file, line: f.cite.line, value: f.cite.value },
          action: "link",
          link: { repo: bigRepoId(to), entry: entry.id, method: entry.method, path: entry.path },
          by: "pat",
          at: "2026-11-10T09:00:00Z",
        }),
      );
    }
    if (lines.length)
      await writeFile(join(factsDirOf(root), `${repo}.corrections.jsonl`), lines.join("\n") + "\n");
  }

  // ---- arrows a person took off the map
  const suppressed = first.records
    .filter((r) => r.kind === "Interface" && [...reposOf(r)].every((x) => !isLegacy.has(x)))
    .map((r) => r.id)
    .sort()
    .filter((_, k) => k % 7 === 0)
    .slice(0, given.suppressed ?? 30);
  const curated = join(catalogDirOf(root), "curated", "curateddecision");
  await mkdir(curated, { recursive: true });
  for (const [k, target] of suppressed.entries())
    await writeFile(
      join(curated, `dec-suppress-${k}.yaml`),
      [
        "schemaVersion: 2",
        "kind: CuratedDecision",
        `id: dec-suppress-${k}`,
        "status: current",
        "confidence: asserted",
        "evidence: []",
        `target: ${JSON.stringify(target)}`,
        "action: suppress",
        "value: null",
        "reason: not a call this service makes",
        "by: pat",
        "at: 2026-11-12T00:00:00Z",
        "",
      ].join("\n"),
    );
  return { root, options, repos: read, legacy, links, suppressed };
}
