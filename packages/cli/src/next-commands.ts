import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import {
  changesDirOf,
  factsDirOf,
  fastPathOf,
  listQuestions,
  proposalsDirOf,
  loadOrgPack,
  orgPackDirOf,
  readRepoSpec,
  readSpecFindings,
  ScanVerifyProposal,
} from "@maycombhq/core";
import { changeStore } from "@maycombhq/changes";
import { readKnowledge, snapshotDates, workingDays } from "@maycombhq/knowledge";
import { metarepoOpenSpec, openspecProgress, readNeeds } from "@maycombhq/planner";
import { readChangeFiles } from "@maycombhq/naysayer";
import { readChangeTasks } from "@maycombhq/speckit";
import type { Output } from "./commands.js";
import { onboardingView } from "./ui-api-onboarding.js";
import {
  ASSISTANT_FORMATS,
  probedAssistant,
  readProbes,
  whatRunsWhere,
} from "@maycombhq/assistant-files";
import { isMetarepo, notMetarepo } from "./metarepo-guard.js";

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
     * ADR 0006 addendum: the stage whose OpenSpec artifacts come next, from `openspec status`
     * (org-flow v2), in a metarepo set up with OpenSpec. Left out when every artifact is done.
     */
    openspecStage?: "feature" | "architecture" | "stories";
  }[];
  problems: { file: string; message: string }[];
}

const METAREPO = "metarepo";
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

/** Read everything the steps depend on. Files that don't read are problems, never a crash. */
export async function readNextState(root: string): Promise<NextState> {
  const view = await onboardingView(root);
  const problems = [...view.problems];
  const repos: RepoState[] = [];
  for (const r of view.repos) {
    const spec = await readRepoSpec(root, r.id);
    problems.push(...spec.problems);
    const findings = await readSpecFindings(root, r.id);
    repos.push({
      id: r.id,
      cloned: r.cloned,
      settings: r.scanSettings.present,
      scanned: r.lastScan !== null,
      verify: await verifyState(root, r.id),
      flows: spec.flows.length,
      checked: !!findings && findings.draftedAt === spec.header?.drafted?.at,
      findings: findings?.findings.filter((f) => !f.question).length ?? 0,
      ...(spec.header?.template.startsWith("facts@") ? { facts: true } : {}),
      ...(existsSync(join(factsDirOf(root), `${r.id}.jsonl`)) ? { read: true } : {}),
    });
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
  const knowledge = await readKnowledge(root);
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
  // ADR 0101: what the knowledge names that the org pack's profiles don't have yet.
  let orgpack: NextState["orgpack"];
  try {
    const op = await loadOrgPack(orgPackDirOf(root));
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
  const types = await loadOrgPack(orgPackDirOf(root)).then(
    (op) => op.changeTypes.types,
    () => [],
  );
  const os = metarepoOpenSpec(root);
  try {
    for (const c of await changeStore(root).list()) {
      const files = await readChangeFiles(join(changesDirOf(root), c.id)).catch(() => undefined);
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
      const progress = os ? await openspecProgress(os, c.id).catch(() => undefined) : undefined;
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
        ...(progress?.next ? { openspecStage: progress.next } : {}),
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
    openQuestions: open.questions.map((q) => q.id),
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
  return [...find, ...stage, ...raise];
}

/** The drafting stages in order: OpenSpec's status may move a change on among them, never past. */
const DRAFTING = ["feature", "architecture", "stories"] as const;

function stageSteps(c: NextState["changes"][number]): NextStep[] {
  const id = c.id;
  const byState = stageOf(c.state);
  // ADR 0006 addendum: in a drafting stage, the stage whose artifacts OpenSpec says come next
  // (a later one only: the hand-off PRs a person merges still move the state).
  const at = (s: string) => DRAFTING.indexOf(s as (typeof DRAFTING)[number]);
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
  const unread = s.repos.filter((r) => r.cloned && !r.facts && !r.scanned);
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
            why: `${r.id} isn't read yet: your assistant reads it and writes its facts, each citing its line, and atticus verify ${r.id} checks them.`,
            repo: r.id,
          },
    );
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
  o: { json?: boolean; all?: boolean },
  io: Output,
): Promise<number> {
  // Outside a metarepo, there is no next step to read: say how to make or open one (ADR 0119).
  if (!isMetarepo(root)) {
    io.err(notMetarepo(root));
    return 2;
  }
  const state = await readNextState(root);
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
    io.out(
      JSON.stringify(
        {
          next: steps[0],
          steps,
          problems: state.problems,
          ...(runs ? { runs } : {}),
          modelMode,
          assistant,
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
