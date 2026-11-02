import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import {
  catalogDirOf,
  changesDirOf,
  isAdopted,
  factsDirOf,
  factsFileOf,
  factsRelOf,
  fastPathOf,
  listQuestions,
  orderQuestions,
  questionWeights,
  proposalsDirOf,
  loadOrgPack,
  orgPackDirOf,
  readRepoSpec,
  readSpecFindings,
  ScanVerifyProposal,
  stepModelsOf,
} from "@maycombhq/core";
import { stepClassOfNextStep } from "@maycombhq/ai";
import { rulesLacking } from "@maycombhq/assistant-files";
import { changeStore, loadChangePolicy, stageCompletion } from "@maycombhq/changes";
import { readKnowledge, snapshotDates, workingDays } from "@maycombhq/knowledge";
import {
  metarepoOpenSpec,
  openspecProgress,
  readNeeds,
  seedCollisions,
  type SeedCollision,
} from "@maycombhq/planner";
import { readChangeFiles } from "@maycombhq/naysayer";
import { readChangeTasks } from "@maycombhq/speckit";
import { readCatalog } from "@maycombhq/scanner";
import { baseClonePath } from "@maycombhq/workspace";
import type { Output } from "./commands.js";
import { onboardingView } from "./ui-api-onboarding.js";
import {
  ASSISTANT_FORMATS,
  probedAssistant,
  readProbes,
  whatRunsWhere,
} from "@maycombhq/assistant-files";
import { isMetarepo, notMetarepo } from "./metarepo-guard.js";
import {
  loadReadPlan,
  partOfWords,
  readCostOf,
  readCostWords,
  readPlanProgress,
  readPlanRelOf,
  tokensWords,
  type ReadCost,
} from "./map-parts.js";
import { onboardingQueue, queueWhy, reasonOf, type QueueReason } from "./onboarding-queue.js";
import { catalogSources, headFromFiles } from "./ui-api-trust.js";
import { repoIdKey } from "./repo-ids.js";
import { checkoutOf, conventionsAt } from "./facts-files.js";
import { houseUntaughtOf, houseUntaughtWords } from "./house-imports.js";
import type { HouseImport } from "@maycombhq/verify";

/**
 * atticus next [--all] [--json] (ADR 0086, plan principle 8): the next step to take, worked out
 * from the metarepo's files only (the manifests, the clones, scan settings, the catalog, the
 * verify proposals, questions/, specs/, the knowledge snapshots and items, the changes). It
 * runs nothing and calls nothing. Each step has its command and, where `atticus
 * assistant-files` writes one, the slash command to type in Copilot Chat.
 */

export interface NextStep {
  /** A stable name for the kind of step: survey, scan, verify, answer, spec, ... */
  step: string;
  command: string;
  /** The slash command for Copilot Chat, when one does this step. */
  slash?: string;
  /** Where the slash command is typed: the metarepo, or a code repo by id. */
  where?: string;
  why: string;
  /** A step only a person can take (accepting a proposal, approving a design). */
  person?: boolean;
  repo?: string;
  change?: string;
  source?: string;
}

export interface RepoState {
  id: string;
  cloned: boolean;
  settings: boolean;
  scanned: boolean;
  /** none: never verified; accept: settings entries waiting for a person; done. */
  verify: "none" | "accept" | "done";
  flows: number;
  /** The spec check read the latest draft. */
  checked: boolean;
  /** Findings of the last check that haven't become a question. */
  findings: number;
  /**
   * Its spec and catalog come from its verified facts (`atticus verify --write`, ADR 0124): the
   * reader path (survey, scan, verify, spec draft and check) is not its way in (B-run2-fixes 7).
   */
  facts?: boolean;
  /** Its assistant wrote its facts (facts/<repo>.jsonl), whether or not they are written yet. */
  read?: boolean;
  /**
   * The read plan of a repo read in parts (ADR 0124 addendum A-ledger): how many parts there are,
   * how many the facts account for, and which comes next.
   */
  readPlan?: {
    total: number;
    done: number;
    next?: { part: number; paths: string[] };
    file: string;
  };
  /**
   * ADR 0141 (P6): where it sits in the onboarding queue (0 first) and why, for a repo not mapped
   * yet: reads under way, then the repos the read repos call, then gateways, then the rest.
   */
  queue?: { order: number; reason: QueueReason; why: string };
  /** ADR 0141: what its read is estimated to cost and what it took, as its read plan records. */
  cost?: ReadCost;
  /**
   * ADR 0141: a mapped repo whose clone has moved past its facts' commit (the verifier's report
   * against the clone's HEAD, read from its .git files): it is read again.
   */
  stale?: { facts: string; head: string };
  /**
   * ADR 0167: a read repo whose facts are of its clone's commit, read before reading rules added
   * since: the rule sets it lacks, which a top-up reads for.
   */
  rules?: string[];
  /**
   * What it is, in a person's words (ADR 0128): `none` when nothing says, `draft` when the
   * assistant wrote one and nobody has confirmed it, `said` when a person did.
   */
  described: "none" | "draft" | "said";
  /**
   * F5: when no facts are filed under this repo, the ids near it (case, `_` and `-`, a version
   * suffix aside) that do have a facts file: likely the same repo under another id.
   */
  nearFacts?: { id: string; file: string }[];
  /**
   * R3 (ADR 0147): for the first repo of the onboarding queue not read yet, the house packages it
   * imports that no taught framework covers, to teach before its read.
   */
  houseUntaught?: HouseImport[];
}

