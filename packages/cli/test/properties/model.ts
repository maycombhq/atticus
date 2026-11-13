import { served, type Base, type Code, type Estate, type ManifestRepo } from "./estate.js";

/**
 * The model of ADR 0195 point 10: small, and not a copy of the system. Per repo (by slot, so a
 * rename keeps it) what the person's estate is now (its code and commit, whether the manifests
 * list it, whether it is archived), and the observations the ADR keeps: the readers' last full
 * read, the facts of the last `verify --write` that succeeded, and what `atticus upgrade`
 * adopted (legacy readers slots and legacy joins). On top: the curated decisions, the answers,
 * the hand edits not yet made curated or discarded, and what changed since the last write (what
 * explains a removal). From these, plain rules say which repo has which source, which records a
 * build must make, and which cross-repo arrows may and must exist.
 *
 * A command whose build a guard refused changes no observation: its update is applied only when
 * a confirmation of it succeeds. `built` is the model as of the last write that succeeded, which
 * is what the catalog on disk must agree with; an input a person changed since (a curated file,
 * an answer, the manifest) is in the model at once and in `built` once a build takes it.
 */

export interface Observation {
  code: Code;
  commit: string;
  /** The repo's id when it was observed: the slot file's name. */
  id: string;
  /** A readers slot `atticus upgrade` adopted (status legacy): the old catalog's records. */
  legacy?: boolean;
}

export interface RepoState {
  slot: number;
  base: Base;
  id: string;
  code: Code;
  commit: string;
  /** Commits made so far (the next one's number). */
  commits: number;
  listed: boolean;
  archived: boolean;
  /** The hosts the manifest lists for it: its own, plus any a person's answer added. */
  hosts: string[];
}

/** A curated decision, the person's (a file the harness wrote) or drafted from a hand edit. */
export interface Decision {
  /** The curated file's id, when the harness wrote it. */
  id?: string;
  action: "suppress" | "assert" | "alias";
  /** The record id it targets. */
  target: string;
  /** The target's kind. */
  kind: string;
  /** An Endpoint target's `component method path`: how the model knows it is built. */
  key?: string;
  /** An Interface target's cross-repo arrow, `from|to|method|path` (a hand deletion made curated). */
  arrow?: string;
  /** An assert's fields; an alias's folded record ids. */
  value?: Record<string, unknown> | string[];
  /** The write count when it was added: its effect is checked after a later write. */
  since: number;
  from: "person" | "edits";
  // No `added`: a record a person added by hand is never made a curated decision (ADR 0195
  // addendum, CS2: "an added record can't be a curated decision (one changes or suppresses a
  // record the build makes) and is said"); it stays a hand edit until it is discarded.
}

/** A file under catalog/generated/ a person changed, deleted or added by hand. */
export interface HandEdit {
  path: string;
  how: "change" | "delete" | "add";
  kind: string;
  id: string;
  /** An Endpoint's `component method path`. */
  key?: string;
  /** An Interface's arrow, `from|to|method|path`. */
  arrow?: string;
  /** A changed record's new field values. */
  value?: Record<string, unknown>;
}

/**
 * A record `atticus upgrade` adopted into legacy/joins.json: a cross-repo Interface (an arrow,
 * with its ends), or any other record with evidence from several repos or none (a feature or a
 * glossary term traced through several repos, an Interface whose evidence names two, a system).
 */
export interface LegacyJoin {
  kind: string;
  id: string;
  /** A cross-repo arrow: `from|to|method|path`, as `arrowKey` makes it, and its ends' slots. */
  arrow?: { key: string; from: number; to: number };
  /** The slots of the repos its evidence names (none for a record with no evidence). */
  repos: number[];
  /**
   * An arrow that cites no code line at its caller's end (a beta.26 write took it off): no file
   * to check a read reached, so only a complete read of the caller tells it is gone.
   */
  lineless?: true;
}

