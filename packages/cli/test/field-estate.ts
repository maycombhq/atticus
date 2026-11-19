import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  catalogDirOf,
  changesDirOf,
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
  factsSnapshotWrites,
  legacyJoinsPath,
  loadBuildInputs,
  readersSlotPath,
  serializeLegacyJoins,
  serializeReadersSlot,
} from "@maycombhq/scanner";
import { compoundOf, termId } from "@maycombhq/glossary";
import { BIG_COMMIT, bigFieldName, bigRepoFacts, bigRepoId, makeBigEstate } from "./big-estate.js";

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
 * - What the naming hints act on: one field name in fifty shortens the name before it
 *   (big-estate.ts's `bigFieldShortens`), which the glossary leaves out as a term, and a person's
 *   alias decision gives the second field name to the first's term.
 *
 * At the defaults the build makes about 14,000 records. Deterministic for a seed.
 *
 * beta.30 (ADR 0201), each only when its option is given, so the estate without them is the one
 * it always was:
 *
 * - `emptyRepo`: a repo the manifest lists, cloned, with nothing in it yet (a `.git` folder and
 *   no other): made on the Git host for work that hasn't begun. Nobody read it.
 * - `unreadRepo`: a repo the manifest lists that nobody cloned or read: no facts, no records.
 * - `topic`: a topic the estate already has. The third service publishes to it and the fourth
 *   listens to it (`FIELD_TOPIC_PUBLISHER`, `FIELD_TOPIC_LISTENER`), each read from a fact.
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
  /** A repo the manifest lists whose clone is empty (its id). None by default. */
  emptyRepo?: string;
  /** A repo the manifest lists that nobody cloned or read (its id). None by default. */
  unreadRepo?: string;
  /** A topic one service publishes to and another listens to (its name). None by default. */
  topic?: string;
}

/** The service that publishes to the estate's topic, and the one that listens to it. */
export const FIELD_TOPIC_PUBLISHER = bigRepoId(2);
export const FIELD_TOPIC_LISTENER = bigRepoId(3);

/**
 * The two facts of the estate's topic: the publisher's call from its first entry, and the
 * listener's entry. In a repo that has a clone, the line it cites is written there too.
 */
async function writeTopic(
  root: string,
  topic: string,
  options: FieldEstate["options"],
  checkouts: number,
): Promise<void> {
  const base = { commit: BIG_COMMIT, verified: "line", by: "assistant", conf: "declared" };
  const publish = {
    file: "src/main/java/forge/events/ItemEvents.java",
    quote: `kafka.send("${topic}", event);`,
  };
  const listen = {
    file: "src/main/java/forge/events/ItemListener.java",
    quote: `@KafkaListener(topics = "${topic}")`,
  };
  const extra: [number, typeof publish, Record<string, unknown>][] = [
    [
      2,
      publish,
      {
        kind: "call",
        id: "c-publish-topic",
        callType: "event-topic",
        method: "publish",
        path: topic,
        from: "e-0",
        cite: { file: publish.file, line: 1, value: topic, quote: publish.quote },
      },
    ],
    [
      3,
      listen,
      {
        kind: "entry",
        id: "e-on-topic",
        entryType: "event-topic",
        path: topic,
        handler: "ItemListener.on",
        cite: { file: listen.file, line: 1, value: topic, quote: listen.quote },
      },
    ],
  ];
  for (const [r, at, fact] of extra) {
    const repo = bigRepoId(r);
    const facts = [
      ...bigRepoFacts(r, options).facts,
      { ...base, repo, ...fact } as unknown as Fact,
    ];
    await writeFile(
      join(factsDirOf(root), `${repo}.jsonl`),
      facts.map((f) => JSON.stringify(f)).join("\n") + "\n",
    );
    for (const w of factsSnapshotWrites(root, repo, facts, {
      commit: BIG_COMMIT,
      contracts: null,
    })) {
      await mkdir(dirname(w.path), { recursive: true });
      await writeFile(w.path, w.text!);
    }
    // In a clone, the line the fact cites.
    if (r < checkouts) {
      const p = join(root, "workspace", repo, ...at.file.split("/"));
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, `        ${at.quote}\n`);
    }
  }
}

/**
 * A change's files as a person or their personas write them (ADR 0201): each path, with forward
 * slashes, under the change's folder, with LF line ends on every platform. Returns the folder.
 */
export async function writeChangeFiles(
  root: string,
  change: string,
  files: Readonly<Record<string, string>>,
): Promise<string> {
  const dir = join(changesDirOf(root), change);
  for (const [path, text] of Object.entries(files)) {
    const p = join(dir, ...path.split("/"));
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, text.replace(/\r\n/g, "\n"), "utf8");
  }
  return dir;
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
  /** The repo the manifest lists whose clone is empty (`emptyRepo`). */
  emptyRepo?: string;
  /** The repo the manifest lists that nobody read (`unreadRepo`). */
  unreadRepo?: string;
  /** The estate's topic, who publishes to it and who listens (`topic`). */
  topic?: { name: string; publisher: string; listener: string };
}

/** The glossary term the v-th field name is (big-estate.ts's `fieldNames`), by its id. */
export const termOfField = (v: number) => termId(compoundOf(bigFieldName(v))!);

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
  const checkouts = given.checkouts ?? 2;

  // ---- beta.30: repos the manifest lists that nobody read, and the estate's topic
  const listed = [given.emptyRepo, given.unreadRepo].filter((x): x is string => !!x);
  if (listed.length)
    await appendFile(
      join(root, "org-pack/profiles/github/repos.manifest.yaml"),
      listed
        .flatMap((id) => [
          `  - id: ${id}`,
          `    url: https://git.example.test/forge/${id}.git`,
          "    type: spring-boot",
          "    owner: team-forge",
          `    system: ${id}`,
          `    hosts: [${id}.forge.example]`,
        ])
        .join("\n") + "\n",
    );
  if (given.emptyRepo)
    await mkdir(join(root, "workspace", given.emptyRepo, ".git"), { recursive: true });
  if (given.topic) await writeTopic(root, given.topic, options, checkouts);

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
  // ---- another name a person gave a term: the second field name is the first's term too
  const alias = { term: termOfField(0), name: compoundOf(bigFieldName(1))! };
  await writeFile(
    join(curated, "dec-alias-field-1.yaml"),
    [
      "schemaVersion: 2",
      "kind: CuratedDecision",
      "id: dec-alias-field-1",
      "status: current",
      "confidence: asserted",
      "evidence: []",
      `target: ${alias.term}`,
      "action: alias",
      `value: [${JSON.stringify(alias.name)}]`,
      "reason: the same thing under two names",
      "by: pat",
      "at: 2026-11-12T00:00:00Z",
      "",
    ].join("\n"),
  );
  return {
    root,
    options,
    repos: read,
    legacy,
    links,
    suppressed,
    ...(given.emptyRepo ? { emptyRepo: given.emptyRepo } : {}),
    ...(given.unreadRepo ? { unreadRepo: given.unreadRepo } : {}),
    ...(given.topic
      ? {
          topic: {
            name: given.topic,
            publisher: FIELD_TOPIC_PUBLISHER,
            listener: FIELD_TOPIC_LISTENER,
          },
        }
      : {}),
  };
}
