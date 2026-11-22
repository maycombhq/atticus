import { readdir, readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { isSeq, LineCounter, parseDocument } from "yaml";
import {
  CODE_TABLE_FILE,
  pairsOf,
  parseCodeTable,
  undoOf,
  type CodeRow,
  type CodeTable,
} from "@maycombhq/changes";
import { normalizePath, type Fact } from "@maycombhq/core";
import type { ConformCite, ConformItem } from "./conform.js";
import { OPERATIONS_FILE, readOperations } from "./stages/operations.js";
import { redactWords, type Operation } from "./stages/schema.js";

/**
 * ADR 0206: a change states what the code will have, and after the build each statement (a
 * claim) is looked for in the verified facts of the branch's commit. The staged path states its
 * claims as an operation's `sets` (`target-flows/_operations.yaml`, ADR 0203 B); the quick path
 * as the rows of design.md's "## In the code". Each claim gets one of five outcomes, cited to a
 * file and line: present, present differently, missing, not checkable, couldn't confirm.
 *
 * Rule 4 (ADR 0074, 0124): present comes from facts only, never from the built-in readers; only
 * facts that cover the commit with nothing unread say something is missing or different; a value
 * `atticus verify` doesn't check on the line (a deployment's platform and env) is said to be the
 * assistant's reading unless it is written on the cited lines. A secret's value is never read,
 * compared or said. Facts and files only, no model: the same inputs give the same answer.
 */

export type ClaimCheck =
  | "endpoint"
  | "listener"
  | "call"
  | "publish"
  | "table"
  | "column"
  | "migration"
  | "deployment"
  | "route"
  | "config"
  | "secret"
  | "pipeline"
  | "cut-over"
  | "other";

export type ClaimOutcome =
  "present" | "present-differently" | "missing" | "not-checkable" | "unconfirmed";

type Key =
  | "method"
  | "path"
  | "topic"
  | "target"
  | "table"
  | "column"
  | "file"
  | "platform"
  | "env"
  | "host"
  | "basePath"
  | "key"
  | "value";

/** Where a claim is stated: the file (change-folder-relative) and line. */
export interface ClaimFrom {
  file: string;
  line: number;
  /** The operation's id (the staged path). */
  operation?: string;
  /** The row's task (the quick path). */
  task?: string;
  /** The row's `<capability>: <Requirement name>`. */
  spec?: string;
}

export interface Claim {
  repo: string;
  check: ClaimCheck;
  expect: Partial<Record<Key, string>>;
  /** The operation's or the row's own words. */
  words: string;
  from: ClaimFrom;
  undo?: string;
  /** The operation's task label, `o<operation>.<repo>`, as tasks.md numbers it (ADR 0203). */
  label?: string;
}

export interface ClaimResult {
  outcome: ClaimOutcome;
  check: ClaimCheck;
  repo: string;
  from: ClaimFrom;
  /** What the claim says, in a few words: `platform anvil, env prod`. */
  expected: string;
  /** What the facts say instead, for present differently (and couldn't confirm, when known). */
  found?: string;
  /** One plain sentence. */
  what: string;
  /** The fact's file and line in the code; the claim's own line for what isn't there. */
  at: ConformCite[];
  /** How sure the cite is: what is written on the cited lines, what is the assistant's reading. */
  why?: string;
  /** What the person does next. */
  next: string;
  /** The fact it rests on. */
  fact?: string;
}

export interface ClaimsInput {
  change: string;
  /** The changes folder, relative to the metarepo (`openspec/changes`), for the words. */
  changesRel: string;
  repo: string;
  claims: readonly Claim[];
  before: readonly Fact[];
  after: readonly Fact[];
  /** Repo-relative files at the commit (`git ls-tree`). */
  files: readonly string[];
  /**
   * What the facts at the commit rest on: verified facts with the changed files no fact covers
   * yet, the built-in readers only, or nothing (a repo nobody read).
   */
  basis: { from: "facts"; unread: readonly string[] } | { from: "readers" } | { from: "none" };
  /** A file's line at the commit, for a value the verifier doesn't check on it. */
  lineAt?: (path: string, line: number) => string | undefined;
  /**
   * What the branch adds that no claim names is out of the design (ADR 0114's `unexpected`):
   * for a change whose whole design is its claims (a quick change, or operations only).
   */
  unexpected?: boolean;
}

// ------------------------------------------------------------------ reading the claims

/** The line of each operation's `- id:` in `_operations.yaml`. */
function operationLines(text: string): Map<string, number> {
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines });
  const out = new Map<string, number>();
  const ops = doc.get("operations", true);
  if (!isSeq(ops)) return out;
  for (const item of ops.items) {
    const range = (item as { range?: [number, number, number] }).range;
    const id = (item as { get?: (k: string) => unknown }).get?.("id");
    if (range && typeof id === "string") out.set(id, lines.linePos(range[0]).line);
  }
  return out;
}

