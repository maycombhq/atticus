import type { CatalogRecord } from "@maycombhq/core";
import { defineExtractor, type RepoHandle, type ScanContext } from "@maycombhq/sdk";
import {
  axiosInstances,
  frontendCall,
  frontendExprCall,
  instanceCall,
  mockHandler,
  serverPackages,
  SourceFile,
} from "./backends/shared.js";
import { componentOf, evidence, looseEnd, repoConfig, splitUrl } from "./facts.js";
import { LIQUIBASE_CLAIMS, liquibaseChangeSets } from "./data/liquibase.js";
import { moduleType, moduleUses } from "./module-uses.js";
import { wrapperRequests } from "./backends/js-wrappers.js";
import { flattenYaml, yamlKeyLine } from "./lang/config.js";
import {
  parseDdl,
  type SqlAlter,
  type SqlColumn,
  type SqlDdl,
  type SqlDrop,
  type SqlTable,
} from "./lang/sql.js";

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
  version: "1.3.0",
  // A module's own build file counts too (W1): a repo whose parts are all in folders (api/,
  // web/) has no build file at its root, and its modules' components were never written.
  claims: [...BUILD_FILES, ...SOURCES, ...BUILD_FILES.map((b) => `**/${b}`)],
  async *scan(repo, ctx) {
    if (ctx.repoType && NOT_COMPONENTS.has(ctx.repoType)) return;
    let marker: string | undefined;
    for await (const p of repo.listFiles(BUILD_FILES)) {
      marker = p;
      break;
    }
    // No build file at the root: a module's shows the repo builds something.
    if (!marker && ctx.modules?.length) {
      const own = ctx.modules.flatMap((m) =>
        BUILD_FILES.map((g) => `${m.path}/${g.replace(/^\*\*\//, "")}`),
      );
      for await (const p of repo.listFiles(own)) {
        marker = p;
        break;
      }
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
    // What each module builds on, among the repo's own modules (ADR 0068).
    const uses = (ctx.modules ?? []).length
      ? await moduleUses(repo, [{ path: "", component: id }, ...(ctx.modules ?? [])])
      : new Map<string, string[]>();
    const usesOf = (c: string) => (uses.get(c) ? { uses: uses.get(c) } : {});
    yield {
      schemaVersion: 1,
      kind: "Component",
      id,
      ...usesOf(id),
      status: "current",
      confidence: "verified",
      system: ctx.system ?? id,
      repo: repo.name,
      type: ctx.repoType ?? "unknown",
      evidence: [evidence(repo, { source: "config", path: marker })],
    } as unknown as CatalogRecord;
    // Each module that builds its own component (ADR 0057), evidenced by its build file.
    for (const m of ctx.modules ?? []) {
      if (m.component === id) continue;
      let at: string | undefined;
      for await (const p of repo.listFiles(
        BUILD_FILES.map((g) => `${m.path}/${g.replace(/^\*\*\//, "")}`),
      )) {
        at = p;
        break;
      }
      yield {
        schemaVersion: 1,
        kind: "Component",
        id: m.component,
        ...usesOf(m.component),
        status: "current",
        confidence: "verified",
        system: ctx.system ?? id,
        repo: repo.name,
        type: (await moduleType(repo, m.path)) ?? ctx.repoType ?? "unknown",
        evidence: [evidence(repo, { source: "config", path: at ?? marker })],
      } as unknown as CatalogRecord;
    }
  },
});

// ------------------------------------------------------------------ frontend calls

/**
 * Browser and Node clients: fetch, axios and HttpClient calls with a literal or template
 * URL. Template expressions become path parameters: `/api/balance/${id}` → /api/balance/{id}.
 * A URL built from a configured base keeps the base's expression (ADR 0076),
 * `GET ${environment.API}owners/{id}`, for the repo's scan settings to resolve, and requests
 * through an axios instance the repo makes (`api.get("/x")` with `api = axios.create({ baseURL
 * })`) are read with the instance's base. Mock handlers (msw's `http.get`) aren't calls. In a
 * Node server package the built and instance calls are the node reader's, which knows its
 * environment.
 */
