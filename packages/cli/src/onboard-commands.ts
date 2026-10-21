import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parse } from "yaml";
import { type AiRuntime } from "@maycombhq/ai";
import {
  checkDraft,
  checkFrameworkDraft,
  draftDialect,
  draftFramework,
  evalOnboarding,
  findGaps,
  reviewRepo,
  formatEval,
  learnFrameworkFrom,
  loadEvalCases,
  proposalYaml,
  type FrameworkCheck,
  type Learned,
} from "@maycombhq/assistant-kit";
import {
  Dialect,
  FrameworkModel,
  loadOrgPack,
  orgPackDirOf,
  RecordId,
  type OrgPack,
} from "@maycombhq/core";
import {
  modelCovers,
  repoImports,
  runDialectTests,
  runFrameworkTests,
} from "@maycombhq/extractors";
import { fsRepo } from "@maycombhq/sdk";
import { baseClonePath } from "@maycombhq/workspace";
import type { Output } from "./commands.js";
import { loadCatalog } from "./diagram-commands.js";

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
    // No dialect of that name: a framework proposal is accepted the same way (ADR 0066).
    if (await stat(frameworkProposalPath(root, name)).catch(() => undefined))
      return onboardFrameworkAccept(root, name, o, io);
    io.err(
      `There's no proposals/dialects/${name}.yaml or proposals/frameworks/${name}.yaml to accept.`,
    );
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

/**
 * atticus onboard eval <dir> [--json]: how well the assistant drafts dialects for ecosystems it
 * hasn't seen (ADR 0059). Each case's draft is scored against its reference dialect by what it
 * reads from the case's repo. Exit 0 when every case is exact, 1 otherwise.
 */
export async function onboardEval(
  root: string,
  dir: string,
  o: { json?: boolean; attempts?: number },
  deps: OnboardDeps,
  io: Output,
): Promise<number> {
  if (!(await isDir(resolve(dir)))) {
    io.err(`${dir} isn't a folder of evaluation cases (each <case>/case.yaml).`);
    return 2;
  }
  const cases = await loadEvalCases(resolve(dir));
  if (cases.length === 0) {
    io.err(`${dir} has no cases (each <case>/case.yaml names a repo and a reference dialect).`);
    return 2;
  }
  const op = await loadOrgPack(orgPackDirOf(root));
  const results = await evalOnboarding(cases, {
    runtime: deps.runtime,
    orgPack: op,
    maxAttempts: o.attempts ?? 3,
    ...(deps.now ? { now: deps.now } : {}),
  });
  if (o.json) io.out(JSON.stringify(results, null, 2));
  else for (const l of formatEval(results)) io.out(l);
  return results.every((r) => r.status === "drafted" && r.precision === 1 && r.recall === 1)
    ? 0
    : 1;
}

// ------------------------------------------------------------------ framework models (ADR 0066)

const frameworkProposalPath = (root: string, name: string) =>
  join(root, "proposals", "frameworks", `${name}.yaml`);

export interface OnboardFrameworkOptions {
  /** The framework's source folder, JAR or npm package (.tgz); none for a redraft from use alone. */
  from?: string;
  /** The repos that use it (manifest ids or folders); default: the cloned ones that import it. */
  users?: string[];
  /** The framework's module prefixes, when the learner can't tell (a pipeline library). */
  packages?: string[];
  attempts?: number;
}

