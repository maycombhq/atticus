import { mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { stringify } from "yaml";
import { loadOrgPack, type OrgPackProblem } from "@maycombhq/core";
import { ORG_FLOW, setDefaultSchema, writeOrgFlowSchema } from "@maycombhq/openspec-adapter";
import { reposDiscover, type DiscoveredRepo, type OwnerQuestion } from "./discover.js";
import { AdoptError } from "./errors.js";
import { exists, hashTree, isDir, listDirs, listFiles, slug, toPosix, writeNew } from "./files.js";
import { ATTICUS_DIR, ORG_PACK_DIR, pathsFor, STATE_FOLDERS, type Layout } from "./layout.js";
import { writeStartingPack } from "./orgpack-files.js";

/**
 * `atticus adopt <path>`: adopt an existing repo or metarepo in place, with no hand-written
 * config and without changing a single file of the repo. Atticus detects what is there
 * (OpenSpec, Spec Kit, a constitution, assistant prompts, agents and skills, a catalog, the
 * repos and their types) and writes only into `.atticus/`: an org pack whose `sources.yaml`
 * `layout` points at what exists, plus Atticus's local state (ignored by `.atticus/.gitignore`).
 * Whatever the repo lacks (an OpenSpec folder, a catalog) is created inside `.atticus/` too.
 *
 * Adopt hashes every file before and after and refuses to finish if anything outside
 * `.atticus/` changed; the snapshot it keeps lets `unadopt` put the repo back byte for byte.
 */

export const SNAPSHOT_FILE = `${ATTICUS_DIR}/state/adopt-snapshot.json`;
export const ADOPTED_FILE = `${ATTICUS_DIR}/adopted.yaml`;

export interface Detected {
  /** The repo's OpenSpec folder (has config.yaml, project.md, specs/ or changes/). */
  openspec?: string;
  speckit?: { specify: string; specs?: string; constitution?: string };
  constitution?: string;
  /** Folders of assistant prompts and commands. */
  prompts: string[];
  /** Folders of assistant agents and chat modes. */
  agents: string[];
  /** Folders of skills and instruction files. */
  skills: string[];
  /** Files assistants read as standing instructions. */
  instructions: string[];
  /** An existing Atticus-style catalog folder (with generated/). */
  catalog?: string;
  codeowners?: string;
}

export interface AdoptOptions {
  /** Platform id for the profile; default a slug of the folder name. */
  platform?: string;
  /** Org pack name; default a slug of the folder name. */
  name?: string;
}

export interface AdoptResult {
  root: string;
  platform: string;
  detected: Detected;
  layout: Layout;
  repos: DiscoveredRepo[];
  questions: OwnerQuestion[];
  /** Files written, all under .atticus/, relative to the root. */
  written: string[];
  problems: OrgPackProblem[];
  /** How long adopt took. */
  ms: number;
}

export interface Snapshot {
  schemaVersion: 1;
  /** sha-256 of every file outside .atticus/ (and .git/, node_modules/) at adoption. */
  files: Record<string, string>;
  /** Every folder that existed, so unadopt removes only folders Atticus created. */
  dirs: string[];
}

const PROMPT_DIRS = [".github/prompts", ".claude/commands", "prompts", ".prompts"];
const AGENT_DIRS = [".github/agents", ".claude/agents", ".github/chatmodes"];
const SKILL_DIRS = [".claude/skills", ".github/instructions", "skills"];
const INSTRUCTION_FILES = ["CLAUDE.md", "AGENTS.md", ".github/copilot-instructions.md"];
const CONSTITUTIONS = [
  ".specify/memory/constitution.md",
  "memory/constitution.md",
  "CONSTITUTION.md",
  "constitution.md",
  "docs/constitution.md",
];

async function isOpenSpecFolder(dir: string): Promise<boolean> {
  return (
    (await exists(join(dir, "config.yaml"))) ||
    (await exists(join(dir, "project.md"))) ||
    (await isDir(join(dir, "specs"))) ||
    (await isDir(join(dir, "changes")))
  );
}

/** Find what an existing repo already has. Reads only; never writes. */
export async function detect(root: string): Promise<Detected> {
  const d: Detected = { prompts: [], agents: [], skills: [], instructions: [] };
  // OpenSpec: openspec/ at the root, else one level down (docs/openspec, design/openspec).
  if ((await isDir(join(root, "openspec"))) && (await isOpenSpecFolder(join(root, "openspec"))))
    d.openspec = "openspec";
  else {
    for (const e of (await readdir(root, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
      const cand = join(root, e.name, "openspec");
      if ((await isDir(cand)) && (await isOpenSpecFolder(cand))) {
        d.openspec = `${e.name}/openspec`;
        break;
      }
    }
  }
  if (await isDir(join(root, ".specify"))) {
    d.speckit = { specify: ".specify" };
    if (await isDir(join(root, "specs"))) d.speckit.specs = "specs";
    if (await exists(join(root, ".specify/memory/constitution.md")))
      d.speckit.constitution = ".specify/memory/constitution.md";
  }
  for (const c of CONSTITUTIONS)
    if (await exists(join(root, c))) {
      d.constitution = c;
      break;
    }
  for (const p of PROMPT_DIRS) if (await isDir(join(root, p))) d.prompts.push(p);
  for (const p of AGENT_DIRS) if (await isDir(join(root, p))) d.agents.push(p);
  for (const p of SKILL_DIRS) if (await isDir(join(root, p))) d.skills.push(p);
  for (const f of INSTRUCTION_FILES) if (await exists(join(root, f))) d.instructions.push(f);
  if (await isDir(join(root, "catalog", "generated"))) d.catalog = "catalog";
  for (const c of ["CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"])
    if (await exists(join(root, c))) {
      d.codeowners = c;
      break;
    }
  return d;
}

/** The repo as it is now: every file's hash and every folder, outside .atticus/. */
export async function takeSnapshot(root: string): Promise<Snapshot> {
  const skipNames = new Set([".git", "node_modules"]);
  const files = await hashTree(root, { skipPaths: [ATTICUS_DIR] });
  const dirs = (await listDirs(root, skipNames)).filter(
    (d) => d !== ATTICUS_DIR && !d.startsWith(`${ATTICUS_DIR}/`),
  );
  return { schemaVersion: 1, files, dirs };
}

const GITIGNORE = `# Atticus local state in an adopted repo: never committed.
${STATE_FOLDERS.map((f) => `/${f}/`).join("\n")}
/executors.yaml
/inputs/inbox/
`;

const README = `# .atticus

This repo is adopted by Atticus in place. Everything Atticus owns is in this folder; no other
file of the repo was changed.

- \`org-pack/\`: how Atticus works here. \`org-pack/sources.yaml\` \`layout\` points at the repo's
  own OpenSpec folder, catalog, constitution, prompts and skills; nothing was moved.
- \`adopted.yaml\`: what adopt found.
- \`proposals/\`: what Atticus proposes for people to review (repos, absorbed items).
- Local state (\`workspace/\`, \`.index/\`, \`.runs/\`, \`state/\`) is ignored by \`.gitignore\` here.

To remove Atticus: \`atticus unadopt\`. It deletes this folder and anything else Atticus created
since adoption, and leaves every other file exactly as it was.
`;

export async function adopt(path: string, o: AdoptOptions = {}): Promise<AdoptResult> {
  const t0 = performance.now();
  const root = resolve(path);
  if (!(await isDir(root))) throw new AdoptError("not-found", `There is no folder ${path}.`);
  if (await isDir(join(root, ATTICUS_DIR, ORG_PACK_DIR)))
    throw new AdoptError("exists", `${path} is already adopted (${ATTICUS_DIR}/${ORG_PACK_DIR}).`);
  if (await isDir(join(root, ORG_PACK_DIR)))
    throw new AdoptError(
      "exists",
      `${path} is already an Atticus metarepo (org-pack/); use it with --root as it is.`,
    );

  const snapshot = await takeSnapshot(root);
  const detected = await detect(root);
  const folder = slug(basename(root));
  const platform = o.platform ?? folder;
  const name = o.name ?? folder;

  const layout: Layout = {
    openspec: detected.openspec ?? `${ATTICUS_DIR}/openspec`,
    catalog: detected.catalog ?? `${ATTICUS_DIR}/catalog`,
    ...(detected.constitution ? { constitution: detected.constitution } : {}),
    skills: detected.skills,
    prompts: detected.prompts,
  };
  const paths = pathsFor(root, true, layout);
  const a = join(root, ATTICUS_DIR);
  await mkdir(a, { recursive: true });

  await writeStartingPack(paths.orgPackDir, {
    name,
    platform,
    owner: "unassigned",
    sources: { schemaVersion: 1, layout },
    defaults: true,
  });
  if (!detected.openspec) {
    await writeNew(join(a, "openspec", "specs", "README.md"), "# Living specs\n");
    await writeNew(join(a, "openspec", "changes", "archive", "README.md"), "# Archived changes\n");
    // The org-flow schema writer takes the folder that holds openspec/: here, .atticus/.
    await writeOrgFlowSchema(a);
    await setDefaultSchema(a, ORG_FLOW);
  }
  if (!detected.catalog) {
    await writeNew(
      join(a, "catalog", "generated", "README.md"),
      "# Generated catalog\n\nWritten by `atticus scan`.\n",
    );
    await writeNew(
      join(a, "catalog", "curated", "README.md"),
      "# Curated decisions\n\nPeople's decisions applied over every scan.\n",
    );
  }
  await writeNew(join(a, ".gitignore"), GITIGNORE);
  await writeNew(join(a, "README.md"), README);

  // The repos, in place: `./<path>` urls so scans read them where they are.
  const disc = await reposDiscover(root, { dir: root }, { platform, inPlace: true }, paths);

  await writeNew(
    join(root, ADOPTED_FILE),
    stringify(
      {
        schemaVersion: 1,
        platform,
        detected,
        repos: disc.repos.map((r) => ({
          id: r.entry.id,
          path: r.entry.url,
          type: r.detection.type,
          signals: r.detection.signals,
        })),
      },
      { lineWidth: 0 },
    ),
  );
  await mkdir(join(root, ATTICUS_DIR, "state"), { recursive: true });
  await writeFile(join(root, SNAPSHOT_FILE), JSON.stringify(snapshot, null, 1), "utf8");

  // Adopt changes nothing in the repo: prove it before reporting success.
  const after = await hashTree(root, { skipPaths: [ATTICUS_DIR] });
  const changed = Object.keys({ ...snapshot.files, ...after }).filter(
    (f) => snapshot.files[f] !== after[f],
  );
  if (changed.length)
    throw new AdoptError(
      "source",
      `Adopt changed files outside ${ATTICUS_DIR}/, which it must never do: ${changed.join(", ")}. Run atticus unadopt.`,
    );

  const op = await loadOrgPack(paths.orgPackDir);
  const written = (await listFiles(a)).map((f) => toPosix(`${ATTICUS_DIR}/${f}`));
  return {
    root,
    platform,
    detected,
    layout,
    repos: disc.repos,
    questions: disc.questions,
    written,
    problems: op.problems,
    ms: Math.round(performance.now() - t0),
  };
}
