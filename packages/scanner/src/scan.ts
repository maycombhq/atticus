import { stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { featuresForScan } from "@maycombhq/features";
import { glossaryForScan } from "@maycombhq/glossary";
import {
  configHash,
  createParseCache,
  DEFAULT_IGNORES,
  fsRepo,
  fsScanCache,
  scanRepo,
  withParseCache,
  type Extractor,
  type RepoScan,
  type ScanCache,
} from "@maycombhq/sdk";
import {
  applyCurated,
  joinFacts,
  loadOrgPack,
  mergeCatalog,
  throwIfCancelled,
  type CatalogRecord,
  type Dialect,
  type Fact,
  type FrameworkModel,
  type OrgPack,
} from "@maycombhq/core";
import {
  BUILT_IN_EXTRACTORS,
  detectModules,
  dialectExtractor,
  loadShippedDialects,
  runDialectTests,
  runFrameworkTests,
  applyPipelineModels,
  MODEL_READERS,
  modelCovers,
  repoImports,
  SHIPPED_DIALECTS_DIR,
  unmodelledFrameworks,
  type RepoImports,
  type UnmodelledFramework,
} from "@maycombhq/extractors";
import { listIngestors } from "@maycombhq/ingestors";
import { scanInputs, type ScanInputsResult } from "@maycombhq/intake";
import { baseClonePath, checkoutState, type GitRunner } from "@maycombhq/workspace";
import { resolveFederatedLooseEnds } from "./federate-loose.js";
import { readCatalog } from "./files.js";
import { curatedDirOf, estateMergeInput, estateRepos, productionRepos } from "./merge-input.js";
import { factsForScan } from "./facts-scan.js";
import { applyFactJoins, joinReposOf, outsideSystems } from "./facts-catalog.js";
import {
  applyClients,
  applyPrefixes,
  checkScanSettings,
  NO_SETTINGS,
  withExcludes,
} from "./scan-settings.js";
import { pluginApplies, usablePlugins, withPluginScan } from "./plugins.js";

export interface ScanOptions {
  /** The metarepo root (holds org-pack/, catalog/, workspace/). */
  root: string;
  /** Org pack folder; default <root>/org-pack. */
  orgPack?: string;
  /** Where a repo's files are; default its base clone under workspace/. */
  repoDir?: (repoId: string) => string;
  /** The commit and cleanliness of a repo; default read with git. */
  repoState?: (repoId: string, dir: string) => Promise<{ commit: string; dirty: boolean }>;
  /** The git runner a repo's facts of an earlier commit are compared with (default: git on PATH). */
  git?: GitRunner;
  /** Only these repos (others are left out of the catalog). */
  repos?: string[];
  /** Scan cache; default .index/scan-cache under root. Pass null to disable. */
  cache?: ScanCache | null;
  /** One timestamp for the run. */
  scannedAt?: string;
  /** Extra extractors (plugins). */
  extractors?: Extractor[];
  onProgress?: (done: number, total: number, repo: string) => void;
  /** Where inputs/ is (documents, partner specs, diagrams); default <root>/inputs. Pass null to skip intake. */
  inputsDir?: string | null;
  /** Folder of curated decisions applied over the merged catalog; default <catalog>/curated (sources.yaml layout). */
  curatedDir?: string;
  /**
   * Other Atticus metarepos federated in `link` mode: their catalog records join this catalog
   * with their origin kept (a `federated:<id>` flag and an export evidence entry), never
   * replacing a record this scan found (local code wins). Default: sources.yaml `absorbed`
   * entries with format atticus and mode link whose url is a local folder, or whose copy
   * absorb keeps under the state folder's `absorbed/<id>/`.
   */
  federated?: { id: string; dir: string }[];
}

/** What each federated metarepo contributed. */
export interface FederatedContribution {
  id: string;
  added: number;
  /** Records the federated catalog also has, kept from this scan instead ("kind/id"). */
  shadowed: string[];
  /** Its loose ends placed against our records (as interfaces), when there are any. */
  resolved?: number;
}

export interface ScanProblem {
  repo?: string;
  source: string;
  message: string;
}

export interface RepoCoverage {
  repo: string;
  /** Interfaces from this repo's components. */
  joined: number;
  /** Loose ends this repo's components still own: calls, listeners, endpoints not yet known. */
  open: number;
  /** Files that use an HTTP or messaging client but gave nothing. */
  unreadFiles: number;
  /** Structured files (YAML, JSON, XML, Terraform...) no record cites: what a dialect could read. */
  unreadConfig: string[];
  /**
   * Nothing was read from the repo beyond its component, though it has structured files no
   * reader knows: a repo to onboard (atticus onboard, ADR 0059).
   */
  needsOnboarding: boolean;
  /**
   * Dialects the repo's manifest entry names that need re-drafting (ADR 0059): their tests fail,
   * so the scan left them out, or they read nothing in this repo. `atticus onboard` re-drafts.
   */
  redraft: { dialect: string; why: "tests-fail" | "reads-nothing" }[];
  /**
   * Framework models that read nothing in this repo though it imports their packages (ADR
   * 0066): the framework changed under the model. `atticus onboard framework` re-drafts.
   */
  redraftFrameworks: { framework: string; why: "reads-nothing" }[];
}

/** Structured files a dialect could read; build and tool config is left out. */
const STRUCTURED = /\.(ya?ml|json|xml|tf|tfvars|properties|toml|conf|hcl)$/i;
const TOOLING =
  /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|tsconfig[^/]*\.json|\.eslintrc[^/]*|\.prettierrc[^/]*|renovate\.json|\.vscode\/.*|\.idea\/.*|pom\.xml|catalog-info\.yaml|mkdocs\.yml|codecov\.yml)$/i;

