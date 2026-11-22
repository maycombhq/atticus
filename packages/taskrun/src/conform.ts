import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { changeFolder, changeStore, writeFileAtomic } from "@maycombhq/changes";
import {
  Api,
  ChecklistPack,
  changeBranch,
  changesRelOf,
  Finding,
  loadOrgPack,
  orgPackDirOf,
  readRepoSpec,
  stateDirOf,
  taskBranch,
  toCanonicalYaml,
  type CatalogRecord,
  type ChecklistRule,
  type Fact,
  type FlowRecord,
} from "@maycombhq/core";
import { readChangeFiles, readRound, roundsOf } from "@maycombhq/naysayer";
import {
  BRANCH_FACTS_DIR,
  claimCounts,
  claimFindingId,
  claimRule,
  conform,
  conformClaims,
  readClaims,
  readConformDeltas,
  readOperations,
  readTaskSteps,
  type Claim,
  type ClaimResult,
  type ConformDelta,
  type ConformItem,
} from "@maycombhq/planner";
import { branchFactsAt, scanEstate, type FactBasis } from "@maycombhq/scanner";
import { readChangeTasks } from "@maycombhq/speckit";
import { slug, writeGateRound } from "@maycombhq/testgen";
import { baseClonePath, createGit, type GitRunner } from "@maycombhq/workspace";

/**
 * Does the code do what the design says? (ADR 0114.) A repo's branch for a change (the change
 * branch, a task branch, or any ref a person names) is scanned at its commit, and at the base it
 * was cut from, with the scanner and its cache, from a detached worktree of the base clone the
 * workspace keeps: nobody's working copy is touched. The records are compared with the
 * change's target flows (planner `conform`), the result is kept at `conform/<repo>.yaml` in the
 * change folder, and what is missing, still there or unexpected becomes C3 findings on the
 * built-in conform gate, which holds the Build hand-off back like any gate. No AI, no network.
 */

export const CONFORM_GATE = "conform";
export const CONFORM_DIR = "conform";

export class ConformError extends Error {
  constructor(
    readonly code: "not-found" | "refused" | "invalid",
    message: string,
  ) {
    super(message);
    this.name = "ConformError";
  }
}

/**
 * The records and files of a repo at one commit, and what the records rest on (rule 4: the
 * assistant's facts, with the changed files no fact covers yet, or the built-in readers).
 */
export type ScanAt = (
  repo: string,
  commit: string,
) => Promise<{
  records: CatalogRecord[];
  files: string[];
  problems: string[];
  basis: FactBasis;
  /**
   * ADR 0206: the verified facts the records rest on at the commit, with the branch's own facts
   * from the change folder (`conform/facts/<repo>.jsonl`) for the files they cover.
   */
  facts?: readonly Fact[];
  /** The lines of the files the facts cite, at the commit, for a value the verifier doesn't check. */
  lines?: Map<string, string[]>;
}>;

export interface ConformOptions {
  /** Only this repo; default every repo the target flows name. */
  repo?: string;
  /** The branch or commit to check; default the task's branch, else the change branch. */
  ref?: string;
  /** Only the steps this task builds (from the stories); its branch by default. */
  task?: string;
  git?: GitRunner;
  now?: string;
  /** Scan a repo at a commit; default a detached worktree of its base clone and the scanner. */
  scanAt?: ScanAt;
}

export interface ConformRun {
  results: Api.ConformRepoResultT[];
  /** The conform gate's newest round after this run. */
  round?: number;
  problems: string[];
  /** How many target flows the change has. */
  flows: number;
  /** ADR 0206: how many claims the change states (operations by repo, design.md's rows). */
  claims: number;
}

const stamp = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * The folder a scan of a repo at a commit checks the commit out in: its own for each scan, so
 * two task runs scanning the same commit (a shared merge-base) never remove each other's.
 */
export function conformScanDir(root: string, repo: string, commit: string): string {
  const own = `${process.pid}-${randomBytes(4).toString("hex")}`;
  return join(stateDirOf(root), ".index", "conform", `${repo}-${commit.slice(0, 12)}-${own}`);
}

/** The files the facts cite (their own lines and their parts'), each once. */
const citedFiles = (facts: readonly Fact[]) => [
  ...new Set(facts.flatMap((f) => [f.cite.file, ...(f.cite.with ?? []).map((w) => w.file)])),
];

