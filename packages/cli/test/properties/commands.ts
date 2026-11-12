import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import fc from "fast-check";
import { parse, stringify } from "yaml";
import {
  CancelledError,
  HOSTS_NONE,
  HOSTS_STEP,
  listQuestions,
  parseRecord,
  recordPath,
  serializeRecord,
  withSignal,
} from "@maycombhq/core";
import { main } from "../../src/main.js";
import {
  commitCode,
  renderFacts,
  resolve,
  sketchArb,
  writeManifest,
  type Code,
  type Sketch,
} from "./estate.js";
import { fault } from "./fault.js";
import { arrowOf, checkStep, InvariantError, type Invariant, type Step } from "./invariants.js";
import {
  arrowKey,
  endpointKey,
  noChanges,
  type Changes,
  type Decision,
  type HandEdit,
  type Model,
} from "./model.js";
import { sut, todaysWriters, type Confirm, type Guard, type Outcome } from "./system.js";
import {
  move,
  readTree,
  recId,
  records,
  repoOf,
  sameTree,
  type Pending,
  type Rec,
  type Snap,
  type World,
} from "./world.js";

/**
 * The commands of ADR 0195 point 10, as plain data (so a shrunk counterexample can be committed
 * as JSON and replayed) and one fast-check command that runs any of them against the world,
 * updates the model by the ADR's rules, and checks the invariants asked for. Repos are named by
 * slot, so a command still means the same repo after a rename.
 */
export type Desc =
  /** A beta.26 metarepo, made by beta.26's writers: a full scan, then `verify --write` of some. Only first. */
  | { t: "seed-beta26"; verify: number[] }
  | { t: "scan" }
  | { t: "scan-subset"; slots: number[] }
  | { t: "scan-not-cloned"; slot: number }
  | { t: "scan-reader-fails"; slot: number }
  /** A scan the app cancels part way (ADR 0119), after its first repo's readers started. */
  | { t: "scan-cancelled" }
  /** A scan that can read no repo: every clone moved away. */
  | { t: "scan-nothing" }
  /** A commit in the repo: its code as a sketch (generated) or as written (the examples). */
  | { t: "change-code"; slot: number; sketch?: Sketch; code?: Code }
  | { t: "verify-write"; slot: number; ok: boolean }
  | { t: "verify-live"; slot: number }
  /** A person answers which repo serves a repo's legacy host: another repo, the repo itself, or none. */
  | { t: "answer"; host: number; to: number | "self" | "none" }
  | { t: "curate"; action: "suppress" | "assert" | "alias"; pick: number }
  | { t: "uncurate"; pick: number }
  | { t: "archive"; slot: number }
  | { t: "remove"; slot: number }
  | { t: "hand-edit"; pick: number; how: "change" | "delete" | "add" }
  /** `--discard-edits <count>` with the count listed, or (`wrong`) one more. */
  | { t: "discard-edits"; wrong?: boolean }
  /** `atticus catalog edits --curate`, then a build. */
  | { t: "curate-edits" }
  /** The last refused command again with `--allow-removals <count>` as listed, or (`wrong`) one more. */
  | { t: "confirm-removals"; wrong?: boolean }
  /** `atticus repo rename`; `fail`: its new slot files don't parse. */
  | { t: "rename"; slot: number; fail?: boolean }
  /** `atticus catalog build`. */
  | { t: "build" }
  /**
   * `atticus catalog undo <n>` (n counted back from the latest write, 1 to 5) with `--yes` or as a
   * dry run; `back`: then undo that undo. Old counterexamples' `{ t: "undo" }` is n 1, yes, back.
   */
  | { t: "undo"; n?: number; yes?: boolean; back?: boolean }
  | { t: "prune"; yes: boolean }
  /**
   * A crash part way through a scan's or a `verify --write`'s write, then a build that catches up;
   * or through a rename's write, which puts every file back (nothing changed, no build).
   */
  | {
      t: "crash";
      at: "after-slots" | "mid-records";
      via: "scan" | "verify" | "rename";
      slot: number;
    }
  | { t: "upgrade"; yes: boolean }
  | { t: "again" };

export type CommandType = Desc["t"];

/** What fast-check's model is here: the model, the world, and the invariants to check. */
export interface Ctx {
  m: Model;
  w: World;
  enabled: ReadonlySet<Invariant>;
}

/** What the model says a command must do (the completeness check reads it). */
export type Expect =
  /** Succeed, unless a guard refused it for a reason the model can check. */
  | { kind: "succeed" }
  /** Refuse (with this guard, when given). */
  | { kind: "refuse"; guard?: Guard }
  /** A dry run: list, write nothing, refuse nothing. */
  | { kind: "dry" }
  /** Anything that writes nothing (a cancelled run; verify without --write). */
  | { kind: "neutral" };

/** What one command did; undefined when it didn't apply (nothing to do), so nothing is checked. */
export interface Acted {
  outcome?: Outcome;
  /** The confirmations it ran with. */
  confirm?: Confirm;
  expect?: Expect;
  /** For a scan: the slots the ADR says it observed in full, and those it couldn't. */
  observed?: number[];
  unobserved?: number[];
  /** What a confirmation of a refusal of this command, or `again` after it, runs. */
  rerun?: Desc;
  /** The model's update, applied only when the outcome succeeded. */
  onSuccess?: () => void | Promise<void>;
  /** The model the catalog must agree with after a success, when it isn't the model now (undo). */
  builtAfter?: Model;
  /** What the next write must still explain (after an undo). */
  carry?: Changes;
  /** The pending refusal this command confirmed. */
  confirmOf?: Pending;
  /** For `again`: the command it ran again. */
  inner?: Desc;
  undo?: {
    /** Before the oldest write it takes back, and after the latest. */
    before: Snap;
    after: Snap;
    afterUndo: Snap;
    back: boolean;
    backOutcome?: Outcome;
  };
  /** `whole`: the crash was a rename's, which must leave the metarepo as it was. */
  crash?: { first: Outcome; mid: Snap; whole?: true };
  /** curate-edits: the drafting step, before its build. */
  pre?: Outcome;
  /** upgrade --yes: the metarepo right after it, before the build the harness runs then. */
  upgrade?: { after: Snap; build?: Outcome };
  /** prune: the files the model says it lists. */
  prunable?: string[];
}