export interface NextState {
  repos: RepoState[];
  catalogRecords: number;
  openQuestions: string[];
  /** The open questions a change's stages raised (filed under the change's id), by change. */
  changeQuestions?: Record<string, string[]>;
  /**
   * The change in hand (2026-10-25): the one whose stage is in progress (drafting, waiting on its
   * assistant, waiting on a person's answers, or stopped), the most recently updated. Its steps
   * come first.
   */
  active?: string;
  /** age: days since the newest snapshot (ADR 0101: an old one is synced again). */
  sources: { id: string; snapshot: boolean; scanned: boolean; age?: number }[];
  /**
   * ADR 0101: products and vendors the knowledge names that no profile has, and a draft of
   * them waiting for a person.
   */
  orgpack?: { missing: number; draft?: { platform: string; proposals: number } };
  /** Open needs of changes whose knowledge item no person has verified. */
  unverifiedNeeds?: number;
  changes: {
    id: string;
    state: string;
    tasks: { id: string; repo: string; done: boolean }[];
    /** ADR 0101: whether its feature is placed, and what it needs from the organisation. */
    feature?: boolean;
    needs?: { open: number; longest?: string };
    /** ADR 0113: it takes the fast path (its type is small, or its brief says so where allowed). */
    fast?: boolean;
    /** ADR 0113: its one step is done (stage/small.yaml): the pull request is next. */
    fastDone?: boolean;
    /**
     * The stages of its stage path that are done, in order (ADR 0124 addendum B-change): the
     * stages can run ahead of the gates, so the state alone doesn't say what is next.
     */
    stagesDone?: string[];
    /**
     * ADR 0006 addendum: the stage whose OpenSpec artifacts come next, from `openspec status`
     * (org-flow v2), in a metarepo set up with OpenSpec. Left out when every artifact is done.
     */
    openspecStage?: "feature" | "architecture" | "stories";
    /**
     * ADR 0156: flows its spec files add as new that a repo's open seed adds too: archiving both
     * would fail, so a person accepts the seed and the stories stage runs again.
     */
    seedCollisions?: { seed: string; repo: string; capability: string; flow: string }[];
  }[];
  problems: { file: string; message: string }[];
}

const METAREPO = "metarepo";
/** The drafting stages in order: OpenSpec's status may move a change on among them, never past. */
const DRAFTING = ["feature", "architecture", "stories"] as const;
/** Where a stage sits among the drafting stages; -1 for a stage that isn't one of them. */
const draftingAt = (s: string) => DRAFTING.indexOf(s as (typeof DRAFTING)[number]);

/**
 * Whether OpenSpec's status could move this change on: only a change at a drafting stage with
 * a later one after it (stageSteps takes a later stage only). For every other state the answer
 * can't change, so `openspec status` isn't run for it.
 */
export const canMoveOn = (state: string) => {
  const at = draftingAt(stageOf(state));
  return at >= 0 && at < DRAFTING.length - 1;
};
/** A snapshot older than this many days is synced again (ADR 0101). */
const STALE_DAYS = 14;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

async function verifyState(root: string, repo: string): Promise<RepoState["verify"]> {
  const text = await readFile(join(proposalsDirOf(root), "scan", `${repo}.yaml`), "utf8").catch(
    () => undefined,
  );
  if (text === undefined) return "none";
  const p = ScanVerifyProposal.safeParse(parse(text));
  if (!p.success) return "none";
  const s = p.data.settings;
  const entries = s.exclude.length + s.prefixes.length + s.clients.length;
  if (entries > 0 && (!p.data.accepted || p.data.accepted.at < p.data.at)) return "accept";
  return "done";
}

/**
 * ADR 0141: a mapped repo's facts' commit (the verifier's report) against its clone's HEAD, read
 * from the clone's .git files (no git runs); undefined when they are the same or either is unknown.
 */
async function staleOf(root: string, repo: string): Promise<RepoState["stale"]> {
  const text = await readFile(join(factsDirOf(root), `${repo}.verify.yaml`), "utf8").catch(
    () => undefined,
  );
  let facts: string | undefined;
  try {
    const c = (parse(text ?? "") as { commit?: unknown } | null)?.commit;
    if (typeof c === "string" && /^[0-9a-f]{7,64}$/.test(c)) facts = c;
  } catch {
    return undefined;
  }
  if (!facts) return undefined;
  let dir: string;
  try {
    dir = isAdopted(root) ? root : baseClonePath(root, repo);
  } catch {
    return undefined;
  }
  const head = await headFromFiles(dir);
  if (!head || head.startsWith(facts) || facts.startsWith(head)) return undefined;
  return { facts, head };
}

