import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { sut } from "./system.js";
import { arrowKey, endpointKey, type HandEdit, type Model } from "./model.js";
import {
  changedPaths,
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
import type { Acted, Ctx, Desc } from "./commands.js";
import type { RemovalReason } from "./seam.js";

/**
 * The twelve invariants of ADR 0195 point 10, the large-removal guard it also tests, and
 * completeness: that a command the model expects to succeed does, and that the catalog it
 * leaves holds what the model says a build makes. Without completeness a system that refuses
 * everything, or writes nothing, keeps the other twelve.
 */
export const INVARIANTS = [
  "equivalence",
  "locality",
  "idempotence",
  "order-independence",
  "failure-neutrality",
  "readers-never-destroy-facts",
  "curation-survives",
  "links-are-live",
  "nothing-removed-unexplained",
  "upgrade-is-lossless",
  "undo-restores",
  "hand-edits-never-silently-lost",
  "large-removals-confirmed",
  "completeness",
] as const;
export type Invariant = (typeof INVARIANTS)[number];

/**
 * The invariants today's writers (beta.26) break: the baseline CS4 records. Each has its shrunk
 * counterexample in regressions/<invariant>.json, which must fail with that invariant (the test
 * says so when it starts passing); the examples that fail today are FAILS_TODAY in examples.ts.
 * CS2 turns them green and takes them off both lists.
 */
// CS2 (ADR 0195): every invariant holds against the build; the counterexamples stay as regressions.
export const KNOWN_FAILURES: ReadonlySet<Invariant> = new Set<Invariant>([]);

/** What one command did, for the checks. */
export interface Step extends Acted {
  desc: Desc;
  m: Model;
  w: World;
  before: Snap;
  after: Snap;
  /** The hand edits not yet made curated or discarded when the command started. */
  editsBefore: string[];
  handEditsBefore: HandEdit[];
  /** The model when the command started. */
  modelBefore: Model;
  /** The refusal waiting for a confirmation when the command started. */
  pendingBefore: Pending | undefined;
}

export class InvariantError extends Error {
  constructor(
    readonly invariant: Invariant,
    message: string,
  ) {
    super(`${invariant}: ${message}`);
  }
}

const fail = (inv: Invariant, message: string): never => {
  throw new InvariantError(inv, message);
};

const SCANS = new Set<Desc["t"]>([
  "scan",
  "scan-subset",
  "scan-not-cloned",
  "scan-reader-fails",
  "scan-cancelled",
  "scan-nothing",
]);

/** Commands that build when they succeed: their catalog is a build's. */
const BUILDS = new Set<Desc["t"]>([
  ...SCANS,
  "verify-write",
  "rename",
  "answer",
  "curate",
  "uncurate",
  "archive",
  "remove",
  "build",
  "discard-edits",
  "curate-edits",
  "confirm-removals",
  "crash",
  "upgrade",
  "again",
]);

/** The command a step ran in the end: what `again`, a confirmation or a crash ran. */
function base(s: Step): Desc {
  if (s.desc.t === "again" && s.inner) return s.inner;
  if ((s.desc.t === "confirm-removals" || s.desc.t === "discard-edits") && s.rerun) return s.rerun;
  if (s.desc.t === "crash")
    return s.desc.via === "scan"
      ? { t: "scan" }
      : s.desc.via === "rename"
        ? { t: "rename", slot: s.desc.slot }
        : { t: "verify-write", slot: s.desc.slot, ok: true };
  return s.desc;
}

/** The step wrote a build: a command that builds, and it succeeded. */
const builtOk = (s: Step) =>
  !!s.outcome?.wrote && BUILDS.has(s.desc.t) && !(s.desc.t === "upgrade" && !s.desc.yes);

/** Every id a slot has had: its current one and those it was observed under. */
function idsOf(m: Model, slot: number): Set<string> {
  const r = m.repos[slot]!;
  return new Set(
    [r.id, r.base.id, m.readers.get(slot)?.id, m.facts.get(slot)?.id].filter(
      (x): x is string => !!x,
    ),
  );
}

const describe = (path: string, r: Rec | undefined) =>
  r ? `${r.kind}/${r.id} (${[...repoOf(r)].join(", ") || "no repo"})` : path;

/** A record involves a slot: its evidence names one of the slot's ids, or it is an arrow to or from its component. */
function involves(m: Model, slots: Iterable<number>, r: Rec | undefined): boolean {
  if (!r) return false;
  const repos = repoOf(r);
  for (const s of slots) {
    for (const id of idsOf(m, s)) if (repos.has(id)) return true;
    const { component, system } = m.repos[s]!.base;
    const ends = [r.from, r.to];
    if (r.kind === "Interface" && (ends.includes(component) || ends.includes(system))) return true;
  }
  return false;
}

/** A cross-repo Interface's arrow, `from|to|method|path`, by the model's repos. */
export function arrowOf(m: Model, r: Rec): string | undefined {
  if (r.kind !== "Interface") return undefined;
  const from = m.slotOfEnd(String(r.from));
  const to = m.slotOfEnd(String(r.to));
  if (!from || !to || from.slot === to.slot) return undefined;
  return arrowKey(
    from.base.component,
    to.base.component,
    r.method ?? "EVENT",
    String(r.normalizedPath),
  );
}

/**
 * The repos a join with `slot` can reach: those whose code, at any commit the model knows, calls
 * one of its hosts or is called by it, or publishes a topic the other listens to. A join that
 * forms or stops forming with `slot` changes their loose ends and features too.
 */
function partners(m: Model, slot: number): number[] {
  const codes = (s: number) => m.history.get(s) ?? [];
  const me = m.repos[slot]!;
  const myHosts = new Set([...me.hosts, me.base.legacyHost]);
  const linked = (a: number, aHosts: Set<string>, b: number) =>
    codes(b).some(
      (c) =>
        c.calls.some((x) => aHosts.has(x.host)) ||
        c.publishes.some((t) => codes(a).some((d) => d.consumes.includes(t))),
    );
  return m.repos
    .filter((r) => r.slot !== slot)
    .filter((r) => {
      const theirs = new Set([...r.hosts, r.base.legacyHost]);
      return linked(slot, myHosts, r.slot) || linked(r.slot, theirs, slot);
    })
    .map((r) => r.slot);
}

/**
 * The kinds a join makes or unmakes in a partner's own records: its loose ends, features and
 * glossary terms. A term is a word two or more records use (ADR 0195's CS2 addendum, "Glossary
 * evidence": it "exists partly because of each repo that uses it"), so when a partner's loose
 * call becomes an arrow to the repo read, the term's uses change with the join, though an arrow
 * inferred from a host cites only its caller (the same kinds the build's removal guard counts as
 * join-derived, JOIN_DERIVED in scanner/src/build.ts).
 */
const JOINED = new Set(["Unresolved", "Capability", "GlossaryTerm"]);

const unchangedSince = (a: Map<string, string>, b: Map<string, string>, skip: string[]) =>
  changedPaths(a, b).filter((p) => !skip.includes(p));

/** The records a step removed from the catalog, by `<Kind>/<id>`: hand-edited files aside. */
function removedBy(s: Step): Map<string, Rec> {
  const skip = new Set(s.editsBefore);
  const after = new Set([...records(s.after.generated).values()].map(recId));
  const out = new Map<string, Rec>();
  for (const [p, r] of records(s.before.generated))
    if (!skip.has(p) && !after.has(recId(r))) out.set(recId(r), r);
  return out;
}

/**
 * The records of files edited by hand that a step's build no longer makes: a refusal's list may
 * count them among its removals, as they are, or leave them to the hand edits' list.
 */
function editedGone(s: Step): Set<string> {
  const after = new Set([...records(s.after.generated).values()].map(recId));
  return new Set(s.handEditsBefore.map((e) => `${e.kind}/${e.id}`).filter((id) => !after.has(id)));
}

/**
 * ADR point 4's limits: more than 10% of a repo's records (those whose evidence names it), or
 * more than 200 in one build. What is above them, in words.
 */
function largeOf(before: Snap, gone: Map<string, Rec>, skip: string[]): string[] {
  const per = new Map<string, { had: number; gone: number }>();
  for (const [p, rec] of records(before.generated)) {
    if (skip.includes(p)) continue;
    for (const repo of repoOf(rec)) {
      const x = per.get(repo) ?? { had: 0, gone: 0 };
      x.had++;
      if (gone.has(recId(rec))) x.gone++;
      per.set(repo, x);
    }
  }
  const big = [...per].filter(([, x]) => x.gone > 0 && x.gone > x.had * 0.1);
  return [
    ...big.map(([r, x]) => `${x.gone} of ${r}'s ${x.had} records`),
    ...(gone.size > 200 ? [`${gone.size} records in one build`] : []),
  ];
}

const sorted = (xs: Iterable<string>) => [...xs].sort();
const sameList = (a: Iterable<string>, b: Iterable<string>) =>
  JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
const list = (xs: Iterable<string>, n = 6) => {
  const a = sorted(xs);
  return a.length
    ? a.slice(0, n).join(", ") + (a.length > n ? ` and ${a.length - n} more` : "")
    : "none";
};

/**
 * Whether a `not-upgraded` refusal is right: the metarepo holds a catalog from before the slots
 * (seeded so, or an undo took the upgrade back) and the command is a writer, neither the upgrade
 * that adopts it nor an undo (ADR 0195 point 7: "an undo can itself be undone", the one that
 * took the upgrade back included).
 */
function notUpgradedMay(s: Step): boolean {
  return s.modelBefore.beta26 && s.desc.t !== "upgrade" && s.desc.t !== "undo";
}

/** Why a guard's refusal of this step is not one the model accounts for (undefined: it is). */
function unjustified(s: Step): string | undefined {
  const o = s.outcome!;
  if (!o.refused) return "it didn't refuse";
  if (o.guard === "hand-edits") {
    if (!s.editsBefore.length) return "no file under catalog/generated/ was edited by hand";
    if (s.confirm?.discardEdits === s.editsBefore.length)
      return `it was given --discard-edits ${s.editsBefore.length}, the count of the hand edits`;
    if (!sameList(o.edits ?? [], s.editsBefore))
      return `it listed ${list(o.edits ?? [])} as hand edits, but they are ${list(s.editsBefore)}`;
    return undefined;
  }
  if (o.guard === "large-removals") {
    const r = o.removals;
    if (!r || !r.count || r.count !== r.ids.length)
      return `it listed ${r ? `a count of ${r.count} for ${r.ids.length} removals` : "no removals"}`;
    if (s.confirm?.allowRemovals === r.count)
      return `it was given --allow-removals ${r.count}, the count it listed`;
    const had = new Set([...records(s.before.generated).values()].map(recId));
    const absent = r.ids.filter((id) => !had.has(id));
    if (absent.length)
      return `it lists ${list(absent)} as removals, which the catalog doesn't hold`;
    return undefined;
  }
  if (o.guard === "empty-catalog") {
    // ADR point 4: no empty catalog over a full one. The guard counts records from code; the
    // model can't say what a build holds besides them (the org pack's systems, say), so it
    // accepts the refusal whenever no repo the build reads has a source that makes a record and
    // the manifests still list one. A facts file with no fact makes none (`makesRecords`): with
    // the ledger's empty facts its only source, archiving payments leaves no record from code,
    // and the guard is right to refuse (seed 1754877814).
    if (!s.before.generated.size) return "the catalog was empty already";
    if (!s.m.repos.some((r) => r.listed)) return "the manifests list no repo";
    const read = s.m.live().filter((r) => s.m.makesRecords(r.slot));
    if (read.length)
      return `${read.map((r) => r.id).join(", ")} ${read.length === 1 ? "has a source that makes" : "have sources that make"} records`;
    return undefined;
  }
  return `the guard ${o.guard ?? "(none)"} isn't one the model can account for here`;
}

/** What the model says may explain a removed record, by the build report's reasons. */
function explanations(s: Step, rec: Rec): Set<RemovalReason> {
  const m = s.m;
  const c = m.changes;
  const out = new Set<RemovalReason>();
  // A record whose evidence names an id no manifest lists rests on a repo gone from the manifests,
  // its slot kept: the build says "manifest" (ADR 0195, CS2's removal reasons). An undone rename
  // leaves one (point 7 puts back the slot under the old id, not the manifest entry).
  const listedIds = new Set(m.repos.filter((r) => r.listed).map((r) => r.id));
  const unlisted = [...repoOf(rec)].some((id) => !listedIds.has(id));
  const reasonsOf = (slot: number): RemovalReason[] => {
    const r = m.repos[slot]!;
    // A repo removed or archived changes the manifest, an input too: a record of a join with it
    // may be reported by any of the three.
    return !r.listed || unlisted
      ? ["manifest", "slot", "input"]
      : r.archived
        ? ["archived", "slot", "input"]
        : ["slot"];
  };
  for (const slot of c.slots)
    if (involves(m, [slot], rec) || (JOINED.has(rec.kind) && involves(m, partners(m, slot), rec)))
      for (const x of reasonsOf(slot)) out.add(x);
  if (c.curated.has(rec.id)) out.add("curated");
  if (c.answered.size) {
    // Only what came from the answer: the loose ends naming the host, the arrows from its
    // callers or to the repo answering on it, and those repos' loose ends and features.
    const callers = m.repos
      .filter((r) =>
        [r.code, m.readers.get(r.slot)?.code, m.facts.get(r.slot)?.code].some((code) =>
          code?.calls.some((x) => c.answered.has(x.host)),
        ),
      )
      .map((r) => r.slot);
    const callees = m.repos
      .filter((r) => r.hosts.some((h) => c.answered.has(h)))
      .map((r) => r.slot);
    const ends = [...callers, ...callees];
    if (
      (rec.kind === "Unresolved" &&
        [...c.answered].some((h) => String(rec.raw ?? "").includes(h))) ||
      ((rec.kind === "Interface" || JOINED.has(rec.kind)) && involves(m, ends, rec))
    )
      out.add("input");
  }
  return out;
}

/** The checks run after each command, by invariant (equivalence and order run at the end). */
export const CHECKS: Partial<Record<Invariant, (s: Step) => void>> = {
  locality(s) {
    const b0 = base(s);
    if (!builtOk(s) || !(SCANS.has(b0.t) || b0.t === "verify-write")) return;
    // The first catalog written makes every record (the org pack's systems too): nothing to compare.
    if (!s.before.generated.size) return;
    const c = s.m.changes;
    if (c.slots.size > 1 || c.curated.size || c.answered.size) return;
    const b = records(s.before.generated);
    const a = records(s.after.generated);
    const reach = [...c.slots].flatMap((x) => partners(s.m, x));
    // The manifests are an input. Archiving or removing a repo is the person's edit to them,
    // then a build; when a guard refuses that build, it writes nothing under catalog/ and the
    // manifest stays as the person left it (ADR 0195 point 4), so the next build that writes,
    // a scan's say, takes the entry in. A System lists its repos from the manifests: its
    // `repos` changes with such an entry, though no repo's evidence names it (seed -1183949415).
    const was = s.modelBefore.built;
    const entries = [...c.slots].filter((x) => {
      const a = was?.repos[x];
      const b = s.m.repos[x];
      return !!a && !!b && (a.listed !== b.listed || a.archived !== b.archived || a.id !== b.id);
    });
    const listsEntry = (r: Rec) =>
      r.kind === "System" &&
      Array.isArray(r.repos) &&
      entries.some((x) => [...idsOf(s.m, x)].some((id) => (r.repos as unknown[]).includes(id)));
    const ok = (r: Rec | undefined) =>
      involves(s.m, c.slots, r) ||
      (!!r && JOINED.has(r.kind) && involves(s.m, reach, r)) ||
      (!!r && listsEntry(r));
    const bad = unchangedSince(s.before.generated, s.after.generated, s.editsBefore).filter(
      (p) => !ok(a.get(p)) && !ok(b.get(p)),
    );
    if (bad.length)
      fail(
        "locality",
        `${c.slots.size ? `only ${[...c.slots].map((x) => s.m.repos[x]!.id).join(", ")}'s observation changed` : "no repo's observation changed"}, yet ${s.desc.t} changed ${bad.map((p) => describe(p, a.get(p) ?? b.get(p))).join("; ")}`,
      );
  },

  idempotence(s) {
    if (s.desc.t !== "again") return;
    const g = changedPaths(s.before.generated, s.after.generated);
    const x = changedPaths(s.before.sources, s.after.sources);
    if (g.length || x.length)
      fail(
        "idempotence",
        `running ${JSON.stringify(s.inner)} again changed ${list([...g.map((p) => `catalog/generated/${p}`), ...x.map((p) => `catalog/sources/${p}`)])}`,
      );
  },

  "failure-neutrality"(s) {
    if (!s.outcome) return;
    const b0 = base(s);
    const whole = (why: string) => {
      const g = changedPaths(s.before.generated, s.after.generated);
      const x = changedPaths(s.before.sources, s.after.sources);
      if (g.length || x.length)
        fail(
          "failure-neutrality",
          `${s.desc.t} ${why}, yet changed ${list([...g.map((p) => `catalog/generated/${p}`), ...x.map((p) => `catalog/sources/${p}`)])}`,
        );
    };
    if (s.crash?.first.crashed && s.crash.whole) {
      // A rename computes everything first and writes it in one step (ADR 0195 point 2): a write
      // that stops part way puts every file back, the facts and curated decisions included.
      whole("stopped part way through a rename's write");
      const f = changedPaths(s.before.facts, s.after.facts);
      const c = changedPaths(s.before.curated, s.after.curated);
      if (f.length || c.length)
        fail(
          "failure-neutrality",
          `a rename that stopped part way changed ${list([...f.map((p) => `facts/${p}`), ...c.map((p) => `catalog/curated/${p}`)])}`,
        );
      return;
    }
    if (s.crash?.first.crashed) {
      // Behind but whole (ADR point 2): each file the crash left is the bytes from before it or
      // those the build that caught up wrote, and the undo copy was taken first.
      const { mid } = s.crash;
      for (const p of new Set([...s.before.generated.keys(), ...mid.generated.keys()])) {
        const x = mid.generated.get(p);
        if (x !== s.before.generated.get(p) && x !== s.after.generated.get(p))
          fail(
            "failure-neutrality",
            `a crash part way through the write left catalog/generated/${p} neither as it was nor as the next build wrote it`,
          );
      }
      const wrote =
        !sameTree(s.before.generated, s.after.generated) ||
        !sameTree(s.before.sources, mid.sources);
      if (wrote && sameTree(s.before.undo, mid.undo))
        fail(
          "failure-neutrality",
          "a crash part way through a write left no undo copy taken before it",
        );
      return;
    }
    if (s.outcome.refused) return whole("refused");
    if (s.expect?.kind === "dry") return whole("was a dry run");
    if (s.expect?.kind === "neutral") return whole(`observed nothing (${b0.t})`);
    if (b0.t === "verify-write" && !b0.ok) return whole("had facts rejected");
    if (SCANS.has(b0.t) && s.outcome.wrote) {
      for (const slot of s.unobserved ?? []) {
        const ids = idsOf(s.m, slot);
        const touched = changedPaths(s.before.sources, s.after.sources).filter((p) =>
          [...ids].some((id) => p.split("/").pop()!.startsWith(`${id}.`)),
        );
        if (touched.length)
          fail(
            "failure-neutrality",
            `${s.m.repos[slot]!.id} wasn't read in full, yet its slot files changed: ${touched.join(", ")}`,
          );
      }
    }
  },

  "readers-never-destroy-facts"(s) {
    const b0 = base(s);
    if (!SCANS.has(b0.t)) return;
    const facts = changedPaths(s.before.sources, s.after.sources).filter((p) =>
      p.startsWith("facts/"),
    );
    if (facts.length)
      fail("readers-never-destroy-facts", `a scan changed facts slot files: ${facts.join(", ")}`);
    // The records' half: only when what changed since the last write is the readers of repos
    // that have facts (another repo's read may change a join, which is locality's to judge).
    const c = s.m.changes;
    if (c.curated.size || c.answered.size || [...c.slots].some((x) => !s.m.facts.has(x))) return;
    const b = records(s.before.generated);
    for (const r of s.m.live()) {
      if (!s.m.facts.has(r.slot)) continue;
      const ids = idsOf(s.m, r.slot);
      for (const [p, rec] of b) {
        const ev = rec.evidence ?? [];
        if (!ev.length || !ev.every((e) => e.by === "assistant" && e.repo && ids.has(e.repo)))
          continue;
        if (s.editsBefore.includes(p)) continue;
        if (s.after.generated.get(p) !== s.before.generated.get(p))
          fail(
            "readers-never-destroy-facts",
            `${r.id} has verified facts, yet ${s.desc.t} ${s.after.generated.has(p) ? "changed" : "removed"} ${rec.kind}/${rec.id}, projected from them`,
          );
      }
    }
  },

  "curation-survives"(s) {
    if (!builtOk(s) && !(s.desc.t === "undo" && s.outcome?.wrote)) return;
    const v = s.m.built ?? s.m;
    const a = records(s.after.generated);
    const byId = new Map([...a.values()].map((r) => [r.id, r]));
    const edited = new Set(s.m.handEdits.map((e) => e.id));
    for (const d of v.curated) {
      if (s.m.writes <= d.since || edited.has(d.target)) continue;
      const what = d.id ?? `the ${d.action} drafted from a hand edit of ${d.target}`;
      if (d.id && ![...s.after.curated.keys()].some((p) => p.endsWith(`/${d.id}.yaml`)))
        fail("curation-survives", `the curated decision ${d.id} was dropped from catalog/curated`);
      const rec = byId.get(d.target);
      if (d.action === "suppress" && rec && (d.kind !== "Endpoint" || v.serves(d)))
        fail("curation-survives", `${d.target} is suppressed by ${what}, yet ${s.desc.t} wrote it`);
      if (d.action === "assert" && rec && d.value && !Array.isArray(d.value))
        for (const [k, val] of Object.entries(d.value)) {
          // Two asserts of one field (a person's and a hand edit's): one of them holds.
          const asserted = v.curated
            .filter(
              (x) =>
                x.action === "assert" &&
                x.target === d.target &&
                !!x.value &&
                !Array.isArray(x.value) &&
                k in x.value,
            )
            .map((x) => (x.value as Record<string, unknown>)[k]);
          if (!asserted.includes(rec[k]))
            fail(
              "curation-survives",
              `${what} asserts ${k}: ${String(val)} on ${d.target}, yet after ${s.desc.t} it has ${String(rec[k])}`,
            );
        }
      if (d.action === "alias" && rec && Array.isArray(d.value))
        for (const folded of d.value)
          if (byId.has(folded))
            fail(
              "curation-survives",
              `${what} folds ${folded} into ${d.target}, yet after ${s.desc.t} both are in the catalog`,
            );
    }
  },

  "links-are-live"(s) {
    if (!builtOk(s) && !(s.desc.t === "undo" && s.outcome?.wrote)) return;
    const v = s.m.built ?? s.m;
    const allowed = v.allowedArrows();
    for (const r of records(s.after.generated).values()) {
      const k = arrowOf(v, r);
      if (k && !allowed.has(k))
        fail(
          "links-are-live",
          `after ${s.desc.t} the arrow ${r.id} (${k}) doesn't follow from the current observations: allowed ${list(allowed, 8)}`,
        );
    }
  },

  "nothing-removed-unexplained"(s) {
    if (!builtOk(s)) return;
    const o = s.outcome!;
    const gone = removedBy(s);
    const reported = new Map((o.removed ?? []).map((x) => [x.id, x.reason]));
    for (const [id, rec] of gone) {
      const why = explanations(s, rec);
      if (!why.size)
        fail(
          "nothing-removed-unexplained",
          `${s.desc.t} removed ${describe(id, rec)}, and no changed slot, input, manifest entry or curated decision explains it (changed: ${[...s.m.changes.slots].map((x) => s.m.repos[x]!.id).join(", ") || "none"})`,
        );
      const said = reported.get(id);
      if (!said)
        fail(
          "nothing-removed-unexplained",
          `${s.desc.t} removed ${describe(id, rec)} without listing it in its report (${o.removed ? `it listed ${list(reported.keys())}` : "it reports no removals"})`,
        );
      // The org pack migrated since (an upgrade's other steps) is an input every record rests
      // on: the build may name it, though the removal must still be one the model explains.
      if (!why.has(said!) && !(said === "input" && s.m.changes.orgPack))
        fail(
          "nothing-removed-unexplained",
          `${s.desc.t} reports ${id} removed by "${said}", but what changed is ${[...why].join(" or ")}`,
        );
    }
    const edited = new Set(s.handEditsBefore.map((e) => `${e.kind}/${e.id}`));
    const made = [...reported.keys()].filter((id) => !gone.has(id) && !edited.has(id));
    if (made.length)
      fail(
        "nothing-removed-unexplained",
        `${s.desc.t} reports removals it didn't make: ${list(made)}`,
      );
  },

  "large-removals-confirmed"(s) {
    if (!builtOk(s)) return;
    const gone = removedBy(s);
    const big = largeOf(s.before, gone, s.editsBefore);
    if (!big.length) return;
    const n = s.confirm?.allowRemovals;
    if (n === undefined)
      fail(
        "large-removals-confirmed",
        `${s.desc.t} removed ${big.join(", ")} without the removals being confirmed`,
      );
    const edited = editedGone(s);
    // Of the hand-edited records the build no longer makes, the refusal counts those whose
    // file is still there, changed: a file the person deleted is no removal of the build's (it
    // is already gone, and the discard confirms it), and a record the person added is none the
    // build made (seeds 1361807166, 1361868403).
    const changed = new Set(
      s.handEditsBefore
        .filter((e) => e.how === "change")
        .map((e) => `${e.kind}/${e.id}`)
        .filter((id) => edited.has(id)),
    );
    if (n !== gone.size && n !== gone.size + changed.size)
      fail(
        "large-removals-confirmed",
        `${s.desc.t} was confirmed with --allow-removals ${n}, yet removed ${gone.size} records${edited.size ? ` (and ${edited.size} edited by hand)` : ""}`,
      );
    // What the refusal listed is what a confirmation right after it removes. A listing other
    // commands acted after is confirmed by its count only (the CLI's flag names a count): the
    // command works its removals out again, and writes only when they are that many (above).
    const p = s.confirmOf;
    if (p && p.at !== s.w.steps - 1) return;
    const listed = new Set(p?.removals?.ids ?? []);
    const unlisted = [...gone.keys()].filter((id) => !listed.has(id));
    if (unlisted.length)
      fail(
        "large-removals-confirmed",
        `${s.desc.t} removed ${list(unlisted)}, which the refusal it confirmed never listed`,
      );
  },

  "upgrade-is-lossless"(s) {
    if (s.desc.t !== "upgrade") return;
    const same = (what: string, x: Map<string, string>, y: Map<string, string>) => {
      const d = changedPaths(x, y);
      if (d.length) fail("upgrade-is-lossless", `${what} changed: ${list(d, 5)}`);
    };
    if (!s.desc.yes || !s.modelBefore.beta26) {
      const what = s.desc.yes ? "an upgrade of a metarepo with nothing to adopt" : "a dry run";
      same(`${what}: catalog/generated`, s.before.generated, s.after.generated);
      same(`${what}: catalog/sources`, s.before.sources, s.after.sources);
      same(`${what}: facts`, s.before.facts, s.after.facts);
      same(`${what}: catalog/curated`, s.before.curated, s.after.curated);
      return;
    }
    if (!s.upgrade) return;
    const up = s.upgrade.after;
    const held = new Map<string, string[]>();
    for (const [p, text] of up.sources) {
      if (!/^(?:readers\/[^/]+\.json|legacy\/joins\.json)$/.test(p)) continue;
      let slot: { status?: string; records?: { kind: string; id: string }[] };
      try {
        slot = JSON.parse(text) as typeof slot;
      } catch {
        return fail("upgrade-is-lossless", `catalog/sources/${p} isn't JSON`);
      }
      if (slot.status !== "legacy") continue;
      for (const r of slot.records ?? []) held.set(recId(r), [...(held.get(recId(r)) ?? []), p]);
    }
    for (const r of records(s.before.generated).values()) {
      const at = held.get(recId(r)) ?? [];
      if (at.length !== 1)
        fail(
          "upgrade-is-lossless",
          `${recId(r)} is in ${at.length} legacy slots after atticus upgrade --yes, not exactly one`,
        );
      const repos = [...repoOf(r)];
      // A cross-repo arrow (its two ends in different repos) is a joined Interface whatever its
      // evidence names, an arrow inferred from a call's host included: it goes to joins.json, so
      // it stays until derived again (ADR 0195 point 6, "A cross-repo arrow from before the
      // upgrade is therefore never dropped because the build cannot derive it yet").
      const a = r.kind === "Interface" ? s.modelBefore.slotOfEnd(String(r.from)) : undefined;
      const b = r.kind === "Interface" ? s.modelBefore.slotOfEnd(String(r.to)) : undefined;
      const crossRepo = !!a && !!b && a.slot !== b.slot;
      const want =
        !crossRepo && repos.length === 1 ? `readers/${repos[0]}.json` : "legacy/joins.json";
      if (at[0] !== want)
        fail(
          "upgrade-is-lossless",
          `${recId(r)}, ${crossRepo ? "a cross-repo arrow" : `with evidence from ${repos.join(", ") || "no repo"}`}, is in ${at[0]}, not ${want}`,
        );
    }
    const copy = new Map(
      [...up.sources]
        .filter(([p]) => p.startsWith("legacy/generated-before-upgrade/"))
        .map(([p, t]) => [p.slice("legacy/generated-before-upgrade/".length), t]),
    );
    same("legacy/generated-before-upgrade/ against the catalog before", s.before.generated, copy);
    same("atticus upgrade --yes: catalog/generated", s.before.generated, up.generated);
    if (!s.upgrade.build?.wrote)
      fail(
        "upgrade-is-lossless",
        `the first build after the upgrade didn't write: ${s.upgrade.build?.err.join(" ") ?? ""}`,
      );
    same(
      "the first build after the upgrade: catalog/generated",
      s.before.generated,
      s.after.generated,
    );
  },

  "undo-restores"(s) {
    // Checked whatever the outcome: an undo that refused or is missing restores nothing.
    if (s.desc.t !== "undo" || !s.undo) return;
    for (const k of ["generated", "sources"] as const) {
      const d = changedPaths(s.undo.before[k], s.undo.afterUndo[k]);
      if (d.length)
        fail(
          "undo-restores",
          `atticus catalog undo ${s.desc.n ?? ""} left catalog/${k} unlike before the writes it took back: ${list(d, 5)}`,
        );
      if (!s.undo.backOutcome?.wrote) continue;
      const e = changedPaths(s.undo.after[k], s.after[k]);
      if (e.length)
        fail(
          "undo-restores",
          `undoing the undo left catalog/${k} unlike after the write: ${list(e, 5)}`,
        );
    }
  },

  "hand-edits-never-silently-lost"(s) {
    if (!s.editsBefore.length || !s.outcome) return;
    if (s.confirm?.discardEdits === s.editsBefore.length && s.outcome.wrote) {
      // A confirmed discard: each discarded file's bytes are in the undo copy first.
      const kept = [...s.after.undo.values(), ...s.before.undo.values()];
      for (const p of s.editsBefore) {
        const text = s.before.generated.get(p);
        if (text !== undefined && !kept.some((k) => k === text || k.includes(text)))
          fail(
            "hand-edits-never-silently-lost",
            `the discarded edit of ${p} isn't in the undo copy`,
          );
      }
      return;
    }
    if (s.desc.t === "curate-edits" && s.pre?.wrote) return;
    const d = [
      ...changedPaths(s.before.generated, s.after.generated).map((p) => `catalog/generated/${p}`),
      ...(s.desc.t === "prune"
        ? []
        : changedPaths(s.before.sources, s.after.sources).map((p) => `catalog/sources/${p}`)),
    ];
    if (d.length)
      fail(
        "hand-edits-never-silently-lost",
        `${s.editsBefore.join(", ")} ${s.editsBefore.length === 1 ? "was" : "were"} edited by hand, not made curated nor discarded, yet ${s.desc.t} wrote ${list(d, 5)}`,
      );
  },

  completeness(s) {
    const o = s.outcome;
    const e = s.expect;
    if (!o || !e) return;
    const t = s.desc.t;
    if (o.unsupported) fail("completeness", `${t}: ${o.err[0] ?? "unsupported"}`);
    const said = () => (o.err.length ? ` (${o.err.slice(0, 2).join(" ")})` : "");
    if (e.kind === "succeed" && !o.wrote) {
      if (s.crash && !o.crashed && !o.refused)
        fail("completeness", `${t} neither crashed where asked nor refused${said()}`);
      // A metarepo not upgraded (an undo took the upgrade back): every writer refuses until
      // `atticus upgrade --yes` runs again. Only then, and never for the upgrade itself, nor for
      // an undo: point 7, "an undo can itself be undone", so the undo that took the upgrade back
      // is taken back by `catalog undo`, not refused as not upgraded.
      const notUpgraded = o.refused && o.guard === "not-upgraded" && notUpgradedMay(s);
      if (o.guard === "not-upgraded" && !notUpgraded)
        fail(
          "completeness",
          `${t} refused as not upgraded, but ${t === "undo" ? "an undo is never refused so (it can itself be undone)" : `the metarepo ${s.modelBefore.beta26 ? "is being upgraded" : "is upgraded"}`}${said()}`,
        );
      const why = notUpgraded ? undefined : unjustified(s);
      if (why)
        fail(
          "completeness",
          `${t} didn't succeed: ${o.refused ? `refused${o.guard ? ` (${o.guard})` : ""}` : "nor refused"}, and ${why}${said()}`,
        );
    }
    if (e.kind === "refuse") {
      if (!o.refused)
        fail(
          "completeness",
          `${t} should have refused${e.guard ? ` (${e.guard})` : ""}, yet ${o.wrote ? "succeeded" : "didn't say it refused"}`,
        );
      if (e.guard && o.guard !== e.guard) {
        // Another guard may come first: hand edits, or a large removal, each as listed.
        const first =
          o.guard === "hand-edits" || (o.guard === "large-removals" && e.guard !== "nothing-read");
        // Not upgraded comes before every other guard, and is right only then.
        const why =
          o.guard === "not-upgraded"
            ? notUpgradedMay(s)
              ? undefined
              : t === "undo"
                ? "an undo is never refused as not upgraded"
                : "the metarepo is upgraded"
            : first
              ? unjustified(s)
              : `it refused for ${o.guard ?? "no guard"}`;
        if (why)
          fail("completeness", `${t} should have refused for ${e.guard}, and ${why}${said()}`);
      }
    }
    if (e.kind === "dry" && o.refused && (o.guard !== "hand-edits" || unjustified(s)))
      fail("completeness", `${t}, a dry run, refused${said()}`);
    if (s.pre && !s.pre.wrote)
      fail("completeness", `atticus catalog edits --curate didn't write${said()}`);
    if (s.undo?.back && o.wrote && !s.undo.backOutcome?.wrote)
      fail(
        "completeness",
        `undoing the undo didn't write: ${s.undo.backOutcome?.err.join(" ") ?? ""}`,
      );
    if (t === "prune" && !(o.refused && !unjustified(s))) {
      if (!o.pruned || !sameList(o.pruned, s.prunable ?? []))
        fail(
          "completeness",
          `prune listed ${o.pruned ? list(o.pruned) : "nothing"}, not the orphaned and archived repos' slots and the upgrade's copy: ${list(s.prunable ?? [])}`,
        );
      if (o.wrote && s.desc.yes) {
        const left = new Map([...s.before.sources].filter(([p]) => !s.prunable!.includes(p)));
        const d = [
          ...changedPaths(left, s.after.sources).map((p) => `catalog/sources/${p}`),
          ...changedPaths(s.before.generated, s.after.generated).map(
            (p) => `catalog/generated/${p}`,
          ),
        ];
        if (d.length)
          fail("completeness", `prune --yes changed more or less than it listed: ${list(d)}`);
      }
    }
    // A confirmed large removal: what it removed was listed, and was above the limits.
    const p = s.confirmOf;
    if (o.wrote && p?.removals && s.confirm?.allowRemovals === p.removals.count) {
      const gone = removedBy(s);
      const fresh = p.at === s.w.steps - 1;
      const edited = editedGone(s);
      const listed = p.removals.ids.filter((id) => !edited.has(id));
      if (fresh && !sameList(gone.keys(), listed))
        fail(
          "completeness",
          `confirmed right after its listing, ${t} removed ${list(gone.keys())}, not what it listed: ${list(p.removals.ids)}`,
        );
      if (fresh && !edited.size && !largeOf(s.before, gone, s.editsBefore).length)
        fail(
          "completeness",
          `${t} refused ${gone.size} removals as large, but they are under the limits`,
        );
    }
    content(s);
  },
};

/**
 * The catalog holds what the model says a build makes, for what the model derives: one REST
 * Endpoint per endpoint each repo's source serves (no more), each repo's own Component, and
 * every cross-repo arrow that must exist (links-are-live checks none is extra). Files edited by
 * hand are the person's, and are left out, as are those made curated whose build hasn't written.
 */
function content(s: Step): void {
  const v = s.m.built;
  if (!v || s.m.beta26) return;
  // A hand edit made curated whose build was refused is still on disk, the person's, until a
  // build writes (ADR 0195 point 4: a refusal writes nothing).
  const edits = [...s.m.handEdits, ...s.m.curatedPending];
  const skipPaths = new Set(edits.map((e) => e.path));
  const skip = new Set(
    edits.flatMap((e) => [e.id, ...(e.key ? [e.key] : []), ...(e.arrow ? [e.arrow] : [])]),
  );
  const recs = [...records(s.after.generated)].filter(([p]) => !skipPaths.has(p)).map(([, r]) => r);
  const where = `after ${s.desc.t}${s.inner ? ` (${s.inner.t})` : ""}`;
  const diff = (what: string, want: Set<string>, have: Set<string>, exact: boolean) => {
    const missing = [...want].filter((k) => !have.has(k) && !skip.has(k));
    const extra = exact ? [...have].filter((k) => !want.has(k)) : [];
    if (missing.length || extra.length)
      fail(
        "completeness",
        `${where} the catalog's ${what} aren't what the model says the build makes: ${[
          ...(missing.length ? [`missing ${list(missing)}`] : []),
          ...(extra.length ? [`not expected ${list(extra)}`] : []),
        ].join("; ")}`,
      );
  };
  diff(
    "REST endpoints",
    v.endpoints(),
    new Set(
      recs
        .filter((r) => r.kind === "Endpoint" && r.endpointType === "rest")
        .map((r) => endpointKey(String(r.component), String(r.method), String(r.pathOrTopic))),
    ),
    true,
  );
  // A repo's own Component, inferred only when another repo calls it: never one without a source.
  const own = new Set(v.repos.map((r) => r.base.component));
  const comps = v.components();
  diff(
    "repos' own components",
    comps,
    new Set(
      recs
        .filter((r) => r.kind === "Component" && own.has(r.id))
        .filter((r) => r.confidence !== "inferred" || comps.has(r.id))
        .map((r) => r.id),
    ),
    true,
  );
  diff(
    "cross-repo arrows",
    v.arrows().required,
    new Set(recs.flatMap((r) => arrowOf(v, r) ?? [])),
    false,
  );
}

/** Run the per-command checks of the invariants asked for. */
export function checkStep(s: Step, enabled: ReadonlySet<Invariant>): void {
  for (const inv of INVARIANTS) if (enabled.has(inv)) CHECKS[inv]?.(s);
}

/**
 * The end of a sequence: what is pending is settled (hand edits discarded with their count,
 * removals confirmed with theirs, then a build, and its own refusal confirmed the same way),
 * each through the commands so every check
 * runs on it. Then the master oracle: the catalog must be byte-identical to a build without the
 * build cache, and to a full build of a fresh metarepo given only the final slots and inputs.
 */
export async function settleAndCompare(ctx: Ctx, run: (d: Desc) => Promise<void>): Promise<void> {
  const { m, w } = ctx;
  // A refusal listing removals is confirmed with its count (and whatever else it ran with); hand
  // edits are discarded with theirs. Each confirmation may meet the next guard, so a few rounds.
  // A confirmation that met the hand-edits guard keeps its count; once another command took the
  // edits (made them curated), the refused command still waits for that confirmation, run again
  // (seed 1344785347: a scan refused, confirmed into the hand-edits guard, the edit curated).
  // The settling build is a command like any other: when it meets a guard itself, its refusal is
  // confirmed the same way (seed 1351551411: a rename undone leaves its slot under the old id,
  // which the manifests no longer list, so the build lists the repo's records as removals above
  // the limit; ADR 0195 point 7 and the joint review: undo puts back the slots, not the inputs).
  // A refused command that no longer runs has nothing left to confirm: a refusal writes nothing
  // (point 4), and its repo has since been archived or removed, so the person can't run it again
  // and its listing is moot (seed 1754877814: verify --write of payments refused for a removal,
  // then payments archived). The build of the rest settles.
  let built = m.beta26;
  for (let i = 0; i < 8; i++) {
    const p = w.pending;
    const steps = w.steps;
    if (p?.removals && (p.confirm.allowRemovals !== p.removals.count || !m.handEdits.length))
      await run({ t: "confirm-removals" });
    else if (m.handEdits.length) await run({ t: "discard-edits" });
    else if (!built) {
      built = true;
      await run({ t: "build" });
    } else break;
    if (p && w.steps === steps && w.pending === p) w.pending = undefined;
  }
  if (!ctx.enabled.has("equivalence") || m.beta26) return;
  // The empty-catalog guard has no confirmation (ADR point 4): a metarepo whose build would hold
  // nothing keeps its catalog, which no fresh build gives. Completeness judged the refusal.
  if (w.lastOutcome?.refused && w.lastOutcome.guard === "empty-catalog") return;
  if (m.handEdits.length || w.pending)
    fail(
      "equivalence",
      `the sequence couldn't be settled: ${m.handEdits.length ? `${m.handEdits.length} hand edits not discarded with their count` : `a refusal (${w.pending!.desc.t}) not confirmed with its count`}`,
    );
  const here = await readTree(join(w.root, "catalog", "generated"));
  // ADR point 9: the build cache is never needed for a correct result.
  await rm(join(w.root, ".index", "build-cache"), { recursive: true, force: true });
  const cold = await sut().build(w.root, {});
  if (!cold.unsupported) {
    const d = changedPaths(here, await readTree(join(w.root, "catalog", "generated")));
    if (d.length) fail("equivalence", `a build without the build cache changed ${list(d)}`);
  }
  const top = await mkdtemp(join(tmpdir(), "cs4-fresh-"));
  try {
    const fresh = join(top, "metarepo");
    await sut().freshBuild(w.root, fresh, m);
    const there = await readTree(join(fresh, "catalog", "generated"));
    if (!sameTree(here, there)) {
      const d = changedPaths(here, there);
      const a = records(here);
      const b = records(there);
      fail(
        "equivalence",
        `the catalog differs from a fresh build of the final observations in ${d.length} files: ${d
          .slice(0, 6)
          .map(
            (p) =>
              `${here.has(p) ? (there.has(p) ? "~" : "-") : "+"} ${describe(p, a.get(p) ?? b.get(p))}`,
          )
          .join("; ")}`,
      );
    }
  } finally {
    await rm(top, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
