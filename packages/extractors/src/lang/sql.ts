/**
 * Reads SQL DDL (CREATE TABLE, CREATE INDEX, ALTER TABLE ADD CONSTRAINT) from migration
 * files, and table references from queries in code. Dialect-neutral: types are kept as
 * written, lower-cased.
 */
export interface SqlColumn {
  name: string;
  type: string;
  nullable: boolean;
  default?: string;
  primaryKey: boolean;
  references?: { table: string; columns: string[] };
  line: number;
}

export interface SqlTable {
  name: string;
  columns: SqlColumn[];
  primaryKey: { columns: string[]; line: number } | undefined;
  foreignKeys: {
    name?: string;
    columns: string[];
    table: string;
    refColumns: string[];
    line: number;
  }[];
  line: number;
}

export interface SqlIndex {
  name: string;
  table: string;
  columns: string[];
  unique: boolean;
  line: number;
}

export interface SqlDdl {
  tables: SqlTable[];
  indexes: SqlIndex[];
  /** Human-readable operations, e.g. "create table entry", "create index idx_entry_account". */
  operations: string[];
}

/** Remove comments, keeping line breaks so positions still match the file. */
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

const unquote = (s: string) => s.replace(/^[`"[]|[`"\]]$/g, "").toLowerCase();

/** Split on top-level commas (not inside parentheses). */
function splitTop(body: string): { text: string; offset: number }[] {
  const out: { text: string; offset: number }[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      out.push({ text: body.slice(start, i), offset: start });
      start = i + 1;
    }
  }
  out.push({ text: body.slice(start), offset: start });
  return out;
}

const lineAt = (text: string, offset: number) => text.slice(0, offset).split("\n").length;

const cols = (s: string) =>
  s
    .split(",")
    .map((c) => unquote(c.trim().split(/\s+/)[0]!))
    .filter(Boolean);

export function parseDdl(source: string): SqlDdl {
  const sql = stripComments(source);
  const tables: SqlTable[] = [];
  const indexes: SqlIndex[] = [];
  const operations: string[] = [];

  const tableRe =
    /create\s+(?:or\s+replace\s+)?(?:temporary\s+)?table\s+(?:if\s+not\s+exists\s+)?([\w."`[\]]+)\s*\(/gi;
  for (const m of sql.matchAll(tableRe)) {
    const name = unquote(m[1]!.split(".").pop()!);
    const open = m.index! + m[0].length;
    let depth = 1;
    let j = open;
    for (; j < sql.length && depth > 0; j++) {
      if (sql[j] === "(") depth++;
      else if (sql[j] === ")") depth--;
    }
    const body = sql.slice(open, j - 1);
    const t: SqlTable = {
      name,
      columns: [],
      primaryKey: undefined,
      foreignKeys: [],
      line: lineAt(sql, m.index!),
    };
    for (const part of splitTop(body)) {
      const text = part.text.trim();
      if (!text) continue;
      const lead = part.text.length - part.text.trimStart().length;
      const line = lineAt(sql, open + part.offset + lead);
      const pk = /^(?:constraint\s+\w+\s+)?primary\s+key\s*\(([^)]*)\)/i.exec(text);
      if (pk) {
        t.primaryKey = { columns: cols(pk[1]!), line };
        continue;
      }
      const fk =
        /^(?:constraint\s+(\w+)\s+)?foreign\s+key\s*\(([^)]*)\)\s*references\s+([\w."`]+)\s*\(([^)]*)\)/i.exec(
          text,
        );
      if (fk) {
        t.foreignKeys.push({
          ...(fk[1] ? { name: fk[1].toLowerCase() } : {}),
          columns: cols(fk[2]!),
          table: unquote(fk[3]!.split(".").pop()!),
          refColumns: cols(fk[4]!),
          line,
        });
        continue;
      }
      if (/^(constraint|unique|check|index|key)\b/i.test(text)) continue;
      const cm =
        /^([\w"`[\]]+)\s+([\w]+(?:\s*\([^)]*\))?(?:\s+(?:varying|precision|with(?:out)?\s+time\s+zone))*)([\s\S]*)$/i.exec(
          text,
        );
      if (!cm) continue;
      const rest = cm[3] ?? "";
      const ref = /references\s+([\w."`]+)\s*\(([^)]*)\)/i.exec(rest);
      const def = /default\s+('(?:[^']|'')*'|[^\s,]+)/i.exec(rest);
      const col: SqlColumn = {
        name: unquote(cm[1]!),
        type: cm[2]!
          .replace(/\s+/g, " ")
          .replace(/\s*\(\s*/g, "(")
          .replace(/\s*,\s*/g, ",")
          .replace(/\s*\)/g, ")")
          .toLowerCase(),
        nullable: !/not\s+null|primary\s+key/i.test(rest),
        primaryKey: /primary\s+key/i.test(rest),
        ...(def ? { default: def[1]! } : {}),
        ...(ref
          ? { references: { table: unquote(ref[1]!.split(".").pop()!), columns: cols(ref[2]!) } }
          : {}),
        line,
      };
      t.columns.push(col);
      if (col.primaryKey && !t.primaryKey) t.primaryKey = { columns: [col.name], line };
      if (col.references)
        t.foreignKeys.push({
          columns: [col.name],
          table: col.references.table,
          refColumns: col.references.columns,
          line,
        });
    }
    tables.push(t);
    operations.push(`create table ${name}`);
  }

  const indexRe =
    /create\s+(unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?([\w"`]+)\s+on\s+([\w."`]+)\s*(?:using\s+\w+\s*)?\(([^)]*)\)/gi;
  for (const m of sql.matchAll(indexRe)) {
    const name = unquote(m[2]!);
    indexes.push({
      name,
      table: unquote(m[3]!.split(".").pop()!),
      columns: cols(m[4]!),
      unique: !!m[1],
      line: lineAt(sql, m.index!),
    });
    operations.push(`create index ${name}`);
  }

  for (const m of sql.matchAll(/alter\s+table\s+([\w."`]+)\s+add\s+(?:column\s+)?([\w"`]+)/gi)) {
    const t = unquote(m[1]!.split(".").pop()!);
    operations.push(
      /^constraint$/i.test(m[2]!)
        ? `alter table ${t} add constraint`
        : `alter table ${t} add column ${unquote(m[2]!)}`,
    );
  }
  for (const m of sql.matchAll(/drop\s+(table|index)\s+(?:if\s+exists\s+)?([\w."`]+)/gi)) {
    operations.push(`drop ${m[1]!.toLowerCase()} ${unquote(m[2]!.split(".").pop()!)}`);
  }
  return { tables, indexes, operations };
}

export interface TableAccess {
  table: string;
  access: "read" | "write";
}

/** Tables a query reads or writes: FROM/JOIN are reads; INSERT INTO, UPDATE, DELETE FROM, MERGE INTO are writes. */
export function tablesInQuery(query: string): TableAccess[] {
  const out: TableAccess[] = [];
  const q = stripComments(query);
  const add = (name: string, access: TableAccess["access"]) => {
    const table = unquote(name.split(".").pop()!);
    if (!out.some((o) => o.table === table && o.access === access)) out.push({ table, access });
  };
  for (const m of q.matchAll(/\b(?:insert\s+into|update|merge\s+into)\s+([\w."`]+)/gi))
    add(m[1]!, "write");
  for (const m of q.matchAll(/\bdelete\s+from\s+([\w."`]+)/gi)) add(m[1]!, "write");
  for (const m of q.matchAll(/\b(delete\s+)?(?:from|join)\s+([\w."`]+)/gi)) {
    if (m[1] || /^(select|\()/i.test(m[2]!)) continue;
    add(m[2]!, "read");
  }
  return out;
}

/** Does this string look like SQL worth reading for table access? */
export function looksLikeSql(s: string): boolean {
  return /^\s*(select|insert|update|delete|merge|with)\b/i.test(s);
}