/** Read everything the steps depend on. Files that don't read are problems, never a crash. */
export async function readNextState(root: string): Promise<NextState> {
  const view = await onboardingView(root);
  const problems = [...view.problems];
  const repos: RepoState[] = [];
  // F5: the ids facts are filed under, so a repo with none can be told of a near one that has.
  const factIds = (await readdir(factsDirOf(root)).catch(() => [] as string[]))
    .map((n) => factsFileOf(n))
    .flatMap((f) => (f?.facts ? [f.repo] : []));
  // ADR 0141: a repo is mapped once the catalog holds records from its facts (verify --write),
  // whatever its spec header says: a header an earlier draft left keeps its own template.
  const fromFacts = catalogSources(
    (await readCatalog(join(catalogDirOf(root), "generated"), { cacheRoot: root })).records,
  );
  for (const r of view.repos) {
    const hasFacts = existsSync(join(factsDirOf(root), `${r.id}.jsonl`));
    const near = hasFacts
      ? []
      : factIds
          .filter((x) => x !== r.id && repoIdKey(x) === repoIdKey(r.id))
          .sort()
          .map((x) => ({ id: x, file: `${factsRelOf(root)}/${x}.jsonl` }));
    const spec = await readRepoSpec(root, r.id, { cacheRoot: root });
    problems.push(...spec.problems);
    const findings = await readSpecFindings(root, r.id);
    // A-ledger: the parts a repo is read in, and which the facts account for.
    const plan = await readPlanProgress(root, r.id);
    // ADR 0141: what the read is estimated to cost, and what it took.
    const planFile = await loadReadPlan(root, r.id);
    const mapped =
      !!spec.header?.template.startsWith("facts@") || (fromFacts.get(r.id)?.facts ?? 0) > 0;
    const stale = mapped && hasFacts ? await staleOf(root, r.id) : undefined;
    // ADR 0167: fresh by commit, read before the reading rules there are now.
    const rules =
      hasFacts && r.cloned && !(await staleOf(root, r.id)) ? rulesLacking(planFile?.rules) : [];
    repos.push({
      id: r.id,
      cloned: r.cloned,
      settings: r.scanSettings.present,
      scanned: r.lastScan !== null,
      verify: await verifyState(root, r.id),
      flows: spec.flows.length,
      checked: !!findings && findings.draftedAt === spec.header?.drafted?.at,
      findings: findings?.findings.filter((f) => !f.question).length ?? 0,
      described: !r.description ? "none" : r.description.trust === "suggested" ? "draft" : "said",
      ...(mapped ? { facts: true } : {}),
      ...(stale ? { stale } : {}),
      ...(rules.length ? { rules } : {}),
      ...(planFile ? { cost: readCostOf(planFile) } : {}),
      ...(hasFacts ? { read: true } : {}),
      ...(near.length ? { nearFacts: near } : {}),
      ...(plan
        ? {
            readPlan: {
              total: plan.total,
              done: plan.done,
              ...(plan.next ? { next: { part: plan.next.part, paths: plan.next.paths } } : {}),
              file: readPlanRelOf(root, r.id),
            },
          }
        : {}),
    });
  }
  // ADR 0141 (P6): the repos not mapped yet, in the order that lands links early.
  const waiting = repos.filter((r) => r.cloned && !r.facts && !r.scanned);
  if (waiting.length) {
    const q = await onboardingQueue(
      root,
      waiting.map((r) => ({
        repo: r.id,
        ...(r.read || (r.readPlan?.done ?? 0) > 0 ? { started: true } : {}),
      })),
    );
    problems.push(...q.problems);
    q.queue.forEach((x, order) => {
      const r = repos.find((y) => y.id === x.repo)!;
      r.queue = { order, reason: reasonOf(x), why: queueWhy(x) };
    });
    // R3: the first repo to read is looked at for house imports nothing taught covers. Only the
    // first, so the step costs one repo's files, and only when the org pack names house prefixes.
    const first = waiting
      .filter((r) => !r.read)
      .sort((a, b) => (a.queue?.order ?? Infinity) - (b.queue?.order ?? Infinity))[0];
    const dir = first ? await checkoutOf(root, first.id) : undefined;
    if (first && dir && (await conventionsAt(root)).housePrefixes.length) {
      const found = await houseUntaughtOf(root, first.id, { dir }).catch(() => []);
      if (found.length) first.houseUntaught = found;
    }
  }
  const open = await listQuestions(root, { state: "open" });
  problems.push(...open.problems);
  const changeIds = new Set(
    await changeStore(root)
      .list()
      .then(
        (cs) => cs.map((c) => c.id),
        () => [] as string[],
      ),
  );
  const changeQuestions: Record<string, string[]> = {};
  for (const q of open.questions)
    if (changeIds.has(q.repo)) (changeQuestions[q.repo] ??= []).push(q.id);
  const knowledge = await readKnowledge(root, { cacheRoot: root });
  const sources: NextState["sources"] = [];
  for (const w of view.sources.wikis) {
    const newest = (await snapshotDates(root, w.id))[0];
    sources.push({
      id: w.id,
      snapshot: !!newest,
      scanned:
        !!newest &&
        !!knowledge.report?.snapshots.some((s) => s.source === w.id && s.date === newest),
      ...(newest
        ? { age: Math.floor((Date.now() - Date.parse(`${newest}T00:00:00Z`)) / 86_400_000) }
        : {}),
    });
  }
  // The org pack, read once for everything below it (the profiles' systems, the change types).
  const orgPack = await loadOrgPack(orgPackDirOf(root)).catch((e: Error) => e);
  // ADR 0101: what the knowledge names that the org pack's profiles don't have yet.
  let orgpack: NextState["orgpack"];
  try {
    if (orgPack instanceof Error) throw orgPack;
    const op = orgPack;
    const names = new Set(
      op.profiles
        .flatMap((p) => (p.profile?.systems ?? []).flatMap((x) => [x.name, ...x.aliases]))
        .map((n) => n.toLowerCase()),
    );
    const missing = knowledge.items.filter(
      (i) =>
        ((i.kind === "Product" && i.productKind === "product") ||
          (i.kind === "Party" && i.partyKind === "vendor" && !!i.quote)) &&
        ![i.name, ...i.aliases].some((n) => names.has(n.toLowerCase())),
    ).length;
    let draft: { platform: string; proposals: number } | undefined;
    for (const f of await readdir(join(proposalsDirOf(root), "orgpack")).catch(
      () => [] as string[],
    ))
      if (f.endsWith(".yaml")) {
        const d = parse(await readFile(join(proposalsDirOf(root), "orgpack", f), "utf8")) as {
          platform?: string;
          proposals?: unknown[];
        } | null;
        if (d?.platform && d.proposals?.length)
          draft = { platform: d.platform, proposals: d.proposals.length };
      }
    if (missing || draft) orgpack = { missing, ...(draft ? { draft } : {}) };
  } catch (e) {
    problems.push({ file: "org-pack", message: (e as Error).message.split("\n")[0]! });
  }
  const changes: NextState["changes"] = [];
  let unverifiedNeeds = 0;
  let active: { id: string; at: string } | undefined;
  // ADR 0113: the change types, to tell a small change from a standard one.
  const types = orgPack instanceof Error ? [] : orgPack.changeTypes.types;
  // B-change: which stages each change has done, read the way the lifecycle reads them.
  const { policy } = await loadChangePolicy(orgPackDirOf(root));
  const os = metarepoOpenSpec(root);
  // ADR 0156: the flows a change adds that an open seed adds too.
  const clashes = await seedCollisions(root).catch(() => [] as SeedCollision[]);
  try {
    for (const c of await changeStore(root).list()) {
      const clash = clashes
        .filter((x) => x.change === c.id)
        .map(({ seed, repo, capability, flow }) => ({ seed, repo, capability, flow }));
      const files = await readChangeFiles(join(changesDirOf(root), c.id)).catch(() => undefined);
      const stagesDone = (await stageCompletion({ root, policy }, c))
        .filter((s) => s.state === "done")
        .map((s) => s.stage);
      const needs = await readNeeds(root, c.id);
      const open = needs?.needs.filter((n) => n.status === "open") ?? [];
      unverifiedNeeds += open.filter((n) => {
        const r = knowledge.reviews[n.item];
        return r?.state !== "verified" && r?.state !== "corrected";
      }).length;
      const longest = open
        .map((n) => ({
          n,
          // The lead time as the knowledge scan read it (ADR 0117); a need with none sorts last.
          days: n.leadTimeDays ? workingDays(n.leadTimeDays) : 0,
        }))
        .sort((a, b) => b.days - a.days)[0];
      // ADR 0006 addendum: which stage's artifacts are written comes from OpenSpec's status.
      // It runs `openspec status` in a child process, so it is asked only where its answer can
      // move the change on: a change whose state is already at the last drafting stage, or past
      // the drafting stages, keeps the stage its state says whatever OpenSpec reports
      // (stageSteps below takes a later stage only).
      const progress =
        os && canMoveOn(c.state)
          ? await openspecProgress(os, c.id).catch(() => undefined)
          : undefined;
      const busy = await stageInProgress(root, c.id);
      if (busy && stageOf(c.state) !== "done" && (!active || busy > active.at))
        active = { id: c.id, at: busy };
      changes.push({
        id: c.id,
        state: c.state,
        tasks: files
          ? readChangeTasks(files).map((t) => ({ id: t.id, repo: t.repo, done: t.done }))
          : [],
        feature: existsSync(join(changesDirOf(root), c.id, "feature.yaml")),
        ...(stagesDone.length ? { stagesDone } : {}),
        ...(progress?.next ? { openspecStage: progress.next } : {}),
        ...(clash.length ? { seedCollisions: clash } : {}),
        ...((await isFast(root, c, types))
          ? {
              fast: true,
              ...(/^state: done$/m.test(
                await readFile(join(changesDirOf(root), c.id, "stage", "small.yaml"), "utf8").catch(
                  () => "",
                ),
              )
                ? { fastDone: true }
                : {}),
            }
          : {}),
        ...(needs
          ? {
              needs: {
                open: open.length,
                ...(longest?.days ? { longest: `${longest.n.title}, ${longest.n.leadTime}` } : {}),
              },
            }
          : {}),
      });
    }
  } catch (e) {
    problems.push({ file: "openspec/changes", message: (e as Error).message.split("\n")[0]! });
  }
  return {
    repos,
    catalogRecords: view.catalog.records,
    // ADR 0140 (Q3): in the order to ask them, what a change in flight rests on first.
    openQuestions: orderQuestions(
      open.questions,
      await questionWeights(root, open.questions).catch(() => new Map()),
    ).map((q) => q.id),
    ...(Object.keys(changeQuestions).length ? { changeQuestions } : {}),
    ...(active ? { active: active.id } : {}),
    sources,
    changes,
    problems,
    ...(orgpack ? { orgpack } : {}),
    ...(unverifiedNeeds ? { unverifiedNeeds } : {}),
  };
}

