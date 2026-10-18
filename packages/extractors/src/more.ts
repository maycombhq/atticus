import type { CatalogRecord } from "@maycombhq/core";
import { defineExtractor, type RepoHandle, type ScanContext } from "@maycombhq/sdk";
import { componentOf, evidence, looseEnd, repoConfig, splitUrl } from "./facts.js";
import { flattenYaml, yamlKeyLine } from "./lang/config.js";
import { parseDdl } from "./lang/sql.js";

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "");

// ------------------------------------------------------------------ component

const BUILD_FILES = [
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "package.json",
  "go.mod",
  "pyproject.toml",
  "requirements.txt",
  "*.csproj",
  "forge.yaml",
];
const NOT_COMPONENTS = new Set(["gateway", "event-config", "infra", "library", "docs"]);

/** One Component per repo that builds something, named by the manifest. Gateways, topic configs and infrastructure repos are not components. */
const SOURCES = [
  "src/**/*.java",
  "src/**/*.kt",
  "src/**/*.ts",
  "src/**/*.js",
  "src/**/*.py",
  "src/**/*.go",
  "src/**/*.cs",
];

export const componentExtractor = defineExtractor({
  id: "component",
  version: "1.0.0",
  claims: [...BUILD_FILES, ...SOURCES],
  async *scan(repo, ctx) {
    if (ctx.repoType && NOT_COMPONENTS.has(ctx.repoType)) return;
    let marker: string | undefined;
    for await (const p of repo.listFiles(BUILD_FILES)) {
      marker = p;
      break;
    }
    // No build file: the first source file shows there's code here.
    if (!marker) {
      for await (const p of repo.listFiles(SOURCES)) {
        marker = p;
        break;
      }
    }
    if (!marker) return;
    const id = componentOf(repo, ctx);
    yield {
      schemaVersion: 1,
      kind: "Component",
      id,
      status: "current",
      confidence: "verified",
      system: ctx.system ?? id,
      repo: repo.name,
      type: ctx.repoType ?? "unknown",
      evidence: [evidence(repo, { source: "config", path: marker })],
    } as unknown as CatalogRecord;
  },
});

// ------------------------------------------------------------------ frontend calls

/**
 * Browser and Node clients: fetch, axios and HttpClient calls with a literal or template
 * URL. Template expressions become path parameters: `/api/balance/${id}` → /api/balance/{id}.
 */
