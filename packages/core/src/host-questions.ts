import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isMap, isSeq, parseDocument, YAMLSeq } from "yaml";
import { writeFileIfUnchanged } from "./fs.js";
import { changedLines, eolOf, inEol, lfOnly, type LineChange } from "./manifest-edit.js";
import { slugify, cmpText } from "./identity.js";
import { isAdopted, orgPackDirOf } from "./metarepo.js";
import { migrateProfileText } from "./profile-migrate.js";
import { Profile } from "./schema/orgpack.js";
import { RepoManifest } from "./schema/workspace.js";

/**
 * Which repo answers on a host (ADR 0088): a scan or atticus estate join asks, as a question
 * file (ADR 0078), for each host the estate's calls name that no repo lists in its `hosts`;
 * the answer writes the host under that repo's `hosts` in its repos.manifest.yaml.
 */

/** The step that asks which repo answers on a host. */
export const HOSTS_STEP = "scan-hosts";

/**
 * The step that asks which repo or system answers a call with no target (the scanner's
 * TARGETS_STEP), and its group question's option that says the calls go to more than one place:
 * named here so an answer's rule (ADR 0153) is checked where it is written.
 */
export const TARGETS_STEP_ID = "facts-targets";
export const TARGETS_SPLIT_LABEL = "Not all to one place";
/**
 * ADR 0162 (F8): the option of a targets question that opens the picker of the whole estate (the
 * manifest's repos, the profiles' systems, the teams). It names nothing: it is never an answer.
 */
export const TARGETS_ANOTHER_LABEL = "Another repo…";

/**
 * ADR 0162 (F8): the step that asks who owns a topic or queue the repo publishes to or listens on
 * that no estate repo serves the other side of, and its option that opens the picker (a system of
 * the profile, or a team): the answer adds the topic to that system's aliases, so the merge lands
 * the publish or the listener on it, as a file change for review.
 */
export const TOPICS_STEP_ID = "facts-topics";
export const TOPICS_OUTSIDE_LABEL = "A topic owned by another team or vendor";

/** A topics question's words: what the repo does with the topic, and the topic. */
export const topicQuestionText = (topic: string, component: string, side: "publish" | "listen") =>
  `Who owns the topic ${topic}, which ${component} ${side === "publish" ? "publishes to" : "listens on"}?`;

/** The topic a topics question asks about, read back from its words. */
export function topicOfQuestion(q: { question: string }): string | undefined {
  return /^Who owns the topic (\S+), which /.exec(q.question.trim())?.[1];
}

/** The options that open the picker: they name nothing, so they are never an answer. */
export const PICKER_LABELS: ReadonlySet<string> = new Set([
  TARGETS_ANOTHER_LABEL,
  TOPICS_OUTSIDE_LABEL,
]);

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
    .sort((a, b) => cmpText(a.platform, b.platform));
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
    await writeFileIfUnchanged(file, before, inEol(doc.toString(), eolOf(before ?? "")));
    return { id: sys.id, profile: rel, added: true };
  }
  throw new Error(`${repo} isn't in any repos.manifest.yaml`);
}

/**
 * ADR 0162 (F8): put a system a person named in a targets answer into the profile whose
 * repos.manifest.yaml lists the repo that asked: a vendor (boundary vendor), or another team's
 * system (boundary internal, owner the team's id from roles.yaml). Written as a file change in the
 * metarepo, for review in the pull request, never to a shared system. `added` is false when a
 * system of the profiles already has the id. Throws when no manifest lists the repo, or the
 * profile would not be valid.
 */
