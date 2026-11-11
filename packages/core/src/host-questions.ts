import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isAlias, isMap, isNode, isSeq, parseDocument, visit, YAMLSeq, type Document } from "yaml";
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

/** Beta.25: the longest reason an Ignore keeps, as the local API takes it. */
export const IGNORE_REASON_MAX = 300;

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

/**
 * The small words a sentence is made of (beta.24 review): two or more of them in a phrase make it
 * a sentence, never a name. One is a name's ("IT Service Desk", "Plan A", "To Do"). Beta.25: the
 * function words of the language only, never a word a name may hold ("Ignore", "Related"), and
 * nothing of any organisation's, so nothing here is an org's convention.
 */
const SENTENCE_WORDS = new Set(["this", "is", "a", "to", "the", "not", "its", "it"]);

/** How many of a sentence's small words the words hold. */
const sentenceWordsIn = (words: string) =>
  words
    .trim()
    .toLowerCase()
    .split(/[\s_'’,;:!?."“”()-]+/)
    .filter((w) => SENTENCE_WORDS.has(w)).length;

/**
 * Beta.25 (review of beta.24): whether a system's name reads as a sentence: by its words only,
 * two or more of a sentence's small words ("ignore this, its cicd related"). Never by its marks:
 * a real system's name may have a comma, a full stop or a `!` in it ("Northwind, Inc.", "Harbor
 * Co."), and a profile holds what its people wrote.
 */
export function nameReadsAsSentence(name: string): boolean {
  return sentenceWordsIn(name) >= 2;
}

/**
 * Beta.25 (review of beta.24): whether words read as a sentence rather than a name: a sentence's
 * marks (a comma, a semicolon, `!`, `?`, a quote, or a full stop that ends a word: never the dots
 * of a host), or two or more of a sentence's small words ("ignore this, its cicd related"). A name
 * of any length in words ("Payments API Gateway North East") is a name, and so is one with a
 * single small word in it ("IT Service Desk", "Plan A").
 */
export function readsAsSentence(words: string): boolean {
  const n = words.trim();
  if (/[,;!?"“”]|\.(?:\s|$)/.test(n)) return true;
  return sentenceWordsIn(n) >= 2;
}

/**
 * Why words can't be a new outside system's name (beta.24 review), or undefined when they can: a
 * short name of letters, digits, spaces and dashes, at most 40 characters, that doesn't read as a
 * sentence (`readsAsSentence`). Lenient for names: "IT Service Desk", "Plan A" and a five-word
 * name are names.
 */
export function systemNameProblem(name: string): string | undefined {
  const n = name.trim();
  if (!n) return "a system's name can't be empty";
  if (n.length > SYSTEM_NAME_MAX)
    return `a system's name is at most ${SYSTEM_NAME_MAX} characters (this is ${n.length})`;
  if (!/^[A-Za-z0-9][A-Za-z0-9 -]*$/.test(n))
    return "a system's name is letters, digits, spaces and dashes only";
  if (readsAsSentence(n)) return "that reads as a sentence, not a system's name";
  return undefined;
}

/** The names Atticus knows a target by (`knownTargetNames`). */
export interface KnownTargets {
  ids: Set<string>;
  names: Set<string>;
  /**
   * Beta.25: the profiles' systems' names exactly, lower case, marks and all ("northwind, inc."),
   * of those whose name isn't a sentence by its words (`nameReadsAsSentence`).
   */
  systemNames?: Set<string>;
}

/**
 * Beta.25: the names Atticus knows a target by, as `namesKnownTarget` reads them: `ids` the ids
 * (repos, components, a system's id, alias or topic, teams) exactly, lower case; `names` those and
 * the systems' names, each also as the id it slugs to; `systemNames` the systems' names exactly.
 * Systems whose id is in `except` are left out (the boxes an answer's words made, which name
 * nothing real).
 */
export async function knownTargetNames(
  root: string,
  o: { except?: ReadonlySet<string> } = {},
): Promise<Required<KnownTargets>> {
  const { loadOrgPack } = await import("./orgpack-load.js");
  const op = await loadOrgPack(orgPackDirOf(root)).catch(() => undefined);
  const ids = new Set<string>();
  const names = new Set<string>();
  const systemNames = new Set<string>();
  const add = (n: string | undefined, isId = true) => {
    if (!n?.trim()) return;
    if (isId) ids.add(n.trim().toLowerCase());
    names.add(n.trim().toLowerCase());
    names.add(slugify(n));
  };
  for (const p of op?.profiles ?? []) {
    for (const r of p.repos?.repos ?? []) {
      add(r.id);
      add(r.component);
      for (const m of r.modules ?? []) add(m.component);
    }
    for (const s of p.profile?.systems ?? []) {
      if (o.except?.has(s.id)) continue;
      for (const n of [s.id, ...s.aliases, ...(s.topics ?? [])]) add(n);
      add(s.name, false);
      if (s.name.trim() && !nameReadsAsSentence(s.name))
        systemNames.add(s.name.trim().toLowerCase());
    }
  }
  for (const t of op?.roles?.teams ?? []) add(t.id);
  // The components the repos' facts name (a module the manifest doesn't list).
  const dir = factsDirOf(root);
  for (const f of await readdir(dir).catch(() => [] as string[])) {
    if (!/^[^.][^/]*\.jsonl$/.test(f) || /\.(corrections|reviewed|rejected)\.jsonl$/.test(f))
      continue;
    const text = await readFile(join(dir, f), "utf8").catch(() => "");
    for (const m of text.matchAll(/"component"\s*:\s*"([^"]+)"/g)) add(m[1]);
  }
  return { ids, names, systemNames };
}

/**
 * Whether words name a target of `knownTargetNames`: a profile system's name exactly, case aside
 * (beta.25: "Northwind, Inc." names the system so named, its marks and all); else case and spacing
 * aside, or by the id they slug to; words that read as a sentence only when they are an id exactly
 * (a sentence is never a system's name, even one an answer's words once wrote into a profile).
 */
export function namesKnown(known: KnownTargets, words: string) {
  const want = words.trim().toLowerCase();
  if (!want) return false;
  if (known.systemNames?.has(want)) return true;
  if (readsAsSentence(want)) return known.ids.has(want);
  return known.names.has(want) || known.names.has(slugify(words));
}

/**
 * Beta.24 review: whether words name a repo, component, system or team Atticus knows, as an
 * answer about where calls go may: a repo of the manifests (its id, component or a module's
 * component), a system of the profiles (its id, name, an alias or a topic), a team of roles.yaml,
 * or a component a repo's facts name. Case and spacing aside, or by the id the words slug to.
 * Beta.25: words that read as a sentence name only an id they are exactly, and the systems in
 * `except` (the boxes an answer's words made) are none.
 */
export async function namesKnownTarget(
  root: string,
  words: string,
  o: { except?: ReadonlySet<string> } = {},
): Promise<boolean> {
  return namesKnown(await knownTargetNames(root, o), words);
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

/**
 * Beta.24 review: the host a targets question the join raised for a host nothing resolves asks
 * about (a gateway's forwarding call whose target URL is a token, `@targetUrl@`): its words start
 * as a hosts question's do, and may go on to say what to do next (`forwardHostQuestion`). A
 * targets question asked of a call (`Which repo or system answers ...`) has none. Beta.25: the
 * host up to the first `?` that ends the question, so a token with spaces in it (`{{ vendor_url
 * }}`, as `forwardHostQuestion` writes it) is read back whole.
 */
export function joinHostOfQuestion(q: { question: string }): string | undefined {
  return /^Which repo answers on (\S(?:.*?\S)?)\?(?:\s|$)/.exec(q.question.trim())?.[1];
}

/** A host still written as a whole token: `@targetUrl@`, `{{host}}`, `${HOST}` (its name). */
const WHOLE_TOKEN = [
  /^@([A-Za-z_][A-Za-z0-9_.-]*)@$/,
  /^\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}$/,
  /^\$\{([A-Za-z_][A-Za-z0-9_.-]*)(?::[^}]*)?\}$/,
];

/**
 * The outside system an answer to a join host question adds (beta.24 review): named by the host,
 * or for a host still written as a token, by the token's name (`@targetVendorUrl@` →
 * `targetVendorUrl`), never with the token's marks in its id.
 */
export function outsideSystemOfJoinHost(host: string): { id: string; name: string } {
  for (const re of WHOLE_TOKEN) {
    const m = re.exec(host.trim());
    if (m) return { id: slugify(m[1]!), name: m[1]! };
  }
  return outsideSystemOf(host);
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
 * A line as the library may write it again with nothing changed, to tell such a line from a
 * changed one: a flow collection's padding taken out, the spaces before an inline comment as one
 * (the library writes `a # b` for `a   # b`), and no spaces at its end.
 */
const unpadded = (line: string) =>
  line
    .replace(/([[{]) +/g, "$1")
    .replace(/ +([\]}])/g, "$1")
    .replace(/[ \t]+#/g, " #")
    .replace(/[ \t]+$/, "");

/**
 * Beta.25 (review of beta.24): the one way every profile edit is written (an outside system, a
 * system a person named, a box put right), so a preview shows only the lines that really change:
 * no line folded (`lineWidth: 0`), flow collections padded as the file pads them (`[ a ]` or
 * `[a]`), and each line the edit didn't change kept exactly as the file had it (the library pads
 * a file's maps and lists alike, so a file that mixes `{ a: 1 }` with `[b]` keeps both). LF only;
 * the caller writes it in the file's own line endings.
 */
export function profileText(doc: Document, before: string | undefined): string {
  const was = before === undefined ? undefined : lfOnly(before);
  const out = doc.toString({
    lineWidth: 0,
    flowCollectionPadding: was === undefined ? true : /[[{] \S/.test(was),
  });
  if (was === undefined) return out;
  const kept = new Map<string, string>();
  for (const l of was.split("\n")) if (!kept.has(unpadded(l))) kept.set(unpadded(l), l);
  const text = out
    .split("\n")
    .map((l) => kept.get(unpadded(l)) ?? l)
    .join("\n");
  // Beta.25: the file's end as it was: a file with no newline at its end keeps none.
  return was && !was.endsWith("\n") ? text.replace(/\n+$/, "") : text;
}

/**
 * Beta.25 (review of beta.24): a profile edit Atticus doesn't make, said in a person's words (the
 * local API answers 422): the file stays as it is, for a person to change by hand.
 */
export class ProfileEditError extends Error {}

/**
 * The anchors an edit would leave aliases of with nothing to name (`*own` once its `&own` went
 * with the system that held it), in the file's order.
 */
function aliasesLeftOf(doc: Document): string[] {
  const anchors = new Set<string>();
  const left: string[] = [];
  visit(doc, (_key, node) => {
    if (isAlias(node)) {
      if (!anchors.has(node.source) && !left.includes(node.source)) left.push(node.source);
    } else if (isNode(node) && node.anchor) anchors.add(node.anchor);
  });
  return left;
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
      before === undefined
        ? `schemaVersion: 1\nplatform: ${platform}\nname: ${platform}\n`
        : lfOnly(before),
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
    await writeFileIfUnchanged(file, before, inEol(profileText(doc, before), eolOf(before ?? "")));
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
  /**
   * Beta.25: for a new system, the file, the text it was read as (undefined: none yet) and the
   * text written (or, previewed, to write), so a caller can write it with others, all or none.
   */
  write?: { file: string; before: string | undefined; after: string };
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
        await writeFileIfUnchanged(file, text, inEol(profileText(doc, text), eolOf(text!)));
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
    // Block lists stay block; every line it doesn't change stays as the file has it.
    const after = profileText(doc, before);
    const changes = changedLines(before ?? "", after);
    const write = { file, before: raw, after: inEol(after, eol) };
    if (o.preview) return { id: s.id, profile: relOf(platform), added: true, changes, write };
    await writeFileIfUnchanged(file, raw, write.after);
    return { id: s.id, profile: relOf(platform), added: true, changes, write };
  }
  throw new Error(`${repo} isn't in any repos.manifest.yaml`);
}

/**
 * Beta.24 review: take a system out of the profile that has it, or (with `rename`) give it another
 * id and name, keeping its other fields, the file's comments and its order (a comment above a
 * system taken out stays, above the next). For a system an answer's words made (a box on Map ›
 * Trust): written as a file change in the
 * metarepo, for review in the pull request. `preview` writes nothing. Undefined when no profile
 * has the system. Throws when the profile would not be valid (the new id another system has).
 */
export async function editProfileSystem(
  root: string,
  id: string,
  o: { rename?: { id: string; name: string }; preview?: boolean } = {},
): Promise<
  | {
      profile: string;
      changes: LineChange[];
      written: boolean;
      /** Beta.25: the file, the text it was read as and the text written (or to write). */
      file: string;
      before: string;
      after: string;
    }
  | undefined
> {
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
    } else {
      // Beta.25: a comment above the system (a group's heading) stays, above the next one.
      const [gone] = seq.items.splice(at, 1) as { commentBefore?: string | null }[];
      const lead = gone?.commentBefore;
      if (lead) {
        const next = seq.items[at] as { commentBefore?: string | null } | undefined;
        if (next) next.commentBefore = next.commentBefore ? `${lead}\n${next.commentBefore}` : lead;
        else seq.comment = seq.comment ? `${lead}\n${seq.comment}` : lead;
      }
    }
    // Beta.25: never an alias left naming nothing (the system held the anchor it names).
    const left = aliasesLeftOf(doc);
    if (left.length)
      throw new ProfileEditError(
        `${id} holds the YAML anchor ${left.map((a) => `&${a}`).join(", ")} in ${rel}, which other lines use (${left.map((a) => `*${a}`).join(", ")}): Atticus doesn't ${o.rename ? "rename" : "take out"} it, as they would name nothing. Write the value in place of ${left.map((a) => `*${a}`).join(", ")} by hand (or move the anchor to another line), then do this again.`,
      );
    const checked = Profile.safeParse(doc.toJS());
    if (!checked.success)
      throw new Error(
        `${rel} would not be valid: ${checked.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      );
    const after = profileText(doc, raw);
    const changes = changedLines(lfOnly(raw), after);
    const text = inEol(after, eolOf(raw));
    const out = { profile: rel, changes, file, before: raw, after: text };
    if (o.preview) return { ...out, written: false };
    await writeFileIfUnchanged(file, raw, text);
    return { ...out, written: true };
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
