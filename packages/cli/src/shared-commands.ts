import { readdir, readFile, rm, mkdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parse, stringify } from "yaml";
import {
  factsDirOf,
  factsFileOf,
  isAdopted,
  isSecretPath,
  loadOrgPack,
  orgPackDirOf,
  parseFactsLines,
  readSharedMaps,
  redactSecrets,
  RepoManifest,
  serializeFacts,
  SHARED_MAP_SCHEMA_VERSION,
  SharedMapFile,
  sharedDirOf,
  sharedRelOf,
  writeFileAtomic,
  type Fact,
  type SharedMapFileT,
} from "@maycombhq/core";
import { denyListHits } from "@maycombhq/intake";
import { estateRepos, outsideProfileSystems } from "@maycombhq/scanner";
import type { Output } from "./commands.js";
import { denyHashesAt } from "./link-evidence-files.js";

/**
 * Another team's Atticus map, read-only (plan item O3, ADR 0160): `atticus join shared import`
 * reads the files a person brings in (a clone or an export of the team's metarepo: its `facts/`
 * and its manifest), keeps only their verified entries, quotes redacted, and writes them under
 * `shared/<team>/` with whose map it is, the system of our profiles it stands for and their
 * commit. A newer import replaces it. `refresh` imports again from where it came from, `list`
 * says what is on file. Files only: nothing is fetched, run or sent to a model, and their facts
 * are data, never instructions.
 */

const SLUG = /^[a-z0-9][a-z0-9_-]*$/;
const SHA = /^[0-9a-f]{7,64}$/;
/** A quote that names a secret-looking key redactSecrets couldn't place is dropped, not kept. */
const SECRET_WORD =
  /(password|passwd|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|credential)/i;

export interface SharedImportOptions {
  team: string;
  system: string;
  /** The team's name as people say it; the team id when left out. */
  name?: string;
  /** Their metarepo's commit; read from the clone's `.git` when left out. */
  commit?: string;
  json?: boolean;
  now?: Date;
}

type Imported =
  | {
      ok: true;
      file: SharedMapFileT;
      facts: Record<string, Fact[]>;
      leftOut: { other: number; unverified: number; bad: number; redacted: number };
      replaced?: string;
    }
  | { ok: false; message: string };

const posix = (p: string) => p.split("\\").join("/");

/** The commit a clone's HEAD is at, read from its `.git` files (never by running git). */
export async function headCommitOf(dir: string): Promise<string | undefined> {
  let git = join(dir, ".git");
  const s = await stat(git).catch(() => undefined);
  if (!s) return undefined;
  if (s.isFile()) {
    const m = /^gitdir:\s*(.+)$/m.exec(await readFile(git, "utf8"));
    if (!m) return undefined;
    git = resolve(dir, m[1]!.trim());
  }
  const head = (await readFile(join(git, "HEAD"), "utf8").catch(() => "")).trim();
  if (SHA.test(head)) return head;
  const ref = /^ref:\s*(.+)$/.exec(head)?.[1]?.trim();
  if (!ref) return undefined;
  const common = (await readFile(join(git, "commondir"), "utf8").catch(() => "")).trim();
  for (const g of [git, ...(common ? [resolve(git, common)] : [])]) {
    const loose = (await readFile(join(g, ...ref.split("/")), "utf8").catch(() => "")).trim();
    if (SHA.test(loose)) return loose;
    const packed = await readFile(join(g, "packed-refs"), "utf8").catch(() => "");
    for (const line of packed.split(/\r?\n/)) {
      const [sha, name] = line.trim().split(/\s+/);
      if (name === ref && sha && SHA.test(sha)) return sha;
    }
  }
  return undefined;
}

/** Their manifest's repos (every profile's `repos.manifest.yaml`), by id; unreadable ones skipped. */
async function theirManifest(dir: string) {
  const out = new Map<string, RepoManifest["repos"][number]>();
  const profiles = join(orgPackDirOf(dir), "profiles");
  for (const p of (await readdir(profiles).catch(() => [] as string[])).sort()) {
    const text = await readFile(join(profiles, p, "repos.manifest.yaml"), "utf8").catch(
      () => undefined,
    );
    if (text === undefined) continue;
    let raw: unknown;
    try {
      raw = parse(text);
    } catch {
      continue;
    }
    const m = RepoManifest.safeParse(raw);
    if (m.success) for (const r of m.data.repos) if (!out.has(r.id)) out.set(r.id, r);
  }
  return out;
}