/** How often each command ran, acted, and how long it took: coverage, and where the time goes. */
export const stats = {
  ran: new Map<string, number>(),
  acted: new Map<string, number>(),
  ms: new Map<string, number>(),
  /** Refusals by guard: a confirmation can only act after one. */
  guards: new Map<string, number>(),
  /** Commands that called the system, and those that succeeded. */
  calls: 0,
  succeeded: 0,
  reset() {
    this.calls = 0;
    this.succeeded = 0;
    this.ran.clear();
    this.acted.clear();
    this.ms.clear();
    this.guards.clear();
  },
};
const bump = (m: Map<string, number>, k: string, by = 1) => m.set(k, (m.get(k) ?? 0) + by);

/** Commands after which the harness forgets its undo list (what undo takes back is unclear then). */
const FORGETS_UNDO = new Set<CommandType>(["crash", "curate-edits", "undo", "seed-beta26"]);

export class Cmd implements fc.AsyncCommand<Ctx, World> {
  ran = false;
  constructor(readonly desc: Desc) {}

  check(): boolean {
    return true;
  }

  async run(ctx: Ctx, w: World): Promise<void> {
    this.ran = true;
    const t0 = performance.now();
    const t = this.desc.t;
    bump(stats.ran, t);
    try {
      await this.go(ctx, w);
    } finally {
      bump(stats.ms, t, performance.now() - t0);
    }
  }

  private async go(ctx: Ctx, w: World): Promise<void> {
    const m = ctx.m;
    const editsBefore = m.handEdits.map((e) => e.path);
    const handEditsBefore = structuredClone(m.handEdits);
    const modelBefore = m.clone();
    const pendingBefore = w.pending;
    const before = await w.snap();
    const acted = await act(this.desc, ctx, w, before, {});
    if (!acted) return;
    w.steps++;
    bump(stats.acted, this.desc.t);
    const after = await w.snap();
    const o = acted.outcome;
    if (o) w.lastOutcome = o;
    if (o?.refused && o.guard) bump(stats.guards, o.guard);
    if (o) stats.calls++;
    if (o?.wrote) stats.succeeded++;
    const ok = !!o?.wrote;
    // A success that built (or undid builds): the catalog is now a build of the model, and what
    // changed before it is explained. A dry run, verify without --write and prune build nothing.
    const built =
      ok &&
      (!!acted.builtAfter ||
        (acted.expect?.kind !== "dry" &&
          acted.expect?.kind !== "neutral" &&
          this.desc.t !== "prune"));
    if (ok) {
      await acted.onSuccess?.();
      const discard = acted.confirm?.discardEdits;
      if (discard !== undefined && discard === editsBefore.length) m.handEdits = [];
      m.writes++;
      if (built) m.built = acted.builtAfter ?? m.clone(false);
    }
    const step: Step = {
      desc: this.desc,
      m,
      w,
      before,
      after,
      editsBefore,
      handEditsBefore,
      modelBefore,
      pendingBefore,
      ...acted,
    };
    checkStep(step, ctx.enabled);
    // A written build may retire legacy joins it derived again (point 6): the model follows,
    // once the retirement is shown to be one the current sources allow.
    if (ok && built && m.legacyJoins.length) {
      const text = after.sources.get("legacy/joins.json");
      let kept = new Set<string>(m.legacyJoins.map((j) => `${j.kind}/${j.id}`));
      if (text !== undefined)
        try {
          const slot = JSON.parse(text) as { records?: { kind: string; id: string }[] };
          kept = new Set((slot.records ?? []).map((r) => `${r.kind}/${r.id}`));
        } catch {
          // a joins.json that doesn't parse retires nothing here; the slot checks say so
        }
      else kept = new Set();
      const written = new Set([...records(after.generated).values()].map(recId));
      const wrong = m.retire(kept, written);
      if (wrong.length && ctx.enabled.has("links-are-live"))
        throw new InvariantError(
          "links-are-live",
          `after ${this.desc.t}, legacy joins left joins.json though the current, non-legacy sources don't derive them into the catalog written: ${wrong.map((j) => `${j.kind}/${j.id}${j.arrow ? ` (${j.arrow.key})` : ""}`).join(", ")}`,
        );
    }
    const changed =
      !sameTree(before.generated, after.generated) || !sameTree(before.sources, after.sources);
    if (ok) {
      if (changed)
        w.undoable = [
          ...w.undoable,
          { desc: this.desc, before, after, model: modelBefore, changes: m.changes },
        ].slice(-5);
      if (built) m.wrote();
      if (acted.carry) m.changes = acted.carry;
    }
    if (
      (FORGETS_UNDO.has(this.desc.t) && (this.desc.t !== "undo" || ok)) ||
      acted.inner?.t === "crash"
    )
      w.undoable = [];
    if (o?.refused && (o.guard === "large-removals" || o.guard === "hand-edits") && acted.rerun) {
      // A confirmation that met the next guard keeps the listing its count came from.
      const c = acted.confirm ?? {};
      const removals =
        o.removals ?? (c.allowRemovals !== undefined ? pendingBefore?.removals : undefined);
      const edits = o.edits ?? (c.discardEdits !== undefined ? pendingBefore?.edits : undefined);
      // A removal listing carried over keeps its age: it was made when the earlier refusal listed
      // it, and the commands acted since may have changed what the command removes (a confirmation
      // of it is judged by its count, not by its records).
      const carried = !o.removals && removals !== undefined && pendingBefore?.removals === removals;
      w.pending = {
        desc: acted.rerun,
        confirm: c,
        ...(removals ? { removals } : {}),
        ...(edits ? { edits } : {}),
        at: carried && pendingBefore ? pendingBefore.at : w.steps,
      };
    } else if (
      ok &&
      (acted.confirmOf || (built && w.pending && !w.pending.removals && !m.handEdits.length))
    ) {
      // Confirmed; or a refusal for hand edits only, whose edits a written build has since taken
      // (made curated or discarded): nothing of it is left to confirm. A pending removal listing
      // stays through another command's write: the refused command wrote nothing (point 4), and
      // only its own confirmation applies it.
      w.pending = undefined;
    }
    w.lastWriter = ok ? acted.rerun : undefined;
  }

