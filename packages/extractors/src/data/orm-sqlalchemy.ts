import type { RepoHandle } from "@maycombhq/sdk";
import { isTestOrBuildPath } from "./common.js";
import type { OrmColumn, OrmModel, OrmTable } from "./orm-model.js";

/**
 * SQLAlchemy declarative models in Python: classes with __tablename__, whose attributes are
 * Column(...), db.Column(...), mapped_column(...) or a bare Mapped[...] annotation (2.0 style).
 * A type in the call wins; otherwise the Mapped[...] type is used, and Optional[...] or
 * "| None" makes the column nullable.
 *
 * Indexes: index=True gets SQLAlchemy's default name ix_<table>_<column>; Index(...) and
 * UniqueConstraint(...) in __table_args__ need a name. Out of scope: classic Table(...)
 * definitions, mixins and inherited columns, and Alembic migration scripts.
 */

interface Stmt {
  text: string;
  line: number;
  indent: number;
}

/** Logical statements: physical lines joined while brackets are open. */
function statements(src: string): Stmt[] {
  const out: Stmt[] = [];
  const lines = src.split(/\r?\n/);
  let cur: Stmt | undefined;
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const noComment = raw.replace(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|#.*$/g, (m, s) => s ?? "");
    if (!cur) {
      if (noComment.trim() === "") continue;
      cur = { text: noComment.trim(), line: i + 1, indent: raw.length - raw.trimStart().length };
    } else cur.text += " " + noComment.trim();
    for (const ch of noComment.replace(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g, "")) {
      if ("([{".includes(ch)) depth++;
      if (")]}".includes(ch)) depth--;
    }
    if (depth <= 0) {
      out.push(cur);
      cur = undefined;
      depth = 0;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Split call arguments at top-level commas. */
function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  let quote: string | undefined;
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = undefined;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    if (!quote && depth === 0 && ch === ",") {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** The argument text of the first call to one of `names` in s, e.g. Column( ... ). */
function callArgs(s: string, names: RegExp): string | undefined {
  const m = names.exec(s);
  if (!m) return undefined;
  let depth = 0;
  const start = m.index + m[0].length - 1;
  for (let i = start; i < s.length; i++) {
    if (s[i] === "(") depth++;
    if (s[i] === ")" && --depth === 0) return s.slice(start + 1, i);
  }
  return s.slice(start + 1);
}

const unquote = (s: string) => /^[rbuf]?["']([\s\S]*)["']$/.exec(s.trim())?.[1];
const kw = (args: string[], key: string) =>
  args.find((a) => new RegExp(`^${key}\\s*=`).test(a))?.replace(/^\w+\s*=\s*/, "");
const stripModule = (t: string) => t.replace(/^(?:sa|db|sqlalchemy|types|sqltypes)\./, "");

/** Mapped[Optional[str]] → { type: "str", optional: true }. */
function mappedType(annotation: string): { type: string; optional: boolean } | undefined {
  const m = /^Mapped\[(.*)\]$/.exec(annotation.trim());
  if (!m) return undefined;
  let t = m[1]!.trim();
  let optional = false;
  const opt = /^(?:typing\.)?Optional\[(.*)\]$/.exec(t);
  if (opt) {
    t = opt[1]!.trim();
    optional = true;
  }
  const union = t.split("|").map((x) => x.trim());
  if (union.length > 1 && union.includes("None")) {
    optional = true;
    t = union.filter((x) => x !== "None").join(" | ");
  }
  return { type: stripModule(t.replace(/^["']|["']$/g, "")), optional };
}

export async function readSqlAlchemy(repo: RepoHandle): Promise<OrmModel> {
  const tables: OrmTable[] = [];
  for await (const path of repo.listFiles(["**/*.py"])) {
    if (isTestOrBuildPath(path) || /(^|\/)(alembic|migrations)\/versions\//.test(path)) continue;
    const src = await repo.readText(path);
    if (!src.includes("__tablename__")) continue;
    const stmts = statements(src);
    for (let i = 0; i < stmts.length; i++) {
      const head = /^class\s+(\w+)\s*(?:\(.*\))?\s*:$/.exec(stmts[i]!.text);
      if (!head) continue;
      const classIndent = stmts[i]!.indent;
      const body: Stmt[] = [];
      let j = i + 1;
      for (; j < stmts.length && stmts[j]!.indent > classIndent; j++) body.push(stmts[j]!);
      const memberIndent = body[0]?.indent;
      const members = body.filter((s) => s.indent === memberIndent);
      const nameStmt = members.find((s) => /^__tablename__\s*=/.test(s.text));
      const name = nameStmt
        ? unquote(nameStmt.text.replace(/^__tablename__\s*=\s*/, ""))
        : undefined;
      if (!name) continue;
      const table: OrmTable = {
        name,
        tableKind: "table",
        path,
        line: stmts[i]!.line,
        columns: [],
        foreignKeys: [],
        indexes: [],
      };
      const pk: string[] = [];
      let pkLine: number | undefined;
      for (const s of members) {
        const m = /^(\w+)\s*(?::\s*([^=]+?))?\s*(?:=\s*([\s\S]+))?$/.exec(s.text);
        if (!m || m[1]!.startsWith("__")) continue;
        const attr = m[1]!;
        const mapped = m[2] ? mappedType(m[2]) : undefined;
        const value = m[3]?.trim();
        const argText = value
          ? callArgs(value, /^(?:\w+\.)?(?:Column|mapped_column)\s*\(/)
          : mapped
            ? ""
            : undefined;
        if (argText === undefined) continue;
        const args = splitArgs(argText);
        const positional = args.filter((a) => !/^\w+\s*=/.test(a));
        const colName =
          unquote(positional.find((a) => unquote(a) !== undefined) ?? "") ??
          unquote(kw(args, "name") ?? "") ??
          attr;
        const fkArg = positional.find((a) => /^(?:\w+\.)?ForeignKey\s*\(/.test(a));
        const typeArg = positional.find((a) => unquote(a) === undefined && a !== fkArg);
        const type = typeArg ? stripModule(typeArg) : mapped?.type;
        if (!type) continue;
        const isPk = kw(args, "primary_key") === "True";
        const nullableKw = kw(args, "nullable");
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
          type: type.replace(/\s+/g, " "),
          ...(nullable !== undefined ? { nullable } : {}),
          path,
          line: s.line,
        };
        table.columns.push(col);
        if (isPk) {
          pk.push(colName);
          pkLine ??= s.line;
        }
        if (kw(args, "index") === "True")
          table.indexes.push({
            name: `ix_${name}_${colName}`,
            columns: [colName],
            unique: kw(args, "unique") === "True",
            path,
            line: s.line,
          });
        if (fkArg) {
          const target = unquote(splitArgs(callArgs(fkArg, /ForeignKey\s*\(/) ?? "")[0] ?? "");
          const parts = target?.split(".") ?? [];
          if (parts.length >= 2)
            table.foreignKeys.push({
              columns: [colName],
              refTable: parts.at(-2)!,
              refColumns: [parts.at(-1)!],
              path,
              line: s.line,
            });
        }
      }
      if (pk.length > 0) table.primaryKey = { path, line: pkLine!, columns: pk };
      const argsStmt = members.find((s) => /^__table_args__\s*=/.test(s.text));
      if (argsStmt) {
        const srcLines = src.split(/\r?\n/);
        for (const call of argsStmt.text.matchAll(/\b(Index|UniqueConstraint)\s*\(/g)) {
          const inner =
            callArgs(argsStmt.text.slice(call.index), /^(?:Index|UniqueConstraint)\s*\(/) ?? "";
          const a = splitArgs(inner);
          const strs = a.filter((x) => !/^\w+\s*=/.test(x)).map((x) => unquote(x));
          const ixName = call[1] === "Index" ? strs[0] : unquote(kw(a, "name") ?? "");
          const cols = (call[1] === "Index" ? strs.slice(1) : strs).filter((x): x is string => !!x);
          if (!ixName || cols.length === 0) continue;
          // The line of the call inside the multi-line statement.
          let line = argsStmt.line;
          for (let k = argsStmt.line - 1; k < srcLines.length; k++)
            if (srcLines[k]!.includes(`${call[1]}(`) && srcLines[k]!.includes(ixName)) {
              line = k + 1;
              break;
            }
          table.indexes.push({
            name: ixName,
            columns: cols,
            unique: call[1] === "UniqueConstraint" || kw(a, "unique") === "True",
            path,
            line,
          });
        }
      }
      tables.push(table);
      i = j - 1;
    }
  }
  return { tables };
}
