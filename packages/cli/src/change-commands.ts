import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createAdapters,
  fileStepStore,
  MockGitHost,
  type Approval,
  type GitHost,
} from "@maycombhq/adapters";
import {
  catalogDirOf,
  changeBranch,
  changesRelOf,
  handoffBranch,
  isMetarepoRoot,
  loadOrgPack,
  orgPackDirOf,
  quickPathOf,
  type ChangeLifecycle,
  type ManualStep,
} from "@maycombhq/core";
import {
  ChangeError,
  archiveChange,
  completeCaptures,
  formatLearn,
  learnReport,
  type DraftCapture,
  changeFolder,
  changeFootprint,
  changeReport,
  changeStore,
  checkRequirements,
  plannedByOpenChanges,
  type RequirementsMap,
  decodeRequirements,
  parseRequirements,
  unadoptedChanges,
  detectConflicts,
  handoff,
  loadChangeContext,
  newChange,
  returnToPo,
  syncHandoff,
  liveHandoff,
  raiseReleasePrs,
  syncReleasePrs,
  RELEASE_PR_STATES,
  gitHandoffPublisher,
  type HandoffPublisher,
  type Reason,
} from "@maycombhq/changes";
import {
  baseClonePath,
  createWorkspace,
  isInPlace,
  loadRepos,
  readChangeRepos,
  type GitRunner,
} from "@maycombhq/workspace";
import { gateStatus, ownerWaitsLine, reviewedGates } from "@maycombhq/naysayer";
import { metarepoOpenSpec } from "@maycombhq/planner";
import type { Output } from "./commands.js";
import { table } from "./table.js";
import { storeChangeRows } from "./openspec-stores-commands.js";

/**
 * atticus change …: the change lifecycle. A gate is approved when its hand-off PR merges
 * (ADR 0073). Every write to the Git host (opening, merging or closing a hand-off PR) needs the
 * person's explicit --approve; without it the command says what it would do and sends nothing.
 * The person is the metarepo's Git user unless --by names someone.
 */

/** Things tests (and the local API) inject instead of what runtime.yaml configures. */
export interface ChangeDeps {
  gitHost?: GitHost;
  /** ADR 0191: tests inject a notifier for the hand-off's reviewers; otherwise runtime.yaml's. */
  notify?: import("@maycombhq/adapters").Notifier;
  publisher?: HandoffPublisher;
  /** ISO timestamp used for every time this command records. */
  now?: string;
  /** Git for updating base clones after archive. */
  git?: GitRunner;
}

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * The open-pull-request step of a change's live hand-off on a manual Git host: the step named, or
 * the one it depends on (its reviews step), when its branch is the hand-off's. Undefined for any
 * other step (a task's PR, another system's step) or when no hand-off is open.
 */
export async function handoffPrStep(
  root: string,
  s: ManualStep,
): Promise<{ open: ManualStep; repo?: string } | undefined> {
  if (s.system !== "git-host" || !s.change) return undefined;
  const c = await changeStore(root)
    .tryRead(s.change)
    .catch(() => undefined);
  const live = c && c.state !== "returned" ? liveHandoff(c) : undefined;
  if (!live) return undefined;
  const steps = await fileStepStore(root).list({ change: s.change, system: "git-host" });
  const open =
    s.action === "open-pull-request"
      ? s
      : steps.find((x) => x.action === "open-pull-request" && s.dependsOn.includes(x.id));
  if (!open || open.inputs.head !== live.branch) return undefined;
  const repo = typeof open.inputs.repo === "string" ? open.inputs.repo : undefined;
  return { open, ...(repo ? { repo } : {}) };
}

/**
 * Seventh UX walk (the app), round 49 (the CLI): a Git host step marked done (a hand-off PR's
 * link, its reviews, its merge) syncs the change's open hand-off, as `atticus change sync` does,
 * so the gate moves on without a second command. Read-only: without the person's approval, sync
 * never merges, it only records what the Git host (here, what was recorded) says. False when
 * there was nothing to sync.
 */
export async function syncAfterManualStep(
  root: string,
  s: ManualStep,
  by: string,
  io: Output,
  deps: ChangeDeps = {},
): Promise<boolean> {
  if (s.state === "open") return false;
  const pr = await handoffPrStep(root, s);
  if (pr) {
    await changeSync(root, s.change!, { by, ...(pr.repo ? { repo: pr.repo } : {}) }, io, deps);
    return true;
  }
  // App-only audit: a release PR's step (from change/<id>) syncs the change too, which reads the
  // release PRs back; a task PR's step (from task/<id>/<task>) settles the task's record (its PR's
  // link, and the task ticked once it merged). Read-only, as above.
  const head = await prStepHead(root, s);
  if (!head || !s.change) return false;
  if (head === changeBranch(s.change)) {
    await changeSync(root, s.change, { by }, io, deps);
    return true;
  }
  const task = head.startsWith(`task/${s.change}/`) ? head.split("/").at(-1) : undefined;
  if (!task) return false;
  const { settleTaskPr } = await import("@maycombhq/taskrun");
  const settled = await settleTaskPr(root, s.change, task, {
    ...(deps.gitHost ? { gitHost: deps.gitHost } : {}),
    ...(deps.now ? { now: () => new Date(deps.now!) } : {}),
  }).catch(() => ({}) as { state?: string; ticked?: true });
  // Only a merge is news; the record is kept in step either way (its PR's link).
  if (settled.state !== "merged") return false;
  io.out(
    `Task ${task}'s PR is merged into ${changeBranch(s.change)}${settled.ticked ? `; ticked ${task} in tasks.md` : ""}.`,
  );
  return true;
}

/** The head branch of the PR a Git host step is about: its open step's, or its own. */
async function prStepHead(root: string, s: ManualStep): Promise<string | undefined> {
  if (s.system !== "git-host" || !s.change) return undefined;
  const open =
    s.action === "open-pull-request"
      ? s
      : (await fileStepStore(root).list({ change: s.change, system: "git-host" })).find(
          (x) => x.action === "open-pull-request" && s.dependsOn.includes(x.id),
        );
  const head = open?.inputs.head;
  return typeof head === "string" ? head : undefined;
}

function printReasons(io: Output, reasons: Reason[]) {
  for (const r of reasons) io.err(`  - ${r.message}`);
}