/**
 * Scan a repo at a commit from a detached worktree of its base clone, then remove the worktree.
 * ADR 0206: the branch's own facts, kept in the change folder, are verified in that worktree and
 * cover the files they cite; they are never written to the catalog.
 */
function gitScanAt(root: string, git: GitRunner, changeDir?: string): ScanAt {
  return async (repo, commit) => {
    const base = baseClonePath(root, repo);
    const dir = conformScanDir(root, repo, commit);
    await rm(dir, { recursive: true, force: true });
    await mkdir(join(dir, ".."), { recursive: true });
    await git(["worktree", "add", "--detach", "--force", "--", dir, commit], base);
    try {
      const s = await scanEstate({
        root,
        repos: [repo],
        repoDir: () => dir,
        repoState: async () => ({ commit, dirty: false }),
        git,
        // Rule 4 at the branch's commit: the facts verify kept, carried to it as verify carries
        // them, never facts citing a file the branch changed (eighth UX walk, ADR 0195 point 2).
        carryFacts: true,
      });
      const files = (await git(["ls-tree", "-r", "--name-only", commit], base)).stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      let basis: FactBasis = s.basis?.[repo] ?? { from: "readers" };
      let facts = [...(s.facts?.[repo] ?? [])];
      const problems = s.problems
        .filter((p) => !p.repo || p.repo === repo)
        .map((p) => `${p.repo ? `${p.repo}: ` : ""}${p.source}: ${p.message}`);
      // The branch's facts: verified here, at the commit, for the files they cite.
      const own = changeDir
        ? await readFile(
            join(changeDir, ...BRANCH_FACTS_DIR.split("/"), `${repo}.jsonl`),
            "utf8",
          ).catch(() => undefined)
        : undefined;
      if (own !== undefined) {
        const op = await loadOrgPack(orgPackDirOf(root));
        const b = await branchFactsAt(op, own, { dir, commit });
        if (b) {
          for (const p of b.problems) problems.push(`${BRANCH_FACTS_DIR}/${repo}.jsonl: ${p}`);
          const covered = new Set(citedFiles(b.facts));
          facts = [...facts.filter((f) => !covered.has(f.cite.file)), ...b.facts];
          basis =
            basis.from === "facts"
              ? { from: "facts", unread: basis.unread.filter((f) => !covered.has(f)) }
              : b.facts.length
                ? { from: "facts", unread: [] }
                : basis;
        }
      }
      // The lines a claim's value may be written on, read in the worktree before it goes.
      const lines = new Map<string, string[]>();
      for (const f of citedFiles(facts.filter((x) => x.kind === "deploy" || x.kind === "config")))
        lines.set(
          f,
          (await readFile(join(dir, ...f.split("/")), "utf8").catch(() => "")).split(/\r?\n/),
        );
      return { records: s.records, files, basis, problems, facts, lines };
    } finally {
      await git(["worktree", "remove", "--force", "--", dir], base).catch(() => undefined);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      await git(["worktree", "prune"], base).catch(() => undefined);
    }
  };
}

const RULES_FILE = fileURLToPath(new URL("../rules/conform.yaml", import.meta.url));

async function loadConformRules(): Promise<Map<string, ChecklistRule>> {
  const pack = ChecklistPack.parse(parse(await readFile(RULES_FILE, "utf8")));
  return new Map(pack.rules.map((r) => [r.id, r]));
}

const FIX: Record<Exclude<ConformItem["status"], "found">, string> = {
  missing:
    "Build what the step says on the branch, or change the target flow (atticus change architecture) if the design was wrong.",
  "still-there":
    "Take the call out on the branch, or keep the step in the target flow if it should stay.",
  unexpected:
    "Add a step that names it to the target flow if the change needs it, or take it out of the branch. Dismiss it as not relevant if it belongs elsewhere.",
};

/**
 * A finding's id from its item: the same item keeps its id, so a dismissal survives a rescan. A
 * column the code lacks has no record, so its sentence (which names the column) tells two
 * missing columns of one step apart.
 */
