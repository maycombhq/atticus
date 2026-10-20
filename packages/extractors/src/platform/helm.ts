import {
  Evaluator,
  Output,
  parseTemplate,
  TemplateUnreadable,
  UNKNOWN,
  type Template,
  type TemplateNode,
} from "./gotemplate.js";
import { arr, at, dirOf, isObj, slug, str, type Obj } from "./util.js";
import { readYamlDocs, type PathSeg, type YamlDoc } from "./yamldoc.js";
import type { ParseCache } from "@maycombhq/sdk";

/**
 * Helm charts read without running Helm (ADR 0064). For each chart (a folder with Chart.yaml
 * that isn't another chart's subchart) and each environment it has a values file for, the
 * values are layered (the chart's values.yaml, then the environment's file), subcharts get
 * their part of them, and every template is evaluated with the small reader in gotemplate.ts.
 * The rendered text, with a map back to template lines, goes to the same YAML and object
 * readers as plain manifests.
 */

/** Where a fact came from, besides the template itself: a values file and line. */
export interface Source {
  file: string;
  line?: number;
}

export interface RenderedFile {
  /** The template file. */
  file: string;
  /** The folder of the chart installed (the umbrella chart, for a subchart template). */
  release: string;
  /** The environment the values file is for; undefined when the chart has none. */
  env?: string;
  text: string;
  /** lines[i] is the template line of rendered line i + 1. */
  lines: number[];
  /** Values files (and lines) the template read. */
  sources: Source[];
}

export interface HelmResult {
  rendered: RenderedFile[];
  warnings: { message: string; path: string }[];
  /** Every file that belongs to a chart: never read as a plain manifest. */
  chartFiles: Set<string>;
}

export type ReadText = (path: string) => Promise<string | undefined>;

const join = (dir: string, rel: string) => normalize(dir ? `${dir}/${rel}` : rel);

/** Resolve `.` and `..` in a repo-relative path; undefined when it leaves the repo. */
export function normalize(path: string): string {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return "\u0000outside";
      out.pop();
    } else out.push(seg);
  }
  return out.join("/");
}

const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const YAML_EXT = [".yaml", ".yml"];
const hasYamlExt = (p: string) => YAML_EXT.some((e) => p.endsWith(e));
const stripExt = (p: string) => p.slice(0, p.lastIndexOf("."));

/** The environment a values file is for, from its path inside the chart; undefined when none. */
export function valuesEnv(rel: string): string | undefined {
  if (!hasYamlExt(rel)) return undefined;
  const parts = rel.split("/");
  const name = stripExt(parts.at(-1)!);
  if (parts.length === 1) {
    for (const sep of ["-", ".", "_"])
      if (name.startsWith(`values${sep}`) && name.length > 7) return slug(name.slice(7));
    return undefined;
  }
  const ENV_DIRS = new Set(["environments", "envs", "env"]);
  if (parts.length === 2 && parts[0] === "values") return slug(name);
  if (parts.length === 2 && ENV_DIRS.has(parts[0]!)) return slug(name);
  if (parts.length === 3 && ENV_DIRS.has(parts[0]!) && name === "values") return slug(parts[1]!);
  return undefined;
}

interface Layer {
  file: string;
  doc: YamlDoc;
  /** Path inside this file's values to the chart's own values. */
  prefix: PathSeg[];
}

interface Chart {
  dir: string;
  meta: Obj;
  name: string;
  templates: string[];
  subcharts: { key: string; chart: Chart; condition?: string; tags: string[] }[];
}

/** Deep-merge Helm values: maps merge, anything else is replaced, null removes a key. */
export function mergeValues(base: unknown, over: unknown): unknown {
  if (!isObj(over)) return over === undefined ? clone(base) : clone(over);
  const out: Obj = isObj(base) ? (clone(base) as Obj) : {};
  for (const [k, v] of Object.entries(over)) {
    if (v === null) delete out[k];
    else out[k] = isObj(v) && isObj(out[k]) ? mergeValues(out[k], v) : clone(v);
  }
  return out;
}

function clone(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(clone);
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)]));
  return v;
}

