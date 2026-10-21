import { normalize, type ReadText, type Source } from "./helm.js";
import { arr, at, dirOf, envOf, isObj, str, type Obj } from "./util.js";
import { readYamlDocs, type PathSeg, type YamlDoc } from "./yamldoc.js";
import type { ParseCache } from "@maycombhq/sdk";

/**
 * Kustomize read without running kustomize (ADR 0064). Every kustomization no other one uses
 * (an overlay, or a lone base) is built: resources and bases (files and folders with their own
 * kustomization), components, configMapGenerator literals, strategic-merge and JSON 6902
 * patches, namespace, namePrefix and nameSuffix (with the references to renamed objects
 * updated), commonLabels and labels, commonAnnotations, images and replicas, in kustomize's
 * order. Remote bases are not fetched, and fields this reader doesn't know are reported.
 */

export interface KObject {
  obj: Obj;
  /** The file the object came from (a resource file, or the kustomization that generated it). */
  file: string;
  docIndex: number;
  line(path?: readonly PathSeg[]): number | undefined;
  /** Kustomization and patch files (and lines) that brought the object in or changed it. */
  sources: Source[];
  /** Every name the object has had, first to last. */
  names: string[];
}

export interface Overlay {
  /** The kustomization file built. */
  file: string;
  env?: string;
  objects: KObject[];
}

export interface KustomizeResult {
  overlays: Overlay[];
  warnings: { message: string; path: string }[];
  /** Files a kustomization uses as a resource or patch: never read as plain manifests. */
  consumed: Set<string>;
}

const KFILES = ["kustomization.yaml", "kustomization.yml", "Kustomization"];
const join = (dir: string, rel: string) => normalize(dir ? `${dir}/${rel}` : rel);
const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);

const isRemote = (ref: string) =>
  ref.includes("://") ||
  ref.startsWith("git@") ||
  ref.startsWith("github.com/") ||
  ref.startsWith("gitlab.com/") ||
  ref.includes("?ref=") ||
  ref.includes("//");

const KNOWN_FIELDS = new Set([
  "apiVersion",
  "kind",
  "metadata",
  "resources",
  "bases",
  "components",
  "patches",
  "patchesStrategicMerge",
  "patchesJson6902",
  "namespace",
  "namePrefix",
  "nameSuffix",
  "commonLabels",
  "labels",
  "commonAnnotations",
  "images",
  "replicas",
  "configMapGenerator",
  "secretGenerator",
  "generatorOptions",
  "sortOptions",
  "buildMetadata",
]);

const CLUSTER_KINDS = new Set([
  "Namespace",
  "ClusterRole",
  "ClusterRoleBinding",
  "CustomResourceDefinition",
  "PersistentVolume",
  "StorageClass",
  "PriorityClass",
  "IngressClass",
  "ValidatingWebhookConfiguration",
  "MutatingWebhookConfiguration",
  "APIService",
]);

const WORKLOADS = new Set([
  "Deployment",
  "StatefulSet",
  "DaemonSet",
  "ReplicaSet",
  "DeploymentConfig",
  "Job",
]);
const SCALABLE = new Set([
  "Deployment",
  "StatefulSet",
  "ReplicaSet",
  "ReplicationController",
  "DeploymentConfig",
]);

const nameOf = (o: Obj) => str(at(o, "metadata", "name")) ?? "";
const kindOf = (o: Obj) => str(o.kind) ?? "";

function clone<T>(v: T): T {
  if (Array.isArray(v)) return v.map(clone) as T;
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)])) as T;
  return v;
}

function ensure(o: Obj, ...path: string[]): Obj {
  let cur = o;
  for (const k of path) {
    if (!isObj(cur[k])) cur[k] = {};
    cur = cur[k] as Obj;
  }
  return cur;
}

