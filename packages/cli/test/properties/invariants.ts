import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SYSTEM, type Outcome } from "./system.js";
import type { Model } from "./model.js";
import {
  changedPaths,
  readTree,
  records,
  repoOf,
  sameTree,
  type Rec,
  type Snap,
  type World,
} from "./world.js";
import type { Desc } from "./commands.js";

/** The twelve invariants of ADR 0195 point 10, and the large-removal guard it also tests. */
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
] as const;
export type Invariant = (typeof INVARIANTS)[number];

/**
 * The invariants today's writers (beta.26) break: the baseline CS4 records. Each has its shrunk
 * counterexample in regressions/<invariant>.json, run as a known failure (`it.fails`); the
 * examples that fail today are listed in examples.ts. CS2 turns them green and takes them off; a
 * known failure that starts passing fails its test, so the list can't go stale.
 */
export const KNOWN_FAILURES: ReadonlySet<Invariant> = new Set<Invariant>([
  // A scan with one repo not cloned writes nothing (beta.26's stop), so the others' reads are lost.
  "equivalence",
  // The same: a later scan brings in a repo read earlier, which no change of this command explains.
  "locality",
  // verify --write of two repos, in either order, gives different Component and System records.
  "order-independence",
  // A scan after verify --write joins the facts' loose end with another repo's readers.
  "readers-never-destroy-facts",
  // A rename rewrites record files without applying the curated decisions.
  "curation-survives",
  // verify --write joins with another repo's facts that verify checked but nothing wrote.
  "links-are-live",
  // The scan reads facts verify checked but didn't write, and its records replace the readers'.
  "nothing-removed-unexplained",
  // There are no slots: atticus upgrade adopts nothing.
  "upgrade-is-lossless",
  // There is no atticus catalog undo.
  "undo-restores",
  // The next scan rewrites a hand-edited file.
  "hand-edits-never-silently-lost",
  // verify --write replaces a repo's readers records with its facts' and confirms nothing.
  "large-removals-confirmed",
]);

