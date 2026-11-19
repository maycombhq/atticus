import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { factsDirOf, type Fact } from "@maycombhq/core";
import { buildAndWrite, factsSnapshotWrites } from "@maycombhq/scanner";
import { main } from "../src/main.js";
import { EMPTY_REPO, NEW_EVENT, TOPIC, UNREAD_REPO } from "./archetypes-changes.js";
import {
  makeFieldEstate,
  writeChangeFiles,
  type FieldEstate,
  type FieldEstateOptions,
} from "./field-estate.js";

/**
 * Beta.30 (slice 9): the field-shaped estate as a committed fixture, `fixtures/forge-field/`, so
 * the journeys and the CLI suites seed it as fast as the tidy Forge fixture. It is made once from
 * field-estate.ts at the shape below (every shape a field report has named) and regenerated with
 * `node scripts/write-field-fixture.mjs`; `forge-field-fixture.test.ts` checks it is up to date.
 *
 * The fixture holds the metarepo's inputs as a team has them after the upgrade (the org pack, the
 * facts and their snapshots, the legacy slots, the corrections, the curated decisions, the open
 * questions) under `metarepo/`, and the clones' files under `repos/`; `estate.json` names what the
 * tests look for. `seedForgeField` copies it, puts the clones (and the empty one) in the
 * workspace and builds the catalog. Everything is invented (CLAUDE.md rule 3).
 *
 * The rule (CONTRIBUTING.md, "Adding a field report's shape"): a field report adds its shape here, as an
 * invented Forge shape, before its fix.
 */
export const FORGE_FIELD_DIR = fileURLToPath(
  new URL("../../../fixtures/forge-field", import.meta.url),
);

/** The shape card's words of the fixture: every flag a field report has named. */
export const FORGE_FIELD_SHAPE =
  "repos: 6-20 records: under-1k flags: gateway-proxies deploy-token-hosts repos-with-no-system dotted-ids nested-payloads ssh-origins https-origins non-gateway-callee legacy-slots hand-pairings empty-repo unread-repo";

/**
 * The fixture's options beside its shape: one more service, so both of the topic's consumers are
 * read from facts (the last service is the legacy one); the topic, the empty repo and the unread
 * repo of the archetypes (archetypes-changes.ts), so its new event is a change of this estate.
 */
export const FORGE_FIELD_OPTIONS: FieldEstateOptions = {
  shape: FORGE_FIELD_SHAPE,
  services: 5,
  topic: TOPIC,
  topicListeners: [3, 0],
  emptyRepo: EMPTY_REPO,
  unreadRepo: UNREAD_REPO,
  dollarTokens: 1,
  wrongBox: true,
  seed: 1,
};

/** The fixture's change: the archetypes' new event on the quick path, its four files written. */
export const FORGE_FIELD_CHANGE = NEW_EVENT;

/** change.yaml of a change `change new --from` made, at a fixed time. */
const quickChangeYaml = (id: string, title: string) =>
  [
    "schemaVersion: 1",
    `id: ${id}`,
    `title: ${title}`,
    "type: quick",
    "state: plan",
    "authors: {}",
    "createdAt: 2026-11-19T05:00:00Z",
    "createdBy: pat",
    "handoffs: []",
    "history:",
    "  - from: draft",
    "    to: plan",
    "    at: 2026-11-19T05:00:00Z",
    "    by: pat",
    "    reason: Created from requirements.md",
    "owners: {}",
    "systems: []",
    "touches:",
    "  dataStores: []",
    "  interfaces: []",
    "  records: []",
    "  repos: []",
    "  tables: []",
    "",
  ].join("\n");

/**
 * A clone's one commit, made the same on every machine: a fixed author, committer, date and
 * message, and the files as they are (LF: .gitattributes), so its id is the same where the
 * fixture is seeded as where it was written. The facts of a repo with a clone cite that commit.
 */
