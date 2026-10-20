import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parse } from "yaml";
import {
  FrameworkModel,
  loadOrgPack,
  orgPackDirOf,
  RecordId,
  toCanonicalYaml,
} from "@maycombhq/core";
import {
  houseDependencies,
  learnFramework,
  learnFrameworkFromJar,
  runFrameworkTests,
} from "@maycombhq/extractors";
import {
  exportFrameworksKit,
  formatFrameworkSurvey,
  surveyFrameworks,
} from "@maycombhq/assistant-kit";
import { fsRepo } from "@maycombhq/sdk";
import { baseClonePath } from "@maycombhq/workspace";
import type { Output } from "./commands.js";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Merge what was learned into what is there: a learned entry replaces one of the same name
 * (code beats a document or a person); everything else already there is kept.
 */
function merge(
  existing: FrameworkModel | undefined,
  learned: FrameworkModel,
): { model: FrameworkModel; keptServices: number; keptOther: number } {
  if (!existing) return { model: learned, keptServices: 0, keptOther: 0 };
  const byName = <T extends { name: string }>(a: T[], b: T[]) => [
    ...b,
    ...a.filter((x) => !b.some((y) => y.name === x.name)),
  ];
  const clientKey = (c: FrameworkModel["clients"][number]) => `${c.type}.${c.method}`;
  const clients = [
    ...learned.clients,
    ...existing.clients.filter((c) => !learned.clients.some((l) => clientKey(l) === clientKey(c))),
  ];
  const keptServices = Object.keys(existing.services).filter((k) => !(k in learned.services));
  const keptOther =
    existing.annotations.filter((a) => !learned.annotations.some((l) => l.name === a.name)).length +
    (clients.length - learned.clients.length) +
    Object.keys(existing.constants).filter((k) => !(k in learned.constants)).length;
  return {
    model: FrameworkModel.parse({
      ...learned,
      packages: [...new Set([...learned.packages, ...existing.packages])],
      artifacts: [...new Set([...learned.artifacts, ...existing.artifacts])],
      annotations: byName(existing.annotations, learned.annotations).sort((a, b) =>
        a.name < b.name ? -1 : 1,
      ),
      clients,
      services: { ...existing.services, ...learned.services },
      constants: { ...existing.constants, ...learned.constants },
      tests: existing.tests,
    }),
    keptServices: keptServices.length,
    keptOther,
  };
}

/**
 * atticus frameworks learn <name> --from <repo> [--package p] [--dry-run]: read a house
 * starter's source and write what it means to org-pack/frameworks/<name>.yaml (ADR 0054).
 */
export async function frameworksLearn(
  root: string,
  name: string,
  from: string,
  o: { packages?: string[]; dryRun?: boolean },
  io: Output,
): Promise<number> {
  if (!RecordId.safeParse(name).success) {
    io.err(
      `"${name}" isn't a framework name: use lower case, digits and dashes, e.g. tide-platform`,
    );
    return 2;
  }
  const dir = resolve(from);
  const info = await stat(dir).catch(() => undefined);
  const isJar = !!info?.isFile() && /\.jar$/i.test(dir);
  if (!info?.isDirectory() && !isJar) {
    io.err(
      `${from} isn't a folder or a .jar: give the starter's source or its JAR, e.g. --from workspace/tide-platform`,
    );
    return 2;
  }
  const opts = { name, ...(o.packages?.length ? { packages: o.packages } : {}) };
  let learned: Awaited<ReturnType<typeof learnFramework>>;
  try {
    learned = isJar
      ? learnFrameworkFromJar(await readFile(dir), { ...opts, jarName: basename(dir) })
      : await learnFramework(fsRepo(basename(dir), dir, "0".repeat(40)), opts);
  } catch (e) {
    io.err(`${from} couldn't be read: ${(e as Error).message}`);
    return 1;
  }
  return writeLearned(root, name, learned, basename(dir), isJar, !!o.dryRun, io);
}

/** Merge a learned model into org-pack/frameworks/<name>.yaml (or say what would be written). */
async function writeLearned(
  root: string,
  name: string,
  learned: { model: FrameworkModel; notes: string[] },
  from: string,
  isJar: boolean,
  dryRun: boolean,
  io: Output,
): Promise<number> {
  const rel = `org-pack/frameworks/${name}.yaml`;
  const file = join(orgPackDirOf(root), "frameworks", `${name}.yaml`);
  let existing: FrameworkModel | undefined;
  try {
    existing = FrameworkModel.parse(parse(await readFile(file, "utf8")));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      io.err(
        `${rel} isn't a valid framework model (${(e as Error).message.split("\n")[0]}); fix or remove it first.`,
      );
      return 1;
    }
  }
  const { model, keptServices, keptOther } = merge(existing, learned.model);
  const m = learned.model;
  const what = `${plural(m.annotations.length, "annotation")}, ${plural(m.clients.length, "wrapper method")}, ${plural(Object.keys(m.constants).length, "constant")} (all from ${isJar ? "bytecode" : "code"})`;
  const keptParts = [
    ...(keptServices ? [plural(keptServices, "service")] : []),
    ...(keptOther ? [plural(keptOther, "other entry", "other entries")] : []),
  ];
  const keptText = keptParts.length ? `; kept ${keptParts.join(" and ")} a person added` : "";
  if (dryRun) {
    io.out(`Dry run: would write ${rel} from ${from}: ${what}${keptText}.`);
  } else {
    await mkdir(join(orgPackDirOf(root), "frameworks"), { recursive: true });
    await writeFile(file, toCanonicalYaml(model, ["schemaVersion", "name"]), "utf8");
    io.out(`Wrote ${rel} from ${from}: ${what}${keptText}.`);
  }
  for (const n of learned.notes) io.out(`note: ${n}`);
  if (m.annotations.length + m.clients.length === 0)
    io.out(
      "note: nothing in it reads as an annotation or a client the scanner knows; check --from is the starter's source.",
    );
  return 0;
}