/** The repos a framework onboarding reads: those named, or the cloned ones importing its packages. */
async function frameworkUsers(
  root: string,
  op: OrgPack,
  named: string[] | undefined,
  packages: string[],
  io: Output,
): Promise<{ id: string; dir: string }[] | undefined> {
  if (named?.length) {
    const out: { id: string; dir: string }[] = [];
    for (const u of named) {
      const repo = await repoFor(root, u);
      if (!repo) {
        io.err(
          `${u} isn't a cloned repo of the manifest or a folder; clone it with atticus workspace sync, or give its folder.`,
        );
        return undefined;
      }
      out.push(repo);
    }
    return out;
  }
  const out: { id: string; dir: string }[] = [];
  const pk = { packages };
  for (const r of op.profiles.flatMap((p) => (p.repos?.repos ?? []).filter((x) => !x.archived))) {
    const dir = baseClonePath(root, r.id);
    if (!(await isDir(dir)) || packages.length === 0) continue;
    const imports = await repoImports(fsRepo(r.id, dir, "0".repeat(40)));
    if ([...imports.modules.keys()].some((m) => modelCovers(pk, m))) out.push({ id: r.id, dir });
  }
  if (out.length === 0) {
    io.err(
      `No cloned repo imports ${packages.length ? packages.join(", ") : "the framework"}: name the repos that use it with --users <repo>[,<repo>...].`,
    );
    return undefined;
  }
  return out;
}

/** What a passing check found, for a person. */
function reportCheck(c: FrameworkCheck, io: Output) {
  for (const g of c.gains) {
    const mine = new Set(c.drafted.find((d) => d.repo === g.repo)?.records ?? []);
    io.out(
      `On ${g.repo} it reads ${plural(g.records.length, "record")} the repo doesn't give without it${g.records.length ? ":" : "."}`,
    );
    for (const l of g.records)
      io.out(`  ${l}${c.added.length && mine.has(l) ? "  (drafted)" : ""}`);
  }
  if (c.idle.length)
    io.out(
      `These entries change nothing in these repos: ${c.idle.join(", ")}. Keep them only if other repos use them.`,
    );
  if (c.added.length)
    io.out(
      `Review the drafted entries first (inferred until a person confirms them): ${c.added
        .map((e) => `${e.label} (${e.source.kind}${e.source.ref ? ` ${e.source.ref}` : ""})`)
        .join("; ")}.`,
    );
}

/**
 * atticus onboard framework <name> --from <source|jar|tgz> [--users <repo>,...] [--attempts 3]
 * [--package p] [--mode m] [--no-ai]: the learner reads the framework, the organisation's
 * assistant drafts what it couldn't, the checks decide, and a passing model is kept as a
 * proposal in proposals/frameworks/ (ADR 0066). With AI off, the learned model alone is checked.
 */
