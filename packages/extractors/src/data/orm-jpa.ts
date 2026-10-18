import type { RepoHandle } from "@maycombhq/sdk";
import { repoConfig } from "../facts.js";
import { tokenize, type Token } from "../lang/java.js";
import { isTestOrBuildPath } from "./common.js";
import type { OrmColumn, OrmForeignKey, OrmIndex, OrmModel, OrmTable } from "./orm-model.js";

/**
 * JPA / Hibernate entities in Java. The shared Java reader only records annotated fields, but
 * JPA maps every non-transient field, so this module walks class bodies itself.
 *
 * Naming: Spring Boot's default physical naming (CamelCaseToUnderscoresNamingStrategy) turns
 * ownerName into owner_name, for explicit names too; with PhysicalNamingStrategyStandardImpl
 * configured, names stay as written.
 *
 * Out of scope: @Embedded / @EmbeddedId, @ElementCollection, @JoinTable link tables, entity
 * inheritance (only @MappedSuperclass fields are inherited), orm.xml mappings and Kotlin.
 */

type AttrValue = string | string[];

interface JAnn {
  name: string;
  attrs: Record<string, AttrValue>;
  nested: JAnn[];
  line: number;
}

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

const MODIFIERS = new Set([
  "public",
  "protected",
  "private",
  "static",
  "final",
  "transient",
  "volatile",
  "abstract",
  "synchronized",
  "native",
  "default",
  "sealed",
  "non",
]);
const PRIMITIVES = new Set(["int", "long", "short", "byte", "boolean", "double", "float", "char"]);

const isP = (t: Token | undefined, v: string) => t?.t === "p" && t.v === v;

/** Read an annotation starting at tk[i] ("@"); nested annotations in its arguments are kept. */
function readAnn(tk: Token[], i: number): { a: JAnn; i: number } {
  let j = i + 1;
  let name = tk[j]?.t === "id" ? tk[j]!.v : "";
  const line = tk[j]?.line ?? 1;
  j++;
  while (isP(tk[j], ".") && tk[j + 1]?.t === "id") {
    name = tk[j + 1]!.v;
    j += 2;
  }
  const a: JAnn = { name, attrs: {}, nested: [], line };
  if (!isP(tk[j], "(")) return { a, i: j };
  j++;
  let seg: Token[] = [];
  const flush = () => {
    if (seg.length === 0) return;
    let key = "value";
    let vals = seg;
    if (seg[0]?.t === "id" && isP(seg[1], "=")) {
      key = seg[0].v;
      vals = seg.slice(2);
    }
    const strs = vals.filter((t) => t.t === "str").map((t) => t.v);
    if (isP(vals[0], "{")) a.attrs[key] = strs;
    else if (strs.length > 0) a.attrs[key] = strs.join("");
    else
      a.attrs[key] = vals
        .filter((t) => t.t === "id" || t.t === "num" || isP(t, "."))
        .map((t) => t.v)
        .join("");
    seg = [];
  };
  let depth = 0;
  while (j < tk.length) {
    const t = tk[j]!;
    if (isP(t, "@")) {
      const r = readAnn(tk, j);
      a.nested.push(r.a);
      j = r.i;
      continue;
    }
    if (isP(t, "(") || isP(t, "{")) depth++;
    if (isP(t, ")") || isP(t, "}")) {
      if (depth === 0) break;
      depth--;
    }
    if (depth === 0 && isP(t, ",")) flush();
    else seg.push(t);
    j++;
  }
  flush();
  return { a, i: j + 1 };
}

/** Skip from an opening brace at tk[i] to just past its matching close. */
function skipBlock(tk: Token[], i: number): number {
  let depth = 0;
  for (; i < tk.length; i++) {
    if (isP(tk[i], "{")) depth++;
    else if (isP(tk[i], "}") && --depth === 0) return i + 1;
  }
  return i;
}

/** Classes in a Java file with their annotations, superclass and fields. */
export function readJavaClasses(src: string, path: string): JClass[] {
  const tk = tokenize(src);
  const out: JClass[] = [];
  const walk = (i: number, end: number, owner: JClass | undefined): void => {
    let pending: JAnn[] = [];
    while (i < end) {
      const t = tk[i]!;
      if (isP(t, "@") && !(tk[i + 1]?.t === "id" && tk[i + 1]!.v === "interface")) {
        const r = readAnn(tk, i);
        pending.push(r.a);
        i = r.i;
        continue;
      }
      if (
        t.t === "id" &&
        ["class", "interface", "enum", "record"].includes(t.v) &&
        tk[i + 1]?.t === "id"
      ) {
        const cls: JClass = {
          name: tk[i + 1]!.v,
          line: tk[i + 1]!.line,
          annotations: pending,
          fields: [],
          path,
        };
        pending = [];
        let j = i + 2;
        while (j < end && !isP(tk[j], "{") && !isP(tk[j], ";")) {
          if (tk[j]!.t === "id" && tk[j]!.v === "extends" && tk[j + 1]?.t === "id")
            cls.superName = tk[j + 1]!.v;
          j++;
        }
        if (isP(tk[j], "{")) {
          const close = skipBlock(tk, j);
          if (t.v === "class") out.push(cls);
          walk(j + 1, close - 1, t.v === "class" ? cls : undefined);
          i = close;
        } else i = j + 1;
        continue;
      }
      if (!owner) {
        if (isP(t, "{")) i = skipBlock(tk, i);
        else {
          if (isP(t, ";")) pending = [];
          i++;
        }
        continue;
      }
      // A member of a class body: find where its declaration stops.
      let j = i;
      let paren = 0;
      let sawParen = false;
      while (j < end) {
        const x = tk[j]!;
        if (isP(x, "(")) {
          paren++;
          sawParen = true;
        } else if (isP(x, ")")) paren--;
        else if (paren === 0 && (isP(x, ";") || isP(x, "{") || isP(x, "="))) break;
        j++;
      }
      const stop = tk[j];
      if (sawParen || isP(stop, "{")) {
        // Method, constructor or initializer: skip its body.
        let k = j;
        while (k < end && !isP(tk[k], "{") && !isP(tk[k], ";")) k++;
        i = isP(tk[k], "{") ? skipBlock(tk, k) : k + 1;
        pending = [];
        continue;
      }
      const decl = tk.slice(i, j);
      if (isP(stop, "=")) {
        // Skip the initializer to the end of the statement.
        let depth = 0;
        while (j < end && !(depth === 0 && isP(tk[j], ";"))) {
          if (isP(tk[j], "(") || isP(tk[j], "{")) depth++;
          if (isP(tk[j], ")") || isP(tk[j], "}")) depth--;
          j++;
        }
      }
      const modifiers = new Set<string>();
      let k = 0;
      while (k < decl.length && decl[k]!.t === "id" && MODIFIERS.has(decl[k]!.v))
        modifiers.add(decl[k++]!.v);
      const rest = decl.slice(k);
      const nameTok = [...rest].reverse().find((x) => x.t === "id");
      if (nameTok && rest.length >= 2) {
        const typeToks = rest.slice(0, rest.lastIndexOf(nameTok));
        owner.fields.push({
          name: nameTok.v,
          type: typeToks.map((x) => x.v).join(""),
          line: nameTok.line,
          annotations: pending,
          modifiers,
        });
      }
      pending = [];
      i = j + 1;
    }
  };
  walk(0, tk.length, undefined);
  return out;
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
    for (const c of readJavaClasses(text, path)) if (!classes.has(c.name)) classes.set(c.name, c);
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
