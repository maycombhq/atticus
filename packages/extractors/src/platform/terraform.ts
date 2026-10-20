import type { RepoHandle, ScanContext } from "@maycombhq/sdk";
import { attrOf, isRef, parseHcl, type HclBlock, type HclValue } from "./hcl.js";
import { dirOf, readOrWarn } from "./util.js";

/**
 * Terraform modules as folders of .tf files: their resources, and the variables (defaults,
 * then terraform.tfvars and *.auto.tfvars) and locals needed to resolve names such as
 * "reports-job-${var.env}". Values are resolved only from what is written in the repo.
 *
 * Local modules are followed (ADR 0063): a `module` block whose source is a folder of the repo
 * ("./x", "../modules/queue") makes an instance of that folder whose variables take the values
 * the caller passes (resolved in the caller), over the module's defaults. Each instantiation
 * is its own TfModule, nested modules included; a folder that some folder calls is read only
 * through its instances, not on its own. Remote sources (registry, git::, http) stay module
 * blocks.
 */

export interface TfResource {
  type: string;
  name: string;
  block: HclBlock;
  file: string;
}

export interface TfModule {
  dir: string;
  resources: TfResource[];
  vars: Map<string, HclValue>;
  locals: Map<string, HclValue>;
  /** For a local module's instance: the caller's module block. */
  call?: { name: string; file: string; line: number };
}

export const TF_GLOBS = ["**/*.tf", "**/terraform.tfvars", "**/*.auto.tfvars"];

/** How deep local modules are followed; deeper calls (or a cycle) stop there. */
const MAX_MODULE_DEPTH = 8;

interface Folder {
  dir: string;
  relevant: boolean;
  resources: TfResource[];
  /** Variable defaults; tfvars apply to a folder read on its own, not to an instance. */
  defaults: Map<string, HclValue>;
  tfvars: [string, HclValue][];
  locals: Map<string, HclValue>;
  calls: { name: string; source: string; block: HclBlock; file: string }[];
}

