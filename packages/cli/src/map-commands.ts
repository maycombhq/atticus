import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import {
  assistantTier,
  ABOUT_RULE,
  mapBatchInstructions,
  taughtFrameworksText,
  readProbes,
  tierSource,
  tierWords,
  type TierReport,
} from "@maycombhq/assistant-files";
import {
  AgentDefinition,
  citedFiles,
  descriptionNote,
  descriptionTrust,
  REPO_DESCRIPTION_MAX,
  saysNotProduct,
  Fact,
  factsDirOf,
  factsRelOf,
  listQuestions,
  loadOrgPack,
  orgPackDirOf,
  parseFacts,
  runsDirOf,
  writeFileAtomic,
  type FrameworkModel,
  type OrgPack,
  type Question,
  type RepoDescription,
  type RepoDescriptionCite,
} from "@maycombhq/core";
import {
  buildContextPack,
  currentPromptLimit,
  DATA_RULE,
  estimateTokens,
  HandoffRuntime,
  promptBudget,
  PromptTooLong,
  wrapData,
  type AiRuntime,
  type Run,
  type SourceInput,
} from "@maycombhq/ai";
import {
  dirSource,
  exclusionYaml,
  FILE_KINDS,
  frameworkTopics,
  frameworkTopicsOfType,
  kindsOf,
  numberedSlice,
  onlyFiles,
  planBatches,
  planParts,
  proposeExclusions,
  SHOWN_PROPOSALS,
  rereadPlan,
  SESSION_TOKENS,
  sameCommit,
  sliceText,
  staleMessage,
  verifyFacts,
  type FileKind,
  type FrameworkTopic,
  type FileSlice,
  type FileSource,
  type Rejected,
  type RereadPlan,
} from "@maycombhq/verify";
import { loadRepos, type GitRunner } from "@maycombhq/workspace";
import type { Output } from "./commands.js";
import {
  carryOf,
  checkoutOf,
  excludesOf,
  headOf,
  raiseReadQuestions,
  readCorrections,
  readReviewed,
  reviewedProblemsOf,
  writeVerifyFiles,
  type VerifySummary,
} from "./facts-files.js";
import {
  loadReadPlan,
  partOfWords,
  readPlanProgress,
  readPlanRelOf,
  writeReadPlan,
} from "./map-parts.js";

/**
 * atticus map <repo> (ADR 0124 §4, tiers 2 and 3): an assistant that can't open files reads the
 * repo in batches. Atticus lists the repo's source files, orders them (build and deploy files,
 * config, entry points first), slices them into batches whose prompt fits the model's limit (ADR
 * 0112 `--max-tokens`), and hands one batch at a time through the AI runtime: each prompt carries
 * the reading protocol, the batch's files with line numbers, the facts already kept (ids and
 * claims, so a fact can name them) and what was rejected last time with the lines it cited. Each
 * answer (JSON lines) is merged into the facts file and verified at once.
 *
 * Hand-off mode stops after each hand-off; `--next` reads the answer and hands the next batch
 * (state in the run folder). `--copy` prints the prompt to paste and reads the answer back from a
 * file or stdin. Model, replay and mock runtimes answer at once, so every batch runs in one call.
 * After the last batch, the facts still rejected get one round of their own.
 */

export interface MapOptions {
  /** The repo's checkout, when not the base clone or (adopted in place) the root itself. */
  dir?: string;
  /** The commit to read at; default the checkout's HEAD. */
  commit?: string;
  /** Say what the read will cost (files, tokens, batches, the tier) and do nothing else. */
  estimate?: boolean;
  /** Read the answer of the batch handed off and hand the next. */
  next?: boolean;
  /** The same as next, naming the run (the hand-off's resume). */
  resume?: string;
  /** Start again though a read is under way. */
  force?: boolean;
  /** Print the prompt to paste, instead of handing it to an assistant. */
  copy?: boolean;
  /** With --copy: the file the pasted answer was saved to, or "-" for stdin. */
  answer?: string;
  json?: boolean;
  /** The model's limit; default the step's (--max-tokens), else runtime.yaml's maxInput. */
  maxTokens?: number;
}

export interface MapDeps {
  /** Needed to hand off or run a batch; not for --estimate. */
  runtime?: AiRuntime;
  /** Read the answer from stdin (--answer -). */
  stdin?: () => Promise<string>;
  now?: () => Date;
  /** The git runner the diff since the facts' commit is read with (tests mock it). */
  git?: GitRunner;
}

/** The step's agent: the org pack's own `repo-reader`, else this one. */
export const REPO_READER = "repo-reader";
/** The answer's file in the run folder. */
const OUTPUT = "facts.jsonl";
/** Tokens kept in each prompt for the facts already kept, the answers on file and the feedback. */
const KEPT_RESERVE = 1500;
/** The smallest the kept-facts reserve may shrink to when a description is paid out of it. */
const MIN_KEPT_RESERVE = 1200;
/** The smallest room for files that is worth a prompt. */
const MIN_ROOM = 300;
/** The limit a batch estimate uses when none is given: GPT-4o mini through Copilot (ADR 0112). */
const EXAMPLE_LIMIT = 12_078;
/** Lines each side of a rejected fact's cited line, shown back to the reader. */
const AROUND = 12;

export function repoReaderAgent(op?: Pick<OrgPack, "agents" | "runtime">): AgentDefinition {
  const own = op?.agents.find((a) => a.id === REPO_READER);
  if (own) return own;
  return AgentDefinition.parse({
    schemaVersion: 1,
    id: REPO_READER,
    role: "architect",
    description:
      "Reads a repo's code into facts (ADR 0124): what it answers to, calls, stores, the fields that cross those boundaries, its deployment and config, each citing its file and line.",
    inputs: ["repo-code"],
    outputArtifact: "data",
    tokenBudget: op?.runtime.budgets.defaultTokens ?? 150_000,
    allowedRuntimes: ["hand-off", "model", "headless-claude-code", "mock", "replay"],
  });
}