  toString(): string {
    return JSON.stringify(this.desc);
  }
}

const live = (m: Model, slot: number) => {
  const r = m.repos[slot % m.repos.length]!;
  return r.listed && !r.archived ? r : undefined;
};

const uniq = <T>(xs: T[]) => [...new Set(xs)];

type ScanDesc = Desc & {
  t:
    | "scan"
    | "scan-subset"
    | "scan-not-cloned"
    | "scan-reader-fails"
    | "scan-cancelled"
    | "scan-nothing";
};

/** Run a scan the way the person asked, with clones moved away for "not cloned" and "nothing". */
async function scan(
  d: ScanDesc,
  m: Model,
  w: World,
  confirm: Confirm,
  crash?: "after-slots" | "mid-records",
): Promise<Acted | undefined> {
  const n = m.repos.length;
  const asked =
    d.t === "scan-subset"
      ? uniq(d.slots.map((s) => s % n)).filter((s) => m.isLive(s))
      : m.live().map((r) => r.slot);
  if (!asked.length) return undefined;
  const target =
    d.t === "scan-not-cloned" || d.t === "scan-reader-fails" ? live(m, d.slot) : undefined;
  if ((d.t === "scan-not-cloned" || d.t === "scan-reader-fails") && !target) return undefined;
  // A cancel stops between repos (ADR 0119), so it needs a second one to stop before.
  if (d.t === "scan-cancelled" && asked.length < 2) return undefined;
  const aside = d.t === "scan-nothing" ? asked : d.t === "scan-not-cloned" ? [target!.slot] : [];
  const moved: [string, string][] = [];
  for (const s of aside) {
    const from = w.clone(m.repos[s]!.id);
    if (!existsSync(from)) continue;
    const to = join(w.top, `aside-${s}`);
    await move(from, to);
    moved.push([to, from]);
  }
  fault.fired = 0;
  fault.on = d.t === "scan-reader-fails" ? target!.id : undefined;
  fault.cancel = d.t === "scan-cancelled" ? new AbortController() : undefined;
  let outcome: Outcome;
  try {
    const call = () =>
      sut().scan(w.root, {
        ...(d.t === "scan-subset" ? { repos: asked.map((s) => m.repos[s]!.id) } : {}),
        ...confirm,
        ...(crash ? { crash } : {}),
      });
    outcome = fault.cancel
      ? await withSignal(fault.cancel.signal, call).catch((e: unknown): Outcome => {
          if (!(e instanceof CancelledError)) throw e;
          return { wrote: false, refused: true, code: 1, out: [], err: [e.message] };
        })
      : await call();
  } finally {
    for (const [from, to] of moved) await move(from, to);
    fault.on = undefined;
    fault.cancel = undefined;
  }
  const faulted = d.t === "scan-reader-fails" || d.t === "scan-cancelled";
  if (faulted && !fault.fired && !outcome.unsupported && outcome.guard !== "hand-edits")
    throw new Error(
      `harness: the ${d.t === "scan-cancelled" ? "cancel" : `reader fault on ${target!.id}`} never fired: the scan didn't read through the mocked scanEstate (fault.ts)`,
    );
  // The ADR's rule: each repo the scan read in full is observed; the others keep their last read.
  const observed =
    d.t === "scan-cancelled" || d.t === "scan-nothing"
      ? []
      : asked.filter((s) => s !== target?.slot);
  const unobserved = m
    .live()
    .map((r) => r.slot)
    .filter((s) => !observed.includes(s));
  const expect: Expect =
    d.t === "scan-cancelled"
      ? { kind: "neutral" }
      : observed.length
        ? { kind: "succeed" }
        : { kind: "refuse", guard: "nothing-read" };
  return {
    outcome,
    confirm,
    expect,
    observed,
    unobserved,
    rerun: d,
    onSuccess: () => observe(m, observed),
  };
}

/** The readers of these slots read in full now: their slots hold this read. */
function observe(m: Model, slots: number[]): void {
  for (const s of slots) {
    const r = m.repos[s]!;
    const was = m.readers.get(s);
    if (!was || was.commit !== r.commit || was.id !== r.id || was.legacy) m.changes.slots.add(s);
    m.readers.set(s, { code: r.code, commit: r.commit, id: r.id });
  }
}

