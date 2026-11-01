import {
  citedFiles,
  claimOnLines,
  clusterServiceAddress,
  factIdPart,
  isPatternPath,
  plainPathPrefix,
  lineNamesClaim,
  partsBuildWord,
  partsNamePath,
  isSecretPath,
  NEVER_CHECKED_STEPS,
  quoteMatches,
  quoteNotRequired,
  redactSecrets,
  staleCite,
  type Cite,
  type Claim,
  type Conventions,
  type Fact,
  type FileChange,
  type StaleCite,
  type FactCorrection,
} from "@maycombhq/core";
import { globToRegExp } from "@maycombhq/sdk";
import { authChecks, authPolicyMismatch } from "./apigee-policy.js";
import { applyCorrections, type AppliedCorrection, type StaleCorrection } from "./corrections.js";
import { derivedHolds, derivedNamesAt, type DeriveEnv, type DerivedName } from "./derived.js";
import { frameworkGaps, frameworkNameProblem, type FrameworkGap } from "./frameworks.js";
import { isDataFile, isLocaleBundle } from "./not-product.js";
import { DEFAULT_READ_RULES, readRulesOf, type ReadRules } from "./conventions.js";
import { pageRouteMatches } from "./pages.js";
import { isGlob, lineRangeOf, type ReviewedEntry } from "./reviewed.js";
import { methodUnseenOf, type MethodUnseen } from "./method.js";
import { insideRepo, type FileSource } from "./source.js";
import {
  candidatesIn,
  factsCover,
  indexFacts,
  isCommentLine,
  notReadForSkipped,
  reviewedHoldsOf,
  skippedOf,
  specOpsUncoveredIn,
  type ReviewedHolds,
  type SkippedLine,
  type SpecOpUncovered,
} from "./skipped.js";

/**
 * The verifier (ADR 0124). It never reads code to find facts; it checks the facts it is given:
 * the file is inside the repo and not a secret, the fact is of the commit being verified, the
 * cited line exists, the claim (the route, topic, table, field, key or resource the fact states)
 * is on that line or one line either side (or, for a name a framework derives, the line declares
 * its source: `derived.ts`), the quote matches after the model's small rewrites
 * are forgiven, and every fact a fact names exists and holds. What it proves: every fact rests on
 * a real line that names the thing claimed. What it cannot prove: that the reader understood it.
 */

export type RejectCode =
  | "outside-repo"
  | "secret-path"
  | "wrong-commit"
  | "no-file"
  | "no-line"
  | "claim-not-on-line"
  | "claim-in-comment"
  | "quote-mismatch"
  | "dangling-ref"
  | "ref-rejected"
  /** A flow's call-out step whose ref is missing or names neither a call nor a config fact. */
  | "call-out-no-call"
  /**
   * A flow's publish step whose ref is missing or isn't the `event-topic` or `mq-queue` call it
   * publishes (ADR 0124 addendum C-estate).
   */
  | "publish-no-event"
  /**
   * A fact of an earlier commit that cites a file edited, renamed or deleted since (ADR 0124
   * addendum A-incremental): a changed file invalidates what cites it, so it is read again.
   */
  | "cite-changed"
  /**
   * An entry whose `authCite` attaches a policy of a kind that cannot produce the `auth` claimed
   * (ADR 0124 addendum A-gateway2): a `VerifyAPIKey` never makes `oauth2`.
   */
  | "auth-policy-kind"
  /**
   * A framework fact whose `name` is not the framework the declaration on its cited line means
   * (ADR 0124 addendum A-framework): a reader can't rename an artifact.
   */
  | "framework-name"
  /** A deploy fact's host written as a template (`{{ .Values.host }}`, `${HOST}`) (ADR 0143). */
  | "exposure-template"
  /**
   * A deploy fact's base path written as a regular expression (an Ingress `ImplementationSpecific`
   * path, `/forge/limits(/|$)(.*)`): its plain prefix is the base path (ADR 0143, beta.10).
   */
  | "exposure-regex"
  /**
   * An exposure (a deploy fact with a host or base path) that names no component of the estate,
   * or names none in a repo whose facts serve nothing, a deploy repo's (ADR 0143).
   */
  | "exposure-component";

/** One thing wrong with a fact. */
export interface Problem {
  code: RejectCode;
  message: string;
}

export interface Rejected {
  fact: Fact;
  /** The first problem's code. */
  code: RejectCode;
  /** The first problem's message, or every problem's, numbered, when there are several. */
  message: string;
  /**
   * Every problem the fact has, in the order found, when there is more than one (ADR 0124
   * addendum A-read): so a fact with two faults is fixed in one loop, not two.
   */
  problems?: Problem[];
}

export interface Coverage {
  /**
   * Source files a kept fact cites (its cite, `cite.with`, an entry's `authCite`, a flow's steps
   * and error paths and their parts), or the reader opened through Atticus's tools.
   */
  read: string[];
  /**
   * Source files the reader says it read and found no fact in (`<repo>.reviewed.jsonl`, ADR 0124
   * addendum A-read): on its word, so counted apart from read and listed with why.
   */
  reviewed: string[];
  /** Source files nobody can show or says were read. Never "excused" on the reader's word. */
  unknown: string[];
  /** Source files left out by an accepted exclusion rule (generated code, vendored copies). */
  excluded: string[];
  /**
   * read / (read + reviewed + unknown), three decimals; 1 when the repo has no source files.
   * What facts show, so a reviewed file never raises it.
   */
  ratio: number;
}

/** A line of `<repo>.reviewed.jsonl` that holds, with the source files it stands for. */
export interface ReviewedFiles {
  path: string;
  why: string;
  /** The source files it covers that no kept fact cites (those are read), sorted. */
  files: string[];
}

/** A line of `<repo>.reviewed.jsonl` refused: its path names no file of the repo at the commit. */
export interface ReviewedProblem {
  line?: number;
  path: string;
  why: string;
  message: string;
}

/**
 * An entry whose `auth` rests on no cited line (`authCite`). The claim stays in the facts file,
 * as its reader wrote it, and `catalogAuth` keeps it out of the catalog (ADR 0124 addendum
 * A-uncited), so this says the same thing on every run until a line is cited.
 */
