import type { CatalogRecord } from "@maycombhq/core";
import { defineExtractor, type RepoHandle, type ScanContext } from "@maycombhq/sdk";
import { tablesInQuery } from "../lang/sql.js";
import { loadManifests } from "../platform/manifests.js";
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
 *   `schedule.<dag id>`; literal `sql="..."` in its file gives db-access loose ends.
 * - dbt: the project (`dbt_project.yml`) is the repo's component (runtime dbt). Models write
 *   Tables on a `warehouse` DataStore `<profile>-warehouse` (`view` unless the model's config
 *   says table or incremental), and sources a model selects from are Tables it reads.
 *   `ref()` between models of one project is the project reading itself and isn't recorded.
 * - Spark: `SparkApplication` and `ScheduledSparkApplication` manifests are components
 *   (runtime spark, schedule as a Setting); PySpark/Scala `spark.read.table("x")`,
 *   `spark.table("x")` and `.saveAsTable("x")`/`.insertInto("x")` are db-access loose ends of the
 *   repo's component. Table names lose their schema, as for every db-access loose end.
 */

const PY = ["**/*.py"];
const SCALA = ["**/*.scala"];
const DBT = ["**/dbt_project.yml"];
const SQL = ["**/*.sql"];
const MANIFESTS = ["**/*.yaml", "**/*.yml"];

/** The value of a keyword argument written as a string literal, with its offset. */
function kwarg(args: string, name: string): { value: string; at: number } | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(args);
  return m ? { value: m[1] ?? m[2]!, at: m.index } : undefined;
}

export const dataPipelinesExtractor = defineExtractor({
  id: "data-pipelines",
  version: "0.1.0",
  claims: [...PY, ...SCALA, ...DBT, ...SQL, ...MANIFESTS],
  async *scan(repo, ctx) {
    yield* airflow(repo, ctx);
    yield* dbt(repo, ctx);
    yield* spark(repo, ctx);
  },
});

