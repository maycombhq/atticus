import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import type { SourceInput } from "@maycombhq/ai";
import { writeFileAtomic } from "@maycombhq/changes";
import { estateRepos, notEstateWhy, type Estate } from "./estate.js";
import type { StageIssue } from "./loop.js";
import { schemaProblems } from "./schema-words.js";
import {
  OperationsFile,
  STAGE_SCHEMA_VERSION,
  type DeployStep,
  type FeaturePlacement,
  type Operation,
  type Wave,
} from "./schema.js";

/**
 * ADR 0203 part B: work that is no runtime step. A change's operations (a deployment, a pipeline,
 * configuration, a secret, a route, a cut-over) are one list in `target-flows/_operations.yaml`,
 * checked against the estate and against what the catalog says runs today (Component.runtime,
 * Deployment and Setting records, read and never changed). Nothing here calls a model.
 */

export const OPERATIONS_FILE = "target-flows/_operations.yaml";
type Rec = Estate["records"][number] & Record<string, unknown>;
type Cite = { repo?: string; path?: string; line?: number };
const TODAY_KINDS = ["Component", "Deployment", "Setting", "GatewayRoute", "Endpoint"];
const andList = (xs: string[]) =>
  xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;
const bare = (s: string) => s.trim().replace(/[.\s]+$/, "");
const sentence = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

/** The operations file as it is in the change folder: none, or what in it doesn't read. */
export async function readOperations(
  dir: string,
): Promise<{ file?: OperationsFile; problems: string[] }> {
  const text = await readFile(join(dir, ...OPERATIONS_FILE.split("/")), "utf8").catch(
    () => undefined,
  );
  if (text === undefined) return { problems: [] };
  try {
    const r = OperationsFile.safeParse(parse(text));
    return r.success
      ? { file: r.data, problems: [] }
      : { problems: schemaProblems(OPERATIONS_FILE, text, r.error.issues) };
  } catch (e) {
    return { problems: [`${OPERATIONS_FILE}: ${(e as Error).message.split("\n")[0]}`] };
  }
}

export async function writeOperations(
  dir: string,
  change: string,
  operations: Operation[],
  waves: Wave[] | undefined,
  by: string,
): Promise<void> {
  const file = OperationsFile.parse({
    schemaVersion: STAGE_SCHEMA_VERSION,
    change,
    ...(waves?.length ? { waves } : {}),
    operations,
  });
  await writeFileAtomic(
    join(dir, ...OPERATIONS_FILE.split("/")),
    `# The change's work that is no runtime step (ADR 0203): deployments, pipelines, configuration, secrets, routes and cut-overs. Drafted by ${by}.\n${stringify(file, { lineWidth: 0 })}`,
  );
}

/** The repos a record is of: its own, its component's, and the repos its evidence cites. */
function reposOf(e: Estate, r: Rec): Set<string> {
  const c = r.kind === "Component" ? r : (e.byId.get(String(r.component ?? "")) as Rec | undefined);
  return new Set([
    ...(typeof c?.repo === "string" ? [c.repo] : []),
    ...(r.evidence as Cite[]).flatMap((x) => (x.repo ? [x.repo] : [])),
  ]);
}

const todayRecords = (e: Estate, repos: readonly string[], kinds = TODAY_KINDS): Rec[] =>
  (e.records as Rec[]).filter(
    (r) => kinds.includes(r.kind) && repos.some((x) => reposOf(e, r).has(x)),
  );

/** What a record says runs today, without its id: a Setting's key and kind, never its value. */
function todayWords(r: Rec): string {
  if (r.kind === "Deployment") {
    const hosts = ((r.ingress as { host: string; path?: string }[] | undefined) ?? []).map(
      (i) => `${i.host}${i.path ?? ""}`,
    );
    return `env ${String(r.env)}, platform ${String(r.platform)}${hosts.length ? `, ingress ${hosts.join(", ")}` : ""}`;
  }
  if (r.kind === "Setting") return `${String(r.key)} (${String(r.settingKind)})`;
  return r.kind === "Component" ? `runtime ${String(r.runtime ?? "not said")}` : r.kind;
}