/** Map a lifecycle error to its exit code: 2 for usage, 1 for everything else. */
function fail(io: Output, e: unknown): number {
  if (e instanceof ChangeError) {
    io.err(e.message);
    printReasons(io, e.reasons);
    return e.code === "invalid" ? 2 : 1;
  }
  if (e instanceof Error && e.name === "AdapterError") {
    io.err(e.message);
    return 1;
  }
  throw e;
}

async function gitHostFor(
  root: string,
  deps: ChangeDeps,
  io: Output,
): Promise<GitHost | undefined> {
  if (deps.gitHost) return deps.gitHost;
  const op = await loadOrgPack(join(orgPackDirOf(root)));
  // Manual Git hosts (and unreachable live ones) turn PR actions into steps a person records (ADR 0032).
  const gh = createAdapters(
    op.runtime,
    {},
    { store: fileStepStore(root), root, procedures: op.procedures },
  ).gitHost;
  if (gh) return gh;
  // Round 49: a runtime.yaml that doesn't validate is read as the defaults (no Git host), so
  // what doesn't validate is said, not that no Git host is configured.
  const bad = op.problems.filter((p) => p.file === "runtime.yaml");
  if (bad.length)
    io.err(
      `org-pack/runtime.yaml doesn't validate, so no Git host could be set up: ${bad
        .map((p) => `${p.path ? `${p.path}: ` : ""}${p.message.replace(/\.$/, "")}`)
        .join("; ")}. Fix it (atticus orgpack validate says every problem).`,
    );
  else io.err("No Git host is configured. Set adapters.gitHost in org-pack/runtime.yaml.");
  return undefined;
}

const approvalOf = (by: string, at: string, ref: string): Approval => ({ by, at, ref });

/**
 * Review: the hand-off's files reach its branch on the remote before the PR is asked for.
 * Before, nothing in production passed a publisher, so the PR's branch was never pushed: a live
 * Git host refused a PR from a branch that isn't there, and a manual one's step named a branch
 * nobody had made. The person's --approve (the app's click) is the approval for the push too.
 * A test that gives its own Git host gives its own publisher, or none.
 */
export function handoffPublisherFor(
  deps: ChangeDeps,
  io?: Output,
  gitHost?: GitHost,
): HandoffPublisher | undefined {
  if (deps.publisher) return deps.publisher;
  if (deps.gitHost) return undefined;
  // runtime.yaml's mock Git host (the evals, a dry run of the process) has no remote to push to.
  if (gitHost instanceof MockGitHost) return undefined;
  const git = gitHandoffPublisher();
  // A metarepo Atticus can't push from (no remote, the practice sandbox, a host it can't reach)
  // still gets its PR, or its manual step (ADR 0032), with the branch for the person to push.
  return {
    async publish(input) {
      try {
        return await git.publish(input);
      } catch (e) {
        io?.out(
          // App-only audit: the branch is kept here (the publisher makes it before the push).
          `The branch ${input.branch} wasn't pushed (${(e as Error).message.split("\n")[0]}): it is kept here with the hand-off's files. Push again on the change page once that is fixed, or push it yourself (git push origin ${input.branch}) before you open the PR.`,
        );
        return { commit: "" };
      }
    },
  };
}

/** Parse --owner role=a,b (repeatable) into owners by role. */
export function parseOwners(values: string[]): Record<string, string[]> | string {
  const out: Record<string, string[]> = {};
  for (const v of values) {
    const m = /^([a-z0-9][a-z0-9._-]*)=(.+)$/.exec(v.trim());
    if (!m) return `--owner takes role=person[,person], for example architect=ari; got "${v}"`;
    out[m[1]!] = [
      ...(out[m[1]!] ?? []),
      ...m[2]!
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ];
  }
  return out;
}

/** ADR 0201: what a quick change's commands say, in the words the ADR gives. */
const QUICK = {
  noType: "This org pack has no change type quick: run atticus upgrade, or pass --type <type>.",
  // An upgrade leaves a type `quick` of the organisation's own alone, so it wouldn't help here.
  otherShape:
    "This org pack's change type quick doesn't have the quick path's shape (its only phase before build is plan; it lists specs, no brief and no stories; it isn't small), and no other type has it. Give a type that shape in change-types.yaml, or pass --type <type>.",
  // An adopted folder has no requirements file to hand on: its status says what it still needs.
  adopted: (id: string) =>
    `Next: atticus change status ${id} says what it still needs. Then a person runs atticus change handoff ${id} --approve.`,
  next: (id: string) =>
    `Next: hand the cleared requirements to the spec writer: /define-change ${id}. Then a person runs atticus change handoff ${id} --approve.`,
};

type NewOptions = Parameters<typeof changeNew>[1];

/**
 * ADR 0201: make a change that has no brief, from a requirements file or by adopting a plain
 * OpenSpec folder. Its type is the one given, else `quick`, else the org pack's first type of
 * the quick shape. A type of another shape keeps its brief: its stages read it.
 */
