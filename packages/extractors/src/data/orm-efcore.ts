import type { RepoHandle } from "@maycombhq/sdk";
import {
  callOf,
  callsIn,
  compact,
  compactName,
  descendants,
  kids,
  lineOf,
  namePath,
  same,
  stringValue,
  withTree,
  type CodeCall,
  type Node,
} from "../lang/code-tree.js";
import { isTestOrBuildPath } from "./common.js";
import type { OrmColumn, OrmModel, OrmTable, Where } from "./orm-model.js";

/**
 * Entity Framework Core, read from C# syntax trees (ADR 0060): entities are the DbSet<T> types
 * of a DbContext (and types configured with modelBuilder.Entity<T>()). Table names follow EF's
 * precedence: fluent ToTable("x"), then [Table("x")], then the DbSet property name, then the
 * class name. Columns are the scalar properties ({ get; ... }) of the class and its non-entity
 * base classes.
 *
 * Keys: [Key], else the Id / <Class>Id convention. Foreign keys: [ForeignKey], else the
 * <navigation><principal key> / <principal class><key> / <navigation>Id convention. Indexes:
 * [Index(...)] with its Name, else EF's IX_<table>_<columns>.
 *
 * Out of scope: fluent configuration other than a literal ToTable (HasKey, HasIndex,
 * Property(...).HasColumnName), owned and complex types, table splitting and migrations'
 * model snapshots.
 */

/** An attribute argument: its text, and its value when it is a string or nameof(X). */
interface CsArg {
  text: string;
  str?: string;
  nameof?: string;
}

interface CsAttr {
  name: string;
  /** Positional arguments. */
  args: CsArg[];
  /** Named arguments: `IsUnique = true`, `Name = "x"`. */
  named: Map<string, CsArg>;
  line: number;
}

interface CsProp {
  name: string;
  type: string;
  nullable: boolean;
  line: number;
  attrs: CsAttr[];
}

interface CsClass {
  name: string;
  base?: string;
  line: number;
  attrs: CsAttr[];
  props: CsProp[];
  path: string;
}

const SCALARS = new Set([
  "int",
  "long",
  "short",
  "byte",
  "sbyte",
  "uint",
  "ulong",
  "ushort",
  "bool",
  "decimal",
  "double",
  "float",
  "char",
  "string",
  "byte[]",
  "Guid",
  "DateTime",
  "DateTimeOffset",
  "DateOnly",
  "TimeOnly",
  "TimeSpan",
  "Int16",
  "Int32",
  "Int64",
  "String",
  "Boolean",
  "Decimal",
  "Double",
  "Single",
  "Byte",
  "Char",
]);
const REFERENCE_TYPES = new Set(["string", "String", "byte[]"]);
/** Modifiers a mapped property may carry (a static or abstract property is not a column). */
const PROP_MODIFIERS = new Set([
  "public",
  "internal",
  "protected",
  "virtual",
  "required",
  "override",
  "new",
  "sealed",
]);

/** The attributes of a declaration: `[A, B(x)] [C]`. */
function attrsOf(decl: Node): CsAttr[] {
  const out: CsAttr[] = [];
  for (const list of kids(decl).filter((c) => c.type === "attribute_list"))
    for (const a of kids(list).filter((c) => c.type === "attribute")) {
      const nameNode = a.childForFieldName("name");
      if (!nameNode) continue;
      const args: CsArg[] = [];
      const named = new Map<string, CsArg>();
      for (const arg of kids(kids(a).find((c) => c.type === "attribute_argument_list"))) {
        const key = kids(arg).find((c) => c.type === "name_equals" || c.type === "name_colon");
        const value = kids(arg)
          .filter((c) => !same(c, key))
          .at(-1);
        if (!value) continue;
        const str = stringValue(value);
        const nameof = nameofArg(value);
        const v: CsArg = {
          text: value.text,
          ...(str !== undefined ? { str } : {}),
          ...(nameof ? { nameof } : {}),
        };
        if (key) named.set(kids(key)[0]?.text ?? key.text.replace(/\W/g, ""), v);
        else args.push(v);
      }
      out.push({
        name: compactName(nameNode)
          .split(".")
          .pop()!
          .replace(/Attribute$/, ""),
        args,
        named,
        line: lineOf(a),
      });
    }
  return out;
}

const modifiersOf = (decl: Node) =>
  kids(decl)
    .filter((c) => c.type === "modifier")
    .map((c) => c.text);