export async function onboardFramework(
  root: string,
  name: string,
  o: OnboardFrameworkOptions,
  deps: { runtime?: AiRuntime; now?: Date },
  io: Output,
): Promise<number> {
  if (!RecordId.safeParse(name).success) {
    io.err(
      `"${name}" isn't a framework name: use lower case, digits and dashes, e.g. tide-platform.`,
    );
    return 2;
  }
  const op = await loadOrgPack(orgPackDirOf(root));
  let learned: Learned;
  if (o.from) {
    try {
      learned = await learnFrameworkFrom(o.from, {
        name,
        ...(o.packages?.length ? { packages: o.packages } : {}),
      });
    } catch (e) {
      io.err(
        `${o.from} couldn't be read (${(e as Error).message}): give the framework's source folder, its JAR or its npm package (.tgz).`,
      );
      return 2;
    }
  } else
    learned = {
      from: "none",
      notes: ["no --from was given: the assistant drafts from the repos that use the framework"],
    };
  const existing = op.frameworks.find((m) => m.name === name);
  const packages = [
    ...new Set([
      ...(o.packages ?? []),
      ...(learned.model?.packages ?? []),
      ...(existing?.packages ?? []),
    ]),
  ];
  const users = await frameworkUsers(root, op, o.users, packages, io);
  if (!users) return 2;
  const handles = users.map((u) => fsRepo(u.id, u.dir, "0".repeat(40)));
  const what =
    learned.from === "jar"
      ? "its JAR"
      : learned.from === "package"
        ? "its npm package"
        : learned.from === "source"
          ? "its source"
          : undefined;
  if (learned.model && what) {
    const m = learned.model;
    io.out(
      `Learned from ${what}: ${plural(m.annotations.length, "annotation")}, ${plural(m.clients.length + m.calls.length, "call")}, ${plural(m.routes.length, "route")}, ${plural(Object.keys(m.constants).length, "constant")} (verified: no draft changes them).`,
    );
  }
  for (const n of learned.notes) io.out(`note: ${n}`);
  if (!deps.runtime && !learned.model) {
    io.err(
      "The learner read nothing and AI is off, so there is nothing to propose: write the model with the kit (atticus frameworks kit).",
    );
    return 1;
  }
  const r = await draftFramework({
    name,
    learned,
    users: handles,
    ...(deps.runtime ? { runtime: deps.runtime } : {}),
    orgPack: op,
    ...(o.packages?.length ? { packages: o.packages } : {}),
    ...(existing ? { existing } : {}),
    maxAttempts: o.attempts ?? 3,
    ...(deps.now ? { now: deps.now } : {}),
  });
  const rel = `proposals/frameworks/${name}.yaml`;
  const userList = users.map((u) => u.id).join(",");
  const checkCmd = `atticus onboard check framework ${name}${o.from ? ` --from ${o.from}` : ""} --users ${userList}`;
  if (r.status === "waiting") {
    if (learned.model) {
      await mkdir(join(root, "proposals", "frameworks"), { recursive: true });
      await writeFile(frameworkProposalPath(root, name), proposalYaml(learned.model, []), "utf8");
    }
    io.out(
      `Handed to your assistant (run ${r.runId}). ${learned.model ? `${rel} holds what was learned; the assistant adds to it` : `Save its model as ${rel}`}, then check it: ${checkCmd}`,
    );
    return 0;
  }
  for (const a of r.attempts.filter((x) => x.attempt > 0 && x.problems.length > 0)) {
    io.out(`Attempt ${a.attempt}: ${plural(a.problems.length, "problem")}, handed back:`);
    for (const p of a.problems) io.out(`  - ${p}`);
  }
  if (r.status === "failed") {
    if (!deps.runtime) for (const p of r.attempts[0]?.problems ?? []) io.err(`- ${p}`);
    io.err(
      deps.runtime
        ? `No draft passed in ${plural(r.attempts.length, "attempt")}. Nothing was written. Try again with --attempts, give the assistant the framework's documents, or write the model with the kit (atticus frameworks kit).`
        : "The learned model doesn't pass on these repos, and AI is off. Nothing was written. Complete it with the kit (atticus frameworks kit).",
    );
    return 1;
  }
  await mkdir(join(root, "proposals", "frameworks"), { recursive: true });
  await writeFile(frameworkProposalPath(root, name), r.yaml!, "utf8");
  const c = r.check!;
  io.out(
    deps.runtime
      ? `Drafted ${rel} in ${plural(r.attempts.length, "attempt")}: ${plural(c.added.length, "entry", "entries")} drafted by your assistant over what was learned; its tests pass.`
      : `Wrote ${rel} from the learner alone (AI off): it reads the repos that use it.`,
  );
  reportCheck(c, io);
  io.out(
    `It is a proposal: nothing scans with it yet. Review it, then: atticus onboard accept framework ${name}${existing ? " --replace (it replaces the model in the org pack)" : ""}`,
  );
  return 0;
}

/**
 * atticus onboard check framework <name> [--from <source>] [--users <repo>,...]: the same
 * checks for a model drafted, handed off or written by hand. With --from, what the learner
 * reads is laid under it (and never changed by it); the proposal is rewritten with both.
 */
