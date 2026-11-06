import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import {
  catalogDirOf,
  checkContracts,
  factsDirOf,
  factsRelOf,
  inputsDirOf,
  joinConventions,
  joinVendorOperations,
  newFindings,
  orgPackDirOf,
  questionsDirOf,
  SpecsFile,
  writeFileAtomic,
  type ContractCheckResult,
  type ContractMismatch,
  type ContractSpecT,
  type Fact,
  type FactsJoinResult,
  type OrgPack,
  type JoinVendor,
  type OutsideSpecs,
  type SpecsFileT,
} from "@maycombhq/core";
import {
  openApiContractSpecs,
  readContractSpecs,
  readRepoSpecs,
  readVendorSpec,
  type SpecTree,
} from "@maycombhq/intake";
import {
  componentRenames,
  estateFacts,
  estateJoinOf,
  hostAliases,
  joinReposOf,
  outsideProfileSystems,
} from "@maycombhq/scanner";
import { sameCommit } from "@maycombhq/verify";
import { createGit, type GitRunner } from "@maycombhq/workspace";
import { intakeContext } from "./intake-commands.js";
import { headCommitOf } from "./shared-commands.js";
import { VERSION } from "./version.js";
import { denyHashesAt } from "./link-evidence-files.js";

/**
 * The files the contract check reads (plan item F7, ADR 0164): each repo's specs, read in its
 * checkout at the facts' commit by `verify --write` and kept beside its facts
 * (`<repo>.specs.yaml`), and the specs of outside systems taken in through intake (inputs/), the
 * newest of each and the one it replaced. Nothing is fetched: a repo's specs are read with the
 * clone's local git (`ls-tree` and `cat-file` of the facts' commit), and the check runs no git.
 */

/** The intake classifications a contract spec comes in. */
const SPEC_CLASSES = new Set(["openapi", "swagger", "asyncapi", "protobuf", "avro"]);

/**
 * The commit a repo's facts were read at (review item 13): the checkout's own commit when the
 * facts have it (a write carries every fact to it), else the one most facts are of, a tie going
 * to the newest as the clone's git dates them.
 */
export async function specsCommitOf(
  facts: readonly Fact[],
  dir: string,
  git: GitRunner = createGit(),
): Promise<string | undefined> {
  const counts = new Map<string, number>();
  for (const f of facts) counts.set(f.commit, (counts.get(f.commit) ?? 0) + 1);
  if (!counts.size) return undefined;
  const head = await headCommitOf(dir);
  const atHead = head ? [...counts.keys()].find((c) => sameCommit(c, head)) : undefined;
  if (atHead) return atHead;
  const most = Math.max(...counts.values());
  const top = [...counts]
    .filter(([, n]) => n === most)
    .map(([c]) => c)
    .sort();
  if (top.length === 1) return top[0];
  const newest = await git(["rev-list", "--no-walk", ...top], dir).then(
    (r) => r.stdout.split("\n")[0]?.trim(),
    () => undefined,
  );
  return top.find((c) => !!newest && sameCommit(c, newest)) ?? top[0];
}

/** The files of one commit of a clone, from its local git: blobs only (no link, no submodule). */
async function commitTree(
  dir: string,
  commit: string,
  git: GitRunner,
): Promise<SpecTree | undefined> {
  const listed = await git(["ls-tree", "-r", "-l", "-z", "--full-tree", commit], dir).then(
    (r) => r.stdout,
    () => undefined,
  );
  if (listed === undefined) return undefined;
  const files = listed
    .split("\0")
    .filter(Boolean)
    .flatMap((line) => {
      const tab = line.indexOf("\t");
      const [mode, type, , size] = line.slice(0, tab).trim().split(/\s+/);
      if (tab < 0 || type !== "blob" || mode === "120000") return [];
      return [{ path: line.slice(tab + 1), size: Number(size) || 0 }];
    });
  return {
    files: async () => files,
    read: (p) =>
      git(["cat-file", "blob", `${commit}:${p}`], dir).then(
        (r) => r.stdout,
        () => undefined,
      ),
  };
}

/**
 * Where a repo's specs are read from, and the commit that is: the facts' commit in the clone;
 * the clone's HEAD, said, when that commit isn't in it; the folder as it is (stamped with the
 * facts' commit) when the checkout isn't a git clone.
 */
