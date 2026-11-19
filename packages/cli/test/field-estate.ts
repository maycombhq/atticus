import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
import {
  CARD_WORDS,
  orderedFlags,
  RECORD_BANDS,
  REPO_BANDS,
  SHAPE_FLAGS,
  type RecordBand,
  type RepoBand,
  type Shape,
  type ShapeFlag,
} from "../src/shape-words.js";
import {
  BIG_COMMIT,
  bigFieldName,
  bigGatewayFacts,
  bigGatewayId,
  bigRepoFacts,
  bigRepoId,
  makeBigEstate,
} from "./big-estate.js";

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
  /** Tables per service (8) and settings per service (40): a shape makes a small estate smaller. */
  tables?: number;
  settings?: number;
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
  /**
   * ADR 0202 point 10: the shape card's words (`atticus selfcheck` prints them), as an object or
   * as the card's text. The estate is then made at that shape: each band at its one fixed size
   * (`REPOS_AT`, `RECORDS_AT`), and each flag adds its invented Forge shape, the others left
   * out. Without it `ATTICUS_FIELD_SHAPE` is read, the same words; with neither, the estate is
   * the one it always was. An option given beside a shape wins over what the shape would set.
   */
  shape?: Shape | string;
}

/**
 * A shape from its words (commas or spaces between them; the card's other words, a platform or
 * a step and its time, are allowed and ignored). A word that is not on the list is refused: a
 * shape is only ever made of these words. A band left out is the smallest.
 */
export function parseShape(text: string): Shape {
  const shape: Shape = { repos: "1-5", records: "under-1k", flags: [] };
  for (const w of text.split(/[\s,;+]+/).filter(Boolean)) {
    const word = w.replace(/:$/, "");
    if ((REPO_BANDS as readonly string[]).includes(word)) shape.repos = word as RepoBand;
    else if ((RECORD_BANDS as readonly string[]).includes(word)) shape.records = word as RecordBand;
    else if ((SHAPE_FLAGS as readonly string[]).includes(word)) shape.flags.push(word as ShapeFlag);
    else if (!CARD_WORDS.has(word))
      throw new Error(
        `"${word.slice(0, 40)}" is not a word of the shape card. Its words: ${[...REPO_BANDS, ...RECORD_BANDS, ...SHAPE_FLAGS].join(", ")}.`,
      );
  }
  shape.flags = orderedFlags(shape.flags);
  return shape;
}

/** The fixed size each band is made at: how many repos the manifests list in all. */
export const REPOS_AT: Record<RepoBand, number> = {
  "1-5": 4,
  "6-20": 12,
  "21-50": 40,
  "51-100": 70,
  "over-100": 120,
};

/** The fixed size each band is made at: about how many records the build makes. */
export const RECORDS_AT: Record<RecordBand, number> = {
  "under-1k": 500,
  "1k-10k": 4_000,
  "10k-50k": 14_000,
  "50k-200k": 80_000,
  "over-200k": 250_000,
};

/** The invented repos a shape's flags add, each one repo of the manifest. */
export const SHAPE_REPOS = {
  "repos-with-no-system": "forge-nosystem-svc",
  "dotted-ids": "forge.instruments.svc",
  "nested-payloads": "forge-nested-svc",
  "empty-repo": "forge-empty-svc",
  "unread-repo": "forge-unread-svc",
} as const;

/**
 * The options a shape stands for. A hand pairing with a repo that is no gateway is a hand
 * pairing, so `non-gateway-callee` brings `hand-pairings`; a hand pairing that is only ever with
 * a gateway needs `gateway-proxies`. A shape that needs more repos than its band holds is
 * refused, never quietly made larger.
 */
