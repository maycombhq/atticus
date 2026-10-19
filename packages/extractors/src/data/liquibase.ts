import type { RepoHandle } from "@maycombhq/sdk";
import { parse } from "yaml";
import { parseXml, type XmlElement } from "../lang/xml.js";

/**
 * Liquibase change sets as the SQL DDL they stand for, so the migration replay that reads
 * Flyway reads Liquibase too. Formatted SQL changelogs (`--liquibase formatted sql`,
 * `--changeset author:id`) are SQL already; XML and YAML change sets are turned into DDL for
 * createTable, addColumn, dropColumn, renameColumn, renameTable, createIndex, dropIndex,
 * dropTable, addPrimaryKey and raw `sql`. Changes it doesn't know are left out (a gap, not a
 * guess). Order: the master changelog's includes when there is one, else path order.
 */
export interface ChangeSet {
  file: string;
  id: string;
  line: number;
  sql: string;
}

export const LIQUIBASE_CLAIMS = [
  "**/db/changelog/**/*.xml",
  "**/db/changelog/**/*.yaml",
  "**/db/changelog/**/*.yml",
  "**/db/changelog/**/*.sql",
  "**/liquibase/**/*.xml",
  "**/liquibase/**/*.yaml",
  "**/liquibase/**/*.yml",
  "**/liquibase/**/*.sql",
];

type Change = Record<string, unknown>;

const q = (s: unknown) => String(s ?? "").trim();
const columnDef = (c: Change): string => {
  const cons = (c.constraints ?? {}) as Change;
  const parts = [q(c.name), q(c.type)];
  if (cons.nullable === false || cons.nullable === "false") parts.push("NOT NULL");
  if (cons.primaryKey === true || cons.primaryKey === "true") parts.push("PRIMARY KEY");
  if (cons.unique === true || cons.unique === "true") parts.push("UNIQUE");
  if (c.defaultValue !== undefined) parts.push(`DEFAULT '${q(c.defaultValue)}'`);
  return parts.filter(Boolean).join(" ");
};
const columnsOf = (ch: Change): Change[] =>
  ((ch.columns as unknown[]) ?? []).map((x) => ((x as Change).column ?? x) as Change);

/** One change (as YAML gives it, or as XML is read into the same shape) as DDL. */
function ddlOf(kind: string, ch: Change): string | undefined {
  const t = q(ch.tableName);
  switch (kind) {
    case "createTable":
      return `CREATE TABLE ${t} (${columnsOf(ch).map(columnDef).join(", ")});`;
    case "addColumn":
      return columnsOf(ch)
        .map((c) => `ALTER TABLE ${t} ADD COLUMN ${columnDef(c)};`)
        .join("\n");
    case "dropColumn":
      return `ALTER TABLE ${t} DROP COLUMN ${q(ch.columnName)};`;
    case "renameColumn":
      return `ALTER TABLE ${t} RENAME COLUMN ${q(ch.oldColumnName)} TO ${q(ch.newColumnName)};`;
    case "renameTable":
      return `ALTER TABLE ${q(ch.oldTableName)} RENAME TO ${q(ch.newTableName)};`;
    case "createIndex":
      return `CREATE ${ch.unique === true || ch.unique === "true" ? "UNIQUE " : ""}INDEX ${q(ch.indexName)} ON ${t} (${columnsOf(
        ch,
      )
        .map((c) => q(c.name))
        .join(", ")});`;
    case "dropIndex":
      return `DROP INDEX ${q(ch.indexName)};`;
    case "dropTable":
      return `DROP TABLE ${t};`;
    case "addPrimaryKey":
      return `ALTER TABLE ${t} ADD PRIMARY KEY (${q(ch.columnNames)});`;
    case "sql":
      return q(ch.sql ?? ch.text ?? ch);
    default:
      return undefined;
  }
}

/** An XML change element in the YAML shape: attributes, <column> children, text for sql. */
function fromXml(e: XmlElement): Change {
  const ch: Change = { ...e.attrs };
  const cols = e.children.filter((c) => c.name === "column");
  if (cols.length)
    ch.columns = cols.map((c) => {
      const cons = c.children.find((x) => x.name === "constraints");
      return { ...c.attrs, ...(cons ? { constraints: { ...cons.attrs } } : {}) };
    });
  if (e.name === "sql") ch.sql = e.text;
  return ch;
}

