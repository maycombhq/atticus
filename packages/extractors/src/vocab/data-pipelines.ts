import type { CatalogRecord } from "@maycombhq/core";
import { defineExtractor, type RepoHandle, type ScanContext } from "@maycombhq/sdk";
import { tablesInQuery } from "../lang/sql.js";
import { loadManifests, readYamlDocs } from "../platform/manifests.js";
import { at, componentFor, envOf, str } from "../platform/util.js";
import {
  component,
  ev,
  lineAt,
  loose,
  own,
  read,
  setting,
  slug,
  sources,
  stripComments,
} from "./common.js";

/**
 * Data pipelines (ADR 0040): Components of type `data-pipeline`, `schedule` Settings and table
 * lineage as readers and writers.
 *
 * - Airflow: each `DAG(...)`/`with DAG(...)`/`@dag(...)` is a component named by its dag id
 *   (runtime airflow), with its `schedule`/`schedule_interval` as a Setting
 *   `schedule.<dag id>`; literal `sql="..."` in its file gives db-access loose ends. A repo with
 *   exactly one DAG whose component the manifest names is that DAG's component (the DAG is what
 *   the repo is), so the Setting belongs to it and the dag id stays in the key.
 * - dbt: the project (`dbt_project.yml`) is the repo's component (runtime dbt, unless the repo's
 *   DAG already is that component). Models write Tables on a `warehouse` DataStore: the one named
 *   by the host of the profile's target output in `profiles.yml` (its first label, which is also
 *   what Terraform calls the cluster), else `<profile>-warehouse`. A model is a `view` unless the
 *   nearest `+materialized` of its folder in `dbt_project.yml`, or a `config(materialized=...)`
 *   in the model, says table or incremental; its evidence is its first line of SQL that is not
 *   a comment. A source a model selects from is a Table of the database `sources.yml` gives it
 *   (inferred, read by the project, evidenced at its entry in sources.yml); one with no database
 *   is only a table name, a db-access read loose end. `ref()` between models of one project is
 *   the project's own flow and isn't recorded.
 * - Spark: `SparkApplication` and `ScheduledSparkApplication` manifests are components
 *   (runtime spark, schedule as a Setting); PySpark/Scala `spark.read.table("x")`,
 *   `spark.table("x")` and `.saveAsTable("x")`/`.insertInto("x")` are db-access loose ends of the
 *   repo's component. Table names lose their schema, as for every db-access loose end.
 */

const PY = ["**/*.py"];
const SCALA = ["**/*.scala"];
const DBT = ["**/dbt_project.yml"];
const PROFILES = ["**/profiles.yml"];
const SQL = ["**/*.sql"];
const MANIFESTS = ["**/*.yaml", "**/*.yml"];

/** The value of a keyword argument written as a string literal, with its offset. */
function kwarg(args: string, name: string): { value: string; at: number } | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(args);
  return m ? { value: m[1] ?? m[2]!, at: m.index } : undefined;
}

export const dataPipelinesExtractor = defineExtractor({
  id: "data-pipelines",
  version: "0.1.1",
  claims: [...PY, ...SCALA, ...DBT, ...PROFILES, ...SQL, ...MANIFESTS],
  async *scan(repo, ctx) {
    // Components already emitted: the repo's DAG and its dbt project can be one component.
    const emitted = new Set<string>();
    yield* airflow(repo, ctx, emitted);
    yield* dbt(repo, ctx, emitted);
    yield* spark(repo, ctx, emitted);
  },
});

interface Dag {
  id: string;
  path: string;
  clean: string;
  at: number;
  args: string;
  argsAt: number;
  /** Where the DAG's body ends: the next DAG of the file, or the file's end. */
  end: number;
}

