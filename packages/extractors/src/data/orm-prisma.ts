import type { RepoHandle } from "@maycombhq/sdk";
import { isTestOrBuildPath } from "./common.js";
import type { OrmColumn, OrmIndex, OrmModel, OrmTable, Where } from "./orm-model.js";

/**
 * Prisma schema files: model (and view) blocks. Table and column names follow @@map and
 * @map; a field whose type is another model is a relation, and its @relation(fields,
 * references) is the foreign key. Fields are required unless marked "?". Index and unique
 * names are Prisma's defaults (<table>_<columns>_idx, <table>_<columns>_key) unless map: names
 * them, so they match what Prisma creates in the database.
 *
 * Out of scope: composite types (MongoDB), @@schema (multi-schema) and @ignore'd fields.
 */

const SCALARS = new Set([
  "String",
  "Boolean",
  "Int",
  "BigInt",
  "Float",
  "Decimal",
  "DateTime",
  "Json",
  "Bytes",
  "Unsupported",
]);

interface PField {
  name: string;
  type: string;
  list: boolean;
  optional: boolean;
  attrs: string;
  line: number;
}

interface PBlock {
  kind: string;
  name: string;
  line: number;
  fields: PField[];
  blockAttrs: { text: string; line: number }[];
  path: string;
}

/** The argument text of attribute `@name(` (balanced), or undefined. */
function attrArgs(text: string, name: string): string | undefined {
  const re = new RegExp(`${name.replace(/[@.]/g, "\\$&")}\\(`);
  const m = re.exec(text);
  if (!m) return undefined;
  let depth = 0;
  const start = m.index + m[0].length - 1;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "(") depth++;
    if (text[i] === ")" && --depth === 0) return text.slice(start + 1, i);
  }
  return undefined;
}

/** The field list of [a, b(sort: Desc)] → ["a", "b"]. */
const fieldList = (args: string | undefined, key?: string): string[] => {
  if (args === undefined) return [];
  const m = key
    ? new RegExp(`\\b${key}\\s*:\\s*\\[([^\\]]*)\\]`).exec(args)
    : /^\s*\[([^\]]*)\]/.exec(args);
  return (m?.[1] ?? "")
    .split(",")
    .map((s) => s.replace(/\(.*\)/, "").trim())
    .filter(Boolean);
};
const mapName = (args: string | undefined) =>
  args ? /\bmap\s*:\s*"([^"]+)"/.exec(args)?.[1] : undefined;

function readBlocks(text: string, path: string): PBlock[] {
  const out: PBlock[] = [];
  const lines = text.split(/\r?\n/);
  let cur: PBlock | undefined;
  lines.forEach((raw, i) => {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (!cur) {
      const m = /^(model|view|enum|datasource|generator|type)\s+(\w+)\s*\{/.exec(line);
      if (m) cur = { kind: m[1]!, name: m[2]!, line: i + 1, fields: [], blockAttrs: [], path };
      return;
    }
    if (line === "}") {
      out.push(cur);
      cur = undefined;
      return;
    }
    if (line.startsWith("@@")) {
      cur.blockAttrs.push({ text: line, line: i + 1 });
      return;
    }
    const f = /^(\w+)\s+(\w+)(\([^)]*\))?(\[\])?(\?)?\s*(.*)$/.exec(line);
    if (f)
      cur.fields.push({
        name: f[1]!,
        type: f[2]!,
        list: f[4] === "[]",
        optional: f[5] === "?",
        attrs: f[6] ?? "",
        line: i + 1,
      });
    else if (cur.kind === "enum" && /^\w+$/.test(line))
      cur.fields.push({
        name: line,
        type: "",
        list: false,
        optional: false,
        attrs: "",
        line: i + 1,
      });
    else if (cur.kind === "datasource") {
      const p = /^(\w+)\s*=\s*"([^"]*)"/.exec(line);
      if (p)
        cur.fields.push({
          name: p[1]!,
          type: p[2]!,
          list: false,
          optional: false,
          attrs: "",
          line: i + 1,
        });
    }
  });
  return out;
}

