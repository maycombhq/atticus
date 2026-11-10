import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isMap, isSeq, parseDocument, type Document, type YAMLMap } from "yaml";
import { writeFileIfUnchanged } from "./fs.js";
import { isAdopted, orgPackDirOf } from "./metarepo.js";
import { RepoDescription, RepoManifest, WORKSPACE_SCHEMA_VERSION } from "./schema/workspace.js";
import { Roles } from "./schema/orgpack.js";
import { migrateRolesText } from "./roles-migrate.js";

/**
 * Editing `org-pack/profiles/<platform>/repos.manifest.yaml` in place, keeping the file's
 * comments and the order a person put its entries in: a repo's description (ADR 0128), and the
 * schema-version rewrite `atticus upgrade` runs. Every write is checked against the manifest
 * schema first, so a manifest Atticus can't read is never written.
 */

/** One profile's manifest: where it is on disk and how the metarepo names it. */
export interface ManifestFile {
  path: string;
  rel: string;
  platform: string;
}

/** Every profile's manifest, by platform name. */
export async function manifestFiles(root: string): Promise<ManifestFile[]> {
  const profiles = join(orgPackDirOf(root), "profiles");
  const names = await readdir(profiles, { withFileTypes: true }).catch(() => []);
  const prefix = isAdopted(root) ? ".atticus/org-pack" : "org-pack";
  return names
    .filter((x) => x.isDirectory())
    .map((d) => d.name)
    .sort()
    .map((platform) => ({
      platform,
      path: join(profiles, platform, "repos.manifest.yaml"),
      rel: `${prefix}/profiles/${platform}/repos.manifest.yaml`,
    }));
}

export class ManifestEditError extends Error {
  constructor(
    readonly code: "not-found" | "invalid",
    message: string,
  ) {
    super(message);
  }
}

/** The manifest that lists a repo, its document and that repo's entry. */
async function entryOf(
  root: string,
  repo: string,
): Promise<{ file: ManifestFile; doc: Document; item: YAMLMap; text: string } | undefined> {
  for (const file of await manifestFiles(root)) {
    const text = await readFile(file.path, "utf8").catch(() => undefined);
    if (text === undefined) continue;
    const doc = parseDocument(text);
    const list = doc.get("repos");
    if (!isSeq(list)) continue;
    const item = list.items.find((x) => isMap(x) && x.get("id") === repo);
    if (isMap(item)) return { file, doc, item, text };
  }
  return undefined;
}

/**
 * Write a document back as the manifest, after checking Atticus can still read it, and only
 * when the file still holds `before` (what the change was made from).
 */
