import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { parse } from "yaml";
import { FrameworkModel } from "./schema/frameworks.js";
import { ScanSettings } from "./schema/scan-settings.js";
import { RepoType } from "./schema/repo-type.js";
import { ComponentType, type LoadedComponentType } from "./schema/component-type.js";
import { ModelProviderPlugin, ScannerPlugin } from "./schema/plugin.js";
import { SpecTemplate } from "./schema/spec.js";
import type { z } from "zod";
import {
  DEFAULT_CHANGE_TYPES,
  DEFAULT_GATES,
  DEFAULT_ROLES,
  DEFAULT_RUNTIME,
  DEFAULT_SOURCES,
  DEFAULT_TEST_STRATEGY,
} from "./orgpack-defaults.js";
import { AgentDefinition } from "./schema/ai.js";
import { Dialect } from "./schema/dialect.js";
import {
  BUILT_IN_ROLES,
  ChangeTypes,
  Estimates,
  Gates,
  OpenSpecSettings,
  IntegrationPattern,
  PackManifest,
  Procedure,
  Profile,
  Roles,
  Runtime,
  ServiceRequestTemplate,
  SkillMeta,
  Sources,
  TestStrategy,
} from "./schema/orgpack.js";
import { ChecklistPack } from "./schema/review.js";
import { RepoManifest } from "./schema/workspace.js";
import { Conventions, DEFAULT_CONVENTIONS } from "./schema/conventions.js";

export interface OrgPackProblem {
  /** File relative to the org-pack folder. */
  file: string;
  path: string;
  message: string;
}

export interface OrgPack {
  pack?: PackManifest;
  /** Deprecated (ADR 0073): loaded and validated when present, read by nothing. */
  roles: Roles;
  changeTypes: z.infer<typeof ChangeTypes>;
  gates: z.infer<typeof Gates>;
  runtime: Runtime;
  sources: z.infer<typeof Sources>;
  testStrategy: z.infer<typeof TestStrategy>;
  profiles: { profile?: Profile; repos?: RepoManifest; platform: string }[];
  patterns: IntegrationPattern[];
  dialects: Dialect[];
  /** Framework models (ADR 0054), from frameworks/. */
  frameworks: FrameworkModel[];
  /** Scan settings per repo (ADR 0075), from scan/<repo>.yaml. */
  scanSettings: ScanSettings[];
  /** Repo types (ADR 0077), from repo-types/<id>/type.yaml. */
  repoTypes: RepoType[];
  /** The organisation's component types (ADR 0180), from component-types/<id>/type.yaml, with their notes.md. */
  componentTypes: LoadedComponentType[];
  /** Scanner plugins (ADR 0080), from plugins/<id>/plugin.yaml, with their folders. */
  plugins: { manifest: ScannerPlugin; dir: string }[];
  /** Model-provider plugins (ADR 0121 item 4): plugins/model-providers/<id>/plugin.yaml. */
  modelProviders: { manifest: ModelProviderPlugin; dir: string }[];
  /** Spec templates (ADR 0079), from repo-types/<id>/spec-template.yaml; a type may have none. */
  specTemplates: SpecTemplate[];
  checklists: ChecklistPack[];
  skills: (z.infer<typeof SkillMeta> & { body: string })[];
  serviceRequests: z.infer<typeof ServiceRequestTemplate>[];
  /** Procedures (ADR 0033), from process/procedures/. */
  procedures: Procedure[];
  agents: AgentDefinition[];
  /**
   * The house conventions a read leans on (ADR 0147), from conventions.yaml: the built-in lists
   * when the pack has none. Optional so a pack built in code (a test's) needs none.
   */
  conventions?: Conventions;
  /** Files that came from built-in defaults because the pack doesn't have them. */
  defaulted: string[];
  problems: OrgPackProblem[];
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

async function listFiles(dir: string, re: RegExp): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string) {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (re.test(e.name)) out.push(full);
    }
  }
  await walk(dir);
  return out;
}

/**
 * Read and validate a whole org pack. Never throws for content problems: every schema or
 * cross-file problem is listed in `problems` with its file, so a team sees all of them at
 * once. Missing files fall back to the built-in defaults.
 */