export function commitClone(dir: string): string {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Forge",
    GIT_AUTHOR_EMAIL: "forge@example.com",
    GIT_COMMITTER_NAME: "Forge",
    GIT_COMMITTER_EMAIL: "forge@example.com",
    GIT_AUTHOR_DATE: "2026-11-01T09:00:00Z",
    GIT_COMMITTER_DATE: "2026-11-01T09:00:00Z",
  };
  const git = (...a: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "core.autocrlf=false",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.filemode=false",
        ...a,
      ],
      { cwd: dir, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-qm", "Forge fixture");
  return git("rev-parse", "HEAD");
}

/** What `estate.json` says of the fixture: the estate without its folder. */
export type ForgeField = Omit<FieldEstate, "root" | "options"> & {
  /** The commit of each clone (`commitClone`), which its facts cite. */
  commits: Record<string, string>;
  /** The change the metarepo holds (on the quick path, its files written). */
  change: string;
  /** The repos whose clones are under `repos/`. */
  clones: string[];
  /** Every repo the manifest lists. */
  manifest: string[];
};

/** Files a made estate holds that are no input: git, the workspace, local state, the built catalog. */
const LEFT_OUT = [
  /^workspace\//,
  /^\.git\//,
  // The metarepo's own .gitignore keeps .atticus/ local but for metarepo.yaml.
  /^\.atticus\/(?!metarepo\.yaml$)/,
  /^\.index\//,
  /^\.runs\//,
  /^catalog\/generated\//,
];

/**
 * The metarepo's stamp. Its `atticus:` line is the version that made the fixture; the check
 * leaves that line out (`sameFixtureText`), so a release's version bump doesn't make it stale.
 */
export const STAMP = ".atticus/metarepo.yaml";

/** Two texts of a fixture file the same, but for the stamp's version line. */
export function sameFixtureText(path: string, a: string, b: string): boolean {
  const norm = (t: string) =>
    (path.endsWith(STAMP) ? t.replace(/^atticus: .*$/m, "atticus: <version>") : t).replace(
      /\r\n/g,
      "\n",
    );
  return norm(a) === norm(b);
}

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const n of await readdir(d).catch(() => [] as string[])) {
      const p = join(d, n);
      if ((await stat(p)).isDirectory()) await walk(p);
      else out.push(relative(dir, p).split(sep).join("/"));
    }
  };
  await walk(dir);
  return out.sort();
}

/**
 * Make the fixture's files in `out` (its metarepo/, repos/ and estate.json replaced; the README
 * kept): what the script writes and the check compares.
 */