/** What changed since the last write: what may explain a record leaving the catalog. */
export interface Changes {
  /** Slots whose observation, listing or id changed. */
  slots: Set<number>;
  /** Record ids a curated decision added or removed since (an alias's folded ids too). */
  curated: Set<string>;
  /** Hosts a person answered since. */
  answered: Set<string>;
  /**
   * `atticus upgrade` migrated the org pack's files since (this harness writes them at schema 1):
   * an input every record rests on, so a build may name it ("input") for a removal that the
   * model explains otherwise (seed 1349124163).
   */
  orgPack?: true;
}

export const noChanges = (): Changes => ({
  slots: new Set(),
  curated: new Set(),
  answered: new Set(),
});

export const endpointKey = (component: string, method: string, path: string) =>
  `${component} ${method} ${path}`;

export const arrowKey = (from: string, to: string, method: string, path: string) =>
  `${from}|${to}|${method}|${path}`;

/** Kinds the whole-catalog passes derive from every repo's records (features, terms). */
const WHOLE_CATALOG: ReadonlySet<string> = new Set(["Capability", "GlossaryTerm"]);

export class Model {
  repos: RepoState[];
  readers = new Map<number, Observation>();
  facts = new Map<number, Observation>();
  curated: Decision[] = [];
  /** Host → slot a person said answers on it, or "none". */
  answers = new Map<string, number | "none">();
  /** Generated files edited by hand and not yet made curated or discarded. */
  handEdits: HandEdit[] = [];
  /**
   * Hand edits made curated whose build hasn't written yet (it was refused, by the large-removal
   * guard say): the files are still the person's on disk, and the curated decision waits for a
   * build. ADR 0195 point 4: a refusal writes nothing. Cleared by the next write.
   */
  curatedPending: HandEdit[] = [];
  /** Successful writes so far. */
  writes = 0;
  changes: Changes = noChanges();
  /** The metarepo holds a beta.26 catalog (catalog/generated/, no catalog/sources/): upgrade adopts it. */
  beta26 = false;
  legacyJoins: LegacyJoin[] = [];
  /** Every code each repo has had, at any commit: what a join with it may ever have used. */
  history = new Map<number, Code[]>();
  /** The model as of the last write that succeeded (none yet: the empty catalog). */
  built: Model | undefined;

  constructor(estate: Estate, commits: string[]) {
    this.repos = estate.repos.map((r, slot) => ({
      slot,
      base: r.base,
      id: r.base.id,
      code: r.code,
      commit: commits[slot]!,
      commits: 1,
      listed: true,
      archived: false,
      hosts: [r.base.host],
    }));
    for (const r of this.repos) this.history.set(r.slot, [r.code]);
  }

  /** The repos a build reads: listed and not archived. */
  live(): RepoState[] {
    return this.repos.filter((r) => r.listed && !r.archived);
  }

  isLive(slot: number): boolean {
    const r = this.repos[slot];
    return !!r && r.listed && !r.archived;
  }

  slotOfComponent(component: string): RepoState | undefined {
    return this.repos.find((r) => r.base.component === component);
  }

  /**
   * The repo an arrow's end names: its component, or the system of a repo the build reads (an
   * arrow to a host's system). A system whose repo left the manifests or was archived is still
   * the profile's, an input of its own, so an arrow to it is not an arrow to that repo.
   */
  slotOfEnd(ref: string): RepoState | undefined {
    return this.repos.find(
      (r) => r.base.component === ref || (r.base.system === ref && r.listed && !r.archived),
    );
  }

  /**
   * ADR 0195 point 2.1: the facts slot when there is one, else the readers slot (a full read or
   * the upgrade's legacy one), else none. A slot is the repo's when it is under the repo's id:
   * a slot left under an old id (an undone rename) is orphaned.
   */
  source(slot: number): { from: "facts" | "readers" | "legacy"; obs: Observation } | undefined {
    const r = this.repos[slot]!;
    if (!r.listed || r.archived) return undefined;
    const f = this.facts.get(slot);
    if (f && f.id === r.id) return { from: "facts", obs: f };
    const x = this.readers.get(slot);
    if (x && x.id === r.id) return { from: x.legacy ? "legacy" : "readers", obs: x };
    return undefined;
  }

  /** The repo a call's host reaches: the listed repo whose hosts name it. */
  calleeOf(host: string): RepoState | undefined {
    return this.live().find((r) => r.hosts.includes(host));
  }

