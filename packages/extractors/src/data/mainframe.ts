import { normalizePath, type CatalogRecord } from "@maycombhq/core";
import { defineExtractor, type RepoHandle, type ScanContext } from "@maycombhq/sdk";
import { componentOf, evidence, looseEnd } from "../facts.js";
import { slug } from "./common.js";

/**
 * Mainframe sources, kept modest and deterministic:
 *
 * JCL. Each `EXEC PGM=` step is an Endpoint of type batch-job (C1's closest fit for a job
 * step), id <component>.batch-job.<job>.<step>, pathOrTopic JOB.STEP.PROGRAM. Each dataset a
 * step names is a db-access loose end for the component: DISP=SHR reads; NEW, MOD and OLD
 * (exclusive, normally to update) write; no DISP means NEW. Temporary (&&) datasets, SYSOUT,
 * DUMMY, referbacks and load libraries (JOBLIB, STEPLIB) are skipped; GDG generations are
 * dropped from the name. Catalogued procedures (EXEC <proc>) are not expanded: a warning says so.
 *
 * COBOL copybooks. One Schema (format other) per 01-level record, or per member when there is
 * no 01 level, with each elementary item (one with a PIC) as a field typed by its PIC, usage and
 * OCCURS. Group items, FILLER, 66 and 88 levels are not fields. Fixed format (sequence area,
 * indicator column, columns 8-72) and free format are both read.
 *
 * CICS resource definitions (CSD extract text, DEFINE ...). A TRANSACTION is an Endpoint of type
 * `transaction` (ADR 0040) with the transaction id as pathOrTopic; it keeps the id it had as a
 * Setting before (<component>.cics.transaction.<id>). C1 has no field for the program it runs,
 * which is the component's own code, so the program is not recorded. A URIMAP with
 * USAGE(SERVER) is an HTTP entry point, so a REST Endpoint (no method: a URIMAP matches any);
 * USAGE(CLIENT) is an outbound HTTP call. Web service pipelines, MQ triggers, BMS maps and the
 * COBOL programs themselves (CALL, EXEC SQL, EXEC CICS) are out of scope.
 */

const JCL_SKIP_DD = new Set([
  "JOBLIB",
  "STEPLIB",
  "SYSPRINT",
  "SYSOUT",
  "SYSUDUMP",
  "SYSABEND",
  "SYSMDUMP",
]);

/** Split operands at top-level commas, outside quotes and parentheses. */
function splitOperands(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = false;
  let cur = "";
  for (const ch of s) {
    if (ch === "'") quote = !quote;
    else if (!quote && ch === "(") depth++;
    else if (!quote && ch === ")") depth--;
    if (!quote && depth === 0 && ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** The operand field: up to the first blank outside quotes (the rest of the line is a comment). */
function operandField(s: string): string {
  let quote = false;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "'") quote = !quote;
    else if (!quote && ch === "(") depth++;
    else if (!quote && ch === ")") depth--;
    else if (!quote && depth === 0 && ch === " ") return s.slice(0, i);
  }
  return s;
}

interface JclStmt {
  name: string;
  op: string;
  operands: string;
  line: number;
}

function jclStatements(text: string): JclStmt[] {
  const out: JclStmt[] = [];
  let cur: JclStmt | undefined;
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.slice(0, 72);
    if (!line.startsWith("//") || line.startsWith("//*")) {
      cur = undefined;
      return;
    }
    if (cur && cur.operands.endsWith(",") && /^\/\/\s/.test(line)) {
      cur.operands += operandField(line.slice(2).trim());
      return;
    }
    const m = /^\/\/(\S*)\s+(\S+)\s*(.*)$/.exec(line);
    if (!m) {
      cur = undefined;
      return;
    }
    cur = {
      name: m[1]!,
      op: m[2]!.toUpperCase(),
      operands: operandField(m[3]!.trim()),
      line: i + 1,
    };
    out.push(cur);
  });
  return out;
}

