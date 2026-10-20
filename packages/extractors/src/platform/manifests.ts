import { parse } from "yaml";
import type { RepoHandle, ScanContext } from "@maycombhq/sdk";
import { dropUnknown } from "./gotemplate.js";
import { renderCharts, type Source } from "./helm.js";
import { buildKustomizations } from "./kustomize.js";
import { arr, at, isObj, readOrWarn, str, type Obj } from "./util.js";
import { MALFORMED_YAML, readYamlDocs, subDoc, type PathSeg, type YamlDoc } from "./yamldoc.js";

export { MALFORMED_YAML, readYamlDocs, subDoc, type PathSeg, type YamlDoc };

/**
 * The Kubernetes and OpenShift objects in a repo's YAML (and JSON): List items are unpacked
 * and OpenShift Templates are processed with their parameter defaults, so extractors see plain
 * objects. With `rendered`, Helm charts are evaluated per environment values file and Kustomize
 * overlays are built (ADR 0064), and their objects come with the environment they are for.
 */

// ------------------------------------------------------------------ Kubernetes objects

export interface K8sObject {
  kind: string;
  apiVersion: string;
  name: string;
  namespace?: string;
  labels: Record<string, string>;
  /** The object as plain data, template parameters filled in. */
  obj: Obj;
  file: string;
  /** Position of the YAML document in its file. */
  docIndex: number;
  /** True for List items and Template objects (not a top-level document of their own). */
  nested: boolean;
  /** Line of a key path inside the object; with no path, the line of its `kind`. */
  line(path?: readonly PathSeg[]): number | undefined;
  /** Set for objects from a Helm chart or a Kustomize build. */
  origin?: "helm" | "kustomize";
  /** The environment of the values file or overlay the object was built for. */
  env?: string;
  /** Values, kustomization and patch files (and lines) behind the object, beyond `file`. */
  sources?: Source[];
  /** The Helm release and environment, or the kustomization, the object was built in. */
  group?: string;
}

/** An object left out: a Template parameter with no value, or a name that can't be read. */
export interface SkippedObject {
  kind: string;
  name: string;
  file: string;
  params: string[];
  /** Why, when it isn't a missing parameter. */
  reason?: string;
}

export interface ManifestSet {
  objects: K8sObject[];
  skipped: SkippedObject[];
}

export const MANIFEST_GLOBS = ["**/*.yaml", "**/*.yml", "**/*.json"];
/** Helm's named-template files, read with the charts they belong to. */
export const CHART_GLOBS = ["**/templates/**/*.tpl"];

