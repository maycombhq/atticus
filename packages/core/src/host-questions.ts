import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isMap, isSeq, parseDocument, YAMLSeq } from "yaml";
import { writeFileIfUnchanged } from "./fs.js";
import { changedLines, eolOf, inEol, lfOnly, type LineChange } from "./manifest-edit.js";
import { slugify, cmpText } from "./identity.js";
import { factsDirOf, isAdopted, orgPackDirOf } from "./metarepo.js";
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
 * The step `atticus estate join` asks which component a spec step's call-out reaches by (named
 * here so the answer's rules below are checked where it is written; the CLI raises it).
 */
export const ESTATE_TARGETS_STEP_ID = "estate-targets";

/**
 * Beta.24 review (answers made into boxes): the questions about where calls go, whose answer the
 * join reads: hosts, targets (an ambiguous call or an unknown host's), topics and the estate's
 * call-outs. Each takes Ignore, and none takes words that name nothing as a system.
 */
export const JOIN_STEPS: ReadonlySet<string> = new Set([
  HOSTS_STEP,
  TARGETS_STEP_ID,
  TOPICS_STEP_ID,
  ESTATE_TARGETS_STEP_ID,
]);

/**
 * The option every join question has (beta.24 review): the calls it asks about aren't real calls
 * (CI/CD, a test, a template), so the join leaves them, the same as "None of these", and never
 * draws a box for them. Its words with a reason are `Ignore: <reason>`.
 */
export const JOIN_IGNORE_LABEL = "Ignore: not a real call (e.g. CI/CD, a test, a template)";
/** How an Ignore answer with a reason starts (the person's words follow it). */
export const IGNORE_PREFIX = "Ignore:";

/** The Ignore option, as a question file holds it. */
export const ignoreOption = (): { label: string; means: string; changes: string } => ({
  label: JOIN_IGNORE_LABEL,
  means: "These aren't real calls: a CI/CD job, a test or a template, not code that runs",
  changes:
    "The join leaves these calls (ignored by you), no box is drawn for them, and this isn't asked again",
});

/** An Ignore answer's words: `Ignore: <reason>`. */
export const ignoreText = (reason: string) => `${IGNORE_PREFIX} ${reason.trim()}`;

/**
 * Whether a question's answer is Ignore (beta.24 review), and its reason when one was given: the
 * Ignore option, or words that start `Ignore:`. Undefined for any other answer, or none.
 */
export function ignoredAnswer(q: {
  options: readonly { label: string }[];
  answer?: { option?: number; text?: string; by: unknown } | undefined;
}): { reason?: string } | undefined {
  const a = q.answer;
  if (!a) return undefined;
  if (a.option !== undefined)
    return q.options[a.option - 1]?.label === JOIN_IGNORE_LABEL ? {} : undefined;
  const t = a.text?.trim() ?? "";
  if (t === JOIN_IGNORE_LABEL) return {};
  if (!t.toLowerCase().startsWith(IGNORE_PREFIX.toLowerCase())) return undefined;
  const reason = t.slice(IGNORE_PREFIX.length).trim();
  return reason ? { reason } : {};
}

/** The longest name an outside system an answer adds may have. */
export const SYSTEM_NAME_MAX = 40;

/** Words that make a phrase a sentence, never a system's name (beta.24 review). */
const SENTENCE_WORDS = new Set([
  "ignore",
  "this",
  "is",
  "a",
  "to",
  "the",
  "related",
  "not",
  "its",
  "it",
]);

/**
 * Why words can't be a new outside system's name (beta.24 review), or undefined when they can: a
 * short name of letters, digits, spaces and dashes, at most 40 characters, not a sentence (four
 * words at most, none of "ignore", "this", "is", "a", "to", "the", "related", "not", "it").
 */
export function systemNameProblem(name: string): string | undefined {
  const n = name.trim();
  if (!n) return "a system's name can't be empty";
  if (n.length > SYSTEM_NAME_MAX)
    return `a system's name is at most ${SYSTEM_NAME_MAX} characters (this is ${n.length})`;
  if (!/^[A-Za-z0-9][A-Za-z0-9 -]*$/.test(n))
    return "a system's name is letters, digits, spaces and dashes only";
  const words = n
    .toLowerCase()
    .split(/[\s-]+/)
    .filter(Boolean);
  if (words.length > 4 || words.some((w) => SENTENCE_WORDS.has(w)))
    return "that reads as a sentence, not a system's name";
  return undefined;
}

/**
 * Beta.24 review: whether a system (its id, and its name when it has one) looks made from an
 * answer's words rather than named: an id of five or more dash-separated words, or with a word
 * of a sentence in it, or a name with spaces longer than 40 characters.
 */