/** The states a stage's loop is in while it is under way (stage/<stage>.yaml). */
const UNDER_WAY = new Set(["drafting", "waiting", "questions", "stopped"]);

/** When a change's stage under way was last updated, or undefined when none is. */
async function stageInProgress(root: string, change: string): Promise<string | undefined> {
  const dir = join(changesDirOf(root), change, "stage");
  let newest: string | undefined;
  for (const f of (await readdir(dir).catch(() => [] as string[])).filter((x) =>
    x.endsWith(".yaml"),
  )) {
    const loop = await readFile(join(dir, f), "utf8").then(
      (t) => {
        try {
          return parse(t) as { state?: unknown; updatedAt?: unknown } | null;
        } catch {
          return null;
        }
      },
      () => null,
    );
    const at = typeof loop?.updatedAt === "string" ? loop.updatedAt : "";
    if (typeof loop?.state === "string" && UNDER_WAY.has(loop.state) && (!newest || at > newest))
      newest = at || "0";
  }
  return newest;
}

/** Whether a change takes the fast path (ADR 0113), from its type and its brief. */
async function isFast(
  root: string,
  c: { id: string; type: string },
  types: { id: string; size?: "standard" | "small"; smallWhenBriefSays?: boolean }[],
): Promise<boolean> {
  const type = types.find((t) => t.id === c.type);
  if (!type || (type.size !== "small" && !type.smallWhenBriefSays)) return false;
  const brief = await readFile(join(changesDirOf(root), c.id, "brief.md"), "utf8").catch(() => "");
  return fastPathOf(type, brief).fast;
}

/** The stage a change's state puts it at (plan 4.4), as the app's Work pages read it. */
function stageOf(
  state: string,
): "feature" | "architecture" | "stories" | "tasks" | "release" | "done" {
  switch (state) {
    case "draft":
    case "define":
    case "returned":
      return "feature";
    case "design":
      return "architecture";
    case "plan":
      return "stories";
    case "build":
    case "qa":
      return "tasks";
    case "released":
    case "archived":
      return "done";
    default:
      return "release";
  }
}