export function conformFindingId(i: ConformItem): string {
  const column =
    i.check !== "column"
      ? ""
      : i.record
        ? `-${slug(i.record.split(".").pop()!)}`
        : `-${createHash("sha256").update(i.what).digest("hex").slice(0, 8)}`;
  const subject =
    i.status === "unexpected"
      ? slug(i.record ?? i.what)
      : `${slug(i.flow ?? "")}-${i.item ?? "trigger"}${column}`;
  return `conform-${i.status}-${i.check}-${subject}`.slice(0, 120).replace(/-+$/, "");
}

/** A claim's outcome as a C3 finding on the conform gate (ADR 0206); none for present and unconfirmed. */
function claimFinding(
  change: string,
  c: Api.ConformClaimT,
  rules: Map<string, ChecklistRule>,
  now: string,
): Finding | undefined {
  const id = claimRule(c.outcome as ClaimResult["outcome"]);
  const rule = id ? rules.get(id) : undefined;
  if (!rule) return undefined;
  const summary = c.what.length <= 200 ? c.what : `${c.what.slice(0, 197)}...`;
  return Finding.parse({
    schemaVersion: 1,
    id: claimFindingId(c as ClaimResult),
    kind: "issue",
    change,
    gate: CONFORM_GATE,
    round: 1,
    rule: rule.id,
    layer: rule.layer,
    lens: rule.lens,
    severity: rule.severity,
    artifact: c.from.file,
    locator: { line: c.from.line },
    summary,
    why: rule.description ?? rule.title,
    fix: { text: c.next },
    evidence: c.at.map((x) =>
      x.source === "artifact"
        ? { source: "artifact", path: x.path, ...(x.line ? { line: x.line } : {}) }
        : {
            source: "code",
            repo: x.repo ?? c.repo,
            path: x.path,
            ...(x.line ? { line: x.line } : {}),
          },
    ),
    waivable: rule.waivable,
    state: "open",
    createdAt: now,
  });
}

/** What is missing, still there or unexpected, as C3 findings on the conform gate. */
export async function conformFindings(
  change: string,
  results: Api.ConformRepoResultT[],
  lines: Map<string, number>,
  now: string,
): Promise<Finding[]> {
  const rules = await loadConformRules();
  const out: Finding[] = [];
  for (const r of results)
    for (const i of r.items) {
      if (i.status === "found") continue;
      const rule = rules.get(`conform.${i.status}`)!;
      const artifact = i.flow ? `target-flows/${i.flow}.yaml` : "code";
      const line = i.flow ? lines.get(`${i.flow}#${i.item ?? 0}`) : undefined;
      const summary = i.what.length <= 200 ? i.what : `${i.what.slice(0, 197)}...`;
      out.push(
        Finding.parse({
          schemaVersion: 1,
          id: conformFindingId(i),
          kind: "issue",
          change,
          gate: CONFORM_GATE,
          round: 1,
          rule: rule.id,
          layer: rule.layer,
          lens: rule.lens,
          severity: rule.severity,
          artifact,
          locator: i.flow
            ? line
              ? { line }
              : { heading: i.item ? `item ${i.item}` : "trigger" }
            : { record: i.record ?? r.repo },
          summary,
          why: rule.description ?? rule.title,
          fix: { text: FIX[i.status] },
          evidence: i.at.map((c) =>
            c.source === "artifact"
              ? { source: "artifact", path: c.path, ...(c.line ? { line: c.line } : {}) }
              : {
                  source: "code",
                  repo: c.repo ?? r.repo,
                  path: c.path,
                  ...(c.line ? { line: c.line } : {}),
                },
          ),
          waivable: rule.waivable,
          state: "open",
          createdAt: now,
        }),
      );
    }
  for (const r of results)
    for (const c of r.claims ?? []) {
      const f = claimFinding(change, c, rules, now);
      if (f) out.push(f);
    }
  return out;
}

