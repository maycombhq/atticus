import type { RepoHandle, ScanContext } from "@maycombhq/sdk";
import { attrOf, isRef, parseHcl, type HclBlock, type HclValue } from "./hcl.js";
import { dirOf, readOrWarn } from "./util.js";

/**
 * Terraform modules as folders of .tf files: their resources, and the variables (defaults,
 * then terraform.tfvars and *.auto.tfvars) and locals needed to resolve names such as
 * "reports-job-${var.env}". Values are resolved only from what is written in the folder.
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
}

export const TF_GLOBS = ["**/*.tf", "**/terraform.tfvars", "**/*.auto.tfvars"];

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
  const out: TfModule[] = [];
  for (const [dir, list] of [...byDir.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (!list.some((f) => f.path.endsWith(".tf") && relevant.test(f.text))) continue;
    const mod: TfModule = { dir, resources: [], vars: new Map(), locals: new Map() };
    const overrides: [string, HclValue][] = [];
    for (const f of list) {
      const hcl = parseHcl(f.text);
      if (hcl.error && f.path.endsWith(".tf") && relevant.test(f.text))
        ctx.warn(
          `Read this file up to line ${hcl.error.line} only: the block there isn't closed.`,
          f.path,
        );
      if (!f.path.endsWith(".tf")) {
        for (const [k, a] of hcl.attrs) overrides.push([k, a.value]);
        continue;
      }
      for (const b of hcl.blocks) {
        if (b.type === "resource" && b.labels.length >= 2)
          mod.resources.push({ type: b.labels[0]!, name: b.labels[1]!, block: b, file: f.path });
        else if (b.type === "variable" && b.labels[0]) {
          const d = attrOf(b, "default");
          if (d !== undefined && !mod.vars.has(b.labels[0])) mod.vars.set(b.labels[0], d);
        } else if (b.type === "locals")
          for (const [k, a] of b.attrs) if (!mod.locals.has(k)) mod.locals.set(k, a.value);
      }
    }
    for (const [k, v] of overrides) mod.vars.set(k, v);
    out.push(mod);
  }
  return out;
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