const OPERATION_CHECK: Record<Operation["kind"], ClaimCheck> = {
  deployment: "deployment",
  pipeline: "pipeline",
  config: "config",
  secret: "secret",
  route: "route",
  "cut-over": "cut-over",
};

/** Each operation in each of its repos, as a claim (ADR 0206 point 2). */
export function operationClaims(ops: readonly Operation[], lines: Map<string, number>): Claim[] {
  return ops.flatMap((o, i) =>
    o.repos.map((repo, k) => ({
      repo,
      check: OPERATION_CHECK[o.kind],
      expect: { ...(o.sets ?? {}) },
      words: o.what,
      from: { file: OPERATIONS_FILE, line: lines.get(o.id) ?? 1, operation: o.id },
      ...(o.undo ? { undo: o.undo } : {}),
      label: `o${i + 1}.${k + 1}`,
    })),
  );
}

const ROW_CHECK: Record<string, ClaimCheck> = {
  serves: "endpoint",
  listens: "listener",
  calls: "call",
  publishes: "publish",
  table: "table",
  column: "column",
  migration: "migration",
  deployment: "deployment",
  route: "route",
  config: "config",
  secret: "secret",
  pipeline: "pipeline",
  "cut-over": "cut-over",
  other: "other",
};

/** A row's claim; undefined when its What doesn't read for its Has (the hand-off says why). */
function rowClaim(r: CodeRow): Claim | undefined {
  const check = ROW_CHECK[r.has];
  if (!check) return undefined;
  const from: ClaimFrom = {
    file: CODE_TABLE_FILE,
    line: r.line,
    ...(r.task ? { task: r.task.toLowerCase() } : {}),
    ...(r.spec ? { spec: r.spec } : {}),
  };
  const base = { repo: r.repo, check, words: r.what, from };
  const http = (s: string) => /^([A-Za-z]+)\s+(\/\S*)$/.exec(s.trim());
  switch (check) {
    case "endpoint": {
      const m = http(r.what);
      return m ? { ...base, expect: { method: m[1]!.toUpperCase(), path: m[2]! } } : undefined;
    }
    case "call": {
      const [target, ...rest] = r.what.split(/\s+/);
      const m = http(rest.join(" "));
      return m && target
        ? { ...base, expect: { target, method: m[1]!.toUpperCase(), path: m[2]! } }
        : undefined;
    }
    case "listener":
    case "publish":
      return { ...base, expect: { topic: r.what } };
    case "table":
      return { ...base, expect: { table: r.what } };
    case "column": {
      const at = r.what.lastIndexOf(".");
      return at > 0
        ? { ...base, expect: { table: r.what.slice(0, at), column: r.what.slice(at + 1) } }
        : undefined;
    }
    case "migration":
      return { ...base, expect: { file: r.what } };
    case "cut-over": {
      const undo = undoOf(r.what);
      return { ...base, expect: {}, ...(undo ? { undo } : {}) };
    }
    case "other":
      return { ...base, expect: {} };
    default: {
      const pairs = pairsOf(r.what);
      return pairs ? { ...base, expect: pairs } : undefined;
    }
  }
}

/** The claims of a quick change's table, in row order. */
export function tableClaims(t: CodeTable): Claim[] {
  return t.rows.flatMap((r) => rowClaim(r) ?? []);
}

/**
 * A change's claims: its operations (the staged path) and its design.md's "## In the code" (the
 * quick path), with what in them doesn't read. `table` says whether design.md has the table.
 */