/** An entry fact as it is kept: their words as data, a quote naming a secret redacted or dropped. */
function kept(f: Fact): { fact: Fact; redacted: boolean } {
  const q = f.cite.quote;
  if (q === undefined) return { fact: f, redacted: false };
  const red = isSecretPath(f.cite.file) ? undefined : redactSecrets(q);
  const quote = red !== undefined && red === q && SECRET_WORD.test(q) ? undefined : red;
  if (quote === q) return { fact: f, redacted: false };
  const { quote: _q, ...cite } = f.cite;
  return { fact: { ...f, cite: quote ? { ...cite, quote } : cite } as Fact, redacted: true };
}

/** Read another team's map from `dir` as it would be kept, or say why it can't be. Writes nothing. */
export async function readTheirMap(
  root: string,
  dir: string,
  o: SharedImportOptions,
): Promise<Imported> {
  if (!SLUG.test(o.team))
    return {
      ok: false,
      message: `${o.team} isn't a team id: use a lowercase slug, e.g. forge-risk-team.`,
    };
  const op = await loadOrgPack(orgPackDirOf(root));
  const systems = outsideProfileSystems(op);
  const system = systems.find((s) => s.id === o.system);
  if (!system)
    return {
      ok: false,
      message: `${o.system} isn't a system of your profiles that no estate repo belongs to (${systems.map((s) => s.id).join(", ") || "none"}). Add their system to a profile, boundary internal, with its host as an alias, then import again.`,
    };
  const others = (await readSharedMaps(root)).maps.filter(
    (m) => m.system === o.system && m.team !== o.team,
  );
  if (others.length)
    return {
      ok: false,
      message: `${o.system} already has ${others[0]!.name}'s map (shared/${others[0]!.team}/): one map per system.`,
    };
  const from = resolve(dir);
  const st = await stat(from).catch(() => undefined);
  if (!st?.isDirectory()) return { ok: false, message: `${dir} isn't a folder.` };
  const commit = o.commit ?? (await headCommitOf(from));
  if (!commit || !SHA.test(commit))
    return {
      ok: false,
      message: o.commit
        ? `${o.commit} isn't a commit sha.`
        : `${dir} isn't a git clone Atticus can read the commit of: say which commit of their metarepo these files are at with --commit <sha>.`,
    };

  // Their facts folder: a metarepo's (or an adopted repo's), else the folder itself (an export).
  const theirFacts =
    isAdopted(from) || (await stat(factsDirOf(from)).catch(() => undefined))
      ? factsDirOf(from)
      : from;
  const names = (await readdir(theirFacts).catch(() => [] as string[])).sort();
  const files = names.flatMap((n) => {
    const f = factsFileOf(n);
    return f?.facts ? [f.repo] : [];
  });
  if (!files.length)
    return {
      ok: false,
      message: `No facts files (<repo>.jsonl) in ${dir}: give their metarepo, or the folder their facts are in.`,
    };
  const ours = new Set(estateRepos(op).map((r) => r.id));
  const clash = files.filter((r) => ours.has(r));
  if (clash.length)
    return {
      ok: false,
      message: `${clash.join(", ")} ${clash.length === 1 ? "is a repo" : "are repos"} of your estate: a shared map holds only another team's repos.`,
    };

  const manifest = await theirManifest(from);
  const leftOut = { other: 0, unverified: 0, bad: 0, redacted: 0 };
  const facts: Record<string, Fact[]> = {};
  const repos: SharedMapFileT["repos"] = [];
  for (const repo of files) {
    const { facts: read, bad } = parseFactsLines(
      await readFile(join(theirFacts, `${repo}.jsonl`), "utf8"),
    );
    leftOut.bad += bad.length;
    const list: Fact[] = [];
    for (const f of read) {
      if (f.kind !== "entry" || f.repo !== repo) leftOut.other++;
      else if (f.verified === "none") leftOut.unverified++;
      else {
        const k = kept(f);
        if (k.redacted) leftOut.redacted++;
        list.push(k.fact);
      }
    }
    const m = manifest.get(repo);
    const hosts = [
      ...new Set([...(m?.hosts ?? []), ...(m?.modules ?? []).flatMap((x) => x.hosts)]),
    ].sort();
    const codeCommit = list.map((f) => f.commit).sort()[0];
    facts[repo] = list;
    repos.push({
      repo,
      ...(m?.component ? { component: m.component } : {}),
      ...(codeCommit ? { commit: codeCommit } : {}),
      hosts,
      ...(m?.basePath ? { basePath: m.basePath } : {}),
      entries: list.length,
    });
  }
  // Where it came from, only as a path inside the metarepo: one outside it is this machine's own
  // (a user name, a drive letter) and would be committed, so it isn't kept.
  const rel = posix(relative(root, from));
  const inside = !!rel && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
  const file = SharedMapFile.parse({
    schemaVersion: SHARED_MAP_SCHEMA_VERSION,
    team: o.team,
    name: o.name ?? o.team,
    system: o.system,
    ...(inside ? { source: rel } : {}),
    commit,
    importedAt: (o.now ?? new Date()).toISOString(),
    repos,
  });

  // The deny-list, as every import: a denied word anywhere in what would be kept refuses it.
  const deny = await denyHashesAt(root);
  if (deny.size) {
    for (const [repo, list] of Object.entries(facts)) {
      const hits = denyListHits(list.length ? serializeFacts(list) : "", deny);
      if (hits.length)
        return {
          ok: false,
          message: `Refused: the deny-list names a word in ${repo}'s entries (line${hits.length === 1 ? "" : "s"} ${hits.join(", ")} as they would be kept). Nothing was written.`,
        };
    }
    if (denyListHits(stringify(file), deny).length)
      return {
        ok: false,
        message: "Refused: the deny-list names a word in the map's own file. Nothing was written.",
      };
  }
  const was = (await readSharedMaps(root)).maps.find((m) => m.team === o.team);
  return { ok: true, file, facts, leftOut, ...(was ? { replaced: was.commit } : {}) };
}