export async function loadOrgPack(dir: string): Promise<OrgPack> {
  const problems: OrgPackProblem[] = [];
  const defaulted: string[] = [];
  const rel = (p: string) => relative(dir, p).split(sep).join("/");

  async function load<T>(path: string, schema: z.ZodType<T>): Promise<T | undefined> {
    let data: unknown;
    try {
      data = parse(await readFile(path, "utf8"));
    } catch (e) {
      problems.push({
        file: rel(path),
        path: "",
        message: `can't read YAML: ${(e as Error).message.split("\n")[0]}`,
      });
      return undefined;
    }
    const r = schema.safeParse(data);
    if (!r.success) {
      for (const i of r.error.issues)
        problems.push({ file: rel(path), path: i.path.map(String).join("."), message: i.message });
      return undefined;
    }
    return r.data;
  }

  async function single<T>(name: string, schema: z.ZodType<T>, fallback: T): Promise<T> {
    const path = join(dir, name);
    if (!(await exists(path))) {
      defaulted.push(name);
      return fallback;
    }
    return (await load(path, schema)) ?? fallback;
  }

  const pack = (await exists(join(dir, "pack.yaml")))
    ? await load(join(dir, "pack.yaml"), PackManifest)
    : undefined;
  // roles.yaml is deprecated (ADR 0073): a pack that has it still loads and validates, nothing
  // reads it, and a pack without it isn't missing anything, so it is never "defaulted".
  const roles = (await exists(join(dir, "roles.yaml")))
    ? ((await load(join(dir, "roles.yaml"), Roles)) ?? DEFAULT_ROLES)
    : DEFAULT_ROLES;
  const changeTypes = await single("change-types.yaml", ChangeTypes, DEFAULT_CHANGE_TYPES);
  const gates = await single("gates.yaml", Gates, DEFAULT_GATES);
  const runtime = await single("runtime.yaml", Runtime, DEFAULT_RUNTIME);
  const sources = await single("sources.yaml", Sources, DEFAULT_SOURCES);
  const testStrategy = await single("test-strategy.yaml", TestStrategy, DEFAULT_TEST_STRATEGY);
  // ADR 0147: optional, and never "defaulted": a pack without it reads as Atticus always did.
  const conventions = (await exists(join(dir, "conventions.yaml")))
    ? ((await load(join(dir, "conventions.yaml"), Conventions)) ?? DEFAULT_CONVENTIONS)
    : DEFAULT_CONVENTIONS;

  const profiles: OrgPack["profiles"] = [];
  let platforms: string[] = [];
  try {
    platforms = (await readdir(join(dir, "profiles"), { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    // no profiles yet
  }
  for (const platform of platforms) {
    const p = join(dir, "profiles", platform);
    const profile = (await exists(join(p, "profile.yaml")))
      ? await load(join(p, "profile.yaml"), Profile)
      : undefined;
    const repos = (await exists(join(p, "repos.manifest.yaml")))
      ? await load(join(p, "repos.manifest.yaml"), RepoManifest)
      : undefined;
    for (const [what, platformId] of [
      ["profile.yaml", profile?.platform],
      ["repos.manifest.yaml", repos?.platform],
    ] as const) {
      if (platformId && platformId !== platform) {
        problems.push({
          file: `profiles/${platform}/${what}`,
          path: "platform",
          message: `says ${platformId} but sits in profiles/${platform}`,
        });
      }
    }
    profiles.push({ platform, ...(profile ? { profile } : {}), ...(repos ? { repos } : {}) });
  }

  // Review round 41: the file each loaded record came from, relative to the pack, so a problem
  // names the real file (a record's id need not be its file name, and subfolders are read).
  // Kept here, beside the records: the C6 records themselves stay as validated.
  const fileOf = new WeakMap<object, string>();
  const many = async <T extends object>(sub: string, re: RegExp, schema: z.ZodType<T>) => {
    const out: T[] = [];
    for (const f of await listFiles(join(dir, sub), re)) {
      const v = await load(f, schema);
      if (!v) continue;
      fileOf.set(v, rel(f));
      out.push(v);
    }
    return out;
  };
  const fileFor = (v: object, fallback: string) => fileOf.get(v) ?? fallback;
  /**
   * Review round 41: two files of one name (a copy in a subfolder, say) are a problem on the
   * later file, naming the first; only the first is loaded, as files are read in order.
   */
  const firstOfName = <T extends object>(items: T[], nameOf: (v: T) => string, what: string) => {
    const seen = new Map<string, string>();
    return items.filter((v) => {
      const name = nameOf(v);
      const first = seen.get(name);
      if (first === undefined) {
        seen.set(name, fileFor(v, ""));
        return true;
      }
      problems.push({
        file: fileFor(v, ""),
        path: "name",
        message: `${what} ${name} is also in ${first}; only that one is loaded`,
      });
      return false;
    });
  };
  const patterns = await many("patterns", /\.ya?ml$/, IntegrationPattern);
  const dialects = firstOfName(
    await many("dialects", /\.ya?ml$/, Dialect),
    (d) => d.name,
    "dialect",
  );
  const frameworks = await many("frameworks", /\.ya?ml$/, FrameworkModel);
  // One file per repo, named after it: a file whose repo doesn't match its name is refused.
  const scanSettings: ScanSettings[] = [];
  for (const f of await listFiles(join(dir, "scan"), /\.ya?ml$/)) {
    const v = await load(f, ScanSettings);
    if (!v) continue;
    const name = basename(f).replace(/\.ya?ml$/, "");
    if (v.repo !== name)
      problems.push({
        file: rel(f),
        path: "repo",
        message: `is for ${v.repo}; name it scan/${v.repo}.yaml`,
      });
    else scanSettings.push(v);
  }
  // Scanner plugins (ADR 0080): one folder per plugin, named after its id. Only the top
  // plugin.yaml of each folder: anything under test/ is a test repo's data.
  const plugins: OrgPack["plugins"] = [];
  const pluginDirs = await readdir(join(dir, "plugins"), { withFileTypes: true }).catch(() => []);
  for (const e of pluginDirs.sort((a, b) => a.name.localeCompare(b.name))) {
    const f = join(dir, "plugins", e.name, "plugin.yaml");
    if (!e.isDirectory() || !(await exists(f))) continue;
    const v = await load(f, ScannerPlugin);
    if (!v) continue;
    if (v.id !== e.name)
      problems.push({
        file: rel(f),
        path: "id",
        message: `is ${v.id}; keep it in plugins/${v.id}/`,
      });
    else plugins.push({ manifest: v, dir: join(dir, "plugins", e.name) });
  }
  const modelProviders: OrgPack["modelProviders"] = [];
  const mpRoot = join(dir, "plugins", "model-providers");
  const mpDirs = await readdir(mpRoot, { withFileTypes: true }).catch(() => []);
  for (const e of mpDirs.sort((a, b) => a.name.localeCompare(b.name))) {
    const f = join(mpRoot, e.name, "plugin.yaml");
    if (!e.isDirectory() || !(await exists(f))) continue;
    const v = await load(f, ModelProviderPlugin);
    if (!v) continue;
    if (v.id !== e.name)
      problems.push({
        file: rel(f),
        path: "id",
        message: `is ${v.id}; keep it in plugins/model-providers/${v.id}/`,
      });
    else modelProviders.push({ manifest: v, dir: join(mpRoot, e.name) });
  }
  // A rule id is one rule across the packs (findings name it): a later pack that
  // reuses one is not loaded, as the review would refuse it, and each clash names both files.
  const ruleFile = new Map<string, string>();
  const checklists = firstOfName(
    await many("checklists", /\.ya?ml$/, ChecklistPack),
    (c) => c.name,
    "checklist pack",
  ).filter((c) => {
    const file = fileFor(c, "");
    const clashes = c.rules.flatMap((r, i) => {
      const first = ruleFile.get(r.id);
      return first === undefined ? [] : [{ i, id: r.id, first }];
    });
    for (const x of clashes)
      problems.push({
        file,
        path: `rules.${x.i}.id`,
        message: `rule ${x.id} is also in ${x.first}; this pack is not loaded`,
      });
    if (clashes.length) return false;
    for (const r of c.rules) ruleFile.set(r.id, file);
    return true;
  });
  const serviceRequests = await many("process/snow", /\.ya?ml$/, ServiceRequestTemplate);
  const procedures = await many("process/procedures", /\.ya?ml$/, Procedure);
  const agents = await many("agents", /\.ya?ml$/, AgentDefinition);

  const skills: OrgPack["skills"] = [];
  for (const f of await listFiles(join(dir, "process", "skills"), /^SKILL\.md$/)) {
    const text = (await readFile(f, "utf8")).replace(/\r\n/g, "\n");
    const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
    if (!m) {
      problems.push({
        file: rel(f),
        path: "",
        message: "a skill starts with YAML front matter between --- lines",
      });
      continue;
    }
    const r = SkillMeta.safeParse(parse(m[1]!));
    if (!r.success) {
      for (const i of r.error.issues)
        problems.push({ file: rel(f), path: i.path.map(String).join("."), message: i.message });
      continue;
    }
    if (m[2]!.trim() === "")
      problems.push({
        file: rel(f),
        path: "",
        message: "a skill needs instructions after the front matter",
      });
    skills.push({ ...r.data, body: m[2]! });
  }

  // One folder per type, named after it; every skill it names must be a loaded skill.
  const repoTypes: RepoType[] = [];
  const specTemplates: SpecTemplate[] = [];
  const skillFiles = new Set(skills.map((s) => `process/skills/${s.id}/SKILL.md`));
  let typeDirs: string[] = [];
  try {
    typeDirs = (await readdir(join(dir, "repo-types"), { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    // no repo types yet
  }
  for (const name of typeDirs) {
    const f = join(dir, "repo-types", name, "type.yaml");
    if (!(await exists(f))) {
      problems.push({ file: `repo-types/${name}`, path: "", message: "has no type.yaml" });
      continue;
    }
    const v = await load(f, RepoType);
    if (!v) continue;
    if (v.id !== name) {
      problems.push({
        file: rel(f),
        path: "id",
        message: `is ${v.id}; put it in repo-types/${v.id}/type.yaml`,
      });
      continue;
    }
    v.skills.forEach((s, i) => {
      if (!skillFiles.has(s))
        problems.push({ file: rel(f), path: `skills.${i}`, message: `no skill at ${s}` });
    });
    repoTypes.push(v);
    const tf = join(dir, "repo-types", name, "spec-template.yaml");
    if (!(await exists(tf))) continue;
    const t = await load(tf, SpecTemplate);
    if (!t) continue;
    if (t.repoType !== name) {
      problems.push({
        file: rel(tf),
        path: "repoType",
        message: `is ${t.repoType}; the template in repo-types/${name}/ is for ${name}`,
      });
      continue;
    }
    specTemplates.push(t);
  }

  // ADR 0180: one folder per component type, named after it; notes.md beside it is read as text.
  const componentTypes: LoadedComponentType[] = [];
  let ctDirs: string[] = [];
  try {
    ctDirs = (await readdir(join(dir, "component-types"), { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    // no component types yet
  }
  for (const name of ctDirs) {
    const f = join(dir, "component-types", name, "type.yaml");
    if (!(await exists(f))) {
      problems.push({ file: `component-types/${name}`, path: "", message: "has no type.yaml" });
      continue;
    }
    const v = await load(f, ComponentType);
    if (!v) continue;
    if (v.id !== name) {
      problems.push({
        file: rel(f),
        path: "id",
        message: `is ${v.id}; put it in component-types/${v.id}/type.yaml`,
      });
      continue;
    }
    const notesFile = join(dir, "component-types", name, v.notes ?? "notes.md");
    const notesText = (await exists(notesFile))
      ? await readFile(notesFile, "utf8")
      : v.notes
        ? (problems.push({ file: rel(f), path: "notes", message: `no file ${v.notes} beside it` }),
          undefined)
        : undefined;
    componentTypes.push({
      ...v,
      source: "org-pack",
      ...(notesText !== undefined ? { notesText } : {}),
    });
  }

  // ---------- cross-file checks
  const roleIds = new Set<string>([...BUILT_IN_ROLES, ...roles.custom.map((c) => c.id)]);
  const typeIds = new Set(changeTypes.types.map((t) => t.id));
  const gateIds = new Set(gates.gates.map((g) => g.id));
  const packNames = new Set(checklists.map((c) => c.name));
  const ruleIds = new Set(checklists.flatMap((c) => c.rules.map((r) => r.id)));
  const dialectNames = new Set(dialects.map((d) => d.name));
  const knownTypes = new Set([
    ...profiles.flatMap((p) => p.repos?.repos.map((r) => r.type) ?? []),
    ...repoTypes.map((t) => t.id),
  ]);

  changeTypes.types.forEach((t) => {
    for (const [phase, rs] of Object.entries(t.approvals)) {
      for (const r of rs ?? [])
        if (!roleIds.has(r))
          problems.push({
            file: "change-types.yaml",
            path: `${t.id}.approvals.${phase}`,
            message: `unknown role ${r}`,
          });
    }
    // ADR 0113: the fast path's gate is a gate, on one of the type's phases.
    if (t.fastGate) {
      const g = gates.gates.find((x) => x.id === t.fastGate);
      if (!g)
        problems.push({
          file: "change-types.yaml",
          path: `${t.id}.fastGate`,
          message: `there is no gate ${t.fastGate} in gates.yaml`,
        });
      else if (!t.phases.includes(g.phase))
        problems.push({
          file: "change-types.yaml",
          path: `${t.id}.fastGate`,
          message: `the ${g.id} gate is for the ${g.phase} phase, which ${t.id} doesn't have`,
        });
    }
  });
  gates.gates.forEach((g) => {
    for (const r of g.approvers)
      if (!roleIds.has(r))
        problems.push({
          file: "gates.yaml",
          path: `${g.id}.approvers`,
          message: `unknown role ${r}`,
        });
    for (const c of g.checklists)
      if (!packNames.has(c))
        problems.push({
          file: "gates.yaml",
          path: `${g.id}.checklists`,
          message: `no checklist pack named ${c}`,
        });
  });
  for (const p of patterns) {
    for (const r of p.checklist)
      if (!ruleIds.has(r))
        problems.push({
          file: fileFor(p, `patterns/${p.code}.yaml`),
          path: "checklist",
          message: `no checklist rule ${r}`,
        });
  }
  for (const p of profiles) {
    for (const g of p.profile?.gates ?? [])
      if (!gateIds.has(g))
        problems.push({
          file: `profiles/${p.platform}/profile.yaml`,
          path: "gates",
          message: `no gate ${g}`,
        });
    for (const r of p.repos?.repos ?? []) {
      for (const d of r.dialects)
        if (!dialectNames.has(d))
          problems.push({
            file: `profiles/${p.platform}/repos.manifest.yaml`,
            path: `${r.id}.dialects`,
            message: `no dialect ${d}`,
          });
    }
  }
  for (const d of dialects) {
    for (const e of d.extends)
      if (!dialectNames.has(e))
        problems.push({
          file: fileFor(d, `dialects/${d.name}.yaml`),
          path: "extends",
          message: `no dialect ${e}`,
        });
  }
  for (const m of testStrategy.matrix) {
    if (!typeIds.has(m.changeType))
      problems.push({
        file: "test-strategy.yaml",
        path: "matrix",
        message: `no change type ${m.changeType}`,
      });
  }
  const snowIds = new Set(serviceRequests.map((s) => s.id));
  for (const s of serviceRequests) {
    for (const a of s.alsoNeeds)
      if (!snowIds.has(a))
        problems.push({
          file: fileFor(s, `process/snow/${s.id}.yaml`),
          path: "alsoNeeds",
          message: `no template ${a}`,
        });
  }
  const procedureIds = new Map<string, string>();
  for (const p of procedures) {
    const firstFile = procedureIds.get(p.id);
    if (firstFile !== undefined)
      problems.push({
        file: fileFor(p, `process/procedures/${p.id}.yaml`),
        path: "id",
        message: `duplicate procedure ${p.id} (also in ${firstFile})`,
      });
    else procedureIds.set(p.id, fileFor(p, `process/procedures/${p.id}.yaml`));
    if (p.template && !snowIds.has(p.template))
      problems.push({
        file: fileFor(p, `process/procedures/${p.id}.yaml`),
        path: "template",
        message: `no template ${p.template}`,
      });
  }
  const allowedModes = new Set<string>([...runtime.modes.allowed, "mock", "replay"]);
  for (const a of agents) {
    if (a.checklist && !packNames.has(a.checklist))
      problems.push({
        file: fileFor(a, `agents/${a.id}.yaml`),
        path: "checklist",
        message: `no checklist pack named ${a.checklist}`,
      });
    if (!a.allowedRuntimes.some((r) => allowedModes.has(r))) {
      problems.push({
        file: fileFor(a, `agents/${a.id}.yaml`),
        path: "allowedRuntimes",
        message: "none of its runtimes is allowed by runtime.yaml",
      });
    }
    if (!roleIds.has(a.role))
      problems.push({
        file: fileFor(a, `agents/${a.id}.yaml`),
        path: "role",
        message: `unknown role ${a.role}`,
      });
  }
  for (const s of skills) {
    for (const t of s.appliesTo.repoTypes) {
      if (knownTypes.size > 0 && !knownTypes.has(t))
        problems.push({
          file: `process/skills/${s.id}/SKILL.md`,
          path: "appliesTo.repoTypes",
          message: `no repo has type ${t}`,
        });
    }
  }

  return {
    ...(pack ? { pack } : {}),
    roles,
    changeTypes,
    gates,
    runtime,
    sources,
    testStrategy,
    profiles,
    patterns,
    dialects,
    frameworks,
    scanSettings,
    repoTypes,
    componentTypes,
    plugins,
    modelProviders,
    specTemplates,
    checklists,
    skills,
    serviceRequests,
    procedures,
    agents,
    conventions,
    defaulted,
    problems,
  };
}

/**
 * The org pack's OpenSpec store settings (ADR 0126), `openspec.yaml`: the defaults (nothing on)
 * when the pack has none, and also, with a problem, when the file is there and doesn't read.
 */
export async function loadOpenSpecSettings(
  dir: string,
): Promise<{ settings: OpenSpecSettings; problem?: string }> {
  const settings = OpenSpecSettings.parse({ schemaVersion: 1 });
  let text: string;
  try {
    text = await readFile(join(dir, "openspec.yaml"), "utf8");
  } catch {
    return { settings };
  }
  try {
    const r = OpenSpecSettings.safeParse(parse(text));
    if (r.success) return { settings: r.data };
    return {
      settings,
      problem: `openspec.yaml: ${r.error.issues.map((i) => `${i.path.join(".") || "(file)"}: ${i.message}`).join("; ")}`,
    };
  } catch (e) {
    return {
      settings,
      problem: `openspec.yaml isn't YAML: ${(e as Error).message.split("\n")[0]}`,
    };
  }
}

/**
 * The org pack's reference ranges for estimates (ADR 0109), `estimates.yaml`: undefined when
 * the pack has none (an estimate then sizes the work and gives no days); a problem when the
 * file is there and doesn't read.
 */
export async function loadEstimates(
  dir: string,
): Promise<{ estimates?: Estimates; problem?: string }> {
  let text: string;
  try {
    text = await readFile(join(dir, "estimates.yaml"), "utf8");
  } catch {
    return {};
  }
  try {
    const r = Estimates.safeParse(parse(text));
    if (r.success) return { estimates: r.data };
    return {
      problem: `estimates.yaml: ${r.error.issues.map((i) => `${i.path.join(".") || "(file)"}: ${i.message}`).join("; ")}`,
    };
  } catch (e) {
    return { problem: `estimates.yaml isn't YAML: ${(e as Error).message.split("\n")[0]}` };
  }
}

/** The conventions of a pack (ADR 0147), its defaults when it has none. */
export const conventionsOf = (op: Pick<OrgPack, "conventions"> | undefined): Conventions =>
  op?.conventions ?? DEFAULT_CONVENTIONS;

/** What the estate join takes from a pack's conventions (ADR 0147): its facing words and bundle folders. */
export function joinConventions(op: Pick<OrgPack, "conventions"> | undefined): {
  facing: { internal: readonly string[]; external: readonly string[] };
  bundleFolders: readonly string[];
} {
  const c = conventionsOf(op);
  return { facing: c.facing, bundleFolders: c.gatewayBundleFolders };
}