export async function addProfileSystem(
  root: string,
  repo: string,
  s: {
    id: string;
    name: string;
    boundary: "internal" | "vendor";
    owner?: string;
    /**
     * The topics and queues it owns (ADR 0162 amendment): written under `topics`, never
     * `aliases`, with the profile at schema version 2.
     */
    topics?: string[];
  },
  o: { preview?: boolean } = {},
): Promise<{
  id: string;
  profile: string;
  added: boolean;
  topics?: string[];
  /** The lines a new system changes in the profile (as the write makes them). */
  changes?: LineChange[];
}> {
  const platforms = await platformsOf(root);
  const relOf = (platform: string) =>
    `${isAdopted(root) ? ".atticus/" : ""}org-pack/profiles/${platform}/profile.yaml`;
  const topics = s.topics ?? [];
  /** A profile that names topics is at version 2 (the number only, as `atticus upgrade` writes it). */
  const atV2 = (text: string) => (topics.length ? migrateProfileText(text).text : text);
  const valid = (doc: ReturnType<typeof parseDocument>, platform: string) => {
    const checked = Profile.safeParse(doc.toJS());
    if (!checked.success)
      throw new Error(
        `${relOf(platform)} would not be valid: ${checked.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      );
  };
  for (const { dir, platform } of platforms) {
    const file = join(dir, "profile.yaml");
    const text = await readFile(file, "utf8").catch(() => undefined);
    const p = text === undefined ? undefined : Profile.safeParse(parseDocument(text).toJS());
    const had = p?.success ? p.data.systems.find((x) => x.id === s.id) : undefined;
    if (!had) continue;
    // A system the profile has already: the topics it lacks go under its topics.
    const missing = topics.filter((t) => !(had.topics ?? []).includes(t));
    if (missing.length) {
      const doc = parseDocument(atV2(text!));
      const seq = doc.get("systems") as YAMLSeq;
      const node = seq.items.find((x) => isMap(x) && x.get("id") === s.id);
      if (isMap(node)) {
        const list = node.get("topics");
        if (isSeq(list)) for (const t of missing) list.add(doc.createNode(t));
        else node.set("topics", doc.createNode([...(had.topics ?? []), ...missing]));
        valid(doc, platform);
        await writeFileIfUnchanged(file, text, inEol(doc.toString(), eolOf(text!)));
      }
    }
    return {
      id: s.id,
      profile: relOf(platform),
      added: false,
      ...(missing.length ? { topics: missing } : {}),
    };
  }
  for (const { dir, platform } of platforms) {
    const text = await readFile(join(dir, "repos.manifest.yaml"), "utf8").catch(() => undefined);
    if (text === undefined) continue;
    const repos = parseDocument(text).get("repos");
    if (!isSeq(repos) || !repos.items.some((r) => isMap(r) && r.get("id") === repo)) continue;
    const file = join(dir, "profile.yaml");
    const raw = await readFile(file, "utf8").catch(() => undefined);
    // Compared and written in the file's own line endings (a Windows checkout's CRLF).
    const eol = eolOf(raw ?? "");
    const before = raw === undefined ? undefined : lfOnly(raw);
    const doc = parseDocument(
      atV2(before ?? `schemaVersion: 1\nplatform: ${platform}\nname: ${platform}\n`),
    );
    let systems = doc.get("systems");
    if (!isSeq(systems)) {
      doc.set("systems", doc.createNode([]));
      systems = doc.get("systems");
    }
    // An empty `systems: []` opens out into a block list, as a hand-written profile has.
    if ((systems as YAMLSeq).items.length === 0) (systems as YAMLSeq).flow = false;
    (systems as YAMLSeq).add(
      doc.createNode({
        id: s.id,
        name: s.name,
        boundary: s.boundary,
        ...(s.owner ? { owner: s.owner } : {}),
        aliases: [],
        ...(topics.length ? { topics: [...topics] } : {}),
      }),
    );
    valid(doc, platform);
    // Block lists stay block; flow lines take the library's padding, as this writer always has
    // (yaml pads maps and lists alike, so a file that mixes them can't keep both).
    const after = doc.toString({ lineWidth: 0, flowCollectionPadding: true });
    const changes = changedLines(before ?? "", after);
    if (o.preview) return { id: s.id, profile: relOf(platform), added: true, changes };
    await writeFileIfUnchanged(file, raw, inEol(after, eol));
    return { id: s.id, profile: relOf(platform), added: true, changes };
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
  /**
   * ADR 0153 (Q2): the path the repo answers under on the host, from an answer's path rule, set
   * as its `basePath`. Refused when the repo gives another one.
   */
  o: { basePath?: string } = {},
): Promise<{ manifest: string; added: boolean }> {
  const profiles = join(orgPackDirOf(root), "profiles");
  const names = await readdir(profiles, { withFileTypes: true }).catch(() => []);
  for (const d of names.filter((x) => x.isDirectory()).sort((a, b) => cmpText(a.name, b.name))) {
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
    const had = node.get("basePath");
    if (o.basePath && had !== undefined && String(had) !== o.basePath)
      throw new Error(
        `${repo} answers under ${String(had)} in ${rel}, not ${o.basePath}: change its basePath there by hand if it moved`,
      );
    const listed = seq.items.some((h) => String((h as { value?: unknown })?.value ?? h) === host);
    if (listed && (!o.basePath || had !== undefined)) return { manifest: rel, added: false };
    if (!listed) seq.add(host);
    if (o.basePath && had === undefined) node.set("basePath", o.basePath);
    // The manifest must still be one Atticus reads before it is written.
    RepoManifest.parse(doc.toJS());
    await writeFileIfUnchanged(file, text, inEol(doc.toString(), eolOf(text)));
    return { manifest: rel, added: true };
  }
  throw new Error(`${repo} isn't in any repos.manifest.yaml`);
}