export async function buildKustomizations(
  paths: readonly string[],
  read: ReadText,
  /** The repo scan's parse cache (ADR 0067): each file parsed once. */
  cache?: ParseCache,
): Promise<KustomizeResult> {
  const result: KustomizeResult = { overlays: [], warnings: [], consumed: new Set() };
  const all = new Set(paths);
  const kfileIn = (dir: string) => KFILES.map((f) => join(dir, f)).find((f) => all.has(f));
  const kfiles = paths.filter((p) => KFILES.includes(baseName(p))).sort();
  if (kfiles.length === 0) return result;

  const docs = new Map<string, YamlDoc[] | null>();
  const docsOf = async (file: string) => {
    if (!docs.has(file)) {
      const text = await read(file);
      const d = text === undefined ? undefined : readYamlDocs(text, { cache, path: file });
      if (text !== undefined && !d)
        result.warnings.push({
          message: "Could not read this file as YAML; skipped it.",
          path: file,
        });
      docs.set(file, d ?? null);
    }
    return docs.get(file) ?? undefined;
  };
  const warned = new Set<string>();
  const warn = (path: string, message: string) => {
    const k = `${path}\u0000${message}`;
    if (!warned.has(k)) {
      warned.add(k);
      result.warnings.push({ message, path });
    }
  };

  // Which kustomizations another one uses: those aren't built on their own.
  const used = new Set<string>();
  for (const kf of kfiles) {
    const k = (await docsOf(kf))?.[0]?.value;
    const dir = dirOf(kf);
    for (const ref of [
      ...arr(at(k, "resources")),
      ...arr(at(k, "bases")),
      ...arr(at(k, "components")),
    ]) {
      const r = str(ref);
      if (!r || isRemote(r)) continue;
      const sub = kfileIn(join(dir, r));
      if (sub) used.add(sub);
    }
  }

  const objectsOfFile = async (file: string, from: Source): Promise<KObject[]> => {
    const ds = await docsOf(file);
    if (!ds) return [];
    const out: KObject[] = [];
    ds.forEach((d, docIndex) => {
      const add = (v: unknown, prefix: PathSeg[]) => {
        if (!isObj(v) || typeof v.kind !== "string") return;
        if (v.kind === "List" && Array.isArray(v.items)) {
          v.items.forEach((x, i) => add(x, [...prefix, "items", i]));
          return;
        }
        out.push({
          obj: clone(v),
          file,
          docIndex,
          line: (path = ["kind"]) => d.line([...prefix, ...path]),
          sources: [from],
          names: [nameOf(v)],
        });
      };
      add(d.value, []);
    });
    return out;
  };

  /** Build the kustomization in `kf` onto `acc` (empty for a base, the parent's for a component). */
  const build = async (kf: string, acc: KObject[], stack: string[]): Promise<KObject[]> => {
    if (stack.includes(kf)) {
      warn(kf, "This kustomization includes itself; skipped the loop.");
      return acc;
    }
    const doc = (await docsOf(kf))?.[0];
    if (!doc || !isObj(doc.value)) return acc;
    const k = doc.value;
    const dir = dirOf(kf);
    const src = (path: PathSeg[]): Source => {
      const line = doc.line(path);
      return { file: kf, ...(line !== undefined ? { line } : {}) };
    };
    const touch = (o: KObject, s: Source) => {
      if (!o.sources.some((x) => x.file === s.file && x.line === s.line)) o.sources.push(s);
    };
    for (const f of Object.keys(k))
      if (!KNOWN_FIELDS.has(f))
        warn(
          kf,
          `Kustomize field ${f} is not read; the objects may differ from what kustomize builds.`,
        );

    // resources and bases
    for (const field of ["resources", "bases"] as const)
      for (const [i, ref] of arr(k[field]).entries()) {
        const r = str(ref);
        if (!r) continue;
        if (isRemote(r)) {
          warn(kf, `Remote base ${r} is not fetched; its objects are not read.`);
          continue;
        }
        const target = join(dir, r);
        const sub = kfileIn(target);
        if (sub) {
          const objs = await build(sub, [], [...stack, kf]);
          for (const o of objs) touch(o, src([field, i]));
          acc.push(...objs);
        } else if (all.has(target)) {
          result.consumed.add(target);
          acc.push(...(await objectsOfFile(target, src([field, i]))));
        } else warn(kf, `Resource ${r} is not in the repo; not read.`);
      }

    // components: built onto what is here so far
    for (const ref of arr(k.components)) {
      const r = str(ref);
      if (!r) continue;
      if (isRemote(r)) {
        warn(kf, `Remote component ${r} is not fetched; not read.`);
        continue;
      }
      const sub = kfileIn(join(dir, r));
      if (sub) await build(sub, acc, [...stack, kf]);
      else warn(kf, `Component ${r} is not in the repo; not read.`);
    }

    // configMapGenerator: literals only
    for (const [i, g] of arr(k.configMapGenerator).entries()) {
      const name = str(at(g, "name"));
      if (!name) continue;
      if (arr(at(g, "envs")).length || arr(at(g, "files")).length || str(at(g, "env")))
        warn(kf, `configMapGenerator ${name}: only literals are read, not envs or files.`);
      const data: Obj = {};
      for (const lit of arr(at(g, "literals"))) {
        const s = str(lit);
        const eq = s?.indexOf("=") ?? -1;
        if (!s || eq <= 0) continue;
        let v = s.slice(eq + 1);
        if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.endsWith(v[0])) v = v.slice(1, -1);
        data[s.slice(0, eq)] = v;
      }
      const behavior = str(at(g, "behavior")) ?? "create";
      const existing = acc.find((o) => kindOf(o.obj) === "ConfigMap" && o.names.includes(name));
      if (existing && behavior !== "create") {
        const cur = isObj(existing.obj.data) ? existing.obj.data : {};
        existing.obj.data = behavior === "replace" ? data : { ...cur, ...data };
        touch(existing, src(["configMapGenerator", i]));
        continue;
      }
      const line = doc.line(["configMapGenerator", i]);
      acc.push({
        obj: { apiVersion: "v1", kind: "ConfigMap", metadata: { name }, data },
        file: kf,
        docIndex: 0,
        line: () => line,
        sources: [],
        names: [name],
      });
    }

    // patches
    const patchList: {
      content: unknown[] | undefined;
      file?: string;
      target?: Obj;
      at: PathSeg[];
      json?: boolean;
    }[] = [];
    const load = async (
      path?: string,
      inline?: string,
    ): Promise<{ docs: YamlDoc[]; file?: string } | undefined> => {
      if (path !== undefined) {
        const f = join(dir, path);
        if (!all.has(f)) {
          warn(kf, `Patch ${path} is not in the repo; not applied.`);
          return undefined;
        }
        result.consumed.add(f);
        const d = await docsOf(f);
        return d ? { docs: d, file: f } : undefined;
      }
      if (inline !== undefined) {
        const d = readYamlDocs(inline);
        if (!d) warn(kf, "An inline patch is not valid YAML; not applied.");
        return d ? { docs: d } : undefined;
      }
      return undefined;
    };
    for (const [i, p] of arr(k.patchesStrategicMerge).entries()) {
      const s = str(p);
      if (!s) continue;
      const inline = s.includes("\n") || s.includes(":");
      const l = await load(inline ? undefined : s, inline ? s : undefined);
      if (l)
        patchList.push({
          content: l.docs.map((d) => d.value),
          file: l.file,
          at: ["patchesStrategicMerge", i],
        });
    }
    for (const [i, p] of arr(k.patches).entries()) {
      const l = await load(str(at(p, "path")), str(at(p, "patch")));
      if (!l) continue;
      const target = at(p, "target");
      patchList.push({
        content: l.docs.map((d) => d.value),
        file: l.file,
        ...(isObj(target) ? { target } : {}),
        at: ["patches", i],
      });
    }
    for (const [i, p] of arr(k.patchesJson6902).entries()) {
      const l = await load(str(at(p, "path")), str(at(p, "patch")));
      const target = at(p, "target");
      if (!l || !isObj(target)) continue;
      patchList.push({
        content: l.docs.map((d) => d.value),
        file: l.file,
        target,
        at: ["patchesJson6902", i],
        json: true,
      });
    }
    const label = (p: (typeof patchList)[number]) => p.file ?? `${kf} (inline patch)`;
    for (const p of patchList) {
      const source: Source = p.file ? { file: p.file, line: 1 } : src(p.at);
      for (const content of p.content ?? []) {
        const ops = Array.isArray(content) ? content : undefined;
        if (p.json && !ops) {
          warn(kf, `Patch ${label(p)} is not a JSON 6902 list of operations; not applied.`);
          continue;
        }
        const targets = p.target
          ? acc.filter((o) => matchesTarget(o, p.target!))
          : isObj(content) && !ops
            ? acc.filter(
                (o) =>
                  kindOf(o.obj) === str(content.kind) &&
                  o.names.includes(str(at(content, "metadata", "name")) ?? "\u0000"),
              )
            : [];
        if (!p.target && ops) {
          warn(kf, `Patch ${label(p)} is a JSON 6902 patch without a target; not applied.`);
          continue;
        }
        if (targets.length === 0) {
          warn(kf, `Patch ${label(p)} matches no object; not applied.`);
          continue;
        }
        for (const o of targets) {
          if (ops) {
            const res = applyJson6902(o.obj, ops);
            if (typeof res === "string") {
              warn(
                kf,
                `Patch ${label(p)} could not be applied to ${kindOf(o.obj)} ${nameOf(o.obj)}: ${res}.`,
              );
              continue;
            }
            o.obj = res;
          } else {
            const patch = clone(content) as Obj;
            if (p.target && isObj(patch.metadata)) delete patch.metadata.name;
            o.obj = smp(o.obj, patch, []) as Obj;
          }
          touch(o, source);
        }
      }
    }

    // namespace
    const ns = str(k.namespace);
    if (ns)
      for (const o of acc)
        if (!CLUSTER_KINDS.has(kindOf(o.obj))) {
          ensure(o.obj, "metadata").namespace = ns;
        }

    // namePrefix / nameSuffix
    const prefix = str(k.namePrefix) ?? "";
    const suffix = str(k.nameSuffix) ?? "";
    if (prefix || suffix)
      for (const o of acc) {
        if (kindOf(o.obj) === "Namespace" || kindOf(o.obj) === "CustomResourceDefinition") continue;
        const name = `${prefix}${nameOf(o.obj)}${suffix}`;
        ensure(o.obj, "metadata").name = name;
        o.names.push(name);
        touch(o, src([prefix ? "namePrefix" : "nameSuffix"]));
      }

    // labels and annotations
    const addLabels = (pairs: unknown, selectors: boolean, templates: boolean) => {
      if (!isObj(pairs)) return;
      const ls = Object.fromEntries(
        Object.entries(pairs).flatMap(([a, b]) => (str(b) !== undefined ? [[a, str(b)!]] : [])),
      );
      if (Object.keys(ls).length === 0) return;
      for (const o of acc) {
        Object.assign(ensure(o.obj, "metadata", "labels"), ls);
        const kind = kindOf(o.obj);
        if (selectors) {
          if (kind === "Service") Object.assign(ensure(o.obj, "spec", "selector"), ls);
          if (WORKLOADS.has(kind) && kind !== "Job") {
            if (kind === "DeploymentConfig") Object.assign(ensure(o.obj, "spec", "selector"), ls);
            else Object.assign(ensure(o.obj, "spec", "selector", "matchLabels"), ls);
          }
        }
        if (selectors || templates) {
          if (WORKLOADS.has(kind))
            Object.assign(ensure(o.obj, "spec", "template", "metadata", "labels"), ls);
          if (kind === "CronJob")
            Object.assign(
              ensure(o.obj, "spec", "jobTemplate", "spec", "template", "metadata", "labels"),
              ls,
            );
        }
      }
    };
    addLabels(k.commonLabels, true, true);
    for (const l of arr(k.labels))
      addLabels(
        at(l, "pairs"),
        at(l, "includeSelectors") === true,
        at(l, "includeTemplates") === true,
      );
    if (isObj(k.commonAnnotations))
      for (const o of acc) {
        Object.assign(ensure(o.obj, "metadata", "annotations"), k.commonAnnotations);
        if (WORKLOADS.has(kindOf(o.obj)))
          Object.assign(
            ensure(o.obj, "spec", "template", "metadata", "annotations"),
            k.commonAnnotations,
          );
      }

    // replicas
    for (const [i, r] of arr(k.replicas).entries()) {
      const name = str(at(r, "name"));
      const count = at(r, "count");
      if (!name || typeof count !== "number") continue;
      for (const o of acc)
        if (SCALABLE.has(kindOf(o.obj)) && o.names.includes(name)) {
          ensure(o.obj, "spec").replicas = count;
          touch(o, src(["replicas", i]));
        }
    }

    // images
    for (const [i, img] of arr(k.images).entries()) {
      const name = str(at(img, "name"));
      if (!name) continue;
      const newName = str(at(img, "newName"));
      const newTag = str(at(img, "newTag"));
      const digest = str(at(img, "digest"));
      for (const o of acc)
        if (setImages(o.obj, name, newName, newTag, digest)) touch(o, src(["images", i]));
    }
    return acc;
  };

  for (const kf of kfiles) {
    if (used.has(kf)) continue;
    const objs = await build(kf, [], []);
    fixReferences(objs);
    const ns = str(at((await docsOf(kf))?.[0]?.value, "namespace"));
    const env = envOf({ path: kf, ...(ns ? { namespace: ns } : {}) });
    result.overlays.push({ file: kf, ...(env ? { env } : {}), objects: objs });
  }
  return result;
}