export interface UncitedAuth {
  id: string;
  auth: string;
  /** The entry's own cite, `file:line`. */
  cite: string;
}

export interface VerifyReport {
  accepted: Fact[];
  rejected: Rejected[];
  coverage: Coverage;
  /** Quotes stored with a secret value redacted. */
  redacted: number;
  /**
   * Quotes left off a kept fact because the file's line can't be quoted and the quote doesn't
   * match it: a minified bundle, a notebook, a binary or a line over 1,000 characters
   * (`quoteNotRequired`). Counted, not silent (ADR 0124 addendum A-uncited): the claim itself is
   * still checked on the line, and only the quote goes.
   */
  quotesDropped: number;
  /**
   * Facts of an earlier commit carried to `commit` (ADR 0124 addendum A-incremental): every file
   * they cite is unchanged since `from`, and their lines checked again. Their `commit` in
   * `accepted` is the one verified; this is the record of where they were read. By id.
   */
  carried: { id: string; from: string }[];
  /** A person's corrections (ADR 0124 addendum D-app): applied, and those that met no fact. */
  corrections: { applied: AppliedCorrection[]; stale: StaleCorrection[] };
  /**
   * A note, not a rejection (ADR 0124 addendum C-estate): the listeners (`event-topic`,
   * `mq-queue`) and the `rest` or `grpc` entries among the kept facts that no kept flow starts,
   * so the reader writes a flow for each that does real work. In id order.
   */
  entriesNoFlowFollows: UnfollowedEntry[];
  /** The reviewed lines that hold, each with the files it stands for (A-read). */
  reviewed: ReviewedFiles[];
  /** The reviewed lines refused, each with why (A-read). */
  reviewedProblems: ReviewedProblem[];
  /**
   * A note, not a refusal (R6, amending A-read): the reviewed globs that match no file at the
   * commit. A glob that stands for no file excuses none, so it is dropped and said, not refused.
   */
  reviewedDropped: ReviewedProblem[];
  /**
   * A note, not a rejection (A-read, as A-uncited turns it round): the kept entries whose `auth`
   * rests on no cited line (`authCite`). The fact keeps the claim; the catalog projection drops
   * it. So this count is the same on every run, `--write` included, until a line is cited. In id
   * order.
   */
  authUncited: UncitedAuth[];
  /**
   * A note, not a rejection (P2): the kept entries and calls whose HTTP method is written on
   * neither the cited line, the next line nor a `cite.with` line. In id order.
   */
  methodUnseen: MethodUnseen[];
  /**
   * A note, not a rejection (R1): the lines of the files read that write a path, URL or topic no
   * kept fact cites or names (`skipped.ts`), for the reader to check. Sorted by file and line.
   */
  skipped: SkippedLine[];
  /** A note (R1): the reviewed globs whose files write a path, URL or topic no fact accounts for. */
  reviewedHolds: ReviewedHolds[];
  /** A note (R1): the operations a repo's OpenAPI spec declares that no kept entry covers. */
  specOpsUncovered: SpecOpUncovered[];
  /**
   * A note, not a rejection (ADR 0124 addendum A-framework): the frameworks the kept facts say
   * the repo is built on whose patterns none of those facts show — a Spring Boot repo with no
   * REST entry, a React repo with no screen. Usually the reader missed the real entry points, so
   * it is a question for a person. In fact-id order.
   */
  frameworkGaps: FrameworkGap[];
}

/** An entry no flow starts: its id, type, method and path, and where it is cited (`file:line`). */
export interface UnfollowedEntry {
  id: string;
  entryType: string;
  method?: string;
  path: string;
  cite: string;
}

/** The entry types a flow is asked for when none starts there: listeners, and rest and gRPC routes. */
const FOLLOWED_TYPES: readonly string[] = ["event-topic", "mq-queue", "rest", "grpc"];

/**
 * The listeners and `rest` or `grpc` entries no flow of these facts starts (a flow's `entry`),
 * in id order. Pure: `verifyFacts` runs it on the kept facts.
 */
