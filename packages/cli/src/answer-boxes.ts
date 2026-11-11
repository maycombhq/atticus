import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  addProfileSystem,
  answerQuestion,
  editProfileSystem,
  FileChangedError,
  IGNORE_REASON_MAX,
  ignoredAnswer,
  isAdopted,
  JOIN_STEPS,
  knownTargetNames,
  listQuestions,
  loadOrgPack,
  nameReadsAsSentence,
  namesKnown,
  orgPackDirOf,
  ProfileEditError,
  QuestionError,
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
 * to, its name a sentence by its words (`nameReadsAsSentence`, never by its marks). A system is
 * never judged by the shape of its id: one an option, the picker or an outside system's answer made
 * (named by a host, with the host as its alias) is never a box. A fix writes all of its files or
 * none, and only over the files its preview was made from (`stamp`); a failure never puts back
 * over another writer's change.
 */

export class AnswerBoxError extends Error {
  constructor(
    /**
     * not-found: no such box; bad: the fix can't be made; changed: a file changed since it was read
     * (or since the preview), nothing written; partial: a write failed and some files couldn't be
     * put back (`written` names them); failed: a write failed (EPERM, EBUSY, ENOSPC) and every
     * file the fix wrote was put back, nothing written (`written` is empty).
     */
    readonly code: "not-found" | "bad" | "changed" | "partial" | "failed",
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
  const systems = new Map<string, { name: string; aliases: string[]; profile: string }>();
  for (const p of op?.profiles ?? [])
    for (const s of p.profile?.systems ?? [])
      if (!systems.has(s.id))
        systems.set(s.id, {
          name: s.name,
          aliases: s.aliases,
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
      // words made it, its name a sentence of theirs by its words (never by its marks: "Northwind,
      // Inc." is a name), with no host of its own. One an outside system's answer made (named by
      // a host, the host its alias), or named as a system is ("IT Service Desk", "Plan A"), is
      // real, whatever its id looks like. A topic is no sign: a topics answer's typed words make
      // a system with the topic under its topics.
      if (s.aliases.length || !nameReadsAsSentence(s.name)) continue;
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
  return r.length > IGNORE_REASON_MAX ? `${r.slice(0, IGNORE_REASON_MAX - 4)}...)` : r;
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
 * What a fix wrote to a file, recorded as soon as it is written: the exact text (an answer's, as
 * answerQuestion says it wrote it, before it returns or fails). A put back after a failure
 * touches only a file that still holds that text, so a change someone made just after is kept.
 */
type Wrote = (file: string, text: string) => void;

/** A refusal in words (the route answers 422), not a write that failed. */
const isRefusal = (e: unknown) =>
  e instanceof QuestionError ||
  e instanceof ProfileEditError ||
  e instanceof AnswerBoxError ||
  (e instanceof Error && / would not be valid: /.test(e.message));

/**
 * Write a fix all or none, as far as Atticus can: each file it writes held (`<file>.lock`, which
 * keeps out the other writers that take it; an answer in the CLI or the app takes none), each
 * still as it was read (else nothing is written), then `work`, whose every write is whole and
 * renamed into place (writeFileIfUnchanged) and recorded (`wrote`). Beta.25 (review of beta.24): a
 * failure puts back only a file that still holds what the fix wrote to it; a file someone else
 * changed meanwhile is left as they wrote it, and named. One the fix wrote that can't be put back,
 * or that someone changed after the fix wrote it, is named (`partial`), never said to be unwritten.
 */
async function allOrNone(
  root: string,
  snap: Snap,
  work: (wrote: Wrote) => Promise<void>,
): Promise<void> {
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
    const ours = new Map<string, string>();
    const wrote: Wrote = (file, text) => {
      ours.set(file, text);
    };
    try {
      await work(wrote);
    } catch (e) {
      /** Written by the fix and couldn't be put back; written, then changed by someone else. */
      const kept: string[] = [];
      const over: string[] = [];
      /** Changed by someone else, not by the fix: left as they wrote it. */
      const theirs: string[] = [];
      for (const f of files) {
        const now = await readFile(f, "utf8").catch(() => undefined);
        const was = snap.get(f);
        if (now === was) continue;
        if (!ours.has(f)) theirs.push(relOf(root, f));
        else if (now !== ours.get(f)) over.push(relOf(root, f));
        else
          try {
            if (was === undefined) await rm(f, { force: true });
            else await writeFileIfUnchanged(f, now, was);
          } catch {
            kept.push(relOf(root, f));
          }
      }
      const why =
        e instanceof FileChangedError
          ? `${relOf(root, e.path)} changed since it was read`
          : e instanceof Error
            ? e.message.split("\n")[0]!
            : String(e);
      const them = (l: string[], one: string, many: string) =>
        `${l.join(", ")} ${l.length === 1 ? one : many}`;
      const left = theirs.length
        ? ` ${them(theirs, "was changed by someone else meanwhile: it is left as they wrote it.", "were changed by someone else meanwhile: they are left as they wrote them.")}`
        : "";
      if (kept.length || over.length)
        throw new AnswerBoxError(
          "partial",
          `The fix couldn't be written (${why}).${kept.length ? ` ${them(kept, "couldn't be put back as it was: it is written.", "couldn't be put back as they were: they are written.")}` : ""}${over.length ? ` ${them(over, "was changed by someone else after the fix wrote it, so it is left as it is, the fix's change in it.", "were changed by someone else after the fix wrote them, so they are left as they are, the fix's change in them.")}` : ""}${left} The fix's other files are as they were.`,
          [...kept, ...over].sort(),
        );
      if (e instanceof FileChangedError)
        throw new AnswerBoxError(
          "changed",
          `${relOf(root, e.path)} changed since it was read (another edit, or a person's): nothing of the fix was written, and what it wrote before was put back.${left} Look at the change again and redo it.`,
        );
      if (isRefusal(e)) throw e;
      // Pre-merge review: a write that failed (a skill file's EPERM after the answer's question
      // file was written), everything the fix wrote put back: said, never a raw error.
      throw new AnswerBoxError(
        "failed",
        `The fix couldn't be written (${why}): nothing of it is written, and what it wrote before was put back.${left} Try it again.`,
      );
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
    await allOrNone(root, snap, async (wrote) => {
      // Each file an answer writes is recorded, with its text, as answerQuestion writes it.
      for (const q of qs)
        await answerQuestion(root, q.id, {
          ignore: { reason: ignoreReason(wordsOf(q) ?? "") },
          scope: q.answer!.scope.level,
          ...(q.answer!.scope.level === "repo-type" ? { repoType: q.answer!.scope.id } : {}),
          by: o.by,
          at: o.at,
          wrote,
        });
      if (profile) {
        await writeFileIfUnchanged(profile.file, profile.before, profile.after);
        wrote(profile.file, profile.after);
      }
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
    await allOrNone(root, snap, async (wrote) => {
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
          wrote,
        });
      if (profile) {
        await writeFileIfUnchanged(profile.file, profile.before, profile.after);
        wrote(profile.file, profile.after);
      }
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
