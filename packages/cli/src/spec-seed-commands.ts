import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { changeFolder, writeFileAtomic } from "@maycombhq/changes";
import { createOpenSpec } from "@maycombhq/openspec-adapter";
import {
  loadEstate,
  openspecRootOf,
  readExistingSpecs,
  SEED_MARK,
  seedChangeId,
  seedCollisions,
  seedCollisionWords,
  seedSpec,
  writeSpecFiles,
} from "@maycombhq/planner";
import type { Output } from "./commands.js";

/**
 * atticus spec seed <repo> and atticus spec accept <repo> (ADR 0146, plan item V2): a repo's
 * starting openspec/specs from its verified flows, proposed as an OpenSpec change of its own in
 * the metarepo (`openspec/changes/seed-<repo>/`), never written into a code repo or straight into
 * openspec/specs. A person reads it and accepts it; accepting is `openspec archive`, and from
 * then on OpenSpec's archive of each change keeps the specs current.
 */

const NO_OPENSPEC =
  "This metarepo isn't set up with OpenSpec (no openspec/config.yaml). Set it up first: atticus openspec setup";

/** atticus spec seed <repo>: write (or refresh) the seed change from the repo's flows. */
export async function specSeed(
  root: string,
  repo: string,
  o: { json?: boolean },
  io: Output,
): Promise<number> {
  const osRoot = openspecRootOf(root);
  if (!osRoot) {
    io.err(NO_OPENSPEC);
    return 2;
  }
  const estate = await loadEstate(root, []);
  const flows = estate.flows.filter((f) => f.repo === repo).map((f) => f.flow);
  if (!flows.length) {
    io.err(
      `${repo} has no verified flows in specs/${repo}/. Read it first: atticus map ${repo}, then atticus verify ${repo} --write`,
    );
    return 2;
  }
  const os = createOpenSpec({ root: osRoot });
  const existing = await readExistingSpecs(os);
  const multiRepo = new Set(estate.flows.map((f) => f.repo)).size > 1;
  const seed = seedSpec(repo, flows, { existing, multiRepo });
  if (!seed.deltas.length) {
    if (o.json) io.out(JSON.stringify({ change: null, repo, skipped: seed.skipped }, null, 2));
    else
      io.out(
        `Nothing to seed: openspec/specs already has every flow of ${repo} that the code runs today. Each change keeps it current when it is archived.`,
      );
    return 0;
  }
  const dir = changeFolder(root, seed.change);
  if (!existsSync(join(dir, ".openspec.yaml")))
    await os.newChange(seed.change, { description: `Starting spec for ${repo}` });
  const written = await writeSpecFiles(dir, seed.files, SEED_MARK);
  const had = await readFile(join(dir, "proposal.md"), "utf8").catch(() => undefined);
  const proposal = had === undefined || had.startsWith(SEED_MARK);
  if (proposal) await writeFileAtomic(join(dir, "proposal.md"), seed.proposal);
  const kept = Object.keys(seed.files).filter((f) => !written.includes(f));
  // ADR 0156: a change that already adds one of these flows as new would collide at archive.
  const collisions = (await seedCollisions(root)).filter((c) => c.seed === seed.change);
  if (o.json) {
    io.out(
      JSON.stringify(
        {
          change: seed.change,
          repo,
          capabilities: seed.deltas.map((d) => ({ capability: d.capability, flow: d.flow })),
          written,
          kept,
          skipped: seed.skipped,
          collisions,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  for (const c of collisions) io.err(`Warning: ${seedCollisionWords(c)}`);
  const rel = `openspec/changes/${seed.change}`;
  io.out(
    `Wrote ${rel}/: a starting spec for ${repo}, ${seed.deltas.length} ${seed.deltas.length === 1 ? "capability" : "capabilities"}, one per verified flow, each scenario citing its lines.`,
  );
  for (const f of kept) io.out(`Kept ${rel}/${f} as a person left it (no mark on its first line).`);
  if (!proposal) io.out(`Kept ${rel}/proposal.md as a person left it.`);
  for (const s of seed.skipped) io.out(`Not seeded: ${s.flow} (${s.why}).`);
  io.out(
    `Read each spec under ${rel}/specs/ against the code it cites, then accept it: atticus spec accept ${repo}`,
  );
  return 0;
}

/**
 * atticus spec accept <repo>: a person accepts the repo's seed. `openspec validate --strict`,
 * then `openspec archive`, which writes the capabilities into openspec/specs/. The proposal
 * records who accepted it and when; the archived change keeps it.
 */
export async function specAccept(
  root: string,
  repo: string,
  o: { by?: string; now?: Date },
  io: Output,
): Promise<number> {
  if (!o.by) {
    io.err("Say who is accepting: set your Git user (git config user.name), or pass --by <you>.");
    return 2;
  }
  const osRoot = openspecRootOf(root);
  if (!osRoot) {
    io.err(NO_OPENSPEC);
    return 2;
  }
  const change = seedChangeId(repo);
  const dir = changeFolder(root, change);
  if (!existsSync(join(dir, ".openspec.yaml"))) {
    io.err(`${repo} has no starting spec waiting. Write one first: atticus spec seed ${repo}`);
    return 2;
  }
  const os = createOpenSpec({ root: osRoot });
  const v = await os.validate({ item: change, type: "change", strict: true });
  const issues = (v.items[0]?.issues ?? []).filter((i) => i.level !== "INFO");
  if (issues.length || v.items[0]?.valid === false) {
    io.err(`${change} doesn't pass openspec validate --strict; fix its specs and accept again:`);
    for (const i of issues) io.err(`  ${i.path}: ${i.message}`);
    return 1;
  }
  const date = (o.now ?? new Date()).toISOString().slice(0, 10);
  const p = join(dir, "proposal.md");
  const text = await readFile(p, "utf8").catch(() => undefined);
  if (text !== undefined && !/\nAccepted by .+ on \d{4}-\d{2}-\d{2}\.\n?$/.test(text))
    await writeFileAtomic(p, `${text.trimEnd()}\n\nAccepted by ${o.by} on ${date}.\n`);
  try {
    await os.archive(change);
  } catch (e) {
    io.err(`openspec archive ${change} failed: ${(e as Error).message}`);
    return 1;
  }
  io.out(
    `Accepted ${repo}'s starting spec: openspec/specs/ has its capabilities, and ${change} is archived. Commit the metarepo and open its pull request; the next change to ${repo} modifies these requirements.`,
  );
  return 0;
}
