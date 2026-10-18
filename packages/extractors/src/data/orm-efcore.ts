import type { RepoHandle } from "@maycombhq/sdk";
import { isTestOrBuildPath, lineAt } from "./common.js";
import type { OrmColumn, OrmModel, OrmTable, Where } from "./orm-model.js";

/**
 * Entity Framework Core: entities are the DbSet<T> types of a DbContext (and types configured
 * with modelBuilder.Entity<T>()). Table names follow EF's precedence: fluent ToTable("x"), then
 * [Table("x")], then the DbSet property name, then the class name. Columns are the scalar
 * properties ({ get; ... }) of the class and its non-entity base classes.
 *
 * Keys: [Key], else the Id / <Class>Id convention. Foreign keys: [ForeignKey], else the
 * <navigation><principal key> / <principal class><key> / <navigation>Id convention. Indexes:
 * [Index(...)] with its Name, else EF's IX_<table>_<columns>.
 *
 * Out of scope: fluent configuration other than a literal ToTable (HasKey, HasIndex,
 * Property(...).HasColumnName), owned and complex types, table splitting and migrations'
 * model snapshots.
 */

interface CsAttr {
  name: string;
  args: string;
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

/** Attributes in "[A, B(x)][C]" with their argument text. */
function readAttrs(text: string, line: number): CsAttr[] {
  const out: CsAttr[] = [];
  for (const group of text.matchAll(/\[([^\]]*(?:\([^)]*\)[^\]]*)*)\]/g)) {
    let depth = 0;
    let cur = "";
    const parts: string[] = [];
    for (const ch of group[1]!) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (ch === "," && depth === 0) {
        parts.push(cur);
        cur = "";
      } else cur += ch;
    }
    parts.push(cur);
    for (const p of parts) {
      const m = /^\s*([\w.]+)\s*(?:\(([\s\S]*)\))?\s*$/.exec(p);
      if (m)
        out.push({
          name: m[1]!
            .split(".")
            .pop()!
            .replace(/Attribute$/, ""),
          args: m[2] ?? "",
          line,
        });
    }
  }
  return out;
}