function* jcl(
  repo: RepoHandle,
  ctx: ScanContext,
  path: string,
  text: string,
): Generator<CatalogRecord> {
  const component = componentOf(repo, ctx);
  let job = "";
  let step = "";
  let n = 0;
  for (const s of jclStatements(text)) {
    const ops = splitOperands(s.operands);
    const kv = (k: string) =>
      ops.find((o) => o.toUpperCase().startsWith(`${k}=`))?.slice(k.length + 1);
    if (s.op === "JOB") {
      job = s.name;
      n = 0;
    } else if (s.op === "EXEC") {
      n++;
      step = s.name || `STEP${n}`;
      const pgm = kv("PGM");
      if (!pgm) {
        const proc = kv("PROC") ?? ops[0]?.split("=")[0];
        ctx.warn(`step ${step} runs procedure ${proc ?? "?"}, which is not expanded`, path);
        step = "";
        continue;
      }
      yield {
        schemaVersion: 1,
        kind: "Endpoint",
        id: `${component}.batch-job.${slug(job || "job")}.${slug(step)}`,
        status: "current",
        confidence: "verified",
        component,
        endpointType: "batch-job",
        pathOrTopic: `${job || "JOB"}.${step}.${pgm}`,
        schemaRefs: [],
        evidence: [evidence(repo, { source: "code", path, line: s.line, side: "definition" })],
      } as unknown as CatalogRecord;
    } else if (s.op === "DD") {
      if (JCL_SKIP_DD.has(s.name.toUpperCase()) || !step) continue;
      const dsn = kv("DSN") ?? kv("DSNAME");
      if (!dsn || dsn.startsWith("&") || dsn.startsWith("*.")) continue;
      if (ops.some((o) => /^(SYSOUT=|DUMMY$)/i.test(o))) continue;
      const disp = (kv("DISP") ?? "NEW").replace(/^\(/, "").split(",")[0]!.toUpperCase() || "NEW";
      const name = dsn.replace(/\([+-]?\d+\)$/, "");
      yield looseEnd(repo, ctx, "db-access", `${disp === "SHR" ? "read" : "write"} ${name}`, {
        source: "code",
        path,
        line: s.line,
        side: "caller",
      });
    }
  }
}

interface CobolEntry {
  level: number;
  name?: string;
  words: string[];
  line: number;
}

/** Copybook entries (level, name, clauses), read from fixed or free format source. */
function cobolEntries(text: string): CobolEntry[] {
  const words: { w: string; line: number }[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    let code: string;
    if (/^[\d ]{6}/.test(raw) && raw.length > 6) {
      const indicator = raw[6];
      if (indicator === "*" || indicator === "/") return;
      code = raw.slice(7, 72);
    } else code = raw;
    if (/^\s*\*>/.test(code)) return;
    code = code.replace(/\*>.*$/, "");
    for (const m of code.matchAll(/'[^']*'|"[^"]*"|\S+/g)) words.push({ w: m[0], line: i + 1 });
  });
  const out: CobolEntry[] = [];
  let cur: CobolEntry | undefined;
  for (const { w, line } of words) {
    if (!cur) {
      if (!/^\d{1,2}$/.test(w)) continue;
      cur = { level: Number(w), words: [], line };
      continue;
    }
    const end = w.endsWith(".");
    const word = end ? w.slice(0, -1) : w;
    if (word) {
      if (cur.name === undefined && cur.words.length === 0 && !CLAUSE_WORDS.test(word))
        cur.name = word;
      else cur.words.push(word);
    }
    if (end) {
      out.push(cur);
      cur = undefined;
    }
  }
  return out;
}

const CLAUSE_WORDS =
  /^(PIC|PICTURE|USAGE|VALUE|VALUES|OCCURS|REDEFINES|COMP(-\d)?|COMPUTATIONAL(-\d)?|BINARY|PACKED-DECIMAL|DISPLAY|INDEX|POINTER|SIGN|SYNC|SYNCHRONIZED|JUST|JUSTIFIED|BLANK)$/i;

/** PIC, usage and OCCURS of an elementary item, or undefined for a group item. */
function cobolType(words: string[]): string | undefined {
  const up = words.map((w) => w.toUpperCase());
  const at = (k: string) => up.indexOf(k);
  let p = at("PIC") === -1 ? at("PICTURE") : at("PIC");
  if (p === -1) return undefined;
  if (up[p + 1] === "IS") p++;
  const pic = words[p + 1];
  if (!pic) return undefined;
  const usageWord = up.find((w) =>
    /^(COMP(-\d)?|COMPUTATIONAL(-\d)?|BINARY|PACKED-DECIMAL|INDEX|POINTER)$/.test(w),
  );
  const usage = usageWord?.replace(/^COMPUTATIONAL/, "COMP");
  const o = at("OCCURS");
  const occurs = o === -1 ? undefined : words[o + 1];
  return [pic, usage, occurs ? `OCCURS ${occurs}` : undefined].filter(Boolean).join(" ");
}

function* copybook(
  repo: RepoHandle,
  ctx: ScanContext,
  path: string,
  text: string,
): Generator<CatalogRecord> {
  const component = componentOf(repo, ctx);
  const member = path
    .split("/")
    .pop()!
    .replace(/\.[^.]+$/, "");
  const records: {
    name: string;
    ref: string;
    line: number;
    fields: { name: string; type: string }[];
  }[] = [];
  for (const e of cobolEntries(text)) {
    if (e.level === 66 || e.level === 77 || e.level === 88) continue;
    if (e.level === 1) {
      records.push({
        name: e.name ?? member,
        ref: `${path}#${e.name ?? member}`,
        line: e.line,
        fields: [],
      });
      continue;
    }
    if (records.length === 0) records.push({ name: member, ref: path, line: e.line, fields: [] });
    const type = cobolType(e.words);
    if (!type || !e.name || /^FILLER$/i.test(e.name)) continue;
    records.at(-1)!.fields.push({ name: e.name, type });
  }
  for (const r of records.filter((x) => x.fields.length > 0))
    yield {
      schemaVersion: 1,
      kind: "Schema",
      id: `${component}.copybook.${slug(r.name)}`,
      status: "current",
      confidence: "verified",
      format: "other",
      ref: r.ref,
      fields: r.fields,
      evidence: [evidence(repo, { source: "code", path, line: r.line })],
    } as unknown as CatalogRecord;
}

function* csd(
  repo: RepoHandle,
  ctx: ScanContext,
  path: string,
  text: string,
): Generator<CatalogRecord> {
  const component = componentOf(repo, ctx);
  const defs: { text: string; line: number }[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("*")) return;
    if (/^DEFINE\s/i.test(line)) defs.push({ text: line, line: i + 1 });
    else if (defs.length > 0) defs.at(-1)!.text += ` ${line}`;
  });
  for (const d of defs) {
    const kv = new Map<string, string>();
    let type: string | undefined;
    let name: string | undefined;
    for (const m of d.text.matchAll(/(\w+)\(([^)]*)\)/g)) {
      const k = m[1]!.toUpperCase();
      if (!type) {
        type = k;
        name = m[2]!.trim();
      } else if (!kv.has(k)) kv.set(k, m[2]!.trim());
    }
    if (!type || !name) continue;
    if (type === "TRANSACTION") {
      yield {
        schemaVersion: 1,
        kind: "Endpoint",
        id: `${component}.cics.transaction.${slug(name)}`,
        status: "current",
        confidence: "verified",
        component,
        endpointType: "transaction",
        pathOrTopic: name,
        schemaRefs: [],
        evidence: [evidence(repo, { source: "config", path, line: d.line, side: "definition" })],
      } as unknown as CatalogRecord;
    } else if (type === "URIMAP" && kv.get("PATH")) {
      const usage = (kv.get("USAGE") ?? "SERVER").toUpperCase();
      const p = kv.get("PATH")!.startsWith("/") ? kv.get("PATH")! : `/${kv.get("PATH")!}`;
      if (usage === "SERVER")
        yield {
          schemaVersion: 1,
          kind: "Endpoint",
          id: `${component}.urimap.${slug(name)}`,
          status: "current",
          confidence: "verified",
          component,
          endpointType: "rest",
          pathOrTopic: p,
          normalizedPath: normalizePath(p),
          schemaRefs: [],
          evidence: [evidence(repo, { source: "config", path, line: d.line, side: "definition" })],
        } as unknown as CatalogRecord;
      else if (usage === "CLIENT" && kv.get("HOST")) {
        const scheme = (kv.get("SCHEME") ?? "HTTP").toLowerCase();
        yield looseEnd(repo, ctx, "http-call", `ANY ${scheme}://${kv.get("HOST")}${p}`, {
          source: "config",
          path,
          line: d.line,
          side: "caller",
        });
      }
    }
  }
}

export const mainframeExtractor = defineExtractor({
  id: "mainframe",
  version: "1.1.0",
  claims: [
    "**/*.jcl",
    "**/*.JCL",
    "**/jcl/*",
    "**/JCL/*",
    "**/*.cpy",
    "**/*.CPY",
    "**/copybooks/*",
    "**/copybook/*",
    "**/copylib/*",
    "**/COPYLIB/*",
    "**/*.csd",
    "**/*.CSD",
    "**/csd/*",
    "**/CSD/*",
  ],
  async *scan(repo, ctx) {
    for await (const path of repo.listFiles(this.claims)) {
      const text = await repo.readText(path);
      if (/^\/\/\S*\s+JOB\b/m.test(text)) yield* jcl(repo, ctx, path, text);
      else if (/^\s*DEFINE\s+\w+\(/im.test(text)) yield* csd(repo, ctx, path, text);
      else if (/\.cpy$/i.test(path) || /(^|\/)(copybooks?|copylib)\//i.test(path))
        yield* copybook(repo, ctx, path, text);
    }
  },
});