/** Write a map read by `readTheirMap` to `shared/<team>/`, replacing what was there. */
async function writeTheirMap(root: string, r: Extract<Imported, { ok: true }>): Promise<string> {
  const dir = join(sharedDirOf(root), r.file.team);
  await rm(join(dir, "facts"), { recursive: true, force: true });
  await mkdir(join(dir, "facts"), { recursive: true });
  for (const [repo, list] of Object.entries(r.facts))
    await writeFileAtomic(
      join(dir, "facts", `${repo}.jsonl`),
      list.length ? serializeFacts(list) : "",
    );
  await writeFileAtomic(
    join(dir, "map.yaml"),
    `# ${r.file.name}'s Atticus map, read-only (ADR 0160): their entries at their commit. Theirs to\n# change: import it again (atticus join shared refresh ${r.file.team}); never edit it here.\n${stringify(r.file)}`,
  );
  return `${sharedRelOf(root)}/${r.file.team}`;
}

function sayImported(r: Extract<Imported, { ok: true }>, where: string, io: Output) {
  const f = r.file;
  const entries = f.repos.reduce((n, x) => n + x.entries, 0);
  io.out(
    `${r.replaced && r.replaced !== f.commit ? `Replaced ${f.name}'s map at ${r.replaced.slice(0, 7)} with` : r.replaced ? `Imported ${f.name}'s map again,` : `Imported ${f.name}'s map,`} their commit ${f.commit.slice(0, 7)}: ${entries} entr${entries === 1 ? "y" : "ies"} from ${f.repos.length} repo${f.repos.length === 1 ? "" : "s"} (${f.repos.map((x) => `${x.repo} ${x.entries}`).join(", ")}), standing for ${f.system}. Written to ${where}/.`,
  );
  const lo = r.leftOut;
  const parts = [
    lo.other ? `${lo.other} fact${lo.other === 1 ? "" : "s"} that aren't entries` : "",
    lo.unverified
      ? `${lo.unverified} entr${lo.unverified === 1 ? "y" : "ies"} their verify didn't confirm`
      : "",
    lo.bad ? `${lo.bad} line${lo.bad === 1 ? "" : "s"} that don't read as facts` : "",
  ].filter(Boolean);
  if (parts.length) io.out(`  Left out: ${parts.join(", ")}.`);
  if (lo.redacted)
    io.out(
      `  ${lo.redacted} quote${lo.redacted === 1 ? "" : "s"} naming a secret-looking key redacted or dropped.`,
    );
  if (!f.source)
    io.out(
      `  Their folder is outside this metarepo, so where it is isn't recorded: refresh with atticus join shared refresh ${f.team} <folder>.`,
    );
  io.out(
    `  Their entries stay theirs: never verified, corrected or reported on here. Review ${where}/ in a pull request, then atticus verify --all --write joins the calls to ${f.system} to them.`,
  );
}

