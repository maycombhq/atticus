import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  loadOrgPack,
  RecordId,
  SOURCES_SCHEMA_VERSION,
  type OrgPackProblem,
} from "@maycombhq/core";
import {
  createOpenSpec,
  ORG_FLOW,
  setDefaultSchema,
  storeIdOf,
  writeOrgFlowSchema,
  writeStoreMarker,
} from "@maycombhq/openspec-adapter";
import { createGit, ensureGitignore, type GitRunner } from "@maycombhq/workspace";
import { AdoptError } from "./errors.js";
import { copyDir, exists, isDir, listFiles, writeNew } from "./files.js";
import { ORG_PACK_DIR } from "./layout.js";
import { writeStartingPack } from "./orgpack-files.js";

/**
 * `atticus init <name> --platform <pack>`: a new metarepo, ready for `repos discover`,
 * `workspace sync` and reading each repo (`/atticus-map`, `atticus verify --write`). The org
 * pack comes from the built-in defaults (written out as files) or is copied from a given pack;
 * `openspec/` is set up with the bundled OpenSpec CLI when it runs (it works offline), else as
 * plain folders; both get the org-flow schema. A folder not inside a git repository is made one
 * (branch main), so its changes go through pull requests; one inside a repository is left as
 * it is. Nothing that exists is overwritten.
 */

export interface InitOptions {
  /** The org pack's name (a slug). */
  name: string;
  /** The platform profile to create under org-pack/profiles/. */
  platform: string;
  /** Copy this org pack folder instead of writing the defaults. */
  packFrom?: string;
  /** The org pack's owner; default `unassigned` (an owner question). */
  owner?: string;
  /** How to make openspec/: the OpenSpec CLI, plain folders, or the CLI with folders as fallback. */
  openspec?: "cli" | "folders" | "auto";
  /** The git runner the repository is made with; default the git on PATH (tests mock it). */
  git?: GitRunner;
  /**
   * Also make the metarepo an OpenSpec store (beta, ADR 0126): write `.openspec-store/store.yaml`
   * with the org pack's name as its id, so a developer can `openspec store register` a clone.
   */
  openspecStore?: boolean;
}

export interface InitResult {
  root: string;
  /** Files written, relative to the root. */
  created: string[];
  openspec: "cli" | "folders";
  /** The OpenSpec store id written in .openspec-store/store.yaml, when asked for. */
  openspecStore?: { id: string };
  /** Why the OpenSpec CLI wasn't used, when it wasn't. */
  openspecNote?: string;
  problems: OrgPackProblem[];
  questions: string[];
  /**
   * `initialised`: the folder wasn't inside a git repository, so it was made one (branch main);
   * `inside`: it is in one already, left as it is; `unavailable`: git didn't run.
   */
  git: "initialised" | "inside" | "unavailable";
  /** Why git didn't run, and what to do, when it didn't. */
  gitNote?: string;
}

/** Whether a folder is inside a git repository: it, or a folder above it, has `.git`. */
async function insideRepo(dir: string): Promise<boolean> {
  for (let d = resolve(dir); ; d = dirname(d)) {
    if (await exists(join(d, ".git"))) return true;
    if (dirname(d) === d) return false;
  }
}

/** A repository on main; a git older than 2.28 (no -b) inits, then points HEAD at main. */
async function makeRepo(dir: string, git: GitRunner): Promise<void> {
  try {
    await git(["init", "-b", "main"], dir);
  } catch {
    await git(["init"], dir);
    await git(["symbolic-ref", "HEAD", "refs/heads/main"], dir);
  }
}

const README = (name: string, platform: string) => `# ${name}

The Atticus metarepo for the ${platform} platform.

- \`org-pack/\`: how this organisation works (change types, gates, patterns, checklists, skills). Changed only through pull requests.
- \`catalog/generated/\`: the catalog Atticus writes on every scan, one YAML record per file. \`catalog/curated/\` holds people's decisions.
- \`openspec/\`: changes (\`openspec/changes/<id>/\`) and the living specs.
- \`workspace/\`, \`.index/\`, \`.runs/\`: local state, never committed.

Next: \`atticus repos discover <folder of clones>\` and \`atticus workspace sync\`, then read each repo: \`/atticus-map <repo>\` in your assistant (or \`atticus map <repo>\`), then \`atticus verify <repo> --write\`.
`;

