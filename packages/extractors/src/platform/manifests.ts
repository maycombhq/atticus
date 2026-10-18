import { isMap, isScalar, isSeq, LineCounter, parse, parseAllDocuments } from "yaml";
import type { RepoHandle, ScanContext } from "@maycombhq/sdk";
import { arr, at, isObj, readOrWarn, str, type Obj } from "./util.js";

/**
 * Multi-document YAML (and JSON, which YAML reads too) with line numbers, and the
 * Kubernetes and OpenShift objects in it: List items are unpacked and OpenShift Templates
 * are processed with their parameter defaults, so extractors see plain objects.
 */

export type PathSeg = string | number;

/** One parsed document: its plain value and the line of any key path in it. */
export interface YamlDoc {
  value: unknown;
  /** Line of the key at `path` (of the item, for a sequence index). Undefined when absent. */
  line(path: readonly PathSeg[]): number | undefined;
}

export const MALFORMED_YAML = "Could not read this file as YAML; skipped it.";

/** Parse every document in a file. Undefined when any document has a syntax error. */
export function readYamlDocs(text: string): YamlDoc[] | undefined {
  const lc = new LineCounter();
  const docs = parseAllDocuments(text, { lineCounter: lc, uniqueKeys: false });
  if (!Array.isArray(docs)) return undefined; // an empty stream
  if (docs.some((d) => d.errors.length > 0)) return undefined;
  const out: YamlDoc[] = [];
  for (const d of docs) {
    if (d.contents === null) continue;
    let value: unknown;
    try {
      value = d.toJS({ maxAliasCount: 100 });
    } catch {
      return undefined;
    }
    const lineAt = (pos: number) => lc.linePos(pos).line;
    const root = d.contents;
    out.push({
      value,
      line(path) {
        let node: unknown = root;
        let line: number | undefined = root.range ? lineAt(root.range[0]) : undefined;
        for (const seg of path) {
          if (isMap(node)) {
            const pair = node.items.find(
              (p) => (isScalar(p.key) ? String(p.key.value) : String(p.key)) === String(seg),
            );
            if (!pair) return undefined;
            const k = pair.key as { range?: [number, number, number] } | null;
            if (k?.range) line = lineAt(k.range[0]);
            node = pair.value;
          } else if (isSeq(node) && typeof seg === "number") {
            const item = node.items[seg] as { range?: [number, number, number] } | undefined;
            if (!item) return undefined;
            if (item.range) line = lineAt(item.range[0]);
            node = item;
          } else return undefined;
        }
        return line;
      },
    });
  }
  return out;
}

/** A view of part of a document, with lines still relative to the file. */
export function subDoc(doc: YamlDoc, prefix: readonly PathSeg[]): YamlDoc {
  return {
    value: at(doc.value, ...prefix),
    line: (path) => doc.line([...prefix, ...path]),
  };
}

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
}

/** A Template object left out because a parameter it uses has no value. */
export interface SkippedObject {
  kind: string;
  name: string;
  file: string;
  params: string[];
}

export interface ManifestSet {
  objects: K8sObject[];
  skipped: SkippedObject[];
}

export const MANIFEST_GLOBS = ["**/*.yaml", "**/*.yml", "**/*.json"];

/** Helm and other Go templates (`{{ .Values.x }}`) can't be read without rendering them. */
const GO_TEMPLATE = /(^|[^$])\{\{/m;

/**
 * Read the Kubernetes-style objects in every claimed file whose text matches `relevant`.
 * A relevant file that isn't valid YAML is reported and skipped; Helm templates are skipped
 * quietly, since they need rendering first.
 */
export async function loadManifests(
  repo: RepoHandle,
  ctx: ScanContext,
  relevant: RegExp,
  globs: readonly string[] = MANIFEST_GLOBS,
): Promise<ManifestSet> {
  const out: ManifestSet = { objects: [], skipped: [] };
  for await (const file of repo.listFiles(globs)) {
    const text = await readOrWarn(repo, ctx, file);
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

function collect(doc: YamlDoc, file: string, docIndex: number, nested: boolean, out: ManifestSet) {
  const v = doc.value;
  if (!isObj(v) || typeof v.kind !== "string") return;
  if (v.kind === "List" && Array.isArray(v.items)) {
    v.items.forEach((_, i) => collect(subDoc(doc, ["items", i]), file, docIndex, true, out));
    return;
  }
  if (v.kind === "Template" && Array.isArray(v.objects)) {
    processTemplate(doc, file, docIndex, out);
    return;
  }
  const o = toObject(v, doc, file, docIndex, nested);
  if (o) out.objects.push(o);
}

function toObject(
  v: Obj,
  doc: YamlDoc,
  file: string,
  docIndex: number,
  nested: boolean,
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
  for (const s of set.skipped) {
    if (!kinds.has(s.kind)) continue;
    const params =
      s.params.length === 1
        ? `template parameter ${s.params[0]} has no value`
        : `template parameters ${s.params.join(", ")} have no value`;
    ctx.warn(`Skipped ${s.kind} ${s.name}: ${params}.`, s.file);
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
  if (a.namespace || b.namespace) return a.namespace === b.namespace;
  const dir = (f: string) => f.slice(0, Math.max(0, f.lastIndexOf("/")));
  return dir(a.file) === dir(b.file);
}
