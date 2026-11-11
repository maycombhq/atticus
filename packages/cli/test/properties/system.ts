import { cp, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { main } from "../../src/main.js";
import { git, renderFacts } from "./estate.js";
import { fault } from "./fault.js";
import type { Model } from "./model.js";
import { cs2Writers } from "./system-cs2.js";

/**
 * The system under test, behind one small interface (ticket CS4). Today it is the writers
 * beta.26 ships: `atticus scan` (scanEstate, then writeCatalog), `atticus verify <repo> --write`
 * (writeFactsIntoCatalog), `atticus repo rename`, `atticus upgrade`. CS2 points `SYSTEM` at the
 * slot writers and `buildCatalog` (`atticus catalog build`, `catalog undo`, `--discard-edits`),
 * and nothing else in the harness changes: the commands, the model and the invariants only ever
 * call these.
 */

export interface Outcome {
  /** The command wrote what it was asked to (exit 0, or a scan's `written: true`). */
  wrote: boolean;
  /** The command said it refused, and so should have written nothing. */
  refused: boolean;
  /** The system has no such command (today: build, undo, discard). */
  unsupported?: boolean;
  /**
   * Refused by a build guard (a hand edit, a large removal; ADR 0195 point 4): the command wrote
   * nothing, no slot either, so the model records no observation for it. Today's writers have no
   * guards (beta.26's stop refuses a scan that didn't read every repo, which the ADR does not).
   */
  guard?: boolean;
  code: number;
  out: string[];
  err: string[];
}

export interface CatalogSystem {
  name: string;
  /** `atticus scan`, of every repo or of `repos`; `failOn` makes one repo's reader fail. */
  scan(root: string, o: { repos?: string[]; failOn?: string }): Promise<Outcome>;
  /** `atticus verify <repo>`, with `--write` or not, over the facts file the assistant wrote. */
  verify(root: string, repo: string, o: { write: boolean }): Promise<Outcome>;
  rename(root: string, from: string, to: string): Promise<Outcome>;
  /** A build after a person changed an input (curated, answers, manifest): `catalog build`. */
  build(root: string): Promise<Outcome>;
  /** Confirm the discard of the hand edits a build listed, with their count. */
  discardEdits(root: string, count: number): Promise<Outcome>;
  /** Confirm the large removals the last refused build listed (`--allow-removals <count>`). */
  confirmRemovals(root: string): Promise<Outcome>;
  /** `atticus catalog undo --yes`: take back the latest build. */
  undo(root: string): Promise<Outcome>;
  /** `atticus upgrade`: a dry run, or with `--yes`. */
  upgrade(root: string, o: { yes: boolean }): Promise<Outcome>;
  /**
   * The equivalence oracle (ADR 0195 point 10): a full build of a fresh metarepo at `to` given
   * only the final slots and inputs of the metarepo at `from` (and, for a system with no slots,
   * the model's observations, which are what the slots would hold).
   */
  freshBuild(from: string, to: string, m: Model): Promise<void>;
}

async function run(args: string[]): Promise<Omit<Outcome, "wrote" | "refused">> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(args, { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err };
}

const unsupported = (what: string): Outcome => ({
  wrote: false,
  refused: false,
  unsupported: true,
  code: 2,
  out: [],
  err: [`${what}: not a command of this system`],
});

/** The writers of beta.26, as the CLI runs them. */
export const todaysWriters: CatalogSystem = {
  name: "beta.26 writers",
  async scan(root, o) {
    fault.on = o.failOn;
    try {
      const r = await run([
        "scan",
        "--root",
        root,
        "--no-drift",
        "--json",
        ...(o.repos ? ["--repos", o.repos.join(",")] : []),
      ]);
      let report: { written?: boolean; refused?: unknown } = {};
      try {
        report = JSON.parse(r.out.join("\n")) as typeof report;
      } catch {
        // A usage error prints no report.
      }
      return { ...r, wrote: report.written === true, refused: report.refused !== undefined };
    } finally {
      fault.on = undefined;
    }
  },
  async verify(root, repo, o) {
    const r = await run(["verify", repo, "--root", root, ...(o.write ? ["--write"] : [])]);
    const refused = o.write && r.err.some((l) => l.startsWith("Nothing written"));
    return { ...r, wrote: o.write && r.code === 0, refused };
  },
  async rename(root, from, to) {
    const r = await run(["repo", "rename", from, to, "--root", root]);
    return { ...r, wrote: r.code === 0, refused: r.code !== 0 };
  },
  async build() {
    return unsupported("atticus catalog build");
  },
  async discardEdits() {
    return unsupported("atticus catalog build --discard-edits");
  },
  async confirmRemovals() {
    return unsupported("atticus catalog build --allow-removals");
  },
  async undo() {
    return unsupported("atticus catalog undo");
  },
  async upgrade(root, o) {
    const r = await run(["upgrade", "--root", root, ...(o.yes ? [] : ["--dry-run"])]);
    return { ...r, wrote: o.yes && r.code === 0, refused: r.code !== 0 };
  },
  /**
   * Today there are no slots, so the fresh metarepo is given what they would hold: the inputs
   * (org pack, curated decisions, answers) copied, each repo's clone at the commit its readers
   * last read in full, one scan, then each repo's facts as its last successful `verify --write`
   * verified them, written again with `verify --write`, in repo order.
   */
  async freshBuild(from, to, m) {
    await mkdir(to, { recursive: true });
    await cp(join(from, "org-pack"), join(to, "org-pack"), { recursive: true });
    for (const d of ["catalog/curated", "questions"])
      if (existsSync(join(from, d))) await cp(join(from, d), join(to, d), { recursive: true });
    const clone = (id: string, commit: string) => {
      const dir = join(to, "workspace", id);
      if (!existsSync(dir)) {
        git(from, "clone", "-q", "--no-hardlinks", join(from, "workspace", id), dir);
      }
      git(dir, "checkout", "-q", "-B", "main", commit);
      return dir;
    };
    for (const r of m.live()) {
      const x = m.readers.get(r.slot);
      if (x) clone(r.id, x.commit);
    }
    await run(["scan", "--root", to, "--no-drift", "--json"]);
    for (const r of [...m.live()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const f = m.facts.get(r.slot);
      if (!f) continue;
      clone(r.id, f.commit);
      await mkdir(join(to, "facts"), { recursive: true });
      await writeFile(
        join(to, "facts", `${r.id}.jsonl`),
        renderFacts(r.base, r.id, f.code, f.commit),
      );
      await run(["verify", r.id, "--root", to, "--write"]);
    }
  },
};

/** The one place the system under test is chosen: CS2, the slot writers and `buildCatalog`. */
export const SYSTEM: CatalogSystem = cs2Writers;
