import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { stringify } from "yaml";
import { changesDirOf, parseFacts } from "@maycombhq/core";
import { draftedStories } from "@maycombhq/planner";
import {
  BenchStory,
  benchStoryFromStories,
  benchKnownFields,
  factFieldNames,
  parseDraftStory,
  parseReference,
  parseReferenceStory,
  scoreStory,
  type StoryScore,
} from "@maycombhq/evals";
import { benchFactsCommand } from "./bench-commands.js";
import type { Output } from "./commands.js";

/**
 * The bench's scoring commands that need no clone and no scan (ADR 0124 §6, Phase B's first
 * ticket): `atticus bench facts` scores an assistant's facts file against a reference, and
 * `atticus bench stories --draft <file>` scores a drafted user story against its reference story
 * in bench/stories.
 */

type Values = Record<string, string | boolean | (string | boolean)[] | undefined>;
const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);

export async function benchScoreCli(
  command: string,
  arg: string | undefined,
  values: Values,
  io: Output,
  /** The metarepo (--root), for a change given by id. */
  root?: string,
): Promise<number> {
  const common = {
    ...(str(values.bench) ? { bench: str(values.bench)! } : {}),
    ...(str(values.cache) ? { cache: str(values.cache)! } : {}),
    ...(str(values.facts) ? { facts: str(values.facts)! } : {}),
    json: values.json === true,
  };
  if (command === "facts") {
    const repo = arg ?? str(values.repo);
    const batch = Number(str(values.batch));
    return benchFactsCommand(
      { ...common, ...(repo ? { repo } : {}), ...(batch > 0 ? { batch } : {}) },
      io,
    );
  }
  const change = str(values.change);
  if (change) {
    const story = str(values.story);
    if (!story) {
      io.err(
        "bench stories --change needs the reference story the change answers: atticus bench stories --change <change> --story <id> (an id in bench/stories).",
      );
      return 2;
    }
    const out = str(values.out);
    return benchChangeStories(
      { ...common, change, story, root: root ?? process.cwd(), ...(out ? { out } : {}) },
      io,
    );
  }
  // --draft is a switch elsewhere (plan stories --draft), so the file is the word after it.
  const draft = str(values.draft) ?? arg;
  if (!draft) {
    io.err(
      "bench stories needs a drafted story: atticus bench stories --draft <file>, or a change's stories: --change <change> --story <id>",
    );
    return 2;
  }
  return benchStories({ ...common, draft }, io);
}

export interface BenchChangeStoriesOptions extends Omit<BenchStoriesOptions, "draft"> {
  /** The change: its id, or its folder. */
  change: string;
  /** The reference story it answers. */
  story: string;
  /** The metarepo, when the change is given by id. */
  root: string;
  /** Where to keep the converted draft. */
  out?: string;
}

/** A change given by its folder: its id and the metarepo it is in. */
function changeAt(value: string, root: string): { root: string; id: string } {
  const dir = resolve(value);
  if (!existsSync(join(dir, "change.yaml"))) return { root: resolve(root), id: value };
  const id = basename(dir);
  for (let up = dirname(dir); ; up = dirname(up)) {
    if (resolve(changesDirOf(up), id) === dir) return { root: up, id };
    if (dirname(up) === up) break;
  }
  throw new Error(`${dir} is a change folder, but not in a metarepo's changes folder.`);
}

/**
 * atticus bench stories --change <change> --story <id> [--out file] (B-stories-bench): the
 * stories the stories stage drafted for a change, read from its folder (draftedStories), as one
 * BenchStory (benchStoryFromStories), scored against bench/stories/<id>.yaml as --draft scores a
 * file. Writes only --out.
 */
export async function benchChangeStories(
  o: BenchChangeStoriesOptions,
  io: Output,
): Promise<number> {
  let draft: BenchStory;
  try {
    const { root, id } = changeAt(o.change, o.root);
    const d = await draftedStories(root, id);
    draft = BenchStory.parse(
      benchStoryFromStories({
        story: o.story,
        change: d.change.id,
        title: d.change.title,
        stories: d.stories,
        answer: d.answer,
        ...(d.extras.done ? { done: d.extras.done } : {}),
        requests: d.requests,
      }),
    );
    if (o.out) {
      await mkdir(dirname(resolve(o.out)), { recursive: true });
      await writeFile(
        resolve(o.out),
        `# The stories atticus plan stories drafted for ${d.change.id}, as a bench story (atticus bench stories --change).\n${stringify(draft, { lineWidth: 0 })}`,
      );
    }
  } catch (e) {
    io.err((e as Error).message);
    return 2;
  }
  return scoreAndReport(draft, o, io, o.out ? resolve(o.out) : undefined);
}

