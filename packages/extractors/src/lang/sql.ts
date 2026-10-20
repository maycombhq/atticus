/**
 * Reads SQL DDL (CREATE TABLE, CREATE INDEX, ALTER TABLE, DROP TABLE/INDEX) from migration
 * files, and table references from queries in code. Dialect-neutral: types are kept as
 * written, lower-cased. ALTER TABLE column actions come back with their lines so the
 * migrations extractor can replay them, in migration order, over the tables it has seen.
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

/**
 * One column action of an ALTER TABLE statement. `alter-column` carries only what the
 * statement says (a new `type`, `nullable`, `default` or `dropDefault`); a full redefinition
 * (SQL Server `ALTER COLUMN c type NULL`, MySQL `MODIFY` or `CHANGE`) carries `definition`.
 */
export interface SqlAlter {
  op: "add-column" | "drop-column" | "alter-column" | "rename-column";
  table: string;
  column: string;
  line: number;
  /** add-column, and alter-column when the column is redefined in full. */
  definition?: SqlColumn;
  type?: string;
  nullable?: boolean;
  default?: string;
  dropDefault?: boolean;
  /** rename-column: the new name. */
  to?: string;
}

/** A DROP TABLE or DROP INDEX statement, so a replay can remove what it names. */
export interface SqlDrop {
  kind: "table" | "index";
  name: string;
  line: number;
}

export interface SqlDdl {
  tables: SqlTable[];
  indexes: SqlIndex[];
  /** Column actions of ALTER TABLE statements, in file order. */
  alters: SqlAlter[];
  drops: SqlDrop[];
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

const TYPE_RE =
  /^(\w+(?:\s*\([^)]*\))?(?:\s+(?:varying|precision|with(?:out)?\s+time\s+zone))*)([\s\S]*)$/i;

const normType = (t: string) =>
  t
    .replace(/\s+/g, " ")
    .replace(/\s*\(\s*/g, "(")
    .replace(/\s*,\s*/g, ",")
    .replace(/\s*\)/g, ")")
    .toLowerCase();

const DEFAULT_RE = /default\s+('(?:[^']|'')*'|[^\s,]+)/i;
const NAME = String.raw`[\w"\x60[\]]+`;