/** One change's steps, in order (the cockpit shows the first). */
export function changeSteps(c: NextState["changes"][number]): NextStep[] {
  const stage = stageSteps(c);
  const id = c.id;
  // ADR 0101: once the feature is placed, what the change needs from the organisation, early,
  // since a request's lead time runs from when it is raised; then each open need for a person.
  const done = stageOf(c.state) === "done";
  const find: NextStep[] =
    c.feature && !c.needs && !done
      ? [
          {
            step: "needs",
            command: `atticus change needs ${id}`,
            slash: `/atticus-needs ${id}`,
            where: METAREPO,
            why: `${id} is placed on the estate: your assistant says what it needs from the organisation (requests and processes to raise, standards to follow, teams to involve), and Atticus checks each against the change's own words (ADR 0101).`,
            change: id,
          },
        ]
      : [];
  const raise: NextStep[] =
    c.needs?.open && !done
      ? [
          {
            step: "raise-needs",
            command: `atticus needs --change ${id}`,
            where: METAREPO,
            why: `${plural(c.needs.open, "need")} of ${id} ${c.needs.open === 1 ? "is" : "are"} open${c.needs.longest ? ` (the longest: ${c.needs.longest})` : ""}. Raise each, then record it with atticus needs done ${id} <item>.`,
            change: id,
            person: true,
          },
        ]
      : [];
  // ADR 0156: a seed the change collides with is accepted first, then its stories run again.
  const seeds: NextStep[] = done
    ? []
    : [...new Set((c.seedCollisions ?? []).map((x) => x.repo))].sort().map((repo) => {
        const xs = c.seedCollisions!.filter((x) => x.repo === repo);
        return {
          step: "accept-seed",
          command: `atticus spec accept ${repo}`,
          where: METAREPO,
          why: `${id} adds ${xs.map((x) => x.flow).join(", ")} as new, and ${repo}'s starting spec (${xs[0]!.seed}), not accepted yet, adds ${xs.length === 1 ? "it" : "them"} too: archiving both would fail on a requirement added twice. A person reads and accepts the seed. Then run the change's stories stage again (atticus plan stories ${id}) so it modifies the seeded requirement (ADR 0156).`,
          person: true,
          change: id,
          repo,
        };
      });
  return [...find, ...seeds, ...stage, ...raise];
}

function stageSteps(c: NextState["changes"][number]): NextStep[] {
  const id = c.id;
  const byState = stageOf(c.state);
  // ADR 0006 addendum: in a drafting stage, the stage whose artifacts OpenSpec says come next
  // (a later one only: the hand-off PRs a person merges still move the state).
  const at = draftingAt;
  const stage =
    c.openspecStage && at(byState) >= 0 && at(c.openspecStage) > at(byState)
      ? c.openspecStage
      : byState;
  // ADR 0113: a small change goes from brief to tasks in one step, before it is built.
  if (c.fast && (stage === "feature" || stage === "architecture" || stage === "stories"))
    return c.fastDone
      ? [
          {
            step: "small-handoff",
            command: `atticus change handoff ${id} --approve`,
            where: METAREPO,
            why: `${id}'s one step is done and nothing blocks it: a person opens its pull request, and merging it approves the plan (ADR 0113).`,
            change: id,
            person: true,
          },
        ]
      : [
          {
            step: "small",
            command: `atticus change small ${id}`,
            slash: `/atticus-small ${id}`,
            where: METAREPO,
            why: `${id} is a small change: your assistant places it, writes its target flows and words its stories in one step, and Atticus runs every stage's checks and the critic at its gate (ADR 0113). Then a person approves its one pull request.`,
            change: id,
          },
        ];
  // B-change: the state's own stage is done, so its hand-off is next, not the stage again; say
  // too which later stages ran ahead of the gate.
  if (
    (stage === "feature" || stage === "architecture" || stage === "stories") &&
    c.stagesDone?.includes(stage)
  ) {
    const later = c.stagesDone.slice(c.stagesDone.indexOf(stage) + 1);
    const gate = c.state === "returned" ? "define" : c.state;
    return [
      {
        step: "handoff",
        command: `atticus change handoff ${id} --approve`,
        where: METAREPO,
        why: `${id}'s ${stage} stage is done${later.length ? ` (and ${later.join(" and ")} ran ahead)` : ""}, but the change is still in ${c.state}: a person raises its ${gate} hand-off PR, and merging it approves the ${gate} gate and moves it on (ADR 0073).`,
        change: id,
        person: true,
      },
    ];
  }
  switch (stage) {
    case "feature":
      return [
        {
          step: "feature",
          command: `atticus change feature ${id}`,
          slash: `/atticus-feature ${id}`,
          where: METAREPO,
          why: `${id} is at the feature stage: your assistant places it on the estate's flows and features, and Atticus checks and criticises every draft until nothing blocks (ADR 0087).`,
          change: id,
        },
      ];
    case "architecture":
      return [
        {
          step: "architecture",
          command: `atticus change architecture ${id}`,
          slash: `/atticus-architecture ${id}`,
          where: METAREPO,
          why: `${id} is at the architecture stage: your assistant writes its target flows, and Atticus checks and criticises every draft until nothing blocks (ADR 0087).`,
          change: id,
        },
      ];
    case "stories":
      return [
        {
          step: "stories",
          command: `atticus plan stories ${id}`,
          slash: `/atticus-stories ${id}`,
          where: METAREPO,
          why: `${id} has an approved design: write its stories and tasks.`,
          change: id,
        },
      ];
    case "tasks": {
      const t = c.tasks.find((x) => !x.done);
      if (!t)
        return [
          {
            step: "tasks",
            command: `atticus change status ${id}`,
            where: METAREPO,
            why: `Every task of ${id} is ticked; the status says what is left before release.`,
            change: id,
          },
        ];
      return [
        {
          step: "task",
          command: `atticus task run ${id} ${t.id}`,
          slash: `/atticus-task ${id} ${t.id}`,
          where: METAREPO,
          why: `Task ${t.id} of ${id} in ${t.repo} is the first one not done. /atticus-task gives your assistant its context (atticus task context ${id} ${t.id}): the story, the criteria, the step with today's code and the files to change (ADR 0113).`,
          repo: t.repo,
          change: id,
        },
      ];
    }
    case "release":
      return [
        {
          step: "release",
          command: `atticus change status ${id}`,
          slash: `/atticus-release ${id}`,
          where: METAREPO,
          why: `${id} is on its way to release: check what still blocks it.`,
          change: id,
        },
      ];
    default:
      return [];
  }
}

/** A person answers a change's own questions; its stage goes on after. */
function changeAnswer(id: string, ids: string[]): NextStep[] {
  if (!ids.length) return [];
  return [
    {
      step: "answer",
      command: "atticus questions list --state open",
      slash: "/atticus-answer",
      where: METAREPO,
      why: `${plural(ids.length, "question")} of ${id} ${ids.length === 1 ? "is" : "are"} waiting for a person: ${ids.join(", ")}. Its stage goes on once ${ids.length === 1 ? "it is" : "they are"} answered.`,
      person: true,
      change: id,
    },
  ];
}