async function newWithoutBrief(
  root: string,
  o: NewOptions,
  made: { title: string; reason: string; adopt?: boolean; from?: { file: string; bytes: Buffer } },
  io: Output,
  deps: ChangeDeps,
): Promise<{ change: ChangeLifecycle; quick: boolean } | number> {
  const owners = parseOwners(o.owners ?? []);
  if (typeof owners === "string") {
    io.err(owners);
    return 2;
  }
  try {
    const types = (await loadOrgPack(orgPackDirOf(root))).changeTypes.types;
    const shaped = types.filter(quickPathOf);
    const type = o.type ?? (shaped.find((t) => t.id === "quick") ?? shaped[0])?.id;
    if (!type) {
      io.err(types.some((t) => t.id === "quick") ? QUICK.otherShape : QUICK.noType);
      return 1;
    }
    const quick = made.adopt === true || shaped.some((t) => t.id === type);
    const change = await newChange(root, {
      title: made.title,
      type,
      by: o.by!,
      owners,
      ...(made.from ? { requirements: made.from } : {}),
      ...(quick
        ? { noBrief: { reason: made.reason, ...(made.adopt ? { adopt: true } : {}) } }
        : {}),
      ...(o.template ? { template: o.template } : {}),
      ...(o.id ? { id: o.id } : {}),
      ...(o.systems?.length ? { systems: o.systems } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    });
    return { change, quick };
  } catch (e) {
    return fail(io, e);
  }
}

/**
 * What the door check takes as in the map (ADR 0201 and its addendum): a catalog record's id, a
 * manifest's repo (read or not), an open change, an owner the catalog or the org pack names, and
 * a topic or an entry by its name where one record has it. A name several records have answers
 * with their ids. Read from the files: nothing is built or written, not even the index.
 */
async function mapLookup(
  root: string,
): Promise<{ has: (id: string) => boolean | string[]; map: RequirementsMap }> {
  const { readCatalog } = await import("@maycombhq/scanner");
  const ids = new Set<string>();
  // What the map itself has: a record or a manifest's repo. An open change's id and an owner are
  // evidence too, and are not "in the map" for what may stand under Planned.
  const own = new Set<string>();
  const names = new Map<string, string[]>();
  const cites = new Map<string, { path: string; repo?: string; line?: number }[]>();
  // What the map read in each repo: a record that is also its repo (a service named as its repo
  // is) may be cited at any file and line the map cites there.
  const inRepo = new Map<string, { path: string; repo?: string; line?: number }[]>();
  const pack = await loadOrgPack(orgPackDirOf(root));
  for (const p of pack.profiles) {
    for (const r of p.repos?.repos ?? []) {
      ids.add(r.id).add(r.owner);
      own.add(r.id);
    }
    for (const s of p.profile?.systems ?? []) if (s.owner) ids.add(s.owner);
  }
  const changes = await changeStore(root).list();
  for (const c of changes) ids.add(c.id);
  const open = new Set(changes.filter((c) => c.state !== "archived").map((c) => c.id));
  const planned = await plannedByOpenChanges(root);
  for (const dir of ["generated", "curated"])
    for (const r of (await readCatalog(join(catalogDirOf(root), dir), { keep: false })).records) {
      ids.add(r.id);
      own.add(r.id);
      if ("owner" in r && typeof r.owner === "string") ids.add(r.owner);
      if (r.kind === "Endpoint")
        names.set(r.pathOrTopic, [...(names.get(r.pathOrTopic) ?? []), r.id]);
      // The files and lines a record was read from, for a row that cites one beside its id.
      const at = (r.evidence ?? []).flatMap((e) =>
        e.path
          ? [
              {
                path: e.path,
                ...(e.repo ? { repo: e.repo } : {}),
                ...(typeof e.line === "number" ? { line: e.line } : {}),
              },
            ]
          : [],
      );
      if (at.length) cites.set(r.id, [...(cites.get(r.id) ?? []), ...at]);
      for (const e of at) if (e.repo) inRepo.set(e.repo, [...(inRepo.get(e.repo) ?? []), e]);
    }
  const named = (id: string) => [...new Set(names.get(id) ?? [])].sort();
  return {
    has: (id) => {
      if (ids.has(id)) return true;
      const n = named(id);
      return n.length > 1 ? n : n.length === 1;
    },
    map: {
      exists: (id) => own.has(id) || named(id).length === 1,
      plans: (change, id) =>
        !open.has(change)
          ? "not-open"
          : planned.get(id)?.includes(change)
            ? "plans"
            : "not-planned",
      cites: (id) => (cites.has(id) ? [...cites.get(id)!, ...(inRepo.get(id) ?? [])] : undefined),
    },
  };
}

/**
 * atticus change new ["<title>"] --from <requirements.md> [--type quick] [--id <id>] [--check]
 * [--json] (ADR 0201): the door check, then the change with the file copied into its folder. The
 * check calls no model, and creates and changes nothing in the metarepo but Atticus's own log
 * under .atticus: every question closed, every evidence id in the map or planned.
 */
async function changeFromRequirements(
  root: string,
  o: NewOptions & { from: string },
  io: Output,
  deps: ChangeDeps,
): Promise<number> {
  const file = o.from;
  const json = (ok: boolean, reasons: unknown[], more: object = {}) => {
    if (o.json) io.out(JSON.stringify({ ok, reasons, ...more }, null, 2));
  };
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch (e) {
    const message = `Can't read ${file}: ${(e as Error).message.split("\n")[0]}`;
    io.err(message);
    json(false, [{ code: "requirements.unreadable", line: 0, role: "", message }]);
    return 1;
  }
  const parsed = parseRequirements(decodeRequirements(bytes));
  const looked = await mapLookup(root);
  const r = checkRequirements(parsed, looked.has, file, looked.map);
  if (!r.ok) {
    json(false, r.reasons);
    io.err(`Refused: ${r.reasons.length} problem${r.reasons.length === 1 ? "" : "s"} in ${file}.`);
    for (const x of r.reasons) io.err(`${x.code}: ${x.message}`);
    return 1;
  }
  const nobody = r.roles ? [] : [`No persona asked a question in ${file}.`];
  if (o.check) {
    json(true, []);
    if (!o.json)
      for (const l of [
        ...nobody,
        `${file} passes: ${r.questions} question${r.questions === 1 ? "" : "s"} (${r.answered} answered, ${r.accepted} accepted), ${r.inMap} id${r.inMap === 1 ? "" : "s"} in the map, ${r.planned} planned.`,
      ])
        io.out(l);
    return 0;
  }
  const title = o.title ?? parsed.title;
  if (!title || !o.by) {
    io.err(
      `${file} has no "# " heading to take the title from: give one, atticus change new "<title>" --from ${file}.`,
    );
    return 2;
  }
  const made = await newWithoutBrief(
    root,
    o,
    { title, reason: `Created from ${file}`, from: { file, bytes } },
    io,
    deps,
  );
  if (typeof made === "number") return made;
  const c = made.change;
  json(true, [], { change: c.id });
  if (o.json) return 0;
  for (const l of nobody) io.out(l);
  io.out(`Created ${c.id} (${c.type}, from ${file}). It is in ${c.state}.`);
  io.out(made.quick ? QUICK.next(c.id) : `Write the brief: ${changesRelOf(root)}/${c.id}/brief.md`);
  return 0;
}

/**
 * ADR 0201: `atticus change new --id <id>` on a plain OpenSpec folder (no change.yaml): its title
 * is proposal.md's first heading (else the id), its type quick when none is given, and only
 * change.yaml is written.
 */
async function adoptChange(
  root: string,
  o: NewOptions & { id: string },
  io: Output,
  deps: ChangeDeps,
): Promise<number> {
  const proposal = await readFile(join(changeFolder(root, o.id), "proposal.md"), "utf8").catch(
    () => "",
  );
  const made = await newWithoutBrief(
    root,
    o,
    {
      title: o.title ?? parseRequirements(proposal).title ?? o.id,
      reason: "Adopted from its OpenSpec folder",
      adopt: true,
    },
    io,
    deps,
  );
  if (typeof made === "number") return made;
  const c = made.change;
  io.out(`Adopted ${c.id} (${c.type}, "${c.title}"). It is in ${c.state}.`);
  io.out(QUICK.adopted(c.id));
  return 0;
}

/**
 * atticus change new "<title>" --type <type> [--template t] [--id x] [--owner role=a,b] [--system s] [--by <you>];
 * with --from <requirements.md>, a quick change from a requirements file (ADR 0201).
 */
export async function changeNew(
  root: string,
  o: {
    title?: string;
    type?: string;
    template?: string;
    id?: string;
    by?: string;
    owners?: string[];
    systems?: string[];
    /** WP7.6: an archived change to start from, by its folder or its id. */
    like?: string;
    /**
     * ADR 0130: a vendor spec in inputs/ whose impact (against its other version) is the change's
     * footprint: the vendor and the systems, repos, flows and Interfaces it reaches.
     */
    impact?: string;
    /** ADR 0201: a requirements file to make the change from, once it passes the door check. */
    from?: string;
    /** With `from`: run the check and create nothing. */
    check?: boolean;
    /** With `from`: the check's result as JSON. */
    json?: boolean;
  },
  io: Output,
  deps: ChangeDeps = {},
): Promise<number> {
  if (o.from !== undefined) return changeFromRequirements(root, { ...o, from: o.from }, io, deps);
  if (o.check || o.json) {
    io.err("--check and --json go with --from <requirements.md>.");
    return 2;
  }
  // ADR 0201: `change new --id <id>` on a plain OpenSpec folder adopts it as it is.
  if (o.id && o.by && (!o.title || !o.type) && (await unadoptedChanges(root)).includes(o.id))
    return adoptChange(root, { ...o, id: o.id }, io, deps);
  if (!o.title || !o.type || !o.by) {
    io.err(
      'Usage: atticus change new "<title>" --type <change type> [--by <you>] [--template <id>]',
    );
    io.err("  or, from a requirements file: atticus change new --from <requirements.md> [--check]");
    // The types this metarepo has, so nobody has to open change-types.yaml to pick one (ADR 0119).
    if (!o.type) {
      try {
        const op = await loadOrgPack(join(orgPackDirOf(root)));
        if (op.changeTypes.types.length) {
          io.err("The change types here:");
          for (const t of op.changeTypes.types) io.err(`  ${t.id}  ${t.name}`);
        }
      } catch {
        // No org pack here: the usage says enough.
      }
    }
    return 2;
  }
  const owners = parseOwners(o.owners ?? []);
  if (typeof owners === "string") {
    io.err(owners);
    return 2;
  }
  let like: string | undefined;
  if (o.like) {
    const { findPastChange } = await import("./similar-changes.js");
    like = await findPastChange(root, o.like);
    if (!like) {
      io.err(
        `There is no archived change ${o.like}: atticus change similar "<what it is about>" lists them.`,
      );
      return 1;
    }
  }
  let impact: import("./vendor-impact-commands.js").LoadedImpact | undefined;
  if (o.impact) {
    const { loadVendorImpact } = await import("./vendor-impact-commands.js");
    const got = await loadVendorImpact(root, o.impact, io);
    if ("error" in got) {
      io.err(got.error);
      return 1;
    }
    impact = got;
  }
  try {
    const i = impact?.impact;
    const systems = [...(o.systems ?? []), ...(i?.systems ?? [])];
    const c = await newChange(root, {
      title: o.title,
      type: o.type,
      by: o.by,
      owners,
      ...(o.template ? { template: o.template } : {}),
      ...(o.id ? { id: o.id } : {}),
      ...(systems.length ? { systems } : {}),
      ...(i
        ? {
            touches: {
              repos: i.repos,
              interfaces: i.interfaces.map((id) => ({ id, status: "planned-modify" as const })),
              records: [...new Set([...i.flows.map((f) => f.id), ...i.endpoints])].sort(),
            },
          }
        : {}),
      ...(deps.now ? { now: deps.now } : {}),
    });
    io.out(`Created ${c.id} (${c.type}, from the ${c.template} template). It is in ${c.state}.`);
    if (impact) {
      const { attachToChange } = await import("@maycombhq/intake");
      const { changeFolder } = await import("@maycombhq/changes");
      const { impactDocument, IMPACT_WORDS } = await import("./vendor-impact-commands.js");
      const doc = impactDocument(impact);
      const attached = await attachToChange(
        changeFolder(root, c.id),
        [{ name: doc.name, bytes: new TextEncoder().encode(doc.text) }],
        { by: o.by, at: deps.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z") },
      );
      const path = attached.added[0]?.path ?? `inputs/${doc.name}`;
      io.out(
        IMPACT_WORDS.started(
          impact.name,
          impact.impact.newer.version ?? impact.impact.newer.id,
          impact.impact,
          path,
        ),
      );
    }
    if (like) {
      const { attachPastChange } = await import("./similar-changes.js");
      const name = await attachPastChange(
        root,
        c.id,
        like,
        o.by,
        deps.now ? new Date(deps.now) : new Date(),
      );
      io.out(
        `It starts from ${like}: attached as inputs/${name}, which its steps read as an example.`,
      );
    }
    io.out(`Write the brief: ${changesRelOf(root)}/${c.id}/brief.md`);
    return 0;
  } catch (e) {
    return fail(io, e);
  }
}

/** atticus change status <id>: state, next step, what blocks it, risk, the hand-off PR and test kinds. */
export async function changeStatus(
  root: string,
  id: string,
  o: { json?: boolean },
  io: Output,
): Promise<number> {
  let r;
  try {
    r = await changeReport(root, id);
  } catch (e) {
    if (e instanceof Error && e.name === "ChangeFileError") {
      io.err(e.message);
      return 1;
    }
    return fail(io, e);
  }
  for (const p of r.problems) io.err(p);
  const critic = await usedUpGates(root, r.change.id);
  // Beta.27 review: the sentence every page says (changeNextStep), in the step's own words.
  const { changeNextStep } = await import("./cockpit.js");
  const said = await changeNextStep(root, r.change.id, r, undefined, "page");
  if (o.json) {
    io.out(
      JSON.stringify(
        {
          id: r.change.id,
          state: r.state,
          phase: r.phase,
          next: r.next,
          ...(r.progress ? { progress: r.progress } : {}),
          nextStep: said.nextStep,
          ...(said.stepFirst ? { stepFirst: true } : {}),
          reasons: r.reasons,
          risk: r.risk,
          tests: r.tests,
          privacy: r.privacy,
          handoff: r.handoff,
          footprint: r.footprint,
          ...(critic.length ? { critic } : {}),
        },
        null,
        2,
      ),
    );
    return 0;
  }
  io.out(`${r.change.id}: ${r.change.title} (${r.change.type})`);
  io.out(`State: ${r.state}`);
  // B-change: where the stages' work is, when it ran ahead of the gates.
  if (r.progress) io.out(`Work: ${r.progress.summary}`);
  io.out(`Next: ${said.nextStep}`);
  io.out(
    `Risk: ${r.risk.level} (${r.risk.score})${r.risk.factors.length ? ": " : ""}${r.risk.factors
      .map((f) => `${f.detail} +${f.points}${bracketed(f.cites)}`)
      .join("; ")}`,
  );
  if (r.phase)
    io.out(
      r.handoff
        ? r.handoff.state === "changes-requested"
          ? `Hand-off: PR #${r.handoff.pr.number} has changes requested (${r.handoff.pr.url}); update the artifacts and hand off again.`
          : `Hand-off: merge PR #${r.handoff.pr.number} to approve the ${r.phase} gate (${r.handoff.pr.url}).`
        : `Hand-off: no PR yet; atticus change handoff ${r.change.id} --approve opens it, and merging it approves the ${r.phase} gate.`,
    );
  io.out(`Tests: ${r.tests.required.length ? r.tests.required.join(", ") : "none listed"}`);
  if (r.tests.note) io.out(`  (${r.tests.note})`);
  for (const a of r.tests.added ?? [])
    io.out(`  ${a.kinds.join(" and ")}, for ${a.factor}: tests ${a.why}${bracketed(a.cites)}`);
  // R5: which classifications counted as personal, and from where, said on the line.
  const counted = `counted as personal: ${r.privacy.counted.levels.join(", ")}; from ${r.privacy.counted.from === "change-policy" ? "the change policy's privacy.classifications" : "the change policy's privacy.classifications and the org pack's levels above internal"}`;
  io.out(
    r.privacy.touched
      ? `Privacy: touches personal data (${r.privacy.records.map((x) => (x.field ? `${x.id}.${x.field} ${x.classification}` : `${x.id} ${x.classification}`)).join(", ")}); review it with the ${r.privacy.phase} hand-off (${counted}).`
      : r.risk.factors.some((f) => f.factor === "personal-data")
        ? `Privacy: no data classified personal touched (${counted}), but its steps touch personal or consent data by name: see the risk's personal-data factor.`
        : `Privacy: no personal data touched (${counted}).`,
  );
  if (r.reasons.length > 0) {
    io.out("Blocked by:");
    for (const x of r.reasons) io.out(`  - ${x.message}`);
  }
  // A gate whose critic rounds are used up: what a person does next, in the critic's words.
  for (const line of critic) io.out(`Critic: ${line}`);
  return 0;
}

/** The status lines of the change's gates whose critic rounds are used up (ADR 0115 addendum). */
async function usedUpGates(root: string, id: string): Promise<string[]> {
  const out: string[] = [];
  for (const g of await reviewedGates(root, id).catch(() => [] as string[])) {
    const s = await gateStatus(root, id, g).catch(() => undefined);
    // An open gap waiting on its owner is said too, in the words the stage's done uses.
    if (s && (s.humanDecides || s.checkRound || ownerWaitsLine(s, id)))
      // The critic's commands load only for a gate to report (change status runs often).
      out.push((await import("./critic-commands.js")).statusLine(s, id));
  }
  return out;
}

/**
 * atticus change handoff <id> [--approve] [--by <you>] [--repo <metarepo>] [--base <branch>].
 * Without --approve it checks the phase is ready and says which PR it would open; nothing is sent.
 */
export async function changeHandoff(
  root: string,
  id: string,
  o: { by?: string; approve?: boolean; repo?: string; base?: string },
  io: Output,
  deps: ChangeDeps = {},
): Promise<number> {
  if (!o.by) {
    io.err("Say who is handing off: set your Git user (git config user.name), or pass --by <you>.");
    return 2;
  }
  if (!o.approve) return handoffPreview(root, id, o.by, io);
  const gitHost = await gitHostFor(root, deps, io);
  if (!gitHost) return 1;
  const now = deps.now ?? nowIso();
  try {
    const c = await changeStore(root).read(id);
    const phase = c.state === "release-ready" ? "release" : c.state;
    const ref = /^(define|design|plan|build|qa|release)$/.test(phase)
      ? handoffBranch(id, phase)
      : `change/${id}`;
    const h = await handoff(root, id, {
      gitHost,
      by: o.by,
      approval: approvalOf(o.by, now, ref),
      now,
      ...(o.repo ? { repo: o.repo } : {}),
      ...(o.base ? { base: o.base } : {}),
      publisher: handoffPublisherFor(deps, io, gitHost),
      // WP7.4: the PR reviews itself: the change as a picture, its estimate, its open findings.
      review: await (await import("./handoff-review.js")).handoffReview(root, id),
      ...(metarepoOpenSpec(root) ? { openspec: metarepoOpenSpec(root)! } : {}),
    });
    // Fifth UX walk: a manual Git host records the PR as a step the person does first.
    io.out(
      h.pr.url.startsWith("manual:")
        ? `Hand-off raised as a step for you (Home › Manual steps): open its PR on the Git host from ${h.branch}, then record its link.`
        : `Hand-off PR #${h.pr.number} (${h.branch}) is open: ${h.pr.url}`,
    );
    io.out(
      `Reviewers: ${h.reviewers.length ? h.reviewers.map((r) => `@${r}`).join(", ") : "none named: name the next role under Owners on the change's page"}.`,
    );
    // ADR 0191: the next role's owners are told it waits on them, through the notify adapter.
    const { notifyHandoffReviewers } = await import("./roles-work.js");
    for (const line of await notifyHandoffReviewers(
      root,
      await changeStore(root).read(id),
      h,
      approvalOf(o.by, now, ref),
      deps.notify,
    ).catch(() => [] as string[]))
      io.out(line);
    io.out(`Merging it approves the gate; the Git host's own rules decide who may approve it.`);
    return 0;
  } catch (e) {
    if (e instanceof Error && e.name === "ChangeFileError") {
      io.err(e.message);
      return 1;
    }
    return fail(io, e);
  }
}

/** What `change handoff` would do, without --approve: nothing goes to the Git host. */
async function handoffPreview(root: string, id: string, by: string, io: Output): Promise<number> {
  let r;
  try {
    r = await changeReport(root, id);
  } catch (e) {
    if (e instanceof Error && e.name === "ChangeFileError") {
      io.err(e.message);
      return 1;
    }
    return fail(io, e);
  }
  if (!r.phase) {
    io.err(`${id} is ${r.state}; there is nothing to hand off.`);
    return 1;
  }
  if (r.blockers.length) {
    io.err(`${id} isn't ready to hand off ${r.phase}:`);
    printReasons(io, r.blockers);
    return 1;
  }
  const open = r.handoff && r.handoff.phase === r.phase;
  io.out(
    open
      ? `Would update hand-off PR #${r.handoff!.pr.number} (${r.handoff!.pr.url}) with the ${r.phase} files, as ${by}.`
      : `Would open the ${r.phase} hand-off PR ${handoffBranch(id, r.phase)} with the phase's files, as ${by}.`,
  );
  io.out(
    `Nothing was sent. To do it: atticus change handoff ${id} --approve. Merging the PR approves the gate.`,
  );
  return 0;
}

/**
 * atticus change release-prs <id> [--approve] [--by <you>] (ADR 0184): one PR per code repo from
 * change/<id> into its default branch, raised in the release phase so go/no-go is decided over
 * the PRs that will ship. Without --approve it says which it would raise; nothing is sent. With
 * it, the change branch is pushed only where the host lacks it (never forced, never the default
 * branch) and the PRs are opened, or written as steps on a manual Git host. A person merges each.
 */
export async function changeReleasePrs(
  root: string,
  id: string,
  o: { by?: string; approve?: boolean },
  io: Output,
  deps: ChangeDeps = {},
): Promise<number> {
  if (!o.by) {
    io.err(
      "Say who raises the release PRs: set your Git user (git config user.name), or pass --by <you>.",
    );
    return 2;
  }
  if (!o.approve) {
    try {
      const c = await changeStore(root).read(id);
      const repos = (await readChangeRepos(root, id))?.repos ?? [];
      if (!RELEASE_PR_STATES.includes(c.state)) {
        io.err(
          `${id} is ${c.state}; the release PRs are raised once the build is done (in QA or at go/no-go).`,
        );
        return 1;
      }
      if (!repos.length) {
        io.err(`${id} has no code repos (repos.yaml), so there is no release PR to raise.`);
        return 1;
      }
      const todo = repos.filter((r) => !r.pr || !["open", "draft", "merged"].includes(r.pr.state));
      io.out(
        todo.length
          ? `Would open a release PR from ${changeBranch(id)} into each repo's default branch: ${todo.map((r) => r.id).join(", ")}.`
          : `Every repo's release PR is already raised: ${repos.map((r) => `${r.id} #${r.pr!.number} (${r.pr!.state})`).join(", ")}.`,
      );
      io.out(
        `Nothing was sent. To do it: atticus change release-prs ${id} --approve. A person merges each PR on the Git host; atticus change sync records it.`,
      );
      return 0;
    } catch (e) {
      if (e instanceof Error && e.name === "WorkspaceFileError") {
        io.err(e.message);
        return 1;
      }
      return fail(io, e);
    }
  }
  const gitHost = await gitHostFor(root, deps, io);
  if (!gitHost) return 1;
  const now = deps.now ?? nowIso();
  try {
    const r = await raiseReleasePrs(root, id, {
      gitHost,
      approval: approvalOf(o.by, now, `${changeBranch(id)}#release`),
      now,
      ...(deps.git ? { git: deps.git } : {}),
    });
    for (const row of r.rows)
      (row.outcome === "failed" || row.outcome === "refused" ? io.err : io.out)(row.message);
    return r.rows.some((x) => x.outcome === "failed" || x.outcome === "refused") ? 1 : 0;
  } catch (e) {
    if (e instanceof Error && e.name === "WorkspaceFileError") {
      io.err(e.message);
      return 1;
    }
    return fail(io, e);
  }
}

/**
 * atticus change sync <id> [--approve] [--by <you>] [--repo <metarepo>]: read the PR and record
 * what happened on the Git host. A merged PR moves the change on; with --approve, a PR that is
 * approved and meets the host's rules is merged as the person.
 */
export async function changeSync(
  root: string,
  id: string,
  o: { by?: string; approve?: boolean; repo?: string },
  io: Output,
  deps: ChangeDeps = {},
): Promise<number> {
  const gitHost = await gitHostFor(root, deps, io);
  if (!gitHost) return 1;
  const now = deps.now ?? nowIso();
  // ADR 0184: the release PRs are read back too (merged, closed, a link recorded on a manual
  // step), so a change past its hand-offs still syncs what reached the default branch. Their
  // lines follow the hand-off's.
  const releaseLines: string[] = [];
  try {
    const rel = await syncReleasePrs(root, id, { gitHost, now });
    releaseLines.push(...rel.rows.map((r) => r.message));
  } catch (e) {
    if (!(e instanceof Error && e.name === "WorkspaceFileError")) throw e;
    io.err(e.message);
  }
  if (releaseLines.length) {
    const c = await changeStore(root)
      .read(id)
      .catch(() => undefined);
    // Nothing else to read: the change has no hand-off PR open.
    if (c && !liveHandoff(c)) {
      for (const l of releaseLines) io.out(l);
      return 0;
    }
  }
  const code = await syncTheHandoff(root, id, o, io, deps, gitHost, now);
  for (const l of releaseLines) io.out(l);
  return code;
}

async function syncTheHandoff(
  root: string,
  id: string,
  o: { by?: string; approve?: boolean; repo?: string },
  io: Output,
  deps: ChangeDeps,
  gitHost: GitHost,
  now: string,
): Promise<number> {
  try {
    const r = await syncHandoff(root, id, {
      gitHost,
      now,
      ...(o.repo ? { repo: o.repo } : {}),
      ...(o.approve && o.by ? { approval: approvalOf(o.by, now, `${id}#merge`) } : {}),
      ...(deps.git ? { git: deps.git } : {}),
    });
    if (r.merged) {
      io.out(`PR #${r.handoff.pr.number} merged. ${id} is now ${r.state}.`);
      if (r.capture) io.out(captureLine(r.capture));
      return 0;
    }
    if (r.ready) {
      io.out(
        `PR #${r.handoff.pr.number} is approved and the Git host's rules are met. Merge it on the Git host, or run atticus change sync ${id} --approve to merge it as you.`,
      );
      return 1;
    }
    io.err(`PR #${r.handoff.pr.number} can't merge yet:`);
    printReasons(io, r.reasons);
    return 1;
  } catch (e) {
    if (e instanceof Error && e.name === "ChangeFileError") {
      io.err(e.message);
      return 1;
    }
    return fail(io, e);
  }
}

/** What `change sync` kept of a merged hand-off (H1), in one line. */
export function captureLine(c: DraftCapture): string {
  if (c.state !== "captured") return c.note ?? "";
  const edited = c.files.filter((f) => f.status !== "same").length;
  return `Kept what Atticus drafted beside what merged: stage/${c.stage}.drafted/ and stage/${c.stage}.merged/ (${edited} of ${c.files.length} file${c.files.length === 1 ? "" : "s"} changed by people). atticus change learn measures it.`;
}

/**
 * atticus change learn [--json] (H3): how much people changed what Atticus drafted, per merged
 * change and stage, and whether that falls over time. Local only: it first keeps the pairs of
 * merged hand-offs whose merge is now in the clone (H1), then reads every kept pair.
 */
export async function changeLearn(
  root: string,
  o: { json?: boolean },
  io: Output,
  deps: ChangeDeps = {},
): Promise<number> {
  const now = deps.now ?? nowIso();
  try {
    const ctx = await loadChangeContext(root);
    await completeCaptures(root, ctx, { now, ...(deps.git ? { git: deps.git } : {}) });
  } catch {
    // No org pack or no git: report what is kept.
  }
  const report = await learnReport(root);
  if (o.json) io.out(JSON.stringify(report, null, 2));
  else for (const l of formatLearn(report)) io.out(l);
  return 0;
}

/**
 * atticus change return <id> --reason "<why>" [--approve] [--by <you>]: close the hand-off PR
 * and return the change to the product owner. Without --approve it says what it would do.
 */
export async function changeReturn(
  root: string,
  id: string,
  o: { by?: string; approve?: boolean; reason?: string; repo?: string },
  io: Output,
  deps: ChangeDeps = {},
): Promise<number> {
  if (!o.by || !o.reason) {
    io.err('Usage: atticus change return <id> --reason "<why>" --approve [--by <you>]');
    return 2;
  }
  if (!o.approve) {
    try {
      const r = await changeReport(root, id);
      if (!r.handoff) {
        io.err(`${id} has no open hand-off PR to return.`);
        return 1;
      }
      io.out(
        `Would comment on PR #${r.handoff.pr.number} (${r.handoff.pr.url}) and close it, and return ${id} to the product owner, as ${o.by}.`,
      );
      io.out(`Nothing was sent. To do it: atticus change return ${id} --reason "..." --approve.`);
      return 0;
    } catch (e) {
      if (e instanceof Error && e.name === "ChangeFileError") {
        io.err(e.message);
        return 1;
      }
      return fail(io, e);
    }
  }
  const gitHost = await gitHostFor(root, deps, io);
  if (!gitHost) return 1;
  const now = deps.now ?? nowIso();
  try {
    const r = await returnToPo(root, id, {
      gitHost,
      by: o.by,
      reason: o.reason,
      approval: approvalOf(o.by, now, `${id}#return`),
      now,
      ...(o.repo ? { repo: o.repo } : {}),
    });
    io.out(
      r.closedOnHost
        ? `Returned ${id} to the product owner and closed PR #${r.handoff.pr.number}.`
        : `Returned ${id} to the product owner. Close PR #${r.handoff.pr.number} on the Git host by hand; this Git host adapter can't close pull requests.`,
    );
    return 0;
  } catch (e) {
    if (e instanceof Error && e.name === "ChangeFileError") {
      io.err(e.message);
      return 1;
    }
    return fail(io, e);
  }
}

/**
 * The change's repos the rescan needs, worked out before archiving: OpenSpec's archive moves
 * the change's folder to openspec/changes/archive/<date>-<id>/, so its change.yaml can't be
 * read at its old path afterwards (round 49).
 */
async function archiveRescanPlan(root: string, id: string) {
  const ctx = await loadChangeContext(root);
  const change = await changeStore(root).read(id);
  const fp = await changeFootprint(ctx, change);
  const all = await loadRepos(root);
  const manifest = new Map(all.map((r) => [r.id, r]));
  // Repos the footprint names, and the manifest's repos for its components and systems (the
  // catalog may not say which repo builds a component yet).
  const wanted = [
    ...new Set([
      ...fp.repos,
      ...all
        .filter(
          (r) =>
            fp.components.includes(r.component ?? r.id) ||
            (r.system !== undefined && fp.systems.includes(r.system)),
        )
        .map((r) => r.id),
    ]),
  ].sort();
  return { wanted, manifest };
}

/**
 * After archive, the released code is the truth: the change's repos are brought up to date
 * where their base clones are here (in-place repos are already current) and the estate is
 * rescanned, so the catalog shows what was built. When none of them is here, the exact
 * commands to run are printed instead. Exit 1 only when the rescan itself had problems.
 */
async function rescanAfterArchive(
  root: string,
  id: string,
  plan: Awaited<ReturnType<typeof archiveRescanPlan>>,
  io: Output,
  deps: ChangeDeps,
): Promise<number> {
  const { wanted, manifest } = plan;
  const here = wanted.filter((r) => {
    const m = manifest.get(r);
    return !!m && (isInPlace(m.url) || existsSync(baseClonePath(root, r)));
  });
  const away = wanted.filter((r) => !here.includes(r));
  const command = (ids: string[]) =>
    `atticus workspace sync --repos ${ids.join(",")} && atticus scan`;
  if (wanted.length === 0) {
    io.out("The change names no repos; run atticus scan to refresh the catalog.");
    return 0;
  }
  if (here.length === 0) {
    io.out(
      `The change's repos aren't in base clones here, so the catalog wasn't rescanned. Run: ${command(away)}`,
    );
    return 0;
  }
  const clones = here.map((r) => manifest.get(r)!).filter((m) => !isInPlace(m.url));
  if (clones.length) {
    const synced = await createWorkspace(root, deps.git).sync(clones);
    for (const s of synced.filter((x) => x.action === "failed" || x.action === "skipped"))
      io.out(
        `Couldn't update the base clone of ${s.id} (${s.reason ?? s.action}); scanning what is there.`,
      );
  }
  io.out(`Rescanning for ${id}'s repos: ${here.join(", ")}.`);
  const code = await (await import("./scan-commands.js")).scanCommand(root, {}, io);
  if (away.length)
    io.out(`Not in a base clone here: ${away.join(", ")}. To add them, run: ${command(away)}`);
  return code;
}

/** atticus change archive <id> [--by <you>]: archive a released change. */
export async function changeArchive(
  root: string,
  id: string,
  o: { by?: string; rescan?: boolean },
  io: Output,
  deps: ChangeDeps = {},
): Promise<number> {
  if (!o.by) {
    io.err("Say who is archiving: set your Git user (git config user.name), or pass --by <you>.");
    return 2;
  }
  try {
    // ADR 0006 addendum: in a metarepo set up with OpenSpec, `openspec validate --strict` then
    // `openspec archive`, which merges the change's spec deltas into openspec/specs/.
    const os = metarepoOpenSpec(root);
    const plan = o.rescan === false ? undefined : await archiveRescanPlan(root, id);
    await archiveChange(root, id, {
      by: o.by,
      ...(deps.now ? { now: deps.now } : {}),
      ...(os ? { openspec: os } : {}),
    });
    io.out(`Archived ${id}.`);
    if (!plan) return 0;
    return await rescanAfterArchive(root, id, plan, io, deps);
  } catch (e) {
    if (e instanceof Error && e.name === "ChangeFileError") {
      io.err(e.message);
      return 1;
    }
    return fail(io, e);
  }
}

/**
 * atticus change list: every change with its type, state and open hand-off; then, when
 * org-pack/openspec.yaml names OpenSpec stores (ADR 0126), their open changes, read-only and
 * labelled with the store.
 */
export async function changeList(root: string, o: { json?: boolean }, io: Output): Promise<number> {
  // Round 46: a change.yaml that doesn't read is named, and the rest are listed.
  const { changes: all, problems } = await changeStore(root).listWithProblems();
  for (const p of problems) io.err(`Skipped: ${p.message}`);
  const stores = await storeChangeRows(root);
  for (const l of stores.err) io.err(l);
  // ADR 0006 addendum: task progress is OpenSpec's (`openspec list --json` counts tasks.md's
  // boxes), in a metarepo set up with it; Atticus adds the type, state and hand-off.
  const progress = new Map(
    (
      await metarepoOpenSpec(root)
        ?.listChanges()
        .catch(() => undefined)
    )?.map((c) => [c.name, c]) ?? [],
  );
  const tasksOf = (id: string) => {
    const p = progress.get(id);
    return p ? { completedTasks: p.completedTasks, totalTasks: p.totalTasks } : undefined;
  };
  // ADR 0201: a plain OpenSpec folder Atticus doesn't track yet, with the command that adopts it.
  const plain = await unadoptedChanges(root);
  if (o.json) {
    io.out(
      JSON.stringify(
        [
          ...all.map((c) => ({
            id: c.id,
            title: c.title,
            type: c.type,
            state: c.state,
            ...(tasksOf(c.id) ? { tasks: tasksOf(c.id) } : {}),
          })),
          ...plain.map((id) => ({ id, adopted: false })),
          ...stores.json,
        ],
        null,
        2,
      ),
    );
    return 0;
  }
  if (all.length === 0 && plain.length === 0)
    io.out("No changes yet. Start one with atticus change new.");
  else {
    const withTasks = progress.size > 0;
    const rows = all.map((c) => {
      const live = c.handoffs.find((h) => h.state === "open" || h.state === "changes-requested");
      const t = tasksOf(c.id);
      return [
        c.id,
        c.type,
        c.state,
        ...(withTasks ? [t ? `${t.completedTasks}/${t.totalTasks}` : ""] : []),
        live ? `#${live.pr.number} ${live.state}` : "",
        c.title,
      ];
    });
    for (const id of plain) rows.push([id, "not adopted"]);
    const head = ["ID", "TYPE", "STATE", ...(withTasks ? ["TASKS"] : []), "HAND-OFF", "TITLE"];
    for (const l of table(head, rows)) io.out(l);
    for (const id of plain)
      io.out(
        `Not adopted: ${id} is an OpenSpec change Atticus doesn't track yet. Adopt it: atticus change new --id ${id}`,
      );
  }
  for (const l of stores.lines) io.out(l);
  return 0;
}

/** What something cites, in brackets after it; nothing when it cites nothing (never "()"). */
const bracketed = (cites: readonly string[] | undefined): string => {
  const named = (cites ?? []).filter((c) => c.trim());
  return named.length ? ` (${named.join(", ")})` : "";
};

/**
 * atticus change conflicts [--touching <id>]: open changes touching the same records or repos;
 * with an id, only the overlaps that id is in (ADR 0201; an id the map lacks is fine: two changes
 * may plan the same repo). Exit 1 when any overlap.
 */
export async function changeConflicts(
  root: string,
  o: { json?: boolean; touching?: string },
  io: Output,
): Promise<number> {
  // Nothing overlaps where there is nothing to read: said as a fault, never as "no overlap".
  if (!isMetarepoRoot(root)) {
    io.err(
      "This folder is not a metarepo (it has no org-pack/), so it has no changes to compare. Run atticus in a metarepo, or pass --root <metarepo>.",
    );
    return 2;
  }
  const all = await detectConflicts(root);
  const pairs = o.touching
    ? all.filter((p) => Object.values(p.overlap).some((v) => v.includes(o.touching!)))
    : all;
  if (o.json) {
    io.out(JSON.stringify(pairs, null, 2));
    return pairs.length ? 1 : 0;
  }
  if (pairs.length === 0) {
    io.out(o.touching ? `No open changes both touch ${o.touching}.` : "No open changes overlap.");
    return 0;
  }
  for (const p of pairs) {
    const parts = Object.entries(p.overlap)
      .filter(([, v]) => v.length > 0)
      .map(([k, v]) => `${k} ${v.join(", ")}`);
    io.out(`${p.changes[0]} and ${p.changes[1]} both touch ${parts.join("; ")}`);
  }
  return 1;
}
