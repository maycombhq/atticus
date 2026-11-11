import type { Model } from "./model.js";

/**
 * THE SEAM: the system under test, behind one small interface (ADR 0195 point 10, ticket CS4).
 *
 * The harness (the commands, the model and the invariants) only ever calls a `CatalogSystem`.
 * Today it is `todaysWriters` (system.ts): the writers beta.26 ships. CS2 implements this
 * interface over the slot writers and `buildCatalog`, sets `SYSTEM` in system.ts to it, and
 * nothing else in the harness changes. This harness is the oracle CS2 is graded against: an
 * implementation is not "done" by making a method return what a check wants, but by doing what
 * the ADR says. Every rule below cites the ADR.
 *
 * What the harness does itself, so a system need not:
 * - The reader faults (a reader failing on one repo, a cancelled scan) are injected by the harness
 *   through the mocked scanner (fault.ts) and ADR 0119's cancel signal; a system's scan only has
 *   to read through `scanEstate` of `@maycombhq/scanner`, as the CLI does.
 * - "Not cloned" and "nothing read" move the clones aside; `--repos` is passed as `repos`.
 * - Writing a facts file, a curated decision, an answer or a manifest is the person's (the
 *   harness's); the system is called to build after it.
 *
 * What a system must do, per method:
 * - Return an `Outcome` (below) that says what happened. `wrote` is "succeeded", not "changed a
 *   byte": a build with nothing to change succeeds and writes no file (ADR point 8).
 * - Refuse by a guard (point 4) only for a reason in `Guard`, with what it listed: a hand-edit
 *   refusal lists the files (`edits`), a large-removal refusal lists the removals (`removals`).
 *   A refused command writes nothing: no slot, no record file, no build.json (point "nothing
 *   destructive"). The harness checks every listing against its model, and confirms with the
 *   listed count: a confirmation with that count must then succeed, and any other count must
 *   refuse again.
 * - Report what a written build removed (`removed`), each with its reason (point 4).
 * - Simulate the two faults only a system can (`Faults`): a crash part way through a write, and
 *   a rename whose new slot files don't parse. They have no CLI flag; CS2's adapter reaches them
 *   however its IO half allows (a test hook in writeBuiltCatalog, say). `todaysWriters` answers
 *   `unsupported` for them.
 */

/** What a person passes to confirm what a refusal listed (ADR point 4). */
export interface Confirm {
  /**
   * `--allow-removals <count>`: the count of removals the refusal listed. A build whose explained
   * removals are above the limits (more than 10% of a repo's records, or more than 200 in one
   * build) writes only with this count; any other count refuses again, listing them again.
   */
  allowRemovals?: number;
  /**
   * `--discard-edits <count>`: the count of hand-edited files under catalog/generated/ the
   * refusal listed. With it the build copies them into the undo copy, then replaces them.
   */
  discardEdits?: number;
}

/** Faults only the system can simulate (test hooks, no CLI flag). */
export interface Faults {
  /**
   * A crash part way through the write (ADR point 2, "compute, guard, then write"): the undo copy
   * and the slots are written, then the process stops `after-slots` (no record file written) or
   * `mid-records` (some record files written, each whole). The method returns `crashed: true`.
   * The next build must catch the catalog up, and must not take the files the crashed write left
   * for hand edits (they match the interrupted build's manifest, kept in its undo copy).
   */
  crash?: "after-slots" | "mid-records";
}

/** Why a guard refused (ADR point 4). Any other refusal of a command the model expects to succeed fails. */
export type Guard =
  /** A scan that read no repo in full: no slot, no build. */
  | "nothing-read"
  /** A build with no records over a catalog that has records, while the manifests list repos. */
  | "empty-catalog"
  /** A removal nothing explains. In this harness every change goes through a command, so the
   *  model has an explanation for every removal: this refusal always fails. */
  | "unexplained-removals"
  /** Explained removals above the limits, listed in `removals`, waiting for `allowRemovals`. */
  | "large-removals"
  /** catalog/generated/ edited by hand since build.json, listed in `edits`, waiting for
   *  `discardEdits` or `atticus catalog edits --curate`. Undo refuses over hand edits too. */
  | "hand-edits"
  /** A rename whose new slot files fail to parse or to build (`failBuild`): the new files are
   *  removed, the old ones kept. */
  | "build-failed";

/** Why a written build removed a record (ADR point 4, "nothing removed unexplained"). */
export type RemovalReason =
  /** A slot this command changed: the repo's new read or facts no longer produce it, or a join
   *  involving that repo no longer forms. */
  | "slot"
  /** A repo the manifests no longer list. */
  | "manifest"
  /** A repo marked archived. */
  | "archived"
  /** A curated decision: a suppress, or an alias that folds it into another record. */
  | "curated"
  /** A build input other than a slot that changed: here, an answer. */
  | "input";

