import { dirname, join } from "node:path";
import { featuresForScan } from "@maycombhq/features";
import {
  configHash,
  fsRepo,
  fsScanCache,
  scanRepo,
  type Extractor,
  type RepoScan,
  type ScanCache,
} from "@maycombhq/sdk";
import {
  applyCurated,
  loadOrgPack,
  mergeCatalog,
  type CatalogRecord,
  type Dialect,
  type OrgPack,
} from "@maycombhq/core";
import {
  BUILT_IN_EXTRACTORS,
  dialectExtractor,
  loadShippedDialects,
  runDialectTests,
  SHIPPED_DIALECTS_DIR,
} from "@maycombhq/extractors";
import { listIngestors } from "@maycombhq/ingestors";
import { scanInputs, type ScanInputsResult } from "@maycombhq/intake";
import { baseClonePath, checkoutState } from "@maycombhq/workspace";
import { readCatalog } from "./files.js";

export interface ScanOptions {
  /** The metarepo root (holds org-pack/, catalog/, workspace/). */
  root: string;
  /** Org pack folder; default <root>/org-pack. */
  orgPack?: string;
  /** Where a repo's files are; default its base clone under workspace/. */
  repoDir?: (repoId: string) => string;
  /** The commit and cleanliness of a repo; default read with git. */
  repoState?: (repoId: string, dir: string) => Promise<{ commit: string; dirty: boolean }>;
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
  /** Folder of curated decisions applied over the merged catalog; default <root>/catalog/curated. */
  curatedDir?: string;
}

export interface ScanProblem {
  repo?: string;
  source: string;
  message: string;
}

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
  };
  /** What intake read from inputs/ (documents, versions, triage items). */
  inputs?: ScanInputsResult;
  /** Curated decisions applied, and the records they suppressed. */
  curated: { applied: string[]; suppressed: string[] };
}

/** Load and check dialects: a dialect whose own tests fail is not used, and the failure is reported. */
async function usableDialects(
  op: OrgPack,
  orgPackDir: string,
  problems: ScanProblem[],
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
      continue;
    }
    ok.push(d);
  }
  return ok;
}

/**
 * Scan every repo in the org pack's manifests with the built-in extractors and the dialects
 * whose tests pass, then merge into one catalog. Unchanged repos come from the cache.
 */
export async function scanEstate(o: ScanOptions): Promise<EstateScan> {
  const orgPackDir = o.orgPack ?? join(o.root, "org-pack");
  const op = await loadOrgPack(orgPackDir);
  const problems: ScanProblem[] = op.problems.map((p) => ({
    source: `org-pack/${p.file}`,
    message: `${p.path ? `${p.path}: ` : ""}${p.message}`,
  }));
  const dialects = await usableDialects(op, orgPackDir, problems);
  const byName = new Map(dialects.map((d) => [d.name, d]));
  const dialectExtractors = dialects.map((d) => ({ d, x: dialectExtractor(d, byName) }));
  const cache =
    o.cache === null ? undefined : (o.cache ?? fsScanCache(join(o.root, ".index", "scan-cache")));
  const scannedAt = o.scannedAt ?? new Date().toISOString();

  const repos = op.profiles
    .flatMap((p) => (p.repos?.repos ?? []).map((r) => ({ ...r, platform: p.platform })))
    .filter((r) => !r.archived && (!o.repos || o.repos.includes(r.id)));
  const results: RepoScan[] = [];
  let done = 0;
  for (const r of repos) {
    const dir = o.repoDir?.(r.id) ?? baseClonePath(o.root, r.id);
    let state: { commit: string; dirty: boolean };
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
        .filter(({ d }) => r.dialects.includes(d.name) || d.appliesTo.repoTypes.includes(r.type))
        .map(({ x }) => x),
    ];
    const scan = await scanRepo({
      repo: fsRepo(r.id, dir, state.commit),
      extractors,
      dialects: r.dialects,
      scannedAt,
      dirty: state.dirty,
      ...(cache ? { cache } : {}),
      configFor: (x) => {
        const d = dialectExtractors.find((de) => de.x === x)?.d;
        return d ? configHash({ dialect: JSON.stringify(d) }) : undefined;
      },
      repoInfo: {
        ...(r.component ? { component: r.component } : {}),
        ...(r.system ? { system: r.system } : {}),
        repoType: r.type,
      },
    });
    for (const run of scan.runs.filter((x) => x.status === "failed"))
      problems.push({ repo: r.id, source: run.extractor, message: run.error ?? "failed" });
    for (const rej of scan.rejected)
      problems.push({
        repo: r.id,
        source: rej.extractor,
        message: `invalid record: ${rej.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
      });
    results.push(scan);
    o.onProgress?.(++done, repos.length, r.id);
  }

  const mergeInput = (records: CatalogRecord[]) => ({
    records,
    repos: repos.map((r) => ({
      id: r.id,
      type: r.type,
      ...(r.component ? { component: r.component } : {}),
      ...(r.system ? { system: r.system } : {}),
    })),
    systems: op.profiles.flatMap((p) => p.profile?.systems ?? []),
    patterns: op.patterns,
    profilePath: op.profiles[0]
      ? `org-pack/profiles/${op.profiles[0].platform}/profile.yaml`
      : undefined,
  });
  const codeRecords = results.flatMap((s) => s.records);
  let merged = mergeCatalog(mergeInput(codeRecords));
  const curatedDir = o.curatedDir ?? join(o.root, "catalog", "curated");
  const curated = await readCatalog(curatedDir);
  for (const p of curated.problems)
    problems.push({ source: `catalog/curated/${p.file}`, message: p.message });

  // Documents in inputs/ (partner specs, diagrams, payloads) come after the code, so code wins in merge.
  let inputs: ScanInputsResult | undefined;
  if (o.inputsDir !== null) {
    inputs = await scanInputs({
      root: o.root,
      orgPack: op,
      inputsDir: o.inputsDir ?? join(o.root, "inputs"),
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
  const withFeatures = [...merged.records, ...found.features].sort((a, b) =>
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
  return {
    records: merged.records,
    repos: results,
    problems,
    stats: {
      repos: results.length,
      cachedRuns: runs.filter((r) => r.status === "cached").length,
      ranRuns: runs.filter((r) => r.status === "ran").length,
      records: merged.records.length,
      ...merged.stats,
    },
    ...(inputs ? { inputs } : {}),
    curated: { applied: applied.applied, suppressed: applied.suppressed },
  };
}