function registerPaths(v: unknown, path: PathSeg[], into: WeakMap<object, PathSeg[]>) {
  if (Array.isArray(v)) {
    into.set(v, path);
    v.forEach((x, i) => registerPaths(x, [...path, i], into));
  } else if (isObj(v)) {
    into.set(v, path);
    for (const [k, x] of Object.entries(v)) registerPaths(x, [...path, k], into);
  }
}

export async function renderCharts(
  paths: readonly string[],
  read: ReadText,
  /** The repo scan's parse cache (ADR 0067): values files and charts parsed once. */
  cache?: ParseCache,
): Promise<HelmResult> {
  const result: HelmResult = { rendered: [], warnings: [], chartFiles: new Set() };
  const all = new Set(paths);
  const chartDirs = paths
    .filter((p) => baseName(p) === "Chart.yaml")
    .map(dirOf)
    .sort();
  if (chartDirs.length === 0) return result;
  const isChart = new Set(chartDirs);
  for (const p of paths)
    if (chartDirs.some((d) => p.startsWith(d ? `${d}/templates/` : "templates/")))
      result.chartFiles.add(p);
  const yamlCache = new Map<string, YamlDoc | null>();
  const yamlOf = async (file: string): Promise<YamlDoc | undefined> => {
    if (!yamlCache.has(file)) {
      const text = await read(file);
      const docs = text === undefined ? undefined : readYamlDocs(text, { cache, path: file });
      if (text !== undefined && !docs)
        result.warnings.push({
          message: "Could not read this file as YAML; skipped it.",
          path: file,
        });
      yamlCache.set(file, docs?.[0] ?? (docs ? { value: {}, line: () => undefined } : null));
    }
    return yamlCache.get(file) ?? undefined;
  };

  const loading = new Set<string>();
  const loadChart = async (dir: string): Promise<Chart | undefined> => {
    if (loading.has(dir)) return undefined;
    loading.add(dir);
    const metaDoc = await yamlOf(join(dir, "Chart.yaml"));
    const meta = isObj(metaDoc?.value) ? metaDoc.value : {};
    const name = str(meta.name) ?? baseName(dir);
    const templates = paths
      .filter((p) => p.startsWith(dir ? `${dir}/templates/` : "templates/"))
      .filter(
        (p) => !p.slice((dir ? dir.length + 1 : 0) + "templates/".length).startsWith("tests/"),
      )
      .sort();
    const chart: Chart = { dir, meta, name, templates, subcharts: [] };
    const req = await (all.has(join(dir, "requirements.yaml"))
      ? yamlOf(join(dir, "requirements.yaml"))
      : undefined);
    const deps = [...arr(meta.dependencies), ...arr(at(req?.value, "dependencies"))];
    const used = new Set<string>();
    for (const d of deps) {
      const depName = str(at(d, "name"));
      if (!depName) continue;
      const repoUrl = str(at(d, "repository")) ?? "";
      const local = repoUrl.startsWith("file://")
        ? join(dir, repoUrl.slice("file://".length))
        : join(dir, `charts/${depName}`);
      if (!isChart.has(local)) {
        result.warnings.push({
          message: `Chart dependency ${depName}${repoUrl ? ` (${repoUrl})` : ""} is not in the repo; its templates are not read.`,
          path: join(dir, "Chart.yaml"),
        });
        continue;
      }
      used.add(local);
      const sub = await loadChart(local);
      if (!sub) continue;
      const condition = str(at(d, "condition"));
      chart.subcharts.push({
        key: str(at(d, "alias")) ?? depName,
        chart: sub,
        ...(condition ? { condition } : {}),
        tags: arr(at(d, "tags")).flatMap((t) => (str(t) ? [str(t)!] : [])),
      });
    }
    // Helm also renders any chart in charts/ that Chart.yaml doesn't list.
    const prefix = dir ? `${dir}/charts/` : "charts/";
    for (const d of chartDirs) {
      if (!d.startsWith(prefix) || d.slice(prefix.length).includes("/") || used.has(d)) continue;
      const sub = await loadChart(d);
      if (sub) chart.subcharts.push({ key: sub.name, chart: sub, tags: [] });
    }
    loading.delete(dir); // guards against a loop only: one subchart can be used twice (alias)
    return chart;
  };

  const parsed = new Map<string, Template | TemplateUnreadable>();
  const parseOf = async (file: string) => {
    if (!parsed.has(file)) {
      const text = (await read(file)) ?? "";
      try {
        parsed.set(file, parseTemplate(text));
      } catch (e) {
        parsed.set(file, e instanceof TemplateUnreadable ? e : new TemplateUnreadable(String(e)));
      }
    }
    return parsed.get(file)!;
  };

  const warned = new Set<string>();
  const warn = (path: string, message: string) => {
    const k = `${path}\u0000${message}`;
    if (warned.has(k)) return;
    warned.add(k);
    result.warnings.push({ message, path });
  };

  const isSub = (d: string) => {
    const m = d.split("/");
    return m.length >= 2 && m.at(-2) === "charts" && isChart.has(m.slice(0, -2).join("/"));
  };

  for (const dir of chartDirs.filter((d) => !isSub(d))) {
    loading.clear();
    const chart = await loadChart(dir);
    if (!chart) continue;
    const base = all.has(join(dir, "values.yaml"))
      ? join(dir, "values.yaml")
      : all.has(join(dir, "values.yml"))
        ? join(dir, "values.yml")
        : undefined;
    const envFiles = new Map<string, string[]>();
    for (const p of paths) {
      if (!p.startsWith(dir ? `${dir}/` : "")) continue;
      const rel = dir ? p.slice(dir.length + 1) : p;
      if (rel.startsWith("templates/") || rel.startsWith("charts/")) continue;
      const env = valuesEnv(rel);
      if (env) envFiles.set(env, [...(envFiles.get(env) ?? []), p].sort());
    }
    const runs: { env?: string; files: string[] }[] =
      envFiles.size > 0
        ? [...envFiles.keys()].sort().map((env) => ({ env, files: envFiles.get(env)! }))
        : [{ files: [] }];

    // Every define of the chart and its subcharts; the parent's win, as in Helm.
    const defines = new Map<string, TemplateNode[]>();
    const collectDefines = async (c: Chart) => {
      for (const s of c.subcharts) await collectDefines(s.chart);
      for (const t of c.templates) {
        const p = await parseOf(t);
        if (p instanceof TemplateUnreadable) continue;
        for (const [k, v] of p.defines) defines.set(k, v);
      }
    };
    await collectDefines(chart);

    for (const run of runs) {
      const layers: Layer[] = [];
      for (const f of [...(base ? [base] : []), ...run.files]) {
        const doc = await yamlOf(f);
        if (doc) layers.push({ file: f, doc, prefix: [] });
      }
      let values: unknown = {};
      for (const l of layers) values = mergeValues(values, isObj(l.doc.value) ? l.doc.value : {});
      // Helm always gives a chart a global map.
      if (!isObj((values as Obj).global)) (values as Obj).global = {};
      await renderChart(chart, values as Obj, layers, run.env, chart.name, defines, dir);
    }
  }

  async function renderChart(
    chart: Chart,
    values: Obj,
    layers: Layer[],
    env: string | undefined,
    release: string,
    defines: Map<string, TemplateNode[]>,
    releaseDir: string,
  ) {
    const vpaths = new WeakMap<object, PathSeg[]>();
    registerPaths(values, [], vpaths);
    const chartObj = {
      Name: chart.name,
      Version: str(chart.meta.version) ?? null,
      AppVersion: str(chart.meta.appVersion) ?? null,
      Description: str(chart.meta.description) ?? null,
      Type: str(chart.meta.type) ?? "application",
      ApiVersion: str(chart.meta.apiVersion) ?? null,
    };
    for (const file of chart.templates) {
      const name = baseName(file);
      if (
        name.startsWith("_") ||
        name === "NOTES.txt" ||
        !(hasYamlExt(name) || name.endsWith(".tpl"))
      )
        continue;
      const tpl = await parseOf(file);
      if (tpl instanceof TemplateUnreadable) {
        warn(file, unreadable(tpl, await read(file)));
        continue;
      }
      const used: PathSeg[][] = [];
      const ev = new Evaluator({
        defines,
        valuePaths: vpaths,
        onValuesRead: (p) => used.push(p),
      });
      const dot = {
        Values: values,
        Release: {
          Name: release,
          Namespace: UNKNOWN,
          Service: "Helm",
          IsInstall: UNKNOWN,
          IsUpgrade: UNKNOWN,
          Revision: UNKNOWN,
        },
        Chart: chartObj,
        Capabilities: UNKNOWN,
        Files: UNKNOWN,
        Template: {
          Name: `${chart.name}/${file.slice(chart.dir ? chart.dir.length + 1 : 0)}`,
          BasePath: `${chart.name}/templates`,
        },
      };
      const out = new Output();
      try {
        ev.render(tpl.nodes, dot, out);
      } catch (e) {
        if (!(e instanceof TemplateUnreadable)) throw e;
        warn(file, unreadable(e, await read(file)));
        continue;
      }
      const src = (await read(file)) ?? "";
      result.rendered.push({
        file,
        release: releaseDir,
        ...(env ? { env } : {}),
        text: out.text(),
        lines: out.lines(src),
        sources: sourcesOf(used, layers),
      });
    }
    for (const s of chart.subcharts) {
      if (!enabled(s, values)) continue;
      const own = all.has(join(s.chart.dir, "values.yaml"))
        ? join(s.chart.dir, "values.yaml")
        : undefined;
      const ownDoc = own ? await yamlOf(own) : undefined;
      const fromParent = values[s.key];
      const subValues = mergeValues(
        isObj(ownDoc?.value) ? ownDoc.value : {},
        isObj(fromParent) ? fromParent : {},
      ) as Obj;
      // A subchart sees the parent's globals over its own.
      subValues.global = mergeValues(
        isObj(subValues.global) ? subValues.global : {},
        isObj(values.global) ? values.global : {},
      );
      const subLayers: Layer[] = [
        ...(ownDoc && own ? [{ file: own, doc: ownDoc, prefix: [] }] : []),
        ...layers.map((l) => ({ ...l, prefix: [...l.prefix, s.key] })),
      ];
      await renderChart(
        { ...s.chart, name: s.key },
        subValues,
        subLayers,
        env,
        release,
        defines,
        releaseDir,
      );
    }
  }

  return result;
}