/** Where a JAR of group:artifact:version can be, offline: given folders, then Maven's and Gradle's caches. */
async function findJar(
  d: { group: string; artifact: string; version: string },
  o: { jars: string[]; home: string },
): Promise<string | undefined> {
  const file = `${d.artifact}-${d.version}.jar`;
  const search = async (dir: string, depth: number): Promise<string | undefined> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1)))
      if (e.isFile() && e.name === file) return join(dir, e.name);
    if (depth > 0)
      for (const e of entries)
        if (e.isDirectory()) {
          const hit = await search(join(dir, e.name), depth - 1);
          if (hit) return hit;
        }
    return undefined;
  };
  for (const dir of o.jars) {
    const hit = await search(resolve(dir), 6);
    if (hit) return hit;
  }
  const m2 = join(o.home, ".m2", "repository", ...d.group.split("."), d.artifact, d.version, file);
  if ((await stat(m2).catch(() => undefined))?.isFile()) return m2;
  return search(
    join(o.home, ".gradle", "caches", "modules-2", "files-2.1", d.group, d.artifact, d.version),
    1,
  );
}

/** Newest first, comparing numeric parts: 3.10.0 > 3.9.1. */
const byVersion = (a: string, b: string) => {
  const pa = a.split(/[.-]/);
  const pb = b.split(/[.-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? "";
    const y = pb[i] ?? "";
    const nx = Number(x);
    const ny = Number(y);
    const c = !Number.isNaN(nx) && !Number.isNaN(ny) ? ny - nx : y.localeCompare(x);
    if (c !== 0) return c;
  }
  return 0;
};

/**
 * atticus frameworks discover --group <prefix>[,...] [--jars <dir>]... [--learn] [--json]: the
 * house artifacts the estate's repos build on, which repos use which version, and where each
 * JAR is on this machine (given folders, Maven's and Gradle's caches). Offline: a JAR that isn't
 * here is named, never downloaded. With --learn, each JAR found is learned (ADR 0054).
 */
export async function frameworksDiscover(
  root: string,
  o: { groups: string[]; jars?: string[]; learn?: boolean; json?: boolean; home?: string },
  io: Output,
): Promise<number> {
  if (o.groups.length === 0) {
    io.err(
      "frameworks discover needs your house group, for example: atticus frameworks discover --group tide.platform",
    );
    return 2;
  }
  const op = await loadOrgPack(orgPackDirOf(root));
  const repos = op.profiles.flatMap((p) => (p.repos?.repos ?? []).filter((r) => !r.archived));
  const used = new Map<
    string,
    { group: string; artifact: string; versions: Map<string, Set<string>> }
  >();
  const missing: string[] = [];
  for (const r of repos) {
    const dir = baseClonePath(root, r.id);
    if (!(await stat(dir).catch(() => undefined))?.isDirectory()) {
      missing.push(r.id);
      continue;
    }
    for (const d of await houseDependencies(fsRepo(r.id, dir, "0".repeat(40)), o.groups)) {
      const k = `${d.group}:${d.artifact}`;
      const u = used.get(k) ?? { group: d.group, artifact: d.artifact, versions: new Map() };
      const v = d.version ?? "(managed)";
      u.versions.set(v, (u.versions.get(v) ?? new Set()).add(r.id));
      used.set(k, u);
    }
  }
  const home = o.home ?? homedir();
  const rows: {
    artifact: string;
    versions: { version: string; repos: string[] }[];
    jar?: string;
    version?: string;
  }[] = [];
  for (const [k, u] of [...used].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const versions = [...u.versions.keys()].filter((v) => v !== "(managed)").sort(byVersion);
    let jar: string | undefined;
    let version: string | undefined;
    for (const v of versions) {
      jar = await findJar(
        { group: u.group, artifact: u.artifact, version: v },
        { jars: o.jars ?? [], home },
      );
      if (jar) {
        version = v;
        break;
      }
    }
    rows.push({
      artifact: k,
      versions: [...u.versions].map(([version, rs]) => ({ version, repos: [...rs].sort() })),
      ...(jar ? { jar, version } : {}),
    });
  }
  if (o.json) io.out(JSON.stringify({ artifacts: rows, notCloned: missing }, null, 2));
  else {
    if (rows.length === 0) io.out(`No repo here declares an artifact of ${o.groups.join(", ")}.`);
    for (const r of rows) {
      io.out(
        `${r.artifact}: ${r.versions.map((v) => `${v.version} in ${v.repos.join(", ")}`).join("; ")}`,
      );
      const [g, a] = r.artifact.split(":");
      const wanted = r.versions.find((v) => v.version !== "(managed)")?.version;
      io.out(
        r.jar
          ? `  JAR: ${r.jar}`
          : `  JAR: not on this machine. Put ${a}-${wanted ?? "<version>"}.jar (from your artifact repository) in a folder and pass --jars <folder>; ${g}:${a} isn't downloaded.`,
      );
    }
    if (missing.length)
      io.out(`Not cloned here, so not read: ${missing.join(", ")} (atticus workspace sync).`);
  }
  if (!o.learn) return 0;
  let code = 0;
  for (const r of rows.filter((x) => x.jar)) {
    const name = r.artifact.split(":")[1]!;
    try {
      const learned = learnFrameworkFromJar(await readFile(r.jar!), {
        name,
        jarName: basename(r.jar!),
      });
      code = Math.max(
        code,
        await writeLearned(root, name, learned, basename(r.jar!), true, false, io),
      );
    } catch (e) {
      io.err(`${r.jar} couldn't be read: ${(e as Error).message}`);
      code = 1;
    }
  }
  return code;
}

/**
 * atticus frameworks check [<name>]: run each framework model's own tests (ADR 0055). A model
 * whose tests fail, or with a drafted entry no test exercises, is left out of scans until they
 * pass; one with no tests is used as written, and said so.
 */
export async function frameworksCheck(
  root: string,
  name: string | undefined,
  io: Output,
): Promise<number> {
  const op = await loadOrgPack(orgPackDirOf(root));
  let bad = 0;
  for (const p of op.problems.filter((x) => x.file.startsWith("frameworks/"))) {
    io.err(`org-pack/${p.file}: ${p.path ? `${p.path}: ` : ""}${p.message}`);
    bad++;
  }
  const models = op.frameworks.filter((m) => !name || m.name === name);
  if (name && models.length === 0) {
    io.err(
      `There's no framework model named ${name} in org-pack/frameworks/ (or it isn't valid; see above).`,
    );
    return 2;
  }
  if (models.length === 0 && bad === 0) {
    io.out(
      "There are no framework models in org-pack/frameworks/ yet: atticus frameworks learn or frameworks kit makes one.",
    );
    return 0;
  }
  for (const m of models) {
    if (m.tests.length === 0) {
      io.out(
        `${m.name}: no tests. Scans use it as written; add tests so a wrong entry can't go unnoticed.`,
      );
      continue;
    }
    const failures = await runFrameworkTests(m);
    if (failures.length === 0) {
      io.out(
        `${m.name}: ${plural(m.tests.length, "test")} ${m.tests.length === 1 ? "passes" : "pass"}; every drafted entry is exercised.`,
      );
      continue;
    }
    bad++;
    for (const f of failures) io.err(`${m.name}: test "${f.test}": ${f.message}`);
    io.err(`${m.name} isn't used by scans until its tests pass.`);
  }
  return bad > 0 ? 1 : 0;
}

/**
 * atticus frameworks survey [--package <prefix>[,...]] [--json]: how the estate's repos use
 * house frameworks, in any language (ADR 0055): the house modules they import, which model
 * covers each, and how each imported name is called or annotated, with a sample line. What an
 * assistant drafting a model starts from; nothing is guessed.
 */
export async function frameworksSurvey(
  root: string,
  o: { prefixes: string[]; json?: boolean },
  io: Output,
): Promise<number> {
  const op = await loadOrgPack(orgPackDirOf(root));
  const handles = [];
  const missing: string[] = [];
  for (const r of op.profiles.flatMap((p) => (p.repos?.repos ?? []).filter((x) => !x.archived))) {
    const dir = baseClonePath(root, r.id);
    if ((await stat(dir).catch(() => undefined))?.isDirectory())
      handles.push(fsRepo(r.id, dir, "0".repeat(40)));
    else missing.push(r.id);
  }
  const survey = await surveyFrameworks(handles, {
    prefixes: o.prefixes,
    models: op.frameworks,
  });
  if (o.json) {
    io.out(JSON.stringify({ ...survey, notCloned: missing }, null, 2));
    return 0;
  }
  for (const l of formatFrameworkSurvey(survey)) io.out(l);
  if (missing.length)
    io.out(
      `Not cloned, so not surveyed: ${missing.sort().join(", ")} (atticus workspace sync clones them).`,
    );
  return 0;
}

/** atticus frameworks kit [dir]: export the framework-model kit for an assistant. */
export async function frameworksKit(outDir: string, io: Output): Promise<number> {
  const files = await exportFrameworksKit(outDir);
  io.out(`Wrote the framework-model kit (${plural(files.length, "file")}) to ${outDir}`);
  return 0;
}
