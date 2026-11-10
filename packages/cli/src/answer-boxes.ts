import {
  addProfileSystem,
  answerQuestion,
  editProfileSystem,
  ignoredAnswer,
  isAdopted,
  JOIN_STEPS,
  listQuestions,
  loadOrgPack,
  madeFromWords,
  namesKnownTarget,
  orgPackDirOf,
  slugify,
  systemNameProblem,
  wordsNameNothing,
  type Api,
  type Question,
} from "@maycombhq/core";

/**
 * Beta.24 review: the boxes on the map an answer's words made, not a system's name. A person once
 * answered questions about where calls go with words that meant "ignore this" ("ignore this, its
 * cicd related"), and the words became a system with arrows to it. Map › Trust lists each such box
 * (a system of a profile, the answers whose words name it, or both), and puts one right: Ignore
 * (the answers become Ignore and the system leaves its profile) or a rename to a real system. The
 * writes are local in the metarepo, for review in the pull request.
 */

export class AnswerBoxError extends Error {
  constructor(
    readonly code: "not-found" | "bad",
    message: string,
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
  const boxes = new Map<string, Api.AnswerBoxT>();
  const prefix = isAdopted(root) ? ".atticus/" : "";
  for (const p of op?.profiles ?? [])
    for (const s of p.profile?.systems ?? [])
      if (madeFromWords(s.id, s.name))
        boxes.set(s.id, {
          id: s.id,
          name: s.name,
          profile: `${prefix}org-pack/profiles/${p.platform}/profile.yaml`,
          questions: [],
        });
  const answered = await listQuestions(root, { state: "answered" }).then(
    (l) => l.questions,
    () => [] as Question[],
  );
  for (const q of answered) {
    if (!JOIN_STEPS.has(q.askedBy.step)) continue;
    const words = wordsOf(q);
    if (!words) continue;
    // A picker's answer is the system's id; a person's words slug to the id the join gave them.
    const id = boxes.has(words) ? words : idOfWords(words);
    if (!boxes.has(id) && !madeFromWords(id, words)) continue;
    const box = boxes.get(id) ?? { id, name: words, questions: [] };
    box.questions.push({ id: q.id, repo: q.repo, question: q.question });
    boxes.set(id, box);
  }
  return [...boxes.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The box by its id, with the questions that name it, or a not-found refusal. */
async function boxOf(root: string, id: string) {
  const box = (await answerBoxesOf(root)).find((b) => b.id === id);
  if (!box)
    throw new AnswerBoxError(
      "not-found",
      `There is no box made from an answer's words with the id ${id}.`,
    );
  const qs = (await listQuestions(root, { state: "answered" })).questions.filter((q) =>
    box.questions.some((x) => x.id === q.id),
  );
  return { box, qs };
}

/** The reason an Ignore made from Trust keeps: the person's word, and the answer it replaces. */
const ignoreReason = (was: string) => {
  const r = `It was 'ignore this' (the answer was: ${was})`;
  return r.length > 300 ? `${r.slice(0, 296)}...)` : r;
};

/**
 * "It was 'ignore this'": each answer that names the box becomes Ignore, and the system leaves
 * the profile that has it. `preview` writes nothing.
 */
export async function ignoreAnswerBox(
  root: string,
  id: string,
  o: { by: string; at: string; preview?: boolean },
): Promise<Api.AnswerBoxResultT> {
  const { box, qs } = await boxOf(root, id);
  const answers = qs.map((q) => ({
    id: q.id,
    repo: q.repo,
    was: wordsOf(q) ?? "",
    now: `Ignore: ${ignoreReason(wordsOf(q) ?? "")}`,
  }));
  // The answers first: one that can't be written leaves the profile as it was.
  if (!o.preview)
    for (const q of qs)
      await answerQuestion(root, q.id, {
        ignore: { reason: ignoreReason(wordsOf(q) ?? "") },
        scope: q.answer!.scope.level,
        ...(q.answer!.scope.level === "repo-type" ? { repoType: q.answer!.scope.id } : {}),
        by: o.by,
        at: o.at,
      });
  const profile = box.profile
    ? await editProfileSystem(root, box.id, o.preview ? { preview: true } : {})
    : undefined;
  return {
    id: box.id,
    written: !o.preview,
    answers,
    ...(profile ? { profile: { path: profile.profile, changes: profile.changes } } : {}),
    repos: [...new Set(qs.map((q) => q.repo))].sort(),
  };
}

/**
 * "Rename to a real system": a repo or system Atticus knows, or a new outside system's short name
 * (the box's own system renamed, or added for the answers' repo when the profiles have none). The
 * answers that name the box name it instead. `preview` writes nothing.
 */
export async function renameAnswerBox(
  root: string,
  id: string,
  name: string,
  o: { by: string; at: string; preview?: boolean },
): Promise<Api.AnswerBoxResultT> {
  const { box, qs } = await boxOf(root, id);
  const want = name.trim();
  const known = await namesKnownTarget(root, want);
  if (!known) {
    const why = systemNameProblem(want);
    if (why) throw new AnswerBoxError("bad", `${wordsNameNothing(want)} (${why})`);
  }
  const to = known ? want : slugify(want);
  if (to === box.id && !known)
    throw new AnswerBoxError("bad", `${want} is the box's own id: give it a real system's name.`);
  // The answers first (naming the system the profile gains, `adds`): one that can't be written
  // leaves the profile as it was.
  if (!o.preview)
    for (const q of qs)
      await answerQuestion(root, q.id, {
        text: to,
        adds: to,
        scope: q.answer!.scope.level,
        ...(q.answer!.scope.level === "repo-type" ? { repoType: q.answer!.scope.id } : {}),
        ...(q.answer!.match ? { match: q.answer!.match } : {}),
        by: o.by,
        at: o.at,
      });
  let profile: { profile: string; changes: { was?: string; now?: string }[] } | undefined;
  const preview = o.preview ? { preview: true } : {};
  if (box.profile)
    // A known one takes the box's place: the box's system leaves; else it is renamed in place.
    profile = await editProfileSystem(
      root,
      box.id,
      known ? preview : { ...preview, rename: { id: to, name: want } },
    );
  else if (!known && qs[0])
    profile = await addProfileSystem(
      root,
      qs[0].repo,
      { id: to, name: want, boundary: "vendor" },
      preview,
    ).then((r) => ({ profile: r.profile, changes: r.changes ?? [] }));
  return {
    id: box.id,
    written: !o.preview,
    answers: qs.map((q) => ({ id: q.id, repo: q.repo, was: wordsOf(q) ?? "", now: to })),
    ...(profile ? { profile: { path: profile.profile, changes: profile.changes } } : {}),
    repos: [...new Set(qs.map((q) => q.repo))].sort(),
  };
}