export function fieldOptionsOf(shape: Shape): FieldEstateOptions & { flags: Set<ShapeFlag> } {
  const flags = new Set<ShapeFlag>(shape.flags);
  if (flags.has("non-gateway-callee")) flags.add("hand-pairings");
  if (
    flags.has("hand-pairings") &&
    !flags.has("non-gateway-callee") &&
    !flags.has("gateway-proxies")
  )
    throw new Error(
      "hand-pairings without non-gateway-callee pairs calls with a gateway only: add gateway-proxies, or non-gateway-callee.",
    );
  const total = REPOS_AT[shape.repos];
  const extras = (Object.keys(SHAPE_REPOS) as (keyof typeof SHAPE_REPOS)[]).filter((f) =>
    flags.has(f),
  ).length;
  const legacy = flags.has("legacy-slots") ? Math.max(1, Math.min(4, Math.floor(total / 8))) : 0;
  // A legacy slot is one of the last services; the first two are the ones with checkouts.
  const least = legacy ? legacy + 2 : 2;
  // Gateway g fronts service g, so there are never more gateways than services.
  const gateways = flags.has("gateway-proxies")
    ? Math.max(
        1,
        Math.min(
          Math.round((total * 3) / 8),
          Math.floor((total - extras) / 2),
          total - extras - least,
        ),
      )
    : 0;
  const services = Math.max(least, gateways, total - gateways - extras);
  const top = [5, 20, 50, 100, Infinity][REPO_BANDS.indexOf(shape.repos)]!;
  if (services + gateways + extras > top)
    throw new Error(
      `This shape needs ${services + gateways + extras} repos, more than the band ${shape.repos} holds: use a larger band for repos, or fewer flags.`,
    );
  // About how many records a build makes of it, measured on this estate (beta.30): a service's
  // component and store, its settings and tables, about 0.56 a call, 3.5 an entry; a gateway's
  // 3.3 a route (20 at most); a glossary term for each field name the entries use.
  const want = RECORDS_AT[shape.records];
  const fieldNames = want >= 10_000 ? Math.min(6000, Math.round(want * 0.3)) : 0;
  const records = (e: number, calls: number, settings: number, tables: number) =>
    20 +
    services * (2 + settings + tables + 0.56 * calls + 3.5 * e) +
    gateways * (4 + 3.3 * Math.min(20, e)) +
    0.95 * Math.min(fieldNames, 4 * e * services);
  // The estate's own sizes first; a small band takes fewer settings and tables, then calls.
  const tier = (
    [
      [40, 40, 8],
      [40, 10, 2],
      [40, 1, 1],
      [12, 1, 1],
    ] as const
  ).find(([c, k, t]) => records(2, c, k, t) <= want);
  if (!tier)
    throw new Error(
      `${services + gateways} repos can't be made with as few records as ${shape.records}: use a larger band for records, or a smaller one for repos.`,
    );
  const [calls, settings, tables] = tier;
  let entries = 2;
  while (entries < 5000 && records(entries, calls, settings, tables) < want) entries++;
  return {
    flags,
    services,
    gateways,
    entries,
    calls,
    settings,
    tables,
    fieldNames,
    legacy,
    questions: Math.min(240, services * 4),
    links: flags.has("hand-pairings") ? Math.min(48, services) : 0,
    suppressed: Math.min(30, services),
    ...(flags.has("empty-repo") ? { emptyRepo: SHAPE_REPOS["empty-repo"] } : {}),
    ...(flags.has("unread-repo") ? { unreadRepo: SHAPE_REPOS["unread-repo"] } : {}),
  };
}

