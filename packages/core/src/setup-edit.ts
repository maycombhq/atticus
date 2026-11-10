import { createHash } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import {
  isMap,
  isNode,
  isScalar,
  isSeq,
  parseDocument,
  stringify,
  type Document,
  type YAMLMap,
} from "yaml";
import type { z } from "zod";
import { writeFileIfUnchanged } from "./fs.js";
import {
  changedLines,
  eolOf,
  inEol,
  lfOnly,
  manifestFiles,
  type LineChange,
} from "./manifest-edit.js";
import { isAdopted, orgPackDirOf } from "./metarepo.js";
import { AgentDefinition } from "./schema/ai.js";
import { Conventions } from "./schema/conventions.js";
import {
  ChangeTypes,
  Gates,
  IntegrationPattern,
  PackManifest,
  Procedure,
  Profile,
  Roles,
  Runtime,
  ServiceRequestTemplate,
  Sources,
  TestStrategy,
} from "./schema/orgpack.js";
import { RepoType } from "./schema/repo-type.js";
import { ChecklistPack } from "./schema/review.js";
import { RepoManifest } from "./schema/workspace.js";

/**
 * ADR 0190: settings and setup are done in the app, "Edit, then Propose". Each edit writes one
 * file of the org pack through its schema, keeping the file's comments, order and line endings,
 * and shows the lines it changes before it writes (`preview`); Propose for review then opens the
 * PR. Nothing here reaches a shared system, and no edit takes a secret: a setting whose name
 * looks like one is refused by the runtime.yaml schema itself.
 */

/** runtime.yaml's outside systems the app sets up, in the order the Adapters panel shows them. */
export const ADAPTER_KINDS = [
  "gitHost",
  "workTracker",
  "serviceDesk",
  "notify",
  "wiki",
  "design",
] as const;
export type AdapterKind = (typeof ADAPTER_KINDS)[number];

/** An adapter entry as the schema builds it: the type alone, or `{ type, settings }`. */
type AdapterEntrySchema = {
  unwrap(): { options: { shape?: { type: { options: readonly string[] } } }[] };
};

/** The types runtime.yaml's schema takes for one kind, read from the schema itself. */
function schemaTypes(kind: AdapterKind): readonly string[] {
  const adapters = (
    Runtime.shape.adapters as unknown as {
      unwrap(): { shape: Record<string, AdapterEntrySchema> };
    }
  ).unwrap();
  return adapters.shape[kind]?.unwrap().options.find((o) => o.shape)?.shape?.type.options ?? [];
}

/**
 * The types runtime.yaml's schema takes for each, read from it so the two never drift (manual
 * first: a person does the step and records the result, ADR 0032). `mock` is for tests and isn't
 * offered; a file that has it shows it.
 */
export const ADAPTER_TYPES = Object.fromEntries(
  ADAPTER_KINDS.map((k) => [
    k,
    ["manual", ...schemaTypes(k).filter((t) => t !== "manual" && t !== "mock")],
  ]),
) as unknown as Record<AdapterKind, readonly string[]>;

/**
 * The settings Atticus itself reads for each kind (the manual adapters and the steps that name a
 * repo on the Git host), each a value or a list. A live adapter's plugin may read more: those
 * are written as further settings, checked by the same schema (never a secret's value).
 */
export const ADAPTER_FIELDS: Record<AdapterKind, readonly { name: string; list?: boolean }[]> = {
  gitHost: [
    { name: "metarepo" },
    { name: "protectedBranches", list: true },
    { name: "defaultBranch" },
  ],
  workTracker: [{ name: "project" }, { name: "idPattern" }],
  serviceDesk: [{ name: "numberPattern" }],
  notify: [],
  wiki: [{ name: "exportDir" }],
  design: [{ name: "exportDir" }],
};

export class SetupEditError extends Error {
  constructor(
    readonly code: "invalid" | "not-found" | "exists",
    message: string,
  ) {
    super(message);
  }
}

