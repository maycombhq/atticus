import { RecordId } from "./schema/common.js";

/**
 * Branch naming (frozen in the build specification):
 * - `change/<change-id>` in each code repo a change touches
 * - `task/<change-id>/<task-id>` for an AI task run, merged into the change branch by PR
 * - `handoff/<change-id>/<phase>` for a hand-off PR in the metarepo
 *
 * `change/x` and `change/x/y` can't both exist in one repo (Git stores refs as paths),
 * which is why task branches have their own prefix.
 */
export type BranchKind = "change" | "task" | "handoff";

export interface ParsedBranch {
  kind: BranchKind;
  change: string;
  task?: string;
  phase?: string;
}

function segment(name: string, value: string): string {
  const r = RecordId.safeParse(value);
  if (!r.success)
    throw new Error(`${name} "${value}" must be a lowercase slug (a-z, 0-9, '.', '_', '-')`);
  if (value.endsWith(".lock") || value.includes("..")) {
    throw new Error(`${name} "${value}" can't be used in a Git branch name`);
  }
  return value;
}

export function changeBranch(changeId: string): string {
  return `change/${segment("change id", changeId)}`;
}

export function taskBranch(changeId: string, taskId: string): string {
  return `task/${segment("change id", changeId)}/${segment("task id", taskId)}`;
}

export function handoffBranch(changeId: string, phase: string): string {
  return `handoff/${segment("change id", changeId)}/${segment("phase", phase)}`;
}

/** Parse an Atticus branch name; returns undefined for any other branch. */
export function parseBranch(branch: string): ParsedBranch | undefined {
  const parts = branch.split("/");
  const ok = (s: string | undefined) => s !== undefined && RecordId.safeParse(s).success;
  if (parts[0] === "change" && parts.length === 2 && ok(parts[1])) {
    return { kind: "change", change: parts[1]! };
  }
  if (parts[0] === "task" && parts.length === 3 && ok(parts[1]) && ok(parts[2])) {
    return { kind: "task", change: parts[1]!, task: parts[2]! };
  }
  if (parts[0] === "handoff" && parts.length === 3 && ok(parts[1]) && ok(parts[2])) {
    return { kind: "handoff", change: parts[1]!, phase: parts[2]! };
  }
  return undefined;
}