async function* airflow(
  repo: RepoHandle,
  ctx: ScanContext,
  emitted: Set<string>,
): AsyncGenerator<CatalogRecord> {
  const dags: Dag[] = [];
  for (const path of await sources(repo, PY)) {
    const text = await read(repo, ctx, path);
    if (text === undefined || !/\bDAG\s*\(|@dag\b/.test(text) || !/airflow/.test(text)) continue;
    const clean = stripComments(text, "hash");
    const found: Omit<Dag, "end">[] = [];
    for (const m of clean.matchAll(/\bDAG\s*\(/g)) {
      const open = m.index + m[0].length;
      const close = closeParen(clean, open - 1);
      const args = clean.slice(open, close);
      const id =
        kwarg(args, "dag_id")?.value ??
        /^\s*(?:"([^"]+)"|'([^']+)')/.exec(args)?.slice(1).find(Boolean);
      if (id) found.push({ id, path, clean, at: m.index, args, argsAt: open });
    }
    for (const m of clean.matchAll(/@dag\s*\(/g)) {
      const open = m.index + m[0].length;
      const close = closeParen(clean, open - 1);
      const args = clean.slice(open, close);
      const fn = /\bdef\s+(\w+)/.exec(clean.slice(close))?.[1];
      const id = kwarg(args, "dag_id")?.value ?? fn;
      if (id) found.push({ id, path, clean, at: m.index, args, argsAt: open });
    }
    found.sort((a, b) => a.at - b.at);
    for (const [i, d] of found.entries())
      dags.push({ ...d, end: found[i + 1]?.at ?? clean.length });
  }
  // One DAG in the whole repo, in a repo the manifest gives a component: the DAG is that component.
  const lone = dags.length === 1 ? ctx.component : undefined;
  for (const d of dags) {
    const comp = lone ?? componentFor(ctx, [d.id]);
    if (!emitted.has(comp)) {
      emitted.add(comp);
      yield component({
        repo,
        ctx,
        id: comp,
        type: "data-pipeline",
        runtime: "airflow",
        source: "code",
        path: d.path,
        line: lineAt(d.clean, d.at),
      });
    }
    const sched = kwarg(d.args, "schedule") ?? kwarg(d.args, "schedule_interval");
    if (sched)
      yield setting({
        repo,
        component: comp,
        settingKind: "schedule",
        key: `schedule.${d.id}`,
        value: sched.value,
        source: "code",
        path: d.path,
        line: lineAt(d.clean, d.argsAt + sched.at),
      });
    // SQL written in the file, up to the next DAG.
    const body = d.clean.slice(d.at, d.end);
    for (const s of body.matchAll(/\bsql\s*=\s*(?:"""([\s\S]*?)"""|"([^"]*)"|'([^']*)')/g)) {
      const q = s[1] ?? s[2] ?? s[3] ?? "";
      const line = lineAt(d.clean, d.at + s.index);
      for (const t of tablesInQuery(q))
        yield loose(repo, comp, "db-access", `${t.access} ${t.table}`, d.path, line);
    }
  }
}

function closeParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return i;
  }
  return text.length;
}

/**
 * The first line of a model's SQL that is not blank or a comment (a line comment, a block comment
 * or a Jinja comment), 1-based; line 1 when the file is all comments.
 */
function firstCodeLine(sql: string): number {
  let block: string | undefined;
  for (const [i, raw] of sql.split("\n").entries()) {
    let s = raw.trim();
    while (s) {
      if (block) {
        const end = s.indexOf(block);
        if (end < 0) break;
        s = s.slice(end + block.length).trim();
        block = undefined;
      } else if (s.startsWith("--")) break;
      else if (s.startsWith("/*")) {
        block = "*/";
        s = s.slice(2);
      } else if (s.startsWith("{#")) {
        block = "#}";
        s = s.slice(2);
      } else return i + 1;
    }
  }
  return 1;
}

/** The nearest `+materialized` for a folder under `models`, from `dbt_project.yml`'s `models:`. */
function folderMaterialization(
  project: unknown,
  name: string,
  dirs: readonly string[],
): string | undefined {
  const pick = (n: unknown) => str(at(n, "+materialized")) ?? str(at(n, "materialized"));
  let node = at(project, "models", name);
  let found = pick(node);
  for (const d of dirs) {
    node = at(node, d);
    if (node === undefined) break;
    found = pick(node) ?? found;
  }
  return found;
}

/** The first label of a concrete (not templated, not local) host. */
function hostLabel(host: string | undefined): string | undefined {
  if (!host || host.includes("{")) return undefined;
  const label = host.toLowerCase().split(".")[0]!;
  return /[a-z]/.test(label) && label !== "localhost" ? slug(label) : undefined;
}

