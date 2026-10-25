import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import {
  assistantTier,
  mapBatchInstructions,
  readProbes,
  tierSource,
  tierWords,
  type TierReport,
} from "@maycombhq/assistant-files";
import {
  AgentDefinition,
  citedFiles,
  Fact,
  factsDirOf,
  factsRelOf,
  listQuestions,
  loadOrgPack,
  orgPackDirOf,
  parseFacts,
  runsDirOf,
  writeFileAtomic,
  type OrgPack,
  type Question,
} from "@maycombhq/core";
import {
  buildContextPack,
  currentPromptLimit,
  DATA_RULE,
  estimateTokens,
  HandoffRuntime,
  promptBudget,
  PromptTooLong,
  type AiRuntime,
  type Run,
  type SourceInput,
} from "@maycombhq/ai";
import {
  dirSource,
  exclusionYaml,
  FILE_KINDS,
  kindsOf,
  numberedSlice,
  onlyFiles,
  planBatches,
  planParts,
  proposeExclusions,
  rereadPlan,
  SESSION_TOKENS,
  sameCommit,
  sliceText,
  staleMessage,
  verifyFacts,
  type FileKind,
  type FileSlice,
  type FileSource,
  type Rejected,
  type RereadPlan,
} from "@maycombhq/verify";
import type { GitRunner } from "@maycombhq/workspace";
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
function instructionTokens(repo: string, commit: string, kinds: readonly FileKind[] = []): number {
  return (
    estimateTokens(mapBatchInstructions({ repo, commit, batch: 999, of: 999, kinds })) +
    estimateTokens(DATA_RULE) +
    // the <atticus-data> wrapper around the batch's files
    60
  );
}

/** What a batch's topic rules add to the core's instructions, for the batch planner. */
const overheadOf = (repo: string, commit: string) => {
  const core = instructionTokens(repo, commit);
  return (kinds: readonly FileKind[]) => instructionTokens(repo, commit, kinds) - core;
};

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
    case "flow":
      return f.name;
  }
}

/** The answer's lines: facts (marked as the assistant's, unverified), questions, and problems. */
export function readAnswer(
  text: string,
  repo: string,
  commit: string,
): { facts: Fact[]; questions: unknown[]; problems: string[] } {
  const facts = new Map<string, Fact>();
  const questions: unknown[] = [];
  const problems: string[] = [];
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
  return { facts: [...facts.values()], questions, problems };
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
    : extra + rejected.reduce((n, t) => n + estimateTokens(t), 0) <= KEPT_RESERVE
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
    ...(facts.length
      ? [
          {
            id: "5-kept",
            kind: "document" as const,
            origin: `${factsRelOf(root)}/${s.repo}.jsonl`,
            text: keptText(facts, KEPT_RESERVE),
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

function roomFor(limit: number | undefined, op: OrgPack, repo: string, commit: string): number {
  const agent = repoReaderAgent(op);
  const budget = op.runtime.budgets.perAgent[agent.id] ?? agent.tokenBudget;
  const fitted = limit === undefined ? budget : Math.min(budget, promptBudget(limit));
  return fitted - instructionTokens(repo, commit) - KEPT_RESERVE;
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
      { room, exclude, overhead: overheadOf(repo, commit) },
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
          overhead: overheadOf(repo, c.commit),
        })
      : undefined;
  const plan = planned && planned.leastRoom >= MIN_ROOM ? planned : undefined;
  // A big repo (ADR 0124 addendum A-big): folders of data to leave out, never written, and the
  // parts to read it in when, with them left out, it is more than one session holds.
  const files = whole.batches.flat().map((s) => ({ path: s.path, tokens: s.tokens }));
  const proposed = reread
    ? { proposals: [], before: whole.tokens, after: whole.tokens }
    : proposeExclusions(files, c.source.list());
  const left = proposed.proposals.map((p) => p.path.slice(0, -2));
  const session = Math.max(SESSION_TOKENS, Math.floor(0.75 * (given ?? 0)));
  const parts = planParts(
    files.filter((f) => !left.some((d) => f.path.startsWith(d))),
    session,
  );
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
          proposals: {
            before: proposed.before,
            after: proposed.after,
            exclude: proposed.proposals,
          },
          parts: { session, parts },
          tier,
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
  io.out(`Facts file: ${c.factsFile}`);
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
    for (const p of proposed.proposals)
      io.out(`  ${p.path} (about ${p.tokens} tokens, ${plural(p.files, "file")}): ${p.why}`);
    io.out(
      `To leave them out, a person adds these entries to the exclude: list of ${scan} in a pull request (Atticus never writes it):`,
    );
    io.out(exclusionYaml(proposed.proposals).trimEnd());
    io.out(`With them left out: about ${proposed.after} tokens (now ${proposed.before}).`);
  }
  if (parts.length) {
    io.out(
      `About ${parts.reduce((n, p) => n + p.tokens, 0)} tokens${proposed.proposals.length ? " with those left out" : ""} is more than one session reads (${session} tokens): read it in ${parts.length} parts, one per session or sub-agent, as /atticus-map says:`,
    );
    parts.forEach((p, i) =>
      io.out(
        `  part ${i + 1} (about ${p.tokens} tokens, ${plural(p.files, "file")}): ${p.paths.join(", ")}`,
      ),
    );
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
