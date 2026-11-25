/**
 * ADR 0201 decision 3, waves: a task that says `(after <task id>)` in tasks.md waits, across
 * repos, for each task it names. What holds a task for ever is named: an id tasks.md doesn't
 * have, a task id used twice, and tasks that each wait for the other, by `(after …)` alone or
 * by `(after …)` against the order of a repo's tasks. Pure: tasks.md is read by the caller.
 */

/** A task as the waves read it (ReadyInput is one). */
export interface WaveTask {
  id: string;
  repo: string;
  done: boolean;
  /** tasks.md marks it [P]: it may go with the [P] tasks next to it in its repo. */
  parallel?: boolean | undefined;
  /** The tasks its line names in `(after …)`. */
  after?: readonly string[] | undefined;
}

/**
 * Ninth UX walk: the not-done tasks before `t` in its own repo, in tasks.md order. A [P] task
 * doesn't wait for the [P] tasks right before it in its repo (they go together), only for what is
 * before them.
 */
export function sameRepoBefore<T extends WaveTask>(tasks: readonly T[], t: T): string[] {
  const mine = tasks.slice(0, tasks.indexOf(t)).filter((x) => x.repo === t.repo);
  let cut = mine.length;
  if (t.parallel) while (cut > 0 && mine[cut - 1]!.parallel) cut--;
  return mine
    .slice(0, cut)
    .filter((x) => !x.done)
    .map((x) => x.id);
}

const tasksWord = (ids: readonly string[]) => (ids.length === 1 ? "task" : "tasks");

/** The tasks each not-done task reaches by `edges`, itself included when it is in a ring. */
function reached(
  open: ReadonlyMap<string, WaveTask>,
  edges: (t: WaveTask) => readonly string[],
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [from, t] of open) {
    const seen = new Set<string>();
    const todo = [...edges(t)];
    while (todo.length) {
      const id = todo.pop()!;
      if (seen.has(id) || !open.has(id)) continue;
      seen.add(id);
      todo.push(...edges(open.get(id)!));
    }
    out.set(from, seen);
  }
  return out;
}

/** Of the tasks that reach themselves, each with the others of its ring, in tasks.md order. */
function ringsOf(reach: ReadonlyMap<string, Set<string>>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [id, r] of reach)
    if (r.has(id))
      out.set(
        id,
        [...reach.keys()].filter((x) => x !== id && r.has(x) && reach.get(x)!.has(id)),
      );
  return out;
}

/**
 * Why a task is never ready as tasks.md stands, by task (the task itself, since an id may be used
 * twice): its id is used twice; it names a task tasks.md doesn't have; or it and other tasks each
 * wait for the other. A ticked task waits for nothing, so it breaks a ring.
 */
export function neverReady<T extends WaveTask>(tasks: readonly T[]): Map<T, string> {
  const out = new Map<T, string>();
  const count = new Map<string, number>();
  for (const t of tasks) count.set(t.id, (count.get(t.id) ?? 0) + 1);
  const open = new Map<string, WaveTask>(tasks.filter((t) => !t.done).map((t) => [t.id, t]));
  const byAfter = ringsOf(reached(open, (t) => t.after ?? []));
  const byOrder = ringsOf(
    reached(open, (t) => [...(t.after ?? []), ...sameRepoBefore(tasks, t as T)]),
  );
  for (const t of tasks) {
    if (t.done) continue;
    const unknown = [...new Set(t.after ?? [])].filter((id) => !count.has(id));
    const ring = byAfter.get(t.id);
    const mixed = byOrder.get(t.id);
    if (count.get(t.id)! > 1)
      out.set(t, `its id ${t.id} is used twice in tasks.md: give each task its own id`);
    else if (unknown.length)
      out.set(
        t,
        `it names ${tasksWord(unknown)} ${unknown.join(", ")} in (after …), which tasks.md doesn't have`,
      );
    else if (ring)
      out.set(
        t,
        ring.length
          ? `it and ${tasksWord(ring)} ${ring.join(", ")} each wait for the other in (after …)`
          : "it names itself in (after …)",
      );
    else if (mixed)
      out.set(
        t,
        `it and ${tasksWord(mixed)} ${mixed.join(", ")} each wait for the other, by (after …) and by their order in tasks.md`,
      );
  }
  return out;
}

/** The not-ticked tasks a task's line names in `(after …)`, in the order it names them. */
export function afterWaits<T extends WaveTask>(tasks: readonly T[], t: T): string[] {
  return [...new Set(t.after ?? [])].filter(
    (id) => id !== t.id && tasks.some((x) => x.id === id && !x.done),
  );
}

/**
 * Why `(after …)` holds one task, for a person who runs it by itself (`atticus task run`): what
 * never lets it run (`never`, a tasks.md to fix), else the named tasks to tick first, which the
 * run goes ahead with as an open item (ADR 0210 part 7). Undefined when nothing it names holds
 * it; the order of its own repo's tasks doesn't hold a task a person chose to run.
 */
export function afterHold<T extends WaveTask>(
  tasks: readonly T[],
  t: T,
): { why: string; fix: string; never?: true } | undefined {
  const never = neverReady(tasks).get(t);
  if (never) return { why: never, fix: "Fix tasks.md, then run it again.", never: true };
  const waits = afterWaits(tasks, t);
  if (!waits.length) return undefined;
  return {
    why: `it waits for ${tasksWord(waits)} ${waits.join(", ")} (after) to be done first`,
    fix: `It runs once ${waits.length === 1 ? "that is" : "those are"} ticked in tasks.md.`,
  };
}