/** A module source that is a folder of this repo, resolved against the caller's folder. */
export function localSource(callerDir: string, source: string): string | undefined {
  if (!/^\.\.?(\/|$)/.test(source)) return undefined;
  const parts = callerDir ? callerDir.split("/") : [];
  for (const seg of source.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join("/");
}

/** Read every Terraform folder whose files match `relevant`, warning about unclosed blocks. */
export async function loadTerraform(
  repo: RepoHandle,
  ctx: ScanContext,
  relevant: RegExp,
): Promise<TfModule[]> {
  const files: string[] = [];
  for await (const p of repo.listFiles(TF_GLOBS)) if (!/(^|\/)\.terraform\//.test(p)) files.push(p);
  const byDir = new Map<string, { path: string; text: string }[]>();
  for (const path of files) {
    const text = await readOrWarn(repo, ctx, path);
    if (text === undefined) continue;
    byDir.set(dirOf(path), [...(byDir.get(dirOf(path)) ?? []), { path, text }]);
  }
  const folders = new Map<string, Folder>();
  for (const [dir, list] of [...byDir.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const f: Folder = {
      dir,
      relevant: list.some((x) => x.path.endsWith(".tf") && relevant.test(x.text)),
      resources: [],
      defaults: new Map(),
      tfvars: [],
      locals: new Map(),
      calls: [],
    };
    for (const file of list) {
      const hcl = parseHcl(file.text);
      if (hcl.error && file.path.endsWith(".tf") && relevant.test(file.text))
        ctx.warn(
          `Read this file up to line ${hcl.error.line} only: the block there isn't closed.`,
          file.path,
        );
      if (!file.path.endsWith(".tf")) {
        for (const [k, a] of hcl.attrs) f.tfvars.push([k, a.value]);
        continue;
      }
      for (const b of hcl.blocks) {
        if (b.type === "resource" && b.labels.length >= 2)
          f.resources.push({ type: b.labels[0]!, name: b.labels[1]!, block: b, file: file.path });
        else if (b.type === "variable" && b.labels[0]) {
          const d = attrOf(b, "default");
          if (d !== undefined && !f.defaults.has(b.labels[0])) f.defaults.set(b.labels[0], d);
        } else if (b.type === "locals") {
          for (const [k, a] of b.attrs) if (!f.locals.has(k)) f.locals.set(k, a.value);
        } else if (b.type === "module" && b.labels[0]) {
          const src = attrOf(b, "source");
          if (typeof src === "string")
            f.calls.push({ name: b.labels[0], source: src, block: b, file: file.path });
        }
      }
    }
    folders.set(dir, f);
  }

  const targetOf = (f: Folder, source: string) => {
    const t = localSource(f.dir, source);
    return t !== undefined && t !== f.dir && folders.has(t) ? t : undefined;
  };
  const called = new Set<string>();
  for (const f of folders.values())
    for (const c of f.calls) {
      const t = targetOf(f, c.source);
      if (t) called.add(t);
    }

  const out: TfModule[] = [];
  const expand = (caller: TfModule, f: Folder, depth: number, seen: Set<string>) => {
    if (depth >= MAX_MODULE_DEPTH) return;
    for (const c of f.calls) {
      const t = targetOf(f, c.source);
      if (!t || seen.has(t)) continue;
      const target = folders.get(t)!;
      const vars = new Map(target.defaults);
      for (const [k, a] of c.block.attrs) {
        if (["source", "version", "count", "for_each", "providers", "depends_on"].includes(k))
          continue;
        vars.set(k, passed(resolve(caller, a.value)));
      }
      const inst: TfModule = {
        dir: t,
        resources: target.resources,
        vars,
        locals: target.locals,
        call: { name: c.name, file: c.file, line: c.block.line },
      };
      if (target.relevant) out.push(inst);
      expand(inst, target, depth + 1, new Set([...seen, t]));
    }
  };
  for (const f of folders.values()) {
    if (called.has(f.dir)) continue;
    const mod: TfModule = {
      dir: f.dir,
      resources: f.resources,
      vars: new Map(f.defaults),
      locals: f.locals,
    };
    for (const [k, v] of f.tfvars) mod.vars.set(k, v);
    if (f.relevant) out.push(mod);
    expand(mod, f, 0, new Set([f.dir]));
  }
  return out;
}

/**
 * A caller's value as the module sees it. What the caller couldn't resolve (another module's
 * output, a data source, a function) is kept as an opaque expression, so it can't be resolved
 * again against the module's own variables of the same name.
 */
function passed(v: HclValue | undefined): HclValue {
  if (v === undefined) return { $expr: "" };
  if (isRef(v)) return { $expr: v.$ref };
  if (typeof v === "string" && v.includes("${")) return { $expr: v };
  if (Array.isArray(v)) return v.map((x) => passed(x));
  if (v !== null && typeof v === "object" && !("$expr" in v)) {
    const o: { [k: string]: HclValue } = {};
    for (const [k, x] of Object.entries(v)) o[k] = passed(x as HclValue);
    return o;
  }
  return v;
}

/** A reference to another resource's attribute: `type.name.attr`. */
export interface ResourceRef {
  type: string;
  name: string;
  attr: string;
}

const parseRef = (ref: string): ResourceRef | undefined => {
  const parts = ref.trim().split(".");
  if (parts.length < 3 || ["var", "local", "module", "data", "each", "count"].includes(parts[0]!))
    return undefined;
  return { type: parts[0]!, name: parts[1]!, attr: parts.slice(2).join(".") };
};

/** The resource references in a value: a bare reference or ones interpolated in a string. */
export function refsIn(v: HclValue | undefined): ResourceRef[] {
  if (isRef(v)) return parseRef(v.$ref) ? [parseRef(v.$ref)!] : [];
  if (typeof v !== "string") return [];
  return [...v.matchAll(/\$\{\s*([A-Za-z0-9_.-]+)\s*\}/g)]
    .map((m) => parseRef(m[1]!))
    .filter((r): r is ResourceRef => !!r);
}

export function findResource(mod: TfModule, type: string, name: string): TfResource | undefined {
  return mod.resources.find((r) => r.type === type && r.name === name);
}

/**
 * Resolve a value as far as the module allows: `var.x` and `local.x` (also inside strings),
 * and another resource's plain attribute. Whatever can't be resolved is left as written.
 */
export function resolve(mod: TfModule, v: HclValue | undefined, depth = 0): HclValue | undefined {
  if (v === undefined || depth > 8) return v;
  const lookup = (ref: string): HclValue | undefined => {
    const [head, key, ...rest] = ref.trim().split(".");
    if (!key || rest.length > 0) {
      const r = parseRef(ref);
      if (!r) return undefined;
      const target = findResource(mod, r.type, r.name);
      const a = target ? attrOf(target.block, r.attr) : undefined;
      return a === undefined ? undefined : resolve(mod, a, depth + 1);
    }
    if (head === "var") return resolve(mod, mod.vars.get(key), depth + 1);
    if (head === "local") return resolve(mod, mod.locals.get(key), depth + 1);
    return undefined;
  };
  if (isRef(v)) return lookup(v.$ref) ?? v;
  if (typeof v === "string")
    return v.replace(/\$\{\s*([A-Za-z0-9_.-]+)\s*\}/g, (whole, ref: string) => {
      const r = lookup(ref);
      return typeof r === "string" || typeof r === "number" || typeof r === "boolean"
        ? String(r)
        : whole;
    });
  if (Array.isArray(v)) return v.map((x) => resolve(mod, x, depth + 1) ?? null);
  if (v !== null && typeof v === "object" && !("$expr" in v)) {
    const out: { [k: string]: HclValue } = {};
    for (const [k, x] of Object.entries(v)) out[k] = resolve(mod, x as HclValue, depth + 1) ?? null;
    return out;
  }
  return v;
}

/** A resolved string, or undefined when the value isn't a plain value or still has `${...}` in it. */
export function tfString(mod: TfModule, v: HclValue | undefined): string | undefined {
  const r = resolve(mod, v);
  if (typeof r === "number" || typeof r === "boolean") return String(r);
  if (typeof r !== "string" || r.includes("${")) return undefined;
  return r;
}

/** An integer value, resolved. */
export function tfInt(mod: TfModule, v: HclValue | undefined): number | undefined {
  const r = resolve(mod, v);
  const n = typeof r === "number" ? r : typeof r === "string" && /^\d+$/.test(r) ? Number(r) : NaN;
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** An object value (e.g. `limits = { cpu = "1" }`), resolved. */
export function tfObject(
  mod: TfModule,
  v: HclValue | undefined,
): Record<string, HclValue> | undefined {
  const r = resolve(mod, v);
  return r !== null &&
    typeof r === "object" &&
    !Array.isArray(r) &&
    !("$ref" in r) &&
    !("$expr" in r)
    ? (r as Record<string, HclValue>)
    : undefined;
}

/**
 * A resource's name: the attribute, resolved, else the resource's own label. In a local
 * module's instance the label is the module's generic one ("this") and the name comes from the
 * caller, so an unresolved name gives nothing (ADR 0063).
 */
export function tfName(mod: TfModule, r: TfResource, attr: string): string | undefined {
  return tfString(mod, attrOf(r.block, attr)) ?? (mod.call ? undefined : r.name);
}