export function entriesNoFlowFollows(
  facts: readonly Fact[],
  rules: ReadRules = DEFAULT_READ_RULES,
): UnfollowedEntry[] {
  const started = new Set(facts.flatMap((f) => (f.kind === "flow" ? [f.entry] : [])));
  return facts
    .flatMap((f) =>
      f.kind === "entry" &&
      FOLLOWED_TYPES.includes(f.entryType) &&
      !started.has(f.id) &&
      // An Apigee route forwards; its forwarding call is its flow (ADR 0124 addendum A-gateway).
      !rules.gatewayBundle.test(f.cite.file)
        ? [
            {
              id: f.id,
              entryType: f.entryType,
              ...(f.method ? { method: f.method } : {}),
              path: f.path,
              cite: `${f.cite.file}:${f.cite.line}`,
            },
          ]
        : [],
    )
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The files changed since each earlier commit the facts name, keyed by that commit as the facts write it. */
export type CarryChanges = Readonly<Record<string, readonly FileChange[]>>;

export interface VerifyOptions {
  facts: readonly Fact[];
  source: FileSource;
  /**
   * The commit being verified; a fact of another commit is refused, unless `carry` has the diff
   * from its commit (then it is carried or read again). Prefixes match.
   */
  commit?: string;
  /**
   * For each earlier commit the facts name, the files changed from it to `commit` (`changesSince`
   * in @maycombhq/workspace): a fact whose cited files are all unchanged is carried to `commit`,
   * one citing a changed file is rejected as `cite-changed`.
   */
  carry?: CarryChanges;
  /** Files the reader opened through Atticus-routed tools (ADR 0118), repo-relative. */
  routed?: readonly string[];
  /** Accepted exclusion globs: generated code, vendored copies (ADR 0075 scan settings). */
  exclude?: readonly string[];
  /**
   * A person's corrections (`<repo>.corrections.jsonl`), applied before anything is checked: a
   * fact marked wrong is left out, an edited one is the person's fact and is checked as any is.
   */
  corrections?: readonly FactCorrection[];
  /**
   * Files the reader read and found no fact in (`<repo>.reviewed.jsonl`, `parseReviewed`): each
   * path must be a file of the repo, or a glob matching one; coverage counts them apart.
   */
  reviewed?: readonly ReviewedEntry[];
  /**
   * Called once per fact and once per file of the repo (ADR 0124 addendum A-room): the caller's
   * chance to stop the run with words of its own while it still can. `atticus verify` passes a
   * guard that throws when the heap passes its ceiling, so a read too big for the memory Node
   * was given ends in a message instead of the kernel's silent kill. Throw to stop; the throw is
   * the caller's, and `verifyFacts` lets it through untouched.
   */
  room?: () => void;
  /**
   * The estate the repo is part of (ADR 0143): its components and repos, as repos.manifest.yaml
   * names them. An exposure's `exposes` must be one of them. Left out, nothing checks the name.
   */
  estate?: {
    components: readonly string[];
    /**
     * The components each repo's facts name, by repo id (ADR 0143, beta.10): an exposure naming
     * `<repo>/<module>` must name one of its repo's. A repo left out has no facts yet, so its
     * module isn't checked here (the join reports one that names nothing).
     */
    repoComponents?: Readonly<Record<string, readonly string[]>>;
  };
  /**
   * The org pack's conventions (ADR 0147, `conventions.yaml`): the folders coverage and the
   * skipped-lines note leave out, the API spec and gateway bundle folders, the house's own
   * frameworks. Left out, the built-in lists.
   */
  conventions?: Conventions;
  /**
   * G4: the per-framework naming rules (`derived.ts`, the stack helper `derived-names`). False:
   * a claim must be written on its cited line or a `cite.with` part. Default true.
   */
  derivedNames?: boolean;
  /**
   * G4: the OpenAPI reader behind the uncovered spec operations (R1; the stack helper
   * `readers`). False: no spec is read and none is listed. Default true.
   */
  readers?: boolean;
}

/**
 * Files whose lines are held at once while the facts are checked (ADR 0124 addendum A-room). A
 * file's lines cost about twice its bytes, so an unbounded cache of a big repo's files was the
 * peak that `verify --write` was killed at. 64 covers a fact's own file, its parts' files and a
 * flow's files several times over, which is as far as consecutive facts (in id order) reach.
 */
const LINES_HELD = 64;

const SOURCE_EXT =
  /\.(java|kt|kts|scala|groovy|cs|vb|fs|ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|php|swift|m|mm|c|cc|cpp|h|hpp|sql|graphql|gql|proto|ya?ml|json|xml|properties|toml|ini|conf|tf|tfvars|hcl|bicep|sh|ps1|bat|cmd|gradle|html?|vue|svelte|cshtml|razor|aspx|jsp|ftl|hbs|cob|cbl|cpy|jcl|avsc|wsdl|xsd|csproj|sln|config)$/i;
const SOURCE_NAME = /(^|\/)(Dockerfile[^/]*|Makefile|Jenkinsfile|Procfile|Containerfile)$/;
const LOCKFILE =
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|Gemfile\.lock|Cargo\.lock|poetry\.lock|go\.sum|packages\.lock\.json)$/;

/**
 * Files that hold no facts of what a repo serves, calls, stores or deploys, so coverage doesn't
 * count them (feedback from the A4 run): tests, build-tool wrappers, Java package docs, and
 * i18n message bundles.
 */
const NOT_PRODUCT = [
  /(\.|_|-)(test|spec|tests|specs)\.[a-z0-9]+$/i,
  /(Test|Tests|IT|Spec)\.(java|kt|scala|groovy|cs|vb)$/,
  /(^|\/)test_[^/]+\.py$/,
  /(^|\/)(mvnw|mvnw\.cmd|gradlew|gradlew\.bat)$/,
  /(^|\/)package-info\.java$/,
  /(^|\/)messages(_[A-Za-z_]+)?\.properties$/,
  /\.(resx|po|pot)$/i,
];

/**
 * Whether a repo file counts as source for coverage. Neither a locale bundle does nor, given its
 * lines, a JSON or XML file big enough to be data (ADR 0124 addendum A-big).
 */
export function isSourceFile(
  path: string,
  firstLine = "",
  lines?: readonly string[],
  rules: ReadRules = DEFAULT_READ_RULES,
): boolean {
  if (isSecretPath(path) || LOCKFILE.test(path)) return false;
  if (rules.notProduct.test(path) || NOT_PRODUCT.some((re) => re.test(path))) return false;
  if (isLocaleBundle(path)) return false;
  if (lines && isDataFile(path, lines, rules)) return false;
  if (quoteNotRequired(path, firstLine)) return false;
  return SOURCE_EXT.test(path) || SOURCE_NAME.test(path);
}

const lastPart = (s: string) => s.split(".").pop() ?? s;
/** A value written as a template: Helm's or Go's `{{ }}`, a `${}` placeholder (ADR 0143). */
const TEMPLATED = /\{\{|\}\}|\$\{/;

/** A Service exposure's in-cluster address (J1, beta.10): only a Service's host is read so. */
const serviceAddress = (f: { resourceType?: string; host?: string }) =>
  f.host !== undefined && /^service$/i.test(f.resourceType ?? "")
    ? clusterServiceAddress(f.host)
    : undefined;

/** `<repo>/<module>`, as an exposure names a module the manifest doesn't list (J1, beta.10). */
export const repoModule = (exposes: string): { repo: string; module: string } | undefined => {
  const m = /^([^/]+)\/([^/]+)$/.exec(exposes.trim());
  return m ? { repo: m[1]!, module: m[2]! } : undefined;
};

const routeOrWord = (v: string): Claim =>
  v.includes("/") ? { kind: "route", value: v } : { kind: "word", value: v };

/** What a fact claims, as the line check looks for it; alternatives are tried in order. */
function claimsOf(f: Fact): Claim[] {
  switch (f.kind) {
    case "entry":
    case "call":
      return [routeOrWord(f.path)];
    case "store":
      return [
        { kind: "word", value: f.name },
        { kind: "word", value: lastPart(f.name) },
      ];
    case "field":
      return [{ kind: "field", value: f.name }];
    case "deploy":
      return [{ kind: "word", value: f.resourceName ?? f.cite.value }];
    // A-framework: the declaration as the build file writes it (`spring-boot-starter-parent`,
    // `Microsoft.NET.Sdk.Web`, `express`). The framework's own name follows from it, and is
    // checked against what Atticus knows that declaration to mean, not against the line.
    case "framework":
      return [
        { kind: "word", value: f.cite.value },
        { kind: "word", value: f.name },
      ];
    case "config": {
      // A key as written on the line, or the last part of a dotted path or a flag (a YAML path
      // `livenessProbe.httpGet.path` names `path:` on its line; `kubectl wait --timeout`, `timeout`).
      const tail = f.key.trim().split(/\s+/).pop()!.replace(/^-+/, "");
      const lastOf = (k: string) => k.split(/[.:]|__/).pop() ?? k;
      return [
        { kind: "word", value: f.key },
        { kind: "word", value: lastPart(f.key) },
        { kind: "word", value: tail },
        { kind: "word", value: lastOf(tail) },
      ];
    }
    case "flow":
      return [routeOrWord(f.cite.value)];
  }
}

/** Same commit when either names the other's prefix (a facts file may keep a short one). */
export const sameCommit = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);