async function verify(
  d: Desc & { t: "verify-write" | "verify-live" },
  m: Model,
  w: World,
  confirm: Confirm,
  crash?: "after-slots" | "mid-records",
): Promise<Acted | undefined> {
  const r = live(m, d.slot);
  if (!r) return undefined;
  const ok = d.t === "verify-live" || d.ok;
  await mkdir(join(w.root, "facts"), { recursive: true });
  await writeFile(
    join(w.root, "facts", `${r.id}.jsonl`),
    renderFacts(r.base, r.id, r.code, r.commit, { broken: !ok }),
  );
  const write = d.t === "verify-write";
  const outcome = await sut().verify(w.root, r.id, {
    write,
    ...confirm,
    ...(crash ? { crash } : {}),
  });
  if (!write) return { outcome, expect: { kind: "neutral" } };
  const facts = { code: r.code, commit: r.commit, id: r.id };
  return {
    outcome,
    confirm,
    expect: ok ? { kind: "succeed" } : { kind: "refuse" },
    rerun: d,
    onSuccess: () => {
      if (!ok) return;
      const was = m.facts.get(r.slot);
      if (!was || was.commit !== facts.commit || was.id !== facts.id) m.changes.slots.add(r.slot);
      m.facts.set(r.slot, facts);
    },
  };
}

/** `atticus repo rename <id> <id>-core`; with `crash`, its write stops part way. */
async function rename(
  d: Desc & { t: "rename" },
  m: Model,
  w: World,
  confirm: Confirm,
  crash?: "after-slots" | "mid-records",
): Promise<Acted | undefined> {
  const r = live(m, d.slot);
  if (!r || r.id.endsWith("-core")) return undefined;
  const from = r.id;
  const to = `${r.id}-core`;
  // New slot files that don't parse need slot files to write: a repo never observed has none.
  const fail = !!d.fail && [m.readers.get(r.slot), m.facts.get(r.slot)].some((o) => o?.id === from);
  const outcome = await sut().rename(w.root, from, to, {
    ...confirm,
    ...(d.fail ? { failBuild: true } : {}),
    ...(crash ? { crash } : {}),
  });
  return {
    outcome,
    confirm,
    expect: fail ? { kind: "refuse", guard: "build-failed" } : { kind: "succeed" },
    rerun: d,
    onSuccess: async () => {
      if (fail) return;
      // The person clones it again under its new id (atticus workspace sync, here a move).
      if (existsSync(w.clone(from))) await move(w.clone(from), w.clone(to));
      r.id = to;
      for (const obs of [m.readers.get(r.slot), m.facts.get(r.slot)])
        if (obs?.id === from) obs.id = to;
      m.changes.slots.add(r.slot);
    },
  };
}

/** A build after a person changed an input (`atticus catalog build`). */
async function build(w: World, confirm: Confirm): Promise<Acted> {
  return {
    outcome: await sut().build(w.root, confirm),
    confirm,
    expect: { kind: "succeed" },
    rerun: { t: "build" },
  };
}

/** The record files a command may pick, by path: not already edited by hand. */
function pickable(m: Model, s: Snap, f: (r: Rec) => boolean): [string, Rec][] {
  const edited = new Set(m.handEdits.map((e) => e.path));
  return [...records(s.generated)]
    .filter(([p, r]) => !edited.has(p) && f(r))
    .sort(([a], [b]) => (a < b ? -1 : 1));
}

const isRest = (r: Rec) => r.kind === "Endpoint" && r.endpointType === "rest";
const keyOf = (r: Rec) => endpointKey(String(r.component), String(r.method), String(r.pathOrTopic));

async function writeDecision(w: World, d: Record<string, unknown>): Promise<void> {
  const p = parseRecord({
    kind: "CuratedDecision",
    schemaVersion: 2,
    status: "current",
    confidence: "asserted",
    reason: "A person's decision in the property tests.",
    by: "forge.dev",
    at: "2026-11-11T09:00:00Z",
    ...d,
  });
  if (!p.ok) throw new Error(`harness: bad curated decision ${JSON.stringify(p.issues)}`);
  const file = join(w.root, "catalog", "curated", ...recordPath(p.record).split("/"));
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, serializeRecord(p.record));
}

/** The slot files `atticus catalog prune` lists: orphaned and archived repos', and the upgrade's copy. */
export function prunable(m: Model, sources: Map<string, string>): string[] {
  const liveIds = new Set(m.live().map((r) => r.id));
  return [...sources.keys()]
    .filter((p) => {
      if (p.startsWith("legacy/generated-before-upgrade/")) return true;
      const slot = /^(?:readers\/(.+)\.json|facts\/(.+)\.(?:jsonl|meta\.json))$/.exec(p);
      return !!slot && !liveIds.has((slot[1] ?? slot[2])!);
    })
    .sort();
}

