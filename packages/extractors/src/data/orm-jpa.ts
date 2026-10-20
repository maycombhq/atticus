import type { RepoHandle } from "@maycombhq/sdk";
import { repoConfig } from "../facts.js";
import { parseJavaClasses, type AnnotationTree } from "../lang/java-tree.js";
import { isTestOrBuildPath } from "./common.js";
import type { OrmColumn, OrmForeignKey, OrmIndex, OrmModel, OrmTable } from "./orm-model.js";

/**
 * JPA / Hibernate entities in Java, read from the syntax tree (ADR 0060). The shared Java
 * reader only records annotated fields, but JPA maps every non-transient field, so this
 * module reads every field of a class (parseJavaClasses), with nested annotations such as
 * `@Table(indexes = @Index(...))`. An annotation in a comment or a string is never read.
 *
 * Naming: Spring Boot's default physical naming (CamelCaseToUnderscoresNamingStrategy) turns
 * ownerName into owner_name, for explicit names too; with PhysicalNamingStrategyStandardImpl
 * configured, names stay as written.
 *
 * Out of scope: @Embedded / @EmbeddedId, @ElementCollection, @JoinTable link tables, entity
 * inheritance (only @MappedSuperclass fields are inherited), orm.xml mappings and Kotlin.
 */

type AttrValue = string | string[];
type JAnn = AnnotationTree;

interface JField {
  name: string;
  type: string;
  line: number;
  annotations: JAnn[];
  modifiers: Set<string>;
}

interface JClass {
  name: string;
  line: number;
  superName?: string;
  annotations: JAnn[];
  fields: JField[];
  path: string;
}

const PRIMITIVES = new Set(["int", "long", "short", "byte", "boolean", "double", "float", "char"]);

/** Classes in a Java file with their annotations, superclass and fields. */
export async function readJavaClasses(src: string, path: string): Promise<JClass[]> {
  return (await parseJavaClasses(src)).map((c) => ({
    name: c.name,
    line: c.line,
    ...(c.superclass ? { superName: c.superclass } : {}),
    annotations: c.annotations,
    fields: c.fields.map((f) => ({ ...f, modifiers: new Set(f.modifiers) })),
    path,
  }));
}

const str = (v: AttrValue | undefined) => (Array.isArray(v) ? v[0] : v);
const list = (v: AttrValue | undefined) =>
  v === undefined ? [] : (Array.isArray(v) ? v : v.split(",")).map((s) => s.trim()).filter(Boolean);
const ann = (anns: JAnn[], ...names: string[]) => anns.find((a) => names.includes(a.name));

/** Spring's CamelCaseToUnderscoresNamingStrategy: dots to underscores, an underscore before an upper-case letter between lower-case ones, then lower case. */
export function springName(name: string): string {
  const s = name.replace(/\./g, "_");
  let out = s[0] ?? "";
  for (let i = 1; i < s.length; i++) {
    const before = s[i - 1]!;
    const cur = s[i]!;
    const after = s[i + 1] ?? "";
    if (/[a-z]/.test(before) && /[A-Z]/.test(cur) && /[a-z]/.test(after)) out += "_";
    out += cur;
  }
  return out.toLowerCase();
}

const DB_ENGINES: Record<string, string> = {
  postgresql: "postgresql",
  mysql: "mysql",
  mariadb: "mariadb",
  sqlserver: "sqlserver",
  oracle: "oracle",
  db2: "db2",
  h2: "h2",
  sqlite: "sqlite",
};

interface EntityInfo {
  cls: JClass;
  table: OrmTable;
  /** Field name → column, for key columns and join columns elsewhere. */
  idColumns: OrmColumn[];
  fields: JField[];
}

