import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isMap, isSeq, parseDocument, type Document, type YAMLMap } from "yaml";
import { writeFileAtomic } from "./fs.js";
import { isAdopted, orgPackDirOf } from "./metarepo.js";
import { RepoDescription, RepoManifest, WORKSPACE_SCHEMA_VERSION } from "./schema/workspace.js";

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
): Promise<{ file: ManifestFile; doc: Document; item: YAMLMap } | undefined> {
  for (const file of await manifestFiles(root)) {
    const text = await readFile(file.path, "utf8").catch(() => undefined);
    if (text === undefined) continue;
    const doc = parseDocument(text);
    const list = doc.get("repos");
    if (!isSeq(list)) continue;
    const item = list.items.find((x) => isMap(x) && x.get("id") === repo);
    if (isMap(item)) return { file, doc, item };
  }
  return undefined;
}

/** Write a document back as the manifest, after checking Atticus can still read it. */
async function save(path: string, doc: Document): Promise<void> {
  const check = RepoManifest.safeParse(doc.toJS());
  if (!check.success)
    throw new ManifestEditError(
      "invalid",
      check.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  await writeFileAtomic(path, doc.toString({ lineWidth: 0, flowCollectionPadding: true }));
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
  const { file, doc, item } = found;
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
  await save(file.path, doc);
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
  entry: {
    id: string;
    url: string;
    type: string;
    owner: string;
    /** The branch to read, when known (a clone's current branch); the manifest's default is main. */
    defaultBranch?: string;
    system?: string;
    component?: string;
    description?: RepoDescription;
  },
): Promise<ManifestFile> {
  const file = (await manifestFiles(root)).find((f) => f.platform === platform);
  if (!file)
    throw new ManifestEditError(
      "not-found",
      `The org pack has no ${platform} profile (org-pack/profiles/${platform}/repos.manifest.yaml). Run atticus repos discover, or create the profile first.`,
    );
  const text = await readFile(file.path, "utf8").catch(() => undefined);
  if (text === undefined) throw new ManifestEditError("not-found", `${file.rel} isn't there yet.`);
  const doc = parseDocument(text);
  const list = doc.get("repos");
  if (!isSeq(list))
    throw new ManifestEditError("invalid", `${file.rel} has no repos: list to add to.`);
  // Repo ids are unique across every profile (ADR 0009), so every manifest is checked.
  for (const other of await manifestFiles(root)) {
    const t = await readFile(other.path, "utf8").catch(() => undefined);
    if (t === undefined) continue;
    const repos = parseDocument(t).get("repos");
    if (isSeq(repos) && repos.items.some((x) => isMap(x) && x.get("id") === entry.id))
      throw new ManifestEditError(
        "invalid",
        `${other.rel} already lists ${entry.id}; repo ids are unique across every profile. Give another with --id.`,
      );
  }
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
  await save(file.path, doc);
  return file;
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
      await save(file.path, doc);
    }
    out.push(file.rel);
  }
  return out;
}