/** The simple name a base-list entry names: `DbContext`, `IEntityTypeConfiguration` (generics left out). */
const baseName = (b: Node) => namePath(b)?.at(-1) ?? namePath(kids(b)[0])?.at(-1);

/** The generic type arguments of a base-list entry: `IEntityTypeConfiguration<Order>` → ["Order"]. */
function baseTypeArgs(b: Node): string[] {
  const g = b.type === "generic_name" ? b : kids(b).find((c) => c.type === "generic_name");
  return kids(kids(g).find((c) => c.type === "type_argument_list")).map((t) =>
    compactName(t).split(".").pop()!,
  );
}

const basesOf = (cls: Node) => kids(cls.childForFieldName("bases") ?? undefined);

function readCsClasses(root: Node, path: string): { classes: CsClass[]; enums: string[] } {
  const classes: CsClass[] = [];
  const enums: string[] = [];
  for (const n of descendants(root)) {
    if (n.type === "enum_declaration") {
      const name = n.childForFieldName("name");
      if (name) enums.push(name.text);
      continue;
    }
    if (n.type !== "class_declaration" && n.type !== "record_declaration") continue;
    const nameNode = n.childForFieldName("name");
    if (!nameNode) continue;
    const first = basesOf(n)[0];
    const base = first ? compactName(first).replace(/\(.*$/, "") : undefined;
    const cls: CsClass = {
      name: nameNode.text,
      ...(base ? { base } : {}),
      line: lineOf(nameNode),
      attrs: attrsOf(n),
      props: [],
      path,
    };
    classes.push(cls);
    for (const m of kids(n.childForFieldName("body") ?? undefined)) {
      if (m.type !== "property_declaration" || !m.childForFieldName("accessors")) continue;
      const mods = modifiersOf(m);
      if (!mods.includes("public") || mods.some((x) => !PROP_MODIFIERS.has(x))) continue;
      const typeNode = m.childForFieldName("type");
      const nameOf = m.childForFieldName("name");
      if (!typeNode || !nameOf) continue;
      const nullable = typeNode.type === "nullable_type";
      const inner = nullable ? (kids(typeNode)[0] ?? typeNode) : typeNode;
      cls.props.push({
        name: nameOf.text,
        type: compact(inner),
        nullable,
        line: lineOf(nameOf),
        attrs: attrsOf(m),
      });
    }
  }
  return { classes, enums };
}

const ENGINES: Record<string, string> = {
  Npgsql: "postgresql",
  SqlServer: "sqlserver",
  MySql: "mysql",
  MySQL: "mysql",
  Sqlite: "sqlite",
  Oracle: "oracle",
  Cosmos: "cosmosdb",
};

/** `nameof(Order.Reference)` → "Reference". */
function nameofArg(n: Node | undefined): string | undefined {
  const c = n ? callOf(n) : undefined;
  return c && c.name === "nameof" && !c.receiver ? namePath(c.args[0])?.at(-1) : undefined;
}

/** The first positional argument when it is a string: [Table("orders")], [Column("total", ...)]. */
const firstString = (a: CsAttr) => a.args[0]?.str;
const named = (a: CsAttr, key: string) => a.named.get(key)?.str;
/** What a [ForeignKey] names: nameof(X) or "X". */
const fkTarget = (a: CsAttr) => a.args[0]?.nameof ?? firstString(a);

/** The table a ToTable("x") call in `n` names, the first one in source order. */
function toTableIn(n: Node | undefined): string | undefined {
  if (!n) return undefined;
  for (const c of callsIn(n))
    if (c.name === "ToTable" && stringValue(c.args[0])) return stringValue(c.args[0]);
  return undefined;
}

/** A ToTable("x") later in the call chain: modelBuilder.Entity<X>().HasKey(...).ToTable("x"). */
function toTableInChain(call: CodeCall): string | undefined {
  let p: Node = call.node;
  for (;;) {
    const access = p.parent;
    const next = access?.parent;
    if (
      access?.type !== "member_access_expression" ||
      !same(access.childForFieldName("expression"), p) ||
      next?.type !== "invocation_expression"
    )
      return undefined;
    const c = callOf(next);
    if (c?.name === "ToTable" && stringValue(c.args[0])) return stringValue(c.args[0]);
    p = next;
  }
}

export async function readEfCore(repo: RepoHandle): Promise<OrmModel> {
  const texts = new Map<string, string>();
  for await (const path of repo.listFiles(["**/*.cs"])) {
    if (isTestOrBuildPath(path) || /(^|\/)Migrations\//.test(path)) continue;
    texts.set(path, await repo.readText(path));
  }
  const sets = new Map<string, string>(); // entity class → DbSet property name
  const fluent = new Map<string, string>(); // entity class → ToTable name
  const configured = new Set<string>();
  let storeType: string | undefined;
  let storeAt: Where | undefined;
  for (const [path, text] of texts) {
    // Only files that name EF's types can declare a context or a configuration.
    if (!text.includes("DbContext") && !text.includes("IEntityTypeConfiguration")) continue;
    await withTree("c_sharp", text, (root) => {
      const fluentTable = (entity: string, table: string | undefined) => {
        if (table && !fluent.has(entity)) fluent.set(entity, table);
      };
      for (const n of descendants(root)) {
        if (n.type === "class_declaration") {
          const bases = basesOf(n);
          const first = bases[0];
          const nameNode = n.childForFieldName("name");
          if (first && nameNode && /^(Identity)?DbContext$/.test(baseName(first) ?? ""))
            storeAt ??= { path, line: lineOf(nameNode) };
          for (const b of bases)
            if (baseName(b) === "IEntityTypeConfiguration")
              for (const entity of baseTypeArgs(b)) {
                configured.add(entity);
                fluentTable(entity, toTableIn(n.childForFieldName("body") ?? undefined));
              }
        } else if (n.type === "property_declaration" || n.type === "variable_declaration") {
          const type = n.childForFieldName("type");
          const name =
            n.type === "property_declaration"
              ? n.childForFieldName("name")
              : kids(n)
                  .find((c) => c.type === "variable_declarator")
                  ?.childForFieldName("name");
          if (type?.type === "generic_name" && baseName(type) === "DbSet" && name) {
            const entity = baseTypeArgs(type)[0];
            if (entity && !sets.has(entity)) sets.set(entity, name.text);
          }
        } else if (n.type === "invocation_expression") {
          const c = callOf(n);
          if (c?.name !== "Entity" || c.typeArgs.length !== 1) continue;
          const entity = c.typeArgs[0]!.split(".").pop()!;
          configured.add(entity);
          // b => b.ToTable("x") in the call, else .ToTable("x") later in its chain.
          let inArgs: string | undefined;
          for (const a of c.args) inArgs ??= toTableIn(a);
          fluentTable(entity, inArgs ?? toTableInChain(c));
        }
      }
    });
  }
  for (const text of texts.values()) {
    if (!/\.Use(Npgsql|SqlServer|MySql|MySQL|Sqlite|Oracle|Cosmos)\b/.test(text)) continue;
    const engine = await withTree("c_sharp", text, (root) => {
      for (const c of callsIn(root)) {
        const m = /^Use(Npgsql|SqlServer|MySql|MySQL|Sqlite|Oracle|Cosmos)$/.exec(c.name);
        if (m && c.receiver) return ENGINES[m[1]!];
      }
      return undefined;
    });
    if (engine) {
      storeType = engine;
      break;
    }
  }
  const wanted = new Set([...sets.keys(), ...configured]);
  if (wanted.size === 0) return { tables: [] };

  const classes = new Map<string, CsClass>();
  const enums = new Set<string>();
  for (const [path, text] of texts) {
    if (![...wanted].some((w) => text.includes(w))) continue;
    const r = await withTree("c_sharp", text, (root) => readCsClasses(root, path));
    for (const c of r.classes) if (!classes.has(c.name)) classes.set(c.name, c);
    for (const e of r.enums) enums.add(e);
  }
  const entities = [...wanted].filter((n) => classes.has(n));
  const isEntity = (t: string) => entities.includes(t);
  const props = (c: CsClass, seen = new Set<string>()): CsProp[] => {
    const base = c.base ? classes.get(c.base) : undefined;
    const inherited =
      base && !isEntity(base.name) && !seen.has(base.name)
        ? props(base, new Set([...seen, c.name]))
        : [];
    return [...inherited, ...c.props];
  };
  const pathOf = (p: CsProp, c: CsClass): string =>
    c.props.includes(p)
      ? c.path
      : c.base && classes.get(c.base)
        ? pathOf(p, classes.get(c.base)!)
        : c.path;
  const has = (p: { attrs: CsAttr[] }, name: string) => p.attrs.find((a) => a.name === name);
  const scalar = (p: CsProp) => SCALARS.has(p.type.replace(/^System\./, "")) || enums.has(p.type);

  interface Info {
    cls: CsClass;
    table: OrmTable;
    byProp: Map<string, OrmColumn>;
    keyProps: string[];
    all: CsProp[];
  }
  const info = new Map<string, Info>();
  const sorted = entities
    .map((n) => classes.get(n)!)
    .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  for (const c of sorted) {
    const tableAttr = has(c, "Table");
    const name =
      fluent.get(c.name) ?? (tableAttr && firstString(tableAttr)) ?? sets.get(c.name) ?? c.name;
    const table: OrmTable = {
      name,
      tableKind: "table",
      path: c.path,
      line: c.line,
      columns: [],
      foreignKeys: [],
      indexes: [],
    };
    const all = props(c).filter((p) => !has(p, "NotMapped"));
    const byProp = new Map<string, OrmColumn>();
    const keyAttr = all.filter((p) => scalar(p) && has(p, "Key"));
    const conv = all.find(
      (p) =>
        scalar(p) &&
        (p.name.toLowerCase() === "id" || p.name.toLowerCase() === `${c.name.toLowerCase()}id`),
    );
    const keyProps = keyAttr.length > 0 ? keyAttr : conv ? [conv] : [];
    for (const p of all) {
      if (!scalar(p)) continue;
      const colAttr = has(p, "Column");
      const isKey = keyProps.includes(p);
      const valueType = !REFERENCE_TYPES.has(p.type.replace(/^System\./, ""));
      const nullable = p.nullable
        ? true
        : isKey || has(p, "Required") || valueType
          ? false
          : undefined;
      const col: OrmColumn = {
        name: (colAttr && firstString(colAttr)) ?? p.name,
        type: (colAttr && named(colAttr, "TypeName")) ?? p.type,
        ...(nullable !== undefined ? { nullable } : {}),
        path: pathOf(p, c),
        line: p.line,
      };
      table.columns.push(col);
      byProp.set(p.name, col);
    }
    if (keyProps.length > 0) {
      const first = keyProps[0]!;
      table.primaryKey = {
        path: pathOf(first, c),
        line: has(first, "Key")?.line ?? first.line,
        columns: keyProps.map((p) => byProp.get(p.name)!.name),
      };
    }
    for (const ix of c.attrs.filter((a) => a.name === "Index")) {
      // [Index(nameof(A), "B", IsUnique = true, Name = "x")]
      const propNames = ix.args.flatMap((x) => x.nameof ?? x.str ?? []);
      const cols = propNames.map((p) => byProp.get(p)?.name ?? p);
      if (cols.length === 0) continue;
      table.indexes.push({
        name: named(ix, "Name") ?? `IX_${name}_${cols.join("_")}`,
        columns: cols,
        unique: ix.named.get("IsUnique")?.text === "true",
        path: c.path,
        line: ix.line,
      });
    }
    info.set(c.name, { cls: c, table, byProp, keyProps: keyProps.map((p) => p.name), all });
  }

  // Foreign keys: a navigation to another entity and the scalar property holding its key.
  for (const e of info.values()) {
    for (const nav of e.all) {
      const target = info.get(nav.type);
      if (!target || target.keyProps.length !== 1) continue;
      const pk = target.keyProps[0]!;
      const fkAttr = has(nav, "ForeignKey");
      const declared = fkAttr
        ? fkTarget(fkAttr)
        : e.all.find((p) => {
            const a = has(p, "ForeignKey");
            return a && fkTarget(a) === nav.name;
          })?.name;
      const fkProp = [declared, `${nav.name}${pk}`, `${nav.type}${pk}`, `${nav.name}Id`]
        .filter((x): x is string => x !== undefined)
        .find((x) => e.byProp.has(x));
      if (!fkProp) continue;
      e.table.foreignKeys.push({
        columns: [e.byProp.get(fkProp)!.name],
        refTable: target.table.name,
        refColumns: [target.byProp.get(pk)!.name],
        path: pathOf(nav, e.cls),
        line: nav.line,
      });
    }
  }

  return {
    tables: [...info.values()].map((x) => x.table),
    ...(storeType ? { storeType } : {}),
    ...(storeAt ? { storeAt } : {}),
  };
}