export async function onboardFrameworkCheck(
  root: string,
  name: string,
  o: OnboardFrameworkOptions,
  io: Output,
): Promise<number> {
  const file = frameworkProposalPath(root, name);
  const text = await readFile(file, "utf8").catch(() => undefined);
  if (text === undefined) {
    io.err(`There's no proposals/frameworks/${name}.yaml.`);
    return 2;
  }
  const op = await loadOrgPack(orgPackDirOf(root));
  let learned: FrameworkModel | undefined;
  if (o.from) {
    try {
      learned = (
        await learnFrameworkFrom(o.from, {
          name,
          ...(o.packages?.length ? { packages: o.packages } : {}),
        })
      ).model;
    } catch (e) {
      io.err(`${o.from} couldn't be read (${(e as Error).message}).`);
      return 2;
    }
  }
  let packages: string[] = [...(o.packages ?? []), ...(learned?.packages ?? [])];
  try {
    packages.push(...((parse(text) as { packages?: string[] })?.packages ?? []));
  } catch {
    // the check below says it isn't YAML
  }
  packages = [...new Set(packages.filter((p) => typeof p === "string"))];
  const users = await frameworkUsers(root, op, o.users, packages, io);
  if (!users) return 2;
  const c = await checkFrameworkDraft(text, {
    name,
    ...(learned ? { learned } : {}),
    users: users.map((u) => fsRepo(u.id, u.dir, "0".repeat(40))),
    others: op.frameworks,
  });
  if (c.problems.length) {
    for (const p of c.problems) io.err(`- ${p}`);
    if (!o.from && c.problems.some((p) => /source (code|bytecode) is only for/.test(p)))
      io.err(
        "Entries citing code or bytecode are confirmed by reading the framework again: give --from <its source, JAR or package>.",
      );
    return 1;
  }
  const merged = proposalYaml(c.model!, c.added);
  if (learned && merged !== text) await writeFile(file, merged, "utf8");
  io.out(
    `proposals/frameworks/${name}.yaml passes${learned && merged !== text ? " (rewritten with what the learner read)" : ""}: its tests pass, and it reads the repos that use it.`,
  );
  reportCheck(c, io);
  io.out(`Accept it: atticus onboard accept framework ${name}`);
  return 0;
}

/**
 * atticus onboard accept framework <name> [--replace]: a person's approval. The proposal must
 * be a valid model whose own tests pass; it moves to org-pack/frameworks/.
 */
export async function onboardFrameworkAccept(
  root: string,
  name: string,
  o: { replace?: boolean },
  io: Output,
): Promise<number> {
  const from = frameworkProposalPath(root, name);
  const text = await readFile(from, "utf8").catch(() => undefined);
  if (text === undefined) {
    io.err(`There's no proposals/frameworks/${name}.yaml to accept.`);
    return 2;
  }
  let model: FrameworkModel;
  try {
    model = FrameworkModel.parse(parse(text));
  } catch {
    io.err(
      `proposals/frameworks/${name}.yaml isn't a valid framework model; run atticus onboard check framework ${name}.`,
    );
    return 1;
  }
  const failures = await runFrameworkTests(model);
  if (failures.length) {
    for (const f of failures) io.err(`- test "${f.test}": ${f.message}`);
    io.err("Its tests fail, so it can't be accepted.");
    return 1;
  }
  const to = join(orgPackDirOf(root), "frameworks", `${name}.yaml`);
  if ((await stat(to).catch(() => undefined)) && !o.replace) {
    io.err(`org-pack/frameworks/${name}.yaml exists; use --replace to replace it.`);
    return 1;
  }
  await mkdir(join(orgPackDirOf(root), "frameworks"), { recursive: true });
  await rename(from, to);
  io.out(
    `Accepted: org-pack/frameworks/${name}.yaml. Scans read every repo that imports ${model.packages.join(", ")} through it. Commit the org pack for review, as with any change to it.`,
  );
  return 0;
}

/**
 * atticus scan review <repo> [--gaps] [--name n] [--attempts 3] [--resume run] (ADR 0072):
 * deterministic first (the gaps the last scan left), then the assistant's verdict on each and
 * a rule for the ones code can read, checked; then a person accepts and the next scan reads
 * with it. Writes proposals/reviews/<repo>.md and, for a rule, proposals/dialects/<name>.yaml.
 */