const defaultCache = () =>
  process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "atticus", "bench")
    : join(homedir(), ".cache", "atticus", "bench");

export interface BenchStoriesOptions {
  draft: string;
  bench?: string;
  cache?: string;
  /** A facts file whose fields count as known; default each repo's facts in the cache. */
  facts?: string;
  json?: boolean;
}

/**
 * atticus bench stories --draft <file> [--facts file] [--json]: score a drafted story against
 * bench/stories/<story>.yaml. Fields the story's repos are known to have (their bench
 * references' fields, and the facts the assistant wrote for them) are not invented. Exit 1 when
 * the draft invents a field, since that must never happen; 2 when it can't be scored.
 */
export async function benchStories(o: BenchStoriesOptions, io: Output): Promise<number> {
  let draft: BenchStory;
  try {
    const draftText = await readFile(resolve(o.draft), "utf8").catch(() => undefined);
    if (draftText === undefined) throw new Error(`There is no draft at ${resolve(o.draft)}.`);
    draft = parseDraftStory(draftText);
  } catch (e) {
    io.err((e as Error).message);
    return 2;
  }
  return scoreAndReport(draft, o, io);
}

/** Score a draft against its reference story and say how it did (exit 1 on an invented field). */
async function scoreAndReport(
  draft: BenchStory,
  o: Omit<BenchStoriesOptions, "draft">,
  io: Output,
  /** Where the draft was written, to say so. */
  written?: string,
): Promise<number> {
  const dir = resolve(o.bench ?? "bench");
  const cache = resolve(o.cache ?? defaultCache());
  let score: StoryScore;
  try {
    const refText = await readFile(join(dir, "stories", `${draft.story}.yaml`), "utf8").catch(
      () => undefined,
    );
    if (refText === undefined)
      throw new Error(
        `There is no reference story ${draft.story} in ${join(dir, "stories")}: the draft's story names the reference it answers.`,
      );
    const ref = parseReferenceStory(refText);
    const known: string[] = [];
    for (const repo of ref.repos) {
      const text = await readFile(join(dir, "references", `${repo}.yaml`), "utf8").catch(
        () => undefined,
      );
      if (text !== undefined) known.push(...benchKnownFields([parseReference(text)]));
    }
    const factFiles = o.facts
      ? [resolve(o.facts)]
      : ref.repos.flatMap((r) => [
          join(cache, r, ".atticus", "facts", `${r}.jsonl`),
          join(cache, "facts", `${r}.jsonl`),
        ]);
    for (const f of factFiles) {
      if (!existsSync(f)) {
        if (o.facts) throw new Error(`There is no facts file at ${f}.`);
        continue;
      }
      const parsed = parseFacts(await readFile(f, "utf8"));
      if (!parsed.ok) throw new Error(`${f} does not read as facts.`);
      known.push(...factFieldNames(parsed.facts));
    }
    score = scoreStory(ref, draft, known);
  } catch (e) {
    io.err((e as Error).message);
    return 2;
  }
  const code = score.invented.length ? 1 : 0;
  if (o.json) {
    io.out(JSON.stringify(score, null, 2));
    return code;
  }
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const row = (what: string, s: { found: number; total: number; coverage: number }) =>
    `${what.padEnd(18)} ${s.found} of ${s.total} (${pct(s.coverage)})`;
  io.out(`Story ${score.story}`);
  if (written) io.out(`Draft: ${written}`);
  io.out(row("Changed steps", score.steps));
  if (score.steps.missed.length) io.out(`  missed: ${score.steps.missed.join(", ")}`);
  if (score.steps.extra.length)
    io.out(`  draft steps no reference step matches: ${score.steps.extra.join(", ")}`);
  io.out(row("Fields", score.fields));
  if (score.fields.missed.length) io.out(`  missed: ${score.fields.missed.join(", ")}`);
  io.out(row("Error cases", score.errors));
  for (const m of score.errors.missed) io.out(`  missed: ${m}`);
  // B-fixes: the same error cases found on any task of the same entry, beside the strict figure.
  io.out(row("  by entry", score.errorsByEntry));
  for (const m of score.errorsByEntry.missed) io.out(`  missed: ${m}`);
  io.out(`${"Invented fields".padEnd(18)} ${score.invented.join(", ") || "none"}`);
  io.out(`${"Rubric sections".padEnd(18)} ${score.sections.present} of ${score.sections.total}`);
  if (score.sections.missing.length) io.out(`  missing: ${score.sections.missing.join(", ")}`);
  if (code)
    io.out(
      "A draft must name only fields the reference, the bench references or the repos' facts know (bench/stories/rubric.md).",
    );
  return code;
}