/** Every step still to take, in the order to take them. Pure: tests check each case. */
/**
 * F5: what a repo with no facts is told of an id near its own that has some: likely one repo
 * listed under two ids. Empty when there is none.
 */
function nearFactsWords(r: RepoState): string {
  return (r.nearFacts ?? [])
    .map(
      (n) =>
        ` No facts are filed under ${r.id}, but ${n.id} has some (${n.file}) and its id is near this one: if they are one repo, keep one id with atticus repo rename ${r.id} ${n.id} (or rename the facts to ${r.id}).`,
    )
    .join("");
}

/** ADR 0141: a repo's estimated cost for its map step, when --estimate recorded one. */
function costWords(r: RepoState): string {
  const e = r.cost?.estimated;
  if (!e) return "";
  return ` Estimated about ${tokensWords(e.tokens)} tokens in ${e.sessions} session${e.sessions === 1 ? "" : "s"} (atticus map ${r.id} --estimate; an estimate, not a meter).`;
}

export function nextSteps(s: NextState): NextStep[] {
  const out: NextStep[] = [];
  // The change in hand first (a live run, 2026-10-25, was pointed at eleven repo questions while
  // its change waited on its own step): its own questions, then its stage.
  const byChange = s.changeQuestions ?? {};
  const inHand = s.active ? s.changes.find((c) => c.id === s.active) : undefined;
  if (inHand && stageOf(inHand.state) !== "done")
    out.push(...changeAnswer(inHand.id, byChange[inHand.id] ?? []), ...changeSteps(inHand));
  const ofChanges = new Set(Object.values(byChange).flat());
  const repoQuestions = s.openQuestions.filter((id) => !ofChanges.has(id));
  if (s.repos.length === 0 && !inHand) {
    out.push({
      step: "discover",
      command: "atticus repos discover <folder>",
      why: "No repo is listed yet. Propose the manifest from a folder of clones or your Git host's organisation (--org).",
    });
    return out;
  }
  const notCloned = s.repos.filter((r) => !r.cloned);
  if (notCloned.length)
    out.push({
      step: "sync",
      command: "atticus workspace sync",
      why: `${plural(notCloned.length, "repo")} ${notCloned.length === 1 ? "isn't" : "aren't"} cloned yet: ${notCloned.map((r) => r.id).join(", ")}.`,
    });
  // B-run2-fixes 7: a repo mapped from its verified facts skips the reader path. ADR 0124: a
  // repo neither read nor scanned is read by the assistant (/atticus-map) and its facts written
  // with verify --write; the reader path (survey, scan, verify, spec) goes on only for a repo a
  // scan already read.
  // ADR 0141 (P6): in the onboarding queue's order (callees and gateways first), each saying why
  // it sits there and what its read is estimated to cost.
  const unread = s.repos
    .filter((r) => r.cloned && !r.facts && !r.scanned)
    .sort((a, b) => (a.queue?.order ?? Infinity) - (b.queue?.order ?? Infinity));
  for (const r of unread)
    out.push(
      r.read
        ? {
            step: "write",
            command: `atticus verify ${r.id} --write`,
            why: `${r.id} is read: atticus verify ${r.id} --write checks its facts against the code, then puts them in the catalog and renders its map.`,
            repo: r.id,
          }
        : {
            step: "map",
            command: `atticus map ${r.id}`,
            slash: `/atticus-map ${r.id}`,
            where: METAREPO,
            // A-ledger: a repo read in parts says which part comes next, so nobody keeps the list.
            why:
              (r.readPlan?.next
                ? `${r.id} is read in ${r.readPlan.total} parts (${r.readPlan.file}): ${partOfWords({ part: r.readPlan.next.part, total: r.readPlan.total })} is next, ${r.readPlan.done === 0 ? "none" : r.readPlan.done} ${r.readPlan.done === 1 ? "is" : "are"} read (${r.readPlan.next.paths.join(", ")}). Your assistant reads the part and writes its facts, each citing its line.`
                : `${r.id} isn't read yet: your assistant reads it and writes its facts, each citing its line, and atticus verify ${r.id} checks them.`) +
              // Only a reason that moved it up the queue is worth a sentence here; --queue says all.
              (r.queue &&
              (r.queue.reason === "called" ||
                r.queue.reason === "gateway" ||
                r.queue.reason === "places")
                ? ` ${r.queue.why}`
                : "") +
              costWords(r) +
              houseUntaughtWords(r.id, r.houseUntaught ?? []) +
              nearFactsWords(r),
            repo: r.id,
          },
    );
  // ADR 0141: a mapped repo is never read again unless its clone moved past its facts' commit.
  for (const r of s.repos.filter((x) => x.cloned && x.facts && x.stale))
    out.push({
      step: "reread",
      command: `atticus map ${r.id}`,
      slash: `/atticus-map ${r.id}`,
      where: METAREPO,
      why: `${r.id}'s clone moved past its facts' commit (facts ${r.stale!.facts.slice(0, 12)}, clone ${r.stale!.head.slice(0, 12)}): atticus estate fresh says how many facts to read again; your assistant reads only the files that changed.`,
      repo: r.id,
    });
  // ADR 0167: a repo read before reading rules added since is topped up for them alone.
  for (const r of s.repos.filter((x) => x.cloned && x.read && x.rules?.length))
    out.push({
      step: "rules",
      command: `atticus map ${r.id} --rules`,
      slash: `/atticus-map ${r.id} --rules`,
      where: METAREPO,
      why: `${r.id} was read before reading rules added since (${r.rules!.join(", ")}): your assistant reads only the files they apply to, for what they ask, and atticus verify ${r.id} records the rules. atticus map --all --stale tops up every such repo.`,
      repo: r.id,
    });
  const cloned = s.repos.filter((r) => r.cloned && !r.facts && r.scanned);
  for (const r of cloned.filter((x) => !x.settings))
    out.push({
      step: "survey",
      command: `atticus scan survey ${r.id}`,
      slash: `/atticus-survey ${r.id}`,
      where: METAREPO,
      why: `${r.id} has no scan settings yet: your assistant reads it and drafts them, and Atticus checks each entry against the code.`,
      repo: r.id,
    });
  if (cloned.length && s.catalogRecords === 0)
    out.push({
      step: "scan",
      command: "atticus scan",
      why: "The catalog is empty: scan the repos into it.",
    });
  const scanned = cloned;
  for (const r of scanned)
    if (r.verify === "none")
      out.push({
        step: "verify",
        command: `atticus scan verify ${r.id}`,
        slash: `/atticus-verify ${r.id}`,
        where: METAREPO,
        why: `The last scan of ${r.id} hasn't been verified: your assistant compares the code with what the scan recorded.`,
        repo: r.id,
      });
    else if (r.verify === "accept")
      out.push({
        step: "accept",
        command: `atticus scan verify ${r.id} --accept`,
        why: `The verify of ${r.id} proposes scan settings entries. A person reads the proposal and accepts it.`,
        person: true,
        repo: r.id,
      });
  // ADR 0128: a repo id often says nothing, so one line from a person is worth asking for. It
  // never blocks a read: the step sits beside the others, and the drafts the assistant wrote are
  // listed for a person to confirm.
  const undescribed = s.repos.filter((r) => r.described === "none");
  if (undescribed.length)
    out.push({
      step: "describe",
      command: `atticus repo describe ${undescribed[0]!.id} --description "what it is"`,
      why: `${plural(undescribed.length, "repo")} ${undescribed.length === 1 ? "doesn't say" : "don't say"} what ${undescribed.length === 1 ? "it is" : "they are"}: ${undescribed.map((r) => r.id).join(", ")}. One line each is carried into every reading prompt, the join's questions and the views, so an opaque id can be read and placed.`,
      person: true,
      ...(undescribed.length === 1 ? { repo: undescribed[0]!.id } : {}),
    });
  const drafted = s.repos.filter((r) => r.described === "draft");
  if (drafted.length)
    out.push({
      step: "describe-accept",
      command: `atticus repo describe ${drafted[0]!.id} --accept`,
      why: `Your assistant drafted what ${drafted.length === 1 ? "this repo is" : "these repos are"} and nobody has confirmed ${drafted.length === 1 ? "it" : "them"}: ${drafted.map((r) => r.id).join(", ")}. Until a person does, each is shown as unconfirmed everywhere it is used.`,
      person: true,
      ...(drafted.length === 1 ? { repo: drafted[0]!.id } : {}),
    });
  if (repoQuestions.length)
    out.push({
      step: "answer",
      command: "atticus questions list --state open",
      slash: "/atticus-answer",
      where: METAREPO,
      why: `${plural(repoQuestions.length, "question")} ${repoQuestions.length === 1 ? "is" : "are"} waiting for a person: ${repoQuestions.join(", ")}. The steps that asked go on once they are answered.`,
      person: true,
    });
  for (const r of scanned) {
    const slash = { slash: `/atticus-spec ${r.id}`, where: METAREPO, repo: r.id };
    if (r.flows === 0)
      out.push({
        step: "spec",
        command: `atticus spec draft ${r.id}`,
        ...slash,
        why: `${r.id} has no spec yet: your assistant writes its flows, one per trigger, each step cited.`,
      });
    else if (!r.checked)
      out.push({
        step: "spec-check",
        command: `atticus spec check ${r.id}`,
        ...slash,
        why: `The spec of ${r.id} hasn't been checked since its last draft.`,
      });
    else if (r.findings > 0)
      out.push({
        step: "spec",
        command: `atticus spec draft ${r.id}`,
        ...slash,
        why: `The last spec check of ${r.id} found ${plural(r.findings, "problem")}: draft the flagged flows again, then check.`,
      });
  }
  for (const k of s.sources)
    if (!k.snapshot)
      out.push({
        step: "sync-source",
        command: `atticus sources sync --source ${k.id}`,
        slash: `/atticus-knowledge ${k.id}`,
        where: METAREPO,
        why: `The knowledge source ${k.id} has no snapshot yet: copy its pages, then read them into knowledge items.`,
        source: k.id,
      });
    else if (!k.scanned)
      out.push({
        step: "knowledge",
        command: `atticus knowledge scan --source ${k.id}`,
        slash: `/atticus-knowledge ${k.id}`,
        where: METAREPO,
        why: `The newest snapshot of ${k.id} hasn't been read into knowledge items yet.`,
        source: k.id,
      });
    else if ((k.age ?? 0) > STALE_DAYS)
      out.push({
        step: "sync-source",
        command: `atticus sources sync --source ${k.id}`,
        slash: `/atticus-knowledge ${k.id}`,
        where: METAREPO,
        why: `The newest snapshot of ${k.id} is ${k.age} days old: sync it again, and a rescan reads only the pages that changed (ADR 0101).`,
        source: k.id,
      });
  // ADR 0101: the org pack keeps up with what the wikis name, and people check what changes use.
  if (s.orgpack?.draft)
    out.push({
      step: "accept-orgpack",
      command: `atticus orgpack accept ${s.orgpack.draft.platform}`,
      why: `A draft of the ${s.orgpack.draft.platform} profile has ${plural(s.orgpack.draft.proposals, "system")} from the wikis waiting: read it (proposals/orgpack/${s.orgpack.draft.platform}.md) and accept what is right, with --only or --verified-only.`,
      person: true,
    });
  else if (s.orgpack?.missing)
    out.push({
      step: "orgpack-draft",
      command: "atticus orgpack draft",
      why: `The wikis name ${plural(s.orgpack.missing, "product or vendor", "products and vendors")} that no profile has yet: draft them into the org pack, with their aliases and owners.`,
    });
  if (s.unverifiedNeeds)
    out.push({
      step: "verify-knowledge",
      command: "atticus knowledge list --unverified",
      why: `${plural(s.unverifiedNeeds, "open need")} of changes ${s.unverifiedNeeds === 1 ? "comes" : "come"} from knowledge items no person has verified: check each against its page (atticus knowledge verify, correct or reject).`,
      person: true,
    });
  const inFlight = s.changes.filter((c) => stageOf(c.state) !== "done");
  for (const c of inFlight)
    if (c !== inHand) out.push(...changeAnswer(c.id, byChange[c.id] ?? []), ...changeSteps(c));
  if (!inFlight.length)
    out.push({
      step: "new-change",
      command: 'atticus change new "<title>" --type <type>',
      why: out.length
        ? "Then start a change: no change is in flight."
        : "Everything is onboarded, checked and answered, and no change is in flight. Start one.",
    });
  return out;
}

