// The Forge estate, as the M3 exit suite and the live-run sandboxes both build it.
// Plain Node ESM, no dependencies beyond `yaml`, so a script can import it without a build step.
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PACKAGE = resolve(HERE, "..");
export const REPO = resolve(HERE, "../../..");
export const FIXTURES = join(REPO, "fixtures");
export const FORGE = join(FIXTURES, "forge");
export const FORGE_CHANGE = join(FIXTURES, "forge-change");
export const SPECKIT = join(FIXTURES, "forge-speckit");
/** The suite's own fixtures: runtime.yaml, design fixes, replay recordings. */
export const OWN = join(PACKAGE, "test/fixtures");
export const CHANGE = "add-transfer-limit";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
  GIT_TERMINAL_PROMPT: "0",
};

/** Run git in a folder with a fixed identity and `main` as the first branch. */
export function sh(cwd, ...args) {
  return execFileSync("git", ["-c", "init.defaultBranch=main", ...args], {
    cwd,
    encoding: "utf8",
    env: GIT_ENV,
    stdio: "pipe",
  }).trim();
}

/**
 * The Forge estate as a team would have it: fixtures/forge copied (metarepo beside repos and
 * inputs), the forge-change and forge-speckit org-pack additions laid over the Forge pack, then
 * the suite's own runtime.yaml (replay allowed, mock outside systems) and a manifest whose repos
 * point at local bare remotes and build with a fake build runner. The metarepo is a Git
 * repository. Nothing is scanned yet.
 *
 * Options:
 *   top      the folder to build in (default: a new temp folder)
 *   answers  true (default) keeps fixtures/forge/expected and copies the replay recordings in,
 *            as the suite needs; false leaves out every expected or recorded answer, which is
 *            what a live-run sandbox must not hold.
 *
 * Returns { top, root, replayDir, buildLog, fakeBuild } (replayDir is undefined without answers).
 */
export async function forgeEstate(o = {}) {
  const answers = o.answers !== false;
  const top = o.top ?? (await mkdtemp(join(tmpdir(), "atticus-m3-exit-")));
  await mkdir(top, { recursive: true });
  await cp(FORGE, top, {
    recursive: true,
    // The README describes the expected files, so a sandbox leaves it out with them.
    filter: (src) =>
      answers || (src !== join(FORGE, "expected") && src !== join(FORGE, "README.md")),
  });
  const root = join(top, "metarepo");
  await cp(join(FORGE_CHANGE, "org-pack"), join(root, "org-pack"), { recursive: true });
  // A person's judgments of the seeded change (which new columns hold personal data, ADR 0117
  // addendum): an answer, so a live-run sandbox leaves them out. Under Copilot's hand-off the
  // critic then asks the table's owner which columns are personal (the grade counts that, b).
  if (answers)
    await cp(join(FORGE_CHANGE, "judgments"), join(root, "judgments"), { recursive: true });
  await cp(join(SPECKIT, "org-pack"), join(root, "org-pack"), { recursive: true });
  await cp(join(OWN, "org-pack"), join(root, "org-pack"), { recursive: true });
  // The diagrams and documents a team drops into the metarepo's inputs/ folder.
  await cp(join(top, "inputs"), join(root, "inputs"), { recursive: true });

  const buildLog = join(top, "build.log");
  const fakeBuild = join(top, "fake-build.mjs");
  await writeFile(
    fakeBuild,
    [
      'import { appendFileSync } from "node:fs";',
      `appendFileSync(${JSON.stringify(buildLog)}, process.cwd() + "\\n");`,
      'console.log("fake build: compiled and tested");',
      "",
    ].join("\n"),
  );

  const manifestPath = join(root, "org-pack/profiles/forge/repos.manifest.yaml");
  const manifest = parse(await readFile(manifestPath, "utf8"));
  for (const id of (await readdir(join(top, "repos"))).sort()) {
    const work = join(top, "repos", id);
    sh(work, "init", "-q", "-b", "main");
    sh(work, "add", "-A");
    sh(work, "commit", "-q", "-m", "initial");
    const bare = join(top, "remotes", `${id}.git`);
    await mkdir(dirname(bare), { recursive: true });
    sh(dirname(bare), "clone", "-q", "--bare", work, bare);
    const entry = manifest.repos.find((r) => r.id === id);
    if (!entry) throw new Error(`${id} is not in the Forge manifest`);
    entry.url = bare;
    if (entry.build) entry.build = `node ${JSON.stringify(fakeBuild)}`;
  }
  await writeFile(manifestPath, stringify(manifest));

  // Replay recordings: the forge-change critic and story-writer answers, and the suite's own.
  let replayDir;
  if (answers) {
    replayDir = join(top, "recordings");
    await cp(join(FORGE_CHANGE, "recordings"), replayDir, { recursive: true });
    await cp(join(OWN, "recordings"), replayDir, { recursive: true });
  }

  await writeFile(join(root, ".gitignore"), "workspace/\n.runs/\n");
  await mkdir(join(root, ".github"), { recursive: true });
  await writeFile(join(root, ".github/CODEOWNERS"), "openspec/  @forge/platform\n");
  sh(root, "init", "-q", "-b", "main");
  sh(root, "add", "-A");
  sh(root, "commit", "-q", "-m", "Forge metarepo");
  return { top, root, replayDir, buildLog, fakeBuild };
}