/** What an edit changed (or would change, with preview), file by file name. */
export interface FileEdit {
  /** The file, relative to the metarepo ("/"-separated). */
  path: string;
  changes: LineChange[];
  written: boolean;
}

const issues = (e: z.ZodError) =>
  e.issues.map((i) => `${i.path.join(".") || "the file"}: ${i.message}`).join("; ");

const packRel = (root: string, rel: string) =>
  `${isAdopted(root) ? ".atticus/org-pack" : "org-pack"}/${rel}`;

/** A YAML document, refused when it doesn't parse. */
function yamlDoc(text: string, where: string): Document {
  const doc = parseDocument(lfOnly(text));
  if (doc.errors.length)
    throw new SetupEditError("invalid", `${where} isn't YAML: ${doc.errors[0]!.message}`);
  return doc;
}

/**
 * Write an edited document back onto the file as it was read (another window's edit meanwhile
 * is FileChangedError), in its own line endings, unless only previewing.
 */
async function finish(
  root: string,
  rel: string,
  before: string | undefined,
  after: string,
  preview: boolean | undefined,
): Promise<FileEdit> {
  const path = packRel(root, rel);
  const changes = changedLines(lfOnly(before ?? ""), after);
  if (preview || (before !== undefined && !changes.length))
    return { path, changes, written: false };
  const file = join(orgPackDirOf(root), ...rel.split("/"));
  await mkdir(dirname(file), { recursive: true });
  await writeFileIfUnchanged(file, before, inEol(after, eolOf(before ?? "")));
  return { path, changes, written: true };
}

/** An adapter as the app sends it: its type and settings, or null to take it out. */
export interface AdapterValue {
  type: string;
  settings?: Record<string, string | number | boolean | string[]>;
}