export async function nextCommand(
  root: string,
  o: { json?: boolean; all?: boolean; queue?: boolean },
  io: Output,
): Promise<number> {
  // Outside a metarepo, there is no next step to read: say how to make or open one (ADR 0119).
  if (!isMetarepo(root)) {
    io.err(notMetarepo(root));
    return 2;
  }
  const state = await readNextState(root);
  if (o.queue) return queueOut(state, o, io);
  const steps = nextSteps(state);
  const runtime = await loadOrgPack(orgPackDirOf(root))
    .then((op) => op.runtime)
    .catch(() => undefined);
  // Where to type a slash command (2026-10-25): the assistant a probe measured here (ADR 0124
  // addendum A-probe), the newest one runtime.yaml allows, else the default it names.
  const probes = (await readProbes(root)).results;
  const probed = runtime
    ? probedAssistant(runtime, probes)
    : [...probes].sort((a, b) => b.measured.localeCompare(a.measured))[0]?.assistant;
  const assistant = probed ?? runtime?.assistants.default ?? "copilot";
  if (o.json) {
    // What runs a step here, in one line (ADR 0121 item 6), for the editors' Next view.
    const runs = runtime ? whatRunsWhere(runtime, { probes }) : undefined;
    // Whether a step can run on runtime.yaml's model here (ADR 0121 item 5), as data: IntelliJ
    // offers "Run on Atticus's configured model" only then.
    const modelMode =
      !!runtime &&
      runtime.ai !== "off" &&
      runtime.modes.allowed.includes("model") &&
      !!runtime.adapters.model &&
      runtime.adapters.model.type !== "mock";
    // ADR 0121 addendum: each AI step's kind, and runtime.yaml's model for each kind, so the
    // editors say (and pick) the model a step will run on.
    const classed = steps.map((x) => {
      const c = x.person ? undefined : stepClassOfNextStep(x.step);
      return c ? { ...x, stepClass: c } : x;
    });
    const orgModels = stepModelsOf(runtime);
    io.out(
      JSON.stringify(
        {
          next: classed[0],
          steps: classed,
          problems: state.problems,
          ...(runs ? { runs } : {}),
          modelMode,
          assistant,
          ...(Object.keys(orgModels).length ? { orgModels } : {}),
        },
        null,
        2,
      ),
    );
    return 0;
  }
  for (const p of state.problems) io.err(`Couldn't read ${p.file}: ${p.message}`);
  // Where to type it: the assistant probed here, or the default runtime.yaml names (ADR 0121).
  const typeIn = ASSISTANT_FORMATS[assistant].typeIn;
  const slashLine = (x: NextStep) =>
    x.slash
      ? `In ${typeIn}${x.where && x.where !== METAREPO ? ` in ${x.where}` : ""}: ${x.slash}`
      : undefined;
  if (!o.all) {
    const n = steps[0]!;
    io.out(`Next: ${n.command}`);
    const sl = slashLine(n);
    if (sl) io.out(sl);
    io.out(`Why: ${n.why}`);
    if (steps.length > 1)
      io.out(`${plural(steps.length - 1, "more step")} after this one: atticus next --all`);
    return 0;
  }
  steps.forEach((x, i) => {
    io.out(`${i + 1}. ${x.command}`);
    const sl = slashLine(x);
    if (sl) io.out(`   ${sl}`);
    io.out(`   ${x.why}`);
  });
  return 0;
}