export const frontendExtractor = defineExtractor({
  id: "frontend",
  version: "1.0.0",
  claims: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", "**/*.mjs", "**/*.vue"],
  async *scan(repo, ctx) {
    for await (const path of repo.listFiles(this.claims)) {
      if (
        /(^|\/)(node_modules|dist|build|coverage|__tests__)\//.test(path) ||
        /\.(test|spec|d)\.[jt]sx?$/.test(path)
      )
        continue;
      const src = await repo.readText(path);
      if (!/\bfetch\s*\(|axios|\.get\s*\(|\.post\s*\(|HttpClient/.test(src)) continue;
      const lines = src.split("\n");
      const re =
        /\b(fetch|axios(?:\.(get|post|put|delete|patch))?|(?:this\.)?http\.(get|post|put|delete|patch))\s*\(\s*(`([^`]*)`|'([^']*)'|"([^"]*)")/g;
      for (const m of src.matchAll(re)) {
        const raw = m[5] ?? m[6] ?? m[7] ?? "";
        const url = raw.replace(
          /\$\{\s*([^}]+?)\s*\}/g,
          (_w, expr: string) => `{${expr.split(".").pop()!.replace(/\W/g, "")}}`,
        );
        if (!/^(\/|https?:)/.test(url)) continue;
        const line = src.slice(0, m.index).split("\n").length;
        let method = (m[2] ?? m[3] ?? "").toUpperCase();
        if (!method) {
          const tail = lines.slice(line - 1, line + 2).join(" ");
          method = /method\s*:\s*["'`](\w+)["'`]/i.exec(tail)?.[1]?.toUpperCase() ?? "GET";
        }
        yield looseEnd(repo, ctx, "http-call", `${method} ${url}`, {
          source: "code",
          path,
          line,
          side: "caller",
        });
      }
    }
  },
});

// ------------------------------------------------------------------ topic configs

/**
 * Topic descriptors kept as YAML (`topic:` with optional producers and consumers): an
 * event-topic Endpoint per topic (side definition) and publish/subscribe loose ends for
 * the named producers and consumers.
 */
export const topicsExtractor = defineExtractor({
  id: "topics",
  version: "1.0.0",
  claims: ["**/topics/*.yaml", "**/topics/*.yml", "**/topics/**/*.yaml"],
  async *scan(repo) {
    for await (const path of repo.listFiles(this.claims)) {
      const text = await repo.readText(path);
      const flat = flattenYaml(text, path);
      const topic = flat.get("topic") ?? flat.get("name");
      if (!topic) continue;
      const list = (k: string) =>
        [...flat.entries()].filter(([key]) => key.startsWith(`${k}[`)).map(([, v]) => v.value);
      const producers = list("producers");
      const consumers = list("consumers");
      yield {
        schemaVersion: 1,
        kind: "Endpoint",
        id: `topic.${topic.value
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")}`,
        status: "current",
        confidence: "verified",
        component: producers[0] ?? "unknown",
        endpointType: "event-topic",
        pathOrTopic: topic.value,
        schemaRefs: [],
        evidence: [
          evidence(repo, { source: "event-config", path, line: topic.line, side: "definition" }),
        ],
      } as unknown as CatalogRecord;
      const ctxFor = (c: string): ScanContext => ({
        dialects: [],
        component: c,
        scannedAt: "",
        warn: () => undefined,
      });
      for (const p of producers)
        yield looseEnd(repo, ctxFor(p), "event-publish", topic.value, {
          source: "event-config",
          path,
          line: yamlKeyLine(text, "producers") ?? topic.line,
          side: "definition",
        });
      for (const c of consumers)
        yield looseEnd(repo, ctxFor(c), "event-subscribe", topic.value, {
          source: "event-config",
          path,
          line: yamlKeyLine(text, "consumers") ?? topic.line,
          side: "definition",
        });
    }
  },
});

// ------------------------------------------------------------------ SQL migrations

async function storeFor(repo: RepoHandle, ctx: ScanContext): Promise<string> {
  const config = await repoConfig(repo);
  const ds = config.get("spring.datasource.url")?.value;
  const host = ds
    ? splitUrl(ds.replace(/^jdbc:/, ""))
        .host?.split(":")[0]
        ?.split(".")[0]
    : undefined;
  return host ?? `${ctx.system ?? componentOf(repo, ctx)}-db`;
}

/**
 * Flyway (V<version>__<name>.sql) and plain SQL migrations: a Migration per file, and the
 * database design they build (Table, Column, IndexConstraint). The owning component reads
 * and writes its own tables. The data store is the datasource host, else <system>-db.
 */
export const migrationsExtractor = defineExtractor({
  id: "migrations",
  version: "1.0.0",
  claims: ["**/db/migration/*.sql", "**/migrations/*.sql", "**/flyway/*.sql"],
  async *scan(repo, ctx) {
    const owner = componentOf(repo, ctx);
    const store = await storeFor(repo, ctx);
    const files: { path: string; version: string }[] = [];
    for await (const path of repo.listFiles(this.claims)) {
      const v = /(?:^|\/)V(\d+(?:[._]\d+)*)__[^/]+\.sql$/i.exec(path);
      files.push({
        path,
        version: v
          ? v[1]!.replace(/_/g, ".")
          : (path.split("/").pop() ?? path).replace(/\.sql$/i, ""),
      });
    }
    const num = (v: string) => v.split(".").map((x) => Number(x) || 0);
    files.sort((a, b) => {
      const x = num(a.version);
      const y = num(b.version);
      for (let i = 0; i < Math.max(x.length, y.length); i++)
        if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
      return a.path.localeCompare(b.path);
    });
    let first = true;
    for (const f of files) {
      const ddl = parseDdl(await repo.readText(f.path));
      const ev = (line?: number) =>
        evidence(repo, { source: "migration", path: f.path, ...(line ? { line } : {}) });
      if (first) {
        first = false;
        yield {
          schemaVersion: 1,
          kind: "DataStore",
          id: store,
          status: "current",
          confidence: "verified",
          storeType: "unknown",
          ownerComponent: owner,
          entitiesHeld: [],
          evidence: [ev(1)],
        } as unknown as CatalogRecord;
      }
      yield {
        schemaVersion: 1,
        kind: "Migration",
        id: `${store}.v${slug(f.version)}`,
        status: "current",
        confidence: "verified",
        dataStore: store,
        version: f.version,
        tool: /\/V\d/.test(f.path) || /V\d+__/.test(f.path) ? "flyway" : "other",
        file: f.path,
        operations: ddl.operations,
        evidence: [ev(1)],
      } as unknown as CatalogRecord;
      for (const t of ddl.tables) {
        const tid = `${store}.${slug(t.name)}`;
        yield {
          schemaVersion: 1,
          kind: "Table",
          id: tid,
          status: "current",
          confidence: "verified",
          dataStore: store,
          name: t.name,
          tableKind: "table",
          ownerComponent: owner,
          readers: [owner],
          writers: [owner],
          evidence: [ev(t.line)],
        } as unknown as CatalogRecord;
        for (const c of t.columns) {
          yield {
            schemaVersion: 1,
            kind: "Column",
            id: `${tid}.${slug(c.name)}`,
            status: "current",
            confidence: "verified",
            table: tid,
            name: c.name,
            type: c.type,
            nullable: c.nullable,
            ...(c.default !== undefined ? { default: c.default } : {}),
            evidence: [ev(c.line)],
          } as unknown as CatalogRecord;
        }
        if (t.primaryKey) {
          yield {
            schemaVersion: 1,
            kind: "IndexConstraint",
            id: `${tid}.pk`,
            status: "current",
            confidence: "verified",
            table: tid,
            constraintKind: "primary-key",
            columns: t.primaryKey.columns,
            evidence: [ev(t.primaryKey.line)],
          } as unknown as CatalogRecord;
        }
        for (const fk of t.foreignKeys) {
          yield {
            schemaVersion: 1,
            kind: "IndexConstraint",
            id: `${tid}.${fk.name ? slug(fk.name) : `fk-${slug(fk.table)}`}`,
            status: "current",
            confidence: "verified",
            table: tid,
            constraintKind: "foreign-key",
            columns: fk.columns,
            references: { table: `${store}.${slug(fk.table)}`, columns: fk.refColumns },
            evidence: [ev(fk.line)],
          } as unknown as CatalogRecord;
        }
      }
      for (const ix of ddl.indexes) {
        const tid = `${store}.${slug(ix.table)}`;
        yield {
          schemaVersion: 1,
          kind: "IndexConstraint",
          id: `${tid}.${slug(ix.name)}`,
          status: "current",
          confidence: "verified",
          table: tid,
          constraintKind: ix.unique ? "unique" : "index",
          columns: ix.columns,
          evidence: [ev(ix.line)],
        } as unknown as CatalogRecord;
      }
    }
  },
});

// ------------------------------------------------------------------ infrastructure as code

/**
 * Kubernetes Deployments (component, environment from namespace, replicas, limits),
 * Terraform databases (google_sql_database_instance, aws_db_instance, azurerm_*_server)
 * and alert definitions kept as YAML.
 */
export const infraExtractor = defineExtractor({
  id: "infra",
  version: "1.0.0",
  claims: [
    "**/k8s/**/*.yaml",
    "**/k8s/**/*.yml",
    "**/kubernetes/**/*.yaml",
    "**/manifests/**/*.yaml",
    "**/*.tf",
    "**/alerts/*.yaml",
    "**/alerts/*.yml",
  ],
  async *scan(repo) {
    for await (const path of repo.listFiles(this.claims)) {
      const text = await repo.readText(path);
      if (path.endsWith(".tf")) {
        for (const m of text.matchAll(
          /resource\s+"(google_sql_database_instance|aws_db_instance|aws_rds_cluster|azurerm_postgresql_flexible_server|azurerm_mssql_server)"\s+"[^"]+"\s*\{([\s\S]*?)\n\}/g,
        )) {
          const body = m[2]!;
          const name = /\b(?:name|identifier|cluster_identifier)\s*=\s*"([^"]+)"/.exec(body)?.[1];
          if (!name) continue;
          const ver = /(?:database_version|engine)\s*=\s*"([^"]+)"/.exec(body)?.[1] ?? "";
          const storeType =
            /postgres/i.test(ver) || /postgres/.test(m[1]!)
              ? "postgresql"
              : /mysql/i.test(ver)
                ? "mysql"
                : /mssql|sqlserver/i.test(ver + m[1]!)
                  ? "sqlserver"
                  : "unknown";
          const line = text.slice(0, m.index).split("\n").length;
          yield {
            schemaVersion: 1,
            kind: "DataStore",
            id: slug(name),
            status: "current",
            confidence: "verified",
            storeType,
            entitiesHeld: [],
            evidence: [evidence(repo, { source: "infrastructure", path, line })],
          } as unknown as CatalogRecord;
        }
        continue;
      }
      const flat = flattenYaml(text, path);
      if (flat.get("kind")?.value === "Deployment") {
        const name = flat.get("metadata.name")?.value;
        if (!name) continue;
        const env = flat.get("metadata.namespace")?.value ?? "default";
        const replicas = flat.get("spec.replicas");
        const cpu = flat.get("spec.template.spec.containers[0].resources.limits.cpu")?.value;
        const memory = flat.get("spec.template.spec.containers[0].resources.limits.memory")?.value;
        yield {
          schemaVersion: 1,
          kind: "Deployment",
          id: `${slug(name)}.${slug(env)}`,
          status: "current",
          confidence: "verified",
          component: slug(name),
          env,
          platform: "kubernetes",
          ...(replicas ? { replicas: Number(replicas.value) } : {}),
          ...(cpu || memory
            ? { resources: { ...(cpu ? { cpu } : {}), ...(memory ? { memory } : {}) } }
            : {}),
          networkPolicies: [],
          evidence: [
            evidence(repo, {
              source: "infrastructure",
              path,
              ...(replicas ? { line: replicas.line } : {}),
            }),
          ],
        } as unknown as CatalogRecord;
        continue;
      }
      for (let i = 0; flat.has(`alerts[${i}].name`); i++) {
        const name = flat.get(`alerts[${i}].name`)!;
        const component = flat.get(`alerts[${i}].component`)?.value;
        if (!component) continue;
        const short = name.value.replace(
          new RegExp(`^${component.replace(/-/g, "[- ]")}\\s*`, "i"),
          "",
        );
        yield {
          schemaVersion: 1,
          kind: "ObservabilityAsset",
          id: `${slug(component)}.alert.${slug(short)}`,
          status: "current",
          confidence: "verified",
          component: slug(component),
          assetKind: "alert",
          name: name.value,
          evidence: [evidence(repo, { source: "infrastructure", path, line: name.line })],
        } as unknown as CatalogRecord;
      }
    }
  },
});