/** A small repo the manifest lists, read from facts: one entry, with the fields given. */
async function writeShapeRepo(
  root: string,
  repo: string,
  o: { system?: string; url: string; fields?: string[] },
): Promise<void> {
  await appendFile(
    join(root, "org-pack/profiles/github/repos.manifest.yaml"),
    [
      `  - id: ${repo}`,
      `    url: ${o.url}`,
      "    type: spring-boot",
      "    owner: team-forge",
      ...(o.system ? [`    system: ${o.system}`] : []),
      `    hosts: [${repo.replace(/\./g, "-")}.forge.example]`,
      "",
    ].join("\n"),
  );
  const base = { repo, commit: BIG_COMMIT, verified: "line", by: "assistant", conf: "declared" };
  const file = "src/main/java/forge/api/ShapeController.java";
  const quote = '@GetMapping("/v1/shapes/{id}")';
  const facts = [
    {
      ...base,
      kind: "entry",
      id: "e-shape",
      entryType: "rest",
      method: "GET",
      path: "/v1/shapes/{id}",
      handler: "ShapeController.get",
      cite: { file, line: 1, value: "/v1/shapes/{id}", quote },
    },
    ...(o.fields ?? []).map((name, k) => ({
      ...base,
      kind: "field",
      id: `f-shape-${k}`,
      owner: "e-shape",
      side: "response",
      name,
      type: "string",
      cite: { file, line: 2 + k, value: name, quote: `// ${name}` },
    })),
  ] as unknown as Fact[];
  await mkdir(factsDirOf(root), { recursive: true });
  await writeFile(
    join(factsDirOf(root), `${repo}.jsonl`),
    facts.map((f) => JSON.stringify(f)).join("\n") + "\n",
  );
  for (const w of factsSnapshotWrites(root, repo, facts, { commit: BIG_COMMIT, contracts: null })) {
    await mkdir(dirname(w.path), { recursive: true });
    await writeFile(w.path, w.text!);
  }
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
  options0: FieldEstateOptions = {},
): Promise<FieldEstate> {
  // ADR 0202 point 10: the shape card's words, given or in ATTICUS_FIELD_SHAPE.
  const words = options0.shape ?? process.env.ATTICUS_FIELD_SHAPE;
  const shaped = words
    ? fieldOptionsOf(typeof words === "string" ? parseShape(words) : words)
    : undefined;
  const flags = shaped?.flags;
  const given: FieldEstateOptions = { ...shaped, ...options0 };
  const services = given.services ?? 25;
  const gateways = given.gateways ?? 15;
  const made = await makeBigEstate(dir, {
    ...(flags && !flags.has("deploy-token-hosts") ? { tokens: false } : {}),
    repos: services,
    gateways,
    entries: given.entries ?? 60,
    calls: given.calls ?? 40,
    tables: given.tables ?? 8,
    settings: given.settings ?? 40,
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
  // ---- a shape's own repos and origins (ADR 0202 point 10); nothing without a shape
  if (flags) {
    const manifest = join(root, "org-pack/profiles/github/repos.manifest.yaml");
    const ssh = flags.has("ssh-origins");
    const https = flags.has("https-origins");
    // Every origin by the flags: https only, ssh only, one of each in turn, or neither (git://).
    let k = 0;
    const origin = (id: string) =>
      (ssh && https ? k++ % 2 === 0 : https)
        ? `https://git.example.test/forge/${id}.git`
        : ssh
          ? `git@git.example.test:forge/${id}.git`
          : `git://git.example.test/forge/${id}.git`;
    await writeFile(
      manifest,
      (await readFile(manifest, "utf8")).replace(
        /^( {4}url: )https:\/\/git\.example\.test\/forge\/(.+)\.git$/gm,
        (_, lead: string, id: string) => `${lead}${origin(id)}`,
      ),
    );
    if (flags.has("repos-with-no-system"))
      await writeShapeRepo(root, SHAPE_REPOS["repos-with-no-system"], {
        url: origin(SHAPE_REPOS["repos-with-no-system"]),
      });
    if (flags.has("dotted-ids"))
      await writeShapeRepo(root, SHAPE_REPOS["dotted-ids"], {
        system: "forge-instruments-svc",
        url: origin(SHAPE_REPOS["dotted-ids"]),
      });
    if (flags.has("nested-payloads"))
      await writeShapeRepo(root, SHAPE_REPOS["nested-payloads"], {
        system: SHAPE_REPOS["nested-payloads"],
        url: origin(SHAPE_REPOS["nested-payloads"]),
        fields: ["customer.address.line1", "customer.address.city", "items[].sku"],
      });
  }

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
  // A shape with no deploy-token hosts pairs the calls to the outside vendor instead; one whose
  // pairings are only ever with a gateway pairs each with the first gateway's first route.
  const looseHost =
    flags && !flags.has("deploy-token-hosts") ? "api.northwind-pay" : "@forgeTargetUrl";
  const toGateway = !!flags && !flags.has("non-gateway-callee");
  // With a shape, half of a repo's loose calls at most are paired, so some stay loose.
  const pairsPerRepo = flags ? 1 : Infinity;
  for (let r = flags ? 0 : 2; r < services && links < want; r++) {
    const repo = bigRepoId(r);
    if (isLegacy.has(repo)) continue;
    let to = (r + 1) % services;
    while (isLegacy.has(bigRepoId(to))) to = (to + 1) % services;
    const target = toGateway ? bigGatewayId(0) : bigRepoId(to);
    const entry = (toGateway ? bigGatewayFacts(0, options) : bigRepoFacts(to, options).facts).find(
      (f) => f.kind === "entry",
    )! as Fact & {
      method: string;
      path: string;
    };
    const lines: string[] = [];
    for (const f of bigRepoFacts(r, options).facts) {
      if (links >= want || lines.length >= pairsPerRepo) break;
      if (f.kind !== "call" || !(f.host ?? "").startsWith(looseHost)) continue;
      links++;
      lines.push(
        JSON.stringify({
          schemaVersion: 1,
          fact: f.id,
          target: { kind: "call", file: f.cite.file, line: f.cite.line, value: f.cite.value },
          action: "link",
          link: { repo: target, entry: entry.id, method: entry.method, path: entry.path },
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