async function specTreeOf(
  repo: string,
  dir: string,
  commit: string | undefined,
  git: GitRunner,
  note?: (n: string) => void,
): Promise<{ tree?: SpecTree; commit?: string }> {
  const as = commit ? { commit } : {};
  if (!existsSync(join(dir, ".git"))) return as;
  if (commit) {
    const tree = await commitTree(dir, commit, git);
    if (tree) return { tree, commit };
    note?.(
      `${repo}: the facts' commit ${commit.slice(0, 12)} isn't in the clone, so its specs are read at the clone's HEAD; fetch it, or read the repo again.`,
    );
  }
  const tree = await commitTree(dir, "HEAD", git);
  if (!tree) {
    note?.(`${repo}: git can't list the clone's files, so its specs are read from the folder.`);
    return as;
  }
  const head = await headCommitOf(dir);
  return { tree, ...(head ? { commit: head } : as) };
}

/** Read a repo's specs at the facts' commit and keep them beside its facts; none, no companion. */
export async function writeRepoSpecs(
  root: string,
  repo: string,
  dir: string,
  facts: readonly Fact[],
  onRefused?: (note: string) => void,
  git: GitRunner = createGit(),
): Promise<SpecsFileT> {
  const { tree, commit } = await specTreeOf(
    repo,
    dir,
    await specsCommitOf(facts, dir, git),
    git,
    onRefused,
  );
  const deny = await denyHashesAt(root);
  const file = await readRepoSpecs(dir, {
    repo,
    ...(commit ? { commit } : {}),
    ...(tree ? { tree } : {}),
    facts,
    ...(deny.size ? { denyHashes: deny } : {}),
    ...(onRefused ? { onRefused } : {}),
  });
  const path = join(factsDirOf(root), `${repo}.specs.yaml`);
  if (file.specs.length) await writeFileAtomic(path, stringify(file, { lineWidth: 0 }));
  else await rm(path, { force: true });
  return file;
}

/** Every repo's specs companion on file; one that doesn't read is said. */
export async function loadRepoSpecs(
  root: string,
): Promise<{ files: SpecsFileT[]; problems: string[] }> {
  const files: SpecsFileT[] = [];
  const problems: string[] = [];
  const rel = factsRelOf(root);
  for (const n of (await readdir(factsDirOf(root)).catch(() => [] as string[])).sort()) {
    if (!n.endsWith(".specs.yaml")) continue;
    let v: unknown;
    try {
      v = parse(await readFile(join(factsDirOf(root), n), "utf8"));
    } catch (e) {
      problems.push(`${rel}/${n} isn't YAML (${(e as Error).message}); it is left out.`);
      continue;
    }
    const p = SpecsFile.safeParse(v);
    if (p.success) files.push(p.data);
    else problems.push(`${rel}/${n} isn't a specs file; it is left out.`);
  }
  return { files, problems };
}

/** One intaken spec of an outside system: where it is, and what the check reads from it. */
export interface IntakenSpec {
  path: string;
  title?: string;
  version?: string;
  specs: ContractSpecT[];
  /** The operations as the vendor match reads them (OpenAPI only). */
  operations: JoinVendor["operations"];
  hosts: string[];
}

export interface OutsideSpecsOnFile {
  system: string;
  name: string;
  /** The newest spec taken in, and the one it replaced (its supersededBy names the newest). */
  newest?: IntakenSpec;
  previous?: IntakenSpec;
}

async function intakenSpec(
  root: string,
  doc: { path: string; title?: string; version?: string },
  system: string,
): Promise<IntakenSpec | undefined> {
  const body = await readFile(
    join(inputsDirOf(root), ...doc.path.split("/").slice(1)),
    "utf8",
  ).catch(() => undefined);
  if (body === undefined) return undefined;
  const vendor = readVendorSpec(doc.path, body, system);
  const specs = vendor ? openApiContractSpecs(vendor) : readContractSpecs(doc.path, body);
  if (!specs.length) return undefined;
  return {
    path: doc.path,
    ...(doc.title ? { title: doc.title } : {}),
    ...(doc.version ? { version: doc.version } : {}),
    specs,
    operations: (vendor?.operations ?? []).map((o) => ({
      id: o.id,
      method: o.method,
      path: o.path,
      fullPath: o.fullPath,
      cite: o.cite,
    })),
    hosts: vendor?.hosts ?? [],
  };
}