/** The warehouse a dbt profile's target output points at, named by its host's first label. */
async function profileWarehouse(
  repo: RepoHandle,
  ctx: ScanContext,
  profile: string,
): Promise<{ id: string; path: string; line: number | undefined } | undefined> {
  for (const path of await sources(repo, PROFILES)) {
    const text = await read(repo, ctx, path);
    const doc = text !== undefined ? readYamlDocs(text)?.[0] : undefined;
    const prof = at(doc?.value, profile);
    if (!doc || prof === undefined) continue;
    const outputs = at(prof, "outputs");
    const target = str(at(prof, "target"));
    const names = [
      ...(target ? [target] : []),
      ...(outputs && typeof outputs === "object" ? Object.keys(outputs) : []),
    ];
    for (const o of names) {
      const id = hostLabel(str(at(outputs, o, "host")));
      if (id) return { id, path, line: doc.line([profile, "outputs", o, "host"]) };
    }
  }
  return undefined;
}

/** A dbt source table: the database it lives in (if sources.yml names one) and where it is declared. */
interface DeclaredSource {
  database: string | undefined;
  path: string;
  line: number | undefined;
}

async function declaredSources(
  repo: RepoHandle,
  ctx: ScanContext,
  modelsDir: string,
): Promise<Map<string, DeclaredSource>> {
  const out = new Map<string, DeclaredSource>();
  for (const path of await sources(repo, MANIFESTS)) {
    if (!path.startsWith(modelsDir)) continue;
    const text = await read(repo, ctx, path);
    if (text === undefined || !/^sources\s*:/m.test(text)) continue;
    const doc = readYamlDocs(text)?.[0];
    const list = at(doc?.value, "sources");
    if (!doc || !Array.isArray(list)) continue;
    for (const [si, s] of list.entries()) {
      const source = str(at(s, "name"));
      const tables = at(s, "tables");
      if (!source || !Array.isArray(tables)) continue;
      const db = str(at(s, "database"));
      const database = db && !db.includes("{") ? db : undefined;
      for (const [ti, t] of tables.entries()) {
        const table = str(at(t, "name"));
        if (table)
          out.set(`${source}.${table}`, {
            database,
            path,
            line: doc.line(["sources", si, "tables", ti]),
          });
      }
    }
  }
  return out;
}