/** Helm and other Go templates (`{{ .Values.x }}`) are only read as part of a chart. */
const GO_TEMPLATE = /(^|[^$])\{\{/m;

export interface LoadOptions {
  /** Also evaluate Helm charts and build Kustomize overlays (ADR 0064). */
  rendered?: boolean;
}

/**
 * Read the Kubernetes-style objects in every claimed file whose text matches `relevant`.
 * A relevant file that isn't valid YAML is reported and skipped; a Go template outside a
 * chart is skipped quietly. With `rendered`, chart templates and the files a kustomization
 * uses come out as built objects instead, one set per environment.
 */
export async function loadManifests(
  repo: RepoHandle,
  ctx: ScanContext,
  relevant: RegExp,
  globs: readonly string[] = MANIFEST_GLOBS,
  options: LoadOptions = {},
): Promise<ManifestSet> {
  const out: ManifestSet = { objects: [], skipped: [] };
  const files: string[] = [];
  for await (const file of repo.listFiles(options.rendered ? [...globs, ...CHART_GLOBS] : globs))
    files.push(file);
  const texts = new Map<string, string | undefined>();
  const read = async (file: string) => {
    if (!texts.has(file)) texts.set(file, await readOrWarn(repo, ctx, file));
    return texts.get(file);
  };
  let skip = new Set<string>();
  if (options.rendered) {
    const helm = await renderCharts(files, read);
    const kust = await buildKustomizations(files, read);
    for (const w of [...helm.warnings, ...kust.warnings]) ctx.warn(w.message, w.path);
    skip = new Set([...helm.chartFiles, ...kust.consumed]);
    for (const r of helm.rendered) {
      const docs = readYamlDocs(r.text);
      if (!docs) {
        ctx.warn(
          `The rendered Helm template is not valid YAML${r.env ? ` for ${r.env}` : ""}; skipped it.`,
          r.file,
        );
        continue;
      }
      docs.forEach((d, docIndex) => {
        const mapped: YamlDoc = {
          value: dropUnknown(d.value),
          line: (path) => {
            const l = d.line(path);
            return l === undefined ? undefined : (r.lines[l - 1] ?? l);
          },
        };
        const extra: Extra = {
          origin: "helm",
          ...(r.env ? { env: r.env } : {}),
          sources: r.sources,
          group: `helm:${r.release}|${r.env ?? ""}`,
        };
        collect(mapped, r.file, docIndex, false, out, extra);
      });
    }
    for (const ov of kust.overlays)
      for (const k of ov.objects) {
        const extra: Extra = {
          origin: "kustomize",
          ...(ov.env ? { env: ov.env } : {}),
          sources: k.sources,
          group: `kustomize:${ov.file}`,
        };
        const doc: YamlDoc = { value: k.obj, line: (p) => k.line(p) };
        const o = toObject(k.obj, doc, k.file, k.docIndex, true, extra);
        if (o) out.objects.push(o);
      }
  }
  for (const file of files) {
    if (skip.has(file) || file.endsWith(".tpl")) continue;
    const text = await read(file);
    if (text === undefined || !relevant.test(text) || GO_TEMPLATE.test(text)) continue;
    const docs = readYamlDocs(text);
    if (!docs) {
      ctx.warn(MALFORMED_YAML, file);
      continue;
    }
    docs.forEach((doc, docIndex) => collect(doc, file, docIndex, false, out));
  }
  return out;
}

type Extra = Pick<K8sObject, "origin" | "env" | "sources" | "group">;

function collect(
  doc: YamlDoc,
  file: string,
  docIndex: number,
  nested: boolean,
  out: ManifestSet,
  extra: Extra = {},
) {
  const v = doc.value;
  if (!isObj(v) || typeof v.kind !== "string") return;
  if (v.kind === "List" && Array.isArray(v.items)) {
    v.items.forEach((_, i) => collect(subDoc(doc, ["items", i]), file, docIndex, true, out, extra));
    return;
  }
  if (v.kind === "Template" && Array.isArray(v.objects)) {
    processTemplate(doc, file, docIndex, out);
    return;
  }
  const o = toObject(v, doc, file, docIndex, nested, extra);
  if (o) out.objects.push(o);
  else if (extra.origin === "helm")
    out.skipped.push({
      kind: v.kind,
      name: "",
      file,
      params: [],
      reason: "its name comes from a template form Atticus doesn't evaluate",
    });
}

function toObject(
  v: Obj,
  doc: YamlDoc,
  file: string,
  docIndex: number,
  nested: boolean,
  extra: Extra = {},
): K8sObject | undefined {
  const kind = str(v.kind);
  const name = str(at(v, "metadata", "name"));
  if (!kind || !name) return undefined;
  const namespace = str(at(v, "metadata", "namespace"));
  const labels: Record<string, string> = {};
  const l = at(v, "metadata", "labels");
  if (isObj(l))
    for (const [k, x] of Object.entries(l)) if (str(x) !== undefined) labels[k] = str(x)!;
  return {
    kind,
    apiVersion: str(v.apiVersion) ?? "",
    name,
    ...(namespace ? { namespace } : {}),
    labels,
    obj: v,
    file,
    docIndex,
    nested,
    line: (path = ["kind"]) => doc.line(path),
    ...(extra.origin ? { origin: extra.origin } : {}),
    ...(extra.env ? { env: extra.env } : {}),
    ...(extra.sources?.length ? { sources: extra.sources } : {}),
    ...(extra.group !== undefined ? { group: extra.group } : {}),
  };
}

const PARAM = /\$\{\{(\w+)\}\}|\$\{(\w+)\}/g;

/**
 * OpenShift Template: `${NAME}` is replaced by the parameter's value as text and a whole
 * `${{NAME}}` by the value read as YAML (so `"${{REPLICAS}}"` becomes the number 2), as
 * `oc process` does with no overrides. An object using a parameter with no value is left out.
 */
function processTemplate(doc: YamlDoc, file: string, docIndex: number, out: ManifestSet) {
  const t = doc.value as Obj;
  const values = new Map<string, string>();
  const declared = new Set<string>();
  for (const p of arr(t.parameters)) {
    const name = str(at(p, "name"));
    if (!name) continue;
    declared.add(name);
    const value = str(at(p, "value"));
    if (value !== undefined) values.set(name, value);
  }
  arr(t.objects).forEach((raw, i) => {
    const missing = new Set<string>();
    const subst = (v: unknown): unknown => {
      if (typeof v === "string") {
        const whole = /^\$\{\{(\w+)\}\}$/.exec(v);
        if (whole && values.has(whole[1]!)) {
          try {
            return parse(values.get(whole[1]!)!) as unknown;
          } catch {
            return values.get(whole[1]!);
          }
        }
        return v.replace(PARAM, (m, a?: string, b?: string) => {
          const name = (a ?? b)!;
          if (values.has(name)) return values.get(name)!;
          if (declared.has(name)) missing.add(name);
          return m;
        });
      }
      if (Array.isArray(v)) return v.map(subst);
      if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, subst(x)]));
      return v;
    };
    const value = subst(raw);
    if (!isObj(value)) return;
    const sub = subDoc(doc, ["objects", i]);
    if (missing.size > 0) {
      const kind = str(value.kind);
      if (kind)
        out.skipped.push({
          kind,
          name: str(at(value, "metadata", "name")) ?? "",
          file,
          params: [...missing].sort(),
        });
      return;
    }
    const o = toObject(value, { value, line: sub.line }, file, docIndex, true);
    if (o) out.objects.push(o);
  });
}

