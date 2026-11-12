import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { cmpText, recordPath, serializeRecord, type CatalogRecord } from "@maycombhq/core";
import {
  buildCatalog,
  buildUndoDirOf,
  baselineTarget,
  filesUnder,
  generatedBeforeUpgradeDirOf,
  generatedDirOf,
  loadBuildInputs,
  readersSlotRead,
  takeUndoCopy,
  type Build,
} from "./build.js";
import { readCatalog } from "./files.js";
import { estateRepos } from "./merge-input.js";
import { orgPackDirFor } from "./scan.js";
import {
  buildManifestPath,
  legacyJoinsPath,
  readersSlotPath,
  serializeBuildManifest,
  serializeLegacyJoins,
  serializeReadersSlot,
  sha256Of,
  sourcesDirOf,
  SLOT_VERSION,
} from "./slots.js";
import { writeFileAtomic } from "@maycombhq/core";

/**
 * The upgrade to source slots (ADR 0195 point 6): once, when `catalog/sources/` doesn't exist and
 * `catalog/generated/` has records, every record of the catalog is adopted, so nothing is lost:
 * a record whose evidence names one repo goes into that repo's readers slot with `status:
 * legacy`; joined and evidence-less records go into `catalog/sources/legacy/joins.json`. The
 * catalog is copied as it is to `legacy/generated-before-upgrade/`. A dry run first: the plan is
 * made and built in memory, and the step refuses, writing nothing, when the build it would make
 * differs from the catalog by one byte.
 */

const posix = (p: string) => p.split(sep).join("/");

export interface UpgradeSlotsPlan {
  /** Whether the step applies here (no catalog/sources, and catalog/generated has records). */
  pending: boolean;
  /** Each slot it would write: its path, the records it adopts. */
  slots: { path: string; records: number; repo?: string }[];
  /** Repos whose facts file a passing verify records as it is now: `atticus verify <repo> --write` puts them in. */
  verifiable: string[];
  /** Record files the first build would give differently (must be none). */
  differs: string[];
  /** The files the step writes, with their text. */
  writes: { path: string; text: string }[];
  build?: Build;
  records: number;
}

async function readText(p: string): Promise<string | undefined> {
  return readFile(p, "utf8").then(
    (t) => t.replace(/\r\n?/g, "\n"),
    () => undefined,
  );
}

const reposOf = (r: CatalogRecord) =>
  [...new Set(r.evidence.flatMap((e) => (e.repo ? [e.repo] : [])))].sort(cmpText);