/** Strip string literals' contents and comments so braces can be counted. */
const code = (line: string) =>
  line
    .replace(/@?"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)'/g, "''")
    .replace(/\/\/.*$/, "");

function readCsClasses(text: string, path: string): { classes: CsClass[]; enums: string[] } {
  const lines = text.split(/\r?\n/);
  const classes: CsClass[] = [];
  const enums: string[] = [];
  let pending: CsAttr[] = [];
  let depth = 0;
  const stack: { cls: CsClass; depth: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = code(raw);
    const trimmed = line.trim();
    const top = stack.at(-1);
    if (/^\[/.test(trimmed) && /\]\s*$/.test(trimmed)) {
      pending.push(...readAttrs(raw.trim(), i + 1));
      continue;
    }
    const en = /\benum\s+(\w+)/.exec(trimmed);
    if (en) enums.push(en[1]!);
    const cm =
      /\b(?:class|record)\s+(\w+)(?:<[^>]*>)?(?:\s*\([^)]*\))?(?:\s*:\s*([\w.<>, ]+))?/.exec(
        trimmed,
      );
    if (cm && !/^\s*\/\//.test(raw)) {
      const base = cm[2]?.split(",")[0]?.trim().replace(/<.*$/, "");
      const cls: CsClass = {
        name: cm[1]!,
        ...(base ? { base } : {}),
        line: i + 1,
        attrs: pending,
        props: [],
        path,
      };
      classes.push(cls);
      stack.push({ cls, depth: depth + 1 });
      pending = [];
    } else if (top && depth === top.depth) {
      const pm =
        /^(?:(?:public|internal|protected|virtual|required|override|new|sealed)\s+)*([\w.]+(?:<[^>]*>)?(?:\[\])?)(\?)?\s+(\w+)\s*\{\s*(?:get|init|set)\b/.exec(
          trimmed,
        );
      if (pm && /\bpublic\b/.test(trimmed))
        top.cls.props.push({
          name: pm[3]!,
          type: pm[1]!,
          nullable: pm[2] === "?",
          line: i + 1,
          attrs: pending,
        });
      if (trimmed !== "") pending = [];
    } else if (trimmed !== "" && !trimmed.startsWith("//")) pending = [];
    for (const ch of line) {
      if (ch === "{") depth++;
      if (ch === "}") {
        if (stack.length > 0 && stack.at(-1)!.depth === depth) stack.pop();
        depth--;
      }
    }
  }
  return { classes, enums };
}

/** The text of the balanced parentheses starting at text[open] ("("). */
function balanced(text: string, open: number): { inner: string; end: number } {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    if (text[i] === ")" && --depth === 0) return { inner: text.slice(open + 1, i), end: i + 1 };
  }
  return { inner: text.slice(open + 1), end: text.length };
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

const firstString = (args: string) => /"([^"]*)"/.exec(args)?.[1];
const named = (args: string, key: string) =>
  new RegExp(`\\b${key}\\s*=\\s*"([^"]*)"`).exec(args)?.[1];

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
    if (!/DbContext|IEntityTypeConfiguration/.test(text)) continue;
    const ctxClass = /\bclass\s+\w+[^{]*:\s*(?:[\w.]*\.)?(?:Identity)?DbContext\b/.exec(text);
    if (ctxClass) storeAt ??= { path, line: lineAt(text, ctxClass.index) };
    for (const m of text.matchAll(/\bDbSet<(\w+)>\s+(\w+)/g))
      if (!sets.has(m[1]!)) sets.set(m[1]!, m[2]!);
    for (const m of text.matchAll(/\bEntity<(\w+)>\s*\(/g)) {
      configured.add(m[1]!);
      const { inner, end } = balanced(text, m.index + m[0].length - 1);
      const chain = text.slice(
        end,
        text.indexOf(";", end) === -1 ? undefined : text.indexOf(";", end),
      );
      const t =
        /\.ToTable\(\s*"([^"]+)"/.exec(inner) ??
        /^\s*(?:\.\w+\([^;]*?\)\s*)*?\.ToTable\(\s*"([^"]+)"/.exec(chain);
      if (t && !fluent.has(m[1]!)) fluent.set(m[1]!, t[1]!);
    }
    for (const m of text.matchAll(/\bIEntityTypeConfiguration<(\w+)>/g)) {
      configured.add(m[1]!);
      const open = text.indexOf("{", m.index);
      const body = open === -1 ? "" : text.slice(open, text.indexOf("\n}", open) + 2 || undefined);
      const t = /\.ToTable\(\s*"([^"]+)"/.exec(body);
      if (t && !fluent.has(m[1]!)) fluent.set(m[1]!, t[1]!);
    }
  }
  for (const text of texts.values()) {
    const u = /\.Use(Npgsql|SqlServer|MySql|MySQL|Sqlite|Oracle|Cosmos)\s*\(/.exec(text);
    if (u) {
      storeType = ENGINES[u[1]!];
      break;
    }
  }
  const wanted = new Set([...sets.keys(), ...configured]);
  if (wanted.size === 0) return { tables: [] };

  const classes = new Map<string, CsClass>();
  const enums = new Set<string>();
  for (const [path, text] of texts) {
    if (![...wanted].some((w) => text.includes(w))) continue;
    const r = readCsClasses(text, path);
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
      fluent.get(c.name) ??
      (tableAttr && firstString(tableAttr.args)) ??
      sets.get(c.name) ??
      c.name;
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
        name: (colAttr && firstString(colAttr.args.replace(/\b\w+\s*=\s*"[^"]*"/g, ""))) ?? p.name,
        type: (colAttr && named(colAttr.args, "TypeName")) ?? p.type,
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
      const propNames = [
        ...[...ix.args.matchAll(/nameof\(\s*(?:\w+\.)?(\w+)\s*\)/g)].map((m) => m[1]!),
        ...[...ix.args.replace(/\b\w+\s*=\s*"[^"]*"/g, "").matchAll(/"([^"]+)"/g)].map(
          (m) => m[1]!,
        ),
      ];
      const cols = propNames.map((p) => byProp.get(p)?.name ?? p);
      if (cols.length === 0) continue;
      table.indexes.push({
        name: named(ix.args, "Name") ?? `IX_${name}_${cols.join("_")}`,
        columns: cols,
        unique: /\bIsUnique\s*=\s*true\b/.test(ix.args),
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
        ? (/nameof\(\s*(?:\w+\.)?(\w+)\s*\)/.exec(fkAttr.args)?.[1] ?? firstString(fkAttr.args))
        : e.all.find((p) => {
            const a = has(p, "ForeignKey");
            return (
              a && (firstString(a.args) ?? /nameof\(\s*(\w+)\s*\)/.exec(a.args)?.[1]) === nav.name
            );
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