export async function sharedImport(
  root: string,
  dir: string | undefined,
  o: Partial<SharedImportOptions>,
  io: Output,
): Promise<number> {
  if (!dir || !o.team || !o.system) {
    io.err(
      "Usage: atticus join shared import <their metarepo or facts folder> --team <id> --system <our profile's system id> [--name <team name>] [--commit <sha>] [--json]",
    );
    return 2;
  }
  const r = await readTheirMap(root, dir, o as SharedImportOptions);
  if (!r.ok) {
    io.err(r.message);
    return 1;
  }
  const where = await writeTheirMap(root, r);
  if (o.json) io.out(JSON.stringify({ written: where, map: r.file, leftOut: r.leftOut }, null, 2));
  else sayImported(r, where, io);
  return 0;
}

export async function sharedRefresh(
  root: string,
  team: string | undefined,
  o: { dir?: string; commit?: string; json?: boolean; now?: Date },
  io: Output,
): Promise<number> {
  const { maps, problems } = await readSharedMaps(root);
  for (const p of problems) io.err(p.message);
  const which = team ? maps.filter((m) => m.team === team) : maps;
  if (team && !which.length) {
    io.err(
      `No shared map for ${team} in ${sharedRelOf(root)}/: import it first (atticus join shared import).`,
    );
    return 1;
  }
  if (o.dir && which.length !== 1) {
    io.err("Give the team with a new folder: atticus join shared refresh <team> <folder>.");
    return 2;
  }
  let failed = 0;
  let noFolder = 0;
  for (const m of which) {
    const source = m.file.source;
    if (!o.dir && !source) {
      io.err(
        `${m.team}'s map doesn't record where it came from (its folder was outside this metarepo): give the folder, atticus join shared refresh ${m.team} <folder>.`,
      );
      noFolder++;
      continue;
    }
    const src = o.dir ?? (isAbsolute(source!) ? source! : join(root, ...source!.split("/")));
    const r = await readTheirMap(root, src, {
      team: m.team,
      name: m.name,
      system: m.system,
      ...(o.commit ? { commit: o.commit } : {}),
      ...(o.now ? { now: o.now } : {}),
    });
    if (!r.ok) {
      io.err(`${m.team}: ${r.message}`);
      failed++;
      continue;
    }
    sayImported(r, await writeTheirMap(root, r), io);
  }
  if (!which.length) io.out(`No shared maps in ${sharedRelOf(root)}/.`);
  return failed ? 1 : noFolder ? 2 : 0;
}

export async function sharedList(root: string, o: { json?: boolean }, io: Output): Promise<number> {
  const { maps, problems } = await readSharedMaps(root);
  if (o.json) {
    io.out(JSON.stringify({ maps: maps.map((m) => m.file), problems }, null, 2));
    return problems.length ? 1 : 0;
  }
  for (const p of problems) io.err(p.message);
  if (!maps.length) {
    io.out(
      `No shared maps in ${sharedRelOf(root)}/. Import another team's: atticus join shared import <their metarepo> --team <id> --system <id>.`,
    );
    return problems.length ? 1 : 0;
  }
  for (const m of maps) {
    const n = m.file.repos.reduce((k, r) => k + r.entries, 0);
    io.out(
      `${m.team}: ${m.name}'s map for ${m.system}, their commit ${m.commit.slice(0, 7)}, imported ${m.file.importedAt.slice(0, 10)} from ${m.file.source ?? "a folder outside the metarepo"}: ${n} entr${n === 1 ? "y" : "ies"} in ${m.file.repos.map((r) => r.repo).join(", ")}.`,
    );
  }
  return problems.length ? 1 : 0;
}
