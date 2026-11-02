import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import {
  checkContracts,
  factsDirOf,
  factsRelOf,
  inputsDirOf,
  joinConventions,
  joinVendorOperations,
  newFindings,
  SpecsFile,
  writeFileAtomic,
  type ContractCheckResult,
  type ContractMismatch,
  type ContractSpecT,
  type Fact,
  type JoinVendor,
  type OutsideSpecs,
  type SpecsFileT,
} from "@maycombhq/core";
import {
  openApiContractSpecs,
  readContractSpecs,
  readRepoSpecs,
  readVendorSpec,
} from "@maycombhq/intake";
import {
  componentRenames,
  estateFacts,
  estateJoinOf,
  hostAliases,
  joinReposOf,
  outsideProfileSystems,
} from "@maycombhq/scanner";
import { intakeContext } from "./intake-commands.js";
import { denyHashesAt } from "./link-evidence-files.js";

/**
 * The files the contract check reads (plan item F7, ADR 0164): each repo's specs, read in its
 * checkout at the facts' commit by `verify --write` and kept beside its facts
 * (`<repo>.specs.yaml`), and the specs of outside systems taken in through intake (inputs/), the
 * newest of each and the one it replaced. Files only: nothing is fetched, no git runs.
 */

/** The intake classifications a contract spec comes in. */
const SPEC_CLASSES = new Set(["openapi", "swagger", "asyncapi", "protobuf", "avro"]);

/** Read a repo's specs in its checkout and keep them beside its facts; none, no companion. */
export async function writeRepoSpecs(
  root: string,
  repo: string,
  dir: string,
  facts: readonly Fact[],
  onRefused?: (note: string) => void,
): Promise<SpecsFileT> {
  const commit = facts.map((f) => f.commit).sort()[0];
  const deny = await denyHashesAt(root);
  const file = await readRepoSpecs(dir, {
    repo,
    ...(commit ? { commit } : {}),
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

/** The contract check over the whole estate, from the files on disk. */
export async function contractCheckOf(root: string): Promise<ContractCheckOnFile> {
  const quiet = { out: () => undefined, err: () => undefined };
  const { op, inputs } = await intakeContext(root, quiet);
  const estate = await estateFacts(root, op, "");
  const join = estateJoinOf(op, estate.repos, estate.targets);
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
  const result = run((o) => o.newest);
  const newBySystem = new Map<string, ContractMismatch[]>();
  if (outside.some((o) => o.previous)) {
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