export const frontendExtractor = defineExtractor({
  id: "frontend",
  version: "1.2.0",
  claims: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", "**/*.mjs", "**/*.vue"],
  async *scan(repo, ctx) {
    const servers = (await serverPackages(repo)).map((p) => p.slice(0, -"package.json".length));
    const inServer = (path: string) => servers.some((r) => path.startsWith(r));
    const all: string[] = [];
    const read: string[] = [];
    for await (const path of repo.listFiles(this.claims)) {
      all.push(path);
      if (
        !/(^|\/)(node_modules|dist|build|coverage|__tests__)\//.test(path) &&
        !/\.(test|spec|d)\.[jt]sx?$/.test(path)
      )
        read.push(path);
    }
    const parse = async (path: string, text: string) =>
      SourceFile.parse(path, path.endsWith(".vue") ? vueScript(text) : text, "js", repo.parseCache);
    // Axios instances the repo makes, by file (ADR 0076): their requests are read where the
    // instance is imported, with its base.
    const instancesIn = new Map<string, Map<string, string | undefined>>();
    for (const path of read) {
      if (inServer(path)) continue;
      const text = await repo.readText(path);
      if (!/\.create\s*\(/.test(text) || !text.includes("axios")) continue;
      const found = axiosInstances(await parse(path, text));
      if (found.length) instancesIn.set(path, new Map(found.map((x) => [x.name, x.base])));
    }
    const names = new Set([...instancesIn.values()].flatMap((m) => [...m.keys()]));
    for (const path of read) {
      const text = await repo.readText(path);
      // Only a file naming one of the clients can hold such a call: skip the rest unparsed.
      if (![...["fetch", "axios", "http"], ...names].some((w) => text.includes(w))) continue;
      const src = await parse(path, text);
      const server = inServer(path);
      const instances = server ? new Map() : instancesFor(path, src, instancesIn);
      for (const c of src.calls) {
        if (mockHandler(src, c)) continue;
        const call =
          frontendCall(src, c) ??
          (server ? undefined : (frontendExprCall(src, c) ?? instanceCall(src, c, instances)));
        if (!call) continue;
        yield looseEnd(repo, ctx, "http-call", `${call.method} ${call.url}`, {
          source: "code",
          path,
          line: c.line,
          side: "caller",
        });
      }
    }
    // Requests through the repo's own HTTP helpers (ADR 0069).
    for (const r of await wrapperRequests(repo, all, (p, t) =>
      p.endsWith(".vue") ? vueScript(t) : t,
    ))
      yield looseEnd(repo, ctx, "http-call", `${r.method} ${r.url}`, {
        source: "code",
        path: r.path,
        line: r.line,
        side: "caller",
      });
  },
});

/**
 * The axios instances a file can use, by local name: its own, and those it imports from the
 * file that makes them. A relative import is resolved; an alias (`@/lib/api-client`) names the
 * instance file whose path ends with what follows the alias, nearest the importing file.
 */
function instancesFor(
  path: string,
  src: SourceFile,
  instancesIn: ReadonlyMap<string, ReadonlyMap<string, string | undefined>>,
): Map<string, string | undefined> {
  const out = new Map(instancesIn.get(path) ?? []);
  if (instancesIn.size === 0) return out;
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const strip = (p: string) => p.replace(/\.(m?[jt]sx?|vue)$/, "").replace(/\/index$/, "");
  const shared = (a: string, b: string) => {
    let n = 0;
    const x = a.split("/");
    const y = b.split("/");
    while (n < x.length && n < y.length && x[n] === y[n]) n++;
    return n;
  };
  for (const imp of src.imports) {
    let candidates: string[];
    if (imp.spec.startsWith(".")) {
      const parts: string[] = dir ? dir.split("/") : [];
      for (const seg of imp.spec.split("/")) {
        if (seg === "..") parts.pop();
        else if (seg !== ".") parts.push(seg);
      }
      const target = strip(parts.join("/"));
      candidates = [...instancesIn.keys()].filter((f) => strip(f) === target);
    } else {
      const tail = imp.spec.replace(/^[@~#]\//, "").replace(/^src\//, "");
      if (!tail.includes("/")) continue;
      candidates = [...instancesIn.keys()]
        .filter((f) => strip(f) === tail || strip(f).endsWith(`/${tail}`))
        .sort((a, b) => shared(b, path) - shared(a, path));
    }
    const file = candidates[0];
    if (!file) continue;
    for (const n of imp.names) {
      const inst = instancesIn.get(file)!;
      if (inst.has(n.name)) out.set(n.local, inst.get(n.name));
    }
  }
  return out;
}

/**
 * A Vue single-file component with everything outside its `<script>` blocks blanked (line
 * breaks kept), so the script parses as TypeScript and lines still match the file.
 */
function vueScript(text: string): string {
  let out = "";
  let at = 0;
  for (;;) {
    const open = text.indexOf("<script", at);
    const body = open < 0 ? -1 : text.indexOf(">", open);
    const close = body < 0 ? -1 : text.indexOf("</script>", body);
    const blank = (s: string) => s.replace(/[^\n]/g, " ");
    if (close < 0) return out + blank(text.slice(at));
    out += blank(text.slice(at, body + 1)) + text.slice(body + 1, close);
    at = close;
  }
}

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
      const flat = flattenYaml(text, path, repo.parseCache);
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
 * database design they leave (Table, Column, IndexConstraint) after replaying every file in
 * version order, ALTER TABLE included. The owning component reads and writes its own
 * tables. The data store is the datasource host, else <system>-db.
 */
/** Flyway's files: under db/migration (any depth), migrations/ or flyway/. */
const FLYWAY_CLAIMS = ["**/db/migration/**/*.sql", "**/migrations/*.sql", "**/flyway/*.sql"];

export const migrationsExtractor = defineExtractor({
  id: "migrations",
  version: "1.4.0",
  claims: [...FLYWAY_CLAIMS, ...LIQUIBASE_CLAIMS],
  async *scan(repo, ctx) {
    const owner = componentOf(repo, ctx);
    const store = await storeFor(repo, ctx);
    const files: { path: string; version: string }[] = [];
    for await (const path of repo.listFiles(FLYWAY_CLAIMS)) {
      // golang-migrate pairs each <version>_<name>.up.sql with a .down.sql that undoes it.
      if (/(?:^|\/)\d+_[^/]+\.down\.sql$/i.test(path)) continue;
      const v = /(?:^|\/)V(\d+(?:[._]\d+)*)__[^/]+\.sql$/i.exec(path);
      const go = /(?:^|\/)(\d+)_[^/]+\.up\.sql$/i.exec(path);
      files.push({
        path,
        version: v
          ? v[1]!.replace(/_/g, ".")
          : go
            ? go[1]!
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
    const state = new DesignState();
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
      state.apply(ddl, ev);
    }
    // Liquibase change sets, after any Flyway migrations, in the order Liquibase applies them.
    for (const cs of await liquibaseChangeSets(repo)) {
      const ddl = parseDdl(cs.sql);
      const ev = (line?: number) =>
        evidence(repo, { source: "migration", path: cs.file, line: line ?? cs.line });
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
      const stem = (cs.file.split("/").pop() ?? cs.file).replace(/\.[^.]+$/, "");
      yield {
        schemaVersion: 1,
        kind: "Migration",
        id: `${store}.lb.${slug(stem)}.${slug(cs.id)}`,
        status: "current",
        confidence: "verified",
        dataStore: store,
        version: cs.id,
        tool: "liquibase",
        file: cs.file,
        operations: ddl.operations,
        evidence: [ev()],
      } as unknown as CatalogRecord;
      // Lines inside a change set are the change set's line: the DDL was made from it.
      state.apply(ddl, () => ev());
    }
    // The design is the latest state after every migration, replayed in version order.
    for (const t of state.tables.values()) {
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
        evidence: [t.ev],
      } as unknown as CatalogRecord;
      for (const c of t.columns.values()) {
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
          ...allowedOf(c, state),
          evidence: c.ev,
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
          evidence: [t.primaryKey.ev],
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
          evidence: [fk.ev],
        } as unknown as CatalogRecord;
      }
    }
    for (const ix of state.indexes.values()) {
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
        evidence: [ix.ev],
      } as unknown as CatalogRecord;
    }
  },
});

type Ev = ReturnType<typeof evidence>;
type StateColumn = Omit<SqlColumn, "line" | "primaryKey" | "references" | "allowed"> & {
  ev: Ev[];
  /** The values it allows, the line that says so, and the constraint's name when it has one. */
  allowed?: { values: string[]; ev: Ev; constraint?: string };
};
interface StateTable {
  name: string;
  ev: Ev;
  columns: Map<string, StateColumn>;
  primaryKey: { columns: string[]; ev: Ev } | undefined;
  foreignKeys: { name?: string; columns: string[]; table: string; refColumns: string[]; ev: Ev }[];
}

/**
 * The database design as migrations leave it. Each file's statements are replayed in file
 * order over what earlier files built: CREATE TABLE replaces a table, ALTER TABLE adds,
 * drops, changes and renames columns, DROP TABLE and DROP INDEX remove. A dropped column is
 * gone from the latest state (code doesn't plan a retirement; it has already happened), and
 * so are the keys and indexes that depended on it, as databases drop them too.
 */
class DesignState {
  readonly tables = new Map<string, StateTable>();
  readonly indexes = new Map<
    string,
    { name: string; table: string; columns: string[]; unique: boolean; ev: Ev }
  >();
  /** CREATE TYPE ... AS ENUM, by type name: what a column of that type allows. */
  readonly enums = new Map<string, { values: string[]; ev: Ev }>();

  apply(ddl: SqlDdl, ev: (line?: number) => Ev): void {
    type Step = { line: number; run: () => void };
    const steps: Step[] = [
      ...ddl.tables.map((t) => ({ line: t.line, run: () => this.create(t, ev) })),
      ...ddl.indexes.map((ix) => ({
        line: ix.line,
        run: () => this.indexes.set(ix.name, { ...ix, ev: ev(ix.line) }),
      })),
      ...ddl.alters.map((a) => ({ line: a.line, run: () => this.alter(a, ev(a.line)) })),
      ...ddl.drops.map((d) => ({ line: d.line, run: () => this.drop(d) })),
      ...ddl.enums.map((x) => ({
        line: x.line,
        run: () => this.enums.set(x.name, { values: x.values, ev: ev(x.line) }),
      })),
      ...ddl.checks.map((c) => ({ line: c.line, run: () => this.check(c.table, c, ev(c.line)) })),
      ...ddl.droppedConstraints.map((d) => ({
        line: d.line,
        run: () => this.dropConstraint(d.table, d.name),
      })),
    ];
    // Stable sort: actions on one line keep the order they were read in.
    for (const s of steps.sort((a, b) => a.line - b.line)) s.run();
  }

  private create(t: SqlTable, ev: (line?: number) => Ev): void {
    this.tables.set(t.name, {
      name: t.name,
      ev: ev(t.line),
      columns: new Map(t.columns.map((c) => [c.name, column(c, ev(c.line), ev)])),
      primaryKey: t.primaryKey && { columns: t.primaryKey.columns, ev: ev(t.primaryKey.line) },
      foreignKeys: t.foreignKeys.map(({ line, ...fk }) => ({ ...fk, ev: ev(line) })),
    });
    for (const c of t.checks) this.check(t.name, c, ev(c.line));
  }

  /** A CHECK (column IN (...)) constraint: the column allows those values, by that line. */
  private check(
    table: string,
    c: { name?: string; column: string; values: string[] },
    ev: Ev,
  ): void {
    const col = this.tables.get(table)?.columns.get(c.column);
    if (col) col.allowed = { values: c.values, ev, ...(c.name ? { constraint: c.name } : {}) };
  }

  /** DROP CONSTRAINT: a check it named no longer limits its column. */
  private dropConstraint(table: string, name: string): void {
    for (const col of this.tables.get(table)?.columns.values() ?? [])
      if (col.allowed?.constraint === name) delete col.allowed;
  }

  private alter(a: SqlAlter, ev: Ev): void {
    let t = this.tables.get(a.table);
    if (!t) {
      // A table the migrations never created (made before them): its altered columns still
      // belong to it, so it exists in the design from the first change seen.
      if (a.op !== "add-column") return;
      t = { name: a.table, ev, columns: new Map(), primaryKey: undefined, foreignKeys: [] };
      this.tables.set(a.table, t);
    }
    const existing = t.columns.get(a.column);
    if (a.op === "add-column" && a.definition) {
      t.columns.set(
        a.column,
        column(a.definition, ev, () => ev),
      );
      if (a.definition.primaryKey && !t.primaryKey) t.primaryKey = { columns: [a.column], ev };
      if (a.definition.references)
        t.foreignKeys.push({
          columns: [a.column],
          table: a.definition.references.table,
          refColumns: a.definition.references.columns,
          ev,
        });
    } else if (a.op === "drop-column") {
      t.columns.delete(a.column);
      const uses = (cs: string[]) => cs.includes(a.column);
      if (t.primaryKey && uses(t.primaryKey.columns)) t.primaryKey = undefined;
      t.foreignKeys = t.foreignKeys.filter((fk) => !uses(fk.columns));
      for (const [k, ix] of this.indexes)
        if (ix.table === t.name && uses(ix.columns)) this.indexes.delete(k);
    } else if (a.op === "rename-column" && existing && a.to) {
      const to = a.to;
      t.columns.delete(a.column);
      t.columns.set(to, { ...existing, name: to, ev: [...existing.ev, ev] });
      const swap = (cs: string[]) => cs.map((c) => (c === a.column ? to : c));
      if (t.primaryKey) t.primaryKey.columns = swap(t.primaryKey.columns);
      for (const fk of t.foreignKeys) fk.columns = swap(fk.columns);
      for (const ix of this.indexes.values())
        if (ix.table === t.name) ix.columns = swap(ix.columns);
    } else if (a.op === "alter-column" && existing) {
      const next: StateColumn = { ...existing, ev: [...existing.ev, ev] };
      if (a.definition) {
        next.type = a.definition.type;
        next.nullable = a.definition.nullable;
        // A full redefinition says again what its own definition allows, or that nothing does.
        if (a.definition.allowed) next.allowed = { values: a.definition.allowed.values, ev };
        else if (next.allowed && !next.allowed.constraint) delete next.allowed;
        if (a.definition.default !== undefined) next.default = a.definition.default;
      }
      if (a.type !== undefined) next.type = a.type;
      if (a.nullable !== undefined) next.nullable = a.nullable;
      if (a.default !== undefined) next.default = a.default;
      if (a.dropDefault) delete next.default;
      t.columns.set(a.column, next);
    }
  }

  private drop(d: SqlDrop): void {
    if (d.kind === "index") {
      this.indexes.delete(d.name);
      return;
    }
    this.tables.delete(d.name);
    for (const [k, ix] of this.indexes) if (ix.table === d.name) this.indexes.delete(k);
  }
}

function column(c: SqlColumn, ev: Ev, at: (line?: number) => Ev): StateColumn {
  return {
    name: c.name,
    type: c.type,
    nullable: c.nullable,
    ...(c.default !== undefined ? { default: c.default } : {}),
    ...(c.allowed ? { allowed: { values: c.allowed.values, ev: at(c.allowed.line) } } : {}),
    ev: [ev],
  };
}

/**
 * A column's allowed values as its Column record carries them (C1, optional): its own check or
 * ENUM type, else the CREATE TYPE ... AS ENUM its type names, cited to the line that says so.
 */
function allowedOf(
  c: StateColumn,
  state: DesignState,
): { allowedValues?: { values: string[]; evidence: Ev } } {
  const a = c.allowed ?? state.enums.get(c.type);
  return a ? { allowedValues: { values: a.values, evidence: a.ev } } : {};
}

// ------------------------------------------------------------------ infrastructure as code

/**
 * Kubernetes Deployments (component, environment from namespace, replicas, limits) and alert
 * definitions kept as YAML. Terraform databases are read by the shipped terraform-aws,
 * terraform-azure and terraform-gcp dialects (ADR 0063).
 */
export const infraExtractor = defineExtractor({
  id: "infra",
  version: "1.1.0",
  claims: [
    "**/k8s/**/*.yaml",
    "**/k8s/**/*.yml",
    "**/kubernetes/**/*.yaml",
    "**/manifests/**/*.yaml",
    "**/alerts/*.yaml",
    "**/alerts/*.yml",
  ],
  async *scan(repo) {
    for await (const path of repo.listFiles(this.claims)) {
      const text = await repo.readText(path);
      const flat = flattenYaml(text, path, repo.parseCache);
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