export async function init(dir: string, o: InitOptions): Promise<InitResult> {
  if (!RecordId.safeParse(o.name).success)
    throw new AdoptError(
      "usage",
      `"${o.name}" can't be an org pack name; use a lowercase slug such as shop-platform.`,
    );
  if (!RecordId.safeParse(o.platform).success)
    throw new AdoptError(
      "usage",
      `"${o.platform}" can't be a platform id; use a lowercase slug such as shop.`,
    );
  if (await isDir(join(dir, ORG_PACK_DIR)))
    throw new AdoptError(
      "exists",
      `${join(dir, ORG_PACK_DIR)} already exists; this folder is already a metarepo.`,
    );
  if (await isDir(join(dir, ".atticus", ORG_PACK_DIR)))
    throw new AdoptError(
      "exists",
      "This repo is adopted in place (.atticus/org-pack); use it as it is, or run atticus unadopt first.",
    );
  if (o.packFrom && !(await isDir(o.packFrom)))
    throw new AdoptError("usage", `There is no org pack folder at ${o.packFrom}.`);

  await mkdir(dir, { recursive: true });
  // A metarepo is a git repository: made one here unless it is inside one already.
  let gitState: InitResult["git"] = "inside";
  let gitNote: string | undefined;
  if (!(await insideRepo(dir))) {
    try {
      await makeRepo(dir, o.git ?? createGit());
      gitState = "initialised";
    } catch (e) {
      gitState = "unavailable";
      gitNote = `git didn't run (${(e as Error).message.split("\n")[0]}), so the folder isn't a git repository yet: run git init -b main in it.`;
    }
  }
  const before = new Set(await listFiles(dir));
  const orgPack = join(dir, ORG_PACK_DIR);
  const questions: string[] = [];
  const owner = o.owner ?? "unassigned";
  if (!o.owner && !o.packFrom)
    questions.push(
      "Who owns the org pack? Set owner in org-pack/pack.yaml (normally the platform lead).",
    );

  if (o.packFrom) {
    await copyDir(o.packFrom, orgPack);
    await writeStartingPack(orgPack, {
      name: o.name,
      platform: o.platform,
      owner,
      sources: { schemaVersion: SOURCES_SCHEMA_VERSION },
      defaults: false,
    });
  } else {
    await writeStartingPack(orgPack, {
      name: o.name,
      platform: o.platform,
      owner,
      sources: { schemaVersion: SOURCES_SCHEMA_VERSION },
      defaults: true,
    });
  }

  // openspec/ with the org-flow schema.
  let mode: InitResult["openspec"] = "folders";
  let note: string | undefined;
  if ((o.openspec ?? "auto") !== "folders") {
    try {
      const os = createOpenSpec({ root: dir });
      await os.assertSupported();
      if (!(await exists(join(dir, "openspec", "config.yaml")))) await os.init();
      mode = "cli";
    } catch (e) {
      if (o.openspec === "cli") throw e;
      note = `The OpenSpec CLI didn't run (${(e as Error).message.split("\n")[0]}), so openspec/ was made as plain folders.`;
    }
  }
  if (mode === "folders") {
    await mkdir(join(dir, "openspec", "specs"), { recursive: true });
    await mkdir(join(dir, "openspec", "changes", "archive"), { recursive: true });
    await writeNew(join(dir, "openspec", "specs", "README.md"), "# Living specs\n");
    await writeNew(
      join(dir, "openspec", "changes", "archive", "README.md"),
      "# Archived changes\n",
    );
  }
  await writeOrgFlowSchema(dir);
  await setDefaultSchema(dir, ORG_FLOW);
  let store: InitResult["openspecStore"];
  if (o.openspecStore) {
    const id = storeIdOf(o.name)!;
    await writeStoreMarker(dir, { id });
    store = { id };
  }

  await writeNew(
    join(dir, "catalog", "generated", "README.md"),
    "# Generated catalog\n\nWritten by `atticus scan`. Don't edit: record decisions in catalog/curated/.\n",
  );
  await writeNew(
    join(dir, "catalog", "curated", "README.md"),
    "# Curated decisions\n\nPeople's decisions (aliases, names, confirmations) applied over every scan.\n",
  );
  await writeNew(join(dir, "README.md"), README(o.name, o.platform));
  await ensureGitignore(dir);
  // Per-person settings (executors.yaml) live in .atticus/ and are never committed either.
  const gi = join(dir, ".gitignore");
  const text = await readFile(gi, "utf8");
  if (!/^\/?\.atticus\/?$/m.test(text))
    await writeFile(gi, `${text.endsWith("\n") ? text : `${text}\n`}/.atticus/\n`, "utf8");

  const op = await loadOrgPack(orgPack);
  const created = (await listFiles(dir)).filter((f) => !before.has(f));
  return {
    root: dir,
    created,
    openspec: mode,
    ...(store ? { openspecStore: store } : {}),
    ...(note ? { openspecNote: note } : {}),
    problems: op.problems,
    questions,
    git: gitState,
    ...(gitNote ? { gitNote } : {}),
  };
}
