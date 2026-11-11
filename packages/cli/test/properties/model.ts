import type { Base, Code, Estate, ManifestRepo } from "./estate.js";

/**
 * The model of ADR 0195 point 10: small, and not a copy of the system. Per repo (by slot, so a
 * rename keeps it) what the person's estate is now (its code and commit, whether the manifests
 * list it, whether it is archived), and the two observations the ADR keeps: the readers' last
 * full read and the facts of the last `verify --write` that succeeded. On top: the curated
 * decisions, the answers, the hand edits not yet made curated or discarded, and what changed
 * since the last write (what explains a removal). From these, plain rules say which repo has
 * which source and which cross-repo arrows may exist.
 */

export interface Observation {
  code: Code;
  commit: string;
  /** The repo's id when it was observed. */
  id: string;
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

export interface Decision {
  /** The curated file's id. */
  id: string;
  action: "suppress" | "assert";
  /** The record id it targets. */
  target: string;
  /** The endpoint it targets, by repo slot, method and path (how the model knows it is built). */
  slot: number;
  method: string;
  path: string;
  /** The write count when it was added: its effect is checked after a later write. */
  since: number;
}

/** What changed since the last write: what may explain a record leaving the catalog. */
export interface Changes {
  /** Slots whose observation, listing or id changed. */
  slots: Set<number>;
  /** Record ids a curated decision added or removed since. */
  curated: Set<string>;
  /** Hosts a person answered since. */
  answered: Set<string>;
}

export class Model {
  repos: RepoState[];
  readers = new Map<number, Observation>();
  facts = new Map<number, Observation>();
  curated: Decision[] = [];
  /** Host → slot a person said answers on it, or "none". */
  answers = new Map<string, number | "none">();
  /** Generated files edited by hand and not yet made curated or discarded. */
  handEdits: string[] = [];
  /** Successful writes so far. */
  writes = 0;
  changes: Changes = { slots: new Set(), curated: new Set(), answered: new Set() };
  upgraded = false;
  /** Every code each repo has had, at any commit: what a join with it may ever have used. */
  history = new Map<number, Code[]>();

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

  slotOf(id: string): RepoState | undefined {
    return this.repos.find((r) => r.listed && r.id === id);
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

  /** ADR 0195 point 2.1: the facts slot when there is one, else the readers slot, else none. */
  source(slot: number): { from: "facts" | "readers"; obs: Observation } | undefined {
    const r = this.repos[slot]!;
    if (!r.listed || r.archived) return undefined;
    const f = this.facts.get(slot);
    if (f) return { from: "facts", obs: f };
    const x = this.readers.get(slot);
    return x ? { from: "readers", obs: x } : undefined;
  }

  /** The repo a call's host reaches: the listed repo whose hosts name it. */
  calleeOf(host: string): RepoState | undefined {
    return this.live().find((r) => r.hosts.includes(host));
  }

  /**
   * Every cross-repo arrow the current sources and inputs allow, as `from|to|method|path`: a
   * call in the caller's source to a host a live repo lists, and a topic the caller's source
   * publishes that a live repo's source listens to. An arrow outside this set outlives its
   * caller or its callee (the "links are live" invariant).
   */
  allowedArrows(): Set<string> {
    const out = new Set<string>();
    for (const c of this.live()) {
      const s = this.source(c.slot);
      if (!s) continue;
      for (const call of s.obs.code.calls) {
        const e = this.calleeOf(call.host);
        if (e && e.slot !== c.slot)
          out.add(`${c.base.component}|${e.base.component}|${call.method}|${call.path}`);
      }
      for (const t of s.obs.code.publishes)
        for (const e of this.live()) {
          if (e.slot === c.slot) continue;
          if (this.source(e.slot)?.obs.code.consumes.includes(t))
            out.add(`${c.base.component}|${e.base.component}|EVENT|${t}`);
        }
    }
    return out;
  }

  /** Whether an endpoint is in the build: its repo's source serves it. */
  built(d: Pick<Decision, "slot" | "method" | "path">): boolean {
    const s = this.source(d.slot);
    return !!s?.obs.code.endpoints.some((e) => e.method === d.method && e.path === d.path);
  }

  manifest(): ManifestRepo[] {
    return this.repos
      .filter((r) => r.listed)
      .map((r) => ({ id: r.id, base: r.base, hosts: r.hosts, archived: r.archived }));
  }

  /** A write succeeded (and was counted): what changed before it explained it, and is cleared. */
  wrote(): void {
    this.changes = { slots: new Set(), curated: new Set(), answered: new Set() };
  }

  /** A deep copy, for running two orders of the same commands from one state. */
  clone(): Model {
    const copy = Object.create(Model.prototype) as Model;
    const plain = structuredClone({ ...this });
    // The pool entries are shared by reference in the estate; a copy keeps them equal by value.
    return Object.assign(copy, plain);
  }
}