/** Report Template objects of the given kinds that were left out for want of a parameter value. */
export function warnSkipped(ctx: ScanContext, set: ManifestSet, kinds: ReadonlySet<string>) {
  const seen = new Set<string>();
  for (const s of set.skipped) {
    if (!kinds.has(s.kind)) continue;
    const why =
      s.reason ??
      (s.params.length === 1
        ? `template parameter ${s.params[0]} has no value`
        : `template parameters ${s.params.join(", ")} have no value`);
    const message = s.name
      ? `Skipped ${s.kind} ${s.name}: ${why}.`
      : `Skipped a ${s.kind}: ${why}.`;
    if (seen.has(`${s.file}|${message}`)) continue;
    seen.add(`${s.file}|${message}`);
    ctx.warn(message, s.file);
  }
}

/** Kubernetes label selector: matchLabels and matchExpressions; an empty selector selects everything. */
export function selects(selector: unknown, labels: Record<string, string>): boolean {
  if (!isObj(selector)) return false;
  const ml = selector.matchLabels;
  const exprs = selector.matchExpressions;
  const plain = ml === undefined && exprs === undefined;
  // DeploymentConfig and Service selectors are plain maps of labels.
  const want = plain ? selector : isObj(ml) ? ml : {};
  for (const [k, v] of Object.entries(want)) if (labels[k] !== str(v)) return false;
  for (const e of arr(exprs)) {
    const key = str(at(e, "key"));
    const op = str(at(e, "operator"));
    const vals = arr(at(e, "values")).map((x) => str(x));
    if (!key || !op) continue;
    const has = key in labels;
    if (op === "In" && !(has && vals.includes(labels[key]))) return false;
    if (op === "NotIn" && has && vals.includes(labels[key])) return false;
    if (op === "Exists" && !has) return false;
    if (op === "DoesNotExist" && has) return false;
  }
  return true;
}

/** Two objects apply to each other when they share a namespace, or both have none and share a folder. */
export function sameScope(a: K8sObject, b: K8sObject): boolean {
  // Objects of one Helm release or Kustomize build for one environment go together, only.
  if (a.group !== undefined || b.group !== undefined)
    return a.group === b.group && a.namespace === b.namespace;
  if (a.namespace || b.namespace) return a.namespace === b.namespace;
  const dir = (f: string) => f.slice(0, Math.max(0, f.lastIndexOf("/")));
  return dir(a.file) === dir(b.file);
}