/** The diff taken from a fact's commit, when there is one. */
export function changesFor(
  carry: CarryChanges | undefined,
  commit: string,
): readonly FileChange[] | undefined {
  if (!carry) return undefined;
  const key = Object.keys(carry).find((k) => sameCommit(k, commit));
  return key === undefined ? undefined : carry[key];
}

/** Why a fact must be read again, in the words the reader gets back. */
export function staleMessage(f: Fact, s: StaleCite, commit: string): string {
  const how = s.how === "renamed" ? `renamed to ${s.to}` : s.how;
  const then =
    s.how === "deleted"
      ? "drop the fact, or cite where the code says it now"
      : "rewrite the fact with its line as it is now, or drop it";
  return `${f.kind} ${f.id} cites ${s.file}, which was ${how} since commit ${f.commit}; read it again at ${commit}, then ${then}`;
}

function refsOf(f: Fact): { field: string; id: string }[] {
  const out: { field: string; id: string }[] = [];
  const add = (field: string, id: string | undefined) => {
    if (id !== undefined) out.push({ field, id });
  };
  if (f.kind === "call") add("from", f.from);
  if (f.kind === "store") add("under", f.under);
  if (f.kind === "field") {
    add("owner", f.owner);
    add("mappedTo", f.mappedTo);
  }
  if (f.kind === "flow") {
    add("entry", f.entry);
    f.steps.forEach((s, i) => add(`steps.${i + 1}.ref`, s.ref));
  }
  return out;
}