async function* dbt(
  repo: RepoHandle,
  ctx: ScanContext,
  emitted: Set<string>,
): AsyncGenerator<CatalogRecord> {
  for (const projectFile of await sources(repo, DBT)) {
    const text = await read(repo, ctx, projectFile);
    if (text === undefined) continue;
    const project = readYamlDocs(text)?.[0]?.value;
    const name = /^name\s*:\s*["']?([\w-]+)/m.exec(text)?.[1] ?? "dbt";
    const profile = /^profile\s*:\s*["']?([\w-]+)/m.exec(text)?.[1] ?? name;
    const root = projectFile.includes("/")
      ? projectFile.slice(0, projectFile.lastIndexOf("/") + 1)
      : "";
    const modelsDir = `${root}models/`;
    const comp = own(repo, ctx);
    const warehouse = await profileWarehouse(repo, ctx, profile);
    const store = warehouse?.id ?? `${slug(profile)}-warehouse`;
    if (!emitted.has(comp)) {
      emitted.add(comp);
      yield component({
        repo,
        ctx,
        id: comp,
        type: "data-pipeline",
        runtime: "dbt",
        source: "config",
        path: projectFile,
        line: lineAt(text, text.search(/^name\s*:/m)),
      });
    }
    yield {
      schemaVersion: 2,
      kind: "DataStore",
      id: store,
      status: "current",
      confidence: "verified",
      storeType: "warehouse",
      entitiesHeld: [],
      evidence: [
        warehouse
          ? ev(repo, "config", warehouse.path, warehouse.line)
          : ev(
              repo,
              "config",
              projectFile,
              lineAt(text, Math.max(0, text.search(/^profile\s*:/m))),
            ),
      ],
    } as unknown as CatalogRecord;
    const declared = await declaredSources(repo, ctx, modelsDir);
    const reads = new Map<string, CatalogRecord>();
    const models: CatalogRecord[] = [];
    const unresolved: CatalogRecord[] = [];
    for (const path of await sources(repo, SQL)) {
      if (!path.startsWith(modelsDir)) continue;
      const sql = await read(repo, ctx, path);
      if (sql === undefined) continue;
      const parts = path.slice(modelsDir.length).split("/");
      const model = parts.pop()!.replace(/\.sql$/, "");
      const mat =
        /config\s*\([^)]*materialized\s*=\s*["'](\w+)["']/.exec(sql)?.[1] ??
        folderMaterialization(project, name, parts);
      models.push({
        schemaVersion: 2,
        kind: "Table",
        id: `${store}.${slug(model)}`,
        status: "current",
        confidence: "verified",
        dataStore: store,
        name: model,
        tableKind: mat === "table" || mat === "incremental" ? "table" : "view",
        ownerComponent: comp,
        readers: [],
        writers: [comp],
        evidence: [ev(repo, "code", path, firstCodeLine(sql))],
      } as unknown as CatalogRecord);
      for (const m of sql.matchAll(
        /\{\{\s*source\s*\(\s*["'](\w+)["']\s*,\s*["'](\w+)["']\s*\)\s*\}\}/g,
      )) {
        const src = declared.get(`${m[1]}.${m[2]}`);
        if (src?.database) {
          const id = `${slug(src.database)}.${slug(m[2]!)}`;
          if (!reads.has(id))
            reads.set(id, {
              schemaVersion: 2,
              kind: "Table",
              id,
              status: "current",
              confidence: "inferred",
              dataStore: slug(src.database),
              name: m[2]!,
              tableKind: "table",
              readers: [comp],
              writers: [],
              evidence: [ev(repo, "code", src.path, src.line, "caller")],
            } as unknown as CatalogRecord);
        } else
          unresolved.push(
            loose(repo, comp, "db-access", `read ${m[2]}`, path, lineAt(sql, m.index)),
          );
      }
    }
    yield* models;
    yield* reads.values();
    yield* unresolved;
  }
}

async function* spark(
  repo: RepoHandle,
  ctx: ScanContext,
  emitted: Set<string>,
): AsyncGenerator<CatalogRecord> {
  const set = await loadManifests(repo, ctx, /SparkApplication/, MANIFESTS);
  for (const o of set.objects) {
    if (o.kind !== "SparkApplication" && o.kind !== "ScheduledSparkApplication") continue;
    const comp = componentFor(ctx, [o.labels.app, o.name]);
    if (!emitted.has(comp)) {
      emitted.add(comp);
      yield component({
        repo,
        ctx,
        id: comp,
        type: "data-pipeline",
        runtime: "spark",
        source: "infrastructure",
        path: o.file,
        line: o.line(),
      });
    }
    const schedule = str(at(o.obj, "spec", "schedule"));
    if (schedule) {
      const env = envOf({ namespace: o.namespace, path: o.file, name: o.name });
      yield setting({
        repo,
        component: comp,
        env,
        settingKind: "schedule",
        key: `schedule.${o.name}`,
        value: schedule,
        source: "infrastructure",
        path: o.file,
        line: o.line(["spec", "schedule"]),
      });
    }
  }
  const comp = own(repo, ctx);
  for (const path of await sources(repo, [...PY, ...SCALA])) {
    const text = await read(repo, ctx, path);
    if (text === undefined || !/\bspark\b|SparkSession/.test(text)) continue;
    const clean = stripComments(text, path.endsWith(".py") ? "hash" : "c");
    const name = (s: string) => s.split(".").pop()!;
    for (const m of clean.matchAll(
      /\bspark\s*\.\s*(?:read\s*\.\s*table|table)\s*\(\s*["']([\w.]+)["']/g,
    ))
      yield loose(repo, comp, "db-access", `read ${name(m[1]!)}`, path, lineAt(clean, m.index));
    for (const m of clean.matchAll(/\.\s*(?:saveAsTable|insertInto)\s*\(\s*["']([\w.]+)["']/g))
      yield loose(repo, comp, "db-access", `write ${name(m[1]!)}`, path, lineAt(clean, m.index));
  }
}
