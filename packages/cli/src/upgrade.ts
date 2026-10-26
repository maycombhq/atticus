import { cp, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import {
  ATTICUS_FOLDER_IGNORE,
  CHECKLISTS_README,
  STARTER_CHECKLISTS_README,
} from "@maycombhq/adopt";
import { readPackFiles, STARTER_REVIEW_PATH, starterReviewText } from "@maycombhq/naysayer";
import { metarepoOrigin } from "@maycombhq/changes";
import {
  ORG_FLOW_VERSION,
  orgFlowVersionOf,
  readStoreMarker,
  STORE_MARKER,
  storeIdOf,
  writeOrgFlowSchema,
  writeStoreMarker,
} from "@maycombhq/openspec-adapter";
import { openspecRootOf, rewriteStories } from "@maycombhq/planner";
import {
  catalogDirOf,
  changesDirOf,
  changesRelOf,
  ensureLocalIgnore,
  isAdopted,
  layoutOf,
  loadOrgPack,
  LOCAL_ONLY,
  MetarepoStamp,
  migrateCatalog,
  migrateChangeTypesText,
  migrateGatesText,
  migrateManifests,
  migrateQuestions,
  migrateRuntimeText,
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
  {
    // ADR 0124 addendum B-place: `atticus init` ignored the whole of .atticus/, so the stamp this
    // command asks a person to commit (ADR 0051) was never committed.
    id: "stamp-committed",
    summary:
      "The stamp .atticus/metarepo.yaml committed, the rest of .atticus/ kept out of Git (metarepo .gitignore, ADR 0051)",
    async pending(root) {
      if (isAdopted(root)) return [];
      const text = await readFile(join(root, ".gitignore"), "utf8").catch(() => "");
      return stampIgnored(text) ? [".gitignore"] : [];
    },
    async apply(root) {
      if (isAdopted(root)) return [];
      const text = await readFile(join(root, ".gitignore"), "utf8").catch(() => "");
      if (!stampIgnored(text)) return [];
      await writeFileAtomic(
        join(root, ".gitignore"),
        text.replace(WHOLE_FOLDER, ATTICUS_FOLDER_IGNORE.join("\n")),
      );
      return [".gitignore"];
    },
  },
  {
    id: "runtime-v2",
    summary:
      "runtime.yaml at version 2: a model can be named for each kind of step (read, draft, critic, knowledge, quick); every step still runs on the one model until one is named (ADR 0121)",
    async pending(root) {
      const rel = packRel(root, "runtime.yaml");
      const text = await readFile(join(root, rel), "utf8").catch(() => undefined);
      return text !== undefined && migrateRuntimeText(text).changed ? [rel] : [];
    },
    async apply(root) {
      const rel = packRel(root, "runtime.yaml");
      const text = await readFile(join(root, rel), "utf8").catch(() => undefined);
      if (text === undefined) return [];
      const r = migrateRuntimeText(text);
      if (!r.changed) return [];
      await writeFileAtomic(join(root, rel), r.text);
      return [rel];
    },
  },
  {
    // ADR 0006 addendum (2026-10-25): org-flow version 2 lists Atticus 2's artifacts (proposal,
    // design, stories, specs, tasks), so `openspec status` and `validate` agree with Atticus.
    id: "org-flow-v2",
    summary:
      "OpenSpec's org-flow schema at version 2: the artifacts Atticus 2 writes, in its stage order (ADR 0006 addendum)",
    async pending(root) {
      const os = openspecRootOf(root);
      if (!os) return [];
      const v = await orgFlowVersionOf(os);
      return v !== undefined && v < ORG_FLOW_VERSION ? [orgFlowRel(root)] : [];
    },
    async apply(root) {
      const os = openspecRootOf(root);
      if (!os) return [];
      await writeOrgFlowSchema(os);
      return [orgFlowRel(root)];
    },
  },
  {
    // ADR 0124 addendum B-short: a change's stories written again from its kept answer, no model
    // call: short story files, task prompts in tasks/, tasks numbered per story, OpenSpec specs.
    id: "stories-b-short",
    summary:
      "Each change's stories in the short form, with OpenSpec spec deltas and a proposal, from the kept stories answer (no model call; ADR 0124 addendum B-short)",
    async pending(root) {
      return (await longStories(root)).map((c) => `${changesRelOf(root)}/${c}/stories`);
    },
    async apply(root) {
      const out: string[] = [];
      for (const c of await longStories(root))
        for (const f of await rewriteStories(root, c).catch(() => [] as string[]))
          out.push(`${changesRelOf(root)}/${c}/${f}`);
      return out;
    },
  },
  {
    id: "manifest-schema-v2",
    summary:
      "repos.manifest.yaml at version 2: a repo can say what it is, in a person's words (ADR 0128)",
    pending: (root) => migrateManifests(root, { dryRun: true }),
    apply: (root) => migrateManifests(root),
  },
];

/** The org-flow schema file, metarepo-relative. */
const orgFlowRel = (root: string) =>
  `${layoutOf(root).openspec.replace(/\/+$/, "")}/schemas/org-flow/schema.yaml`;

/** The changes in flight whose story files are in the long form (a prompt pasted per task). */
async function longStories(root: string): Promise<string[]> {
  const out: string[] = [];
  const dir = changesDirOf(root);
  for (const c of (await readdir(dir).catch(() => [] as string[])).sort()) {
    if (c === "archive") continue;
    if (!(await exists(join(dir, c, "stage", "stories-answer.yaml")))) continue;
    for (const f of await readdir(join(dir, c, "stories")).catch(() => [] as string[]))
      if (
        f.endsWith(".md") &&
        (await readFile(join(dir, c, "stories", f), "utf8")).includes(
          "Prompt for Copilot or Claude Code:",
        )
      ) {
        out.push(c);
        break;
      }
  }
  return out;
}

/** A .gitignore line that ignores the whole of .atticus/, the stamp with it. */
const WHOLE_FOLDER = /^\/?\.atticus\/?[ \t]*$/m;
const stampIgnored = (text: string) =>
  WHOLE_FOLDER.test(text) && !/^!\/?\.atticus\/metarepo\.yaml\s*$/m.test(text);

/**
 * A step that rewrites the catalog's record files (generated and curated) at some older schema
 * versions, in canonical form at the current version. Each version has its own step, so a file
 * is listed under one step only.
 */
function catalogStep(id: string, summary: string, versions: readonly number[]): Migration {
  const run = async (root: string, dryRun: boolean) => {
    const out: string[] = [];
    for (const sub of ["generated", "curated"]) {
      // A dry run asks only what is to do: a file at another version isn't read as YAML (doctor
      // and the Set up screen ask this on every metarepo, of every record).
      const r = await migrateCatalog(join(catalogDirOf(root), sub), {
        dryRun,
        versions,
        pendingOnly: dryRun,
      });
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