/** The flow style a file uses (`[a]` or `[ a ]`), so a write keeps it and changes only its lines. */
export const flowPaddingOf = (text: string) => /[[{] \S/.test(text);

/** Two values as YAML reads them, the same (a setting the form sends back unchanged). */
const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Set (or with null, take out) one outside system in runtime.yaml: `adapters.<kind>`, written as
 * the type alone when it has no settings (`gitHost: manual`). The entry is edited in place: a
 * setting sent as it is stays as it is (its comments, its style), one changed is that line, one
 * left out is taken out. The whole file is checked with the Runtime schema first, so a type it
 * doesn't take, or a setting named like a secret, is refused. With `baseSha256` (the file's
 * sha256 as the form read it), a file changed since is refused (`exists`), never overwritten.
 */
export async function setRuntimeAdapter(
  root: string,
  kind: AdapterKind,
  value: AdapterValue | null,
  o: { preview?: boolean; baseSha256?: string } = {},
): Promise<FileEdit> {
  if (!(ADAPTER_KINDS as readonly string[]).includes(kind))
    throw new SetupEditError("invalid", `${kind} isn't an outside system runtime.yaml names.`);
  const file = join(orgPackDirOf(root), "runtime.yaml");
  const before = await readFile(file, "utf8").catch(() => undefined);
  if (before === undefined)
    throw new SetupEditError(
      "not-found",
      `${packRel(root, "runtime.yaml")} isn't there: create the metarepo first (atticus init).`,
    );
  if (o.baseSha256 !== undefined && sha256Of(before) !== o.baseSha256)
    throw new SetupEditError(
      "exists",
      `${packRel(root, "runtime.yaml")} changed since this form read it (another window, the raw editor or the CLI): read it again, then make the edit.`,
    );
  const doc = yamlDoc(before, "runtime.yaml");
  if (!isMap(doc.contents)) throw new SetupEditError("invalid", "runtime.yaml isn't a map.");
  let adapters = doc.get("adapters");
  if (!isMap(adapters)) {
    doc.set("adapters", doc.createNode({}));
    adapters = doc.get("adapters");
  }
  const map = adapters as YAMLMap;
  if (value === null) map.delete(kind);
  else {
    const settings = Object.fromEntries(
      Object.entries(value.settings ?? {}).filter(
        ([k, v]) => k.trim() && v !== "" && !(Array.isArray(v) && !v.length),
      ),
    );
    // The `adapters: {}` init writes is a flow map: the first entry turns it into a block map.
    if (!map.items.length) map.flow = false;
    const entry = map.get(kind, true);
    const had = isMap(entry) ? entry.get("settings", true) : undefined;
    if (!Object.keys(settings).length) map.set(kind, value.type);
    else if (isMap(entry)) {
      // In place: the entry's and each setting's comments and style kept.
      if (entry.get("type") !== value.type) entry.set("type", value.type);
      if (isMap(had)) {
        for (const pair of [...had.items]) {
          const k = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
          if (!(k in settings)) had.delete(pair.key);
        }
        for (const [k, v] of Object.entries(settings)) {
          const now = had.get(k, true);
          if (now !== undefined && sameValue(isNode(now) ? now.toJS(doc) : now, v)) continue;
          if (isScalar(now) && !Array.isArray(v)) now.value = v;
          else had.set(k, doc.createNode(v, { flow: isSeq(now) && now.flow === true }));
        }
      } else entry.set("settings", doc.createNode(settings, { flow: false }));
    } else map.set(kind, doc.createNode({ type: value.type, settings }, { flow: false }));
  }
  const check = Runtime.safeParse(doc.toJS());
  if (!check.success) throw new SetupEditError("invalid", `runtime.yaml: ${issues(check.error)}`);
  return finish(
    root,
    "runtime.yaml",
    before,
    doc.toString({ lineWidth: 0, flowCollectionPadding: flowPaddingOf(lfOnly(before)) }),
    o.preview,
  );
}

/** The schema an org-pack file is read with, by its path in the org pack; none for other files. */
const SINGLE_FILES: Record<string, z.ZodTypeAny> = {
  "runtime.yaml": Runtime,
  "sources.yaml": Sources,
  "gates.yaml": Gates,
  "change-types.yaml": ChangeTypes,
  "test-strategy.yaml": TestStrategy,
  "pack.yaml": PackManifest,
  "roles.yaml": Roles,
  "conventions.yaml": Conventions,
};
/** Files by their place in the org pack: `*` is a name a person gives (a profile, a pattern). */
const MANY_FILES: [string, RegExp, z.ZodTypeAny][] = [
  ["patterns/*.yaml", /^patterns\/[^/]+\.ya?ml$/i, IntegrationPattern],
  ["profiles/*/repos.manifest.yaml", /^profiles\/[^/]+\/repos\.manifest\.yaml$/i, RepoManifest],
  ["profiles/*/profile.yaml", /^profiles\/[^/]+\/profile\.yaml$/i, Profile],
  ["process/procedures/*.yaml", /^process\/procedures\/[^/]+\.ya?ml$/i, Procedure],
  ["process/snow/*.yaml", /^process\/snow\/[^/]+\.ya?ml$/i, ServiceRequestTemplate],
  ["checklists/*.yaml", /^checklists\/[^/]+\.ya?ml$/i, ChecklistPack],
  ["agents/*.yaml", /^agents\/[^/]+\.ya?ml$/i, AgentDefinition],
  ["repo-types/*/type.yaml", /^repo-types\/[^/]+\/type\.yaml$/i, RepoType],
];

/**
 * The schema an org-pack file is read with, by its path in the org pack; none for other files.
 * Matched in any case: on a disk that doesn't tell case apart (Windows, macOS) `Runtime.yaml` is
 * runtime.yaml, and is checked as it.
 */
export function orgPackFileSchema(rel: string): z.ZodTypeAny | undefined {
  const r = rel.split("\\").join("/");
  return SINGLE_FILES[r.toLowerCase()] ?? MANY_FILES.find(([, re]) => re.test(r))?.[2];
}

/**
 * The name a path has in the org pack when it is one of the files Atticus reads but written in
 * another case (`Runtime.yaml` for runtime.yaml), so it is refused, naming the right one.
 */
function canonicalName(r: string): string | undefined {
  const low = r.toLowerCase();
  if (SINGLE_FILES[low]) return low === r ? undefined : low;
  const many = MANY_FILES.find(([, re]) => re.test(r));
  if (!many) return undefined;
  // The parts of the place that are fixed (folders, file names, the extension), as written.
  const want = many[0].split("/");
  const name = r
    .split("/")
    .map((p, k) =>
      want[k] === "*"
        ? p
        : want[k] === "*.yaml"
          ? p.replace(/\.ya?ml$/i, (e) => e.toLowerCase())
          : p.toLowerCase(),
    )
    .join("/");
  return name === r ? undefined : name;
}

/** A path in the org pack the raw editor may open: relative, inside it, a text file. */
export function orgPackFileRel(rel: string): string {
  const r = rel.trim().split("\\").join("/").replace(/^\.\//, "");
  if (
    !r ||
    isAbsolute(r) ||
    /^[a-z]:/i.test(r) ||
    normalize(r).split(sep).includes("..") ||
    r.split("/").some((p) => p === ".." || p === "" || p.startsWith(".")) ||
    !/\.(ya?ml|md|txt|json)$/i.test(r)
  )
    throw new SetupEditError(
      "invalid",
      `${rel} isn't a file of the org pack the app edits: a path inside org-pack/ ending .yaml, .md, .txt or .json.`,
    );
  const named = canonicalName(r);
  if (named)
    throw new SetupEditError(
      "invalid",
      `${r} is ${named} in another case: open ${named}, the name Atticus reads.`,
    );
  return r;
}

/**
 * A path whose folders or file are there already in another case (`profiles/Forge/` for
 * `profiles/forge/`) is refused, naming them as they are: on a disk that doesn't tell case apart
 * it would be the same file under a name Atticus doesn't read.
 */
async function sameCaseOnDisk(root: string, r: string): Promise<void> {
  let dir = orgPackDirOf(root);
  const asIs: string[] = [];
  for (const part of r.split("/")) {
    const names = await readdir(dir).catch(() => [] as string[]);
    if (!names.includes(part)) {
      const other = names.find((n) => n.toLowerCase() === part.toLowerCase());
      if (other) {
        const there = [...asIs, other].join("/");
        throw new SetupEditError(
          "invalid",
          `${r}: the org pack has ${there} in another case. Open the file under that name.`,
        );
      }
    }
    asIs.push(part);
    dir = join(dir, part);
  }
}

/**
 * Repo ids are unique across every profile (ADR 0009): a manifest written in the raw editor that
 * lists an id another profile lists is refused, naming it, as adding repos refuses it.
 */
async function idsUniqueAcrossProfiles(root: string, r: string, content: string): Promise<void> {
  if (orgPackFileSchema(r) !== RepoManifest) return;
  const mine = r.split("/")[1]!;
  const repos = parseDocument(lfOnly(content)).get("repos");
  const ids = isSeq(repos)
    ? repos.items
        .map((x) => (isMap(x) ? x.get("id") : undefined))
        .filter((x) => typeof x === "string")
    : [];
  const listed = new Map<string, string>();
  for (const other of await manifestFiles(root)) {
    if (other.platform === mine) continue;
    const t = await readFile(other.path, "utf8").catch(() => undefined);
    if (t === undefined) continue;
    const list = parseDocument(lfOnly(t)).get("repos");
    if (!isSeq(list)) continue;
    for (const x of list.items) {
      const id = isMap(x) ? x.get("id") : undefined;
      if (typeof id === "string" && !listed.has(id)) listed.set(id, other.rel);
    }
  }
  for (const id of ids) {
    const there = listed.get(id as string);
    if (there)
      throw new SetupEditError(
        "invalid",
        `${there} already lists ${String(id)}; repo ids are unique across every profile. Give it another id.`,
      );
  }
}

export const sha256Of = (text: string) => createHash("sha256").update(text).digest("hex");

/** An org-pack file as the raw editor shows it, with the schema it is checked with. */
export async function readOrgPackFile(
  root: string,
  rel: string,
): Promise<{
  path: string;
  rel: string;
  content: string;
  sha256: string;
  exists: boolean;
  checked: boolean;
}> {
  const r = orgPackFileRel(rel);
  await sameCaseOnDisk(root, r);
  const content = await readFile(join(orgPackDirOf(root), ...r.split("/")), "utf8").catch(
    () => undefined,
  );
  return {
    path: packRel(root, r),
    rel: r,
    content: content ?? "",
    sha256: sha256Of(content ?? ""),
    exists: content !== undefined,
    checked: orgPackFileSchema(r) !== undefined,
  };
}

/** The problems Atticus would have reading this text as that org-pack file (empty when none). */
export function orgPackFileProblems(rel: string, content: string): string[] {
  const r = orgPackFileRel(rel);
  if (!/\.ya?ml$/i.test(r)) return [];
  const doc = parseDocument(lfOnly(content));
  if (doc.errors.length) return doc.errors.map((e) => `${r} isn't YAML: ${e.message}`);
  const schema = orgPackFileSchema(r);
  if (!schema) return [];
  const check = schema.safeParse(doc.toJS());
  return check.success ? [] : [`${r}: ${issues(check.error)}`];
}

/**
 * The raw editor's write (the fallback for anything without a form): the file's whole text,
 * checked with its schema, written onto the file as the person opened it (`baseSha256`, from
 * readOrgPackFile; an edit meanwhile is refused), in the file's own line endings.
 */
export async function writeOrgPackFile(
  root: string,
  rel: string,
  content: string,
  o: { baseSha256: string; preview?: boolean },
): Promise<FileEdit> {
  const r = orgPackFileRel(rel);
  const problems = orgPackFileProblems(r, content);
  if (problems.length) throw new SetupEditError("invalid", problems.join("; "));
  await sameCaseOnDisk(root, r);
  await idsUniqueAcrossProfiles(root, r, content);
  const before = await readFile(join(orgPackDirOf(root), ...r.split("/")), "utf8").catch(
    () => undefined,
  );
  if (sha256Of(before ?? "") !== o.baseSha256)
    throw new SetupEditError(
      "exists",
      `${packRel(root, r)} changed since it was opened: open it again, then make the edit.`,
    );
  return finish(root, r, before, lfOnly(content), o.preview);
}

/** An integration pattern as the app's form gives it (patterns/<code>.yaml). */
export interface PatternInput {
  code: string;
  name: string;
  definition: string;
  interaction: string;
  route: string;
  targetType: string;
  controls?: string[];
  source: string;
  version?: string;
  status?: string;
}

/**
 * A new integration pattern from the form, as its own file `patterns/<code>.yaml` (the shape the
 * starter pack's patterns have), checked with the pattern schema. A code already there is refused:
 * an existing pattern is edited in the raw editor.
 */
export async function addPattern(
  root: string,
  p: PatternInput,
  o: { preview?: boolean } = {},
): Promise<FileEdit> {
  const data = {
    schemaVersion: 1,
    code: p.code.trim(),
    name: p.name.trim(),
    definition: p.definition.trim(),
    interaction: p.interaction,
    route: p.route,
    targetType: p.targetType,
    controls: (p.controls ?? []).map((c) => c.trim()).filter(Boolean),
    source: p.source.trim(),
    version: p.version?.trim() || "1.0.0",
    status: p.status ?? "to-review",
  };
  const check = IntegrationPattern.safeParse(data);
  if (!check.success) throw new SetupEditError("invalid", `The pattern: ${issues(check.error)}`);
  const rel = `patterns/${data.code}.yaml`;
  const there = await readFile(join(orgPackDirOf(root), "patterns", `${data.code}.yaml`), "utf8")
    .then(() => true)
    .catch(() => false);
  if (there)
    throw new SetupEditError(
      "exists",
      `${packRel(root, rel)} is there already: edit it in the raw editor instead.`,
    );
  return finish(root, rel, undefined, stringify(data, { lineWidth: 0 }), o.preview);
}