export async function act(
  d: Desc,
  ctx: Ctx,
  w: World,
  before: Snap,
  confirm: Confirm,
): Promise<Acted | undefined> {
  const m = ctx.m;
  const n = m.repos.length;
  switch (d.t) {
    case "seed-beta26": {
      if (m.writes || m.beta26 || before.generated.size || before.sources.size)
        throw new Error("harness: seed-beta26 comes first, on a metarepo nothing wrote yet");
      const s = await todaysWriters.scan(w.root, {});
      if (!s.wrote) throw new Error(`harness: beta.26's scan didn't write: ${s.err.join("\n")}`);
      observe(
        m,
        m.live().map((r) => r.slot),
      );
      for (const slot of uniq(d.verify.map((x) => x % n))) {
        const r = m.repos[slot]!;
        await mkdir(join(w.root, "facts"), { recursive: true });
        await writeFile(
          join(w.root, "facts", `${r.id}.jsonl`),
          renderFacts(r.base, r.id, r.code, r.commit),
        );
        const v = await todaysWriters.verify(w.root, r.id, { write: true });
        // A writer newer than beta.26 may refuse it (a large removal it wants confirmed): the
        // seed then has no facts for the repo, which is a beta.26 metarepo too.
        if (v.wrote) m.facts.set(slot, { code: r.code, commit: r.commit, id: r.id });
      }
      // A beta.26 metarepo is catalog/generated/ with no catalog/sources/: when the CLI's writers
      // are newer than beta.26 (CS2's), what they keep beside the catalog is taken away, so the
      // upgrade has a beta.26 metarepo to adopt whichever writers made its catalog.
      for (const d of ["catalog/sources", ".index/build-undo", ".index/build-cache"])
        await rm(join(w.root, ...d.split("/")), { recursive: true, force: true });
      m.beta26 = true;
      m.changes = noChanges();
      m.built = m.clone(false);
      return {};
    }

    case "scan":
    case "scan-subset":
    case "scan-not-cloned":
    case "scan-reader-fails":
    case "scan-cancelled":
    case "scan-nothing":
      return scan(d, m, w, confirm);

    case "change-code": {
      const r = m.repos[d.slot % n]!;
      if (!r.listed || !existsSync(w.clone(r.id))) return undefined;
      const bases = m.repos.map((x) => x.base);
      r.code = d.code ?? resolve(bases, r.slot, d.sketch!, r.code.filler ?? 0);
      m.history.get(r.slot)!.push(r.code);
      r.commit = await commitCode(w.clone(r.id), r.base, r.code, r.commits++);
      return {};
    }

    case "verify-write":
    case "verify-live":
      return verify(d, m, w, confirm);

    case "answer": {
      // `host` picks among the open questions about a repo's legacy host (the scan asks one for
      // each host a call names that no repo lists), so an answer acts whenever one is asked.
      const open = (await listQuestions(w.root, { step: HOSTS_STEP, state: "open" })).questions
        .flatMap((q) => {
          const h = m.live().find((r) => q.question.includes(r.base.legacyHost));
          return h ? [{ q, h }] : [];
        })
        .sort((a, b) => (a.q.id < b.q.id ? -1 : 1));
      if (!open.length) return undefined;
      const { q, h } = open[d.host % open.length]!;
      const to = d.to === "none" ? undefined : d.to === "self" ? h : live(m, d.to);
      if (d.to !== "none" && !to) return undefined;
      const host = h.base.legacyHost;
      const i = q.options.findIndex((o) => o.label === (to ? to.id : HOSTS_NONE));
      if (i < 0) return undefined;
      const said: string[] = [];
      const io = { out: (l: string) => said.push(l), err: (l: string) => said.push(l) };
      const code = await main(
        [
          "questions",
          "answer",
          q.id,
          "--option",
          String(i + 1),
          "--by",
          "forge.dev",
          "--root",
          w.root,
        ],
        io,
      );
      if (code !== 0) throw new Error(`harness: questions answer failed: ${said.join("\n")}`);
      if (to && !to.hosts.includes(host)) to.hosts.push(host);
      m.answers.set(host, to ? to.slot : "none");
      m.changes.answered.add(host);
      return build(w, confirm);
    }

    case "curate": {
      if (d.action === "alias") {
        // An alias whose value names another feature folds it into the target (ADR 0031).
        const feats = pickable(
          m,
          before,
          (r) => r.kind === "Capability" && r.id.startsWith("feature."),
        );
        if (feats.length < 2) return undefined;
        const [, a] = feats[d.pick % feats.length]!;
        const [, b] = feats[(d.pick + 1) % feats.length]!;
        const id = `cd-alias-${a.id}`;
        if (m.curated.some((x) => x.id === id || x.target === b.id)) return undefined;
        await writeDecision(w, { id, target: a.id, action: "alias", value: [b.id] });
        m.curated.push({
          id,
          action: "alias",
          target: a.id,
          kind: a.kind,
          value: [b.id],
          since: m.writes,
          from: "person",
        });
        m.changes.curated.add(a.id).add(b.id);
        return build(w, confirm);
      }
      const eps = pickable(m, before, isRest);
      if (!eps.length) return undefined;
      const [, e] = eps[d.pick % eps.length]!;
      const id = `cd-${d.action}-${e.id}`;
      if (!m.slotOfComponent(String(e.component)) || m.curated.some((x) => x.id === id))
        return undefined;
      const value = d.action === "assert" ? { auth: "oauth2" } : null;
      await writeDecision(w, { id, target: e.id, action: d.action, value });
      m.curated.push({
        id,
        action: d.action,
        target: e.id,
        kind: "Endpoint",
        key: keyOf(e),
        ...(value ? { value } : {}),
        since: m.writes,
        from: "person",
      });
      m.changes.curated.add(e.id);
      return build(w, confirm);
    }

    case "uncurate": {
      const mine = m.curated.filter((x) => x.from === "person");
      if (!mine.length) return undefined;
      const dec = mine[d.pick % mine.length]!;
      m.curated = m.curated.filter((x) => x !== dec);
      const file = [...before.curated.keys()].find((k) => k.endsWith(`/${dec.id}.yaml`));
      if (file) await rm(join(w.root, "catalog", "curated", ...file.split("/")));
      m.changes.curated.add(dec.target);
      return build(w, confirm);
    }

    case "archive":
    case "remove": {
      const r = live(m, d.slot);
      if (!r) return undefined;
      if (d.t === "archive") r.archived = true;
      else r.listed = false;
      await writeManifest(w.root, m.manifest());
      m.changes.slots.add(r.slot);
      return build(w, confirm);
    }

    case "hand-edit": {
      const any = pickable(m, before, () => true);
      const rest = pickable(m, before, isRest);
      const from = d.how === "delete" ? any : rest;
      if (!from.length) return undefined;
      const [rel, rec] = from[d.pick % from.length]!;
      const full = (p: string) => join(w.root, "catalog", "generated", ...p.split("/"));
      let edit: HandEdit;
      if (d.how === "delete") {
        await rm(full(rel));
        const arrow = arrowOf(m, rec);
        edit = {
          path: rel,
          how: "delete",
          kind: rec.kind,
          id: rec.id,
          ...(isRest(rec) ? { key: keyOf(rec) } : {}),
          ...(arrow ? { arrow } : {}),
        };
      } else if (d.how === "change") {
        const auth = rec.auth === "mtls" ? "basic" : "mtls";
        const doc = parse(await readFile(full(rel), "utf8")) as Record<string, unknown>;
        await writeFile(full(rel), stringify({ ...doc, auth }) + "# edited by hand\n");
        edit = {
          path: rel,
          how: "change",
          kind: rec.kind,
          id: rec.id,
          key: keyOf(rec),
          value: { auth },
        };
      } else {
        // A record a person adds by hand: a copy of an endpoint, on a path no repo serves.
        const id = `${rec.id}.by-hand`;
        const path = `/by-hand/${rec.id}`;
        // Added once already and not discarded (it stays a hand edit: an added record is never
        // made a curated decision), or made curated before: nothing new to add.
        if (m.curated.some((x) => x.target === id) || m.handEdits.some((e) => e.id === id))
          return undefined;
        const doc = parse(await readFile(full(rel), "utf8")) as Record<string, unknown>;
        const p = parseRecord({ ...doc, id, pathOrTopic: path, normalizedPath: path });
        if (!p.ok) throw new Error(`harness: bad added record ${JSON.stringify(p.issues)}`);
        const at = recordPath(p.record);
        await mkdir(join(full(at), ".."), { recursive: true });
        await writeFile(full(at), serializeRecord(p.record));
        edit = {
          path: at,
          how: "add",
          kind: rec.kind,
          id,
          key: endpointKey(String(rec.component), String(rec.method), path),
        };
      }
      m.handEdits.push(edit);
      return {};
    }

    case "discard-edits": {
      if (!m.handEdits.length) return undefined;
      const p = w.pending;
      const count = (p?.edits?.length ?? m.handEdits.length) + (d.wrong ? 1 : 0);
      const c: Confirm = { ...(p?.confirm ?? {}), ...confirm, discardEdits: count };
      const acted = p ? await act(p.desc, ctx, w, before, c) : await build(w, c);
      if (!acted) return undefined;
      return {
        ...acted,
        expect: d.wrong
          ? { kind: "refuse", guard: "hand-edits" }
          : (acted.expect ?? { kind: "succeed" }),
        ...(p ? { confirmOf: p } : {}),
      };
    }

    case "curate-edits": {
      if (!m.handEdits.length) return undefined;
      // ADR 0195 addendum (CS2, the guards as built): "an added record can't be a curated
      // decision (one changes or suppresses a record the build makes) and is said". The changed
      // and deleted files are made curated; each added one stays a hand edit, so the command
      // refuses (nothing built, catalog/generated and the slots as they were) until it is
      // discarded.
      const adds = m.handEdits.filter((e) => e.how === "add");
      const pre = await sut().curateEdits(w.root);
      const curate = (e: HandEdit) => {
        const common = {
          target: e.id,
          kind: e.kind,
          ...(e.key ? { key: e.key } : {}),
          ...(e.arrow ? { arrow: e.arrow } : {}),
        };
        const dec: Decision =
          e.how === "delete"
            ? { action: "suppress", ...common, since: m.writes, from: "edits" }
            : { action: "assert", ...common, value: e.value!, since: m.writes, from: "edits" };
        m.curated.push(dec);
        m.changes.curated.add(e.id);
      };
      if (adds.length) {
        if (pre.refused)
          for (const e of m.handEdits.filter((x) => x.how !== "add")) {
            curate(e);
            m.curatedPending.push(e);
          }
        m.handEdits = pre.refused ? adds : m.handEdits;
        return { outcome: pre, expect: { kind: "refuse" } };
      }
      if (!pre.wrote) return { outcome: pre, pre, expect: { kind: "succeed" } };
      for (const e of m.handEdits) curate(e);
      // Until a build writes them in, the files stay the person's (a refused build writes nothing).
      m.curatedPending.push(...m.handEdits);
      m.handEdits = [];
      return { ...(await build(w, confirm)), pre };
    }

    case "confirm-removals": {
      const p = w.pending;
      if (!p?.removals) return undefined;
      const c: Confirm = {
        ...p.confirm,
        ...confirm,
        allowRemovals: p.removals.count + (d.wrong ? 1 : 0),
      };
      const acted = await act(p.desc, ctx, w, before, c);
      if (!acted) return undefined;
      // The listing outlives the commands acted since it (point 4: the refused command wrote
      // nothing, and only its own confirmation applies it), but what the command removes now is
      // worked out again when it runs: another command's write, or a commit its scan now reads,
      // changes it. Right after the listing, its count is the count, and one more must refuse.
      // Later, the count it was given is checked against the count it lists now: the same
      // succeeds, and any other refuses again with the new listing ("any other count refuses
      // again"), which the checks accept only when that listing's count is not the one given
      // (`unjustified`), and a write only when it removed that many (large-removals-confirmed).
      const fresh = p.at === w.steps;
      return {
        ...acted,
        expect:
          d.wrong && fresh
            ? { kind: "refuse", guard: "large-removals" }
            : (acted.expect ?? { kind: "succeed" }),
        confirmOf: p,
      };
    }

    case "rename":
      return rename(d, m, w, confirm);

    case "build":
      return build(w, confirm);

    case "undo": {
      if (!w.undoable.length) return undefined;
      const k = 1 + ((d.n ?? 0) % w.undoable.length);
      if (d.yes === false)
        return { outcome: await sut().undo(w.root, { n: k, yes: false }), expect: { kind: "dry" } };
      if (m.handEdits.length)
        return {
          outcome: await sut().undo(w.root, { n: k, yes: true }),
          expect: { kind: "refuse", guard: "hand-edits" },
        };
      const undone = w.undoable.slice(-k);
      const restored = undone[0]!.model;
      const outcome = await sut().undo(w.root, { n: k, yes: true });
      const afterUndo = await w.snap();
      // Undoing a discard brings its hand edits back, and undo refuses over hand edits.
      const back = d.back !== false && !restored.handEdits.length;
      const backOutcome =
        outcome.wrote && back ? await sut().undo(w.root, { n: 1, yes: true }) : undefined;
      const stays = back && !!backOutcome?.wrote;
      const union = (f: (c: Changes) => Set<string> | Set<number>) =>
        new Set([...f(m.changes), ...undone.flatMap((e) => [...f(e.changes)])]);
      const carry = {
        slots: union((c) => c.slots),
        curated: union((c) => c.curated),
        answered: union((c) => c.answered),
      } as Changes;
      const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
      for (const r of m.repos)
        if (
          !same(m.readers.get(r.slot), restored.readers.get(r.slot)) ||
          !same(m.facts.get(r.slot), restored.facts.get(r.slot))
        )
          carry.slots.add(r.slot);
      const undo = {
        before: undone[0]!.before,
        after: undone[undone.length - 1]!.after,
        afterUndo,
        back,
        ...(backOutcome ? { backOutcome } : {}),
      };
      if (stays)
        return {
          outcome,
          expect: { kind: "succeed" },
          undo,
          builtAfter: m.built ?? m.clone(false),
          carry: m.changes,
        };
      return {
        outcome,
        expect: { kind: "succeed" },
        undo,
        builtAfter: restored.built ?? restored.clone(false),
        carry,
        onSuccess: () => {
          m.readers = restored.readers;
          m.facts = restored.facts;
          m.legacyJoins = restored.legacyJoins;
          m.beta26 = restored.beta26;
          m.handEdits = restored.handEdits;
        },
      };
    }

    case "prune": {
      const listed = prunable(m, before.sources);
      const outcome = await sut().prune(w.root, { yes: d.yes });
      return {
        outcome,
        expect: d.yes ? { kind: "succeed" } : { kind: "dry" },
        prunable: listed,
        onSuccess: () => {
          if (!d.yes) return;
          const liveIds = new Set(m.live().map((r) => r.id));
          for (const obs of [m.readers, m.facts])
            for (const [slot, o] of obs) if (!liveIds.has(o.id)) obs.delete(slot);
        },
      };
    }

    case "crash": {
      if (d.via === "rename") {
        // ADR 0195 point 2: the rename computes everything first and writes it in one step; a
        // write that stops part way puts every file back, so nothing changed and nothing is
        // left for a build to catch up (the model is as it was: no update applies).
        const first = await rename({ t: "rename", slot: d.slot }, m, w, confirm, d.at);
        if (!first?.outcome) return undefined;
        const o = first.outcome;
        if (!o.crashed) return { ...first, crash: { first: o, mid: before } };
        const { onSuccess: _never, ...rest } = first;
        return {
          ...rest,
          expect: { kind: "neutral" },
          crash: { first: o, mid: before, whole: true },
        };
      }
      const inner: Desc =
        d.via === "scan" ? { t: "scan" } : { t: "verify-write", slot: d.slot, ok: true };
      const first =
        inner.t === "scan"
          ? await scan(inner, m, w, confirm, d.at)
          : await verify(inner as Desc & { t: "verify-write" }, m, w, confirm, d.at);
      if (!first?.outcome) return undefined;
      const o = first.outcome;
      // Refused before it wrote (a guard), unsupported, or the fault ignored: judged as it is.
      if (!o.crashed) return { ...first, crash: { first: o, mid: before } };
      const mid = await w.snap();
      // The crash left the slots written: they hold this observation now.
      await first.onSuccess?.();
      return {
        ...(await build(w, {})),
        observed: first.observed ?? [],
        unobserved: first.unobserved ?? [],
        crash: { first: o, mid },
      };
    }

    case "upgrade": {
      const pack = join(w.root, "org-pack");
      const packBefore = await readTree(pack);
      const outcome = await sut().upgrade(w.root, { yes: d.yes });
      // Its other steps run without --yes too: the org pack's files migrated are an input.
      if (!sameTree(packBefore, await readTree(pack))) m.changes.orgPack = true;
      if (!m.beta26 || !d.yes) return { outcome, expect: { kind: "dry" } };
      const afterUpgrade = await w.snap();
      const built = outcome.wrote ? await sut().build(w.root, {}) : undefined;
      return {
        outcome,
        expect: { kind: "succeed" },
        rerun: { t: "build" },
        upgrade: { after: afterUpgrade, ...(built ? { build: built } : {}) },
        onSuccess: () => {
          // Every record adopted (ADR point 6): each repo's into a legacy readers slot, the
          // joined ones into legacy/joins.json; no facts slot.
          for (const r of m.live()) {
            const s = m.source(r.slot);
            m.facts.delete(r.slot);
            if (s) m.readers.set(r.slot, { ...s.obs, legacy: true });
          }
          // Every record that goes to legacy/joins.json (the lossless invariant's rule): a
          // cross-repo arrow, and any record with evidence from several repos or none.
          m.legacyJoins = [];
          const slotOfRepo = new Map(m.repos.map((r) => [r.id, r.slot]));
          for (const rec of records(before.generated).values()) {
            const repos = [...repoOf(rec)];
            const slots = repos.flatMap((x) => (slotOfRepo.has(x) ? [slotOfRepo.get(x)!] : []));
            const a = rec.kind === "Interface" ? m.slotOfEnd(String(rec.from)) : undefined;
            const b = rec.kind === "Interface" ? m.slotOfEnd(String(rec.to)) : undefined;
            if (a && b && a.slot !== b.slot)
              m.legacyJoins.push({
                kind: rec.kind,
                id: rec.id,
                arrow: {
                  key: arrowKey(
                    a.base.component,
                    b.base.component,
                    rec.method ?? "EVENT",
                    String(rec.normalizedPath),
                  ),
                  from: a.slot,
                  to: b.slot,
                },
                repos: slots,
              });
            else if (repos.length !== 1)
              m.legacyJoins.push({ kind: rec.kind, id: rec.id, repos: slots });
          }
          m.beta26 = false;
        },
      };
    }

    case "again": {
      if (!w.lastWriter) return undefined;
      const acted = await act(w.lastWriter, ctx, w, before, {});
      if (!acted) return undefined;
      return { ...acted, inner: w.lastWriter, expect: { kind: "succeed" } };
    }
  }
}