export async function readClaims(
  changeDir: string,
): Promise<{ claims: Claim[]; problems: string[]; table: boolean; rows: number }> {
  const problems: string[] = [];
  const claims: Claim[] = [];
  const ops = await readOperations(changeDir);
  problems.push(...ops.problems);
  if (ops.file) {
    const text = await readFile(join(changeDir, ...OPERATIONS_FILE.split("/")), "utf8");
    claims.push(...operationClaims(ops.file.operations, operationLines(text)));
  }
  const design = await readFile(join(changeDir, CODE_TABLE_FILE), "utf8").catch(() => undefined);
  const t = design === undefined ? undefined : parseCodeTable(design);
  if (t) {
    for (const p of t.problems) problems.push(`${CODE_TABLE_FILE}:${p.line}: ${p.words}`);
    for (const r of t.rows)
      if (!rowClaim(r))
        problems.push(
          `${CODE_TABLE_FILE}:${r.line}: this row of ## In the code doesn't read, so it isn't checked: atticus change status names what to fix.`,
        );
    claims.push(...tableClaims(t));
  }
  return { claims, problems, table: !!t?.found, rows: t?.rows.length ?? 0 };
}

/** The repos of the claims, each once, sorted. */
export const claimRepos = (claims: readonly Claim[]): string[] =>
  [...new Set(claims.map((c) => c.repo))].sort();

// ------------------------------------------------------------------ the comparison

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/\{[^}]*\}/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const RULE_TAIL: Partial<Record<ClaimOutcome, string>> = {
  missing: "missing",
  "present-differently": "differs",
  "not-checkable": "not-checked",
};

/** The rule a claim's outcome makes a finding of; none for present and couldn't confirm. */
export const claimRule = (o: ClaimOutcome): string | undefined =>
  RULE_TAIL[o] ? `conform.${RULE_TAIL[o]}` : undefined;

/**
 * A claim's finding id: the same claim keeps its id while the file around it changes (an
 * operation by its id and repo, a row by its repo and what it says).
 */
export function claimFindingId(
  r: Pick<ClaimResult, "outcome" | "check" | "repo" | "from" | "expected">,
): string {
  const tail = RULE_TAIL[r.outcome] ?? r.outcome;
  const subject = r.from.operation ? `${r.from.operation}-${r.repo}` : `${r.repo}-${r.expected}`;
  return `conform-${tail}-${r.check}-${slug(subject)}`.slice(0, 120).replace(/-+$/, "");
}

const HTTP_CALLS = new Set(["rest", "grpc", "soap", "graphql", "webhook"]);
const TOPICS = new Set(["event-topic", "mq-queue"]);
const sentence = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);
const bare = (s: string) => s.replace(/[.\s]+$/, "");
const lastPart = (s: string) => s.split(".").pop() ?? s;
/**
 * Whether a value is written on a line as a word of its own (the review of ADR 0206): never as a
 * part of a longer one, so `anvil` isn't on `name: ledger-anvil`, `prod` isn't on `production`,
 * and `anvil.forge.example` isn't on `orders.anvil.forge.example`. Case is ignored.
 */