/** The record's own provenance: the first file and line its evidence cites. */
function citeOf(r: Rec): string {
  const c = (r.evidence as Cite[]).find((x) => x.path);
  return c ? ` (${c.repo ? `${c.repo}:` : ""}${c.path}${c.line ? `:${c.line}` : ""})` : "";
}

/**
 * The `runs-today` data block of the feature and architecture prompts: each repo's component and
 * where it runs, its Deployment records and its Setting keys and kinds, each with its id. None
 * when the catalog has no such record for the repos, so such a prompt is as it was.
 */
export function runsTodaySource(e: Estate, repos: Iterable<string>): SourceInput[] {
  const blocks = [...new Set(repos)].sort().flatMap((repo) => {
    const rows = todayRecords(e, [repo], ["Component", "Deployment", "Setting"]).filter(
      (r) => r.kind !== "Component" || r.repo === repo,
    );
    if (!rows.some((r) => r.kind !== "Component" || r.runtime)) return [];
    const line = (r: Rec) =>
      `${r.id}: ${r.kind === "Deployment" ? `Deployment of ${String(r.component)}` : r.kind}${r.kind === "Setting" ? " " : ", "}${todayWords(r)}`;
    return [`# ${repo}\n${rows.map(line).join("\n")}`];
  });
  if (!blocks.length) return [];
  return [
    {
      id: "runs-today",
      kind: "catalog",
      origin: "the catalog's Component, Deployment and Setting records (deterministic)",
      text: `What runs today in each repo, from the catalog: where its component runs, its deployments and the settings it has by key and kind (never a value). Cite these ids under an operation's today.\n\n${blocks.join("\n\n")}`,
      classification: "internal",
      priority: 75,
    },
  ];
}

const waveOf = (waves: readonly Wave[] | undefined, repo: string): number =>
  Math.max(1, (waves ?? []).findIndex((w) => w.repos.includes(repo)) + 1);

/** The operations in an order that keeps every `after`, else file order. */
function inAfterOrder(ops: readonly Operation[]): Operation[] {
  const left = [...ops];
  const out: Operation[] = [];
  while (left.length) {
    const i = left.findIndex((o) => (o.after ?? []).every((a) => !left.some((x) => x.id === a)));
    out.push(...left.splice(Math.max(i, 0), 1));
  }
  return out;
}

/** With no deploy order given: waves first, then `after`, then file order. */
export function suggestedOperationOrder(
  ops: readonly Operation[],
  waves?: readonly Wave[],
): (DeployStep & { operation: string })[] {
  const last = Math.max(1, waves?.length ?? 1);
  const out: (DeployStep & { operation: string })[] = [];
  for (let w = 1; w <= last; w++)
    for (const o of inAfterOrder(ops))
      for (const repo of o.repos)
        if (waveOf(waves, repo) === w) out.push({ repo, operation: o.id });
  return out;
}