interface MapState {
  schemaVersion: 1;
  repo: string;
  commit: string;
  maxTokens?: number;
  room: number;
  batches: FileSlice[][];
  /** The batch to hand next; batches.length is the fix round. */
  next: number;
  waiting?: { runId: string; batch: number };
  /** The facts the last verify rejected, fed back in the next prompt. */
  rejected: { id: string; code: string; message: string; fact: Fact }[];
  /** Lines of the last answer that weren't facts or questions, and why. */
  problems: string[];
  fixRound?: boolean;
  done?: boolean;
  last?: VerifySummary;
  /**
   * A re-read (ADR 0124 addendum A-incremental): the facts were of these earlier commits, and the
   * batches hold only the files changed since; the facts citing them were handed back to rewrite.
   */
  reread?: { from: string[]; carried: number; facts: number };
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const batches = (n: number) => `${n} ${n === 1 ? "batch" : "batches"}`;
const changeOf = (repo: string) => `map-${repo}`;
const stateFile = (root: string, repo: string) =>
  join(runsDirOf(root), changeOf(repo), "state.json");

async function readState(root: string, repo: string): Promise<MapState | undefined> {
  const text = await readFile(stateFile(root, repo), "utf8").catch(() => undefined);
  return text ? (JSON.parse(text) as MapState) : undefined;
}
async function saveState(root: string, s: MapState): Promise<void> {
  await mkdir(dirname(stateFile(root, s.repo)), { recursive: true });
  await writeFileAtomic(stateFile(root, s.repo), JSON.stringify(s, null, 2) + "\n");
}

const LEVELS = ["public", "internal", "confidential", "restricted"];

/**
 * The tokens a prompt keeps for its instructions, the data rule and the frame around the files:
 * with the core rules alone, or with the topic rules of these kinds of file too (ADR 0124
 * addendum A-lean).
 */
function instructionTokens(
  repo: string,
  commit: string,
  kinds: readonly FileKind[] = [],
  /**
   * The frameworks the prompts of this read carry rules for (ADR 0124 addendum A-framework).
   * Left out, every framework's rules are counted, as `FACT_RULES` has them; the planner passes
   * what the read will really carry, so the plan and the prompts agree.
   */
  frameworks?: readonly FrameworkTopic[],
): number {
  return (
    // The rule asking what the repo is (ADR 0128) isn't counted here: it is paid for out of the
    // reserve below (`reserveFor`), so the room planned for files is what it always was.
    estimateTokens(mapBatchInstructions({ repo, commit, batch: 999, of: 999, kinds, frameworks })) +
    estimateTokens(DATA_RULE) +
    // the <atticus-data> wrapper around the batch's files
    60
  );
}

/**
 * The repo's description as the manifest holds it (ADR 0128), read for every prompt, so a line
 * a person adds part-way through a read is carried by the batches after it.
 */
async function aboutOf(root: string, repo: string): Promise<RepoDescription | undefined> {
  return (await loadRepos(root).catch(() => [])).find((r) => r.id === repo)?.description;
}

/** The source a repo's description goes in as: untrusted, so the pack wraps it as data. */
function aboutSource(repo: string, d: RepoDescription): SourceInput {
  return {
    id: "6-about",
    kind: "document",
    origin: "repos.manifest.yaml",
    text: descriptionNote(repo, d),
    classification: "internal",
    priority: 9,
  };
}

/** What a description costs a prompt, wrapper and all, so the batch planner leaves room for it. */
const aboutTokens = (repo: string, d?: RepoDescription): number =>
  d
    ? estimateTokens(
        wrapData(
          { id: "6-about", origin: "repos.manifest.yaml", kind: "document" },
          descriptionNote(repo, d),
        ),
      )
    : 0;

/**
 * What a batch's topic rules add to the core's instructions, for the batch planner. The
 * frameworks the read will carry rules for are counted in (A-framework), so the room the plan
 * leaves each batch is the room its prompt really has.
 */
const overheadOf = (repo: string, commit: string, frameworks: readonly FrameworkTopic[]) => {
  const core = instructionTokens(repo, commit, [], frameworks);
  return (kinds: readonly FileKind[]) => instructionTokens(repo, commit, kinds, frameworks) - core;
};

/**
 * The frameworks a read carries rules for (ADR 0124 addendum A-framework): what the repo's own
 * framework facts say it is built on, else — for the first read, before any build file has been
 * read — what its type in the manifest suggests, which is a hint and never a fact. Nothing at
 * all means no framework rule goes in a prompt: a framework's rule refines a rule that is
 * already there, and is bought by evidence.
 */
async function frameworksFor(
  root: string,
  repo: string,
  facts: readonly Fact[],
): Promise<FrameworkTopic[]> {
  const fromFacts = frameworkTopics(facts);
  if (fromFacts) return fromFacts;
  const type = (await loadRepos(root).catch(() => [])).find((r) => r.id === repo)?.type;
  return frameworkTopicsOfType(type);
}

const joinKinds = (a: readonly FileKind[], b: readonly FileKind[]) =>
  FILE_KINDS.filter((k) => a.includes(k) || b.includes(k));

/** What a fact claims, in a few words, for the list of facts already kept. */
function claimOf(f: Fact): string {
  switch (f.kind) {
    case "entry":
    case "call":
      return `${f.method ? `${f.method} ` : ""}${f.path}`;
    case "store":
      return `${f.op} ${f.store} ${f.name}`;
    case "field":
      return `${f.owner}.${f.name}`;
    case "deploy":
      return `${f.platform}${f.resourceName ? ` ${f.resourceName}` : ""}`;
    case "config":
      return f.key;
    case "framework":
      return `${f.name}${f.version ? ` ${f.version}` : ""}`;
    case "flow":
      return f.name;
  }
}

/** The answer's lines: facts (marked as the assistant's, unverified), questions, and problems. */
export function readAnswer(
  text: string,
  repo: string,
  commit: string,
): {
  facts: Fact[];
  questions: unknown[];
  problems: string[];
  /** The one-line description the reader drafted, when it wrote one (ADR 0128). */
  about?: { text: string; cites: RepoDescriptionCite[] };
} {
  const facts = new Map<string, Fact>();
  const questions: unknown[] = [];
  const problems: string[] = [];
  let about: { text: string; cites: RepoDescriptionCite[] } | undefined;
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("```")) return;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      problems.push(`line ${i + 1} is not one JSON object: ${line.slice(0, 80)}`);
      return;
    }
    if (!json || typeof json !== "object" || Array.isArray(json)) {
      problems.push(`line ${i + 1} is not one JSON object`);
      return;
    }
    const o = json as Record<string, unknown>;
    if ("question" in o && !("kind" in o)) {
      questions.push(o);
      return;
    }
    // One line saying what the repo is (ADR 0128): a draft for a person, never a fact. The
    // first one wins, so a reader that writes it in every batch doesn't flip-flop.
    if ("about" in o && !("kind" in o)) {
      const text = typeof o.about === "string" ? o.about.trim() : "";
      if (!text) {
        problems.push(`line ${i + 1}: "about" needs one line saying what the repo is`);
        return;
      }
      const cites: RepoDescriptionCite[] = (Array.isArray(o.cites) ? o.cites : [])
        .flatMap((c) => {
          const x = c as { file?: unknown; line?: unknown };
          return typeof x.file === "string" && Number.isInteger(x.line) && Number(x.line) > 0
            ? [{ file: x.file, line: Number(x.line) }]
            : [];
        })
        .slice(0, 6);
      if (!cites.length) {
        problems.push(
          `line ${i + 1}: "about" needs "cites": the file and line it was read from, as a fact cites its line`,
        );
        return;
      }
      about ??= { text: text.slice(0, REPO_DESCRIPTION_MAX), cites };
      return;
    }
    // Only the verifier says a fact is verified, and only a person's edit says a person did.
    const r = Fact.safeParse({ repo, commit, ...o, verified: "none", by: "assistant" });
    if (r.success) facts.set(r.data.id, r.data);
    else
      problems.push(
        `line ${i + 1}${typeof o.id === "string" ? ` (${o.id})` : ""}: ${r.error.issues
          .map((x) => `${x.path.join(".") || "(fact)"}: ${x.message}`)
          .join("; ")}`,
      );
  });
  return { facts: [...facts.values()], questions, problems, ...(about ? { about } : {}) };
}