function fromXmlFile(file: string, text: string): ChangeSet[] {
  const doc = parseXml(text);
  // parseXml gives the root element.
  const root =
    doc?.name === "databaseChangeLog"
      ? doc
      : doc?.children.find((c) => c.name === "databaseChangeLog");
  if (!root) return [];
  return root.children
    .filter((c) => c.name === "changeSet")
    .map((cs) => ({
      file,
      id: cs.attrs.id ?? String(cs.line),
      line: cs.line,
      sql: cs.children
        .flatMap((c) => {
          const d = ddlOf(c.name, fromXml(c));
          return d ? [d] : [];
        })
        .join("\n"),
    }));
}

function fromYamlFile(file: string, text: string): ChangeSet[] {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch {
    return [];
  }
  const log = (doc as { databaseChangeLog?: unknown[] } | null)?.databaseChangeLog;
  if (!Array.isArray(log)) return [];
  const lines = text.split(/\r?\n/);
  return log.flatMap((entry) => {
    const cs = (entry as { changeSet?: Change }).changeSet;
    if (!cs) return [];
    const id = q(cs.id);
    const line = lines.findIndex((l) => new RegExp(`^\\s*id:\\s*["']?${id}["']?\\s*$`).test(l)) + 1;
    const sql = ((cs.changes as unknown[]) ?? [])
      .flatMap((c) =>
        Object.entries(c as Change).flatMap(([kind, body]) => {
          const d = ddlOf(kind, (body ?? {}) as Change);
          return d ? [d] : [];
        }),
      )
      .join("\n");
    return [{ file, id, line: line || 1, sql }];
  });
}

function fromFormattedSql(file: string, text: string): ChangeSet[] {
  if (!/^\s*--\s*liquibase formatted sql/i.test(text)) return [];
  const out: ChangeSet[] = [];
  const lines = text.split(/\r?\n/);
  let cur: ChangeSet | undefined;
  lines.forEach((l, i) => {
    const m = /^\s*--\s*changeset\s+[^:\s]+:(\S+)/i.exec(l);
    if (m) {
      if (cur) out.push(cur);
      cur = { file, id: m[1]!, line: i + 1, sql: "" };
    } else if (cur && !/^\s*--\s*(rollback|comment|preconditions)/i.test(l)) cur.sql += `${l}\n`;
  });
  if (cur) out.push(cur);
  return out;
}

/** Every Liquibase change set in a repo, in the order Liquibase would apply them. */
export async function liquibaseChangeSets(repo: RepoHandle): Promise<ChangeSet[]> {
  const files: string[] = [];
  for await (const p of repo.listFiles(LIQUIBASE_CLAIMS)) if (!/\/test\//.test(p)) files.push(p);
  if (files.length === 0) return [];
  const texts = new Map<string, string>();
  for (const f of files) texts.set(f, await repo.readText(f));
  // A master changelog: one whose entries are includes. It decides the order.
  const included: string[] = [];
  const masters = new Set<string>();
  for (const f of files.sort()) {
    const t = texts.get(f)!;
    const refs = [
      ...t.matchAll(/(?:^|\n)\s*-\s*include:\s*\n\s*file:\s*["']?([^"'\n]+)["']?/g),
      ...t.matchAll(/<include\s+[^>]*file\s*=\s*"([^"]+)"/g),
    ].map((m) => m[1]!.trim());
    if (refs.length === 0) continue;
    masters.add(f);
    for (const r of refs) {
      const hit = files.find(
        (x) => x === r || x.endsWith(`/${r}`) || x.endsWith(`/${r.replace(/^.*\//, "")}`),
      );
      if (hit && !included.includes(hit)) included.push(hit);
    }
  }
  const order = [
    ...included,
    ...files.filter((f) => !included.includes(f) && !masters.has(f)).sort(),
  ];
  return order.flatMap((f) => {
    const t = texts.get(f)!;
    if (f.endsWith(".xml")) return fromXmlFile(f, t);
    if (f.endsWith(".sql")) return fromFormattedSql(f, t);
    return fromYamlFile(f, t);
  });
}
