import { createHash } from "node:crypto";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { parseRecord, type RecordOf } from "./catalog.js";
import { writeFileAtomic } from "./fs.js";
import { specDirOf, specRelOf, specsDirOf, specsRelOf } from "./metarepo.js";
import { EstateJoins, SpecFindings, SpecHeader } from "./schema/spec.js";
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

/** Read a repo's spec: header, flows (sorted by id) and the files that didn't read. */
export async function readRepoSpec(root: string, repo: string): Promise<RepoSpec> {
  const dir = specDirOf(root, repo);
  const rel = specRelOf(root, repo);
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".yaml")).sort();
  } catch {
    return { flows: [], problems: [] };
  }
  const out: RepoSpec = { flows: [], problems: [] };
  for (const n of names) {
    if (n === SPEC_FINDINGS_FILE) continue;
    let data: unknown;
    try {
      data = parse(await readFile(join(dir, n), "utf8"));
    } catch (e) {
      out.problems.push({ file: `${rel}/${n}`, message: (e as Error).message.split("\n")[0]! });
      continue;
    }
    if (n === SPEC_HEADER_FILE) {
      const h = SpecHeader.safeParse(data);
      if (h.success) out.header = h.data;
      else out.problems.push({ file: `${rel}/${n}`, message: issues(h) });
      continue;
    }
    const r = parseRecord(data);
    if (!r.ok)
      out.problems.push({
        file: `${rel}/${n}`,
        message: r.issues.map((i) => `${i.path || "(top)"}: ${i.message}`).join("; "),
      });
    else if (r.record.kind !== "Flow")
      out.problems.push({ file: `${rel}/${n}`, message: `is a ${r.record.kind}, not a Flow` });
    else if (`${r.record.id}.yaml` !== n)
      out.problems.push({
        file: `${rel}/${n}`,
        message: `holds ${r.record.id}; put it in ${rel}/${r.record.id}.yaml`,
      });
    else out.flows.push(r.record);
  }
  return out;
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