function matchesTarget(o: KObject, t: Obj): boolean {
  const kind = str(t.kind);
  if (kind && kindOf(o.obj) !== kind) return false;
  const name = str(t.name);
  if (name && !o.names.some((n) => nameMatches(name, n))) return false;
  const ns = str(t.namespace);
  if (ns && str(at(o.obj, "metadata", "namespace")) !== ns) return false;
  const api = str(o.obj.apiVersion) ?? "";
  const group = api.includes("/") ? api.slice(0, api.indexOf("/")) : "";
  const version = api.includes("/") ? api.slice(api.indexOf("/") + 1) : api;
  if (str(t.group) !== undefined && str(t.group) !== group) return false;
  if (str(t.version) !== undefined && str(t.version) !== version) return false;
  const sel = str(t.labelSelector);
  if (sel) {
    const labels = at(o.obj, "metadata", "labels");
    for (const part of sel.split(",")) {
      const eq = part.indexOf("=");
      if (eq <= 0) return false;
      if (str(at(labels, part.slice(0, eq).trim())) !== part.slice(eq + 1).trim()) return false;
    }
  }
  return true;
}

/** A patch target's name: exact, or a pattern as kustomize allows (anchored). */
function nameMatches(pattern: string, name: string): boolean {
  if (pattern === name) return true;
  if (!/[.*+?^$()[\]{}|\\]/.test(pattern)) return false;
  try {
    return new RegExp(`^(?:${pattern})$`).test(name);
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ strategic merge

const MERGE_KEYS: Record<string, string> = {
  containers: "name",
  initContainers: "name",
  ephemeralContainers: "name",
  env: "name",
  volumes: "name",
  volumeMounts: "mountPath",
  imagePullSecrets: "name",
  hostAliases: "ip",
  topologySpreadConstraints: "topologyKey",
};

const DELETE = Symbol("delete");

/** Strategic merge patch, for the list merge keys of the core workload and Service types. */
export function smp(target: unknown, patch: unknown, path: readonly string[]): unknown {
  if (isObj(patch)) {
    const directive = str(patch.$patch);
    if (directive === "delete") return DELETE;
    const body = Object.fromEntries(Object.entries(patch).filter(([k]) => !k.startsWith("$")));
    if (directive === "replace") return clone(body);
    const out: Obj = isObj(target) ? clone(target) : {};
    for (const [k, v] of Object.entries(body)) {
      if (v === null) {
        delete out[k];
        continue;
      }
      const r = smp(out[k], v, [...path, k]);
      if (r === DELETE) delete out[k];
      else out[k] = r;
    }
    return out;
  }
  if (Array.isArray(patch)) {
    const key = path.at(-1) ?? "";
    const mergeKey =
      key === "ports" ? (path.at(-2) === "spec" ? "port" : "containerPort") : MERGE_KEYS[key];
    if (!mergeKey || !Array.isArray(target) || !patch.every(isObj)) return clone(patch);
    if (patch.some((p) => isObj(p) && p.$patch === "replace"))
      return patch.filter((p) => !(isObj(p) && p.$patch === "replace")).map(clone);
    const out = clone(target) as unknown[];
    for (const item of patch as Obj[]) {
      const idx = out.findIndex((t) => isObj(t) && t[mergeKey] === item[mergeKey]);
      if (item.$patch === "delete") {
        if (idx >= 0) out.splice(idx, 1);
        continue;
      }
      if (idx >= 0) out[idx] = smp(out[idx], item, [...path, String(idx)]);
      else out.push(smp(undefined, item, [...path, String(out.length)]));
    }
    return out;
  }
  return patch;
}

// ------------------------------------------------------------------ JSON 6902

function pointer(p: string): string[] | undefined {
  if (p === "") return [];
  if (!p.startsWith("/")) return undefined;
  return p
    .slice(1)
    .split("/")
    .map((s) => s.split("~1").join("/").split("~0").join("~"));
}

/** Apply JSON 6902 operations to a copy; a message instead when one can't be applied. */
export function applyJson6902(obj: Obj, ops: unknown[]): Obj | string {
  let doc: unknown = clone(obj);
  const parentOf = (segs: string[]) => {
    let cur = doc;
    for (const s of segs.slice(0, -1)) {
      if (Array.isArray(cur)) cur = cur[Number(s)];
      else if (isObj(cur)) cur = cur[s];
      else return undefined;
    }
    return cur;
  };
  const get = (segs: string[]) => {
    let cur = doc;
    for (const s of segs) {
      if (Array.isArray(cur)) cur = cur[Number(s)];
      else if (isObj(cur)) cur = cur[s];
      else return undefined;
    }
    return cur;
  };
  const remove = (segs: string[]): boolean => {
    const parent = parentOf(segs);
    const last = segs.at(-1)!;
    if (Array.isArray(parent)) {
      const i = Number(last);
      if (!Number.isInteger(i) || i < 0 || i >= parent.length) return false;
      parent.splice(i, 1);
      return true;
    }
    if (isObj(parent) && last in parent) {
      delete parent[last];
      return true;
    }
    return false;
  };
  const add = (segs: string[], value: unknown): boolean => {
    if (segs.length === 0) {
      doc = value;
      return true;
    }
    const parent = parentOf(segs);
    const last = segs.at(-1)!;
    if (Array.isArray(parent)) {
      if (last === "-") parent.push(value);
      else {
        const i = Number(last);
        if (!Number.isInteger(i) || i < 0 || i > parent.length) return false;
        parent.splice(i, 0, value);
      }
      return true;
    }
    if (isObj(parent)) {
      parent[last] = value;
      return true;
    }
    return false;
  };
  for (const raw of ops) {
    const op = str(at(raw, "op"));
    const path = pointer(str(at(raw, "path")) ?? "\u0000");
    if (!op || !path) return "an operation has no op or path";
    const value = clone(at(raw, "value"));
    if (op === "add") {
      if (!add(path, value)) return `${str(at(raw, "path"))} does not exist`;
    } else if (op === "remove") {
      if (!remove(path)) return `${str(at(raw, "path"))} does not exist`;
    } else if (op === "replace") {
      if (get(path) === undefined || !remove(path) || !add(path, value))
        return `${str(at(raw, "path"))} does not exist`;
    } else if (op === "copy" || op === "move") {
      const from = pointer(str(at(raw, "from")) ?? "\u0000");
      const v = from ? clone(get(from)) : undefined;
      if (!from || v === undefined) return `${str(at(raw, "from"))} does not exist`;
      if (op === "move" && !remove(from)) return `${str(at(raw, "from"))} does not exist`;
      if (!add(path, v)) return `${str(at(raw, "path"))} does not exist`;
    } else if (op === "test") {
      if (JSON.stringify(get(path)) !== JSON.stringify(value))
        return `the test of ${str(at(raw, "path"))} failed`;
    } else return `operation ${op} is not known`;
  }
  return isObj(doc) ? doc : "the patch replaced the whole object with something else";
}

// ------------------------------------------------------------------ images and references

/** Split `registry/repo:tag@digest` into its name and the rest. */
function imageName(image: string): string {
  const at_ = image.indexOf("@");
  const noDigest = at_ >= 0 ? image.slice(0, at_) : image;
  const colon = noDigest.lastIndexOf(":");
  return colon > noDigest.lastIndexOf("/") ? noDigest.slice(0, colon) : noDigest;
}

function setImages(
  o: unknown,
  name: string,
  newName: string | undefined,
  newTag: string | undefined,
  digest: string | undefined,
): boolean {
  let changed = false;
  const visit = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (isObj(v))
      for (const [k, x] of Object.entries(v)) {
        if ((k === "containers" || k === "initContainers") && Array.isArray(x)) {
          for (const c of x) {
            const image = str(at(c, "image"));
            if (!isObj(c) || !image || imageName(image) !== name) continue;
            const rest = image.slice(imageName(image).length);
            const tag = digest ? `@${digest}` : newTag ? `:${newTag}` : rest;
            c.image = `${newName ?? name}${tag}`;
            changed = true;
          }
        } else visit(x);
      }
  };
  visit(o);
  return changed;
}

/** Fields that name another object, by the kind they name: kustomize updates them on a rename. */
const REFERENCES: { kind: string; find: (o: Obj) => { holder: Obj; key: string }[] }[] = [
  {
    kind: "ConfigMap",
    find: (o) =>
      podSpecs(o).flatMap((spec) => [
        ...containersOf(spec).flatMap((c) => [
          ...arr(c.envFrom).flatMap((e) => holder(at(e, "configMapRef"))),
          ...arr(c.env).flatMap((e) => holder(at(e, "valueFrom", "configMapKeyRef"))),
        ]),
        ...arr(spec.volumes).flatMap((v) => holder(at(v, "configMap"))),
      ]),
  },
  {
    kind: "Secret",
    find: (o) =>
      podSpecs(o).flatMap((spec) => [
        ...containersOf(spec).flatMap((c) => [
          ...arr(c.envFrom).flatMap((e) => holder(at(e, "secretRef"))),
          ...arr(c.env).flatMap((e) => holder(at(e, "valueFrom", "secretKeyRef"))),
        ]),
        ...arr(spec.volumes).flatMap((v) => holder(at(v, "secret"), "secretName")),
      ]),
  },
  {
    kind: "Service",
    find: (o) => [
      ...arr(at(o, "spec", "rules")).flatMap((r) =>
        arr(at(r, "http", "paths")).flatMap((p) => holder(at(p, "backend", "service"))),
      ),
      ...holder(at(o, "spec", "defaultBackend", "service")),
      ...(kindOf(o) === "Route" && (str(at(o, "spec", "to", "kind")) ?? "Service") === "Service"
        ? holder(at(o, "spec", "to"))
        : []),
    ],
  },
  {
    kind: "*workload",
    find: (o) =>
      kindOf(o) === "HorizontalPodAutoscaler" ? holder(at(o, "spec", "scaleTargetRef")) : [],
  },
];

function holder(v: unknown, key = "name"): { holder: Obj; key: string }[] {
  return isObj(v) && typeof v[key] === "string" ? [{ holder: v, key }] : [];
}

function podSpecs(o: Obj): Obj[] {
  const kind = kindOf(o);
  const spec =
    kind === "CronJob"
      ? at(o, "spec", "jobTemplate", "spec", "template", "spec")
      : kind === "Pod"
        ? at(o, "spec")
        : at(o, "spec", "template", "spec");
  return isObj(spec) ? [spec] : [];
}

function containersOf(spec: Obj): Obj[] {
  return [...arr(spec.containers), ...arr(spec.initContainers)].filter(isObj);
}

/** After a build, point references at the renamed objects (kustomize's name reference step). */
function fixReferences(objs: KObject[]) {
  for (const ref of REFERENCES)
    for (const o of objs)
      for (const { holder: h, key } of ref.find(o.obj)) {
        const old = h[key] as string;
        const target = objs.find(
          (t) =>
            t !== o &&
            (ref.kind === "*workload" ? SCALABLE.has(kindOf(t.obj)) : kindOf(t.obj) === ref.kind) &&
            t.names.includes(old) &&
            (str(at(t.obj, "metadata", "namespace")) ?? "") ===
              (str(at(o.obj, "metadata", "namespace")) ?? ""),
        );
        if (target && nameOf(target.obj) !== old) h[key] = nameOf(target.obj);
      }
}