/** What one command did, for the checks. */
export interface Step {
  desc: Desc;
  m: Model;
  w: World;
  before: Snap;
  after: Snap;
  outcome?: Outcome;
  /** For a scan: the slots the ADR says it observed in full, and those it couldn't. */
  observed?: number[];
  unobserved?: number[];
  /** The hand edits not yet made curated or discarded when the command started. */
  editsBefore: string[];
  /** For undo: the files after the first undo, before it was undone. */
  afterUndo?: Snap;
  /** For undo: the last write's before and after. */
  lastWrite?: { before: Snap; after: Snap };
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

/** Commands that run a writer, so may write the catalog. */
const WRITERS = new Set<Desc["t"]>([
  "scan",
  "scan-subset",
  "scan-not-cloned",
  "scan-reader-fails",
  "verify-write",
  "rename",
  "again",
  "confirm-removals",
  "curate",
  "uncurate",
  "answer",
  "archive",
  "remove",
]);
const SCANS = new Set<Desc["t"]>(["scan", "scan-subset", "scan-not-cloned", "scan-reader-fails"]);

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

/** The kinds a join makes or unmakes in a partner's own records: its loose ends and features. */
const JOINED = new Set(["Unresolved", "Capability"]);

const unchangedSince = (a: Map<string, string>, b: Map<string, string>, skip: string[]) =>
  changedPaths(a, b).filter((p) => !skip.includes(p));

/** The checks run after each command, by invariant (equivalence and order run at the end). */
export const CHECKS: Partial<Record<Invariant, (s: Step) => void>> = {
  locality(s) {
    if (!s.outcome?.wrote || !(SCANS.has(s.desc.t) || s.desc.t === "verify-write")) return;
    // The first catalog written makes every record (the org pack's systems too): nothing to compare.
    if (!s.before.generated.size) return;
    const c = s.m.changes;
    if (c.slots.size > 1 || c.curated.size || c.answered.size) return;
    const b = records(s.before.generated);
    const a = records(s.after.generated);
    const reach = [...c.slots].flatMap((x) => partners(s.m, x));
    const ok = (r: Rec | undefined) =>
      involves(s.m, c.slots, r) || (!!r && JOINED.has(r.kind) && involves(s.m, reach, r));
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
      fail("idempotence", `running the same writer again changed ${[...g, ...x].join(", ")}`);
  },

  "failure-neutrality"(s) {
    const whole = () => {
      const g = changedPaths(s.before.generated, s.after.generated);
      const x = changedPaths(s.before.sources, s.after.sources);
      if (g.length || x.length)
        fail(
          "failure-neutrality",
          `${s.desc.t} observed nothing, yet changed ${[...g.map((p) => `catalog/generated/${p}`), ...x.map((p) => `catalog/sources/${p}`)].join(", ")}`,
        );
    };
    if (s.desc.t === "verify-write" && !s.desc.ok) return whole();
    if (s.outcome?.refused) return whole();
    if (SCANS.has(s.desc.t)) {
      if (!s.observed?.length) return whole();
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
    if (!SCANS.has(s.desc.t)) return;
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
    if (!s.outcome?.wrote) return;
    const a = records(s.after.generated);
    const byId = new Map([...a.values()].map((r) => [r.id, r]));
    for (const d of s.m.curated) {
      if (s.m.writes <= d.since) continue;
      if (![...s.after.curated.keys()].some((p) => p.endsWith(`${d.id}.yaml`)))
        fail("curation-survives", `the curated decision ${d.id} was dropped from catalog/curated`);
      const rec = byId.get(d.target);
      if (d.action === "suppress" && s.m.built(d) && rec)
        fail(
          "curation-survives",
          `${d.target} is suppressed by ${d.id} and its repo still serves it, yet ${s.desc.t} wrote it`,
        );
      if (d.action === "assert" && rec && rec.auth !== "oauth2")
        fail(
          "curation-survives",
          `${d.id} asserts auth: oauth2 on ${d.target}, yet after ${s.desc.t} it has ${String(rec.auth)}`,
        );
    }
  },

  "links-are-live"(s) {
    if (!s.outcome?.wrote) return;
    const allowed = s.m.allowedArrows();
    for (const r of records(s.after.generated).values()) {
      if (r.kind !== "Interface") continue;
      const from = s.m.slotOfEnd(String(r.from));
      const to = s.m.slotOfEnd(String(r.to));
      if (!from || !to || from.slot === to.slot) continue;
      const k = `${from.base.component}|${to.base.component}|${r.method ?? "EVENT"}|${String(r.normalizedPath)}`;
      if (!allowed.has(k))
        fail(
          "links-are-live",
          `after ${s.desc.t} the arrow ${r.id} (${k}) doesn't follow from the current observations: allowed ${[...allowed].join(", ") || "none"}`,
        );
    }
  },

  "nothing-removed-unexplained"(s) {
    if (!s.outcome?.wrote) return;
    const b = records(s.before.generated);
    const c = s.m.changes;
    const callersOfAnswered = s.m.repos
      .filter((r) =>
        [r.code, s.m.readers.get(r.slot)?.code, s.m.facts.get(r.slot)?.code].some((code) =>
          code?.calls.some((x) => c.answered.has(x.host)),
        ),
      )
      .map((r) => r.slot);
    for (const [p, rec] of b) {
      if (s.after.generated.has(p) || s.editsBefore.includes(p)) continue;
      if (involves(s.m, c.slots, rec) || c.curated.has(rec.id)) continue;
      const reach = [...c.slots].flatMap((x) => partners(s.m, x));
      if (JOINED.has(rec.kind) && involves(s.m, reach, rec)) continue;
      if (involves(s.m, callersOfAnswered, rec)) continue;
      fail(
        "nothing-removed-unexplained",
        `${s.desc.t} removed ${describe(p, rec)}, and no changed slot, input, manifest entry or curated decision explains it (changed: ${[...c.slots].map((x) => s.m.repos[x]!.id).join(", ") || "none"})`,
      );
    }
  },

  "large-removals-confirmed"(s) {
    if (!s.outcome?.wrote || s.desc.t === "confirm-removals") return;
    const b = records(s.before.generated);
    const per = new Map<string, { had: number; gone: number }>();
    let gone = 0;
    for (const [p, rec] of b) {
      const removed = !s.after.generated.has(p) && !s.editsBefore.includes(p);
      if (removed) gone++;
      for (const repo of repoOf(rec)) {
        const x = per.get(repo) ?? { had: 0, gone: 0 };
        x.had++;
        if (removed) x.gone++;
        per.set(repo, x);
      }
    }
    const big = [...per].filter(([, x]) => x.gone > 0 && x.gone > x.had * 0.1);
    if (big.length || gone > 200)
      fail(
        "large-removals-confirmed",
        `${s.desc.t} removed ${big.map(([r, x]) => `${x.gone} of ${r}'s ${x.had} records`).join(", ") || `${gone} records`} without the removals being confirmed`,
      );
  },

  "upgrade-is-lossless"(s) {
    if (s.desc.t !== "upgrade") return;
    const fresh = s.before.sources.size === 0 && s.before.generated.size > 0;
    const same = (what: string, x: Map<string, string>, y: Map<string, string>) => {
      const d = changedPaths(x, y);
      if (d.length) fail("upgrade-is-lossless", `${what} changed: ${d.slice(0, 5).join(", ")}`);
    };
    if (!s.desc.yes || !fresh) {
      same(
        `a ${s.desc.yes ? "second upgrade" : "dry run"}: catalog/generated`,
        s.before.generated,
        s.after.generated,
      );
      same("catalog/sources", s.before.sources, s.after.sources);
      same("facts", s.before.facts, s.after.facts);
      same("catalog/curated", s.before.curated, s.after.curated);
      return;
    }
    const held = new Map<string, number>();
    for (const [p, text] of s.after.sources) {
      if (!/^(readers\/[^/]+\.json|legacy\/joins\.json)$/.test(p)) continue;
      let slot: { status?: string; records?: { kind: string; id: string }[] };
      try {
        slot = JSON.parse(text) as typeof slot;
      } catch {
        fail("upgrade-is-lossless", `catalog/sources/${p} isn't JSON`);
        return;
      }
      if (slot.status !== "legacy") continue;
      for (const r of slot.records ?? [])
        held.set(`${r.kind}/${r.id}`, (held.get(`${r.kind}/${r.id}`) ?? 0) + 1);
    }
    for (const r of records(s.before.generated).values()) {
      const n = held.get(`${r.kind}/${r.id}`) ?? 0;
      if (n !== 1)
        fail(
          "upgrade-is-lossless",
          `${r.kind}/${r.id} is in ${n} legacy slots after atticus upgrade --yes, not exactly one`,
        );
    }
    const copy = new Map(
      [...s.after.sources]
        .filter(([p]) => p.startsWith("legacy/generated-before-upgrade/"))
        .map(([p, t]) => [p.slice("legacy/generated-before-upgrade/".length), t]),
    );
    same("legacy/generated-before-upgrade/ against the catalog before", s.before.generated, copy);
    same(
      "the first build after the upgrade: catalog/generated",
      s.before.generated,
      s.after.generated,
    );
  },

  "undo-restores"(s) {
    if (s.desc.t !== "undo" || !s.lastWrite || !s.afterUndo) return;
    for (const k of ["generated", "sources"] as const) {
      const d = changedPaths(s.lastWrite.before[k], s.afterUndo[k]);
      if (d.length)
        fail(
          "undo-restores",
          `atticus catalog undo left catalog/${k} unlike before the last write: ${d.slice(0, 5).join(", ")}${s.outcome?.unsupported ? ` (${s.outcome.err[0]})` : ""}`,
        );
      const e = changedPaths(s.lastWrite.after[k], s.after[k]);
      if (e.length)
        fail(
          "undo-restores",
          `undoing the undo left catalog/${k} unlike after the write: ${e.slice(0, 5).join(", ")}`,
        );
    }
  },

  "hand-edits-never-silently-lost"(s) {
    if (!s.editsBefore.length) return;
    if (s.desc.t === "discard-edits") {
      if (!s.outcome?.wrote) return;
      const kept = new Set(s.before.undo.values());
      for (const p of s.editsBefore) {
        const text = s.before.generated.get(p);
        if (text !== undefined && ![...s.after.undo.values()].includes(text) && !kept.has(text))
          fail(
            "hand-edits-never-silently-lost",
            `the discarded edit of ${p} isn't in the undo copy`,
          );
      }
      return;
    }
    if (!WRITERS.has(s.desc.t) && s.desc.t !== "upgrade") return;
    const d = changedPaths(s.before.generated, s.after.generated);
    if (d.length)
      fail(
        "hand-edits-never-silently-lost",
        `${s.editsBefore.join(", ")} ${s.editsBefore.length === 1 ? "was" : "were"} edited by hand, not made curated nor discarded, yet ${s.desc.t} wrote ${d.slice(0, 5).join(", ")}`,
      );
  },
};

/** Run the per-command checks of the invariants asked for. */
export function checkStep(s: Step, enabled: ReadonlySet<Invariant>): void {
  for (const inv of INVARIANTS) if (enabled.has(inv)) CHECKS[inv]?.(s);
}

/**
 * The master oracle, at the end of a sequence: what is pending is settled (hand edits
 * discarded, removals confirmed, a build), then the catalog must be byte-identical to a full
 * build of a fresh metarepo given only the final slots and inputs.
 */
export async function checkEquivalence(w: World): Promise<void> {
  const m = w.model;
  if (m.handEdits.length) {
    const r = await SYSTEM.discardEdits(w.root, m.handEdits.length);
    if (r.wrote) m.handEdits = [];
  }
  await SYSTEM.confirmRemovals(w.root);
  await SYSTEM.build(w.root);
  const here = await readTree(join(w.root, "catalog", "generated"));
  const top = await mkdtemp(join(tmpdir(), "cs4-fresh-"));
  try {
    const fresh = join(top, "metarepo");
    await SYSTEM.freshBuild(w.root, fresh, m);
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
