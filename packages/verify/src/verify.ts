import {
  APIGEE_BUNDLE,
  citedFiles,
  claimOnLines,
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
import { pageRouteMatches } from "./pages.js";
import { isGlob, type ReviewedEntry } from "./reviewed.js";
import { insideRepo, type FileSource } from "./source.js";

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
  | "framework-name";

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

/** An entry whose `auth` was left out because no line was cited for it (`authCite`). */
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
   * A note, not a rejection (A-read): the kept entries whose `auth` was left out because no line
   * that sets it was cited (`authCite`). In id order.
   */
  authUncited: UncitedAuth[];
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
export function entriesNoFlowFollows(facts: readonly Fact[]): UnfollowedEntry[] {
  const started = new Set(facts.flatMap((f) => (f.kind === "flow" ? [f.entry] : [])));
  return facts
    .flatMap((f) =>
      f.kind === "entry" &&
      FOLLOWED_TYPES.includes(f.entryType) &&
      !started.has(f.id) &&
      // An Apigee route forwards; its forwarding call is its flow (ADR 0124 addendum A-gateway).
      !APIGEE_BUNDLE.test(f.cite.file)
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
}

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
  /(^|\/)(src\/test|src\/it|test|tests|__tests__|__mocks__|spec|specs|e2e|testdata|test-data|fixtures)\//i,
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
export function isSourceFile(path: string, firstLine = "", lines?: readonly string[]): boolean {
  if (isSecretPath(path) || LOCKFILE.test(path)) return false;
  if (NOT_PRODUCT.some((re) => re.test(path)) || isLocaleBundle(path)) return false;
  if (lines && isDataFile(path, lines)) return false;
  if (quoteNotRequired(path, firstLine)) return false;
  return SOURCE_EXT.test(path) || SOURCE_NAME.test(path);
}

const lastPart = (s: string) => s.split(".").pop() ?? s;
/** A line that is all comment: `//`, `/*`, `*`, `#` (not a C# directive), `<!--` or SQL's `-- `. */
const isCommentLine = (l: string) =>
  /^\s*(\/\/|\/\*|\*|<!--|-- |#(?!\s*(region|endregion|if|elif|else|endif|define|undef|pragma|nullable|include|import)\b)(?!!))/.test(
    l,
  );

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
  const linesCache = new Map<string, string[] | undefined>();
  const linesOf = (path: string) => {
    if (!linesCache.has(path)) {
      // a path a rule builds (`app/models/user.rb`) is read only when it stays in the repo
      const text = insideRepo(path) && !isSecretPath(path) ? o.source.read(path) : undefined;
      linesCache.set(
        path,
        text === undefined ? undefined : text.replace(/\r\n?/g, "\n").split("\n"),
      );
    }
    return linesCache.get(path);
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
      derivedHolds(c, derivedHere(), partLines, partsNamePath);
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
    // A-framework: the name follows from the declaration on the cited line, and a version, where
    // one is claimed, is written on that line or on one of its `cite.with` parts (a property, a
    // parent pom's version, a <TargetFramework>, a dependency-management block).
    if (f.kind === "framework") {
      const bad = frameworkNameProblem(f);
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

  // the kept facts: verified by the line check unless a person or a sample already did, quotes redacted
  let redacted = 0;
  const fixQuote = (c: Cite): Cite => {
    if (!c.quote) return c;
    const lines = linesOf(c.file) ?? [];
    const line = lines[c.line - 1] ?? "";
    if (quoteNotRequired(c.file, line) && !quoteMatches(line, c.quote)) {
      const { quote: _drop, ...rest } = c;
      return rest;
    }
    const q = redactSecrets(c.quote);
    if (q !== c.quote) redacted++;
    return { ...c, quote: q };
  };
  const authUncited: UncitedAuth[] = [];
  const accepted: Fact[] = facts
    .filter((f) => !rejected.has(f.id))
    .map((f) => {
      // A reader can't vouch for itself: only a fact a person made keeps a person's mark, and a
      // sample session's mark stands only on a fact a person made too (the sample check writes
      // its own results, not this file). Everything else is verified by the line check.
      const verified = f.by === "person" && f.verified !== "none" ? f.verified : "line";
      const base = { ...f, verified, cite: fixQuote(f.cite) } as Fact;
      // A-read, problem 4: an auth no line is cited for is left out, so the catalog never says
      // it; a person's own fact keeps it (it is their word, marked as theirs).
      if (base.kind === "entry" && base.auth !== undefined && !base.authCite && f.by !== "person") {
        authUncited.push({
          id: base.id,
          auth: base.auth,
          cite: `${base.cite.file}:${base.cite.line}`,
        });
        const { auth: _auth, ...rest } = base;
        return rest as Fact;
      }
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
    const ls = linesOf(p) ?? [""];
    if (!isSourceFile(p, ls[0] ?? "", ls)) continue;
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
    const re = isGlob(r.path) ? globToRegExp(r.path) : undefined;
    const matched = re ? allFiles.filter((p) => re.test(p)) : allFiles.filter((p) => p === r.path);
    if (!matched.length) {
      refuse(
        re
          ? "matches no file in the repo at this commit; name the files you read"
          : "is not in the repo at this commit; name a file you read",
      );
      continue;
    }
    const files = matched.filter((p) => isSource.has(p) && !touched.has(p)).sort();
    for (const p of files) reviewedSet.add(p);
    reviewed.push({ path: r.path, why: r.why, files });
  }
  const read = sources.filter((p) => touched.has(p)).sort();
  const reviewedFiles = sources.filter((p) => reviewedSet.has(p)).sort();
  const unknown = sources.filter((p) => !touched.has(p) && !reviewedSet.has(p)).sort();
  const total = read.length + reviewedFiles.length + unknown.length;
  const ratio = total === 0 ? 1 : Math.round((read.length / total) * 1000) / 1000;

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
    carried: accepted.flatMap((f) =>
      carriedFrom.has(f.id) ? [{ id: f.id, from: carriedFrom.get(f.id)! }] : [],
    ),
    corrections: { applied: corrected.applied, stale: corrected.stale },
    entriesNoFlowFollows: entriesNoFlowFollows(accepted),
    reviewed,
    reviewedProblems,
    authUncited: authUncited.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    frameworkGaps: frameworkGaps(accepted),
  };
}