  /**
   * The legacy joins still in force (ADR point 6): an arrow while both its repos are read, any
   * other record while every repo its evidence names is, and neither while a curated suppress
   * takes it out (point 6: it leaves "through the removal guard: one of its repos removed or
   * archived, or a curated suppress"). A suppressed join stays in joins.json, not derived, and is
   * in force again once the suppress goes.
   */
  liveLegacy(withSuppressed = false): LegacyJoin[] {
    const gone = withSuppressed ? new Set<string>() : this.suppressed();
    return this.legacyJoins.filter(
      (j) =>
        !gone.has(j.id) &&
        (j.arrow
          ? this.isLive(j.arrow.from) && this.isLive(j.arrow.to)
          : j.repos.every((s) => this.isLive(s))),
    );
  }

  /**
   * The cross-repo arrows, as `from|to|method|path`. `admitted`: every arrow the current sources
   * and inputs allow (a call in the caller's source to a host a live repo lists; a topic the
   * caller's source publishes that a live repo's source listens to; a legacy join in force); an
   * arrow outside it outlives its caller or its callee (links are live). `required`: the arrows
   * a build must make: those between two repos read from current, non-legacy sources, and every
   * legacy join in force (point 6: a legacy join stays until it is derived again, and leaves
   * without that only when one of its repos is removed or archived). A call is required to
   * join only when the callee's source serves that method and path. An arrow from or to a
   * legacy readers slot, or to a repo with no source, is admitted but not required: the old
   * catalog's records hold no calls to re-derive it from.
   *
   * `derived`: the arrows the current, non-legacy sources derive by themselves, legacy readers
   * slots and legacy joins aside: a call in a caller's facts or full read to a host a live repo
   * lists (the arrow comes from the caller's evidence), and a topic a non-legacy source publishes
   * that another non-legacy source listens to. The model keeps a legacy observation's calls and
   * topics, but the build has none of them: a legacy slot holds the old catalog's records, whose
   * cross-repo arrows went to joins.json. So an arrow from a legacy caller is admitted and never
   * derived, whatever the callee's source. `required` is within `derived` (legacy joins aside).
   */
  arrows(withLegacy = true): {
    admitted: Set<string>;
    required: Set<string>;
    derived: Set<string>;
  } {
    const admitted = new Set<string>();
    const required = new Set<string>();
    const derived = new Set<string>();
    const add = (k: string, must: boolean, fresh = must) => {
      admitted.add(k);
      if (must) required.add(k);
      if (fresh) derived.add(k);
    };
    for (const c of this.live()) {
      const s = this.source(c.slot);
      if (!s) continue;
      for (const call of s.obs.code.calls) {
        const e = this.calleeOf(call.host);
        if (!e || e.slot === c.slot) continue;
        const t = this.source(e.slot);
        const serves =
          !!t &&
          served(e.base, t.obs.code).some((x) => x.method === call.method && x.path === call.path);
        add(
          arrowKey(c.base.component, e.base.component, call.method, call.path),
          s.from !== "legacy" && !!t && t.from !== "legacy" && serves,
          s.from !== "legacy",
        );
      }
      for (const topic of s.obs.code.publishes)
        for (const e of this.live()) {
          if (e.slot === c.slot) continue;
          const t = this.source(e.slot);
          if (t?.obs.code.consumes.includes(topic))
            add(
              arrowKey(c.base.component, e.base.component, "EVENT", topic),
              s.from !== "legacy" && t.from !== "legacy",
            );
        }
    }
    if (withLegacy)
      for (const j of this.liveLegacy()) {
        if (!j.arrow) continue;
        admitted.add(j.arrow.key);
        if (!this.unjoinedMayLeave(j)) required.add(j.arrow.key);
      }
    // A curated suppress of an arrow's Interface (a hand deletion made curated) takes it out:
    // the build need not make it, derived or legacy (the overlay runs last).
    for (const d of this.curated) if (d.action === "suppress" && d.arrow) required.delete(d.arrow);
    return { admitted, required, derived };
  }