/**
 * atticus next --queue (ADR 0141, P6): the repos to read, in the onboarding queue's order, each
 * with why it sits there and its estimated cost; then the repos read, each with what its read
 * took as its read plan records it. Estimates and reports are said for what they are.
 */
function queueOut(s: NextState, o: { json?: boolean }, io: Output): number {
  const waiting = s.repos.filter((r) => r.queue).sort((a, b) => a.queue!.order - b.queue!.order);
  const read = s.repos.filter((r) => r.facts);
  if (o.json) {
    io.out(
      JSON.stringify(
        {
          queue: waiting.map((r) => ({
            repo: r.id,
            order: r.queue!.order + 1,
            reason: r.queue!.reason,
            why: r.queue!.why,
            command: `atticus map ${r.id}`,
            slash: `/atticus-map ${r.id}`,
            ...(r.cost ? { cost: r.cost } : {}),
          })),
          read: read.map((r) => ({
            repo: r.id,
            ...(r.cost ? { cost: r.cost } : {}),
            ...(r.stale ? { stale: r.stale } : {}),
          })),
          problems: s.problems,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  for (const p of s.problems) io.err(`Couldn't read ${p.file}: ${p.message}`);
  io.out(
    waiting.length
      ? `${plural(waiting.length, "repo")} to read, in the order that lands links early (callees and gateways first):`
      : "No repo is waiting to be read.",
  );
  waiting.forEach((r, i) =>
    io.out(
      `  ${i + 1}. ${r.id}: ${r.queue!.why} ${
        r.cost?.estimated
          ? `Cost: ${readCostWords(r.cost)}.`
          : `Cost: not estimated yet (atticus map ${r.id} --estimate).`
      }`,
    ),
  );
  if (read.length) {
    io.out(`${plural(read.length, "repo")} read:`);
    for (const r of read)
      io.out(
        `  ${r.id}: ${r.cost ? readCostWords(r.cost) || "no cost on file" : "no cost on file (read before Atticus recorded one)"}${r.stale ? `; its clone moved past its facts' commit: atticus estate fresh` : ""}`,
      );
  }
  io.out(
    "Tokens estimated are counted from the source; reported ones are your assistant's word (atticus map <repo> --spent); Atticus meters neither.",
  );
  return 0;
}