export async function planUpgradeToSlots(root: string): Promise<UpgradeSlotsPlan> {
  const none: UpgradeSlotsPlan = {
    pending: false,
    slots: [],
    verifiable: [],
    differs: [],
    writes: [],
    records: 0,
  };
  const sources = sourcesDirOf(root);
  const already = (await readdir(sources).catch(() => [] as string[])).some(
    (n) => n === "build.json" || n === "readers" || n === "facts" || n === "legacy",
  );
  const generated = generatedDirOf(root);
  const old = await readCatalog(generated, { cacheRoot: root });
  if (already || !old.records.length) return none;
  const inputs = await loadBuildInputs(root);
  const listed = new Set(estateRepos(inputs.op).map((r) => r.id));
  const byRepo = new Map<string, CatalogRecord[]>();
  const joins: CatalogRecord[] = [];
  for (const r of old.records) {
    const repos = reposOf(r);
    if (repos.length === 1 && listed.has(repos[0]!)) {
      const xs = byRepo.get(repos[0]!) ?? [];
      xs.push(r);
      byRepo.set(repos[0]!, xs);
    } else joins.push(r);
  }
  const writes: { path: string; text: string }[] = [];
  const slots: UpgradeSlotsPlan["slots"] = [];
  const shaOf = new Map<string, string>();
  for (const [repo, records] of [...byRepo].sort((a, b) => cmpText(a[0], b[0]))) {
    // The commit the last scan read the repo at, when its evidence agrees on one.
    const commits = new Set(
      records.flatMap((r) =>
        r.evidence.flatMap((e) => {
          const c = (e as { commit?: string }).commit;
          return e.repo === repo && c ? [c] : [];
        }),
      ),
    );
    const text = serializeReadersSlot({
      slotVersion: SLOT_VERSION,
      kind: "readers",
      repo,
      commit: commits.size === 1 ? [...commits][0]! : "unknown",
      status: "legacy",
      extractors: [],
      settings: null,
      records,
    });
    const path = readersSlotPath(root, repo);
    writes.push({ path, text });
    shaOf.set(posix(relative(root, path)), sha256Of(text));
    slots.push({ path: posix(relative(root, path)), records: records.length, repo });
  }
  const inputsAt: Record<string, string> = Object.fromEntries([...shaOf, ...inputs.inputHashes]);
  if (joins.length) {
    const text = serializeLegacyJoins({
      slotVersion: SLOT_VERSION,
      kind: "legacy-joins",
      status: "legacy",
      records: joins,
      inputs: inputsAt,
    });
    writes.push({ path: legacyJoinsPath(root), text });
    slots.push({ path: posix(relative(root, legacyJoinsPath(root))), records: joins.length });
  }
  // The copy of the catalog as it is, never read by the build.
  const copyDir = generatedBeforeUpgradeDirOf(root);
  for (const f of await filesUnder(generated)) {
    const text = await readText(f);
    if (text !== undefined)
      writes.push({ path: join(copyDir, ...posix(relative(generated, f)).split("/")), text });
  }
  // The dry-run build from these slots: it must give the catalog as it is, byte for byte.
  const readers = new Map(inputs.slots.readers);
  for (const w of writes)
    if (w.path.startsWith(join(sources, "readers")))
      readers.set(
        posix(relative(join(sources, "readers"), w.path)).replace(/\.json$/, ""),
        readersSlotRead(
          w.text,
          posix(relative(join(sources, "readers"), w.path)).replace(/\.json$/, ""),
        ),
      );
  const legacy = writes.find((w) => w.path === legacyJoinsPath(root));
  const { parseLegacyJoins } = await import("./slots.js");
  const lj = legacy ? parseLegacyJoins(legacy.text) : undefined;
  const build = await buildCatalog({
    ...inputs,
    slots: {
      readers,
      facts: inputs.slots.facts,
      ...(lj?.ok ? { legacy: { slot: lj.slot, sha: sha256Of(legacy!.text) } } : {}),
    },
  });
  const was = new Map(old.records.map((r) => [recordPath(r), serializeRecord(r)]));
  const onDisk = new Map<string, string>();
  for (const f of await filesUnder(generated)) {
    const t = await readText(f);
    if (t !== undefined && /\.ya?ml$/.test(f)) onDisk.set(posix(relative(generated, f)), t);
  }
  const differs = [...new Set([...onDisk.keys(), ...build.files.keys()])]
    .filter((p) => onDisk.get(p) !== build.files.get(p))
    .sort(cmpText);
  writes.push({ path: buildManifestPath(root), text: serializeBuildManifest(build.manifest) });
  // Repos whose verify report records a passing verify of the facts as they are now.
  const verifiable: string[] = [];
  const { factsDirOf } = await import("@maycombhq/core");
  for (const repo of listed) {
    const facts = await readText(join(factsDirOf(root), `${repo}.jsonl`));
    const report = await readText(join(factsDirOf(root), `${repo}.verify.yaml`));
    if (facts && report && /rejected:\s*(0|\[\])/.test(report)) verifiable.push(repo);
  }
  void was;
  return {
    pending: true,
    slots,
    verifiable: verifiable.sort(cmpText),
    differs,
    writes,
    build,
    records: old.records.length,
  };
}

/** Apply a plan whose dry-run build gives the catalog as it is: its undo copy first, then each file. */
export async function applyUpgradeToSlots(
  root: string,
  plan: UpgradeSlotsPlan,
): Promise<number | undefined> {
  if (!plan.pending || plan.differs.length)
    throw new Error("applyUpgradeToSlots: nothing to apply");
  const pack = await orgPackDirFor(root);
  const undoDir = buildUndoDirOf(root, pack.adopted ? join(root, ".atticus") : root);
  const undo = await takeUndoCopy(root, undoDir, "atticus upgrade --yes", plan.writes, {
    nextManifest: plan.writes.find((w) => w.path === baselineTarget(root).manifest)?.text ?? "",
  });
  for (const w of plan.writes) await writeFileAtomic(w.path, w.text);
  return undo;
}
