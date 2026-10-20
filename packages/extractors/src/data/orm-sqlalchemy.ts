import type { RepoHandle } from "@maycombhq/sdk";
import {
  callOf,
  callsIn,
  descendants,
  kids,
  lineOf,
  stringValue,
  withTree,
  type CodeCall,
  type Node,
} from "../lang/code-tree.js";
import { at } from "../lang/parsed.js";
import { isTestOrBuildPath } from "./common.js";
import type { OrmColumn, OrmModel, OrmTable } from "./orm-model.js";

/**
 * SQLAlchemy declarative models in Python, read from the syntax tree (ADR 0060): classes with
 * __tablename__, whose attributes are Column(...), db.Column(...), mapped_column(...) or a bare
 * Mapped[...] annotation (2.0 style). A type in the call wins; otherwise the Mapped[...] type
 * is used, and Optional[...] or "| None" makes the column nullable.
 *
 * Indexes: index=True gets SQLAlchemy's default name ix_<table>_<column>; Index(...) and
 * UniqueConstraint(...) in __table_args__ need a name. Out of scope: classic Table(...)
 * definitions, mixins and inherited columns, and Alembic migration scripts.
 */

/** Text as written, comments left out and runs of whitespace made one space. */
function written(n: Node): string {
  let out = "";
  let at = n.startIndex;
  const src = n.text;
  const skip = (x: Node) => {
    if (x.type === "comment") {
      out += src.slice(at - n.startIndex, x.startIndex - n.startIndex);
      at = x.endIndex;
    } else for (const c of x.children) skip(c);
  };
  skip(n);
  out += src.slice(at - n.startIndex);
  return out.replace(/\s+/g, " ").trim();
}

const stripModule = (t: string) => t.replace(/^(?:sa|db|sqlalchemy|types|sqltypes)\./, "");

/** The last name of a call's callee, when it is a plain name or one attribute: `Column`, `sa.Column`. */
const calleeIs = (c: CodeCall | undefined, ...names: string[]) =>
  !!c && !!c.path && c.path.length <= 2 && names.includes(c.name);

/** Mapped[Optional[str]] → { type: "str", optional: true }. */
function mappedType(t: Node): { type: string; optional: boolean } | undefined {
  const g = t.type === "type" ? kids(t)[0] : t;
  if (g?.type !== "generic_type" || kids(g)[0]?.text !== "Mapped") return undefined;
  let inner = kids(kids(kids(g).find((c) => c.type === "type_parameter"))[0])[0];
  if (!inner) return undefined;
  let optional = false;
  if (inner.type === "generic_type" && /^(typing\.)?Optional$/.test(kids(inner)[0]?.text ?? "")) {
    const arg = kids(kids(kids(inner).find((c) => c.type === "type_parameter"))[0])[0];
    if (arg) {
      inner = arg;
      optional = true;
    }
  }
  // str | None
  const union: Node[] = [];
  const flat = (x: Node) => {
    if (x.type === "binary_operator" && x.child(1)?.text === "|") {
      flat(x.childForFieldName("left")!);
      flat(x.childForFieldName("right")!);
    } else union.push(x);
  };
  flat(inner);
  let type = written(inner);
  if (union.length > 1 && union.some((u) => u.type === "none")) {
    optional = true;
    type = union
      .filter((u) => u.type !== "none")
      .map(written)
      .join(" | ");
  }
  return { type: stripModule(stringValue(inner) ?? type), optional };
}