function enabled(s: Chart["subcharts"][number], parent: Obj): boolean {
  if (s.condition) {
    for (const c of s.condition.split(",")) {
      const v = at(parent, ...c.trim().split("."));
      if (typeof v === "boolean") return v;
    }
  }
  if (s.tags.length > 0) {
    const tags = at(parent, "tags");
    const vals = s.tags.map((t) => at(tags, t));
    if (vals.every((v) => v === false)) return false;
  }
  return true;
}

/** For each values file a template read from, the first line it read. */
function sourcesOf(read: PathSeg[][], layers: Layer[]): Source[] {
  const best = new Map<string, number | undefined>();
  for (const p of read) {
    for (let i = layers.length - 1; i >= 0; i--) {
      const l = layers[i]!;
      const tryPath = (full: PathSeg[]) =>
        at(l.doc.value, ...full) !== undefined ? l.doc.line(full) : null;
      let line = tryPath([...l.prefix, ...p]);
      if (line === null && p[0] === "global") line = tryPath(p);
      if (line === null) continue;
      const prev = best.get(l.file);
      if (!best.has(l.file) || (line !== undefined && (prev === undefined || line < prev)))
        best.set(l.file, line);
      break;
    }
  }
  const order = layers.map((l) => l.file);
  return [...best.entries()]
    .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([file, line]) => ({ file, ...(line !== undefined ? { line } : {}) }));
}

function unreadable(e: TemplateUnreadable, src: string | undefined): string {
  const line =
    e.pos !== undefined && src !== undefined ? src.slice(0, e.pos).split("\n").length : undefined;
  return `Could not read this Helm template${line ? ` at line ${line}` : ""}: ${e.message}. Its objects are not read.`;
}