/** A beta.26 metarepo first, upgraded (after a dry run or not), or nothing: the sequence's prefix. */
export const prefixArb: fc.Arbitrary<Desc[]> = fc.oneof(
  { withCrossShrink: true },
  { arbitrary: fc.constant<Desc[]>([]), weight: 7 },
  {
    arbitrary: fc
      .record({
        verify: fc.uniqueArray(fc.nat({ max: 4 }), { maxLength: 2 }),
        dry: fc.boolean(),
      })
      .map(({ verify, dry }): Desc[] => [
        { t: "seed-beta26", verify },
        ...(dry ? [{ t: "upgrade" as const, yes: false }] : []),
        { t: "upgrade", yes: true },
      ]),
    weight: 1,
  },
);

/**
 * The commands, weighted toward the writers and toward what is rare to reach otherwise (a
 * confirmation, a discard, an answer naming a repo's own legacy host, the same build again). A
 * repo is a slot number taken modulo the estate's size, so the commands are made apart from the
 * estate and each shrinks on its own.
 */
export function commandArbs(): fc.Arbitrary<Cmd>[] {
  const slot = fc.nat({ max: 4 });
  const d = (a: fc.Arbitrary<Desc>) => a.map((x) => new Cmd(x));
  const times = <T>(k: number, x: T): T[] => Array.from({ length: k }, () => x);
  const rarely = fc.oneof(
    { arbitrary: fc.constant(false), weight: 3 },
    { arbitrary: fc.constant(true), weight: 1 },
  );
  return [
    ...times(3, d(fc.constant({ t: "scan" }))),
    ...times(
      1,
      d(
        fc.record({
          t: fc.constant("scan-subset" as const),
          slots: fc.uniqueArray(slot, { minLength: 1, maxLength: 5 }),
        }),
      ),
    ),
    d(fc.record({ t: fc.constant("scan-not-cloned" as const), slot })),
    d(fc.record({ t: fc.constant("scan-reader-fails" as const), slot })),
    d(fc.constant({ t: "scan-cancelled" })),
    d(fc.constant({ t: "scan-nothing" })),
    ...times(3, d(fc.record({ t: fc.constant("change-code" as const), slot, sketch: sketchArb }))),
    ...times(3, d(fc.record({ t: fc.constant("verify-write" as const), slot, ok: fc.boolean() }))),
    d(fc.record({ t: fc.constant("verify-live" as const), slot })),
    ...times(
      2,
      d(
        fc.record({
          t: fc.constant("answer" as const),
          host: slot,
          to: fc.oneof(
            { arbitrary: fc.constant("self" as const), weight: 2 },
            { arbitrary: slot, weight: 1 },
            { arbitrary: fc.constant("none" as const), weight: 1 },
          ),
        }),
      ),
    ),
    ...times(
      3,
      d(
        fc.record({
          t: fc.constant("curate" as const),
          action: fc.constantFrom("suppress" as const, "assert" as const, "alias" as const),
          pick: fc.nat(30),
        }),
      ),
    ),
    ...times(2, d(fc.record({ t: fc.constant("uncurate" as const), pick: fc.nat(30) }))),
    d(fc.record({ t: fc.constant("archive" as const), slot })),
    d(fc.record({ t: fc.constant("remove" as const), slot })),
    ...times(
      3,
      d(
        fc.record({
          t: fc.constant("hand-edit" as const),
          pick: fc.nat(60),
          how: fc.constantFrom("change" as const, "delete" as const, "add" as const),
        }),
      ),
    ),
    ...times(2, d(fc.record({ t: fc.constant("discard-edits" as const), wrong: rarely }))),
    ...times(2, d(fc.constant({ t: "curate-edits" }))),
    ...times(4, d(fc.record({ t: fc.constant("confirm-removals" as const), wrong: rarely }))),
    d(fc.record({ t: fc.constant("rename" as const), slot, fail: rarely })),
    d(fc.constant({ t: "build" })),
    d(
      fc.record({
        t: fc.constant("undo" as const),
        n: fc.nat(4),
        yes: fc.boolean(),
        back: fc.boolean(),
      }),
    ),
    d(fc.record({ t: fc.constant("prune" as const), yes: fc.boolean() })),
    d(
      fc.record({
        t: fc.constant("crash" as const),
        at: fc.constantFrom("after-slots" as const, "mid-records" as const),
        via: fc.constantFrom("scan" as const, "verify" as const, "rename" as const),
        slot,
      }),
    ),
    d(fc.record({ t: fc.constant("upgrade" as const), yes: fc.boolean() })),
    ...times(3, d(fc.constant({ t: "again" }))),
  ];
}

/** Every command type the generators make: the coverage check's list. */
export const GENERATED: readonly CommandType[] = [
  "seed-beta26",
  "scan",
  "scan-subset",
  "scan-not-cloned",
  "scan-reader-fails",
  "scan-cancelled",
  "scan-nothing",
  "change-code",
  "verify-write",
  "verify-live",
  "answer",
  "curate",
  "uncurate",
  "archive",
  "remove",
  "hand-edit",
  "discard-edits",
  "curate-edits",
  "confirm-removals",
  "rename",
  "build",
  "undo",
  "prune",
  "crash",
  "upgrade",
  "again",
];
