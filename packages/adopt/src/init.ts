import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadOrgPack, RecordId, type OrgPackProblem } from "@maycombhq/core";
import {
  createOpenSpec,
  ORG_FLOW,
  setDefaultSchema,
  writeOrgFlowSchema,
} from "@maycombhq/openspec-adapter";
import { ensureGitignore } from "@maycombhq/workspace";
import { AdoptError } from "./errors.js";
import { copyDir, exists, isDir, listFiles, writeNew } from "./files.js";
import { ORG_PACK_DIR } from "./layout.js";
import { writeStartingPack } from "./orgpack-files.js";

/**
 * `atticus init <name> --platform <pack>`: a new metarepo, ready for `repos discover`,
 * `workspace sync` and `scan`. The org pack comes from the built-in defaults (written out as
 * files) or is copied from a given pack; `openspec/` is set up with the bundled OpenSpec CLI
 * when it runs (it works offline), else as plain folders; both get the org-flow schema.
 * Nothing that exists is overwritten.
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
}

export interface InitResult {
  root: string;
  /** Files written, relative to the root. */
  created: string[];
  openspec: "cli" | "folders";
  /** Why the OpenSpec CLI wasn't used, when it wasn't. */
  openspecNote?: string;
  problems: OrgPackProblem[];
  questions: string[];
}

const README = (name: string, platform: string) => `# ${name}

The Atticus metarepo for the ${platform} platform.

- \`org-pack/\`: how this organisation works (roles, change types, gates, patterns, checklists, skills). Changed only through pull requests.
- \`catalog/generated/\`: the catalog Atticus writes on every scan, one YAML record per file. \`catalog/curated/\` holds people's decisions.
- \`openspec/\`: changes (\`openspec/changes/<id>/\`) and the living specs.
- \`workspace/\`, \`.index/\`, \`.runs/\`: local state, never committed.

Next: \`atticus repos discover <folder of clones>\`, then \`atticus workspace sync\` and \`atticus scan\`.
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
      sources: { schemaVersion: 1 },
      defaults: false,
    });
  } else {
    await writeStartingPack(orgPack, {
      name: o.name,
      platform: o.platform,
      owner,
      sources: { schemaVersion: 1 },
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
    ...(note ? { openspecNote: note } : {}),
    problems: op.problems,
    questions,
  };
}