/** The stored results, one per repo checked (newest check of each). */
export async function readConformResults(
  root: string,
  change: string,
): Promise<{ results: Api.ConformRepoResultT[]; problems: string[] }> {
  const dir = join(changeFolder(root, change), CONFORM_DIR);
  const results: Api.ConformRepoResultT[] = [];
  const problems: string[] = [];
  for (const f of (await readdir(dir).catch(() => [] as string[])).sort()) {
    if (!f.endsWith(".yaml")) continue;
    try {
      const r = Api.ConformRepoResult.safeParse(parse(await readFile(join(dir, f), "utf8")));
      if (r.success) results.push(r.data);
      else
        problems.push(
          `${CONFORM_DIR}/${f}: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        );
    } catch (e) {
      problems.push(`${CONFORM_DIR}/${f}: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  return { results, problems };
}

/** The change's target flows with today's flows from the specs. */
async function deltasOf(root: string, change: string) {
  const { deltas, problems } = await readConformDeltas(changeFolder(root, change));
  const specs = new Map<string, FlowRecord[]>();
  const out: ConformDelta[] = [];
  for (const d of deltas) {
    if (!specs.has(d.delta.repo))
      specs.set(d.delta.repo, (await readRepoSpec(root, d.delta.repo, { cacheRoot: root })).flows);
    const today = specs.get(d.delta.repo)!.find((f) => f.id === d.delta.flow);
    if (d.delta.change !== "new" && !today)
      problems.push(
        `${d.file}: ${d.delta.flow} isn't in ${d.delta.repo}'s spec, so the steps it ${d.delta.change === "remove" ? "removes" : "changes"} are checked without today's flow.`,
      );
    out.push(today ? { ...d, today } : d);
  }
  return { deltas: out, problems };
}

/** Each target-flow step's line, keyed "<flow>#<item>" (0: the trigger). */
function linesOf(deltas: ConformDelta[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const d of deltas) {
    m.set(`${d.delta.flow}#0`, d.triggerLine);
    d.stepLines.forEach((l, i) => m.set(`${d.delta.flow}#${i + 1}`, l));
  }
  return m;
}

/**
 * Check a change's code against its target flows: per repo, scan the branch's commit and its
 * base, compare, keep the result and write the findings. Throws ConformError when the change,
 * the task or the base clone isn't there.
 */
export async function conformChange(
  root: string,
  change: string,
  o: ConformOptions = {},
): Promise<ConformRun> {
  await changeStore(root)
    .read(change)
    .catch(() => {
      throw new ConformError("not-found", `There is no change ${change}.`);
    });
  const git = o.git ?? createGit();
  const now = o.now ?? stamp();
  const { deltas, problems } = await deltasOf(root, change);
  // ADR 0206: what the change states its code will have, beside its target flows.
  const dirOfChange = changeFolder(root, change);
  const stated = await readClaims(dirOfChange);
  problems.push(...stated.problems);
  if (!deltas.length && !stated.claims.length)
    return { results: [], problems, flows: 0, claims: 0 };

  const tasks = await readTaskSteps(dirOfChange);
  let taskRepo: string | undefined;
  /** A task's claims: an operation's task by its label, a row by its task; else its repo's. */
  let taskClaims: Claim[] | undefined;
  if (o.task) {
    const t = o.task.toLowerCase();
    const listed = readChangeTasks(await readChangeFiles(dirOfChange)).find((x) => x.id === t);
    const flow = [...tasks].find(([, v]) => v === t)?.[0].split("#")[0];
    const own = stated.claims.filter((c) => c.label === t || c.from.task === t);
    taskRepo =
      listed?.repo ?? deltas.find((d) => d.delta.flow === flow)?.delta.repo ?? own[0]?.repo;
    if (taskRepo) taskClaims = own.length ? own : stated.claims.filter((c) => c.repo === taskRepo);
    if (!taskRepo)
      throw new ConformError(
        "not-found",
        `There is no task ${o.task} in ${change}'s tasks.md or stories.`,
      );
  }
  const claims = taskClaims ?? stated.claims;
  const repos = o.repo
    ? [o.repo]
    : taskRepo
      ? [taskRepo]
      : [...new Set([...deltas.map((d) => d.delta.repo), ...claims.map((c) => c.repo)])].sort();
  if (
    o.repo &&
    !deltas.some((d) => d.delta.repo === o.repo) &&
    !claims.some((c) => c.repo === o.repo)
  )
    problems.push(`No target flow of ${change} is in ${o.repo}; only what it adds is checked.`);
  const scanAt = o.scanAt ?? gitScanAt(root, git, dirOfChange);
  const results: Api.ConformRepoResultT[] = [];

  for (const repo of repos) {
    const ref = o.ref ?? (o.task ? taskBranch(change, o.task.toLowerCase()) : changeBranch(change));
    const base = baseClonePath(root, repo);
    if (!existsSync(base))
      throw new ConformError(
        "refused",
        `There is no base clone of ${repo}; run atticus workspace sync first.`,
      );
    const commit = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], base).then(
      (x) => x.stdout.trim(),
      () => "",
    );
    if (!commit) {
      problems.push(
        `${repo} has no ${ref} yet, so there is no code to check: open the change (atticus workspace open ${change} --repos ${repo}) or name the branch with --ref.`,
      );
      continue;
    }
    // The base the branch was cut from: where it meets the base clone's own branch.
    const from = await git(["merge-base", commit, "HEAD"], base).then(
      (x) => x.stdout.trim() || commit,
      () => commit,
    );
    const after = await scanAt(repo, commit);
    const before = from === commit ? after : await scanAt(repo, from);
    const scope = o.task
      ? [...tasks]
          .filter(([, v]) => v === o.task!.toLowerCase())
          .map(([k]) => ({ flow: k.split("#")[0]!, item: Number(k.split("#")[1]) }))
      : undefined;
    const repoProblems = [...new Set([...before.problems, ...after.problems])];
    if (o.task && deltas.length && !scope?.length)
      repoProblems.push(
        `The stories don't say which target-flow steps task ${o.task} builds, so every step of ${repo}'s target flows is checked.`,
      );
    const r = deltas.length
      ? conform({
          repo,
          deltas,
          ...(scope?.length ? { scope } : {}),
          tasks,
          before: before.records,
          after: after.records,
          files: after.files,
          basis: after.basis,
        })
      : { items: [] as ConformItem[], unchecked: [] };
    // ADR 0206: each claim in this repo, looked for in the facts at the commit.
    const mine = claims.filter((c) => c.repo === repo);
    const judged = mine.length
      ? conformClaims({
          change,
          changesRel: changesRelOf(root),
          repo,
          claims: mine,
          before: before.facts ?? [],
          after: after.facts ?? [],
          files: after.files,
          basis: after.basis,
          lineAt: (path, line) => after.lines?.get(path)?.[line - 1],
          // A change whose whole design is its claims: what the branch adds and no claim names.
          unexpected: !deltas.length,
        })
      : { claims: [], unexpected: [] };
    r.items.push(...judged.unexpected);
    const count = (s: ConformItem["status"]) => r.items.filter((i) => i.status === s).length;
    const result: Api.ConformRepoResultT = {
      schemaVersion: 1,
      change,
      repo,
      ref,
      commit,
      base: from,
      ...(o.task ? { task: o.task.toLowerCase() } : {}),
      checkedAt: now,
      counts: {
        found: count("found"),
        missing: count("missing"),
        stillThere: count("still-there"),
        unexpected: count("unexpected"),
        ...(judged.claims.length ? { claims: claimCounts(judged.claims) } : {}),
      },
      items: r.items,
      unchecked: r.unchecked,
      ...(judged.claims.length ? { claims: judged.claims } : {}),
      problems: repoProblems,
    };
    await writeFileAtomic(
      join(changeFolder(root, change), CONFORM_DIR, `${repo}.yaml`),
      toCanonicalYaml(result, [
        "schemaVersion",
        "change",
        "repo",
        "ref",
        "commit",
        "base",
        "task",
        "checkedAt",
        "counts",
        "status",
        "check",
        "flow",
        "item",
        "outcome",
        "repo",
        "from",
      ]),
    );
    results.push(result);
  }

  // The gate's round holds every repo's newest result, so one repo's check doesn't hide another's.
  const stored = await readConformResults(root, change);
  problems.push(...stored.problems);
  const round = await writeGateRound(
    root,
    change,
    CONFORM_GATE,
    await conformFindings(change, stored.results, linesOf(deltas), now),
    now,
  );
  return {
    results,
    ...(round.round ? { round: round.round } : {}),
    problems,
    flows: deltas.length,
    claims: stated.claims.length,
  };
}

/** The API's body: the stored results, each item with its finding's state (no scan). */
export async function conformanceOf(
  root: string,
  change: string,
): Promise<Api.ChangeConformanceT | undefined> {
  const c = await changeStore(root)
    .read(change)
    .catch(() => undefined);
  if (!c) return undefined;
  const { deltas, problems } = await readConformDeltas(changeFolder(root, change));
  // ADR 0203: the operations, which this check doesn't look at, counted so the app says so.
  const operations = (await readOperations(changeFolder(root, change))).file?.operations.length;
  // ADR 0206: the claims the change states, which the check looks for.
  const claims = (await readClaims(changeFolder(root, change))).claims.length;
  const stored = await readConformResults(root, change);
  const rounds = await roundsOf(root, change, CONFORM_GATE).catch(() => [] as number[]);
  const round = rounds.at(-1);
  const states = new Map<string, string>();
  if (round)
    for (const f of (await readRound(root, change, CONFORM_GATE, round)).findings)
      states.set(f.finding.id, f.finding.state);
  return {
    change,
    title: c.title,
    flows: deltas.length,
    ...(operations ? { operations } : {}),
    ...(claims ? { claims } : {}),
    results: stored.results.map((r) => ({
      ...r,
      items: r.items.map((i) => {
        if (i.status === "found") return i;
        const id = conformFindingId(i);
        return { ...i, finding: { id, state: states.get(id) ?? "open" } };
      }),
      ...(r.claims
        ? {
            claims: r.claims.map((c) => {
              if (!claimRule(c.outcome as ClaimResult["outcome"])) return c;
              const id = claimFindingId(c as ClaimResult);
              return { ...c, finding: { id, state: states.get(id) ?? "open" } };
            }),
          }
        : {}),
    })),
    gate: CONFORM_GATE,
    ...(round ? { round } : {}),
    problems: [...problems, ...stored.problems],
  };
}

/** What a task run needs to check its commit (ADR 0114): the run's own context. */
export interface BuiltTask {
  root: string;
  t: { change: { id: string }; task: { id: string } };
  record: { state: string; commit?: string; branch: string; notes: string[] };
  git: GitRunner;
  now: () => Date;
}

/**
 * The end of a task run whose build passed: check the task branch's commit against the target
 * flows (the task's steps), and say what came of it in the run's notes. A change with no target
 * flows has nothing to check; a check that can't run is a note, never a failed run.
 */
export async function conformAfterBuild(
  c: BuiltTask,
  o: Pick<ConformOptions, "scanAt"> = {},
): Promise<void> {
  if (c.record.state !== "built" || !c.record.commit) return;
  const change = c.t.change.id;
  const task = c.t.task.id;
  try {
    const r = await conformChange(c.root, change, {
      task,
      ref: c.record.branch,
      git: c.git,
      now: c
        .now()
        .toISOString()
        .replace(/\.\d{3}Z$/, "Z"),
      ...(o.scanAt ? { scanAt: o.scanAt } : {}),
    });
    if (!r.flows && !r.claims) return;
    const x = r.results[0];
    const cmd = `atticus change conform ${change} --task ${task}`;
    if (!x) {
      c.record.notes.push(
        `The code wasn't checked against the design: ${r.problems[0] ?? "nothing to check"} (${cmd}).`,
      );
      return;
    }
    const n = x.counts;
    const k = n.claims;
    const claimsOf = (m: number, words: string) =>
      m ? `${m} claim${m === 1 ? "" : "s"} ${words}` : "";
    const parts = [
      n.missing ? `${n.missing} missing` : "",
      n.stillThere ? `${n.stillThere} still there` : "",
      n.unexpected ? `${n.unexpected} not in the design` : "",
      claimsOf(k?.missing ?? 0, "missing"),
      claimsOf(k?.differs ?? 0, "present differently"),
      claimsOf(k?.notCheckable ?? 0, "to check by hand"),
      claimsOf(k?.unconfirmed ?? 0, "not confirmed"),
    ].filter(Boolean);
    c.record.notes.push(
      parts.length
        ? `Checked against the design: ${parts.join(", ")}; the findings are on the conform gate (${cmd}).`
        : `Checked against the design: ${n.found + (k?.present ?? 0)} found, nothing missing or unexpected (${cmd}).`,
    );
  } catch (e) {
    c.record.notes.push(
      `The code couldn't be checked against the design: ${(e as Error).message.split("\n")[0]}`,
    );
  }
}