function readTable(cls: Node, path: string): OrmTable | undefined {
  const members = kids(cls.childForFieldName("body"))
    .filter((s) => s.type === "expression_statement")
    .map((s) => ({ stmt: s, a: kids(s)[0] }))
    .filter((x): x is { stmt: Node; a: Node } => x.a?.type === "assignment");
  const left = (a: Node) => a.childForFieldName("left");
  const nameStmt = members.find((m) => left(m.a)?.text === "__tablename__");
  const name = nameStmt ? stringValue(nameStmt.a.childForFieldName("right")) : undefined;
  if (!name) return undefined;
  const table: OrmTable = {
    name,
    tableKind: "table",
    path,
    line: lineOf(cls),
    columns: [],
    foreignKeys: [],
    indexes: [],
  };
  const pk: string[] = [];
  let pkLine: number | undefined;
  for (const { stmt, a } of members) {
    const target = left(a);
    if (target?.type !== "identifier" || target.text.startsWith("__")) continue;
    const attr = target.text;
    const typeNode = a.childForFieldName("type");
    const mapped = typeNode ? mappedType(typeNode) : undefined;
    const value = a.childForFieldName("right");
    const call = value ? callOf(value) : undefined;
    if (value && !calleeIs(call, "Column", "mapped_column")) continue;
    if (!value && !mapped) continue;
    const positional = call?.args ?? [];
    const kw = (k: string) => {
      const v = call?.kwargs.get(k);
      return v ? written(v) : undefined;
    };
    const line = lineOf(stmt);
    const colName =
      positional.map((p) => stringValue(p)).find((s) => s !== undefined) ??
      stringValue(call?.kwargs.get("name")) ??
      attr;
    const fkArg = positional.find((p) => calleeIs(callOf(p), "ForeignKey"));
    const typeArg = positional.find((p) => stringValue(p) === undefined && p !== fkArg);
    const type = typeArg ? stripModule(written(typeArg)) : mapped?.type;
    if (!type) continue;
    const isPk = kw("primary_key") === "True";
    const nullableKw = kw("nullable");
    const nullable =
      nullableKw === "False" || isPk
        ? false
        : nullableKw === "True"
          ? true
          : mapped
            ? mapped.optional
            : undefined;
    const col: OrmColumn = {
      name: colName,
      type,
      ...(nullable !== undefined ? { nullable } : {}),
      path,
      line,
    };
    table.columns.push(col);
    if (isPk) {
      pk.push(colName);
      pkLine ??= line;
    }
    if (kw("index") === "True")
      table.indexes.push({
        name: `ix_${name}_${colName}`,
        columns: [colName],
        unique: kw("unique") === "True",
        path,
        line,
      });
    if (fkArg) {
      const parts = stringValue(callOf(fkArg)!.args[0])?.split(".") ?? [];
      if (parts.length >= 2)
        table.foreignKeys.push({
          columns: [colName],
          refTable: parts.at(-2)!,
          refColumns: [parts.at(-1)!],
          path,
          line,
        });
    }
  }
  if (pk.length > 0) table.primaryKey = { path, line: pkLine!, columns: pk };
  const args = members.find((m) => left(m.a)?.text === "__table_args__");
  for (const c of args ? callsIn(args.a) : []) {
    if (c.name !== "Index" && c.name !== "UniqueConstraint") continue;
    const strs = c.args.map((x) => stringValue(x));
    const ixName = c.name === "Index" ? strs[0] : stringValue(c.kwargs.get("name"));
    const cols = (c.name === "Index" ? strs.slice(1) : strs).filter((x): x is string => !!x);
    if (!ixName || cols.length === 0) continue;
    table.indexes.push({
      name: ixName,
      columns: cols,
      unique: c.name === "UniqueConstraint" || c.kwargs.get("unique")?.text === "True",
      path,
      line: c.line,
    });
  }
  return table;
}

export async function readSqlAlchemy(repo: RepoHandle): Promise<OrmModel> {
  const tables: OrmTable[] = [];
  for await (const path of repo.listFiles(["**/*.py"])) {
    if (isTestOrBuildPath(path) || /(^|\/)(alembic|migrations)\/versions\//.test(path)) continue;
    const src = await repo.readText(path);
    if (!src.includes("__tablename__")) continue;
    await withTree(
      "python",
      src,
      (root) => {
        // A mapped class's own nested classes are not tables of their own.
        const inside: Node[] = [];
        for (const n of descendants(root)) {
          if (n.type !== "class_definition") continue;
          if (inside.some((o) => n.startIndex >= o.startIndex && n.endIndex <= o.endIndex))
            continue;
          const t = readTable(n, path);
          if (t) {
            tables.push(t);
            inside.push(n);
          }
        }
      },
      at(repo, path),
    );
  }
  return { tables };
}
