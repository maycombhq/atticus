import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import {
  changesDirOf,
  orgPackDirOf,
  QUESTION_ROLES,
  roleOfQuestion,
  roleOfStep,
  rolesOfPerson,
  type CustomRole,
  type Question,
  type QuestionRole,
} from "@maycombhq/core";

/**
 * ADR 0181 part 4: each role answers its own questions, so Home and Questions can show each person
 * their role's questions for a change. Files only: the questions, each change's stage loop files
 * (stage/<stage>.yaml, whose `questions` a stage raised under the repos they are about), its
 * change.yaml `owners`, and roles.yaml's custom roles. Words, not permissions.
 */

/** A change's stages whose loop file lists the questions it raised. */
const STAGE_FILES = ["feature", "architecture", "stories", "small"] as const;

const yamlOf = async (path: string): Promise<unknown> => {
  const text = await readFile(path, "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  try {
    return parse(text);
  } catch {
    return undefined;
  }
};

/**
 * The questions each change's stages raised, by question id: the change and the stage's role.
 * A stage files a question under the repo it is about, so its own loop file is what ties it to
 * the change (as the cockpit counts them).
 */
export async function stageQuestions(
  root: string,
  only?: string,
): Promise<Map<string, { change: string; role: QuestionRole | undefined }>> {
  const out = new Map<string, { change: string; role: QuestionRole | undefined }>();
  const changes = only
    ? [only]
    : await readdir(changesDirOf(root), { withFileTypes: true }).then(
        (d) => d.filter((x) => x.isDirectory()).map((x) => x.name),
        () => [] as string[],
      );
  for (const change of changes.sort())
    for (const stage of STAGE_FILES) {
      const y = (await yamlOf(join(changesDirOf(root), change, "stage", `${stage}.yaml`))) as {
        questions?: unknown;
      } | null;
      const ids = Array.isArray(y?.questions) ? y.questions : [];
      for (const id of ids)
        if (typeof id === "string" && !out.has(id))
          out.set(id, { change, role: roleOfStep(`change-${stage}`) });
    }
  return out;
}

/**
 * A question's role: its own or its step's (`roleOfQuestion`), else the role of the stage whose
 * loop file lists it.
 */
export function roleWithStage(
  q: Question,
  stages: ReadonlyMap<string, { role: QuestionRole | undefined }>,
): QuestionRole | undefined {
  return roleOfQuestion(q) ?? stages.get(q.id)?.role;
}

/** Whether a question belongs to a change: filed under it, raised by its stages, or resting on it. */
export function isChangeQuestion(
  q: Question,
  change: string,
  o: {
    stages: ReadonlyMap<string, { change: string }>;
    restsOn?: readonly string[] | undefined;
  },
): boolean {
  return (
    q.repo === change || o.stages.get(q.id)?.change === change || !!o.restsOn?.includes(change)
  );
}

/** The custom roles roles.yaml names, each with the built-in role it is based on; none when it doesn't read. */
async function customRoles(root: string): Promise<CustomRole[]> {
  const y = (await yamlOf(join(orgPackDirOf(root), "roles.yaml"))) as { custom?: unknown } | null;
  if (!Array.isArray(y?.custom)) return [];
  return y.custom.flatMap((c: unknown) => {
    const x = c as { id?: unknown; basedOn?: unknown } | null;
    return typeof x?.id === "string" && typeof x.basedOn === "string"
      ? [{ id: x.id, basedOn: x.basedOn }]
      : [];
  });
}

/**
 * The person's roles on a change, from its change.yaml `owners` (role → people) and roles.yaml's
 * custom roles: none when the change doesn't name them, so the app asks which role is theirs.
 */
export async function personsRoles(
  root: string,
  change: string,
  handle: string | undefined,
): Promise<QuestionRole[]> {
  if (!handle) return [];
  const y = (await yamlOf(join(changesDirOf(root), change, "change.yaml"))) as {
    owners?: unknown;
  } | null;
  const owners = y?.owners;
  if (!owners || typeof owners !== "object" || Array.isArray(owners)) return [];
  const lists: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(owners as Record<string, unknown>))
    if (Array.isArray(v)) lists[k] = v.filter((h): h is string => typeof h === "string");
  return rolesOfPerson(handle, lists, await customRoles(root));
}

export type RoleCounts = Partial<
  Record<QuestionRole, { open: number; answered: number; retired: number; total: number }>
>;

/** The questions by role and state; a role no question has is left out. */
export function countByRole(
  questions: readonly Question[],
  roleOf: (q: Question) => QuestionRole | undefined,
): RoleCounts {
  const out: RoleCounts = {};
  for (const r of QUESTION_ROLES) {
    const of = questions.filter((q) => roleOf(q) === r);
    if (!of.length) continue;
    const k = (s: string) => of.filter((q) => q.state === s).length;
    out[r] = { open: k("open"), answered: k("answered"), retired: k("retired"), total: of.length };
  }
  return out;
}