async function save(path: string, doc: Document, before: string): Promise<void> {
  const check = RepoManifest.safeParse(doc.toJS());
  if (!check.success)
    throw new ManifestEditError(
      "invalid",
      check.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  // In the file's own line endings (a Windows checkout's CRLF).
  await writeFileIfUnchanged(
    path,
    before,
    inEol(doc.toString({ lineWidth: 0, flowCollectionPadding: true }), eolOf(before)),
  );
}

/**
 * Set, replace or remove a repo's description in the manifest that lists it. A person's own
 * words come in as `verified`; a draft the assistant wrote comes in as `suggested` with its
 * cites, and stays marked unconfirmed until a person confirms it.
 */
export async function setManifestDescription(
  root: string,
  repo: string,
  description: RepoDescription | undefined,
): Promise<ManifestFile> {
  const found = await entryOf(root, repo);
  if (!found) throw new ManifestEditError("not-found", `There is no repo ${repo} in any manifest.`);
  const { file, doc, item, text } = found;
  if (!description) item.delete("description");
  else {
    const d = RepoDescription.parse(description);
    item.set(
      "description",
      doc.createNode({
        text: d.text,
        trust: d.trust,
        ...(d.by ? { by: d.by } : {}),
        ...(d.at ? { at: d.at } : {}),
        ...(d.cites.length ? { cites: d.cites } : {}),
      }),
    );
  }
  await save(file.path, doc, text);
  return file;
}

/**
 * Add a repo to a platform's manifest, keeping the file's comments and the order its entries
 * are in. The entry is written with the fields that are set and no more, and the whole manifest
 * is checked before it is written, so a duplicate id or a password in the URL is refused here.
 */
export async function addManifestRepo(
  root: string,
  platform: string,
  entry: NewManifestRepo,
): Promise<ManifestFile> {
  return (await addManifestRepos(root, platform, [entry])).file;
}

/** One repo to add to a manifest: the fields that are set, and no more. */
export interface NewManifestRepo {
  id: string;
  url: string;
  type: string;
  owner: string;
  /** The branch to read, when known (a clone's current branch); the manifest's default is main. */
  defaultBranch?: string;
  system?: string;
  component?: string;
  description?: RepoDescription;
}

/**
 * ADR 0190: many repos into a platform's manifest at once (the app's paste of ~40 clone URLs),
 * as addManifestRepo adds one: appended in order, comments and order kept, the file's own line
 * endings, the whole manifest checked before anything is written. An id another manifest (or
 * an earlier entry of the batch) lists is refused, naming it. With `preview`, nothing is
 * written: the lines it would change come back, for the app's diff before the write.
 */
export async function addManifestRepos(
  root: string,
  platform: string,
  entries: readonly NewManifestRepo[],
  o: { preview?: boolean } = {},
): Promise<{ file: ManifestFile; changes: LineChange[]; written: boolean }> {
  const file = (await manifestFiles(root)).find((f) => f.platform === platform);
  if (!file)
    throw new ManifestEditError(
      "not-found",
      `The org pack has no ${platform} profile (org-pack/profiles/${platform}/repos.manifest.yaml). Run atticus repos discover, or create the profile first.`,
    );
  const text = await readFile(file.path, "utf8").catch(() => undefined);
  if (text === undefined) throw new ManifestEditError("not-found", `${file.rel} isn't there yet.`);
  const doc = parseDocument(lfOnly(text));
  const list = doc.get("repos");
  if (!isSeq(list))
    throw new ManifestEditError("invalid", `${file.rel} has no repos: list to add to.`);
  // Repo ids are unique across every profile (ADR 0009), so every manifest is checked.
  const listed = new Map<string, string>();
  for (const other of await manifestFiles(root)) {
    const t = await readFile(other.path, "utf8").catch(() => undefined);
    if (t === undefined) continue;
    const repos = parseDocument(t).get("repos");
    if (!isSeq(repos)) continue;
    for (const x of repos.items) {
      const id = isMap(x) ? x.get("id") : undefined;
      if (typeof id === "string" && !listed.has(id)) listed.set(id, other.rel);
    }
  }
  for (const entry of entries) {
    const there = listed.get(entry.id);
    if (there)
      throw new ManifestEditError(
        "invalid",
        `${there} already lists ${entry.id}; repo ids are unique across every profile. Give another with --id.`,
      );
    listed.set(entry.id, file.rel);
  }
  // Round 50: the `repos: []` init writes is a flow list; the first entry turns it into a block
  // list, so each add is a few new lines and never rewrites the whole list on one line.
  if (!list.items.length && entries.length) list.flow = false;
  for (const entry of entries) {
    const d = entry.description ? RepoDescription.parse(entry.description) : undefined;
    list.add(
      doc.createNode({
        id: entry.id,
        url: entry.url,
        ...(entry.defaultBranch ? { defaultBranch: entry.defaultBranch } : {}),
        type: entry.type,
        owner: entry.owner,
        ...(entry.component ? { component: entry.component } : {}),
        ...(entry.system ? { system: entry.system } : {}),
        ...(d
          ? {
              description: {
                text: d.text,
                trust: d.trust,
                ...(d.by ? { by: d.by } : {}),
                ...(d.at ? { at: d.at } : {}),
                ...(d.cites.length ? { cites: d.cites } : {}),
              },
            }
          : {}),
      }),
    );
  }
  const check = RepoManifest.safeParse(doc.toJS());
  if (!check.success)
    throw new ManifestEditError(
      "invalid",
      check.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  // Written in the file's own style (`[a]` or `[ a ]`), so only the lines added change.
  const after = doc.toString({ lineWidth: 0, flowCollectionPadding: /[[{] \S/.test(lfOnly(text)) });
  const changes = changedLines(lfOnly(text), after);
  if (o.preview || !entries.length) return { file, changes, written: false };
  // In the file's own line endings (a Windows checkout's CRLF), onto the file as read.
  await writeFileIfUnchanged(file.path, text, inEol(after, eolOf(text)));
  return { file, changes, written: true };
}

/**
 * F5: move a repo's id in the manifest that lists it, in place (comments and order kept). Refused
 * when no manifest lists the repo, or any lists the new id already (ids are unique across every
 * profile, ADR 0009). Only the id changes; the files filed under it are the caller's to move.
 */
export async function renameManifestRepo(
  root: string,
  repo: string,
  to: string,
): Promise<ManifestFile> {
  for (const other of await manifestFiles(root)) {
    const t = await readFile(other.path, "utf8").catch(() => undefined);
    if (t === undefined) continue;
    const repos = parseDocument(t).get("repos");
    if (isSeq(repos) && repos.items.some((x) => isMap(x) && x.get("id") === to))
      throw new ManifestEditError(
        "invalid",
        `${to} is already listed in ${other.rel}; repo ids are unique across every profile.`,
      );
  }
  const found = await entryOf(root, repo);
  if (!found) throw new ManifestEditError("not-found", `There is no repo ${repo} in any manifest.`);
  found.item.set("id", to);
  await save(found.file.path, found.doc, found.text);
  return found.file;
}

/**
 * Rewrite every manifest at a version below `to` (the current one when left out) at that
 * version, keeping its comments and order (ADR 0009, 0128, 0134). Nothing a person wrote
 * changes: older manifests are read as they are and stay valid, and this only keeps diffs clean.
 * `dryRun` lists what it would change.
 */
export async function migrateManifests(
  root: string,
  o: { dryRun?: boolean; to?: number } = {},
): Promise<string[]> {
  const to = o.to ?? WORKSPACE_SCHEMA_VERSION;
  const out: string[] = [];
  for (const file of await manifestFiles(root)) {
    const text = await readFile(file.path, "utf8").catch(() => undefined);
    if (text === undefined) continue;
    const doc = parseDocument(text);
    const have = doc.get("schemaVersion");
    if (typeof have !== "number" || have >= to) continue;
    if (!RepoManifest.safeParse(doc.toJS()).success) continue;
    if (!o.dryRun) {
      doc.set("schemaVersion", to);
      await save(file.path, doc, text);
    }
    out.push(file.rel);
  }
  return out;
}

/** A file's line ending, its text with LF only, and the text back in its own endings. */
export const eolOf = (raw: string): "\r\n" | "\n" => (raw.includes("\r\n") ? "\r\n" : "\n");
export const lfOnly = (raw: string) => raw.replace(/\r\n/g, "\n");
export const inEol = (text: string, eol: "\r\n" | "\n") =>
  eol === "\n" ? text : text.replace(/\r?\n/g, eol);

/** A line the edit changes: what it was (none when added) and what it is now. */
export interface LineChange {
  was?: string;
  now?: string;
}

/**
 * The lines two texts differ in, in order: a line diff (longest common subsequence), each run of
 * removed and added lines paired up as was and now. For a preview of a file's change.
 */
export function changedLines(before: string, after: string): LineChange[] {
  const a = before.split("\n");
  const b = after.split("\n");
  // Trim what is the same at both ends, then diff what is left.
  let s0 = 0;
  while (s0 < a.length && s0 < b.length && a[s0] === b[s0]) s0++;
  let ea = a.length;
  let eb = b.length;
  while (ea > s0 && eb > s0 && a[ea - 1] === b[eb - 1]) {
    ea--;
    eb--;
  }
  const x = a.slice(s0, ea);
  const y = b.slice(s0, eb);
  const n = x.length;
  const m = y.length;
  // Past a million cells the table costs too much: the changed block, line against line.
  if (n * m > 1_000_000) {
    const rows = Math.max(n, m);
    const shown = Math.min(rows, 200);
    return [
      ...Array.from({ length: shown }, (_, k) => ({
        ...(k < n ? { was: x[k]! } : {}),
        ...(k < m ? { now: y[k]! } : {}),
      })),
      ...(rows > shown ? [{ now: `(${rows - shown} more changed lines not shown)` }] : []),
    ];
  }
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i]![j] =
        x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: LineChange[] = [];
  let was: string[] = [];
  let now: string[] = [];
  const flush = () => {
    for (let k = 0; k < Math.max(was.length, now.length); k++)
      out.push({
        ...(was[k] !== undefined ? { was: was[k] } : {}),
        ...(now[k] !== undefined ? { now: now[k] } : {}),
      });
    was = [];
    now = [];
  };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) {
      flush();
      i++;
      j++;
    } else if (j < m && (i >= n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) now.push(y[j++]!);
    else was.push(x[i++]!);
  }
  flush();
  return out;
}

/**
 * G2 (ADR 0174): set a repo's `owner` or `system` in the manifest that lists it, keeping the
 * file's comments and order; checked before it is written. With `preview`, nothing is written:
 * the lines it would change come back.
 */
export async function setManifestField(
  root: string,
  repo: string,
  /** ADR 0190: `type` too, from the app's Detect the type (atticus repo-type detect). */
  field: "owner" | "system" | "type",
  value: string,
  o: { preview?: boolean } = {},
): Promise<{ file: ManifestFile; changes: LineChange[]; written: boolean }> {
  const found = await entryOf(root, repo);
  if (!found) throw new ManifestEditError("not-found", `There is no repo ${repo} in any manifest.`);
  const { file, doc, item, text: raw } = found;
  // The preview is of the file as it is on disk, so a write that reformats it shows that too.
  // Compared and written with the file's own line endings (a Windows checkout's CRLF).
  const eol = eolOf(raw);
  const before = lfOnly(raw);
  item.set(field, value);
  // Written in the file's own style (`[a]` or `[ a ]`), so only the line set changes.
  const after = doc.toString({ lineWidth: 0, flowCollectionPadding: /\[ \S/.test(before) });
  const changes = changedLines(before, after);
  const check = RepoManifest.safeParse(doc.toJS());
  if (!check.success)
    throw new ManifestEditError(
      "invalid",
      check.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  if (o.preview || !changes.length) return { file, changes, written: false };
  await writeFileIfUnchanged(file.path, raw, inEol(after, eol));
  return { file, changes, written: true };
}

/**
 * G2 (ADR 0174): add a team to roles.yaml (moved to version 2 first when it is older), for
 * review: its id and name, no people. With `preview`, nothing is written.
 */
export async function addRolesTeam(
  root: string,
  team: { id: string; name: string },
  o: { preview?: boolean } = {},
): Promise<{ rel: string; changes: LineChange[]; written: boolean }> {
  const path = join(orgPackDirOf(root), "roles.yaml");
  const rel = `${isAdopted(root) ? ".atticus/org-pack" : "org-pack"}/roles.yaml`;
  const onDisk = await readFile(path, "utf8").catch(() => undefined);
  const raw = onDisk ?? "schemaVersion: 2\nteams: []\n";
  const eol = eolOf(raw);
  const text = lfOnly(raw);
  const migrated = migrateRolesText(text).text;
  const doc = parseDocument(migrated);
  let teams = doc.get("teams");
  if (!isSeq(teams)) {
    doc.set("teams", doc.createNode([]));
    teams = doc.get("teams");
  }
  if (!isSeq(teams)) throw new ManifestEditError("invalid", `${rel} has no teams: list.`);
  if (teams.items.some((x) => isMap(x) && x.get("id") === team.id))
    throw new ManifestEditError("invalid", `${rel} already has a team ${team.id}.`);
  if (!teams.items.length) teams.flow = false;
  teams.add(doc.createNode({ id: team.id, name: team.name }));
  const after = doc.toString({ lineWidth: 0, flowCollectionPadding: true });
  const check = Roles.safeParse(doc.toJS());
  if (!check.success)
    throw new ManifestEditError(
      "invalid",
      check.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  const changes = changedLines(text, after);
  if (o.preview) return { rel, changes, written: false };
  await writeFileIfUnchanged(path, onDisk, inEol(after, eol));
  return { rel, changes, written: true };
}