export interface Outcome {
  /**
   * The command succeeded: it did what it was asked (exit 0, or a scan's `written: true`). When
   * there was nothing to change it succeeds having written no byte.
   */
  wrote: boolean;
  /** The command refused, and so wrote nothing. */
  refused: boolean;
  /** Refused by a build guard (ADR point 4), and which. */
  guard?: Guard;
  /** The system has no such command (today: build, undo, prune, the confirm flags). */
  unsupported?: boolean;
  /** The command stopped at the `Faults.crash` point it was asked to. */
  crashed?: boolean;
  /**
   * A `large-removals` refusal's list: every record the build would remove, as `<Kind>/<id>`
   * (`Endpoint/ledger-api.get-account`), and their count, which `allowRemovals` must repeat.
   */
  removals?: { count: number; ids: string[] };
  /** A `hand-edits` refusal's list: each file, as its path under catalog/generated/ (`/`). */
  edits?: string[];
  /** A build that wrote: each record it removed, as `<Kind>/<id>`, with its reason. */
  removed?: { id: string; reason: RemovalReason }[];
  /**
   * `atticus catalog prune`: the files it listed (a dry run) or removed (`yes`), as paths under
   * catalog/sources/ (`/`): orphaned and archived repos' slot files and
   * legacy/generated-before-upgrade/.
   */
  pruned?: string[];
  code: number;
  out: string[];
  err: string[];
}

/** The system under test. Every method takes the metarepo's root. */
export interface CatalogSystem {
  name: string;
  /**
   * `atticus scan [--repos a,b] [--allow-removals n] [--discard-edits n]`: writes the readers slot
   * of each repo read in full, then builds (ADR points 1 and 2). Never writes a facts slot.
   */
  scan(root: string, o: { repos?: string[] } & Confirm & Faults): Promise<Outcome>;
  /**
   * `atticus verify <repo> [--write] [--allow-removals n] [--discard-edits n]` over the facts file
   * the assistant wrote. With `write` and nothing rejected: the facts snapshot, then a build.
   * With facts rejected: refused (not a guard), nothing written. Without `write`: nothing written.
   */
  verify(root: string, repo: string, o: { write: boolean } & Confirm & Faults): Promise<Outcome>;
  /**
   * `atticus repo rename <from> <to>`: the new slot files first, a build from them through its
   * guards, then the old files removed (ADR point 2). `failBuild` simulates new slot files that
   * don't parse: guard `build-failed`, only the new files removed, nothing else changed.
   */
  rename(
    root: string,
    from: string,
    to: string,
    o: Confirm & { failBuild?: boolean },
  ): Promise<Outcome>;
  /** `atticus catalog build [--allow-removals n] [--discard-edits n]`, after a person changed an input. */
  build(root: string, o: Confirm & Faults): Promise<Outcome>;
  /**
   * `atticus catalog edits --curate`: for each hand-edited file, a curated assert of the changed
   * fields (or of the added record) or a suppress of a deleted one, into catalog/curated/. It
   * does not build; the harness builds after it, and that build must keep each edit's effect.
   */
  curateEdits(root: string): Promise<Outcome>;
  /**
   * `atticus catalog undo [<n>] [--yes]` (ADR point 7). `n` counts back from the latest build
   * that wrote (1, the default, is the latest; up to 5): undo n takes back the n latest, in
   * order. Without `yes` it lists and writes nothing. An undo is itself undoable.
   */
  undo(root: string, o: { n?: number; yes: boolean }): Promise<Outcome>;
  /** `atticus catalog prune [--yes]` (ADR point 4): lists, and with `yes` removes, `pruned`. */
  prune(root: string, o: { yes: boolean }): Promise<Outcome>;
  /** `atticus upgrade [--yes]` (ADR point 6): a dry run writes nothing; `yes` adopts and builds. */
  upgrade(root: string, o: { yes: boolean }): Promise<Outcome>;
  /**
   * The equivalence oracle (ADR point 10): a full build, at `to`, of a fresh metarepo given only
   * the final slots and inputs of the metarepo at `from`. A slot system can use `freshFromSlots`
   * (system.ts), which copies the slots and inputs, never a clone or a cache, and builds. The
   * model is passed for a system with no slots, whose observations are what the slots would hold.
   */
  freshBuild(from: string, to: string, m: Model): Promise<void>;
}
