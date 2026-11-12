import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
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
  migrateRolesText,
  migrateRuntimeText,
  migrateRuntimeV3Text,
  migrateRuntimeV4Text,
  migrateCorrections,
  migrateSourcesText,
  orgPackDirOf,
  specsDirOf,
  specsRelOf,
  WORKSPACE_SCHEMA_VERSION,
  writeFileAtomic,
} from "@maycombhq/core";
import { ensureGitignore, gitUser, IGNORED } from "@maycombhq/workspace";
import type { Output } from "./commands.js";
import { recordUpgraded } from "./propose.js";
import { VERSION } from "./version.js";

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
  /**
   * Round 49: the step can list a file that isn't there yet (it makes it), so a backup finds
   * nothing to keep. For any other step, a listed file that isn't there stops the upgrade.
   */
  creates?: boolean;
  /** Round 49: files the step leaves as they are, with why, said by --check and the upgrade. */
  problems?(root: string): Promise<string[]>;
}

const rel = (prefix: string, files: string[]) => files.map((f) => `${prefix}/${f}`);

/** The migrations this Atticus knows, oldest first. Add new ones at the end. */
export const MIGRATIONS: Migration[] = [
  // The version-1 files; each is written at the current version (ADR 0031, 0125).
  catalogStep("catalog-schema-v2", "Catalog records at schema version 2 (ADR 0031)", [1]),
  {
    id: "local-files-ignored",
    summary: "This machine's files kept out of Git (.atticus/.gitignore, ADR 0050)",
    creates: true,
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
    creates: true,
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
    // The id is kept as it was first shipped (stamps record it); the step writes the current version.
    id: "questions-v3",
    summary:
      "Questions at schema version 6: a question can name the earlier one it may be the same as (ADR 0117), an answer can carry its rule and the proposal it accepted (ADR 0153), a question the code later disagreed with keeps why it reopened and the answer it had (ADR 0162), a change's question carries the role that owns it, derived from the stage that asked when the file doesn't say (ADR 0181), and what it asks (business, design or delivery) and a person's re-routing of it (ADR 0191)",
    pending: (root) => migrateQuestions(root, { dryRun: true }),
    apply: (root) => migrateQuestions(root),
    async problems(root) {
      const out: { file: string; message: string }[] = [];
      await migrateQuestions(root, { dryRun: true, problems: out });
      return out.map((p) => `${p.file}: ${p.message}`);
    },
  },
  {
    id: "starter-review",
    summary:
      "The starter review: AI rules for the critic's lenses in checklists/review.yaml, for an org pack with no AI review of its own (ADR 0120)",
    creates: true,
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
  // The version-3 files: only the number changes; version 4 adds a Schema format (ADR 0164).
  catalogStep(
    "catalog-schema-v4",
    "Catalog records at schema version 4: a Schema can be a protobuf message (ADR 0164)",
    [3],
  ),
  sourcesStep(
    "sources-v2",
    "sources.yaml at version 2: a wiki can include and exclude pages by pattern; every wiki still reads every page (ADR 0083)",
    { from: 1, to: 2 },
  ),
  // ADR 0132: from version 1 or 2 (a version 1 file is moved to 2 by the step before, then here).
  sourcesStep(
    "sources-v3",
    "sources.yaml at version 3: a wiki can say how much its word counts (authority) and where it applies (appliesTo); every wiki still ranks as a team's and applies everywhere (ADR 0132)",
    { to: 3 },
  ),
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
    // ADR 0171: a runtime.yaml that names copilot-acp (a mode or its copilotAcp section) needs
    // version 3; any other file means the same at 1 or 2 and is left as it is.
    id: "runtime-v3",
    summary:
      "runtime.yaml at version 3 where it names copilot-acp: GitHub Copilot driven unattended through its Agent Client Protocol (ADR 0171); the number only",
    async pending(root) {
      const rel = packRel(root, "runtime.yaml");
      const text = await readFile(join(root, rel), "utf8").catch(() => undefined);
      return text !== undefined && migrateRuntimeV3Text(text).changed ? [rel] : [];
    },
    async apply(root) {
      const rel = packRel(root, "runtime.yaml");
      const text = await readFile(join(root, rel), "utf8").catch(() => undefined);
      if (text === undefined) return [];
      const r = migrateRuntimeV3Text(text);
      if (!r.changed) return [];
      await writeFileAtomic(join(root, rel), r.text);
      return [rel];
    },
  },
  {
    id: "roles-v2",
    summary:
      "roles.yaml at version 3: it can name the teams repos are owned by and who is on each, so questions go to their owner (ADR 0140), and who takes each role on a change, so a new change's owners are suggested (ADR 0191); no team or role is named until a person writes one",
    async pending(root) {
      const rel = packRel(root, "roles.yaml");
      const text = await readFile(join(root, rel), "utf8").catch(() => undefined);
      return text !== undefined && migrateRolesText(text).changed ? [rel] : [];
    },
    async apply(root) {
      const rel = packRel(root, "roles.yaml");
      const text = await readFile(join(root, rel), "utf8").catch(() => undefined);
      if (text === undefined) return [];
      const r = migrateRolesText(text);
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
    // The whole change folder: writing the stories again also writes stories.md, tasks.md,
    // requests.md, the proposal, specs/, the task prompts and the needs files, all backed up.
    async pending(root) {
      return (await longStories(root)).map((c) => `${changesRelOf(root)}/${c}`);
    },
    async apply(root) {
      const out: string[] = [];
      for (const c of await longStories(root)) {
        // A change that can't be written again is said, never "Done" over it.
        const files = await rewriteStories(root, c).catch((e: unknown) => {
          throw new Error(
            `The stories of ${c} couldn't be written again (${e instanceof Error ? e.message : String(e)}).`,
            { cause: e },
          );
        });
        for (const f of files) out.push(`${changesRelOf(root)}/${c}/${f}`);
      }
      return out;
    },
  },
  {
    id: "manifest-schema-v2",
    summary:
      "repos.manifest.yaml at version 2: a repo can say what it is, in a person's words (ADR 0128)",
    pending: (root) => migrateManifests(root, { dryRun: true, to: 2 }),
    apply: (root) => migrateManifests(root, { to: 2 }),
  },
  {
    id: "manifest-schema-v3",
    summary:
      "repos.manifest.yaml at version 3: a repo can give the base path it answers under on a shared host (ADR 0134)",
    pending: (root) => migrateManifests(root, { dryRun: true, to: 3 }),
    apply: (root) => migrateManifests(root, { to: 3 }),
  },
  // ADR 0181: the version-4 files: only the number changes; version 5 adds the evidence source
  // `ai` with its run (a link the AI decided, flagged joined-by-ai).
  catalogStep(
    "catalog-schema-v5",
    "Catalog records at schema version 5: a link can be the AI's, with the run that decided it (ADR 0181)",
    [4],
  ),
  {
    // ADR 0181: a runtime.yaml that sets `decide` needs version 4; any other file means the same
    // at 1 to 3 and is left as it is.
    id: "runtime-v4",
    summary:
      "runtime.yaml at version 4 where it sets decide: whether the AI decides pairings and option questions itself (ADR 0181); the number only",
    async pending(root) {
      const rel = packRel(root, "runtime.yaml");
      const text = await readFile(join(root, rel), "utf8").catch(() => undefined);
      return text !== undefined && migrateRuntimeV4Text(text).changed ? [rel] : [];
    },
    async apply(root) {
      const rel = packRel(root, "runtime.yaml");
      const text = await readFile(join(root, rel), "utf8").catch(() => undefined);
      if (text === undefined) return [];
      const r = migrateRuntimeV4Text(text);
      if (!r.changed) return [];
      await writeFileAtomic(join(root, rel), r.text);
      return [rel];
    },
  },
  {
    // ADR 0181: a corrections line that uses version 2's fields (ai, batch, rule, match, unlink)
    // but says version 1 (written by hand) says 2; every other line means the same at 1.
    id: "corrections-v2",
    summary:
      "Corrections lines at version 2 where they use its fields: an AI pairing, a batch, a rule, an unlink (ADR 0181); the number only",
    pending: (root) => migrateCorrections(root, { dryRun: true }),
    apply: (root) => migrateCorrections(root),
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

/** A step that moves sources.yaml up a version, the number only (ADR 0127, 0132). */
function sourcesStep(id: string, summary: string, v: { from?: number; to: number }): Migration {
  return {
    id,
    summary,
    async pending(root) {
      const rel = packRel(root, "sources.yaml");
      const text = await readFile(join(root, rel), "utf8").catch(() => undefined);
      return text !== undefined && migrateSourcesText(text, v).changed ? [rel] : [];
    },
    async apply(root) {
      const rel = packRel(root, "sources.yaml");
      const text = await readFile(join(root, rel), "utf8").catch(() => undefined);
      if (text === undefined) return [];
      const r = migrateSourcesText(text, v);
      if (!r.changed) return [];
      await writeFileAtomic(join(root, rel), r.text);
      return [rel];
    },
  };
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
    // ADR 0195: once the catalog is built from slots, catalog/generated is the build's output,
    // never rewritten in place (a file the build didn't write is a hand edit).
    const built = await exists(join(catalogDirOf(root), "sources", "build.json"));
    for (const sub of built ? ["curated"] : ["generated", "curated"]) {
      // A dry run asks only what is to do: a file at another version isn't read as YAML (doctor
      // and the Set up screen ask this on every metarepo, of every record).
      const r = await migrateCatalog(join(catalogDirOf(root), sub), {
        dryRun,
        versions,
        pendingOnly: dryRun,
      });
      // Round 49: where the layout keeps the catalog (kb/catalog, .atticus/catalog), so the
      // backup, --dry-run and --json name the files this step rewrites.
      out.push(...rel(`${layoutOf(root).catalog.replace(/\/+$/, "")}/${sub}`, r.migrated));
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

/** The stamp's path as Git and the app's Propose name it. */
const STAMP_REL = STAMP_FILE.split(sep).join("/");

/**
 * Beta.27 review: each file under the given paths (a file, or a folder read whole), by its
 * content's hash, metarepo-relative and "/"-separated. A path that isn't there has none. Review
 * of the fix: a link (symbolic, or a Windows junction) is skipped, never followed, so a link to
 * a folder above can't loop and one out of the metarepo is never read.
 */
export async function contentOf(root: string, paths: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (rel: string): Promise<void> => {
    if (out.has(rel)) return;
    const abs = join(root, ...rel.split("/"));
    const s = await lstat(abs).catch(() => undefined);
    if (!s || s.isSymbolicLink()) return;
    if (s.isDirectory()) {
      for (const e of (await readdir(abs)).sort()) await walk(`${rel}/${e}`);
      return;
    }
    if (s.isFile())
      out.set(
        rel,
        createHash("sha256")
          .update(await readFile(abs))
          .digest("hex"),
      );
  };
  for (const p of paths) await walk(p.split("\\").join("/").replace(/\/+$/, ""));
  return out;
}

function packRel(root: string, file: string): string {
  return `${isAdopted(root) ? ".atticus/org-pack" : "org-pack"}/${file}`;
}

function gatesRel(root: string): string {
  return packRel(root, "gates.yaml");
}

export async function readStamp(root: string): Promise<MetarepoStamp | undefined> {
  return (await readStampFile(root)).stamp;
}

/**
 * Round 49: the stamp, and when the file is there but isn't a stamp this Atticus reads (a newer
 * one added a field, or a schema version), the Atticus it names, read on its own, and why.
 */
async function readStampFile(
  root: string,
): Promise<{ stamp?: MetarepoStamp; unread?: { atticus?: string; why: string } }> {
  let text: string;
  try {
    text = await readFile(join(root, STAMP_FILE), "utf8");
  } catch {
    return {};
  }
  let data: unknown;
  try {
    data = parse(text);
  } catch (e) {
    return { unread: { why: `not YAML: ${(e as Error).message.split("\n")[0]!}` } };
  }
  const r = MetarepoStamp.safeParse(data);
  if (r.success) return { stamp: r.data };
  const atticus = (data as { atticus?: unknown } | null)?.atticus;
  const why = r.error.issues.map((i) => `${i.path.join(".") || "(top)"}: ${i.message}`).join("; ");
  return {
    unread: {
      ...(typeof atticus === "string" && atticus.trim() ? { atticus: atticus.trim() } : {}),
      why,
    },
  };
}

export interface UpgradeCheck {
  atticus: string;
  stamp?: MetarepoStamp;
  /** A newer Atticus upgraded this metarepo: this one must not write to it. */
  newer: boolean;
  /**
   * Round 49: the stamp is there but isn't one this Atticus reads, so it was written by a newer
   * or an unknown Atticus (`newer` is true): the version it names, if any, and why it isn't read.
   */
  unreadStamp?: { atticus?: string; why: string };
  pending: { id: string; summary: string; files: string[] }[];
  /** Round 49: files a step leaves as they are, with why. */
  problems?: string[];
}

/**
 * Round 49: the Atticus to install when this one refuses the metarepo (c.newer), if known: the
 * stamp's, or the one a stamp it can't read names when that one is newer.
 */
export function newerAtticusOf(c: UpgradeCheck): string | undefined {
  const u = c.unreadStamp?.atticus;
  return c.stamp?.atticus ?? (u && newerThan(u, c.atticus) ? u : undefined);
}

/** Round 49: why this Atticus refuses the metarepo (c.newer), with what to do. */
export function newerWords(c: UpgradeCheck): string {
  const u = c.unreadStamp;
  // A stamp a newer Atticus wrote with a field this one doesn't know still names that Atticus.
  const v = newerAtticusOf(c);
  if (v)
    return `This metarepo was upgraded by Atticus ${v}; this is ${c.atticus}. Install ${v} or later before working in it, so nothing it wrote is lost.`;
  return `This metarepo was upgraded by a newer or unknown Atticus${u?.atticus ? ` (${u.atticus})` : ""}: .atticus/metarepo.yaml isn't a stamp Atticus ${c.atticus} reads (${u?.why ?? "unreadable"}). Install it${u?.atticus ? ` (Atticus ${u.atticus} or later)` : ""} before working in this metarepo, so nothing it wrote is lost; or, if the file was edited by hand, put it back as it was committed. Nothing was changed.`;
}

/**
 * Round 38: semver order with pre-releases (2.0.0-beta.30 > 2.0.0-beta.21 > 2.0.0-beta.9, and a
 * release above its pre-releases), so an older beta refuses a metarepo a newer beta upgraded.
 */
export function newerThan(a: string, b: string): boolean {
  const split = (v: string) => {
    const [core, pre] = v.trim().replace(/^v/, "").split(/-(.*)/s, 2);
    return { core: (core ?? "").split(".").map((n) => Number(n) || 0), pre: pre ?? "" };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.max(x.core.length, y.core.length); i++) {
    const d = (x.core[i] ?? 0) - (y.core[i] ?? 0);
    if (d) return d > 0;
  }
  if (x.pre === y.pre) return false;
  if (!x.pre) return true; // a release is above its pre-releases
  if (!y.pre) return false;
  const xp = x.pre.split(".");
  const yp = y.pre.split(".");
  for (let i = 0; i < Math.max(xp.length, yp.length); i++) {
    const p = xp[i];
    const q = yp[i];
    if (p === undefined) return false;
    if (q === undefined) return true;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) > Number(q);
    if (pn !== qn) return !pn; // numeric identifiers sort below the others
    return p > q;
  }
  return false;
}

export async function upgradeCheck(root: string, version = VERSION): Promise<UpgradeCheck> {
  // Each migration's dry run only reads, so they run at once; the list keeps MIGRATIONS' order.
  const [read, found] = await Promise.all([
    readStampFile(root),
    Promise.all(
      MIGRATIONS.map(async (m) => ({
        m,
        files: await m.pending(root),
        problems: m.problems ? await m.problems(root) : [],
      })),
    ),
  ]);
  const { stamp, unread } = read;
  const pending = found
    .filter((x) => x.files.length)
    .map(({ m, files }) => ({ id: m.id, summary: m.summary, files }));
  const problems = found.flatMap((x) => x.problems);
  return {
    atticus: version,
    ...(stamp ? { stamp } : {}),
    // Round 49: a stamp that is there but isn't read is a newer or unknown Atticus's: never
    // taken as no stamp, so this one never writes over it.
    newer: stamp ? newerThan(stamp.atticus, version) : !!unread,
    ...(unread ? { unreadStamp: unread } : {}),
    pending,
    ...(problems.length ? { problems } : {}),
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
    /** ADR 0195 point 6: apply the step that adopts the catalog into source slots. */
    yes?: boolean;
    /** With --yes: accept the first build's changes, naming their count (`--accept-changes`). */
    acceptChanges?: number;
  },
  io: Output,
  version = VERSION,
): Promise<number> {
  const c = await upgradeCheck(root, version);
  const { planUpgradeToSlots, applyUpgradeToSlots, upgradeSlotsView } =
    await import("@maycombhq/scanner");
  let slots = await planUpgradeToSlots(root);
  // CS3: every file --yes writes, with its hash, the same list the app's upgrade screen shows.
  let view = await upgradeSlotsView(root, slots);
  const slotsJson = () => (slots.pending ? { slots: view } : {});
  const slotsLines = (): string[] => [
    `Adopt the catalog into source slots (ADR 0195): ${slots.records} records, nothing lost:`,
    ...slots.slots.map(
      (x) =>
        `  ${x.path}: ${x.records} record${x.records === 1 ? "" : "s"}${x.repo ? ` (${x.repo}, legacy)` : " (joined and evidence-less records, legacy)"}`,
    ),
    `  catalog/sources/legacy/generated-before-upgrade/: a copy of catalog/generated as it is`,
    ...(slots.differs.length
      ? [
          `  The first build would change ${slots.differs.length} record file${slots.differs.length === 1 ? "" : "s"} (the files as they are stay in the copy):`,
          ...slots.changes.slice(0, 20).map((x) => `    ${x.how}: catalog/generated/${x.path}`),
          ...(slots.changes.length > 20 ? [`    and ${slots.changes.length - 20} more`] : []),
          `  Accept exactly these with: atticus upgrade --yes --accept-changes ${slots.differs.length}`,
        ]
      : ["  The first build changes nothing: catalog/generated stays byte for byte."]),
    ...slots.verifiable.map(
      (r) =>
        `  ${r}: its facts passed verify as they are; atticus verify ${r} --write puts them in its facts slot.`,
    ),
  ];
  if (c.newer) {
    io.err(newerWords(c));
    if (o.json) io.out(JSON.stringify(c, null, 2));
    return 1;
  }
  // Round 49: what a step leaves as it is (a copy of a question, say) is said, each time.
  for (const p of c.problems ?? []) io.err(`Left as it is: ${p}`);
  const store = o.openspecStore ? await openspecStorePlan(root) : undefined;
  if (store?.action === "refused") {
    io.err(store.why!);
    if (o.json) io.out(JSON.stringify({ ...c, openspecStore: store }, null, 2));
    return 1;
  }
  if (o.check || o.dryRun) {
    const steps = c.pending.length + (store?.action === "create" ? 1 : 0) + (slots.pending ? 1 : 0);
    if (o.json)
      io.out(
        JSON.stringify(
          { ...c, ...(store ? { openspecStore: store } : {}), ...slotsJson() },
          null,
          2,
        ),
      );
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
      if (slots.pending) for (const l of slotsLines()) io.out(`  ${l}`);
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
  // Beta.27 review: what this run changes is kept with it, so the app proposes exactly that:
  // what every step returned, and each file under what a step named (a change's whole folder,
  // say) that it wrote, rewrote or removed, as content before and after tells. Kept even when a
  // step fails, so the steps that had run are proposed once the upgrade is run again.
  const named = [".atticus/.gitignore", ...c.pending.flatMap((p) => p.files)];
  const before = await contentOf(root, named);
  const keep = async () => {
    const after = await contentOf(root, named);
    const touched = [...new Set([...before.keys(), ...after.keys()])].filter(
      (f) => before.get(f) !== after.get(f),
    );
    await recordUpgraded(root, { add: [...changed, ...touched, STAMP_REL] });
  };
  if (c.pending.length) {
    await mkdir(backup, { recursive: true });
    await ensureLocalIgnore(root);
    // Every file or folder a step changes, copied whole before any step runs. One that isn't
    // there yet (a step that makes it) has nothing to keep; any other failure stops the upgrade
    // before anything is changed, so "the files as they were are in" is always true.
    // Round 49: only a step that makes its file may list one that isn't there; for any other,
    // a file it would rewrite that the backup can't find is a wrong path, never skipped.
    for (const p of c.pending) {
      const creates = MIGRATIONS.find((x) => x.id === p.id)?.creates === true;
      for (const f of p.files)
        await cp(join(root, ...f.split("/")), join(backup, ...f.split("/")), {
          recursive: true,
        }).catch((e: NodeJS.ErrnoException) => {
          if (e.code === "ENOENT" && creates) return;
          throw new Error(
            e.code === "ENOENT"
              ? `Couldn't back up ${f} before upgrading: the step ${p.id} would change it, but it isn't there; nothing was changed.`
              : `Couldn't back up ${f} before upgrading (${e.message}); nothing was changed.`,
          );
        });
    }
    for (const p of c.pending) {
      const m = MIGRATIONS.find((x) => x.id === p.id)!;
      try {
        changed.push(...(await m.apply(root)));
      } catch (e) {
        // Said with where the files as they were are kept, and which steps already ran.
        const done = c.pending.slice(0, c.pending.indexOf(p)).map((x) => x.id);
        await keep().catch(() => undefined);
        throw new Error(
          `${e instanceof Error ? e.message : String(e)} The files as they were before this upgrade are in ${relative(root, backup).split(sep).join("/")}${done.length ? `; these steps had already run: ${done.join(", ")}` : ""}. Run atticus upgrade again once it's fixed.`,
          { cause: e },
        );
      }
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
  // ADR 0195 point 6: the catalog adopted into source slots, shown first, applied with --yes.
  // Planned again once the other steps ran: they may change an input the slots record.
  if (c.pending.length && slots.pending) {
    slots = await planUpgradeToSlots(root);
    view = await upgradeSlotsView(root, slots);
  }
  let slotsDone: number | undefined | "refused" | "shown" | "changed" = undefined;
  if (slots.pending) {
    const accepted = !slots.differs.length || o.acceptChanges === slots.differs.length;
    if (!o.yes || !accepted) slotsDone = o.yes ? "refused" : "shown";
    else {
      const { acquireLock, LockHeldError } = await import("@maycombhq/core");
      await (await import("./catalog-build-commands.js")).afterListed();
      let lock;
      try {
        lock = await acquireLock(root, "scan", "atticus upgrade --yes");
      } catch (e) {
        if (e instanceof LockHeldError) {
          io.err(e.message);
          await keep().catch(() => undefined);
          return 1;
        }
        throw e;
      }
      try {
        // Planned again under the lock (ADR 0195 point 2): it writes what it listed, or nothing.
        const { upgradePlanHash } = await import("@maycombhq/scanner");
        const again = await planUpgradeToSlots(root);
        if (upgradePlanHash(root, again) !== upgradePlanHash(root, slots)) {
          slotsDone = "changed";
        } else {
          slotsDone =
            (await applyUpgradeToSlots(
              root,
              slots,
              slots.differs.length ? { acceptChanges: slots.differs.length } : {},
            )) ?? 0;
          changed.push(...slots.writes.map((w) => relative(root, w.path).split(sep).join("/")));
        }
      } finally {
        await lock.release();
      }
    }
  }
  // Beta.27 review: kept once every step ran, the slots' adoption included.
  await keep();
  if (o.json)
    io.out(
      JSON.stringify(
        {
          upgraded: c.pending.map((p) => p.id),
          files: changed,
          stamp,
          ...(store ? { openspecStore: store } : {}),
          ...(slots.pending
            ? {
                ...slotsJson(),
                slotsStep: typeof slotsDone === "number" ? "applied" : (slotsDone ?? "none"),
              }
            : {}),
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
    if (slots.pending) {
      for (const l of slotsLines()) (slotsDone === "refused" ? io.err : io.out)(l);
      if (slotsDone === "shown")
        io.out("Nothing of it written yet: atticus upgrade --yes applies this step.");
      else if (slotsDone === "refused")
        io.err(
          o.acceptChanges !== undefined
            ? `Nothing of it written: --accept-changes ${o.acceptChanges} doesn't name the ${slots.differs.length} listed.`
            : `Nothing of it written: the first build changes the catalog, so it waits for atticus upgrade --yes --accept-changes ${slots.differs.length}.`,
        );
      else if (slotsDone === "changed")
        io.err(
          "Nothing of it written: what the step would write isn't what it listed any more (another command wrote meanwhile). Run atticus upgrade again to list it.",
        );
      else
        io.out(
          "Done: the catalog is adopted into catalog/sources/ (atticus catalog undo takes it back).",
        );
    }
  }
  return slotsDone === "refused" || slotsDone === "changed" ? 1 : 0;
}
