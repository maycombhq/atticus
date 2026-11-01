import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isMap, isSeq, parseDocument, YAMLSeq } from "yaml";
import { writeFileAtomic } from "./fs.js";
import { slugify } from "./identity.js";
import { isAdopted, orgPackDirOf } from "./metarepo.js";
import { Profile } from "./schema/orgpack.js";
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

/**
 * The options of a hosts question that say an outside system answers on the host (O1): another
 * team's system (boundary internal, the first, the default) or a vendor's. The answer writes the
 * system into the profile of the repo that asked, with the host as its alias, so the calls to
 * the host go to it (F3: a declared system no estate repo belongs to is outside).
 */
export const HOSTS_OUTSIDE_INTERNAL = "An outside system (new): another team's";
export const HOSTS_OUTSIDE_VENDOR = "An outside system (new): a vendor";

/** The boundary an outside-system option of a hosts question gives its system, if it is one. */
export function outsideBoundaryOf(label: string | undefined): "internal" | "vendor" | undefined {
  if (label === HOSTS_OUTSIDE_INTERNAL) return "internal";
  if (label === HOSTS_OUTSIDE_VENDOR) return "vendor";
  return undefined;
}

/** The system an outside-system answer adds for a host: its id and name, both from the host. */
export function outsideSystemOf(host: string): { id: string; name: string } {
  return { id: slugify(host.replace(/[.:]+/g, "-")), name: host };
}

/** The question for a host, with its port when the calls name one: localhost:9966. */
export const hostQuestionText = (host: string) => `Which repo answers on ${host}?`;

/** The host a hosts question asks about, read back from its words. */
export function hostOfQuestion(q: { question: string }): string | undefined {
  return /^Which repo answers on (\S+)\?$/.exec(q.question.trim())?.[1];
}

/** The profiles folder of the org pack, its platforms sorted. */
async function platformsOf(root: string): Promise<{ dir: string; platform: string }[]> {
  const profiles = join(orgPackDirOf(root), "profiles");
  const names = await readdir(profiles, { withFileTypes: true }).catch(() => []);
  return names
    .filter((x) => x.isDirectory())
    .map((x) => ({ dir: join(profiles, x.name), platform: x.name }))
    .sort((a, b) => a.platform.localeCompare(b.platform));
}

/**
 * Put an outside system for a host into the profile whose repos.manifest.yaml lists the repo
 * that asked (O1): its id and name from the host, the host as its alias, the boundary given
 * (internal: another team's; vendor). The profile keeps its comments and order, and is made,
 * with the platform's id as its name, when there is none. `added` is false when a system of the
 * profiles already names the host. Throws when no manifest lists the repo, or the profile would
 * not be valid (an id another system has).
 */
export async function addOutsideSystem(
  root: string,
  repo: string,
  host: string,
  boundary: "internal" | "vendor",
): Promise<{ id: string; profile: string; added: boolean }> {
  const platforms = await platformsOf(root);
  const sys = outsideSystemOf(host);
  const key = host.toLowerCase();
  // A system any profile has that names the host already takes its calls.
  for (const { dir, platform } of platforms) {
    const text = await readFile(join(dir, "profile.yaml"), "utf8").catch(() => undefined);
    const p = text === undefined ? undefined : Profile.safeParse(parseDocument(text).toJS());
    const hit = p?.success
      ? p.data.systems.find((s) =>
          [s.id, s.name, ...s.aliases].some((n) => n.toLowerCase() === key),
        )
      : undefined;
    if (hit) {
      const rel = `${isAdopted(root) ? ".atticus/" : ""}org-pack/profiles/${platform}/profile.yaml`;
      return { id: hit.id, profile: rel, added: false };
    }
  }
  for (const { dir, platform } of platforms) {
    const text = await readFile(join(dir, "repos.manifest.yaml"), "utf8").catch(() => undefined);
    if (text === undefined) continue;
    const repos = parseDocument(text).get("repos");
    if (!isSeq(repos) || !repos.items.some((r) => isMap(r) && r.get("id") === repo)) continue;
    const file = join(dir, "profile.yaml");
    const rel = `${isAdopted(root) ? ".atticus/" : ""}org-pack/profiles/${platform}/profile.yaml`;
    const before = await readFile(file, "utf8").catch(() => undefined);
    const doc = parseDocument(
      before ?? `schemaVersion: 1\nplatform: ${platform}\nname: ${platform}\n`,
    );
    let systems = doc.get("systems");
    if (!isSeq(systems)) {
      doc.set("systems", doc.createNode([]));
      systems = doc.get("systems");
    }
    (systems as YAMLSeq).add(
      doc.createNode({ id: sys.id, name: sys.name, boundary, aliases: [host] }),
    );
    // The profile must still be one Atticus reads before it is written.
    const checked = Profile.safeParse(doc.toJS());
    if (!checked.success)
      throw new Error(
        `${rel} would not be valid: ${checked.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      );
    await writeFileAtomic(file, doc.toString());
    return { id: sys.id, profile: rel, added: true };
  }
  throw new Error(`${repo} isn't in any repos.manifest.yaml`);
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
