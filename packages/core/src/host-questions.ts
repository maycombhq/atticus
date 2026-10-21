import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isMap, isSeq, parseDocument, YAMLSeq } from "yaml";
import { writeFileAtomic } from "./fs.js";
import { isAdopted, orgPackDirOf } from "./metarepo.js";
import { RepoManifest } from "./schema/workspace.js";

/**
 * Which repo answers on a host (ADR 0088): a scan or atticus estate join asks, as a question
 * file (ADR 0078), for each host the estate's calls name that no repo lists in its `hosts`;
 * the answer writes the host under that repo's `hosts` in its repos.manifest.yaml.
 */

/** The step that asks which repo answers on a host. */
export const HOSTS_STEP = "scan-hosts";

/** The last option of a hosts question: no repo of the estate answers on it. */
export const HOSTS_NONE = "None of these";

/** The question for a host, with its port when the calls name one: localhost:9966. */
export const hostQuestionText = (host: string) => `Which repo answers on ${host}?`;

/** The host a hosts question asks about, read back from its words. */
export function hostOfQuestion(q: { question: string }): string | undefined {
  return /^Which repo answers on (\S+)\?$/.exec(q.question.trim())?.[1];
}

/**
 * Put a host under a repo's `hosts` in the repos.manifest.yaml that lists it, keeping the
 * file's comments and order. `added` is false when the repo already lists it. Throws when no
 * manifest lists the repo, or the host isn't one the manifest takes.
 */
export async function addManifestHost(
  root: string,
  repo: string,
  host: string,
): Promise<{ manifest: string; added: boolean }> {
  const profiles = join(orgPackDirOf(root), "profiles");
  const names = await readdir(profiles, { withFileTypes: true }).catch(() => []);
  for (const d of names
    .filter((x) => x.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const file = join(profiles, d.name, "repos.manifest.yaml");
    const text = await readFile(file, "utf8").catch(() => undefined);
    if (text === undefined) continue;
    const doc = parseDocument(text);
    const repos = doc.get("repos");
    if (!isSeq(repos)) continue;
    const node = repos.items.find((r) => isMap(r) && r.get("id") === repo);
    if (!isMap(node)) continue;
    const rel = `${isAdopted(root) ? ".atticus/" : ""}org-pack/profiles/${d.name}/repos.manifest.yaml`;
    let hosts = node.get("hosts");
    if (!isSeq(hosts)) {
      hosts = new YAMLSeq();
      (hosts as YAMLSeq).flow = true;
      node.set("hosts", hosts);
    }
    const seq = hosts as YAMLSeq;
    if (seq.items.some((h) => String((h as { value?: unknown })?.value ?? h) === host))
      return { manifest: rel, added: false };
    seq.add(host);
    // The manifest must still be one Atticus reads before it is written.
    RepoManifest.parse(doc.toJS());
    await writeFileAtomic(file, doc.toString());
    return { manifest: rel, added: true };
  }
  throw new Error(`${repo} isn't in any repos.manifest.yaml`);
}