  /**
   * The legacy joins a written build retired (ADR 0195 point 6: once a slot or input the derived
   * record comes from has changed since the upgrade, the derived record takes the id and the
   * legacy copy leaves joins.json). `kept` is the ids joins.json still holds after the write.
   * A join with an arrow may leave only when the current, non-legacy sources derive that arrow
   * by themselves (`arrows(false).derived`: from the caller's fresh evidence, a call to a host a
   * live repo lists, or a topic both ends' fresh sources publish and listen to), and the
   * derived record took its id: it is in the catalog the build wrote (`written`), unless a
   * person's decision suppresses or folds it. An arrow whose caller is still a legacy slot is
   * never derived, though the model keeps that slot's calls: the build has only the old records,
   * whose arrows are in joins.json, so a retirement then would let a later change to the callee
   * "explain" the arrow away, which point 6 forbids (it leaves without being derived only
   * through the removal guard). Any other retirement is returned as wrong. The others leave the
   * model: their arrow is a derived one from now on, and goes when its caller or callee drops it.
   *
   * Any other legacy join (a feature, a term, an Interface whose evidence names two repos), the
   * same way, by the ADR's line (point 6): "Once a slot or input that the derived record comes
   * from has changed since the upgrade (against the slot's `inputs`), the derived record takes
   * the id, and the build retires the legacy copy". What it comes from is the slots of the repos
   * its evidence names: it may leave only once one of them is read from a current, non-legacy
   * source (its slot changed since the upgrade). A curated decision or an answer changes no
   * slot, so it retires nothing by itself. A record with no evidence names no repo: any repo
   * read afresh may derive it; it too must be in the catalog written, as its derived record.
   * So may a feature or a term (beta.28, seed 1400958621): the whole-catalog passes derive them
   * from every repo's records, so any repo read afresh may derive one whatever repos its
   * evidence names.
   * `kept` and `written` hold `<Kind>/<id>`.
   */
  retire(kept: ReadonlySet<string>, written: ReadonlySet<string>): LegacyJoin[] {
    const derivable = this.arrows(false).derived;
    const fresh = (slot: number) => {
      const s = this.source(slot);
      return !!s && s.from !== "legacy";
    };
    // A person's suppress, or an alias folding it into another record, takes the derived record
    // out after it took the id (the curated overlay runs last).
    const decided = new Set([
      ...this.suppressed(),
      ...this.curated.flatMap((d) =>
        d.action === "alias" && Array.isArray(d.value) ? d.value : [],
      ),
    ]);
    const wrong: LegacyJoin[] = [];
    const stay: LegacyJoin[] = [];
    // A suppressed join is judged as one in force: the build may derive it again meanwhile.
    const live = new Set(this.liveLegacy(true));
    for (const j of this.legacyJoins) {
      const took = written.has(`${j.kind}/${j.id}`) || decided.has(j.id);
      const may =
        (took &&
          (j.arrow
            ? derivable.has(j.arrow.key)
            : (j.repos.length && !WHOLE_CATALOG.has(j.kind)
                ? j.repos
                : this.live().map((r) => r.slot)
              ).some(fresh))) ||
        this.unjoinedMayLeave(j);
      if (kept.has(`${j.kind}/${j.id}`) || !live.has(j)) stay.push(j);
      else if (may) continue;
      else {
        wrong.push(j);
        stay.push(j);
      }
    }
    this.legacyJoins = stay;
    return wrong;
  }