async function* airflow(repo: RepoHandle, ctx: ScanContext): AsyncGenerator<CatalogRecord> {
  for (const path of await sources(repo, PY)) {
    const text = await read(repo, ctx, path);
    if (text === undefined || !/\bDAG\s*\(|@dag\b/.test(text) || !/airflow/.test(text)) continue;
    const clean = stripComments(text, "hash");
    const dags: { id: string; at: number; args: string; argsAt: number }[] = [];
    for (const m of clean.matchAll(/\bDAG\s*\(/g)) {
      const open = m.index + m[0].length;
      const close = closeParen(clean, open - 1);
      const args = clean.slice(open, close);
      const id =
        kwarg(args, "dag_id")?.value ??
        /^\s*(?:"([^"]+)"|'([^']+)')/.exec(args)?.slice(1).find(Boolean);
      if (id) dags.push({ id, at: m.index, args, argsAt: open });
    }
    for (const m of clean.matchAll(/@dag\s*\(/g)) {
      const open = m.index + m[0].length;
      const close = closeParen(clean, open - 1);
      const args = clean.slice(open, close);
      const fn = /\bdef\s+(\w+)/.exec(clean.slice(close))?.[1];
      const id = kwarg(args, "dag_id")?.value ?? fn;
      if (id) dags.push({ id, at: m.index, args, argsAt: open });
    }
    dags.sort((a, b) => a.at - b.at);
    for (const [i, d] of dags.entries()) {
      const comp = componentFor(ctx, [d.id]);
      yield component({
        repo,
        ctx,
        id: comp,
        type: "data-pipeline",
        runtime: "airflow",
        source: "code",
        path,
        line: lineAt(clean, d.at),
      });
      const sched = kwarg(d.args, "schedule") ?? kwarg(d.args, "schedule_interval");
      if (sched)
        yield setting({
          repo,
          component: comp,
          settingKind: "schedule",
          key: `schedule.${d.id}`,
          value: sched.value,
          source: "code",
          path,
          line: lineAt(clean, d.argsAt + sched.at),
        });
      // SQL written in the file, up to the next DAG.
      const body = clean.slice(d.at, dags[i + 1]?.at ?? clean.length);
      for (const s of body.matchAll(/\bsql\s*=\s*(?:"""([\s\S]*?)"""|"([^"]*)"|'([^']*)')/g)) {
        const q = s[1] ?? s[2] ?? s[3] ?? "";
        const line = lineAt(clean, d.at + s.index);
        for (const t of tablesInQuery(q))
          yield loose(repo, comp, "db-access", `${t.access} ${t.table}`, path, line);
      }
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

async function* dbt(repo: RepoHandle, ctx: ScanContext): AsyncGenerator<CatalogRecord> {
  for (const projectFile of await sources(repo, DBT)) {
    const text = await read(repo, ctx, projectFile);
    if (text === undefined) continue;
    const name = /^name\s*:\s*["']?([\w-]+)/m.exec(text)?.[1] ?? "dbt";
    const profile = /^profile\s*:\s*["']?([\w-]+)/m.exec(text)?.[1] ?? name;
    const root = projectFile.includes("/")
      ? projectFile.slice(0, projectFile.lastIndexOf("/") + 1)
      : "";
    const comp = own(repo, ctx);
    const store = `${slug(profile)}-warehouse`;
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
    yield {
      schemaVersion: 2,
      kind: "DataStore",
      id: store,
      status: "current",
      confidence: "verified",
      storeType: "warehouse",
      entitiesHeld: [],
      evidence: [
        ev(repo, "config", projectFile, lineAt(text, Math.max(0, text.search(/^profile\s*:/m)))),
      ],
    } as unknown as CatalogRecord;
    const tables = new Map<string, Record<string, unknown> & { evidence: unknown[] }>();
    const table = (
      n: string,
      kind: "table" | "view",
      role: "writer" | "reader",
      path: string,
      line: number,
    ) => {
      const id = `${store}.${slug(n)}`;
      const t =
        tables.get(id) ??
        ({
          schemaVersion: 2,
          kind: "Table",
          id,
          status: "current",
          confidence: "verified",
          dataStore: store,
          name: n,
          tableKind: kind,
          readers: [],
          writers: [],
          evidence: [],
        } as Record<string, unknown> & { evidence: unknown[] });
      if (role === "writer") {
        t.ownerComponent = comp;
        t.tableKind = kind;
        t.writers = [comp];
      } else if (!(t.readers as string[]).includes(comp)) t.readers = [comp];
      t.evidence.push(ev(repo, "code", path, line));
      tables.set(id, t);
    };
    for (const path of await sources(repo, SQL)) {
      if (!path.startsWith(`${root}models/`)) continue;
      const sql = await read(repo, ctx, path);
      if (sql === undefined) continue;
      const model = path
        .split("/")
        .pop()!
        .replace(/\.sql$/, "");
      const mat = /config\s*\([^)]*materialized\s*=\s*["'](\w+)["']/.exec(sql)?.[1];
      table(model, mat === "table" || mat === "incremental" ? "table" : "view", "writer", path, 1);
      for (const m of sql.matchAll(
        /\{\{\s*source\s*\(\s*["'](\w+)["']\s*,\s*["'](\w+)["']\s*\)\s*\}\}/g,
      ))
        table(m[2]!, "table", "reader", path, lineAt(sql, m.index));
    }
    for (const t of tables.values()) yield t as unknown as CatalogRecord;
  }
}

async function* spark(repo: RepoHandle, ctx: ScanContext): AsyncGenerator<CatalogRecord> {
  const set = await loadManifests(repo, ctx, /SparkApplication/, MANIFESTS);
  for (const o of set.objects) {
    if (o.kind !== "SparkApplication" && o.kind !== "ScheduledSparkApplication") continue;
    const comp = componentFor(ctx, [o.labels.app, o.name]);
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
