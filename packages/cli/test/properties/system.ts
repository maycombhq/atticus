import { cp, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { main } from "../../src/main.js";
import { git, writeRead } from "./estate.js";
import type { CatalogSystem, Outcome } from "./seam.js";
import { cs2Writers } from "./system-cs2.js";

/**
 * The system under test (ticket CS4). The seam's types and the rules a system must keep are in
 * seam.ts; read them first. This file holds today's system (`todaysWriters`, the writers beta.26
 * ships, which is also what seeds a beta.26 metarepo for the upgrade's sequences), the helper a
 * slot system uses for the equivalence oracle (`freshFromSlots`), and the one place the system
 * under test is chosen (`SYSTEM`).
 *
 * CS2: implement `CatalogSystem` over the slot writers and `buildCatalog` (a `slotWriters` object
 * here, calling `main` as `todaysWriters` does, with `--allow-removals`, `--discard-edits`,
 * `atticus catalog build|undo|prune|edits --curate`, and the two `Faults`), point `SYSTEM` at it,
 * and take each invariant it turns green off KNOWN_FAILURES (invariants.ts) and FAILS_TODAY
 * (examples.ts). Nothing else in the harness changes.
 */

export type { CatalogSystem, Confirm, Faults, Guard, Outcome, RemovalReason } from "./seam.js";

async function run(args: string[]): Promise<Omit<Outcome, "wrote" | "refused">> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(args, { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err };
}

export const unsupported = (what: string): Outcome => ({
  wrote: false,
  refused: false,
  unsupported: true,
  code: 2,
  out: [],
  err: [`${what}: not a command of this system`],
});

const confirming = (o: { allowRemovals?: number; discardEdits?: number }) =>
  o.allowRemovals !== undefined || o.discardEdits !== undefined;

/** The writers of beta.26, as the CLI runs them. They have no slots, guards, build or undo. */
export const todaysWriters: CatalogSystem = {
  name: "beta.26 writers",
  async scan(root, o) {
    if (confirming(o)) return unsupported("atticus scan --allow-removals/--discard-edits");
    if (o.crash) return unsupported("a crash part way through a write");
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
      // A usage error, or a cancelled run, prints no report.
    }
    // beta.26's stop refuses a scan that didn't read every repo, which ADR 0195 doesn't: it is no
    // guard of the ADR's, so it carries none.
    return { ...r, wrote: report.written === true, refused: report.refused !== undefined };
  },
  async verify(root, repo, o) {
    if (confirming(o)) return unsupported("atticus verify --allow-removals/--discard-edits");
    if (o.crash) return unsupported("a crash part way through a write");
    const r = await run(["verify", repo, "--root", root, ...(o.write ? ["--write"] : [])]);
    const refused = o.write && r.err.some((l) => l.startsWith("Nothing written"));
    return { ...r, wrote: o.write && r.code === 0, refused };
  },
  async rename(root, from, to, o) {
    if (confirming(o)) return unsupported("atticus repo rename --allow-removals/--discard-edits");
    if (o.failBuild) return unsupported("a rename whose new slots fail to build");
    if (o.crash) return unsupported("a crash part way through a write");
    const r = await run(["repo", "rename", from, to, "--root", root]);
    return { ...r, wrote: r.code === 0, refused: r.code !== 0 };
  },
  async build() {
    return unsupported("atticus catalog build");
  },
  async curateEdits() {
    return unsupported("atticus catalog edits --curate");
  },
  async undo() {
    return unsupported("atticus catalog undo");
  },
  async prune() {
    return unsupported("atticus catalog prune");
  },
  async upgrade(root, o) {
    const r = await run(["upgrade", "--root", root, ...(o.yes ? [] : ["--dry-run"])]);
    return { ...r, wrote: r.code === 0, refused: r.code !== 0 };
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
      if (x && existsSync(join(from, "workspace", r.id))) clone(r.id, x.commit);
    }
    await run(["scan", "--root", to, "--no-drift", "--json"]);
    for (const r of [...m.live()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const f = m.facts.get(r.slot);
      if (!f || !existsSync(join(from, "workspace", r.id))) continue;
      clone(r.id, f.commit);
      await writeRead(to, r.base, r.id, f.code, f.commit);
      await run(["verify", r.id, "--root", to, "--write"]);
    }
  },
};

/**
 * The equivalence oracle for a slot system (ADR point 10): a fresh metarepo given only the final
 * slots and inputs (the org pack, catalog/curated/, the answers, inputs/, catalog/sources/ but
 * build.json, which is the last build's output), with no clone and no cache, built once.
 */
export async function freshFromSlots(sys: CatalogSystem, from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const d of ["org-pack", "catalog/curated", "questions", "inputs"])
    if (existsSync(join(from, d))) await cp(join(from, d), join(to, d), { recursive: true });
  if (existsSync(join(from, "catalog", "sources")))
    await cp(join(from, "catalog", "sources"), join(to, "catalog", "sources"), {
      recursive: true,
      filter: (src) => !/[\\/]catalog[\\/]sources[\\/]build\.json$/.test(src),
    });
  const r = await sys.build(to, {});
  if (!r.wrote)
    throw new Error(
      `harness: the fresh build of the final slots didn't write: ${r.err.join("\n")}`,
    );
}

/** The one place the system under test is chosen. CS2: the slot writers and `buildCatalog`. */
export const SYSTEM: CatalogSystem = cs2Writers;

let active: CatalogSystem = SYSTEM;

/** The system the commands call: `SYSTEM`, unless a mutation test put another in its place. */
export const sut = (): CatalogSystem => active;

/** Run `f` with `s` as the system under test (the harness's own mutation tests). */
export async function withSystem<T>(s: CatalogSystem, f: () => Promise<T>): Promise<T> {
  const was = active;
  active = s;
  try {
    return await f();
  } finally {
    active = was;
  }
}