/** The architecture stage's checks of a change's operations: all blocking but the last, a note. */
export function checkOperations(
  ops: readonly Operation[],
  waves: readonly Wave[] | undefined,
  e: Estate,
  placement: Pick<FeaturePlacement, "newFlows" | "operations">,
  planned: ReadonlySet<string> = new Set(),
): StageIssue[] {
  const out: StageIssue[] = [];
  const issue = (rule: string, target: string, message: string, repo?: string) =>
    out.push({
      rule: `operation.${rule}`,
      target,
      message,
      blocking: true,
      ...(repo ? { repo } : {}),
    });
  const known = new Set([
    ...estateRepos(e),
    ...planned,
    ...placement.newFlows.filter((f) => f.newRepo).map((f) => f.repo),
    ...(placement.operations ?? []).filter((o) => o.newRepo).flatMap((o) => o.repos),
  ]);
  const ids = ops.map((o) => o.id);
  for (const o of ops) {
    for (const repo of o.repos.filter((r) => !known.has(r)))
      issue(
        "unknown-repo",
        `${o.id}:${repo}`,
        `Operation ${o.id} names repo ${repo}, which the estate doesn't have and this change doesn't plan: name a repo from the index, or mark it newRepo: true in feature.yaml.${notEstateWhy(e, repo)}`,
      );
    for (const id of o.today ?? []) {
      const r = e.byId.get(id) as Rec | undefined;
      if (!r || !TODAY_KINDS.includes(r.kind) || !o.repos.some((x) => reposOf(e, r).has(x)))
        issue(
          "unknown-today",
          `${o.id}:${id}`,
          `Operation ${o.id} cites ${id} under today, which is no ${TODAY_KINDS.slice(0, -1).join(", ")} or Endpoint record of ${andList(o.repos)}: cite records of the operation's own repos, from the runs-today block, or leave today out.`,
        );
    }
    if (o.kind === "cut-over" && !o.undo)
      issue(
        "no-undo",
        o.id,
        `Operation ${o.id} is a cut-over and gives no undo: say under undo how it is taken back, in one or two sentences.`,
      );
    for (const a of (o.after ?? []).filter((a) => !ids.includes(a)))
      issue(
        "after",
        `${o.id}:${a}`,
        `Operation ${o.id} comes after ${a}, which is no operation of this change (${ids.join(", ")}).`,
      );
  }
  // A circle: operations that reach themselves through after.
  const reach = (from: string, seen = new Set<string>()): Set<string> => {
    for (const a of ops.find((o) => o.id === from)?.after ?? [])
      if (!seen.has(a)) reach(a, seen.add(a));
    return seen;
  };
  const circle = ids.filter((id) => reach(id).has(id));
  if (circle.length)
    issue(
      "after",
      circle.join(">"),
      `Operations ${andList(circle)} each come after the other: an operation can't wait for one that waits for it.`,
    );
  if (waves?.length) {
    const said = new Set<string>();
    for (const repo of new Set(waves.flatMap((w) => w.repos))) {
      const at = waves.flatMap((w, i) => (w.repos.includes(repo) ? [i + 1] : []));
      if (at.length > 1 && said.add(repo))
        issue(
          "wave",
          repo,
          `Repo ${repo} is in waves ${andList(at.map(String))}: put every repo in exactly one wave, or leave waves out.`,
          repo,
        );
    }
    for (const o of ops)
      for (const repo of o.repos)
        if (!waves.some((w) => w.repos.includes(repo)) && !said.has(repo) && said.add(repo))
          issue(
            "wave",
            repo,
            `Repo ${repo} of operation ${o.id} is in no wave: put every repo in exactly one wave, or leave waves out.`,
            repo,
          );
  }
  for (const f of placement.operations ?? [])
    for (const repo of f.repos)
      if (!ops.some((o) => o.kind === f.kind && o.repos.includes(repo)))
        issue(
          "missing",
          `${f.kind}:${repo}`,
          `The feature lists a ${f.kind} operation in ${repo} (${f.what}) and no operation here is of that kind in that repo: add it, or take it out of feature.yaml.`,
          repo,
        );
  for (const o of ops) {
    if (o.kind !== "deployment" && o.kind !== "route") continue;
    const have = todayRecords(e, o.repos, ["Deployment"]).map((r) => r.id);
    if (have.length && !(o.today ?? []).some((id) => have.includes(id)))
      out.push({
        rule: "operation.today-uncited",
        target: o.id,
        message: `Operation ${o.id} is a ${o.kind} and cites nothing under today, and the catalog has Deployment records for its repos: ${have.join(", ")}. Cite the ones it replaces or changes.`,
        blocking: false,
      });
  }
  return out;
}

/**
 * The deploy order's operation steps (`{ repo, operation }`) against the operations: every
 * operation and repo once, `after` kept, and no step of a wave before the last step of the wave
 * before it. With no operation step the suggested order stands and there is nothing to check.
 */