export interface ContractCheckOnFile {
  result: ContractCheckResult;
  /** What the estate's facts or the companions left out, said once. */
  notes: string[];
  outside: OutsideSpecsOnFile[];
  /** Per outside system with a newer spec: the findings it brings that the one before didn't. */
  newBySystem: Map<string, ContractMismatch[]>;
}

/**
 * What the check reads, as a stamp (review item 4): every file under facts/, the inputs, the org
 * pack, the questions and the curated catalog, by path, size and modification time. The
 * generated catalog is left out: only a write of the facts changes it, and that changes facts/.
 */
async function stampOf(root: string): Promise<string> {
  const out: string[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => undefined);
    if (!entries) return;
    await Promise.all(
      entries.map(async (e) => {
        const p = join(dir, e.name);
        if (e.isDirectory()) return walk(p, `${rel}/${e.name}`);
        const s = await stat(p).catch(() => undefined);
        if (s) out.push(`${rel}/${e.name}\u0000${s.size}\u0000${s.mtimeMs}`);
      }),
    );
  };
  const dirs = [
    factsDirOf(root),
    inputsDirOf(root),
    orgPackDirOf(root),
    questionsDirOf(root),
    join(catalogDirOf(root), "curated"),
  ];
  await Promise.all(dirs.map((d, i) => walk(d, String(i))));
  return out.sort().join("\n");
}

/** Each metarepo's check, kept with the stamp it was worked out at. */
const kept = new Map<string, { stamp: string; value: Promise<ContractCheckOnFile> }>();

/** What a restart does to the checks kept in memory (tests): the copies on disk stay. */
export function forgetKeptChecks(): void {
  kept.clear();
}

/**
 * The copies kept on disk (`.atticus/cache/<name>.json`), keyed by the same stamp, so a restart of
 * `atticus ui` or another page reuses a check or a join nothing has changed since. Stamped with
 * the version that wrote it too: another version works it out again. A copy that doesn't read
 * is no copy; one that can't be written is said nowhere (the check stands without it).
 */
const cacheFileOf = (root: string, name: string) =>
  join(resolve(root), ".atticus", "cache", `${name}.json`);
const stampKey = (stamp: string) =>
  createHash("sha256").update(VERSION).update("\u0000").update(stamp).digest("hex");

async function readCached<T>(root: string, name: string, stamp: string): Promise<T | undefined> {
  try {
    const c = JSON.parse(await readFile(cacheFileOf(root, name), "utf8")) as {
      key?: string;
      value?: T;
    };
    return c.key === stampKey(stamp) ? c.value : undefined;
  } catch {
    return undefined;
  }
}

async function writeCached(root: string, name: string, stamp: string, value: unknown) {
  await writeFileAtomic(
    cacheFileOf(root, name),
    JSON.stringify({ key: stampKey(stamp), value }),
  ).catch(() => undefined);
}

/** Lets a request that came in meanwhile (the canvas's graph) run between the check's steps. */
const breathe = () => new Promise<void>((r) => setImmediate(r));

/**
 * The estate join of these facts (`estateJoinOf`), kept on disk under the stamp of what it
 * reads, so the contract check, Map › Outside systems and a restart share one join.
 */
export async function estateJoinOnFile(
  root: string,
  op: OrgPack,
  estate: {
    repos: { repo: string; facts: readonly Fact[] }[];
    targets?: Parameters<typeof estateJoinOf>[2];
    pairs?: Parameters<typeof estateJoinOf>[3];
  },
  stamp?: string,
): Promise<FactsJoinResult> {
  const at = stamp ?? (await stampOf(root));
  const hit = await readCached<FactsJoinResult>(root, "estate-join", at);
  if (hit) return hit;
  await breathe();
  const join = estateJoinOf(op, estate.repos, estate.targets, estate.pairs);
  await writeCached(root, "estate-join", at, join);
  return join;
}

/** The check as it is kept on disk: its per-system findings as entries. */
type CheckOnDisk = Omit<ContractCheckOnFile, "newBySystem"> & {
  newBySystem: [string, ContractMismatch[]][];
};