export function madeFromWords(id: string, name?: string): boolean {
  const words = id
    .toLowerCase()
    .split(/[-_.]+/)
    .filter(Boolean);
  if (words.length >= 5) return true;
  if (words.some((w) => SENTENCE_WORDS.has(w))) return true;
  const n = name?.trim() ?? "";
  return /\s/.test(n) && n.length > SYSTEM_NAME_MAX;
}

/**
 * Beta.24 review: whether words name a repo, component, system or team Atticus knows, as an
 * answer about where calls go may: a repo of the manifests (its id, component or a module's
 * component), a system of the profiles (its id, name, an alias or a topic), a team of roles.yaml,
 * or a component a repo's facts name. Case and spacing aside, or by the id the words slug to.
 */
export async function namesKnownTarget(root: string, words: string): Promise<boolean> {
  const { loadOrgPack } = await import("./orgpack-load.js");
  const op = await loadOrgPack(orgPackDirOf(root)).catch(() => undefined);
  const names = new Set<string>();
  const add = (n: string | undefined) => {
    if (!n?.trim()) return;
    names.add(n.trim().toLowerCase());
    names.add(slugify(n));
  };
  for (const p of op?.profiles ?? []) {
    for (const r of p.repos?.repos ?? []) {
      add(r.id);
      add(r.component);
      for (const m of r.modules ?? []) add(m.component);
    }
    for (const s of p.profile?.systems ?? [])
      for (const n of [s.id, s.name, ...s.aliases, ...(s.topics ?? [])]) add(n);
  }
  for (const t of op?.roles?.teams ?? []) add(t.id);
  const want = words.trim().toLowerCase();
  if (names.has(want) || names.has(slugify(words))) return true;
  // The components the repos' facts name (a module the manifest doesn't list).
  const dir = factsDirOf(root);
  for (const f of await readdir(dir).catch(() => [] as string[])) {
    if (!/^[^.][^/]*\.jsonl$/.test(f) || /\.(corrections|reviewed|rejected)\.jsonl$/.test(f))
      continue;
    const text = await readFile(join(dir, f), "utf8").catch(() => "");
    for (const m of text.matchAll(/"component"\s*:\s*"([^"]+)"/g)) add(m[1]);
    if (names.has(want) || names.has(slugify(words))) return true;
  }
  return false;
}

/**
 * Beta.24 review: the refusal of words that name no repo, component or system as the answer of a
 * question about where calls go, in a person's words: what to do instead.
 */
export const wordsNameNothing = (words: string) =>
  `"${words.length > 60 ? `${words.slice(0, 57)}...` : words}" names no repo, component or system Atticus knows, so it isn't made into a box on the map. Pick a repo or system; or choose "An outside system (new)" and type its name (a short name: letters, digits, spaces and dashes, up to ${SYSTEM_NAME_MAX} characters, not a sentence); or choose "${JOIN_IGNORE_LABEL}" if these aren't real calls.`;

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
 * Beta.24 review: take a system out of the profile that has it, or (with `rename`) give it another
 * id and name, keeping its other fields, the file's comments and its order. For a system an
 * answer's words made (`madeFromWords`), from Map › Trust: written as a file change in the
 * metarepo, for review in the pull request. `preview` writes nothing. Undefined when no profile
 * has the system. Throws when the profile would not be valid (the new id another system has).
 */
export async function editProfileSystem(
  root: string,
  id: string,
  o: { rename?: { id: string; name: string }; preview?: boolean } = {},
): Promise<{ profile: string; changes: LineChange[]; written: boolean } | undefined> {
  for (const { dir, platform } of await platformsOf(root)) {
    const file = join(dir, "profile.yaml");
    const raw = await readFile(file, "utf8").catch(() => undefined);
    if (raw === undefined) continue;
    const doc = parseDocument(lfOnly(raw));
    const seq = doc.get("systems");
    if (!isSeq(seq)) continue;
    const at = seq.items.findIndex((x) => isMap(x) && x.get("id") === id);
    if (at < 0) continue;
    const rel = `${isAdopted(root) ? ".atticus/" : ""}org-pack/profiles/${platform}/profile.yaml`;
    if (o.rename) {
      const node = seq.items[at];
      if (isMap(node)) {
        node.set("id", o.rename.id);
        node.set("name", o.rename.name);
      }
    } else seq.items.splice(at, 1);
    const checked = Profile.safeParse(doc.toJS());
    if (!checked.success)
      throw new Error(
        `${rel} would not be valid: ${checked.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      );
    const after = doc.toString({ lineWidth: 0, flowCollectionPadding: true });
    const changes = changedLines(lfOnly(raw), after);
    if (o.preview) return { profile: rel, changes, written: false };
    await writeFileIfUnchanged(file, raw, inEol(after, eolOf(raw)));
    return { profile: rel, changes, written: true };
  }
  return undefined;
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
