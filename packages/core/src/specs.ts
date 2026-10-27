import { createHash } from "node:crypto";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { parseRecord, type RecordOf } from "./catalog.js";
import { FLOW_SCHEMA_VERSION } from "./schema/kinds.js";
import { writeFileAtomic } from "./fs.js";
import { readParsedFiles, type ParseOutcome } from "./record-cache.js";
import { specDirOf, specRelOf, specsDirOf, specsRelOf } from "./metarepo.js";
import {
  EstateJoins,
  SPEC_HEADER_SCHEMA_VERSION,
  SpecFindings,
  SpecHeader,
} from "./schema/spec.js";
import { serializeRecord, toCanonicalYaml } from "./serialize.js";

/**
 * A repo's spec as files (ADR 0079): specs/<repo>/spec.yaml (the header), one canonical YAML
 * file per flow named by its id, and findings.yaml (the critic's last findings). In a repo
 * adopted in place the folder is .atticus/specs/<repo>/.
 */

export type FlowRecord = RecordOf<"Flow">;

export const SPEC_HEADER_FILE = "spec.yaml";
export const SPEC_FINDINGS_FILE = "findings.yaml";

export interface RepoSpec {
  header?: SpecHeader;
  flows: FlowRecord[];
  /** Files in the folder that aren't valid, with why (relative to the root). */
  problems: { file: string; message: string }[];
}

const issues = (r: { error: { issues: { path: PropertyKey[]; message: string }[] } }) =>
  r.error.issues.map((i) => `${i.path.map(String).join(".") || "(top)"}: ${i.message}`).join("; ");

/**
 * Bumped when what a kept parse of a spec file holds changes, so a cache an older Atticus
 * wrote is read from the files again (record-cache.ts).
 */
const SPEC_CACHE_VERSION = `spec@${FLOW_SCHEMA_VERSION}.${SPEC_HEADER_SCHEMA_VERSION}`;

/** One spec file's parse: the header, or a flow, as `readRepoSpec` reads them. */
type SpecFile = { header: SpecHeader; flow?: never } | { flow: FlowRecord; header?: never };

/** What a spec file's name means, and what its text says, in the words `readRepoSpec` uses. */
function parseSpecFile(text: string, name: string, rel: string): ParseOutcome<SpecFile> {
  let data: unknown;
  try {
    data = parse(text);
  } catch (e) {
    return { ok: false, message: (e as Error).message.split("\n")[0]! };
  }
  if (name === SPEC_HEADER_FILE) {
    const h = SpecHeader.safeParse(data);
    return h.success ? { ok: true, value: { header: h.data } } : { ok: false, message: issues(h) };
  }
  const r = parseRecord(data);
  if (!r.ok)
    return {
      ok: false,
      message: r.issues.map((i) => `${i.path || "(top)"}: ${i.message}`).join("; "),
    };
  if (r.record.kind !== "Flow") return { ok: false, message: `is a ${r.record.kind}, not a Flow` };
  if (`${r.record.id}.yaml` !== name)
    return { ok: false, message: `holds ${r.record.id}; put it in ${rel}/${r.record.id}.yaml` };
  return { ok: true, value: { flow: r.record } };
}

/**
 * Read a repo's spec: header, flows (sorted by id) and the files that didn't read. `cacheRoot`
 * is the metarepo this run is working in, and the only place the parses are kept (record-cache.ts);
 * reading another team's estate leaves it out, and then nothing is written into it.
 */
export async function readRepoSpec(
  root: string,
  repo: string,
  o: { cacheRoot?: string } = {},
): Promise<RepoSpec> {
  const dir = specDirOf(root, repo);
  const rel = specRelOf(root, repo);
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".yaml")).sort();
  } catch {
    return { flows: [], problems: [] };
  }
  const out: RepoSpec = { flows: [], problems: [] };
  // The files are read at once, and one whose size and time haven't changed since the last run
  // isn't parsed again (record-cache.ts): a metarepo's specs hold hundreds of flows.
  const read = await readParsedFiles<SpecFile>({
    dir,
    files: names.filter((n) => n !== SPEC_FINDINGS_FILE),
    name: "spec",
    version: SPEC_CACHE_VERSION,
    parse: (text, name) => parseSpecFile(text, name, rel),
    cacheRoot: o.cacheRoot,
  });
  for (const p of read) {
    if (p.problem !== undefined) {
      out.problems.push({ file: `${rel}/${p.rel}`, message: p.problem });
      continue;
    }
    if (p.value!.header) out.header = p.value!.header;
    else out.flows.push(p.value!.flow!);
  }
  return out;
}

/**
 * Every flow file in specs/, by flow id, from the file names alone — no file is read (ADR 0079:
 * a flow lives at specs/<repo>/<id>.yaml, and a file holding another id is a problem
 * `readRepoSpec` reports and leaves out). A command that needs a handful of flows out of
 * hundreds reads those with `readFlow` instead of parsing every one.
 */
export async function specFlowFiles(
  root: string,
): Promise<Map<string, { repo: string; file: string }>> {
  const out = new Map<string, { repo: string; file: string }>();
  for (const repo of await specRepos(root)) {
    const dir = specDirOf(root, repo);
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const n of names.sort()) {
      if (!n.endsWith(".yaml") || n === SPEC_HEADER_FILE || n === SPEC_FINDINGS_FILE) continue;
      const id = n.slice(0, -".yaml".length);
      if (!out.has(id)) out.set(id, { repo, file: join(dir, n) });
    }
  }
  return out;
}

