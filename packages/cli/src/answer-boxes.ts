import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  addProfileSystem,
  answerQuestion,
  editProfileSystem,
  FileChangedError,
  ignoredAnswer,
  isAdopted,
  JOIN_STEPS,
  knownTargetNames,
  listQuestions,
  loadOrgPack,
  namesKnown,
  orgPackDirOf,
  questionsDirOf,
  QUICK_WRITE_LOCK,
  readsAsSentence,
  slugify,
  systemNameProblem,
  withSharedFileLock,
  wordsNameNothing,
  writeFileIfUnchanged,
  type Api,
  type Question,
} from "@maycombhq/core";

/**
 * Beta.24 review: the boxes on the map an answer's words made, not a system's name. A person once
 * answered questions about where calls go with words that meant "ignore this" ("ignore this, its
 * cicd related"), and the words became a system with arrows to it. Map › Trust lists each such box
 * (the answers whose words name it, and the system of a profile they made, if any), and puts one
 * right: Ignore (the answers become Ignore and the system leaves its profile) or a rename to a real
 * system. The writes are local in the metarepo, for review in the pull request.
 *
 * Beta.25 (review of beta.24): a box is only what a person's own words made: an answer whose words
 * read as a sentence (`readsAsSentence`), and the system of a profile with the id those words slug
 * to. A system is never judged by the shape of its id: one an option, the picker or an outside
 * system's answer made (named by a host, with the host as its alias) is never a box. A fix writes
 * all of its files or none, and only over the files its preview was made from (`stamp`).
 */

export class AnswerBoxError extends Error {
  constructor(
    /**
     * not-found: no such box; bad: the fix can't be made; changed: a file changed since it was read
     * (or since the preview), nothing written; partial: a write failed and some files couldn't be
     * put back (`written` names them).
     */
    readonly code: "not-found" | "bad" | "changed" | "partial",
    message: string,
    readonly written: string[] = [],
  ) {
    super(message);
  }
}

/** The words an answer gives, or undefined for an option, Ignore or none. */
const wordsOf = (q: Question): string | undefined =>
  q.answer?.text && !ignoredAnswer(q) ? q.answer.text.trim() : undefined;

/** The id the join gives an answer's words (as the target a person named). */
const idOfWords = (words: string) => slugify(words).replace(/\./g, "-");