export async function scanReview(
  root: string,
  target: string,
  o: { gapsOnly?: boolean; name?: string; attempts?: number; resume?: string },
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
  const name = o.name ?? `${repo.id.toLowerCase().replace(/[^a-z0-9._-]+/g, "-")}-review`;
  if (!RecordId.safeParse(name).success) {
    io.err(`"${name}" isn't a dialect name: use lower case, digits and dashes (--name).`);
    return 2;
  }
  const { records } = await loadCatalog(root, { out: () => {}, err: (l) => io.err(l) });
  const handle = fsRepo(repo.id, repo.dir, "0".repeat(40));
  const gaps = await findGaps(handle, records);
  if (gaps.length === 0) {
    io.out(`The last scan of ${repo.id} left no gaps: everything it found is read and resolved.`);
    return 0;
  }
  io.out(`${plural(gaps.length, "gap")} in ${repo.id} after the last scan:`);
  for (const g of gaps)
    io.out(
      `  ${g.id} ${g.kind} ${g.path}${g.line ? `:${g.line}` : ""}${g.raw ? ` ${g.raw}` : ""}${g.component ? ` (${g.component})` : ""}`,
    );
  if (o.gapsOnly) return 0;
  const op = await loadOrgPack(orgPackDirOf(root));
  const r = await reviewRepo(handle, {
    name,
    runtime: deps.runtime,
    gaps,
    orgPack: op,
    maxAttempts: o.attempts ?? 3,
    ...(deps.now ? { now: deps.now } : {}),
    ...(o.resume ? { resume: o.resume } : {}),
  });
  if (r.status === "waiting") {
    io.out(
      `Handed the gaps to your assistant (run ${r.runId}). When it is done: atticus handoff done ${r.runId}, then atticus scan review ${repo.id} --resume ${r.runId}`,
    );
    return 0;
  }
  for (const a of r.attempts.filter((x) => x.problems.length > 0)) {
    io.out(`Attempt ${a.attempt}: ${plural(a.problems.length, "problem")}, handed back:`);
    for (const p of a.problems) io.out(`  - ${p}`);
  }
  if (r.status === "failed") {
    io.err(`No answer passed in ${plural(r.attempts.length, "attempt")}. Nothing was written.`);
    return 1;
  }
  io.out("Verdicts:");
  for (const v of r.verdicts) io.out(`  ${v.gap} ${v.verdict}: ${v.why}`);
  const report = [
    `# Scan review of ${repo.id}`,
    "",
    "Drafted by atticus scan review from the gaps the last scan left; a person decides on each.",
    "",
    "| Gap | Kind | Where | Verdict | Why |",
    "| --- | --- | --- | --- | --- |",
    ...gaps.map((g) => {
      const v = r.verdicts.find((x) => x.gap === g.id);
      const where = `${g.path}${g.line ? `:${g.line}` : ""}${g.raw ? ` (${g.raw})` : ""}`;
      return `| ${g.id} | ${g.kind} | ${where.replace(/\|/g, "\\|")} | ${v?.verdict ?? ""} | ${(v?.why ?? "").replace(/\|/g, "\\|")} |`;
    }),
    "",
  ].join("\n");
  await mkdir(join(root, "proposals", "reviews"), { recursive: true });
  await writeFile(join(root, "proposals", "reviews", `${repo.id}.md`), report, "utf8");
  io.out(`Wrote proposals/reviews/${repo.id}.md.`);
  if (r.yaml) {
    await mkdir(join(root, "proposals", "dialects"), { recursive: true });
    await writeFile(proposalPath(root, name), r.yaml, "utf8");
    io.out(
      `Drafted proposals/dialects/${name}.yaml: its tests pass, and it reads ${plural(r.resolved.length, "gap")} (${r.resolved.join(", ")}) with ${plural(r.records.length, "record")}. Review it, then: atticus onboard accept ${name}, and atticus scan.`,
    );
  }
  const misread = r.verdicts.filter((v) => v.verdict === "reader");
  if (misread.length)
    io.out(
      `For Atticus: ${plural(misread.length, "gap")} where a built-in reader misreads the code (${misread.map((v) => v.gap).join(", ")}); the review file says what each misreads.`,
    );
  const others = r.verdicts.filter((v) => v.verdict === "vendor" || v.verdict === "person");
  if (others.length)
    io.out(
      `For a person: ${others.map((v) => `${v.gap} (${v.verdict})`).join(", ")}. Record a vendor with atticus alias, or answer in the review file.`,
    );
  return 0;
}