export function operationDeployIssues(
  ops: readonly Operation[],
  waves: readonly Wave[] | undefined,
  deploy: readonly DeployStep[] | undefined,
): StageIssue[] {
  if (!ops.length || !deploy?.some((s) => s.operation)) return [];
  const out: StageIssue[] = [];
  const issue = (rule: string, target: string, message: string, repo: string) =>
    out.push({ rule: `delta.${rule}`, target, message, blocking: true, repo });
  const pos = (op: string, repo: string) =>
    deploy.findIndex((s) => s.operation === op && s.repo === repo) + 1;
  const lastOfWave = (w: number) =>
    Math.max(0, ...deploy.map((s, i) => (s.operation && waveOf(waves, s.repo) === w ? i + 1 : 0)));
  deploy.forEach((s, i) => {
    if (s.operation && !ops.some((o) => o.id === s.operation && o.repos.includes(s.repo)))
      issue(
        "deploy-unknown-repo",
        `deploy#${i + 1}`,
        `Step ${i + 1} of the deploy order does operation ${s.operation} in ${s.repo}, which ${OPERATIONS_FILE} doesn't have: name an operation and one of its repos.`,
        s.repo,
      );
  });
  for (const o of ops)
    for (const repo of o.repos) {
      const at = pos(o.id, repo);
      if (!at) {
        issue(
          "deploy-missing",
          `deploy:${o.id}:${repo}`,
          `The deploy order leaves out operation ${o.id} in ${repo}: add a step { repo: ${repo}, operation: ${o.id} }.`,
          repo,
        );
        continue;
      }
      for (const a of ops.filter((x) => (o.after ?? []).includes(x.id))) {
        const first = Math.max(
          ...(a.repos.includes(repo) ? [repo] : a.repos).map((r) => pos(a.id, r)),
        );
        if (first > at)
          issue(
            "deploy-order",
            `deploy:${a.id}>${o.id}:${repo}`,
            `The deploy order puts operation ${o.id} in ${repo} (step ${at}) before ${a.id} (step ${first}), which it comes after: ${a.id} goes first.`,
            repo,
          );
      }
      const w = waveOf(waves, repo);
      if (w > 1 && lastOfWave(w - 1) > at)
        issue(
          "deploy-order",
          `deploy:wave${w}:${o.id}:${repo}`,
          `The deploy order puts operation ${o.id} in ${repo} (step ${at}), of wave ${w}, before the last step of wave ${w - 1} (step ${lastOfWave(w - 1)}): a wave starts once the wave before it is done.`,
          repo,
        );
    }
  return out;
}

/** design.md's "## Operations": a row an operation and repo, today (cited) and what it becomes. */
export function renderOperations(
  ops: readonly Operation[],
  waves: readonly Wave[] | undefined,
  e: Estate,
): string[] {
  if (!ops.length) return [];
  const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const rows = ops.flatMap((o) =>
    o.repos.map((repo) => {
      const today = (o.today ?? [])
        .map((id) => e.byId.get(id) as Rec | undefined)
        .filter((r): r is Rec => !!r && reposOf(e, r).has(repo))
        .map((r) => `${r.id}: ${todayWords(r).replace(/, ingress .*$/, "")}${citeOf(r)}`);
      const sets = Object.entries(o.sets ?? {}).map(([k, v]) => `${k} ${v}`);
      return `| ${o.id} | ${o.kind} | ${repo} | ${waveOf(waves, repo)} | ${cell(today.join("; ") || "not cited")} | ${cell(`${sentence(o.what)}${sets.length ? ` Sets ${sets.join(", ")}.` : ""}`)} |`;
    }),
  );
  return [
    "## Operations",
    "",
    "Work that is no runtime step, from target-flows/_operations.yaml. Today is what the catalog's records say, each cited where it was read; a person confirms what a scan can't see.",
    "",
    "| Operation | Kind | Repo | Wave | Today | Becomes |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
  ];
}

/** The Rollout and rollback section with a row for each operation that gives an undo. */
export function withOperationRollback(section: string[], ops: readonly Operation[]): string[] {
  const rows = ops
    .filter((o) => o.undo)
    .map(
      (o) =>
        `| Operation ${o.id} | ${o.kind} in ${o.repos.join(", ")} | ${sentence(o.undo!).replace(/\|/g, "\\|")} | Nothing is stored by the operation itself |`,
    );
  if (!rows.length) return section;
  const head = section.findIndex((l) => l.startsWith("| --- |"));
  if (head >= 0) return [...section.slice(0, -1), ...rows, ""];
  return [
    ...section,
    "| Store | Change | How it is undone | Rows written in between |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
  ];
}

export { bare as bareWords, waveOf as operationWave, inAfterOrder };