export async function verifyFacts(o: VerifyOptions): Promise<VerifyReport> {
  // ADR 0147: the org pack's folder lists and house frameworks, the built-in ones without.
  const rules = readRulesOf(o.conventions);
  // A fact of an earlier commit whose cited files are all unchanged since is checked as a fact
  // of this commit (ADR 0124 addendum A-incremental); one citing a changed file is read again.
  const carriedFrom = new Map<string, string>();
  const stale = new Map<string, StaleCite>();
  const corrected = applyCorrections(o.facts, o.corrections ?? []);
  const facts = [...corrected.facts]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((f) => {
      if (!o.commit || sameCommit(f.commit, o.commit)) return f;
      const changes = changesFor(o.carry, f.commit);
      if (!changes) return f;
      const s = staleCite(f, changes);
      if (s) {
        stale.set(f.id, s);
        return f;
      }
      carriedFrom.set(f.id, f.commit);
      return { ...f, commit: o.commit } as Fact;
    });
  // The lines of the file cited, read once and held while the facts that cite it are checked.
  // The cache is bounded (ADR 0124 addendum A-room): a 4,900-file repo's lines, held as arrays of
  // strings, cost about twice the repo's own bytes, and that was the peak this command died at.
  // The facts are in id order and a fact's cite, parts, steps and error paths sit in a handful of
  // files, so a small window keeps nearly every hit; past it, the oldest file's lines are freed.
  const readLines = (path: string) => {
    // a path a rule builds (`app/models/user.rb`) is read only when it stays in the repo
    const text = insideRepo(path) && !isSecretPath(path) ? o.source.read(path) : undefined;
    // the raw text is dropped as soon as it is split, so only one copy of a file is ever held
    return text === undefined ? undefined : text.replace(/\r\n?/g, "\n").split("\n");
  };
  const linesCache = new Map<string, string[] | undefined>();
  const linesOf = (path: string) => {
    if (linesCache.has(path)) {
      // keep it at the newest end of the window
      const held = linesCache.get(path);
      linesCache.delete(path);
      linesCache.set(path, held);
      return held;
    }
    const lines = readLines(path);
    linesCache.set(path, lines);
    if (linesCache.size > LINES_HELD) linesCache.delete(linesCache.keys().next().value!);
    return lines;
  };
  let fileList: string[] | undefined;
  const deriveEnv: DeriveEnv = { lines: linesOf, files: () => (fileList ??= o.source.list()) };

  /** One citation checked against its file: undefined when it holds, else why not. */
  const checkCite = (
    cite: Cite,
    claims: Claim[] | undefined,
    label: string,
    /** Say that a claim built from other lines cites them in `cite.with` (not for an authCite). */
    withHint = true,
  ): Problem | undefined => {
    const where = `${cite.file}:${cite.line}`;
    if (!insideRepo(cite.file))
      return {
        code: "outside-repo",
        message: `${label} cites ${cite.file}, which is outside the repo`,
      };
    if (isSecretPath(cite.file))
      return {
        code: "secret-path",
        message: `${label} cites ${cite.file}, a file whose lines are never quoted into a map; cite where the code reads the setting instead`,
      };
    const lines = linesOf(cite.file);
    if (lines === undefined)
      return {
        code: "no-file",
        message: `${label} cites ${cite.file}, which is not in the repo at this commit`,
      };
    if (cite.line > lines.length)
      return {
        code: "no-line",
        message: `${label} cites line ${cite.line} of ${cite.file}, which has ${lines.length} lines`,
      };
    // A claim put together from several lines (ADR 0124 addendum A4): each part line must exist
    // and name its own part; then the claim is checked over all the lines together.
    const parts = cite.with ?? [];
    const near = (ls: string[], n: number) => ls.slice(Math.max(0, n - 2), n + 1);
    const partLines: string[] = [];
    for (const [i, p] of parts.entries()) {
      const pl = `${label} part ${i + 1}`;
      if (!insideRepo(p.file))
        return {
          code: "outside-repo",
          message: `${pl} cites ${p.file}, which is outside the repo`,
        };
      if (isSecretPath(p.file))
        return {
          code: "secret-path",
          message: `${pl} cites ${p.file}, a file never quoted into a map`,
        };
      const ls = linesOf(p.file);
      if (ls === undefined)
        return {
          code: "no-file",
          message: `${pl} cites ${p.file}, which is not in the repo at this commit`,
        };
      if (p.line > ls.length)
        return {
          code: "no-line",
          message: `${pl} cites line ${p.line} of ${p.file}, which has ${ls.length} lines`,
        };
      if (
        !claimOnLines(ls, p.line, routeOrWord(p.value)) &&
        !claimOnLines(ls, p.line, { kind: "word", value: p.value.replace(/^\/+|\/+$/g, "") }) &&
        // a part named at a camelCase start (`Catalog` in `CatalogController`), as the path check does
        !partsNamePath(near(ls, p.line), p.value)
      )
        return {
          code: "claim-not-on-line",
          message: `${pl} says "${p.value}" is written at ${p.file}:${p.line} (or the line either side), and it isn't`,
        };
      partLines.push(...near(ls, p.line));
    }
    // Names a framework derives from what the cited line or a part declares (A-derived).
    let derived: DerivedName[] | undefined;
    const derivedHere = () =>
      (derived ??= [
        { file: cite.file, line: cite.line },
        ...parts.map((p) => ({ file: p.file, line: p.line })),
      ].flatMap((at) => derivedNamesAt(at.file, linesOf(at.file) ?? [], at.line, deriveEnv)));
    const holds = (c: Claim) =>
      claimOnLines(lines, cite.line, c) ||
      // a framework that routes by file place (Razor Pages, WebForms, Next.js)
      (c.kind === "route" &&
        pageRouteMatches(cite.file, lines, (p) => linesOf(p) !== undefined, c.value)) ||
      (parts.length > 0 &&
        (c.kind === "route"
          ? partsNamePath([...near(lines, cite.line), ...partLines], c.value)
          : partLines.some((l) => lineNamesClaim(l, c)) ||
            // a word put together from parts (`namespace:task`, a key a helper prefixes)
            (c.kind === "word" &&
              partsBuildWord(
                c.value,
                parts.map((p) => p.value),
                near(lines, cite.line),
              )))) ||
      (o.derivedNames !== false && derivedHolds(c, derivedHere(), partLines, partsNamePath));
    if (claims && !claims.some(holds))
      return {
        code: "claim-not-on-line",
        message: `${label} claims ${claims.map((c) => `"${c.value}"`).join(" or ")}, which ${where} (or the line either side)${parts.length ? " and its parts" : ""} does not name${parts.length || !withHint ? "" : "; if it is put together from other lines (a base URL, a prefix, a context path), cite them in cite.with"}`,
      };
    // A claim written only in a comment (a commented-out example, a scaffold note) isn't code.
    if (claims && !parts.length) {
      const naming = [cite.line - 1, cite.line, cite.line + 1]
        .map((n) => lines[n - 1])
        .filter((l): l is string => l !== undefined && claims.some((c) => lineNamesClaim(l, c)));
      // Netlify's `_redirects` starts its rules with `/*`, which is no comment there
      if (naming.length && !/(^|\/)_redirects$/.test(cite.file) && naming.every(isCommentLine))
        return {
          code: "claim-in-comment",
          message: `${label} claims ${claims.map((c) => `"${c.value}"`).join(" or ")}, which ${where} writes only in a comment; cite the code that does it`,
        };
    }
    const line = lines[cite.line - 1] ?? "";
    if (cite.quote && !quoteNotRequired(cite.file, line)) {
      const near = [cite.line - 1, cite.line, cite.line + 1].map((n) => lines[n - 1] ?? "");
      if (!near.some((l) => quoteMatches(l, cite.quote)))
        return {
          code: "quote-mismatch",
          message: `${label} quotes "${cite.quote}", but ${where} reads "${line.trim().slice(0, 200)}"`,
        };
    }
    return undefined;
  };

  // Every problem a fact has is found in one run (A-read, problem 5): its own cite, its auth's,
  // each step and error path of a flow, and its references. A fact of another commit has one.
  const found = new Map<string, Problem[]>();
  const other = new Set<string>();
  const problem = (fact: Fact, code: RejectCode, message: string) =>
    found.set(fact.id, [...(found.get(fact.id) ?? []), { code, message }]);
  const add = (fact: Fact, p: Problem | undefined) => {
    if (p) problem(fact, p.code, p.message);
  };

  /** What a flow step claims: none for the kinds a line can't confirm, but a validate's rule is. */
  const stepClaims = (kind: string, value: string): Claim[] | undefined => {
    // A-read, problem 3: a validation rule (a range, required, a format) is what a story needs
    // most, and its value is written on its line, so it is checked as other steps are. C1's
    // NEVER_CHECKED_STEPS stays as it is: the projection still marks no validate step confirmed
    // by the check, since a rule's line can't show the rule is applied where the flow says.
    if (kind === "validate")
      return value.includes("/")
        ? [routeOrWord(value), { kind: "word", value }]
        : [routeOrWord(value)];
    return (NEVER_CHECKED_STEPS as readonly string[]).includes(kind)
      ? undefined
      : [routeOrWord(value)];
  };

  // J1: the estate's components an exposure may name, and whether this repo serves anything.
  const estate = o.estate ? new Set(o.estate.components.map(factIdPart)) : undefined;
  const serves = facts.some((f) => f.kind === "entry");
  const repoComponents = new Map(
    Object.entries(o.estate?.repoComponents ?? {}).map(
      ([r, cs]) => [factIdPart(r), new Set(cs.map(factIdPart))] as const,
    ),
  );
  for (const f of facts) {
    const label = `${f.kind} ${f.id}`;
    if (o.commit && !sameCommit(f.commit, o.commit)) {
      other.add(f.id);
      // a traversal or a secret is reported as such even on another commit
      const early = !insideRepo(f.cite.file)
        ? ("outside-repo" as const)
        : isSecretPath(f.cite.file)
          ? ("secret-path" as const)
          : undefined;
      if (early) add(f, checkCite(f.cite, undefined, label));
      else if (stale.has(f.id))
        problem(f, "cite-changed", staleMessage(f, stale.get(f.id)!, o.commit));
      else
        problem(
          f,
          "wrong-commit",
          `${label} was read at ${f.commit}, not at ${o.commit}; read it again`,
        );
      continue;
    }
    add(f, checkCite(f.cite, claimsOf(f), label));
    // A-read, problem 4: an entry's auth rests on the line that sets it, checked as a part is.
    if (f.kind === "entry" && f.authCite)
      add(
        f,
        checkCite(
          { ...f.authCite },
          [{ kind: "word", value: f.authCite.value }],
          `${label} authCite${f.auth ? ` (auth ${f.auth})` : ""}`,
          false,
        ),
      );
    // A-gateway2: and the policy attached there must be of a kind that can set that auth.
    if (f.kind === "entry" && f.authCite && f.auth) {
      const bad = authPolicyMismatch(f.auth, f.authCite.file, f.authCite.value, linesOf);
      if (bad)
        problem(
          f,
          "auth-policy-kind",
          `${label} claims auth ${f.auth} on a line that attaches ${f.authCite.value}, a ${bad.element} policy (${bad.path}), which ${bad.makes ? `checks ${bad.makes.map(authChecks).join(" or ")}, not ${authChecks(f.auth)}` : "authenticates nobody"}; cite the line that attaches the check, or write the auth the policy makes`,
        );
    }
    // A-gateway2: each scope the entry demands rests on the line that names it.
    if (f.kind === "entry")
      (f.scopes ?? []).forEach((s, i) =>
        add(
          f,
          checkCite(
            s,
            [{ kind: "word", value: s.value }],
            `${label} scope ${i + 1} ("${s.value}")`,
          ),
        ),
      );
    // A-callers: and each consumer it names, on the line that names it.
    if (f.kind === "entry")
      (f.callers ?? []).forEach((c, i) =>
        add(
          f,
          checkCite(
            c,
            [{ kind: "word", value: c.value }],
            `${label} caller ${i + 1} (${c.as} "${c.value}")`,
          ),
        ),
      );
    // J1 (ADR 0143): where a component is reached. The host and the base path are on the cited
    // line or a part (a templated host's values-file line); the component it reaches resolves.
    if (f.kind === "deploy" && (f.host !== undefined || f.basePath !== undefined)) {
      if (f.host !== undefined && TEMPLATED.test(f.host))
        problem(
          f,
          "exposure-template",
          `${label} host "${f.host}" is a template: give the host the values file sets, with that line in cite.with (one fact per environment's values file, each with its env)`,
        );
      else if (f.host !== undefined && serviceAddress(f) !== undefined) {
        // A Service's in-cluster address is written whole on no line: its name, its namespace
        // and its port each are, on the cited line or a part (beta.10).
        const a = serviceAddress(f)!;
        const parts: [string, string][] = [
          ["name", a.name],
          ["namespace", a.namespace],
          ...(a.port !== undefined ? [["port", String(a.port)] as [string, string]] : []),
        ];
        for (const [what, value] of parts)
          add(f, checkCite(f.cite, [{ kind: "word", value }], `${label} host's ${what}`, false));
      } else if (f.host !== undefined)
        add(f, checkCite(f.cite, [{ kind: "word", value: f.host }], `${label} host`, false));
      if (f.basePath !== undefined && isPatternPath(f.basePath))
        problem(
          f,
          "exposure-regex",
          `${label} basePath "${f.basePath}" is a regular expression: write its plain prefix, "${plainPathPrefix(f.basePath)}" (the segments before the first pattern), and keep the line that writes the expression cited`,
        );
      else if (f.basePath !== undefined)
        add(
          f,
          checkCite(
            f.cite,
            [routeOrWord(f.basePath), { kind: "word", value: f.basePath }],
            `${label} basePath`,
            false,
          ),
        );
      const inModule = f.exposes !== undefined ? repoModule(f.exposes) : undefined;
      if (inModule && estate && estate.has(factIdPart(inModule.repo))) {
        const known = repoComponents.get(factIdPart(inModule.repo));
        if (known && !known.has(factIdPart(inModule.module)))
          problem(
            f,
            "exposure-component",
            `${label} exposes "${f.exposes}": ${inModule.repo}'s facts name no component ${inModule.module} (they name ${[...known].sort().join(", ")}); name the module as its facts do, or write a question when no file says which`,
          );
      } else if (
        f.exposes !== undefined &&
        estate &&
        !estate.has(factIdPart(inModule?.repo ?? f.exposes))
      )
        problem(
          f,
          "exposure-component",
          `${label} exposes "${f.exposes}", which is no component or repo of the estate (repos.manifest.yaml): name the component the route reaches, or write a question when no file says which`,
        );
      if (f.exposes === undefined && !serves)
        problem(
          f,
          "exposure-component",
          `${label} says where a component is reached and names none: this repo's facts serve nothing, so its routes reach another repo's component; name it in exposes (one of the estate's components), or write a question when no file says which`,
        );
    }
    // A-framework: the name follows from the declaration on the cited line, and a version, where
    // one is claimed, is written on that line or on one of its `cite.with` parts (a property, a
    // parent pom's version, a <TargetFramework>, a dependency-management block).
    if (f.kind === "framework") {
      const bad = frameworkNameProblem(f, rules.frameworks);
      if (bad) problem(f, "framework-name", `${label} ${bad}`);
      if (f.version !== undefined)
        add(f, checkCite(f.cite, [{ kind: "word", value: f.version }], `${label} version`, false));
    }
    if (f.kind === "flow") {
      f.steps.forEach((s, i) =>
        add(f, checkCite(s.cite, stepClaims(s.kind, s.cite.value), `${label} step ${i + 1}`)),
      );
      f.errors.forEach((e, i) =>
        add(f, checkCite(e.cite, [routeOrWord(e.cite.value)], `${label} error ${i + 1}`)),
      );
    }
  }

  // references: dangling first, then whatever names a rejected fact, until nothing changes
  const ids = new Set(facts.map((f) => f.id));
  for (const f of facts) {
    if (other.has(f.id)) continue;
    for (const d of refsOf(f).filter((r) => !ids.has(r.id)))
      problem(
        f,
        "dangling-ref",
        `${f.kind} ${f.id} names ${d.field} "${d.id}", which is no fact in this file`,
      );
  }
  // B-fixes, problem 6: a call-out step names the call it makes (a call fact), or, for a call
  // through a cloud SDK with no path, the client's config fact the protocol records instead.
  // One that names neither can't say where the flow goes, so the map couldn't write the flow.
  const byId = new Map(facts.map((f) => [f.id, f]));
  for (const f of facts) {
    if (other.has(f.id) || f.kind !== "flow") continue;
    f.steps.forEach((s, i) => {
      if (s.kind !== "call-out") return;
      const to = s.ref === undefined ? undefined : byId.get(s.ref);
      if (to?.kind === "call" || to?.kind === "config") return;
      // a ref to no fact at all is said once, as dangling
      if (s.ref !== undefined && !to) return;
      const what = s.ref === undefined ? "names no fact" : `names ${to!.kind} ${s.ref}`;
      problem(
        f,
        "call-out-no-call",
        `flow ${f.id} step ${i + 1} is a call-out that ${what} (${s.cite.file}:${s.cite.line}): give it ref, the id of the call fact it makes, or, for a call through a cloud SDK with no path, the config fact of the client's setting; or make it another kind of step if it calls nothing`,
      );
    });
  }
  // C-estate: a publish step names the event it publishes (the event-topic or mq-queue call
  // fact), so the estate join can follow it to every listener of the topic.
  for (const f of facts) {
    if (other.has(f.id) || f.kind !== "flow") continue;
    f.steps.forEach((s, i) => {
      if (s.kind !== "publish") return;
      const to = s.ref === undefined ? undefined : byId.get(s.ref);
      if (to?.kind === "call" && (to.callType === "event-topic" || to.callType === "mq-queue"))
        return;
      if (s.ref !== undefined && !to) return;
      const what =
        to === undefined
          ? "names no fact"
          : `names ${to.kind === "call" ? `a ${to.callType} call` : to.kind} ${s.ref}`;
      problem(
        f,
        "publish-no-event",
        `flow ${f.id} step ${i + 1} is a publish that ${what} (${s.cite.file}:${s.cite.line}): give it ref, the id of the event-topic or mq-queue call fact it publishes (write that call fact if there is none); or make it another kind of step if it publishes nothing`,
      );
    });
  }

  const rejected = new Map<string, Rejected>();
  for (const f of facts) {
    const ps = found.get(f.id);
    if (!ps?.length) continue;
    rejected.set(
      f.id,
      ps.length === 1
        ? { fact: f, ...ps[0]! }
        : {
            fact: f,
            code: ps[0]!.code,
            message: ps.map((p, i) => `(${i + 1}) ${p.message}`).join(" "),
            problems: ps,
          },
    );
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const f of facts) {
      if (rejected.has(f.id)) continue;
      const r = refsOf(f).find((x) => rejected.has(x.id));
      if (r) {
        rejected.set(f.id, {
          fact: f,
          code: "ref-rejected",
          message: `${f.kind} ${f.id} names ${r.field} "${r.id}", which was rejected (${rejected.get(r.id)!.code})`,
        });
        changed = true;
      }
    }
  }

  // The kept facts, as their writer wrote them, with two changes to the bytes on disk: a quote's
  // secret value is redacted, and a quote a file of this kind can't bear is dropped. Nothing a
  // fact claims is taken out here: a claim the catalog mustn't carry is dropped on the way into
  // the catalog instead (ADR 0124 addendum A-uncited), so the warning for it survives a `--write`.
  let redacted = 0;
  let quotesDropped = 0;
  const fixQuote = (c: Cite): Cite => {
    if (!c.quote) return c;
    const line = (linesOf(c.file) ?? [])[c.line - 1] ?? "";
    if (quoteNotRequired(c.file, line) && !quoteMatches(line, c.quote)) {
      quotesDropped++;
      const { quote: _drop, ...rest } = c;
      return rest;
    }
    const q = redactSecrets(c.quote);
    if (q !== c.quote) redacted++;
    return { ...c, quote: q };
  };
  const authUncited: UncitedAuth[] = [];
  const methodUnseen: MethodUnseen[] = [];
  // P2: a forwarding call's route, among the kept facts.
  const kept = new Map(facts.filter((f) => !rejected.has(f.id)).map((f) => [f.id, f]));
  const factById = (id: string) => kept.get(id);
  const accepted: Fact[] = facts
    .filter((f) => !rejected.has(f.id))
    .map((f) => {
      o.room?.();
      // A reader can't vouch for itself: only a fact a person made keeps a person's mark, and a
      // sample session's mark stands only on a fact a person made too (the sample check writes
      // its own results, not this file). Everything else is verified by the line check.
      const verified = f.by === "person" && f.verified !== "none" ? f.verified : "line";
      const base = { ...f, verified, cite: fixQuote(f.cite) } as Fact;
      // A-read problem 4, as A-uncited turns it round: an auth no line is cited for is said here
      // and kept in the fact, since it is what the reader wrote; `catalogAuth` leaves it out of
      // the catalog. A person's own fact is their word, marked as theirs, and is not listed.
      if (base.kind === "entry" && base.auth !== undefined && !base.authCite && f.by !== "person")
        authUncited.push({
          id: base.id,
          auth: base.auth,
          cite: `${base.cite.file}:${base.cite.line}`,
        });
      // P2: the method claimed, looked for on the lines the fact cites; a note, never a rejection.
      const unseen = methodUnseenOf(base, linesOf, factById);
      if (unseen) methodUnseen.push(unseen);
      if (base.kind === "flow")
        return {
          ...base,
          steps: base.steps.map((s) => ({ ...s, cite: fixQuote(s.cite) })),
          errors: base.errors.map((e) => ({ ...e, cite: fixQuote(e.cite) })),
        } as Fact;
      return base;
    });

  // coverage
  const excludeRes = (o.exclude ?? []).map(globToRegExp);
  const sources: string[] = [];
  const excluded: string[] = [];
  for (const p of o.source.list()) {
    o.room?.();
    // A-room: every file of the repo passes through here, and only to ask whether it counts as
    // source. Its lines are read, looked at and freed: nothing of a file nothing cites is held.
    const ls = readLines(p) ?? [""];
    if (!isSourceFile(p, ls[0] ?? "", ls, rules)) continue;
    if (excludeRes.some((re) => re.test(p))) excluded.push(p);
    else sources.push(p);
  }
  // A file is read when a kept fact cites it (its cite and parts, an entry's authCite, a flow's
  // steps and error paths: A-read, problem 1, as `citedFiles` lists them for the carry), or the
  // reader opened it through Atticus's tools.
  const touched = new Set<string>(o.routed ?? []);
  for (const f of accepted) for (const p of citedFiles(f)) touched.add(p);
  // A-read, problem 2: what the reader says it read and found nothing in, each path checked.
  const allFiles = o.source.list();
  const isSource = new Set(sources);
  const reviewedSet = new Set<string>();
  const reviewed: ReviewedFiles[] = [];
  const reviewedProblems: ReviewedProblem[] = [];
  const reviewedDropped: ReviewedProblem[] = [];
  const reviewedGlobs: { entry: ReviewedEntry; files: string[] }[] = [];
  for (const r of o.reviewed ?? []) {
    const refuse = (message: string) =>
      reviewedProblems.push({
        ...(r.line !== undefined ? { line: r.line } : {}),
        path: r.path,
        why: r.why,
        message: `${r.line !== undefined ? `line ${r.line}: ` : ""}${r.path} ${message}`,
      });
    if (!insideRepo(r.path)) {
      refuse("is outside the repo");
      continue;
    }
    if (isSecretPath(r.path)) {
      refuse("is a secret's file, which is never read into a map");
      continue;
    }
    // A range of a file read in line ranges (A-ledger): the file, and lines it has.
    const range = lineRangeOf(r.path);
    if (range) {
      const text = allFiles.includes(range.file) ? o.source.read(range.file) : undefined;
      if (text === undefined) {
        refuse("is not in the repo at this commit; name a file you read");
        continue;
      }
      const last = text.split(/\r?\n/).length;
      if (range.from < 1 || range.from > range.to || range.to > last) {
        refuse(`is past the file's last line (${last}) or out of order; name the lines you read`);
        continue;
      }
    }
    const target = range ? range.file : r.path;
    const re = !range && isGlob(r.path) ? globToRegExp(r.path) : undefined;
    const matched = re ? allFiles.filter((p) => re.test(p)) : allFiles.filter((p) => p === target);
    if (!matched.length) {
      // R6: a glob matching nothing stands for no file, so it excuses none: dropped with a note.
      if (re)
        reviewedDropped.push({
          ...(r.line !== undefined ? { line: r.line } : {}),
          path: r.path,
          why: r.why,
          message: `${r.line !== undefined ? `line ${r.line}: ` : ""}${r.path} matches no file in the repo at this commit; dropped (it stands for no file)`,
        });
      else refuse("is not in the repo at this commit; name a file you read");
      continue;
    }
    const files = matched.filter((p) => isSource.has(p) && !touched.has(p)).sort();
    for (const p of files) reviewedSet.add(p);
    reviewed.push({ path: r.path, why: r.why, files });
    if (re) reviewedGlobs.push({ entry: r, files });
  }
  const read = sources.filter((p) => touched.has(p)).sort();
  const reviewedFiles = sources.filter((p) => reviewedSet.has(p)).sort();
  const unknown = sources.filter((p) => !touched.has(p) && !reviewedSet.has(p)).sort();
  const total = read.length + reviewedFiles.length + unknown.length;
  const ratio = total === 0 ? 1 : Math.round((read.length / total) * 1000) / 1000;

  // R1: the lines the reader skipped, a note for it to check; nothing here keeps or drops a fact.
  // A spec's operations are matched to the entries; every other file read is looked at for path,
  // URL and topic strings the kept facts don't cite or name. One file's lines at a time.
  const ix = indexFacts(accepted);
  const specOpsUncovered: SpecOpUncovered[] = [];
  const specs = new Set<string>();
  for (const p of sources) {
    if (notReadForSkipped(p, rules)) continue;
    o.room?.();
    const text = o.readers !== false && /\.(ya?ml|json)$/i.test(p) ? o.source.read(p) : undefined;
    const ops = text === undefined ? undefined : specOpsUncoveredIn(p, text, accepted);
    if (!ops) continue;
    specs.add(p);
    specOpsUncovered.push(...ops);
  }
  const skippedIn = (p: string): SkippedLine[] => {
    if (specs.has(p) || notReadForSkipped(p, rules)) return [];
    o.room?.();
    const ls = readLines(p);
    return ls
      ? candidatesIn(p, ls).flatMap((c) => (factsCover(p, c, ix) ? [] : [skippedOf(p, c)]))
      : [];
  };
  const skipped = read.flatMap(skippedIn);
  const reviewedHolds = reviewedGlobs.flatMap(({ entry, files }) => {
    const held = files.flatMap(skippedIn);
    return held.length ? [reviewedHoldsOf(entry, held)] : [];
  });

  return {
    accepted,
    // a rejected fact goes back as it was read, at its own commit, even one that was carried
    rejected: [...rejected.values()]
      .map((r) =>
        carriedFrom.has(r.fact.id)
          ? { ...r, fact: { ...r.fact, commit: carriedFrom.get(r.fact.id)! } as Fact }
          : r,
      )
      .sort((a, b) => (a.fact.id < b.fact.id ? -1 : a.fact.id > b.fact.id ? 1 : 0)),
    coverage: { read, reviewed: reviewedFiles, unknown, excluded: excluded.sort(), ratio },
    redacted,
    quotesDropped,
    carried: accepted.flatMap((f) =>
      carriedFrom.has(f.id) ? [{ id: f.id, from: carriedFrom.get(f.id)! }] : [],
    ),
    corrections: { applied: corrected.applied, stale: corrected.stale },
    entriesNoFlowFollows: entriesNoFlowFollows(accepted, rules),
    reviewed,
    reviewedProblems,
    reviewedDropped,
    authUncited: authUncited.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    methodUnseen: methodUnseen.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    skipped,
    reviewedHolds,
    specOpsUncovered,
    frameworkGaps: frameworkGaps(accepted, rules.frameworks),
  };
}