/** A column definition: `name type [constraints]`. */
function parseColumn(text: string, line: number): SqlColumn | undefined {
  const nm = new RegExp(String.raw`^(${NAME})\s+([\s\S]*)$`).exec(text.trim());
  if (!nm) return undefined;
  const tm = TYPE_RE.exec(nm[2]!);
  if (!tm) return undefined;
  const rest = tm[2] ?? "";
  const ref = /references\s+([\w."`]+)\s*\(([^)]*)\)/i.exec(rest);
  const def = DEFAULT_RE.exec(rest);
  return {
    name: unquote(nm[1]!),
    type: normType(tm[1]!),
    nullable: !/not\s+null|primary\s+key/i.test(rest),
    primaryKey: /primary\s+key/i.test(rest),
    ...(def ? { default: def[1]! } : {}),
    ...(ref
      ? { references: { table: unquote(ref[1]!.split(".").pop()!), columns: cols(ref[2]!) } }
      : {}),
    line,
  };
}

/** Where the statement starting at `from` ends: the next top-level `;`, or the end. */
function statementEnd(sql: string, from: number): number {
  let depth = 0;
  for (let i = from; i < sql.length; i++) {
    const c = sql[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === ";" && depth <= 0) return i;
  }
  return sql.length;
}

const re = (s: string) => new RegExp(s, "i");

/** One ALTER TABLE action list: column actions into `alters`, a description into `operations`. */
function parseAlterActions(
  table: string,
  sql: string,
  start: number,
  alters: SqlAlter[],
  operations: string[],
): void {
  const body = sql.slice(start, statementEnd(sql, start));
  const op = (a: SqlAlter, text: string) => {
    alters.push(a);
    operations.push(`alter table ${table} ${text}`);
  };
  for (const part of splitTop(body)) {
    const text = part.text.trim();
    if (!text) continue;
    const lead = part.text.length - part.text.trimStart().length;
    const line = lineAt(sql, start + part.offset + lead);
    if (/^add\s+(?:constraint|primary|foreign|unique|check|index|key)\b/i.test(text)) {
      operations.push(`alter table ${table} add constraint`);
      continue;
    }
    const multi = /^add\s*\(([\s\S]*)\)$/i.exec(text);
    const single = /^add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?([\s\S]+)$/i.exec(text);
    if (multi || single) {
      const defs = multi ? splitTop(multi[1]!).map((p) => p.text) : [single![1]!];
      for (const d of defs) {
        const col = parseColumn(d, line);
        if (col)
          op(
            { op: "add-column", table, column: col.name, line, definition: col },
            `add column ${col.name}`,
          );
      }
      continue;
    }
    if (/^drop\s+(?:constraint|primary|foreign|index|key|check|unique)\b/i.test(text)) continue;
    const drop = re(String.raw`^drop\s+(?:column\s+)?(?:if\s+exists\s+)?(${NAME})`).exec(text);
    if (drop) {
      const column = unquote(drop[1]!);
      op({ op: "drop-column", table, column, line }, `drop column ${column}`);
      continue;
    }
    const rename = re(String.raw`^rename\s+column\s+(${NAME})\s+to\s+(${NAME})`).exec(text);
    if (rename) {
      const column = unquote(rename[1]!);
      const to = unquote(rename[2]!);
      op({ op: "rename-column", table, column, line, to }, `rename column ${column} to ${to}`);
      continue;
    }
    // MySQL CHANGE old new definition: a rename (when the name differs) and a redefinition.
    const change = re(String.raw`^change\s+(?:column\s+)?(${NAME})\s+([\s\S]+)$`).exec(text);
    if (change) {
      const column = unquote(change[1]!);
      const col = parseColumn(change[2]!, line);
      if (!col) continue;
      if (col.name !== column)
        op(
          { op: "rename-column", table, column, line, to: col.name },
          `rename column ${column} to ${col.name}`,
        );
      op(
        { op: "alter-column", table, column: col.name, line, definition: col },
        `alter column ${col.name}`,
      );
      continue;
    }
    const alter = re(String.raw`^(?:alter|modify)\s+(?:column\s+)?(${NAME})\s+([\s\S]+)$`).exec(
      text,
    );
    if (!alter) continue;
    const column = unquote(alter[1]!);
    const what = alter[2]!.trim();
    const a: SqlAlter = { op: "alter-column", table, column, line };
    const type = /^(?:set\s+data\s+)?type\s+([\s\S]+)$/i.exec(what);
    if (type) {
      const tm = TYPE_RE.exec(type[1]!.trim());
      if (!tm) continue;
      a.type = normType(tm[1]!);
    } else if (/^set\s+not\s+null\b/i.test(what)) a.nullable = false;
    else if (/^drop\s+not\s+null\b/i.test(what)) a.nullable = true;
    else if (/^drop\s+default\b/i.test(what)) a.dropDefault = true;
    else if (/^set\s+default\s/i.test(what)) {
      const def = DEFAULT_RE.exec(what);
      if (!def) continue;
      a.default = def[1]!;
    } else if (/^(?:set|drop|add|reset)\b/i.test(what)) continue;
    else {
      const col = parseColumn(`${column} ${what}`, line);
      if (!col) continue;
      a.definition = col;
    }
    op(a, `alter column ${column}`);
  }
}

export function parseDdl(source: string): SqlDdl {
  const sql = stripComments(source);
  const tables: SqlTable[] = [];
  const indexes: SqlIndex[] = [];
  const operations: string[] = [];
  const alters: SqlAlter[] = [];
  const drops: SqlDrop[] = [];

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
      const col = parseColumn(text, line);
      if (!col) continue;
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

  const alterRe = /alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?([\w."`[\]]+)\s+/gi;
  for (const m of sql.matchAll(alterRe))
    parseAlterActions(
      unquote(m[1]!.split(".").pop()!),
      sql,
      m.index! + m[0].length,
      alters,
      operations,
    );
  const dropRe = /drop\s+(table|index)\s+(?:concurrently\s+)?(?:if\s+exists\s+)?([\w."`]+)/gi;
  for (const m of sql.matchAll(dropRe)) {
    const kind = m[1]!.toLowerCase() as SqlDrop["kind"];
    const name = unquote(m[2]!.split(".").pop()!);
    drops.push({ kind, name, line: lineAt(sql, m.index!) });
    operations.push(`drop ${kind} ${name}`);
  }
  return { tables, indexes, alters, drops, operations };
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
  // An UPDATE after DO (PostgreSQL ON CONFLICT), KEY (MySQL ON DUPLICATE KEY) or FOR (a locking
  // read) names no table: the upsert's table is its INSERT's.
  for (const m of q.matchAll(
    /\b(?:insert\s+into|(?<!\b(?:do|key|for)\s+)update|merge\s+into)\s+([\w."`]+)/gi,
  ))
    if (!/^set$/i.test(m[1]!)) add(m[1]!, "write");
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