export async function writeForgeField(out: string): Promise<void> {
  const tmp = await mkdtemp(join(tmpdir(), "b30-forge-field-"));
  try {
    const estate = await makeFieldEstate(tmp, FORGE_FIELD_OPTIONS);
    // Each clone a git repo at its one commit, and its facts of that commit.
    const commits: Record<string, string> = {};
    const workspace0 = join(estate.root, "workspace");
    for (const id of (await readdir(workspace0).catch(() => [] as string[])).sort()) {
      if (id === estate.emptyRepo) continue;
      const head = commitClone(join(workspace0, id));
      commits[id] = head;
      const path = join(factsDirOf(estate.root), `${id}.jsonl`);
      const facts = (await readFile(path, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((l) => ({ ...(JSON.parse(l) as Fact), commit: head }) as Fact);
      await writeFile(path, facts.map((f) => JSON.stringify(f)).join("\n") + "\n");
      for (const w of factsSnapshotWrites(estate.root, id, facts, {
        commit: head,
        contracts: null,
      })) {
        await mkdir(dirname(w.path), { recursive: true });
        await writeFile(w.path, w.text!);
      }
    }
    const c = FORGE_FIELD_CHANGE;
    await writeChangeFiles(estate.root, c.id, {
      "change.yaml": quickChangeYaml(c.id, c.title),
      "requirements.md": c.requirements,
      ...c.files,
    });
    // After the upgrade, as a team has it: the curated decisions field-estate.ts writes at an
    // older schema are migrated, so `atticus status` has nothing waiting on a fresh seed.
    const said: string[] = [];
    const io = { out: (l: string) => said.push(l), err: (l: string) => said.push(l) };
    const code = await main(["upgrade", "--root", estate.root, "--by", "pat"], io, { quiet: true });
    if (code !== 0)
      throw new Error(`atticus upgrade of the field estate failed: ${said.join("\n")}`);
    for (const n of ["metarepo", "repos", "estate.json"])
      await rm(join(out, n), { recursive: true, force: true });
    await mkdir(out, { recursive: true });
    for (const f of await filesUnder(estate.root)) {
      if (LEFT_OUT.some((re) => re.test(f))) continue;
      const to = join(out, "metarepo", ...f.split("/"));
      await mkdir(dirname(to), { recursive: true });
      const bytes = await readFile(join(estate.root, ...f.split("/")));
      // The upgrade's stamp at a fixed time, so the same code writes the same bytes.
      await writeFile(
        to,
        f === STAMP
          ? bytes.toString("utf8").replace(/^upgradedAt: .*$/m, "upgradedAt: 2026-11-19T05:00:00Z")
          : bytes,
      );
    }
    const workspace = join(estate.root, "workspace");
    const clones: string[] = [];
    for (const id of (await readdir(workspace).catch(() => [] as string[])).sort()) {
      const files = (await filesUnder(join(workspace, id))).filter((f) => !f.startsWith(".git/"));
      // The empty repo's clone holds nothing but its .git: seedForgeField makes it.
      if (!files.length) continue;
      clones.push(id);
      for (const f of files) {
        const to = join(out, "repos", id, ...f.split("/"));
        await mkdir(dirname(to), { recursive: true });
        await writeFile(to, await readFile(join(workspace, id, ...f.split("/"))));
      }
    }
    const manifest = [
      ...(
        await readFile(join(estate.root, "org-pack/profiles/github/repos.manifest.yaml"), "utf8")
      ).matchAll(/^ {2}- id: (\S+)$/gm),
    ].map((m) => m[1]!);
    const { root: _root, options: _options, ...rest } = estate;
    const info: ForgeField = { ...rest, change: c.id, commits, clones, manifest };
    await writeFile(join(out, "estate.json"), JSON.stringify(info, null, 2) + "\n");
  } finally {
    await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

/** The fixture's `estate.json`. */
export async function forgeFieldEstate(fixture = FORGE_FIELD_DIR): Promise<ForgeField> {
  return JSON.parse(await readFile(join(fixture, "estate.json"), "utf8")) as ForgeField;
}

/**
 * The fixture as a metarepo in `dir` (its `forge` folder): copied, the clones in the workspace,
 * the empty repo's clone with nothing in it, and the catalog built (unless `build: false`).
 */
export async function seedForgeField(
  dir: string,
  o: { build?: boolean; fixture?: string } = {},
): Promise<ForgeField & { root: string }> {
  const fixture = o.fixture ?? FORGE_FIELD_DIR;
  const estate = await forgeFieldEstate(fixture);
  const root = join(dir, "forge");
  await cp(join(fixture, "metarepo"), root, { recursive: true });
  for (const id of estate.clones) {
    const clone = join(root, "workspace", id);
    await cp(join(fixture, "repos", id), clone, { recursive: true });
    const head = commitClone(clone);
    if (head !== estate.commits[id])
      throw new Error(
        `${id}'s clone is at ${head}, not ${estate.commits[id]} as its facts say: the fixture's files changed (line ends?). Run node scripts/write-field-fixture.mjs.`,
      );
  }
  if (estate.emptyRepo)
    await mkdir(join(root, "workspace", estate.emptyRepo, ".git"), { recursive: true });
  if (o.build !== false) {
    const built = await buildAndWrite(root, { command: "atticus catalog build" });
    if (built.guard.refused) throw new Error("The field fixture's build was refused.");
  }
  return { ...estate, root };
}
