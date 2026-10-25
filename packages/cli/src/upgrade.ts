import { cp, mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { CHECKLISTS_README, STARTER_CHECKLISTS_README } from "@maycombhq/adopt";
import { readPackFiles, STARTER_REVIEW_PATH, starterReviewText } from "@maycombhq/naysayer";
import { metarepoOrigin } from "@maycombhq/changes";
import {
  readStoreMarker,
  STORE_MARKER,
  storeIdOf,
  writeStoreMarker,
} from "@maycombhq/openspec-adapter";
import {
  catalogDirOf,
  ensureLocalIgnore,
  isAdopted,
  layoutOf,
  loadOrgPack,
  LOCAL_ONLY,
  MetarepoStamp,
  migrateCatalog,
  migrateChangeTypesText,
  migrateGatesText,
  migrateQuestions,
  migrateSourcesText,
  orgPackDirOf,
  specsDirOf,
  specsRelOf,
  WORKSPACE_SCHEMA_VERSION,
  writeFileAtomic,
} from "@maycombhq/core";
import { ensureGitignore, gitUser, IGNORED } from "@maycombhq/workspace";
import type { Output } from "./commands.js";
import { VERSION, versionAtLeast } from "./version.js";

/**
 * `atticus upgrade` (ADR 0051): bring a metarepo's files up to what this Atticus writes, after
 * installing a new version. Readers accept older files anyway; upgrading once keeps diffs clean
 * and records which Atticus did it in `.atticus/metarepo.yaml`. Every file a migration would
 * change is copied to `.atticus/backups/<time>/` first, and an older Atticus refuses a metarepo
 * a newer one upgraded. Nothing is committed: the person reviews the changes in a pull request.
 */

export const STAMP_FILE = join(".atticus", "metarepo.yaml");

export interface Migration {
  id: string;
  summary: string;
  /** Files (relative to the root, "/"-separated) it would change; none means nothing to do. */
  pending(root: string): Promise<string[]>;
  apply(root: string): Promise<string[]>;
}

const rel = (prefix: string, files: string[]) => files.map((f) => `${prefix}/${f}`);

/** The migrations this Atticus knows, oldest first. Add new ones at the end. */
export const MIGRATIONS: Migration[] = [
  // The version-1 files; each is written at the current version (ADR 0031, 0125).
  catalogStep("catalog-schema-v2", "Catalog records at schema version 2 (ADR 0031)", [1]),
  {
    id: "local-files-ignored",
    summary: "This machine's files kept out of Git (.atticus/.gitignore, ADR 0050)",
    async pending(root) {
      const text = await readFile(join(root, ".atticus", ".gitignore"), "utf8").catch(() => "");
      const have = new Set(text.split(/\r?\n/).map((l) => l.trim()));
      return LOCAL_ONLY.every((l) => have.has(l)) ? [] : [".atticus/.gitignore"];
    },
    async apply(root) {
      await ensureLocalIgnore(root);
      return [".atticus/.gitignore"];
    },
  },
  {
    id: "state-folders-ignored",
    summary: "Base clones, the index and run folders kept out of Git (metarepo .gitignore)",
    async pending(root) {
      // An adopted repo's own .gitignore is the team's: Atticus never edits it.
      if (isAdopted(root)) return [];
      const text = await readFile(join(root, ".gitignore"), "utf8").catch(() => "");
      const norm = (l: string) => l.trim().replace(/^\//, "").replace(/\/$/, "");
      const have = new Set(text.split(/\r?\n/).map(norm));
      return IGNORED.every((p) => have.has(norm(p))) ? [] : [".gitignore"];
    },
    async apply(root) {
      return (await ensureGitignore(root)).length ? [".gitignore"] : [];
    },
  },
  {
    id: "gates-v2",
    summary:
      "gates.yaml at version 2: each gate's critic round limit written out, so leaving it out means no limit (ADR 0087)",
    async pending(root) {
      const rel = gatesRel(root);
      const text = await readFile(join(root, rel), "utf8").catch(() => undefined);
      return text !== undefined && migrateGatesText(text).changed ? [rel] : [];
    },
    async apply(root) {
      const rel = gatesRel(root);
      const text = await readFile(join(root, rel), "utf8").catch(() => undefined);
      if (text === undefined) return [];
      const r = migrateGatesText(text);
      if (!r.changed) return [];
      await writeFileAtomic(join(root, rel), r.text);
      return [rel];
    },
  },
  {
    id: "flow-schema-v2",
    summary:
      "Spec flows at schema version 2: loops and retries can say which steps they repeat (ADR 0095)",
    async pending(root) {
      const r = await migrateCatalog(specsDirOf(root), { dryRun: true });
      return rel(specsRelOf(root), r.migrated);
    },
    async apply(root) {
      const r = await migrateCatalog(specsDirOf(root));
      return rel(specsRelOf(root), r.migrated);
    },
  },
  {
    id: "change-types-v2",
    summary:
      "change-types.yaml at version 2: a type can be small and take the fast path; every type stays standard until a person marks it (ADR 0113)",
    async pending(root) {
      const rel = packRel(root, "change-types.yaml");
      const text = await readFile(join(root, rel), "utf8").catch(() => undefined);
      return text !== undefined && migrateChangeTypesText(text).changed ? [rel] : [];
    },
    async apply(root) {
      const rel = packRel(root, "change-types.yaml");
      const text = await readFile(join(root, rel), "utf8").catch(() => undefined);
      if (text === undefined) return [];
      const r = migrateChangeTypesText(text);
      if (!r.changed) return [];
      await writeFileAtomic(join(root, rel), r.text);
      return [rel];
    },
  },
  {
    id: "questions-v2",
    summary:
      "Questions at schema version 2: a question can name the earlier one it may be the same as (ADR 0117)",
    pending: (root) => migrateQuestions(root, { dryRun: true }),
    apply: (root) => migrateQuestions(root),
  },
  {
    id: "starter-review",
    summary:
      "The starter review: AI rules for the critic's lenses in checklists/review.yaml, for an org pack with no AI review of its own (ADR 0120)",
    async pending(root) {
      return (await starterReviewPlan(root)).map((f) => f.rel);
    },
    async apply(root) {
      const out: string[] = [];
      for (const f of await starterReviewPlan(root)) {
        await writeFileAtomic(join(root, ...f.rel.split("/")), f.text);
        out.push(f.rel);
      }
      return out;
    },
  },
  // The version-2 files: only the number changes, no field gains a required (ADR 0125).
  catalogStep(
    "catalog-schema-v3",
    "Catalog records at schema version 3: a Schema field can say whether it is required (ADR 0125)",
    [2],
  ),
  {
    id: "sources-v2",
    summary:
      "sources.yaml at version 2: a wiki can include and exclude pages by pattern; every wiki still reads every page (ADR 0083)",
    async pending(root) {
      const rel = packRel(root, "sources.yaml");
      const text = await readFile(join(root, rel), "utf8").catch(() => undefined);
      return text !== undefined && migrateSourcesText(text).changed ? [rel] : [];
    },
    async apply(root) {
      const rel = packRel(root, "sources.yaml");
      const text = await readFile(join(root, rel), "utf8").catch(() => undefined);
      if (text === undefined) return [];
      const r = migrateSourcesText(text);
      if (!r.changed) return [];
      await writeFileAtomic(join(root, rel), r.text);
      return [rel];
    },
  },
];

/**
 * A step that rewrites the catalog's record files (generated and curated) at some older schema
 * versions, in canonical form at the current version. Each version has its own step, so a file
 * is listed under one step only.
 */
function catalogStep(id: string, summary: string, versions: readonly number[]): Migration {
  const run = async (root: string, dryRun: boolean) => {
    const out: string[] = [];
    for (const sub of ["generated", "curated"]) {
      const r = await migrateCatalog(join(catalogDirOf(root), sub), { dryRun, versions });
      out.push(...rel(`catalog/${sub}`, r.migrated));
    }
    return out;
  };
  return { id, summary, pending: (root) => run(root, true), apply: (root) => run(root, false) };
}

/**
 * What adding the starter review (ADR 0120) would write: review.yaml, and the checklists README
 * when it is still the one Atticus wrote (or missing), so every clone can tell the review was
 * added. Nothing when the org pack has a review.yaml or a pack named review, when any of its
 * checklists has an AI rule (the org wrote its own review), when this metarepo's stamp says the
 * step ran, or when the README names the starter review (it was there and the org deleted it).
 */
async function starterReviewPlan(root: string): Promise<{ rel: string; text: string }[]> {
  if ((await readStamp(root))?.migrations.includes("starter-review")) return [];
  const dirRel = packRel(root, "checklists");
  const reviewRel = packRel(root, STARTER_REVIEW_PATH);
  if (await exists(join(root, ...reviewRel.split("/")))) return [];
  const { packs } = await readPackFiles(root, join(root, ...dirRel.split("/")));
  if (
    packs.some((p) => p.pack.name === "review" || p.pack.rules.some((r) => r.check.type === "ai"))
  )
    return [];
  const readmeRel = `${dirRel}/README.md`;
  const readme = await readFile(join(root, ...readmeRel.split("/")), "utf8").catch(() => undefined);
  const norm = (t: string) => t.replace(/\r\n/g, "\n");
  if (readme !== undefined && norm(readme).includes("starter review")) return [];
  const out = [{ rel: reviewRel, text: await starterReviewText() }];
  if (readme === undefined || norm(readme) === CHECKLISTS_README)
    out.unshift({ rel: readmeRel, text: STARTER_CHECKLISTS_README });
  return out;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

function packRel(root: string, file: string): string {
  return `${isAdopted(root) ? ".atticus/org-pack" : "org-pack"}/${file}`;
}

function gatesRel(root: string): string {
  return packRel(root, "gates.yaml");
}

export async function readStamp(root: string): Promise<MetarepoStamp | undefined> {
  try {
    const r = MetarepoStamp.safeParse(parse(await readFile(join(root, STAMP_FILE), "utf8")));
    return r.success ? r.data : undefined;
  } catch {
    return undefined;
  }
}

export interface UpgradeCheck {
  atticus: string;
  stamp?: MetarepoStamp;
  /** A newer Atticus upgraded this metarepo: this one must not write to it. */
  newer: boolean;
  pending: { id: string; summary: string; files: string[] }[];
}

/** Numeric version order (pre-release suffixes ignored): a > b. */
const newerThan = (a: string, b: string) => !versionAtLeast(b, a.replace(/-.*$/, ""));

export async function upgradeCheck(root: string, version = VERSION): Promise<UpgradeCheck> {
  // Each migration's dry run only reads, so they run at once; the list keeps MIGRATIONS' order.
  const [stamp, found] = await Promise.all([
    readStamp(root),
    Promise.all(MIGRATIONS.map(async (m) => ({ m, files: await m.pending(root) }))),
  ]);
  const pending = found
    .filter((x) => x.files.length)
    .map(({ m, files }) => ({ id: m.id, summary: m.summary, files }));
  return {
    atticus: version,
    ...(stamp ? { stamp } : {}),
    newer: !!stamp && newerThan(stamp.atticus.replace(/-.*$/, ""), version.replace(/-.*$/, "")),
    pending,
  };
}

/**
 * `atticus upgrade --openspec-store` (ADR 0126): what making this metarepo an OpenSpec store
 * (beta) would do. Opt-in, so it is not one of MIGRATIONS. A store keeps openspec/ at its root, so
 * a metarepo that keeps it elsewhere can't be one; a store.yaml that is there is never replaced.
 */
export interface OpenSpecStorePlan {
  action: "create" | "present" | "differs" | "refused";
  /** The store id: the org pack's name, made kebab-case. */
  id?: string;
  /** The id the store.yaml that is there names. */
  has?: string;
  remote?: string;
  why?: string;
}

async function openspecStorePlan(root: string): Promise<OpenSpecStorePlan> {
  const where = layoutOf(root).openspec.replace(/\/+$/, "");
  if (where !== "openspec")
    return {
      action: "refused",
      why: `An OpenSpec store keeps openspec/ at its root; this metarepo keeps it in ${where}, so it can't be one. Nothing was changed.`,
    };
  const name = (await loadOrgPack(orgPackDirOf(root))).pack?.name;
  const id = name ? storeIdOf(name) : undefined;
  if (!id)
    return {
      action: "refused",
      why: "The org pack has no name to make a store id from (org-pack/pack.yaml name). Nothing was changed.",
    };
  const have = await readStoreMarker(root);
  if (!have.missing)
    return have.marker?.id === id
      ? { action: "present", id }
      : { action: "differs", id, ...(have.marker ? { has: have.marker.id } : {}) };
  const remote = await metarepoOrigin(root);
  return { action: "create", id, ...(remote ? { remote } : {}) };
}

function storeLine(s: OpenSpecStorePlan): string {
  if (s.action === "present")
    return `This metarepo is already the OpenSpec store ${s.id} (${STORE_MARKER}).`;
  if (s.action === "differs")
    return s.has
      ? `${STORE_MARKER} names the store ${s.has}, not ${s.id}: left as it is.`
      : `${STORE_MARKER} is there but can't be read: left as it is.`;
  return `Wrote ${STORE_MARKER}: this metarepo is the OpenSpec store ${s.id} (beta). Commit it; then a developer runs openspec store register <their clone> once to use it from plain OpenSpec.`;
}

/** atticus upgrade [--check] [--dry-run] [--openspec-store] [--by you] [--json]; the person defaults to the Git user. */
export async function upgradeCommand(
  root: string,
  o: {
    check?: boolean;
    dryRun?: boolean;
    by?: string;
    json?: boolean;
    now?: Date;
    /** Also make the metarepo an OpenSpec store (beta, ADR 0126). */
    openspecStore?: boolean;
  },
  io: Output,
  version = VERSION,
): Promise<number> {
  const c = await upgradeCheck(root, version);
  if (c.newer) {
    io.err(
      `This metarepo was upgraded by Atticus ${c.stamp!.atticus}; this is ${version}. Install ${c.stamp!.atticus} or later before working in it, so nothing it wrote is lost.`,
    );
    if (o.json) io.out(JSON.stringify(c, null, 2));
    return 1;
  }
  const store = o.openspecStore ? await openspecStorePlan(root) : undefined;
  if (store?.action === "refused") {
    io.err(store.why!);
    if (o.json) io.out(JSON.stringify({ ...c, openspecStore: store }, null, 2));
    return 1;
  }
  if (o.check || o.dryRun) {
    const steps = c.pending.length + (store?.action === "create" ? 1 : 0);
    if (o.json) io.out(JSON.stringify(store ? { ...c, openspecStore: store } : c, null, 2));
    else if (!steps) {
      io.out(`Up to date for Atticus ${version}.`);
      if (store) io.out(storeLine(store));
    } else {
      io.out(`${steps} upgrade step${steps === 1 ? "" : "s"} to run (atticus upgrade):`);
      for (const p of c.pending)
        io.out(`  ${p.summary}: ${p.files.length} file${p.files.length === 1 ? "" : "s"}`);
      if (store?.action === "create")
        io.out(`  Make this metarepo the OpenSpec store ${store.id} (beta): ${STORE_MARKER}`);
      else if (store) io.out(storeLine(store));
    }
    return o.check && steps ? 1 : 0;
  }
  const now = o.now ?? new Date();
  const by = o.by ?? (await gitUser(root)).handle;
  const stampTime = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const backup = join(
    root,
    ".atticus",
    "backups",
    stampTime.replace(/[-:]/g, "").replace("T", "-").replace("Z", ""),
  );
  const changed: string[] = [];
  if (c.pending.length) {
    await mkdir(backup, { recursive: true });
    await ensureLocalIgnore(root);
    for (const p of c.pending)
      for (const f of p.files)
        await cp(join(root, ...f.split("/")), join(backup, ...f.split("/"))).catch(() => undefined);
    for (const p of c.pending) {
      const m = MIGRATIONS.find((x) => x.id === p.id)!;
      changed.push(...(await m.apply(root)));
    }
  }
  const stamp: MetarepoStamp = MetarepoStamp.parse({
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    atticus: version,
    upgradedAt: stampTime,
    upgradedBy: by,
    migrations: [...new Set([...(c.stamp?.migrations ?? []), ...MIGRATIONS.map((m) => m.id)])],
  });
  await writeFileAtomic(join(root, STAMP_FILE), stringify(stamp));
  if (store?.action === "create") {
    await writeStoreMarker(root, {
      id: store.id!,
      ...(store.remote ? { remote: store.remote } : {}),
    });
    changed.push(STORE_MARKER);
  }
  if (o.json)
    io.out(
      JSON.stringify(
        {
          upgraded: c.pending.map((p) => p.id),
          files: changed,
          stamp,
          ...(store ? { openspecStore: store } : {}),
        },
        null,
        2,
      ),
    );
  else {
    if (c.pending.length) {
      for (const p of c.pending)
        io.out(`Done: ${p.summary} (${p.files.length} file${p.files.length === 1 ? "" : "s"})`);
      io.out(`The files as they were are in ${backup}.`);
    } else if (store?.action !== "create") io.out(`Nothing to change for Atticus ${version}.`);
    if (store) io.out(storeLine(store));
    io.out(
      `Recorded Atticus ${version} in ${STAMP_FILE.split("\\").join("/")}. Commit the changes in a pull request.`,
    );
  }
  return 0;
}