  /**
   * Beta.27.2 (ADR 0195, addendum "a legacy join its caller's facts place elsewhere", as the
   * owner approved it on 2026-11-12): a legacy join's call arrow may leave without being derived
   * only when both its ends are read from facts (a facts slot is always written after the
   * upgrade; a callee still legacy gives the join nothing to place the call with) and the
   * caller's read places every call it has with the arrow's method and path somewhere else: none
   * is left, or each goes to a host another live repo lists. An arrow that cites no line at its
   * caller's end (`lineless`) needs the caller's read complete too: with no file to check, a call
   * gone from a read in parts may be one in a file it hasn't reached (`Code.unread`). May, not
   * must: the build also asks that the read cite the file the arrow's caller line is in, which
   * the model doesn't track. An event's arrow never leaves this way: it joins two sources, and a
   * legacy listener gives the join nothing to pair a publish with.
   */
  unjoinedMayLeave(j: LegacyJoin): boolean {
    if (!j.arrow) return false;
    const [, , method, path] = j.arrow.key.split("|");
    if (method === "EVENT") return false;
    const s = this.source(j.arrow.from);
    // Beta.27.1 (owner, 2026-11-12): an arrow with no line at its caller's end is a guess, and a
    // complete facts read of its caller is the whole truth of what it calls: it may leave then,
    // whatever its callee is read from and wherever the read's calls go.
    if (j.lineless) return s?.from === "facts" && !s.obs.code.unread;
    if (s?.from !== "facts" || this.source(j.arrow.to)?.from !== "facts") return false;
    return s.obs.code.calls
      .filter((c) => c.method === method && c.path === path)
      .every((c) => {
        const e = this.calleeOf(c.host);
        return !!e && e.slot !== j.arrow!.to && e.slot !== j.arrow!.from;
      });
  }

  allowedArrows(): Set<string> {
    return this.arrows().admitted;
  }

  /** The suppress decisions in force, by target id. */
  suppressed(): Set<string> {
    return new Set(this.curated.filter((d) => d.action === "suppress").map((d) => d.target));
  }

  /** Every REST endpoint the build must make, as `component method path` (ADR point 2). */
  endpoints(): Set<string> {
    const out = new Set<string>();
    for (const r of this.live()) {
      const s = this.source(r.slot);
      if (!s) continue;
      for (const e of served(r.base, s.obs.code))
        out.add(endpointKey(r.base.component, e.method, e.path));
    }
    // A decision never adds a record (ADR 0195 addendum, CS2: "an added record can't be a
    // curated decision"): only a suppress changes which endpoints there are.
    for (const d of this.curated) if (d.key && d.action === "suppress") out.delete(d.key);
    return out;
  }

  /**
   * Whether a repo's source makes any record from code: a readers or legacy slot does (the
   * readers read the build file, so the repo's own Component at least), a facts slot only when
   * it holds a fact (a facts file with no fact names nothing: no Component, no Endpoint, no
   * arrow). A repo with no source makes none.
   */
  makesRecords(slot: number): boolean {
    const r = this.repos[slot]!;
    const s = this.source(slot);
    if (!s) return false;
    if (s.from !== "facts") return true;
    const c = s.obs.code;
    return served(r.base, c).length + c.calls.length + c.publishes.length + c.consumes.length > 0;
  }

  /**
   * Every repo's own Component the build must make: each repo it reads whose source makes a
   * record (`makesRecords`).
   */
  components(): Set<string> {
    const gone = this.suppressed();
    return new Set(
      this.live()
        .filter((r) => this.makesRecords(r.slot) && !gone.has(r.base.component))
        .map((r) => r.base.component),
    );
  }

  /** Whether an Endpoint decision's target is in the build: its repo's source serves it. */
  serves(d: Pick<Decision, "key">): boolean {
    if (!d.key) return false;
    for (const r of this.live()) {
      const s = this.source(r.slot);
      if (
        s?.obs.code &&
        served(r.base, s.obs.code).some(
          (e) => d.key === endpointKey(r.base.component, e.method, e.path),
        )
      )
        return true;
    }
    return false;
  }

  manifest(): ManifestRepo[] {
    return this.repos
      .filter((r) => r.listed)
      .map((r) => ({ id: r.id, base: r.base, hosts: r.hosts, archived: r.archived }));
  }

  /** A write succeeded (and was counted): what changed before it explained it, and is cleared. */
  wrote(): void {
    this.changes = noChanges();
    this.curatedPending = [];
  }

  /**
   * A deep copy, for two orders of the same commands and for undo; with `withBuilt`, its
   * `built` copied too (one level: a `built` has none of its own).
   */
  clone(withBuilt = true): Model {
    const copy = Object.create(Model.prototype) as Model;
    const { built, ...rest } = this;
    return Object.assign(copy, structuredClone(rest), {
      built: withBuilt ? built?.clone(false) : undefined,
    });
  }
}