/** A rejected fact as the reader gets it back: why, the fact, and the lines around its cite. */
function rejectedText(r: MapState["rejected"][number], source: FileSource): string {
  const text = source.read(r.fact.cite.file);
  const lines = text?.split(/\r?\n/).length ?? 0;
  const from = Math.max(1, r.fact.cite.line - AROUND);
  const to = Math.min(lines, r.fact.cite.line + AROUND);
  return [
    `${r.fact.id} was rejected (${r.code}): ${r.message}`,
    `The fact: ${JSON.stringify(r.fact)}`,
    ...(text !== undefined && from <= to
      ? [
          `${r.fact.cite.file} lines ${from}-${to} (numbered as in the file):`,
          numberedSlice(text, { from, to }),
        ]
      : []),
  ].join("\n");
}

function questionsText(qs: Question[]): string {
  return [
    "Questions already on file for this repo. Don't ask them again; follow each answer a person gave.",
    ...qs.map(
      (q) =>
        `- ${q.question} (${q.evidence.join(", ")}): ${
          q.state === "answered"
            ? `answered: ${q.answer?.text ?? q.options[(q.answer?.option ?? 1) - 1]?.label ?? ""}`
            : "waiting for a person"
        }`,
    ),
  ].join("\n");
}

function keptText(facts: Fact[], budgetTokens: number): string {
  const head =
    "Facts already kept (id, kind, claim, where). Name them by id; don't write them again.";
  const order = ["entry", "call", "store", "flow", "deploy", "config", "field"];
  const sorted = [...facts].sort(
    (a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.id.localeCompare(b.id),
  );
  const out = [head];
  let used = estimateTokens(head);
  for (const [i, f] of sorted.entries()) {
    const l = `- ${f.id} (${f.kind}): ${claimOf(f)} [${f.cite.file}:${f.cite.line}]`;
    if (used + estimateTokens(l) > budgetTokens - 20) {
      out.push(`... and ${sorted.length - i} more`);
      break;
    }
    out.push(l);
    used += estimateTokens(l);
  }
  return out.join("\n");
}

async function readFactsFile(root: string, repo: string): Promise<Fact[] | string> {
  const file = join(factsDirOf(root), `${repo}.jsonl`);
  if (!existsSync(file)) return [];
  const parsed = parseFacts(await readFile(file, "utf8"));
  if (parsed.ok) return parsed.facts;
  return `${factsRelOf(root)}/${repo}.jsonl does not read as facts (${parsed.issues[0]?.message ?? "?"}); fix it, or start again with --force after moving it aside.`;
}

/** What a re-read's prompts add to the protocol: only the changed files, rewrite or drop, keep the rest. */
function rereadInstructions(s: MapState): string {
  const r = s.reread!;
  return [
    `This is a re-read: the facts were read at ${r.from.map((c) => c.slice(0, 12)).join(", ")}, and the checkout moved to ${s.commit}. Only the files changed since are in these batches.`,
    `The ${plural(r.facts, "fact")} that cite a changed file are listed below as rejected (cite-changed): read the file again (a renamed file under its new path) and write each again at this commit under the same id, with its line as it is now, or leave it out if the code no longer says it.`,
    `The other ${plural(r.carried, "fact")} cite files that didn't change: they are kept and carried to this commit. Don't write them again; name them by id.`,
    "Write a fact for anything new in the changed files, as in a first read.",
  ].join("\n");
}

/**
 * A re-read (ADR 0124 addendum A-incremental): when facts are of an earlier commit that the
 * clone can compare with this one, the files changed since and the facts citing them.
 */
async function rereadOf(
  dir: string,
  facts: readonly Fact[],
  commit: string,
  source: FileSource,
  exclude: string[],
  git?: GitRunner,
): Promise<{ plan?: RereadPlan; missing: string[] }> {
  if (!facts.some((f) => !sameCommit(f.commit, commit))) return { missing: [] };
  const { carry, missing } = await carryOf(dir, facts, commit, git);
  if (!Object.keys(carry).length) return { missing };
  return { plan: rereadPlan({ facts, commit, carry, source, exclude }), missing };
}

/** The prompt of one batch (or of the fix round), fitted to the model's limit. */
const taughtOption = (models: FrameworkModel[]) => {
  const taught = taughtFrameworksText(models);
  return taught ? { taught } : {};
};

/** The build files a taught framework's artifact is declared in. */
const BUILD_FILE =
  /(^|\/)(pom\.xml|build\.gradle(\.kts)?|package\.json|[^/]+\.csproj|requirements[^/]*\.txt|pyproject\.toml|go\.mod)$/;

/**
 * The frameworks taught to Atticus (org-pack/frameworks/, ADR 0054) that this repo's build files
 * declare, by an artifact the model names (ADR 0124 addendum A-taught): a Maven `<artifactId>`
 * (a dependency or the `<parent>`), a Gradle coordinate, an npm package. In model order.
 */
export function taughtIn(source: FileSource, op: OrgPack): FrameworkModel[] {
  const models = op.frameworks.filter((m) => m.artifacts.length);
  if (!models.length) return [];
  const texts = source
    .list()
    .filter((p) => BUILD_FILE.test(p))
    .map((p) => source.read(p) ?? "");
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return models.filter((m) =>
    m.artifacts.some((a) => {
      const artifact = a.split(":")[1] ?? a;
      const declared = new RegExp(
        `<artifactId>\\s*${esc(artifact)}\\s*</artifactId>|["':]${esc(artifact)}["':@]`,
      );
      return texts.some((t) => declared.test(t));
    }),
  );
}

async function packFor(
  root: string,
  s: MapState,
  batch: number,
  source: FileSource,
  op: OrgPack,
  now: Date,
) {
  const agent = repoReaderAgent(op);
  const budget = op.runtime.budgets.perAgent[agent.id] ?? agent.tokenBudget;
  const fix = batch >= s.batches.length;
  const about = await aboutOf(root, s.repo);
  // What the description (or the line asking for one) leaves for the facts on file (ADR 0128).
  const reserve = reserveFor(s.repo, about);
  const kept = await readFactsFile(root, s.repo);
  const facts = typeof kept === "string" ? [] : kept;
  const onFile = (await listQuestions(root, { repo: s.repo })).questions.filter(
    (q) => q.state !== "retired",
  );
  const slices = fix ? [] : s.batches[batch]!;
  const rejected = s.rejected.map((r) => rejectedText(r, source));
  // The topic rules of the batch's files (planned to fit), and of the files its rejected facts
  // cite when those rules fit the reserve beside the rejected facts themselves (A-lean). The fix
  // round has no files: its rejected facts' kinds.
  const own = kindsOf(slices.map((x) => x.path));
  const theirs = kindsOf(s.rejected.flatMap((r) => citedFiles(r.fact)));
  const both = joinKinds(own, theirs);
  const extra =
    instructionTokens(s.repo, s.commit, both) - instructionTokens(s.repo, s.commit, own);
  const kinds = fix
    ? theirs
    : extra + rejected.reduce((n, t) => n + estimateTokens(t), 0) <= reserve
      ? both
      : own;
  const sources: SourceInput[] = [
    {
      id: "0-instructions",
      kind: "instruction",
      origin: "atticus/map",
      text: mapBatchInstructions({
        repo: s.repo,
        commit: s.commit,
        batch: batch + 1,
        of: s.batches.length,
        ...(fix ? { fix: true } : {}),
        kinds,
        // A-framework: the frameworks the repo's own facts declare, else its type's hint. The
        // build files are read first, so from the second batch on this is what the code says.
        frameworks: await frameworksFor(root, s.repo, facts),
        // Nothing says what this repo is: ask for one line, cited, for a person to confirm.
        ...(about ? {} : { askAbout: true }),
        // A-taught: how to read the wrapper calls and annotations of the frameworks it is built on.
        ...taughtOption(taughtIn(source, op)),
      }),
      classification: "public",
      trusted: true,
    },
    ...(s.reread
      ? [
          {
            id: "0-reread",
            kind: "instruction" as const,
            origin: "atticus/map",
            text: rereadInstructions(s),
            classification: "public",
            trusted: true,
          },
        ]
      : []),
    ...(slices.length
      ? [
          {
            id: "1-files",
            kind: "code" as const,
            origin: slices.map((x) => `${x.path}#L${x.from}-${x.to}`).join(", "),
            text: slices.map((x) => sliceText(source, x)).join("\n\n"),
            classification: "internal",
            priority: 10,
          },
        ]
      : []),
    ...s.rejected.map((r, i) => ({
      id: `2-rejected-${String(i + 1).padStart(3, "0")}`,
      kind: "document" as const,
      origin: `${factsRelOf(root)}/${s.repo}.rejected.jsonl`,
      text: rejected[i]!,
      classification: "internal",
      priority: 6,
    })),
    ...(s.problems.length
      ? [
          {
            id: "3-problems",
            kind: "document" as const,
            origin: "the last answer",
            text: `Lines of your last answer that weren't kept:\n${s.problems.map((p) => `- ${p}`).join("\n")}`,
            classification: "internal",
            priority: 5,
          },
        ]
      : []),
    ...(onFile.length
      ? [
          {
            id: "4-questions",
            kind: "document" as const,
            origin: "questions/",
            text: questionsText(onFile),
            classification: "internal",
            priority: 4,
          },
        ]
      : []),
    // What a person says the repo is (ADR 0128), as data: it orients the read, never leads it.
    ...(about ? [aboutSource(s.repo, about)] : []),
    ...(facts.length
      ? [
          {
            id: "5-kept",
            kind: "document" as const,
            origin: `${factsRelOf(root)}/${s.repo}.jsonl`,
            text: keptText(facts, reserve),
            classification: "internal",
            priority: 3,
          },
        ]
      : []),
  ];
  const levels = op.pack?.classification ?? LEVELS;
  return {
    agent,
    pack: buildContextPack({
      change: changeOf(s.repo),
      agent: agent.id,
      budget,
      sources,
      levels,
      maxClassification: levels.includes("internal") ? "internal" : levels.at(-1)!,
      now,
      ...(s.maxTokens ? { maxTokens: s.maxTokens } : {}),
      required: slices.length ? ["1-files"] : [],
      step: `map ${s.repo}`,
    }),
  };
}

const COPY_START = "----- copy from here -----";
const COPY_END = "----- to here -----";

/** Atticus's model limit: the one given, else the step's, else runtime.yaml's maxInput. */
/**
 * The model's limit: --max-tokens, else the limit stated when atticus probe measured the person's
 * assistant (ADR 0124 addendum A-probe; for a read that assistant answers, not model mode), else
 * runtime.yaml's maxInput.
 */
function limitOf(
  o: MapOptions,
  op: OrgPack,
  tier?: TierReport,
): { limit?: number; from?: "flag" | "probe" | "runtime.yaml" } {
  const given = o.maxTokens ?? currentPromptLimit();
  if (given !== undefined) return { limit: given, from: "flag" };
  if (tier?.maxTokensFrom === "probe" && tier.maxTokens !== undefined)
    return { limit: tier.maxTokens, from: "probe" };
  const maxInput = op.runtime.adapters.model?.settings.maxInput;
  return typeof maxInput === "number" ? { limit: maxInput, from: "runtime.yaml" } : {};
}

/** The tier said for this metarepo: measured on this machine, else from runtime.yaml. */
async function tierHere(root: string, op: OrgPack): Promise<TierReport> {
  return assistantTier(op.runtime, { probes: (await readProbes(root)).results });
}

/**
 * The room a batch's files have. ADR 0128 changes nothing here: a prompt either carries the
 * repo's description or asks for one, never both, and either is paid for out of KEPT_RESERVE
 * (`reserveFor`), not out of the files' room — so a repo that says what it is reads in the same
 * batches as one that doesn't.
 */
function roomFor(limit: number | undefined, op: OrgPack, repo: string, commit: string): number {
  const agent = repoReaderAgent(op);
  const budget = op.runtime.budgets.perAgent[agent.id] ?? agent.tokenBudget;
  const fitted = limit === undefined ? budget : Math.min(budget, promptBudget(limit));
  return fitted - instructionTokens(repo, commit) - KEPT_RESERVE;
}

/**
 * What a prompt keeps for the facts on file, the questions and the feedback, once the repo's
 * description (or the line asking for one) is paid for out of it (ADR 0128).
 */
function reserveFor(repo: string, about?: RepoDescription): number {
  const cost = about ? aboutTokens(repo, about) : estimateTokens(ABOUT_RULE);
  return Math.max(MIN_KEPT_RESERVE, KEPT_RESERVE - cost);
}

export async function mapCommand(
  root: string,
  repo: string,
  o: MapOptions,
  io: Output,
  deps: MapDeps = {},
): Promise<number> {
  const now = deps.now ?? (() => new Date());
  const dir = await checkoutOf(root, repo, o.dir);
  if (!dir || !existsSync(dir)) {
    io.err(
      `No checkout of ${repo}: clone it (atticus workspace sync) or give its folder with --dir.`,
    );
    return 2;
  }
  const commit = o.commit ?? (await headOf(dir));
  if (!commit || !/^[0-9a-f]{7,64}$/.test(commit)) {
    io.err(
      `${dir} has no Git commit to read at; give one with --commit <sha> (every fact names the commit it was read at).`,
    );
    return 2;
  }
  const op = await loadOrgPack(orgPackDirOf(root));
  const source = dirSource(dir);
  const exclude = await excludesOf(root, repo);
  const factsFile = `${factsRelOf(root)}/${repo}.jsonl`;

  if (o.estimate)
    return estimate(
      root,
      repo,
      { o, op, dir, commit, source, exclude, factsFile, ...(deps.git ? { git: deps.git } : {}) },
      io,
    );

  const runtime = deps.runtime;
  if (!runtime) {
    io.err("atticus map needs an AI runtime: run it with --handoff, --copy or --mode <mode>.");
    return 2;
  }
  let s = await readState(root, repo);
  const continuing = o.next || o.resume !== undefined || (o.copy && o.answer !== undefined);

  if (continuing) {
    if (!s || s.done || (!s.waiting && o.answer !== undefined)) {
      io.err(
        `No read of ${repo} is waiting for an answer. Start one with atticus map ${repo}${o.copy ? " --copy" : " --handoff"}.`,
      );
      return 2;
    }
    if (o.resume && o.resume !== s.waiting?.runId) {
      io.err(
        `${o.resume} isn't the run the read of ${repo} waits for${s.waiting ? ` (it waits for ${s.waiting.runId})` : ""}.`,
      );
      return 2;
    }
  }
  // An answer to read first: the batch handed off last.
  if (continuing && s?.waiting) {
    const runId = s.waiting.runId;
    if (o.copy && o.answer !== undefined) {
      const text =
        o.answer === "-"
          ? await (deps.stdin ?? readStdin)()
          : await readFile(o.answer, "utf8").catch(() => undefined);
      if (text === undefined) {
        io.err(`Can't read ${o.answer}: save the assistant's answer to that file first.`);
        return 2;
      }
      const out = join(runsDirOf(root), changeOf(repo), runId, OUTPUT);
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, text, "utf8");
    }
    let run = await runtime.result(runId);
    const resultFile = join(runsDirOf(root), changeOf(repo), runId, OUTPUT);
    if (run.state === "waiting" && runtime instanceof HandoffRuntime && existsSync(resultFile))
      run = await runtime.done(runId);
    if (run.state === "waiting" || run.state === "prepared") {
      io.out(
        `Run ${runId} is still waiting for its result file: write it, then atticus map ${repo} --next.`,
      );
      io.report?.({ handoff: { runId } });
      return 0;
    }
    const r = await takeAnswer(root, s, run, s.waiting.batch, source, exclude, now, io, {
      dir,
      ...(deps.git ? { git: deps.git } : {}),
    });
    if (typeof r === "number") return r;
    s = r;
  } else if (!continuing) {
    if (s && !s.done && !o.force) {
      io.out(
        `A read of ${repo} is under way (batch ${(s.waiting?.batch ?? s.next) + 1} of ${s.batches.length}${s.waiting ? `, waiting for run ${s.waiting.runId}` : ""}). Continue it with atticus map ${repo} --next${o.copy ? " (--copy --answer <file> to paste the answer)" : ""}; start again with --force.`,
      );
      if (s.waiting) {
        if (o.copy) return printCopy(s, runtime, io);
        io.report?.({ handoff: { runId: s.waiting.runId } });
      }
      return 0;
    }
    const existing = await readFactsFile(root, repo);
    if (typeof existing === "string") {
      io.err(existing);
      return 2;
    }
    // A read the person's assistant answers (hand-off, copy) takes the limit its probe stated.
    const { limit } = limitOf(
      o,
      op,
      runtime.kind === "hand-off" ? await tierHere(root, op) : undefined,
    );
    const room = roomFor(limit, op, repo, commit);
    /** The model is too small: a prompt needs `more` tokens of topic rules beyond the core. */
    const tooSmall = (more: number) => {
      const fitted = limit === undefined ? room : promptBudget(limit);
      io.err(
        new PromptTooLong(
          `map ${repo}`,
          instructionTokens(repo, commit) + more + KEPT_RESERVE + MIN_ROOM,
          fitted,
          limit ?? fitted,
          [],
        ).message,
      );
      return 2;
    };
    if (room < MIN_ROOM) return tooSmall(0);
    // A moved checkout (ADR 0124 addendum A-incremental): only the files changed since the facts'
    // commit are read, and the facts citing them handed back to rewrite; the rest are carried.
    // What the prompts of this read will carry framework rules for (A-framework), counted into
    // the room the plan leaves each batch.
    const frameworks = await frameworksFor(root, repo, existing);
    const re = await rereadOf(dir, existing, commit, source, exclude, deps.git);
    const reread = re.plan && !re.plan.unknown.length ? re.plan : undefined;
    const since = reread?.from.map((x) => x.commit.slice(0, 12)).join(", ");
    if (reread && !reread.files.length && !reread.reread.length) {
      io.out(
        `Nothing ${repo}'s facts cite changed since ${since}, and no source file did: atticus verify ${repo} carries its ${plural(reread.carried, "fact")} to ${commit.slice(0, 12)}.`,
      );
      return 0;
    }
    const plan = planBatches(
      reread
        ? onlyFiles(
            source,
            reread.files.map((f) => f.path),
          )
        : source,
      { room, exclude, overhead: overheadOf(repo, commit, frameworks) },
    );
    // A file whose topic rules leave too little room beside them (A-lean).
    if (plan.leastRoom < MIN_ROOM) return tooSmall(room - plan.leastRoom);
    if (!plan.batches.length && !reread) {
      io.out(
        `${repo} has no source files to read${plan.excluded.length ? ` (${plural(plan.excluded.length, "file")} excluded)` : ""}.`,
      );
      return 0;
    }
    const byId = new Map(existing.map((f) => [f.id, f]));
    s = {
      schemaVersion: 1,
      repo,
      commit,
      ...(limit ? { maxTokens: limit } : {}),
      room,
      batches: plan.batches,
      next: 0,
      rejected: (reread?.reread ?? []).map((r) => {
        const fact = byId.get(r.id)!;
        return { id: r.id, code: "cite-changed", message: staleMessage(fact, r, commit), fact };
      }),
      problems: [],
      ...(reread
        ? {
            reread: {
              from: reread.from.map((x) => x.commit),
              carried: reread.carried,
              facts: reread.reread.length,
            },
          }
        : {}),
    };
    await saveState(root, s);
    io.out(
      reread
        ? `Re-reading ${repo} at ${commit.slice(0, 12)}: ${plural(plan.files, "source file")} changed since ${since}, in ${batches(plan.batches.length)}${plan.batches.length ? ` (about ${plan.tokens} tokens${limit ? `, each prompt within ${limit} tokens` : ""})` : ""}; ${plural(reread.reread.length, "fact")} to rewrite, ${reread.carried} carried as they are; facts go to ${factsFile}.`
        : `Reading ${repo} at ${commit.slice(0, 12)} in ${batches(plan.batches.length)} (${plural(plan.files, "source file")}, about ${plan.tokens} tokens${limit ? `, each prompt within ${limit} tokens` : ""}); facts go to ${factsFile}.`,
    );
  }

  if (!s) return 2;
  // Hand batches until one waits on a person's assistant, or every batch is read.
  for (;;) {
    const fixRound = s.next >= s.batches.length;
    if (fixRound && (s.fixRound || !s.rejected.length)) break;
    if (fixRound) s.fixRound = true;
    const { agent, pack } = await packFor(root, s, s.next, source, op, now());
    const prepared = await runtime.prepare({
      change: changeOf(repo),
      agent,
      pack,
      outputPath: OUTPUT,
      outputIn: "run",
    });
    const run = await runtime.run(prepared.runId);
    if (run.state === "waiting" || run.state === "prepared") {
      s.waiting = { runId: run.runId, batch: s.next };
      await saveState(root, s);
      if (o.copy) return printCopy(s, runtime, io);
      const label = fixRound
        ? "the fix round for the rejected facts"
        : `batch ${s.next + 1} of ${s.batches.length}`;
      io.out(
        `Handed ${label} to your assistant (run ${run.runId}). When it is done: atticus handoff done ${run.runId}, then atticus map ${repo} --next`,
      );
      io.report?.({ handoff: { runId: run.runId } });
      return 0;
    }
    const r = await takeAnswer(root, s, run, s.next, source, exclude, now, io, {
      dir,
      ...(deps.git ? { git: deps.git } : {}),
    });
    if (typeof r === "number") return r;
    s = r;
  }
  return finish(root, s, io, o);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** --copy: the waiting batch's prompt, to paste into a chat, and how to give the answer back. */
async function printCopy(s: MapState, runtime: AiRuntime, io: Output) {
  const run = await runtime.result(s.waiting!.runId);
  io.out(COPY_START);
  io.out(run.request.pack.prompt.trimEnd());
  io.out(COPY_END);
  io.out(
    `Paste it into your assistant's chat (${s.waiting!.batch < s.batches.length ? `batch ${s.waiting!.batch + 1} of ${s.batches.length}` : "the fix round"}). Save its answer to a file, then run: atticus map ${s.repo} --copy --answer <file> (or --answer - to paste it on stdin).`,
  );
  io.report?.({ handoff: { runId: run.runId } });
  return 0;
}

/** One answer: its facts merged into the facts file and verified at once, its questions raised. */
async function takeAnswer(
  root: string,
  s: MapState,
  run: Run,
  batch: number,
  source: FileSource,
  exclude: string[],
  now: () => Date,
  io: Output,
  at: { dir: string; git?: GitRunner },
): Promise<MapState | number> {
  const label =
    batch < s.batches.length ? `Batch ${batch + 1} of ${s.batches.length}` : "The fix round";
  if (run.state !== "validated" && run.state !== "produced") {
    io.err(
      `${label} got no answer to read (${run.errors.join("; ") || `the run ended ${run.state}`}). Run atticus map ${s.repo} --next to hand it again.`,
    );
    const { waiting: _w, ...rest } = s;
    await saveState(root, { ...rest, next: batch });
    return 1;
  }
  const answer = readAnswer(run.output ?? "", s.repo, s.commit);
  const existing = await readFactsFile(root, s.repo);
  if (typeof existing === "string") {
    io.err(existing);
    return 2;
  }
  const merged = new Map(existing.map((f) => [f.id, f]));
  for (const f of answer.facts) merged.set(f.id, f);
  // Facts of an earlier commit whose files are unchanged are carried (ADR 0124 addendum A-incremental).
  const { carry } = await carryOf(at.dir, [...merged.values()], s.commit, at.git);
  const reviewed = await readReviewed(root, s.repo);
  const report = await verifyFacts({
    facts: [...merged.values()],
    source,
    commit: s.commit,
    carry,
    exclude,
    // ADR 0124 addendum D-app: a person's corrections hold through every batch of a read.
    corrections: (await readCorrections(root, s.repo)).corrections,
    // ADR 0124 addendum A-read: files the reader read and found nothing in, if it wrote any.
    reviewed: reviewed.entries,
  });
  const q = await raiseReadQuestions(root, s.repo, answer.questions, source, {
    command: `atticus map ${s.repo}`,
    run: run.runId,
    at: now().toISOString(),
  });
  const summary = await writeVerifyFiles(
    root,
    s.repo,
    report,
    s.commit,
    q.problems,
    [],
    reviewedProblemsOf(reviewed.bad, report),
  );
  // The one line the reader drafted about the repo (ADR 0128): kept as a draft, marked
  // unconfirmed wherever it is shown, for a person to confirm, edit or reject.
  if (answer.about) {
    const { keepDraftedDescription } = await import("./repo-commands.js");
    const d = await keepDraftedDescription(root, s.repo, answer.about, now());
    if (d.kept)
      io.out(
        `Your assistant says ${s.repo} is: "${answer.about.text}" — written to the manifest as a draft, unconfirmed. Confirm it (atticus repo describe ${s.repo} --accept), change it (--description "...") or drop it (--reject).`,
      );
    else if (d.why) io.out(`The description your assistant drafted wasn't kept: ${d.why}.`);
  }
  const fresh = new Set(answer.facts.map((f) => f.id));
  const kept = report.accepted.filter((f) => fresh.has(f.id)).length;
  io.out(
    `${label}: ${plural(kept, "fact")} kept (${report.accepted.length} in all${report.carried.length ? `, ${report.carried.length} carried from an earlier commit` : ""}), ${report.rejected.length} rejected${q.raised.length ? `, ${plural(q.raised.length, "question")} raised for a person` : ""}${answer.problems.length ? `, ${plural(answer.problems.length, "line")} not read` : ""}.`,
  );
  const { waiting: _w, ...rest } = s;
  const rejected = report.rejected.map((r: Rejected) => ({
    id: r.fact.id,
    code: r.code,
    message: r.message,
    fact: r.fact,
  }));
  // A re-read's facts to rewrite stay handed back until a batch rewrites them (their file may be
  // in a later batch) or the fix round leaves them out; they are no longer in the facts file.
  const settled = new Set([...report.accepted.map((f) => f.id), ...rejected.map((r) => r.id)]);
  const pending = s.rejected.filter((r) => r.code === "cite-changed" && !settled.has(r.id));
  return {
    ...rest,
    next: batch + 1,
    rejected: [...rejected, ...pending],
    problems: [...answer.problems, ...q.problems.map((p) => `${p.message}: ${p.line}`)],
    last: summary,
  };
}

async function finish(root: string, s: MapState, io: Output, o: MapOptions): Promise<number> {
  s.done = true;
  await saveState(root, s);
  const last = s.last;
  const rel = factsRelOf(root);
  if (o.json) {
    io.out(
      JSON.stringify({ state: "done", repo: s.repo, batches: s.batches.length, ...last }, null, 2),
    );
    return last && last.rejected ? 1 : 0;
  }
  if (!last) {
    io.out(`Read ${s.repo}: nothing was kept.`);
    return 0;
  }
  io.out(
    `Read ${s.repo} in ${batches(s.batches.length)}: ${plural(last.accepted, "fact")} kept in ${rel}/${s.repo}.jsonl, ${last.rejected} still rejected; coverage ${Math.round(last.coverage.ratio * 100)}% (${last.coverage.read} read, ${last.coverage.reviewed ? `${last.coverage.reviewed} reviewed with nothing to record, ` : ""}${last.coverage.unknown.length} unknown).`,
  );
  if (last.rejected)
    io.out(
      `The rejected facts are in ${rel}/${s.repo}.rejected.jsonl; fix them by hand or with your assistant, then atticus verify ${s.repo}.`,
    );
  if (last.coverage.unknown.length)
    io.out(
      `Files no fact cites yet are listed in ${rel}/${s.repo}.verify.yaml; generated code can be excluded in org-pack/scan/${s.repo}.yaml.`,
    );
  return last.rejected ? 1 : 0;
}

/**
 * What a re-read is, for the person and the /atticus-map protocol: the facts carried as they are,
 * the facts to rewrite or drop and why, and the changed files to read (ADR 0124 addendum
 * A-incremental). Every fact and file is listed: they are the read.
 */
function rereadLines(repo: string, r: RereadPlan): string[] {
  const head = r.commit.slice(0, 12);
  const since = r.from.map((x) => x.commit.slice(0, 12)).join(", ");
  const changed = r.from.reduce((n, x) => n + x.changed, 0);
  const out = [
    `A re-read: the facts are of ${since} and the checkout is at ${head}; ${plural(changed, "file")} changed since. Read only what is listed here, not the whole repo.`,
    `${plural(r.carried, "fact")} still ${r.carried === 1 ? "holds" : "hold"} (every file they cite is unchanged): keep them as they are; atticus verify ${repo} carries them to ${head}, checking each line again.`,
  ];
  if (r.current)
    out.push(`${plural(r.current, "fact")} ${r.current === 1 ? "is" : "are"} already of ${head}.`);
  if (r.reread.length) {
    out.push(
      `${plural(r.reread.length, "fact")} ${r.reread.length === 1 ? "cites" : "cite"} a file that changed: read it again, then write each at ${head} under the same id with its line as it is now, or drop it if the code no longer says it:`,
    );
    for (const f of r.reread)
      out.push(
        `  ${f.id} (${f.kind}): ${f.file} was ${f.how === "renamed" ? `renamed to ${f.to}` : f.how}`,
      );
  }
  if (r.files.length) {
    out.push(`${plural(r.files.length, "file")} to read whole (changed since ${since}):`);
    for (const f of r.files)
      out.push(
        `  ${f.path} (${f.facts ? `${plural(f.facts, "fact")} to rewrite` : `${f.status === "added" ? "new" : f.status}; no fact cites it yet`})`,
      );
  } else if (!r.reread.length)
    out.push(
      `Nothing a fact cites changed and no source file did: run atticus verify ${repo} to carry the facts to ${head}.`,
    );
  return out;
}

/** --estimate: what the first read costs, at every tier, and the tier runtime.yaml points to. */
async function estimate(
  root: string,
  repo: string,
  c: {
    o: MapOptions;
    op: OrgPack;
    dir: string;
    commit: string;
    source: FileSource;
    exclude: string[];
    factsFile: string;
    git?: GitRunner;
  },
  io: Output,
): Promise<number> {
  const tier: TierReport = await tierHere(root, c.op);
  const { limit: given, from } = limitOf(c.o, c.op, tier);
  const limit = given ?? EXAMPLE_LIMIT;
  const about = await aboutOf(root, repo);
  const room = roomFor(limit, c.op, repo, c.commit);
  // A moved checkout (ADR 0124 addendum A-incremental): the read is the files changed since the
  // facts' commit and the facts citing them, not the whole repo.
  const existing = await readFactsFile(root, repo);
  const re =
    typeof existing === "string"
      ? { missing: [] as string[] }
      : await rereadOf(c.dir, existing, c.commit, c.source, c.exclude, c.git);
  const reread = re.plan && !re.plan.unknown.length ? re.plan : undefined;
  const readSource = reread
    ? onlyFiles(
        c.source,
        reread.files.map((f) => f.path),
      )
    : c.source;
  const repoWhole = reread
    ? planBatches(c.source, { room: Number.MAX_SAFE_INTEGER, exclude: c.exclude })
    : undefined;
  const whole = planBatches(readSource, { room: Number.MAX_SAFE_INTEGER, exclude: c.exclude });
  const planned =
    room >= MIN_ROOM
      ? planBatches(readSource, {
          room,
          exclude: c.exclude,
          overhead: overheadOf(
            repo,
            c.commit,
            await frameworksFor(root, repo, typeof existing === "string" ? [] : existing),
          ),
        })
      : undefined;
  const plan = planned && planned.leastRoom >= MIN_ROOM ? planned : undefined;
  // A big repo (ADR 0124 addendum A-big): folders of data to leave out, never written, and the
  // parts to read it in when, with them left out, it is more than one session holds.
  const files = whole.batches.flat().map((s) => ({ path: s.path, tokens: s.tokens }));
  const proposed = reread
    ? { proposals: [], before: whole.tokens, after: whole.tokens }
    : proposeExclusions(files, c.source.list(), (p) => c.source.read(p), {
        // What the person's description plainly says this repo holds (ADR 0128).
        saysNotProduct: saysNotProduct(about),
      });
  const left = proposed.proposals.map((p) => p.path.slice(0, -2));
  const session = Math.max(SESSION_TOKENS, Math.floor(0.75 * (given ?? 0)));
  // A-big2: the parts are of the product code left with every proposal out.
  const product = files.filter((f) => !left.some((d) => f.path.startsWith(d)));
  const parts = planParts(product, session);
  // A-ledger: the plan is kept beside the facts, so the parts are the same in every session and
  // which part is next is read back from the facts. An unchanged plan is left as it was planned.
  const plan0 = await loadReadPlan(root, repo);
  const same =
    plan0 !== undefined &&
    plan0.commit === c.commit &&
    plan0.session === session &&
    plan0.parts.length === parts.length &&
    plan0.parts.every(
      (p, i) =>
        p.paths.length === parts[i]!.paths.length &&
        p.paths.every((x, j) => x === parts[i]!.paths[j]),
    );
  if (parts.length && !same) await writeReadPlan(root, repo, { commit: c.commit, session, parts });
  const progress = parts.length
    ? await readPlanProgress(root, repo, { commit: c.commit })
    : undefined;
  const questions = (await listQuestions(root, { repo })).questions.filter(
    (q) => q.state !== "retired",
  );
  if (c.o.json) {
    io.out(
      JSON.stringify(
        {
          repo,
          dir: c.dir,
          commit: c.commit,
          factsFile: c.factsFile,
          files: whole.files,
          lines: whole.lines,
          tokens: whole.tokens,
          excluded: whole.excluded,
          maxTokens: limit,
          maxTokensGiven: given !== undefined,
          maxTokensFrom: from ?? "example",
          batches: plan?.batches.length ?? null,
          order: whole.batches.flat().map((x) => x.path),
          // ADR 0128: what a person says the repo is, and whether that eased the proposals.
          about: about
            ? { text: about.text, trust: about.trust, eased: saysNotProduct(about) }
            : null,
          proposals: {
            before: proposed.before,
            after: proposed.after,
            exclude: proposed.proposals,
          },
          parts: {
            session,
            parts,
            // A-ledger: the read plan on file and what the facts say each part has covered.
            ...(progress
              ? {
                  plan: {
                    file: readPlanRelOf(root, repo),
                    total: progress.total,
                    done: progress.done,
                    ...(progress.next ? { next: progress.next.part } : {}),
                    stale: progress.stale,
                    parts: progress.parts,
                  },
                }
              : {}),
          },
          tier,
          // A-taught: the frameworks of the organisation it is built on, as taught to Atticus.
          taughtFrameworks: taughtIn(c.source, c.op).map((m) => m.name),
          questions: questions.map((q) => ({
            id: q.id,
            question: q.question,
            state: q.state,
            ...(q.answer ? { answer: q.answer } : {}),
          })),
          // A re-read: what the files and batches above are, and the facts to revisit.
          reread: reread
            ? {
                ...reread,
                repo: {
                  files: repoWhole!.files,
                  lines: repoWhole!.lines,
                  tokens: repoWhole!.tokens,
                },
              }
            : null,
          ...(re.missing.length ? { notComparable: re.missing } : {}),
        },
        null,
        2,
      ),
    );
    return 0;
  }
  io.out(`${repo} at ${c.commit} in ${c.dir}`);
  // ADR 0128: what the repo is, for the reader to orient by — a note, not a finding.
  io.out(
    about
      ? `What it is (${descriptionTrust(about)}${about.by ? `, ${about.by}` : ""}): ${about.text} — a person's note from the manifest, not read from the code: where the code says otherwise, the code is right.`
      : `What it is: nothing says yet. A person writes one line (atticus repo describe ${repo} --description "..."); if the files say plainly, hand yours over with atticus repo describe ${repo} --drafted "..." --cites <file>:<line>, and it waits for a person.`,
  );
  io.out(`Facts file: ${c.factsFile}`);
  // A-taught: the frameworks of the organisation it is built on, as /atticus-map's reader needs them.
  const taught = taughtFrameworksText(taughtIn(c.source, c.op));
  if (taught) for (const l of taught.split("\n")) io.out(l);
  if (reread) for (const l of rereadLines(repo, reread)) io.out(l);
  for (const m of re.missing)
    io.out(
      `Some facts are of commit ${m.slice(0, 12)}, which this clone can't compare with ${c.commit.slice(0, 12)} (fetch it, or read the repo again whole): the read below is the whole repo.`,
    );
  io.out(
    `${plural(whole.files, "source file")}${reread ? " to read" : ""}, ${plural(whole.lines, "line")}, about ${whole.tokens} tokens${whole.excluded.length ? `; ${whole.excluded.length} excluded` : ""}${reread ? ` (the repo has ${plural(repoWhole!.files, "source file")}, about ${repoWhole!.tokens} tokens)` : ""}.`,
  );
  if (proposed.proposals.length) {
    const scan = relative(root, join(orgPackDirOf(root), "scan", `${repo}.yaml`)).replace(
      /\\/g,
      "/",
    );
    io.out(
      `Folders that look like data, documentation or vendored code, not the product (${proposed.proposals.length}):`,
    );
    if (saysNotProduct(about))
      io.out(
        `  (${repo}'s description says it is mostly not product code, so a smaller folder is proposed than would be otherwise. Each is still a proposal a person accepts.)`,
      );
    for (const p of proposed.proposals.slice(0, SHOWN_PROPOSALS))
      io.out(`  ${p.path} (about ${p.tokens} tokens, ${plural(p.files, "file")}): ${p.why}`);
    if (proposed.proposals.length > SHOWN_PROPOSALS)
      io.out(
        `  ... and ${proposed.proposals.length - SHOWN_PROPOSALS} more (all in the exclude: block below)`,
      );
    // No scan settings yet: the whole file, ready to save (the schema needs its version and repo).
    const fresh = !existsSync(join(root, scan));
    io.out(
      fresh
        ? `To leave them out, a person saves this as ${scan} in a pull request (Atticus never writes it):`
        : `To leave them out, a person adds these entries to the exclude: list of ${scan} in a pull request (Atticus never writes it):`,
    );
    if (fresh) io.out(`schemaVersion: 1\nrepo: ${repo}`);
    io.out(exclusionYaml(proposed.proposals).trimEnd());
    io.out(`With them left out: about ${proposed.after} tokens (now ${proposed.before}).`);
  }
  if (parts.length) {
    if (proposed.proposals.length)
      io.out(
        `The parts below are planned over what is left with the ${plural(proposed.proposals.length, "proposed folder")} left out (${plural(product.length, "source file")}, about ${proposed.after} tokens); no part reads a proposed folder.`,
      );
    io.out(
      `About ${parts.reduce((n, p) => n + p.tokens, 0)} tokens${proposed.proposals.length ? " with those left out" : ""} is more than one session reads (${session} tokens): read it in ${parts.length} parts, one per session or sub-agent, as /atticus-map says:`,
    );
    // A-ledger: the plan is recorded, so each part says whether it is read; the next one is named.
    const stateOf = (i: number) => progress?.parts[i]?.state;
    const words = (s: string | undefined) =>
      s === "done" ? "done" : s === "in-progress" ? "part-read" : "to read";
    parts.forEach((p, i) =>
      io.out(
        `  part ${i + 1} (${words(stateOf(i))}, about ${p.tokens} tokens, ${plural(p.files, "file")}): ${p.paths.join(", ")}`,
      ),
    );
    if (progress) {
      io.out(
        `Read plan: ${readPlanRelOf(root, repo)}. ${
          progress.next
            ? `${partOfWords({ part: progress.next.part, total: progress.total })} is next (${progress.done ? `${progress.done} of ${progress.total} read` : `none of ${progress.total} read yet`}): ${progress.next.paths.join(", ")}.`
            : `All ${progress.total} parts are read.`
        } A part counts as read when every folder it covers is in the facts (a fact citing a file, or a line of ${factsRelOf(root)}/${repo}.reviewed.jsonl); atticus next says which comes next.`,
      );
      for (const p of progress.parts)
        if (p.state === "in-progress")
          io.out(
            `  part ${p.part} is part-read: nothing in the facts yet for ${p.left.join(", ")}.`,
          );
    }
  }
  io.out(`Your assistant: ${tierWords(tier)}, ${tierSource(tier)}. ${tier.how}`);
  io.out(
    `Another agentic assistant (Claude Code, Cursor, Gemini CLI) reads it the same way: /atticus-map ${repo}; one without file tools gets batches with atticus map ${repo} --handoff --max-tokens <its limit>.`,
  );
  if (tier.fallback) io.out(tier.fallback);
  if (tier.note) io.out(tier.note);
  if (tier.model) io.out(tier.model);
  if (tier.measured?.stale)
    io.out(`That was ${tier.measured.days} days ago: atticus probe measures it again.`);
  else if (tier.source === "runtime.yaml" && tier.tier !== "off")
    io.out("atticus probe measures your assistant's tier and limit instead.");
  io.out(
    plan
      ? `In batches at ${limit} tokens a prompt${given === undefined ? " (GPT-4o mini through Copilot; --max-tokens n for your model's limit)" : from === "probe" ? ` (the limit stated when your assistant was measured on ${tier.measured?.at})` : ""}: ${plural(plan.batches.length, "prompt")}, one more if facts are rejected in the last.`
      : `A model of ${limit} tokens leaves too little room for the files beside the instructions: use a model with a bigger limit.`,
  );
  for (const q of questions)
    io.out(
      `Question ${q.id}: ${q.question} (${q.state === "answered" ? `answered: ${q.answer?.text ?? q.options[(q.answer?.option ?? 1) - 1]?.label ?? ""}` : "open"})`,
    );
  if (questions.length) io.out("Follow each answer; don't ask these again.");
  return 0;
}