export async function readJpa(repo: RepoHandle): Promise<OrmModel> {
  const classes = new Map<string, JClass>();
  for await (const path of repo.listFiles(["**/*.java"])) {
    if (isTestOrBuildPath(path)) continue;
    const text = await repo.readText(path);
    if (!/@(Entity|MappedSuperclass)\b/.test(text)) continue;
    for (const c of await readJavaClasses(text, path))
      if (!classes.has(c.name)) classes.set(c.name, c);
  }
  const entities = [...classes.values()].filter((c) => ann(c.annotations, "Entity"));
  if (entities.length === 0) return { tables: [] };

  const config = await repoConfig(repo);
  const standard = /PhysicalNamingStrategyStandardImpl/.test(
    config.get("spring.jpa.hibernate.naming.physical-strategy")?.value ?? "",
  );
  const phys = (n: string) => (standard ? n : springName(n));
  const engine = /^jdbc:([a-z0-9]+):/.exec(config.get("spring.datasource.url")?.value ?? "")?.[1];

  // Fields of the class and its @MappedSuperclass ancestors, ancestors first.
  const allFields = (c: JClass, seen = new Set<string>()): JField[] => {
    const sup = c.superName ? classes.get(c.superName) : undefined;
    const inherited =
      sup && !seen.has(sup.name) && ann(sup.annotations, "MappedSuperclass")
        ? allFields(sup, new Set([...seen, c.name]))
        : [];
    return [...inherited, ...c.fields];
  };
  const pathOf = (f: JField, c: JClass): string => {
    if (c.fields.includes(f)) return c.path;
    const sup = c.superName ? classes.get(c.superName) : undefined;
    return sup ? pathOf(f, sup) : c.path;
  };
  const skipped = (f: JField) =>
    f.modifiers.has("static") ||
    f.modifiers.has("transient") ||
    ann(
      f.annotations,
      "Transient",
      "OneToMany",
      "ManyToMany",
      "Embedded",
      "EmbeddedId",
      "ElementCollection",
    ) !== undefined;
  const relation = (f: JField) => ann(f.annotations, "ManyToOne", "OneToOne");

  // Pass 1: tables and their plain columns.
  const info = new Map<string, EntityInfo>();
  for (const c of entities) {
    const entityAnn = ann(c.annotations, "Entity")!;
    const tableAnn = ann(c.annotations, "Table");
    const name = phys(str(tableAnn?.attrs.name) ?? str(entityAnn.attrs.name) ?? c.name);
    const table: OrmTable = {
      name,
      tableKind: "table",
      path: c.path,
      line: entityAnn.line,
      columns: [],
      foreignKeys: [],
      indexes: [],
    };
    const fields = allFields(c).filter((f) => !skipped(f));
    const idColumns: OrmColumn[] = [];
    let pkAt: { path: string; line: number } | undefined;
    for (const f of fields) {
      if (relation(f)) continue;
      const col = ann(f.annotations, "Column");
      const id = ann(f.annotations, "Id");
      const nullable =
        str(col?.attrs.nullable) === "false" ||
        id !== undefined ||
        PRIMITIVES.has(f.type) ||
        ann(f.annotations, "NotNull", "NonNull") !== undefined
          ? false
          : str(col?.attrs.nullable) === "true"
            ? true
            : undefined;
      const column: OrmColumn = {
        name: phys(str(col?.attrs.name) ?? f.name),
        type: str(col?.attrs.columnDefinition) ?? f.type.replace(/<.*>$/, ""),
        ...(nullable !== undefined ? { nullable } : {}),
        path: pathOf(f, c),
        line: f.line,
      };
      table.columns.push(column);
      if (id) {
        idColumns.push(column);
        pkAt ??= { path: pathOf(f, c), line: id.line };
      }
    }
    if (pkAt) table.primaryKey = { ...pkAt, columns: idColumns.map((x) => x.name) };
    for (const nested of tableAnn?.nested ?? []) {
      const ixName = str(nested.attrs.name);
      if (!ixName) continue; // Hibernate makes up a name: no stable id to give it.
      if (nested.name === "Index")
        table.indexes.push({
          name: ixName,
          columns: list(nested.attrs.columnList).map(phys),
          unique: str(nested.attrs.unique) === "true",
          path: c.path,
          line: nested.line,
        } satisfies OrmIndex);
      else if (nested.name === "UniqueConstraint")
        table.indexes.push({
          name: ixName,
          columns: list(nested.attrs.columnNames).map(phys),
          unique: true,
          path: c.path,
          line: nested.line,
        });
    }
    info.set(c.name, { cls: c, table, idColumns, fields });
  }

  // Pass 2: owning-side relationships become a join column and a foreign key.
  for (const e of info.values()) {
    for (const f of e.fields) {
      const rel = relation(f);
      if (!rel || rel.attrs.mappedBy !== undefined) continue;
      const target = info.get(f.type.replace(/<.*>$/, ""));
      if (!target) continue;
      const join = ann(f.annotations, "JoinColumn");
      const refCol =
        target.idColumns.find(
          (x) => x.name === phys(str(join?.attrs.referencedColumnName) ?? ""),
        ) ?? target.idColumns[0];
      if (!refCol) continue;
      const name = phys(str(join?.attrs.name) ?? `${f.name}_${refCol.name}`);
      const notNull = str(rel.attrs.optional) === "false" || str(join?.attrs.nullable) === "false";
      e.table.columns.push({
        name,
        type: refCol.type,
        ...(notNull ? { nullable: false } : {}),
        path: pathOf(f, e.cls),
        line: f.line,
      });
      e.table.foreignKeys.push({
        columns: [name],
        refTable: target.table.name,
        refColumns: [refCol.name],
        path: pathOf(f, e.cls),
        line: rel.line,
      } satisfies OrmForeignKey);
    }
  }

  return {
    tables: [...info.values()].map((e) => e.table),
    ...(engine && DB_ENGINES[engine] ? { storeType: DB_ENGINES[engine] } : {}),
  };
}
