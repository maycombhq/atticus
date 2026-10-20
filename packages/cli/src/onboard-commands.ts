import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parse } from "yaml";
import { type AiRuntime } from "@maycombhq/ai";
import { checkDraft, draftDialect } from "@maycombhq/assistant-kit";
import { Dialect, loadOrgPack, orgPackDirOf, RecordId } from "@maycombhq/core";
import { runDialectTests } from "@maycombhq/extractors";
import { fsRepo } from "@maycombhq/sdk";
import { baseClonePath } from "@maycombhq/workspace";
import type { Output } from "./commands.js";

/**
 * atticus onboard (ADR 0059): the organisation's assistant drafts a dialect for a repo Atticus
 * can't read yet; the draft is checked and handed back until it passes, then kept as a proposal
 * in proposals/dialects/. A person reviews it and runs atticus onboard accept.
 */

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const proposalPath = (root: string, name: string) =>
  join(root, "proposals", "dialects", `${name}.yaml`);

const isDir = async (p: string) => !!(await stat(p).catch(() => undefined))?.isDirectory();

/** A repo by manifest id (its base clone) or a folder. */
async function repoFor(
  root: string,
  target: string,
): Promise<{ id: string; dir: string } | undefined> {
  const op = await loadOrgPack(orgPackDirOf(root));
  const known = op.profiles.flatMap((p) => p.repos?.repos ?? []).find((r) => r.id === target);
  if (known) {
    const dir = baseClonePath(root, known.id);
    return (await isDir(dir)) ? { id: known.id, dir } : undefined;
  }
  const dir = resolve(target);
  return (await isDir(dir)) ? { id: basename(dir), dir } : undefined;
}

export interface OnboardDeps {
  /** The runtime to draft with; the CLI builds it from runtime.yaml (or --mode). */
  runtime: AiRuntime;
  now?: Date;
}

/** atticus onboard <repo> [--name n] [--attempts 3]: draft, check, hand back, keep a proposal. */
export async function onboardDraft(
  root: string,
  target: string,
  o: { name?: string; attempts?: number },
  deps: OnboardDeps,
  io: Output,
): Promise<number> {
  const repo = await repoFor(root, target);
  if (!repo) {
    io.err(
      `${target} isn't a cloned repo of the manifest or a folder; clone it with atticus workspace sync, or give its folder.`,
    );
    return 2;
  }
  const name = o.name ?? repo.id.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  if (!RecordId.safeParse(name).success) {
    io.err(`"${name}" isn't a dialect name: use lower case, digits and dashes (--name).`);
    return 2;
  }
  const op = await loadOrgPack(orgPackDirOf(root));
  const handle = fsRepo(repo.id, repo.dir, "0".repeat(40));
  const r = await draftDialect(handle, {
    name,
    runtime: deps.runtime,
    orgPack: op,
    maxAttempts: o.attempts ?? 3,
    ...(deps.now ? { now: deps.now } : {}),
  });
  const rel = `proposals/dialects/${name}.yaml`;
  if (r.status === "waiting") {
    io.out(
      `Handed to your assistant (run ${r.runId}). Save its dialect as ${rel}, then check it: atticus onboard check ${name} --repo ${repo.id}`,
    );
    return 0;
  }
  for (const a of r.attempts.filter((x) => x.problems.length > 0)) {
    io.out(`Attempt ${a.attempt}: ${plural(a.problems.length, "problem")}, handed back:`);
    for (const p of a.problems) io.out(`  - ${p}`);
  }
  if (r.status === "failed") {
    io.err(
      `No draft passed in ${plural(r.attempts.length, "attempt")}. Nothing was written. Try again with --attempts, give the assistant the framework's documents, or write the dialect with the kit (atticus dialect kit).`,
    );
    return 1;
  }
  await mkdir(join(root, "proposals", "dialects"), { recursive: true });
  await writeFile(proposalPath(root, name), r.yaml!, "utf8");
  const kinds = new Map<string, number>();
  for (const x of r.records) kinds.set(x.split(" ")[0]!, (kinds.get(x.split(" ")[0]!) ?? 0) + 1);
  io.out(
    `Drafted ${rel} for ${repo.id} in ${plural(r.attempts.length, "attempt")}: its tests pass, and on ${repo.id} it gives ${[...kinds].map(([k, n]) => plural(n, k)).join(", ")}.`,
  );
  for (const x of r.records) io.out(`  ${x}`);
  io.out(
    `It is a proposal: nothing scans with it yet. Review the rules and their tests, then: atticus onboard accept ${name}`,
  );
  return 0;
}

/** atticus onboard check <name> --repo <repo>: the same checks, for a draft written by hand or hand-off. */
export async function onboardCheck(
  root: string,
  name: string,
  target: string,
  io: Output,
): Promise<number> {
  const repo = await repoFor(root, target);
  if (!repo) {
    io.err(`${target} isn't a cloned repo of the manifest or a folder.`);
    return 2;
  }
  const text = await readFile(proposalPath(root, name), "utf8").catch(() => undefined);
  if (text === undefined) {
    io.err(`There's no proposals/dialects/${name}.yaml.`);
    return 2;
  }
  const c = await checkDraft(text, fsRepo(repo.id, repo.dir, "0".repeat(40)), name);
  if (c.problems.length) {
    for (const p of c.problems) io.err(`- ${p}`);
    return 1;
  }
  io.out(
    `proposals/dialects/${name}.yaml passes: its tests pass, and on ${repo.id} it gives ${plural(c.records.length, "record")}. Accept it: atticus onboard accept ${name}`,
  );
  return 0;
}

/**
 * atticus onboard accept <name>: a person's approval. The proposal's own tests must still pass;
 * it moves to org-pack/dialects/, and the repos it is for are named for the manifest.
 */
export async function onboardAccept(
  root: string,
  name: string,
  o: { replace?: boolean },
  io: Output,
): Promise<number> {
  const from = proposalPath(root, name);
  const text = await readFile(from, "utf8").catch(() => undefined);
  if (text === undefined) {
    io.err(`There's no proposals/dialects/${name}.yaml to accept.`);
    return 2;
  }
  const parsed = Dialect.safeParse(parse(text));
  if (!parsed.success) {
    io.err(`proposals/dialects/${name}.yaml isn't a valid dialect; run atticus onboard check.`);
    return 1;
  }
  const failures = await runDialectTests(parsed.data, ".");
  if (failures.length) {
    for (const f of failures) io.err(`- test "${f.test}": ${f.message}`);
    io.err("Its tests fail, so it can't be accepted.");
    return 1;
  }
  const to = join(orgPackDirOf(root), "dialects", `${name}.yaml`);
  if ((await stat(to).catch(() => undefined)) && !o.replace) {
    io.err(`org-pack/dialects/${name}.yaml exists; use --replace to replace it.`);
    return 1;
  }
  await mkdir(join(orgPackDirOf(root), "dialects"), { recursive: true });
  await rename(from, to);
  const types = parsed.data.appliesTo.repoTypes;
  io.out(
    `Accepted: org-pack/dialects/${name}.yaml. ${
      types.length
        ? `It applies to repos of type ${types.join(", ")}.`
        : `Add it to the repos it reads in repos.manifest.yaml: dialects: [${name}].`
    } Commit the org pack for review, as with any change to it.`,
  );
  return 0;
}