export interface EstateScan {
  records: CatalogRecord[];
  repos: RepoScan[];
  problems: ScanProblem[];
  stats: {
    repos: number;
    cachedRuns: number;
    ranRuns: number;
    records: number;
    interfaces: number;
    verified: number;
    unresolved: number;
    /** Distinct warnings (repo, path, message) across RepoScan.warnings: worth a look, not a failure. */
    warnings: number;
  };
  /** What intake read from inputs/ (documents, versions, triage items). */
  inputs?: ScanInputsResult;
  /** Things worth knowing that don't make the scan fail (for example a wiki folder the glossary couldn't read). */
  notes: string[];
  /** Curated decisions applied, and the records they suppressed. */
  curated: { applied: string[]; suppressed: string[] };
  /**
   * Per repo, how much of what the scan found it could join: interfaces from the repo's
   * components, loose ends they still own, and files that use a client library but gave
   * nothing (warnings). Low numbers are where dialects or hosts are missing.
   */
  coverage: RepoCoverage[];
  /**
   * House frameworks several repos import that no framework model covers (ADR 0066): what to
   * onboard with `atticus onboard framework`.
   */
  unmodelled: UnmodelledFramework[];
  /** Federated metarepos and what they contributed, when there are any. */
  federated?: FederatedContribution[];
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * A metarepo's org pack: `org-pack/` at its root, or `.atticus/org-pack/` in a repo adopted in
 * place (the same rule as @maycombhq/adopt's resolveMetarepo).
 */
export async function orgPackDirFor(root: string): Promise<{ dir: string; adopted: boolean }> {
  if (!(await isDir(join(root, "org-pack"))) && (await isDir(join(root, ".atticus", "org-pack"))))
    return { dir: join(root, ".atticus", "org-pack"), adopted: true };
  return { dir: join(root, "org-pack"), adopted: false };
}

/** A manifest url that is `.` or `./<path>` names a repo in place under the root. */
function inPlace(root: string, url: string): string | undefined {
  if (url === "." || url === "./") return root;
  if (url.startsWith("./") && !url.split("/").includes("..")) return join(root, url.slice(2));
  return undefined;
}

/**
 * Federated catalogs: records added with their origin; local records win. Their folders are
 * read-only, so the parses of their record files are kept in **our** root (`cacheRoot`, ADR 0119
 * addendum) — never beside their files.
 */
async function federate(
  local: CatalogRecord[],
  sources: { id: string; dir: string }[],
  problems: ScanProblem[],
  root: string,
): Promise<{ records: CatalogRecord[]; contributions: FederatedContribution[] }> {
  const have = new Set(local.map((r) => `${r.kind}/${r.id}`));
  const records: CatalogRecord[] = [];
  const contributions: FederatedContribution[] = [];
  for (const s of sources) {
    const theirs = await loadOrgPack((await orgPackDirFor(s.dir)).dir);
    const catalogRel = `${theirs.sources.layout.catalog}/generated`;
    const cat = await readCatalog(join(s.dir, ...catalogRel.split("/")), { cacheRoot: root });
    for (const p of cat.problems)
      problems.push({ source: `federated ${s.id}`, message: `${p.file}: ${p.message}` });
    const c: FederatedContribution = { id: s.id, added: 0, shadowed: [] };
    for (const r of cat.records) {
      const key = `${r.kind}/${r.id}`;
      if (have.has(key)) {
        c.shadowed.push(key);
        continue;
      }
      have.add(key);
      records.push({
        ...r,
        flags: [...new Set([...(r.flags ?? []), `federated:${s.id}`])],
        evidence: [
          ...r.evidence,
          {
            source: "export",
            repo: s.id,
            path: `${catalogRel}/${r.kind.toLowerCase()}/${r.id}.yaml`,
          },
        ],
      } as CatalogRecord);
      c.added++;
    }
    contributions.push(c);
  }
  return { records, contributions };
}

const REMOTE_URL = /^[a-z][a-z0-9+.-]*:\/\//i;
const SCP_URL = /^[^/]+@[^:/]+:/;

/** Default federation sources from sources.yaml: atticus format, link mode, on this machine. */
async function federationSources(
  root: string,
  stateDir: string,
  op: OrgPack,
): Promise<{ id: string; dir: string }[]> {
  const out: { id: string; dir: string }[] = [];
  for (const a of op.sources.absorbed) {
    if (a.format !== "atticus" || a.mode !== "link") continue;
    const local = a.url.startsWith("file://")
      ? fileURLToPath(a.url)
      : REMOTE_URL.test(a.url) || SCP_URL.test(a.url)
        ? undefined
        : isAbsolute(a.url)
          ? a.url
          : resolve(root, a.url);
    const copy = join(stateDir, "absorbed", a.id);
    // A bare repository (objects/ at its top) can't be read as files: absorb keeps a copy.
    if (local && (await isDir(local)) && !(await isDir(join(local, "objects"))))
      out.push({ id: a.id, dir: local });
    else if (await isDir(copy)) out.push({ id: a.id, dir: copy });
  }
  return out;
}

/** Load and check dialects: a dialect whose own tests fail is not used, and the failure is reported. */
async function usableDialects(
  op: OrgPack,
  orgPackDir: string,
  problems: ScanProblem[],
  broken: Set<string> = new Set(),
): Promise<Dialect[]> {
  // Dialects shipped with Atticus are defaults; an org-pack dialect with the same name replaces one.
  const own = new Set(op.dialects.map((d) => d.name));
  const shipped = (await loadShippedDialects().catch(() => [] as Dialect[])).filter(
    (d) => !own.has(d.name),
  );
  const all = [
    ...shipped.map((d) => ({ d, dir: SHIPPED_DIALECTS_DIR })),
    ...op.dialects.map((d) => ({ d, dir: join(orgPackDir, "dialects") })),
  ];
  const byName = new Map(all.map(({ d }) => [d.name, d]));
  const ok: Dialect[] = [];
  for (const { d, dir } of all) {
    const failures = await runDialectTests(d, dir, byName).catch((e: Error) => [
      { test: "(load)", message: e.message },
    ]);
    if (failures.length > 0) {
      for (const f of failures)
        problems.push({ source: `dialect ${d.name}`, message: `test "${f.test}": ${f.message}` });
      broken.add(d.name);
      continue;
    }
    ok.push(d);
  }
  return ok;
}

/**
 * The org pack's framework models whose own tests pass (ADR 0055). A model that fails a test,
 * or has an entry no test exercises, is left out with a problem, so a wrong draft can't
 * quietly shape the catalog. A model with no tests loads as before.
 */
async function usableFrameworks(op: OrgPack, problems: ScanProblem[]): Promise<FrameworkModel[]> {
  const ok: FrameworkModel[] = [];
  for (const m of op.frameworks) {
    const failures = await runFrameworkTests(m).catch((e: Error) => [
      { test: "(load)", message: e.message },
    ]);
    if (failures.length > 0) {
      for (const f of failures)
        problems.push({
          source: `framework ${m.name}`,
          message: `test "${f.test}": ${f.message}; the model is not used`,
        });
      continue;
    }
    ok.push(m);
  }
  return ok;
}

interface ModelReading {
  handle: ReturnType<typeof fsRepo>;
  repoInfo: NonNullable<Parameters<typeof scanRepo>[0]["repoInfo"]>;
  dialects: string[];
  dirty: boolean;
  imports: RepoImports;
}

/**
 * The models that read nothing in a repo that imports their packages (ADR 0066): the repo read
 * through the extractors that use models, with every usable model and without this one, gives
 * the same records. The same options as the scan, so the reading with every model comes from
 * the cache when the scan's did.
 */
async function modelsReadingNothing(
  x: ModelReading,
  models: FrameworkModel[],
  cache: ScanCache | undefined,
  scannedAt: string,
): Promise<string[]> {
  const used = models.filter((m) =>
    [...x.imports.modules.keys()].some((mod) => modelCovers(m, mod)),
  );
  if (used.length === 0) return [];
  const read = async (with_: FrameworkModel[]) => {
    const s = await scanRepo({
      repo: x.handle,
      extractors: [...MODEL_READERS],
      dialects: x.dialects,
      scannedAt,
      dirty: x.dirty,
      ...(cache ? { cache } : {}),
      frameworks: with_,
      repoInfo: x.repoInfo,
    });
    return applyPipelineModels(s.records, with_)
      .map((r) => JSON.stringify({ ...r, evidence: undefined }))
      .sort()
      .join("\n");
  };
  const all = await read(models);
  const out: string[] = [];
  for (const m of used) if ((await read(models.filter((o) => o !== m))) === all) out.push(m.name);
  return out;
}

/**
 * Scan every repo in the org pack's manifests with the built-in extractors and the dialects
 * whose tests pass, then merge into one catalog. Unchanged repos come from the cache.
 */
export async function scanEstate(o: ScanOptions): Promise<EstateScan> {
  const pack = o.orgPack ? undefined : await orgPackDirFor(o.root);
  const orgPackDir = o.orgPack ?? pack!.dir;
  // A repo adopted in place keeps Atticus's local state in .atticus/.
  const stateDir = pack?.adopted ? join(o.root, ".atticus") : o.root;
  const op = await loadOrgPack(orgPackDir);
  const problems: ScanProblem[] = op.problems.map((p) => ({
    source: `org-pack/${p.file}`,
    message: `${p.path ? `${p.path}: ` : ""}${p.message}`,
  }));
  const brokenDialects = new Set<string>();
  const dialects = await usableDialects(op, orgPackDir, problems, brokenDialects);
  const frameworks = await usableFrameworks(op, problems);
  // Scanner plugins (ADR 0080): pinned, re-tested, then run sandboxed after the built-ins.
  const pluginSet = await usablePlugins(op);
  problems.push(...pluginSet.problems);
  const byName = new Map(dialects.map((d) => [d.name, d]));
  const dialectExtractors = dialects.map((d) => ({ d, x: dialectExtractor(d, byName) }));
  const cache =
    o.cache === null ? undefined : (o.cache ?? fsScanCache(join(stateDir, ".index", "scan-cache")));
  const scannedAt = o.scannedAt ?? new Date().toISOString();

  // A prototype is read and compared with the estate, never scanned into the catalog (ADR 0133).
  const repos = productionRepos(op, o.repos);
  const results: RepoScan[] = [];
  const factNotes: string[] = estateRepos(op, o.repos)
    .filter((r) => !repos.includes(r))
    .map(
      (r) =>
        `${r.id}: a prototype, so not scanned into the catalog; compare it with the estate: atticus change attach <change> --prototype ${r.id}.`,
    );
  /** The repos read from their facts, for the estate join (ADR 0124, C-join). */
  const factRepos: { repo: string; facts: Fact[]; targets: Record<string, string> }[] = [];
  /** Each repo's structured files, to tell which no record cites. */
  const structuredOf = new Map<string, string[]>();
  /** Each repo's modules with their own component (ADR 0057): the manifest's, else found. */
  const modulesOf = new Map<string, { path: string; component: string; hosts: string[] }[]>();
  /** Each repo as scanned, with its imports: for the framework signals (ADR 0066). */
  const readers = new Map<string, ModelReading>();
  let done = 0;
  for (const r of repos) {
    // A scan the app cancelled stops between repos, before anything is written (ADR 0119).
    throwIfCancelled();
    const dir = o.repoDir?.(r.id) ?? inPlace(o.root, r.url) ?? baseClonePath(o.root, r.id);
    let state: { commit: string; dirty: boolean };
    // No folder: say it isn't cloned, not what git said about a folder that isn't there.
    if (!o.repoState && !(await stat(dir).catch(() => undefined))) {
      problems.push({
        repo: r.id,
        source: "workspace",
        message: "isn't cloned here yet; run atticus workspace sync",
      });
      continue;
    }
    try {
      state = o.repoState ? await o.repoState(r.id, dir) : await checkoutState(dir);
    } catch (e) {
      problems.push({
        repo: r.id,
        source: "workspace",
        message: `can't read the base clone (${(e as Error).message}); run atticus workspace sync`,
      });
      continue;
    }
    const extractors: Extractor[] = [
      ...BUILT_IN_EXTRACTORS,
      ...(o.extractors ?? []),
      ...dialectExtractors
        .filter(
          ({ d }) =>
            r.dialects.includes(d.name) ||
            d.appliesTo.repoTypes.includes(r.type) ||
            // "*": any repo where the marker matches (ADR 0062).
            d.appliesTo.repoTypes.includes("*"),
        )
        .map(({ x }) => x),
    ];
    // One parse cache for the repo (ADR 0067): every extractor and dialect shares each file's
    // parse, and everything it holds (syntax trees too) is freed when the repo is done.
    const parsed = createParseCache();
    // .atticus/ is Atticus's own folder (an adopted repo scans itself): never read as code.
    const files = fsRepo(r.id, dir, state.commit, { ignore: [...DEFAULT_IGNORES, ".atticus"] });
    // Scan settings (ADR 0075): every entry checked against the code before it applies.
    const settingsFor = op.scanSettings.find((s) => s.repo === r.id);
    const settings = settingsFor ? await checkScanSettings(settingsFor, files) : NO_SETTINGS;
    for (const message of settings.problems)
      problems.push({ repo: r.id, source: `org-pack/scan/${r.id}.yaml`, message });
    const handle = withParseCache(withExcludes(files, settings.exclude), parsed);
    let scan: RepoScan;
    try {
      const modules = r.modules.length
        ? r.modules
        : (await detectModules(handle)).map((m) => ({ ...m, hosts: [] as string[] }));
      modulesOf.set(r.id, modules);
      const structured: string[] = [];
      for await (const f of handle.listFiles(["**/*"]))
        if (STRUCTURED.test(f) && !TOOLING.test(f)) structured.push(f);
      structuredOf.set(r.id, structured.sort());
      const repoInfo = {
        ...(modules.length
          ? { modules: modules.map(({ path, component }) => ({ path, component })) }
          : {}),
        ...(r.component ? { component: r.component } : {}),
        ...(r.system ? { system: r.system } : {}),
        repoType: r.type,
      };
      scan = await scanRepo({
        repo: handle,
        extractors,
        dialects: r.dialects,
        scannedAt,
        dirty: state.dirty,
        ...(cache ? { cache } : {}),
        configFor: (x) => {
          const d = dialectExtractors.find((de) => de.x === x)?.d;
          return d ? configHash({ dialect: JSON.stringify(d) }) : undefined;
        },
        frameworks,
        repoInfo,
      });
      // Plugins after the built-ins, each in its own sandbox: one that fails, times out, runs
      // out of memory or tries something forbidden is a failed run, reported below.
      const here = pluginSet.plugins.filter((p) => pluginApplies(p.manifest, r));
      if (here.length > 0)
        scan = withPluginScan(
          scan,
          await scanRepo({
            repo: handle,
            extractors: here.map((p) => p.extractor),
            dialects: r.dialects,
            scannedAt,
            dirty: state.dirty,
            ...(cache ? { cache } : {}),
            configFor: (x) => here.find((p) => p.extractor === x)?.config,
            frameworks,
            repoInfo,
          }),
        );
      // What it imports, for naming house frameworks with no model (ADR 0066). Read while the
      // parse cache is live; later readings of this handle parse afresh.
      readers.set(r.id, {
        handle,
        repoInfo,
        dialects: r.dialects,
        dirty: state.dirty,
        imports: await repoImports(handle),
      });
    } finally {
      parsed.dispose();
    }
    for (const run of scan.runs.filter((x) => x.status === "failed"))
      problems.push({ repo: r.id, source: run.extractor, message: run.error ?? "failed" });
    for (const rej of scan.rejected)
      problems.push({
        repo: r.id,
        source: rej.extractor,
        message: `invalid record: ${rej.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
      });
    const readerRecords = applyClients(
      applyPrefixes(scan.records, settings.prefixes),
      settings.clients,
    );
    // ADR 0124 §3: a repo the assistant has read takes its verified facts over its readers'
    // records; the readers stay as a cross-check, said as a note. Facts of an earlier commit are
    // carried where the files they cite are unchanged (addendum A-incremental); the readers stand
    // in only when the two commits can't be compared.
    const fromFacts = await factsForScan(o.root, op, r.id, state.commit, readerRecords, {
      dir,
      ...(o.git ? { git: o.git } : {}),
    });
    if (fromFacts.note) factNotes.push(fromFacts.note);
    if (fromFacts.facts)
      factRepos.push({ repo: r.id, facts: fromFacts.facts, targets: fromFacts.targets ?? {} });
    results.push({ ...scan, records: fromFacts.records ?? readerRecords });
    o.onProgress?.(++done, repos.length, r.id);
  }

  const mergeInput = (records: CatalogRecord[]) =>
    estateMergeInput(op, repos, records, (id) => modulesOf.get(id) ?? []);
  // What the org's pipeline templates and library steps do, on the pipelines using them (ADR 0062).
  let codeRecords = applyPipelineModels(
    results.flatMap((s) => s.records),
    frameworks,
  );
  // The repos read from their facts join each other's entries, as verify --write joins them.
  if (factRepos.length) {
    const joinRepos = joinReposOf(op, factRepos);
    const join = joinFacts({
      repos: joinRepos,
      targets: Object.fromEntries(factRepos.map((x) => [x.repo, x.targets])),
      outside: outsideSystems(op),
    });
    codeRecords = applyFactJoins(codeRecords, join, joinRepos);
  }
  let merged = mergeCatalog(mergeInput(codeRecords));
  const curatedDir = o.curatedDir ?? curatedDirOf(o.root, op);
  const curated = await readCatalog(curatedDir, { cacheRoot: o.root });
  for (const p of curated.problems)
    problems.push({ source: `catalog/curated/${p.file}`, message: p.message });

  // Documents in inputs/ (partner specs, diagrams, payloads) come after the code, so code wins in merge.
  let inputs: ScanInputsResult | undefined;
  if (o.inputsDir !== null) {
    inputs = await scanInputs({
      root: o.root,
      orgPack: op,
      inputsDir: o.inputsDir ?? join(stateDir, "inputs"),
      records: [...merged.records, ...curated.records],
      ingestors: listIngestors(),
      scannedAt,
    });
    for (const p of inputs.problems)
      problems.push({ source: "intake", message: `${p.path ? `${p.path}: ` : ""}${p.message}` });
    if (inputs.records.length > 0)
      merged = mergeCatalog(mergeInput([...codeRecords, ...inputs.records]));
  }
  // Features found in code (ADR 0031) join the catalog before curated decisions, so people's
  // names, tags, merges and splits apply over detection on every scan.
  const found = await featuresForScan({
    records: merged.records,
    decisions: curated.records,
    proposalsDir: join(dirname(curatedDir), "proposals"),
  });
  for (const p of found.problems)
    problems.push({ source: "features", message: `${p.decision}: ${p.message}` });
  // Federated metarepos (link mode) add their records last, before curated decisions: local
  // records win, and their records never become features of ours.
  const fedSources = o.federated ?? (await federationSources(o.root, stateDir, op));
  let federated: FederatedContribution[] | undefined;
  let fedRecords: CatalogRecord[] = [];
  if (fedSources.length) {
    const fed = await federate(
      [...merged.records, ...found.features],
      fedSources,
      problems,
      o.root,
    );
    // Their loose ends go through merge against our raw facts; local code still wins.
    const placed = resolveFederatedLooseEnds({
      local: merged.records,
      raw: [...codeRecords, ...(inputs?.records ?? [])],
      federated: fed.records,
      merge: (records) => mergeCatalog(mergeInput(records)),
    });
    fedRecords = placed.federated;
    federated = fed.contributions.map((c) =>
      placed.resolved.get(c.id) ? { ...c, resolved: placed.resolved.get(c.id)! } : c,
    );
  }
  // The business glossary: terms from wikis and code, column links, AI proposals; before curated decisions.
  const glossary = await glossaryForScan({
    root: o.root,
    orgPack: op,
    records: [...merged.records, ...found.features],
    decisions: curated.records,
    proposalsDir: join(dirname(curatedDir), "proposals"),
    orgPackDir,
  });
  // The glossary is an enrichment: what it can't read (a missing wiki folder) is a note, not a scan failure.
  const notes = [...factNotes, ...merged.notes, ...glossary.problems.map((p) => `glossary: ${p}`)];
  const withFeatures = [...glossary.records, ...fedRecords].sort((a, b) =>
    a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind.localeCompare(b.kind),
  );
  const applied = applyCurated(withFeatures, curated.records);
  for (const p of applied.problems)
    problems.push({ source: "curated", message: JSON.stringify(p) });
  merged = { ...merged, records: applied.records };
  for (const i of merged.invalid)
    problems.push({
      source: "merge",
      message: `invalid record: ${i.issues.map((x) => `${x.path}: ${x.message}`).join("; ")}`,
    });
  const runs = results.flatMap((s) => s.runs);
  // House frameworks with no model, and models that read nothing where they're imported (ADR 0066).
  const unmodelled = unmodelledFrameworks(
    [...readers.values()].map((x) => x.imports),
    op.frameworks,
  );
  const idleModels = new Map<string, string[]>();
  for (const [id, x] of readers)
    idleModels.set(id, await modelsReadingNothing(x, frameworks, cache, scannedAt));
  const coverage: RepoCoverage[] = repos
    .filter((r) => results.some((s) => s.repo === r.id))
    .map((r) => {
      const own = new Set([
        r.component ?? r.id,
        ...merged.records
          .filter((x) => x.kind === "Component" && (x as { repo?: string }).repo === r.id)
          .map((x) => x.id),
      ]);
      const scan = results.find((s) => s.repo === r.id)!;
      const cited = new Set(
        scan.records.flatMap((x) =>
          (x as unknown as { evidence: { path?: string }[] }).evidence.map((e) => e.path ?? ""),
        ),
      );
      const unreadConfig = (structuredOf.get(r.id) ?? []).filter((f) => !cited.has(f));
      const readSomething = scan.records.some((x) => x.kind !== "Component");
      return {
        repo: r.id,
        joined: merged.records.filter(
          (x) => x.kind === "Interface" && own.has(String((x as { from?: string }).from)),
        ).length,
        open: merged.records.filter(
          (x) => x.kind === "Unresolved" && own.has(String((x as { owner?: string }).owner)),
        ).length,
        unreadFiles: new Set(
          scan.warnings
            .filter((w) => /but no call to it was read here/.test(w.message))
            .map((w) => w.path),
        ).size,
        unreadConfig,
        needsOnboarding: !readSomething && unreadConfig.length > 0,
        redraft: r.dialects.flatMap((name): RepoCoverage["redraft"] => {
          if (brokenDialects.has(name)) return [{ dialect: name, why: "tests-fail" }];
          const run = scan.runs.find((x) => x.extractor === `dialect-${name}`);
          return run && run.status !== "failed" && run.records === 0
            ? [{ dialect: name, why: "reads-nothing" }]
            : [];
        }),
        redraftFrameworks: (idleModels.get(r.id) ?? []).map((framework) => ({
          framework,
          why: "reads-nothing" as const,
        })),
      };
    });
  return {
    coverage,
    unmodelled,
    records: merged.records,
    repos: results,
    problems,
    stats: {
      repos: results.length,
      cachedRuns: runs.filter((r) => r.status === "cached").length,
      ranRuns: runs.filter((r) => r.status === "ran").length,
      records: merged.records.length,
      ...merged.stats,
      // A file several extractors left out is one warning.
      warnings: new Set(
        results.flatMap((s) => s.warnings.map((w) => JSON.stringify([s.repo, w.path, w.message]))),
      ).size,
    },
    ...(inputs ? { inputs } : {}),
    curated: { applied: applied.applied, suppressed: applied.suppressed },
    notes,
    ...(federated ? { federated } : {}),
  };
}