/**
 * The contract check over the whole estate, from the files on disk (ADR 0164). Worked out once
 * per metarepo and kept while nothing it reads changes, in memory and on disk, so Map ›
 * Mismatches, the canvas's marks, the Trust tab and the Outside systems page share one check,
 * and a restart reuses it; asks that come at once share one run. Its steps give way to other
 * requests between them, so the canvas's picture never waits on it. The result is shared:
 * callers read it, never change it.
 */
export async function contractCheckOf(root: string): Promise<ContractCheckOnFile> {
  const key = resolve(root);
  const stamp = await stampOf(root);
  const hit = kept.get(key);
  if (hit && hit.stamp === stamp) return hit.value;
  const value = (async () => {
    const disk = await readCached<CheckOnDisk>(root, "contract-check", stamp);
    if (disk) return { ...disk, newBySystem: new Map(disk.newBySystem) };
    const v = await workOutContractCheck(root, stamp);
    await writeCached(root, "contract-check", stamp, {
      ...v,
      newBySystem: [...v.newBySystem],
    } satisfies CheckOnDisk);
    return v;
  })();
  kept.set(key, { stamp, value });
  // A run that failed isn't kept: the next ask tries again.
  value.catch(() => {
    if (kept.get(key)?.value === value) kept.delete(key);
  });
  return value;
}

async function workOutContractCheck(root: string, stamp: string): Promise<ContractCheckOnFile> {
  const quiet = { out: () => undefined, err: () => undefined };
  const { op, inputs } = await intakeContext(root, quiet);
  const estate = await estateFacts(root, op, "");
  const join = await estateJoinOnFile(root, op, estate, stamp);
  const { files, problems } = await loadRepoSpecs(root);
  const systems = outsideProfileSystems(op);

  const outside: OutsideSpecsOnFile[] = [];
  for (const s of systems) {
    const docs = inputs.documents.filter(
      (d) => d.id && SPEC_CLASSES.has(d.classification) && d.systems[0] === s.id,
    );
    const newestDoc = docs.find((d) => !d.supersededBy);
    const previousDoc = newestDoc ? docs.find((d) => d.supersededBy === newestDoc.id) : undefined;
    const newest = newestDoc ? await intakenSpec(root, newestDoc, s.id) : undefined;
    const previous = previousDoc ? await intakenSpec(root, previousDoc, s.id) : undefined;
    outside.push({
      system: s.id,
      name: s.name,
      ...(newest ? { newest } : {}),
      ...(previous ? { previous } : {}),
    });
  }
  const repos = joinReposOf(op, estate.repos, componentRenames(estate.repos, op));
  const run = (pick: (o: OutsideSpecsOnFile) => IntakenSpec | undefined) => {
    const specs: OutsideSpecs[] = [];
    const vendors: JoinVendor[] = [];
    for (const o of outside) {
      const s = pick(o);
      if (!s) continue;
      const sys = systems.find((x) => x.id === o.system)!;
      specs.push({ system: o.system, name: o.name, specs: s.specs });
      if (s.operations.length)
        vendors.push({
          system: o.system,
          boundary: "internal",
          names: [sys.name, ...sys.aliases],
          hosts: [...new Set([...s.hosts, ...hostAliases(sys.aliases)])],
          operations: s.operations,
        });
    }
    const matched = vendors.length
      ? joinVendorOperations({ repos, vendors, targets: estate.targets, ...joinConventions(op) })
      : { matches: [] };
    return checkContracts({
      repos: estate.repos,
      join,
      specs: files,
      outside: specs,
      vendorMatches: matched.matches,
    });
  };
  await breathe();
  const result = run((o) => o.newest);
  const newBySystem = new Map<string, ContractMismatch[]>();
  if (outside.some((o) => o.previous)) {
    await breathe();
    const before = run((o) => o.previous ?? o.newest);
    for (const o of outside)
      if (o.previous)
        newBySystem.set(
          o.system,
          newFindings(
            result.findings.filter((f) => f.system === o.system),
            before.findings.filter((f) => f.system === o.system),
          ),
        );
  }
  return { result, notes: [...estate.notes, ...problems], outside, newBySystem };
}