export async function readPrisma(repo: RepoHandle): Promise<OrmModel> {
  const blocks: PBlock[] = [];
  for await (const path of repo.listFiles(["**/*.prisma"])) {
    if (isTestOrBuildPath(path)) continue;
    blocks.push(...readBlocks(await repo.readText(path), path));
  }
  const models = blocks.filter(
    (b) =>
      (b.kind === "model" || b.kind === "view") &&
      !b.blockAttrs.some((a) => a.text.startsWith("@@ignore")),
  );
  if (models.length === 0) return { tables: [] };
  const enums = new Set(blocks.filter((b) => b.kind === "enum").map((b) => b.name));
  const ds = blocks.find((b) => b.kind === "datasource");
  const provider = ds?.fields.find((f) => f.name === "provider")?.type;
  const byName = new Map(models.map((m) => [m.name, m]));
  const tableName = (m: PBlock) => {
    const at = m.blockAttrs.find((a) => a.text.startsWith("@@map("));
    return (at && /"([^"]+)"/.exec(at.text)?.[1]) ?? m.name;
  };
  const isScalar = (f: PField) => !f.list && (SCALARS.has(f.type) || enums.has(f.type));
  const colName = (f: PField) => attrArgs(f.attrs, "@map")?.match(/"([^"]+)"/)?.[1] ?? f.name;
  const fieldCol = (m: PBlock, field: string) => {
    const f = m.fields.find((x) => x.name === field);
    return f ? colName(f) : field;
  };

  const tables: OrmTable[] = [];
  for (const m of models) {
    const name = tableName(m);
    const table: OrmTable = {
      name,
      tableKind: m.kind === "view" ? "view" : "table",
      path: m.path,
      line: m.line,
      columns: [],
      foreignKeys: [],
      indexes: [],
    };
    const idx = (cols: string[], unique: boolean, at: Where, mapped?: string): OrmIndex => ({
      name: mapped ?? `${name}_${cols.join("_")}_${unique ? "key" : "idx"}`,
      columns: cols,
      unique,
      ...at,
    });
    for (const f of m.fields) {
      if (/(^|\s)@ignore\b/.test(f.attrs)) continue;
      if (isScalar(f)) {
        const native = /@db\.(\w+(?:\([^)]*\))?)/.exec(f.attrs)?.[1];
        const col: OrmColumn = {
          name: colName(f),
          type: native ?? f.type,
          nullable: f.optional,
          path: m.path,
          line: f.line,
        };
        table.columns.push(col);
        if (/@id\b/.test(f.attrs))
          table.primaryKey = { path: m.path, line: f.line, columns: [col.name] };
        if (/@unique\b/.test(f.attrs))
          table.indexes.push(
            idx(
              [col.name],
              true,
              { path: m.path, line: f.line },
              mapName(attrArgs(f.attrs, "@unique")),
            ),
          );
        continue;
      }
      const target = byName.get(f.type);
      const rel = attrArgs(f.attrs, "@relation");
      if (!target || f.list || !rel) continue;
      const fields = fieldList(rel, "fields");
      const refs = fieldList(rel, "references");
      if (fields.length === 0 || fields.length !== refs.length) continue;
      table.foreignKeys.push({
        columns: fields.map((x) => fieldCol(m, x)),
        refTable: tableName(target),
        refColumns: refs.map((x) => fieldCol(target, x)),
        path: m.path,
        line: f.line,
      });
    }
    for (const a of m.blockAttrs) {
      const kind = /^@@(\w+)\(/.exec(a.text)?.[1];
      const args = kind ? attrArgs(a.text, `@@${kind}`) : undefined;
      const cols = fieldList(args).map((x) => fieldCol(m, x));
      if (cols.length === 0) continue;
      const at = { path: m.path, line: a.line };
      if (kind === "id") table.primaryKey = { ...at, columns: cols };
      else if (kind === "unique") table.indexes.push(idx(cols, true, at, mapName(args)));
      else if (kind === "index") table.indexes.push(idx(cols, false, at, mapName(args)));
    }
    tables.push(table);
  }
  return {
    tables,
    ...(provider ? { storeType: provider } : {}),
    ...(ds ? { storeAt: { path: ds.path, line: ds.line } } : {}),
  };
}