/**
 * One flow of a repo's spec, or undefined when there is no such file, it isn't valid, or it
 * holds another flow — exactly the flows `readRepoSpec` returns, one at a time.
 */
export async function readFlow(
  root: string,
  repo: string,
  id: string,
): Promise<FlowRecord | undefined> {
  const name = `${id}.yaml`;
  const text = await readFile(join(specDirOf(root, repo), name), "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  const r = parseSpecFile(text, name, specRelOf(root, repo));
  return r.ok ? r.value.flow : undefined;
}

/** Write one flow at specs/<repo>/<id>.yaml in canonical YAML. */
export async function writeFlow(root: string, repo: string, flow: FlowRecord): Promise<string> {
  const r = parseRecord(flow);
  if (!r.ok || r.record.kind !== "Flow")
    throw new Error(
      `not a valid Flow: ${r.ok ? r.record.kind : r.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
    );
  await writeFileAtomic(join(specDirOf(root, repo), `${flow.id}.yaml`), serializeRecord(r.record));
  return `${specRelOf(root, repo)}/${flow.id}.yaml`;
}

/** Remove a flow's file (a flow redrafted under another id, or dropped). */
export async function removeFlow(root: string, repo: string, id: string): Promise<void> {
  await rm(join(specDirOf(root, repo), `${id}.yaml`), { force: true });
}

const HEADER_KEYS = ["schemaVersion", "repo", "commit", "template", "templateReviewed"];

/** Write specs/<repo>/spec.yaml. */
export async function writeSpecHeader(root: string, header: SpecHeader): Promise<void> {
  const h = SpecHeader.parse(header);
  await writeFileAtomic(
    join(specDirOf(root, h.repo), SPEC_HEADER_FILE),
    `# The spec of ${h.repo} (ADR 0079): one file per flow beside this one. Drafted by atticus spec draft, checked by atticus spec check.\n${toCanonicalYaml(h, HEADER_KEYS)}`,
  );
}

/** The critic's last findings for a repo, or undefined before the first check. */
export async function readSpecFindings(
  root: string,
  repo: string,
): Promise<SpecFindings | undefined> {
  try {
    const r = SpecFindings.safeParse(
      parse(await readFile(join(specDirOf(root, repo), SPEC_FINDINGS_FILE), "utf8")),
    );
    return r.success ? r.data : undefined;
  } catch {
    return undefined;
  }
}

/** Write specs/<repo>/findings.yaml. */
export async function writeSpecFindings(root: string, f: SpecFindings): Promise<void> {
  const v = SpecFindings.parse(f);
  await writeFileAtomic(
    join(specDirOf(root, v.repo), SPEC_FINDINGS_FILE),
    `# The last atticus spec check of ${v.repo} (ADR 0079). A finding that comes back unchanged after a redraft becomes a question.\n${toCanonicalYaml(v, ["schemaVersion", "repo", "checkedAt", "draftedAt"])}`,
  );
}

/** The short hash a spec header keeps per cited file: sha-256, first 16 hex, of the text with LF endings. */
export function specFileHash(text: string): string {
  return createHash("sha256").update(text.replace(/\r\n?/g, "\n")).digest("hex").slice(0, 16);
}

/** The fingerprint of a critic finding: sha-256, first 12 hex, of rule, target and evidence. */
export function specFindingFingerprint(rule: string, target: string, evidence = ""): string {
  return createHash("sha256")
    .update([rule, target, evidence].join("\n"))
    .digest("hex")
    .slice(0, 12);
}

/** The estate pass's joins (ADR 0085), beside the repo folders: specs/estate.yaml. */
export const ESTATE_FILE = "estate.yaml";

/** The repos that have a spec folder, sorted. */
export async function specRepos(root: string): Promise<string[]> {
  try {
    return (await readdir(specsDirOf(root), { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

/** specs/estate.yaml, or undefined when the estate pass hasn't run (or the file doesn't read). */
export async function readEstateJoins(root: string): Promise<EstateJoins | undefined> {
  try {
    const r = EstateJoins.safeParse(
      parse(await readFile(join(specsDirOf(root), ESTATE_FILE), "utf8")),
    );
    return r.success ? r.data : undefined;
  } catch {
    return undefined;
  }
}

/** Write specs/estate.yaml in canonical YAML. Returns its path relative to the root. */
export async function writeEstateJoins(root: string, joins: EstateJoins): Promise<string> {
  const v = EstateJoins.parse(joins);
  await writeFileAtomic(
    join(specsDirOf(root), ESTATE_FILE),
    `# The estate pass (ADR 0085): each call-out of the repos' flows joined to the flow its target starts, or why not. Written by atticus estate join.\n${toCanonicalYaml(v, ["schemaVersion", "joinedAt", "repos"])}`,
  );
  return `${specsRelOf(root)}/${ESTATE_FILE}`;
}

/** Every repo-relative file a flow cites (trigger, steps, errors), sorted. */
export function flowFiles(flow: FlowRecord): string[] {
  const out = new Set<string>();
  for (const e of [
    ...flow.evidence,
    ...flow.trigger.evidence,
    ...flow.steps.flatMap((s) => s.evidence),
    ...flow.errors.flatMap((x) => x.evidence),
  ])
    if (e.path) out.add(e.path);
  return [...out].sort();
}