export function wordOn(line: string, value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  const esc = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?<![A-Za-z0-9_-]|[A-Za-z0-9_][./])${esc}(?![A-Za-z0-9_-]|[./][A-Za-z0-9_-])`,
    "i",
  ).test(line);
}
const same = (a: string | undefined, b: string | undefined) =>
  (a ?? "").toLowerCase() === (b ?? "").toLowerCase();
const shown = (xs: readonly string[]) =>
  xs.length > 3 ? `${xs.slice(0, 3).join(", ")} and ${xs.length - 3} more` : xs.join(", ");

type F<K extends Fact["kind"]> = Extract<Fact, { kind: K }>;

export function conformClaims(input: ClaimsInput): {
  claims: ClaimResult[];
  unexpected: ConformItem[];
} {
  const { repo, change } = input;
  const mine = (f: Fact) =>
    f.repo === repo || (f.kind === "deploy" && (f as F<"deploy">).exposes === repo);
  const after = input.after.filter(mine);
  const of = <K extends Fact["kind"]>(k: K) => after.filter((f): f is F<K> => f.kind === k);
  const basis = input.basis;
  const factsSay = basis.from === "facts";
  const decisive = basis.from === "facts" && basis.unread.length === 0;
  const matched = new Set<string>();
  const results: ClaimResult[] = [];

  const codeCite = (f: Fact): ConformCite => ({
    source: "code",
    repo: f.repo,
    path: f.cite.file,
    line: f.cite.line,
  });
  const claimCite = (c: Claim): ConformCite => ({
    source: "artifact",
    path: c.from.file,
    line: c.from.line,
  });
  const quick = (c: Claim) => c.from.file === CODE_TABLE_FILE;
  const conformCmd = `atticus change conform ${change}`;
  const branchFacts = `${input.changesRel}/${change}/conform/facts/${repo}.jsonl`;

  /** The cited line and its `with` parts' lines, at the commit. */
  const citedLines = (f: Fact): string[] =>
    input.lineAt
      ? [f.cite, ...(f.cite.with ?? [])].flatMap((p) => input.lineAt!(p.file, p.line) ?? [])
      : [];
  /** Which claimed values are written on the fact's cited lines, and which are its reading. */
  const writtenWhy = (f: Fact, values: [string, string | undefined][]): string | undefined => {
    if (!input.lineAt) return undefined;
    const lines = citedLines(f);
    const given = values.filter((v): v is [string, string] => !!v[1]);
    // The word itself on the line, never a part of a longer one (the review of ADR 0206).
    const on = given.filter(([, v]) => lines.some((l) => wordOn(l, v)));
    const off = given.filter((g) => !on.includes(g));
    const words = (xs: [string, string][]) => xs.map(([k, v]) => `${k} ${v}`).join(", ");
    return [
      on.length ? `Written on the cited lines: ${words(on)}.` : "",
      off.length ? `The assistant's reading of ${f.cite.file}:${f.cite.line}: ${words(off)}.` : "",
    ]
      .filter(Boolean)
      .join(" ");
  };

  const unreadWhy = () =>
    basis.from === "facts"
      ? `no fact covers ${shown(basis.unread)}, which changed since ${repo} was read`
      : basis.from === "readers"
        ? `${repo} hasn't been read into facts at this commit, and the built-in readers alone are only a cross-check`
        : `nobody has read ${repo} at this commit`;
  const unreadNext = () =>
    basis.from === "facts"
      ? `Have your assistant read ${shown(basis.unread)} in ${repo}'s branch into ${branchFacts} (facts at the branch's commit, each citing its file and line), then check again: ${conformCmd}. They are verified here and never written to the catalog.`
      : `Read ${repo} into facts (/atticus-map ${repo}, then atticus verify ${repo} --write), then check again: ${conformCmd}.`;

  const push = (c: Claim, r: Omit<ClaimResult, "check" | "repo" | "from" | "next">) => {
    const full = { ...r, check: c.check, repo, from: c.from } as ClaimResult;
    const where = quick(c) ? "the row" : "the operation";
    full.next =
      r.outcome === "present"
        ? "Nothing: the line is cited for the reviewer."
        : r.outcome === "present-differently"
          ? quick(c)
            ? `Make ${repo} do what the row says on the branch, or change the row (design.md:${c.from.line}) if the design was wrong, then check again: ${conformCmd}. If it is right as it is, waive the finding with a reason.`
            : `Make ${repo} do what ${c.from.operation} sets on the branch, or change the operation if the design was wrong (atticus change architecture ${change}), then check again: ${conformCmd}. If it is right as it is, waive the finding with a reason.`
          : r.outcome === "missing"
            ? `Build it on the branch in ${repo}; if it lives in a repo the change doesn't name, add that repo to ${where}${quick(c) ? ` (design.md:${c.from.line})` : ""}. Then check again: ${conformCmd}.`
            : r.outcome === "not-checkable"
              ? `Check it by hand, then say how: atticus finding ${change} ${claimFindingId(full)} waive --reason "<how it was checked>".`
              : unreadNext();
    results.push(full);
  };

  /**
   * The outcome of a claim looked for in facts: what matches, else what says otherwise, else
   * nothing. Present needs facts; different and missing need facts with nothing unread.
   */
  const judge = (
    c: Claim,
    expected: string,
    says: string,
    hit: Fact | undefined,
    other: { fact: Fact; found: string; what: string } | undefined,
    none: string,
    why?: string,
  ) => {
    if (hit) matched.add(hit.id);
    if (other) matched.add(other.fact.id);
    if (hit && factsSay)
      return push(c, {
        outcome: "present",
        expected,
        what: sentence(says),
        at: [codeCite(hit)],
        ...(why ? { why } : {}),
        fact: hit.id,
      });
    if (other && decisive)
      return push(c, {
        outcome: "present-differently",
        expected,
        found: other.found,
        what: sentence(other.what),
        at: [codeCite(other.fact), claimCite(c)],
        fact: other.fact.id,
      });
    if (!hit && !other && decisive)
      return push(c, { outcome: "missing", expected, what: sentence(none), at: [claimCite(c)] });
    const seen = hit ?? other?.fact;
    push(c, {
      outcome: "unconfirmed",
      expected,
      ...(other && !hit ? { found: other.found } : {}),
      what: `Atticus couldn't confirm that ${bare(says)}: ${unreadWhy()}.`,
      at: seen ? [codeCite(seen), claimCite(c)] : [claimCite(c)],
      ...(seen ? { fact: seen.id } : {}),
    });
  };

  const notCheckable = (c: Claim, expected: string, what: string) =>
    push(c, { outcome: "not-checkable", expected, what, at: [claimCite(c)] });

  /** A file of the commit's tree, named as a file or with its folder. */
  const inTree = (name: string) => {
    const want = name
      .trim()
      .replace(/\\/g, "/")
      .replace(/^\.?\//, "");
    return input.files.find(
      (f) =>
        f === want || f.endsWith(`/${want}`) || (!want.includes("/") && posix.basename(f) === want),
    );
  };

  for (const c of input.claims.filter((x) => x.repo === repo)) {
    const e = c.expect;
    const op = c.from.operation;
    const pairs = (keys: Key[]) =>
      keys
        .flatMap((k) =>
          e[k] !== undefined ? [`${k} ${k === "value" ? redactWords(e[k]!) : e[k]}`] : [],
        )
        .join(", ");
    switch (c.check) {
      case "cut-over":
        notCheckable(
          c,
          c.undo ? `undo: ${c.undo}` : "no undo",
          op
            ? `${op} is a cut-over in ${repo}: an act in a live system, which Atticus never connects to.`
            : `The cut-over in ${repo} is an act in a live system, which Atticus never connects to.`,
        );
        continue;
      case "other":
        notCheckable(
          c,
          c.words,
          `The design says a person checks this in ${repo}: ${sentence(c.words)}`,
        );
        continue;
      default:
        break;
    }
    if (op && !Object.keys(e).length) {
      notCheckable(
        c,
        "nothing a scan can find",
        `${op} in ${repo} says nothing a scan can find: it gives no sets.`,
      );
      continue;
    }
    if (c.check === "pipeline" || c.check === "migration") {
      if (!e.file) {
        notCheckable(
          c,
          "nothing a scan can find",
          `${op ?? "The row"} in ${repo} names no file a scan can find.`,
        );
        continue;
      }
      if (basis.from === "none") {
        push(c, {
          outcome: "unconfirmed",
          expected: `file ${e.file}`,
          what: `Atticus couldn't confirm that ${repo} has ${e.file}: ${unreadWhy()}.`,
          at: [claimCite(c)],
        });
        continue;
      }
      // A file of the commit's tree is git's to say, whatever the facts cover.
      const file = inTree(e.file);
      push(
        c,
        file
          ? {
              outcome: "present",
              expected: `file ${e.file}`,
              what: `${repo} has ${e.file}.`,
              at: [{ source: "code", repo, path: file, line: 1 }],
            }
          : {
              outcome: "missing",
              expected: `file ${e.file}`,
              what: `${repo} has no ${e.file}.`,
              at: [claimCite(c)],
            },
      );
      continue;
    }
    switch (c.check) {
      case "deployment": {
        const expected = pairs(["platform", "env"]);
        const envOf = (f: F<"deploy">) => f.env ?? "default";
        const deploys = of("deploy");
        const sameEnv = e.env ? deploys.filter((f) => same(envOf(f), e.env)) : deploys;
        const hit = sameEnv.find((f) => !e.platform || same(f.platform, e.platform));
        const says = e.platform
          ? `${repo} runs on ${e.platform}${e.env ? ` in ${e.env}` : ""}`
          : `${repo} has a deployment in ${e.env}`;
        const o = hit ? undefined : (sameEnv[0] ?? deploys[0]);
        judge(
          c,
          expected,
          says,
          hit,
          o && {
            fact: o,
            found: `platform ${o.platform}, env ${envOf(o)}`,
            what:
              e.env && !same(envOf(o), e.env)
                ? `${repo} runs on ${o.platform} in ${envOf(o)}, not in ${e.env}`
                : `${repo} runs on ${o.platform} in ${envOf(o)}, not on ${e.platform}`,
          },
          `${repo} has no deployment${e.platform ? ` on ${e.platform}` : ""}${e.env ? ` in ${e.env}` : ""}`,
          hit
            ? writtenWhy(hit, [
                ["platform", e.platform],
                ["env", e.env],
              ])
            : undefined,
        );
        break;
      }
      case "route": {
        const expected = pairs(["host", "basePath"]);
        const at = `${e.host ?? ""}${e.basePath ?? ""}`;
        const hosts = of("deploy").filter((f) => f.host || f.basePath);
        const hit = hosts.find(
          (f) => (!e.host || same(f.host, e.host)) && (!e.basePath || f.basePath === e.basePath),
        );
        const o = hit ? undefined : hosts[0];
        judge(
          c,
          expected,
          `${repo} is served at ${at}`,
          hit,
          o && {
            fact: o,
            found: [o.host ? `host ${o.host}` : "", o.basePath ? `basePath ${o.basePath}` : ""]
              .filter(Boolean)
              .join(", "),
            what: `${repo} is served at ${o.host ?? ""}${o.basePath ?? ""}, not at ${at}`,
          },
          `${repo} isn't served at ${at}`,
          hit
            ? writtenWhy(hit, [
                ["host", e.host],
                ["basePath", e.basePath],
              ])
            : undefined,
        );
        break;
      }
      case "config":
      case "secret": {
        const secret = c.check === "secret";
        const expected = pairs(secret ? ["key", "env"] : ["key", "env", "value"]);
        const keyed = of("config").filter((f) => f.key === e.key);
        const inEnv = e.env ? keyed.filter((f) => same(f.env, e.env)) : keyed;
        const envWords = e.env ? ` in ${e.env}` : "";
        if (secret) {
          // The review of ADR 0206: a literal is `source: literal:<file>` with no value (the
          // /atticus-map rules; the verifier refuses a secret-shaped value), or a value; a
          // reference counts only when it is written on the cited lines, as the verifier doesn't
          // check a source there. The value is never read into a result.
          const literal = (f: F<"config">) =>
            f.value !== undefined || /^literal:/i.test(f.source ?? "");
          const literalIn = (f: F<"config">) =>
            /^literal:(.+)$/i.exec(f.source ?? "")?.[1]?.trim() || f.cite.file;
          const shownOn = (f: F<"config">) => {
            const s = f.source?.trim();
            if (!s || !input.lineAt) return false;
            const name = /^[a-z][a-z0-9+.-]*:(.+)$/i.exec(s)?.[1]?.trim();
            return citedLines(f).some((l) => wordOn(l, s) || (!!name && wordOn(l, name)));
          };
          const says = `${repo} keeps ${e.key}${envWords} by a reference to where secrets are kept`;
          const lit = inEnv.find(literal);
          const hit = lit ? undefined : inEnv.find((f) => f.source && shownOn(f));
          const doubt = lit || hit ? undefined : inEnv.find((f) => !literal(f));
          if (doubt) {
            matched.add(doubt.id);
            push(c, {
              outcome: "unconfirmed",
              expected,
              what: doubt.source
                ? `Atticus couldn't confirm that ${bare(says)}: ${doubt.cite.file}:${doubt.cite.line} doesn't show ${doubt.source}, so the reference is only the assistant's reading.`
                : `Atticus couldn't confirm that ${bare(says)}: the fact at ${doubt.cite.file}:${doubt.cite.line} gives no source.`,
              at: [codeCite(doubt), claimCite(c)],
              fact: doubt.id,
            });
            break;
          }
          const o = hit ? undefined : (lit ?? keyed[0]);
          judge(
            c,
            expected,
            says,
            hit,
            o && {
              fact: o,
              found: lit
                ? `key ${e.key}, set to a literal in ${literalIn(lit)}`
                : `key ${e.key}, env ${o.env ?? "none"}`,
              what: lit
                ? `${repo} sets ${e.key} to a literal in ${literalIn(lit)}: keep it in the secret store`
                : `${repo} sets ${e.key} in ${o.env ?? "no env"}, not in ${e.env}`,
            },
            `${repo} doesn't set ${e.key}${envWords}`,
            hit ? `Written on the cited lines: source ${hit.source}.` : undefined,
          );
          break;
        }
        const hit = inEnv.find((f) => e.value === undefined || f.value === e.value);
        const o = hit ? undefined : (inEnv[0] ?? keyed[0]);
        const valueOf = (f: F<"config">) =>
          f.value !== undefined ? redactWords(f.value) : "a reference";
        judge(
          c,
          expected,
          `${repo} sets ${e.key}${envWords}${e.value !== undefined ? ` to ${redactWords(e.value)}` : ""}`,
          hit,
          o && {
            fact: o,
            found: [`key ${o.key}`, o.env ? `env ${o.env}` : "", `value ${valueOf(o)}`]
              .filter(Boolean)
              .join(", "),
            what:
              e.env && !same(o.env, e.env)
                ? `${repo} sets ${e.key} in ${o.env ?? "no env"}, not in ${e.env}`
                : `${repo} sets ${e.key}${envWords} to ${valueOf(o)}, not ${redactWords(e.value ?? "")}`,
          },
          `${repo} doesn't set ${e.key}${envWords}`,
          hit && e.value !== undefined ? writtenWhy(hit, [["value", e.value]]) : undefined,
        );
        break;
      }
      case "endpoint": {
        const entries = of("entry").filter((f) => !TOPICS.has(f.entryType));
        const onPath = entries.filter((f) => normalizePath(f.path) === normalizePath(e.path!));
        const hit = onPath.find((f) => same(f.method, e.method));
        const o = hit ? undefined : onPath[0];
        const entry = `${e.method} ${e.path}`;
        judge(
          c,
          entry,
          `${repo} serves ${entry}`,
          hit,
          o && {
            fact: o,
            found: `${o.method ?? "?"} ${o.path}`,
            what: `${repo} serves ${o.method ?? "?"} ${o.path}, not ${entry}`,
          },
          `${repo} serves no ${entry}`,
        );
        break;
      }
      case "listener": {
        const hit = of("entry").find((f) => TOPICS.has(f.entryType) && f.path === e.topic);
        judge(
          c,
          `topic ${e.topic}`,
          `${repo} listens to ${e.topic}`,
          hit,
          undefined,
          `${repo} doesn't listen to ${e.topic}`,
        );
        break;
      }
      case "publish": {
        const hit = of("call").find((f) => TOPICS.has(f.callType) && f.path === e.topic);
        judge(
          c,
          `topic ${e.topic}`,
          `${repo} publishes to ${e.topic}`,
          hit,
          undefined,
          `${repo} doesn't publish to ${e.topic}`,
        );
        break;
      }
      case "call": {
        const entry = `${e.method} ${e.path}`;
        const calls = of("call").filter(
          (f) => HTTP_CALLS.has(f.callType) && normalizePath(f.path) === normalizePath(e.path!),
        );
        const right = calls.filter((f) => same(f.method, e.method));
        const hit = right.find((f) => !f.to || same(f.to, e.target));
        const o = hit ? undefined : (right[0] ?? calls[0]);
        judge(
          c,
          `${e.target} ${entry}`,
          `${repo} calls ${e.target} ${entry}`,
          hit,
          o && {
            fact: o,
            found: `${o.to ?? "?"} ${o.method ?? "?"} ${o.path}`,
            what: `${repo} calls ${o.to ?? "?"} ${o.method ?? "?"} ${o.path}, not ${e.target} ${entry}`,
          },
          `${repo} makes no call to ${e.target} ${entry}`,
          hit && !hit.to
            ? "The call's target is settled by the map's join, not by this fact."
            : undefined,
        );
        break;
      }
      case "table":
      case "column": {
        const table = e.table!;
        const stores = of("store").filter((f) => f.name === table || lastPart(f.name) === table);
        if (c.check === "table") {
          judge(
            c,
            `table ${table}`,
            `${repo} has the table ${table}`,
            stores[0],
            undefined,
            `${repo} has no table ${table}`,
          );
          break;
        }
        const col = e.column!;
        const hit = stores.find((f) => f.columns?.includes(col));
        const expected = `column ${table}.${col}`;
        if (!hit && stores.length && !stores.some((f) => f.columns?.length)) {
          matched.add(stores[0]!.id);
          push(c, {
            outcome: "unconfirmed",
            expected,
            what: `Atticus couldn't confirm that ${table} has the column ${col} in ${repo}: the facts name the table and none of its columns.`,
            at: [codeCite(stores[0]!), claimCite(c)],
            fact: stores[0]!.id,
          });
          break;
        }
        judge(
          c,
          expected,
          `${table} has the column ${col} in ${repo}`,
          hit,
          undefined,
          `${table} has no column ${col} in ${repo}`,
        );
        break;
      }
    }
  }

  const unexpected: ConformItem[] = [];
  if (input.unexpected && factsSay) {
    const keyOf = (f: Fact): string | undefined =>
      f.kind === "entry"
        ? `entry|${(f.method ?? "").toUpperCase()}|${normalizePath(f.path)}`
        : f.kind === "call"
          ? `call|${(f.method ?? "").toUpperCase()}|${TOPICS.has(f.callType) ? f.path : normalizePath(f.path)}`
          : f.kind === "store"
            ? `store|${f.name}`
            : undefined;
    const had = new Set(input.before.filter(mine).flatMap((f) => keyOf(f) ?? []));
    const design = input.claims.some(quick)
      ? "which no row of design.md's In the code names"
      : "which the change's design doesn't name";
    for (const f of after.filter((x) => x.repo === repo)) {
      const k = keyOf(f);
      if (!k || had.has(k) || matched.has(f.id)) continue;
      if (f.kind === "store" && f.op === "read") continue;
      const at = [codeCite(f)];
      const record = `${repo}#${f.id}`;
      if (f.kind === "entry")
        unexpected.push({
          status: "unexpected",
          check: "endpoint",
          what: TOPICS.has(f.entryType)
            ? `${repo} listens to ${f.path}, ${design}.`
            : `${repo} serves ${f.method ? `${f.method} ` : ""}${f.path}, ${design}.`,
          record,
          at,
        });
      else if (f.kind === "call")
        unexpected.push({
          status: "unexpected",
          check: TOPICS.has(f.callType) ? "publish" : "call",
          what: TOPICS.has(f.callType)
            ? `${repo} publishes to ${f.path}, ${design}.`
            : `${repo} calls ${f.to ?? f.host ?? "an address the map hasn't joined"} ${f.method ? `${f.method} ` : ""}${f.path}, ${design}.`,
          record,
          at,
        });
      else if (f.kind === "store")
        unexpected.push({
          status: "unexpected",
          check: "table",
          what: `${repo} adds the table ${f.name}, ${design}.`,
          record,
          at,
        });
    }
  }
  return { claims: results, unexpected };
}

/** How many of each outcome, as the stored result counts them. */
export function claimCounts(rs: readonly Pick<ClaimResult, "outcome">[]) {
  const n = (o: ClaimOutcome) => rs.filter((r) => r.outcome === o).length;
  return {
    present: n("present"),
    differs: n("present-differently"),
    missing: n("missing"),
    notCheckable: n("not-checkable"),
    unconfirmed: n("unconfirmed"),
  };
}

/** A repo's facts the branch's assistant wrote, kept in the change folder (ADR 0206, as built). */
export const BRANCH_FACTS_DIR = "conform/facts";

/** The repos with branch facts in a change folder. */
export async function branchFactRepos(changeDir: string): Promise<string[]> {
  return (
    await readdir(join(changeDir, ...BRANCH_FACTS_DIR.split("/"))).catch(() => [] as string[])
  )
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.slice(0, -".jsonl".length))
    .sort();
}