/** Every box an answer's words made, sorted by id. Files only. */
export async function answerBoxesOf(root: string): Promise<Api.AnswerBoxT[]> {
  const op = await loadOrgPack(orgPackDirOf(root)).catch(() => undefined);
  const prefix = isAdopted(root) ? ".atticus/" : "";
  const systems = new Map<
    string,
    { name: string; aliases: string[]; topics: string[]; profile: string }
  >();
  for (const p of op?.profiles ?? [])
    for (const s of p.profile?.systems ?? [])
      if (!systems.has(s.id))
        systems.set(s.id, {
          name: s.name,
          aliases: s.aliases,
          topics: s.topics ?? [],
          profile: `${prefix}org-pack/profiles/${p.platform}/profile.yaml`,
        });
  const answered = await listQuestions(root, { state: "answered" }).then(
    (l) => l.questions,
    () => [] as Question[],
  );
  const joins = answered.filter((q) => JOIN_STEPS.has(q.askedBy.step) && !!wordsOf(q));
  if (!joins.length) return [];
  const known = await knownTargetNames(root);
  const boxes = new Map<string, Api.AnswerBoxT>();
  for (const q of joins) {
    const words = wordsOf(q)!;
    const id = idOfWords(words);
    const s = systems.get(id);
    let made: typeof s;
    if (s) {
      // The system the answer names (the picker's answer is its id): a box only when a person's
      // words made it, its name a sentence of theirs, with no host or topic of its own. One an
      // outside system's answer made (named by a host, the host its alias), or named as a
      // system is ("IT Service Desk", "Plan A"), is real, whatever its id looks like.
      if (s.aliases.length || s.topics.length || !readsAsSentence(s.name)) continue;
      made = s;
    } else if (!readsAsSentence(words) || namesKnown(known, words)) continue;
    const box = boxes.get(id) ?? {
      id,
      name: made?.name ?? words,
      ...(made ? { profile: made.profile } : {}),
      questions: [],
    };
    box.questions.push({ id: q.id, repo: q.repo, question: q.question });
    boxes.set(id, box);
  }
  return [...boxes.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The box by its id, with the questions that name it, or a not-found refusal. */
async function boxOf(root: string, id: string) {
  const boxes = await answerBoxesOf(root);
  const box = boxes.find((b) => b.id === id);
  if (!box)
    throw new AnswerBoxError(
      "not-found",
      `There is no box made from an answer's words with the id ${id}.`,
    );
  const qs = (await listQuestions(root, { state: "answered" })).questions.filter((q) =>
    box.questions.some((x) => x.id === q.id),
  );
  return { box, boxes, qs };
}

/** The reason an Ignore made from Trust keeps: the person's word, and the answer it replaces. */
const ignoreReason = (was: string) => {
  const r = `It was 'ignore this' (the answer was: ${was})`;
  return r.length > 300 ? `${r.slice(0, 296)}...)` : r;
};

// ------------------------------------------------------------------ all or none

/** A file a fix writes: where it is, and what it held when read (undefined: not there). */
type Snap = Map<string, string | undefined>;

/** The files a fix writes, as they are now: each answer's question file (and skill file), a profile. */
async function snapshot(root: string, qs: readonly Question[], more: readonly string[]) {
  const files = new Set<string>(more);
  for (const q of qs) {
    files.add(join(questionsDirOf(root), `${q.id}.yaml`));
    if (q.answer?.skill) files.add(join(root, ...q.answer.skill.split("/")));
  }
  const snap: Snap = new Map();
  for (const f of [...files].sort()) snap.set(f, await readFile(f, "utf8").catch(() => undefined));
  return snap;
}

/** What the preview was made from: one hash of every file the fix writes, as it was read. */
function stampOf(root: string, snap: Snap): string {
  const h = createHash("sha256");
  for (const [f, text] of snap)
    h.update(`${relative(root, f).split("\\").join("/")}\0${text ?? "\u0001"}\0`);
  return h.digest("hex").slice(0, 16);
}

const relOf = (root: string, f: string) => relative(root, f).split("\\").join("/");

/**
 * Write a fix all or none: every file it writes held (`<file>.lock`), each still as it was read
 * (else nothing is written), then `work`, whose every write is whole and renamed into place
 * (writeFileIfUnchanged). A failure puts back each file written, as it was; one that can't be put
 * back is named (`partial`), never said to be unwritten.
 */
async function allOrNone(root: string, snap: Snap, work: () => Promise<void>): Promise<void> {
  const files = [...snap.keys()];
  const hold = (i: number): Promise<void> =>
    i < files.length
      ? withSharedFileLock(files[i]!, () => hold(i + 1), {
          ...QUICK_WRITE_LOCK,
          what: "fix of a box made from an answer's words",
        })
      : run();
  const run = async () => {
    for (const f of files)
      if ((await readFile(f, "utf8").catch(() => undefined)) !== snap.get(f))
        throw new AnswerBoxError(
          "changed",
          `${relOf(root, f)} changed since it was read (another edit, or a person's): nothing was written. Look at the change again and redo it.`,
        );
    try {
      await work();
    } catch (e) {
      const kept: string[] = [];
      for (const f of files) {
        const now = await readFile(f, "utf8").catch(() => undefined);
        const was = snap.get(f);
        if (now === was) continue;
        try {
          if (was === undefined) await rm(f, { force: true });
          else await writeFileIfUnchanged(f, now, was);
        } catch {
          kept.push(relOf(root, f));
        }
      }
      const why = e instanceof Error ? e.message.split("\n")[0]! : String(e);
      if (kept.length)
        throw new AnswerBoxError(
          "partial",
          `The fix couldn't be written (${why}), and ${kept.join(", ")} couldn't be put back as ${kept.length === 1 ? "it was: it is" : "they were: they are"} written, the other files are not.`,
          kept,
        );
      if (e instanceof FileChangedError)
        throw new AnswerBoxError(
          "changed",
          `${relOf(root, e.path)} changed since it was read (another edit, or a person's): nothing was written, and what was written before it was put back. Look at the change again and redo it.`,
        );
      throw e;
    }
  };
  await hold(0);
}

/** A write asked for over files that changed since its preview: nothing is written. */
function checkStamp(root: string, snap: Snap, stamp: string | undefined): string {
  const now = stampOf(root, snap);
  if (stamp !== undefined && stamp !== now)
    throw new AnswerBoxError(
      "changed",
      "The files this fix writes changed since its preview (another edit, or a person's): nothing was written. Look at the preview again.",
    );
  return now;
}

// ------------------------------------------------------------------ the fixes

/**
 * "It was 'ignore this'": each answer that names the box becomes Ignore, and the system leaves
 * the profile that has it. `preview` writes nothing; a write with the preview's `stamp` writes
 * only over the files the preview was made from.
 */
export async function ignoreAnswerBox(
  root: string,
  id: string,
  o: { by: string; at: string; preview?: boolean; stamp?: string },
): Promise<Api.AnswerBoxResultT> {
  const { box, qs } = await boxOf(root, id);
  const answers = qs.map((q) => ({
    id: q.id,
    repo: q.repo,
    was: wordsOf(q) ?? "",
    now: `Ignore: ${ignoreReason(wordsOf(q) ?? "")}`,
  }));
  // The profile's change, worked out (and checked) before anything is written.
  const profile = box.profile
    ? await editProfileSystem(root, box.id, { preview: true })
    : undefined;
  const snap = await snapshot(root, qs, profile ? [profile.file] : []);
  const stamp = checkStamp(root, snap, o.stamp);
  if (!o.preview)
    await allOrNone(root, snap, async () => {
      for (const q of qs)
        await answerQuestion(root, q.id, {
          ignore: { reason: ignoreReason(wordsOf(q) ?? "") },
          scope: q.answer!.scope.level,
          ...(q.answer!.scope.level === "repo-type" ? { repoType: q.answer!.scope.id } : {}),
          by: o.by,
          at: o.at,
        });
      if (profile) await writeFileIfUnchanged(profile.file, profile.before, profile.after);
    });
  return {
    id: box.id,
    written: !o.preview,
    answers,
    ...(profile ? { profile: { path: profile.profile, changes: profile.changes } } : {}),
    repos: [...new Set(qs.map((q) => q.repo))].sort(),
    stamp,
  };
}

/**
 * "Rename to a real system": a repo or system Atticus knows (never a box made from words, this one
 * or another), or a new outside system's short name (the box's own system renamed, or added for
 * the answers' repo when the profiles have none). The answers that name the box name it instead.
 * `preview` writes nothing; a write with the preview's `stamp` writes only over its files.
 */
export async function renameAnswerBox(
  root: string,
  id: string,
  name: string,
  o: { by: string; at: string; preview?: boolean; stamp?: string },
): Promise<Api.AnswerBoxResultT> {
  const { box, boxes, qs } = await boxOf(root, id);
  const want = name.trim();
  const others = new Set(boxes.map((b) => b.id));
  if (
    [slugify(want), idOfWords(want)].includes(box.id) ||
    want.toLowerCase() === box.name.trim().toLowerCase()
  )
    throw new AnswerBoxError(
      "bad",
      `"${want}" is the box's own name, which names nothing real: give a repo or system it is, or a new system's short name.`,
    );
  const known = namesKnown(await knownTargetNames(root, { except: others }), want);
  if (!known) {
    const why = systemNameProblem(want);
    if (why) throw new AnswerBoxError("bad", `${wordsNameNothing(want)} (${why})`);
    if (others.has(slugify(want)))
      throw new AnswerBoxError(
        "bad",
        `"${want}" is another box made from an answer's words: give a repo or system it is, or a new system's short name.`,
      );
  }
  const to = known ? want : slugify(want);
  // The profile's change, worked out (and checked) before anything is written: a known one takes
  // the box's place (the box's system leaves); else the system is renamed in place, or added.
  let profile:
    | {
        profile: string;
        changes: { was?: string; now?: string }[];
        file: string;
        before: string | undefined;
        after: string;
      }
    | undefined;
  if (box.profile)
    profile = await editProfileSystem(
      root,
      box.id,
      known ? { preview: true } : { preview: true, rename: { id: to, name: want } },
    );
  else if (!known && qs[0]) {
    const r = await addProfileSystem(
      root,
      qs[0].repo,
      { id: to, name: want, boundary: "vendor" },
      { preview: true },
    );
    if (r.write) profile = { profile: r.profile, changes: r.changes ?? [], ...r.write };
  }
  const snap = await snapshot(root, qs, profile ? [profile.file] : []);
  const stamp = checkStamp(root, snap, o.stamp);
  if (!o.preview)
    await allOrNone(root, snap, async () => {
      for (const q of qs)
        await answerQuestion(root, q.id, {
          text: to,
          // A new system the profile gains is named by the answer, so it isn't refused.
          ...(known ? {} : { adds: to }),
          scope: q.answer!.scope.level,
          ...(q.answer!.scope.level === "repo-type" ? { repoType: q.answer!.scope.id } : {}),
          ...(q.answer!.match ? { match: q.answer!.match } : {}),
          by: o.by,
          at: o.at,
        });
      if (profile) await writeFileIfUnchanged(profile.file, profile.before, profile.after);
    });
  return {
    id: box.id,
    written: !o.preview,
    answers: qs.map((q) => ({ id: q.id, repo: q.repo, was: wordsOf(q) ?? "", now: to })),
    ...(profile ? { profile: { path: profile.profile, changes: profile.changes } } : {}),
    repos: [...new Set(qs.map((q) => q.repo))].sort(),
    stamp,
  };
}
