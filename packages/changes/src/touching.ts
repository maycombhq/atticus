import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { changeFolder, changeStore } from "./store.js";

/** One place in an open change's files that names the id asked about. */
export interface ChangeTouchPlace {
  /** The change's file, relative to its folder: `tasks.md` or `target-flows/<flow>.yaml`. */
  file: string;
  line: number;
  /** In tasks.md: the `## <repo>` heading the place is under (or is). */
  heading?: string;
  /** In tasks.md: the task's id, for a task line. */
  task?: string;
  /** For a `## <id>` heading: the ids of the tasks under it. */
  tasks?: string[];
  /** The line as written, trimmed. */
  text: string;
}

/**
 * An open change whose tasks.md or target flows name an id (ADR 0201 addendum, 2026-11-22): the
 * answer `conflicts <id>` adds to its pairs, so a change still being written (not open yet) sees
 * the open changes with work where it plans its own.
 */
export interface ChangeTouch {
  change: string;
  touches: string;
  where: ChangeTouchPlace[];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The id as a word of its own: not inside a longer id (`forge-svc-010`, `my-forge-svc-01`), though
 * a record of it (`forge-svc-01.put-refund-2`) and a possessive (`forge-svc-01's`) name it.
 */
const namesId = (id: string) => new RegExp(`(?<![A-Za-z0-9_.-])${escape(id)}(?![A-Za-z0-9_-])`);

async function read(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

/** Where a tasks.md names the id: a `## <id>` heading (with its tasks), and each task that names it. */
export function tasksNaming(tasks: string, id: string): ChangeTouchPlace[] {
  const word = namesId(id);
  const out: ChangeTouchPlace[] = [];
  let heading: string | undefined;
  let under: ChangeTouchPlace | undefined;
  let fence = false;
  tasks.split(/\r?\n/).forEach((raw, i) => {
    const l = raw.trimEnd();
    if (/^\s{0,3}(```|~~~)/.test(l)) fence = !fence;
    if (fence) return;
    const h = /^##\s+`?([^`\s]+)`?\s*$/.exec(l);
    if (h) {
      heading = h[1]!;
      under = undefined;
      if (heading === id) {
        under = { file: "tasks.md", line: i + 1, heading, tasks: [], text: l.trim() };
        out.push(under);
      }
      return;
    }
    if (/^#{1,2}\s/.test(l)) {
      heading = undefined;
      under = undefined;
      return;
    }
    const t = /^\s*-\s+\[[ xX]\]\s+(\S+)/.exec(l);
    if (!t) return;
    if (under) under.tasks!.push(t[1]!);
    else if (word.test(l))
      out.push({
        file: "tasks.md",
        line: i + 1,
        ...(heading ? { heading } : {}),
        task: t[1]!,
        text: l.trim(),
      });
  });
  return out;
}

/** Each line of a target flow that names the id (its flow, repo, a step's component or entry). */
export function flowNaming(file: string, text: string, id: string): ChangeTouchPlace[] {
  const word = namesId(id);
  const out: ChangeTouchPlace[] = [];
  text.split(/\r?\n/).forEach((l, i) => {
    if (/^\s*#/.test(l)) return;
    if (word.test(l)) out.push({ file, line: i + 1, text: l.trim() });
  });
  return out;
}

/**
 * Every open change (anything not archived) whose tasks.md or target flows name the id, in id
 * order, each with where. Read-only: the change files only.
 */
export async function changesTouching(root: string, id: string): Promise<ChangeTouch[]> {
  const open = (await changeStore(root).list())
    .filter((c) => c.state !== "archived")
    .map((c) => c.id)
    .sort();
  const out: ChangeTouch[] = [];
  for (const c of open) {
    const dir = changeFolder(root, c);
    const where = tasksNaming(await read(join(dir, "tasks.md")), id);
    const flows = (await readdir(join(dir, "target-flows")).catch(() => [] as string[]))
      .filter((f) => f.endsWith(".yaml"))
      .sort();
    for (const f of flows)
      where.push(...flowNaming(`target-flows/${f}`, await read(join(dir, "target-flows", f)), id));
    if (where.length) out.push({ change: c, touches: id, where });
  }
  return out;
}

/** A place as one short cite: `tasks.md:15 ## forge-svc-01 (t5)`, `tasks.md:9 t3 (## forge-deploy)`. */
export function touchPlaceLine(p: ChangeTouchPlace): string {
  if (p.tasks)
    return `${p.file}:${p.line} ## ${p.heading}${p.tasks.length ? ` (${p.tasks.join(", ")})` : ""}`;
  if (p.task)
    return `${p.file}:${p.line} task ${p.task}${p.heading ? ` under ## ${p.heading}` : ""}`;
  return `${p.file}:${p.line}`;
}
