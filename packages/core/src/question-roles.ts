import { BUILT_IN_ROLES } from "./schema/orgpack.js";
import { QUESTION_ROLES, type Question, type QuestionRole } from "./schema/question.js";

/**
 * ADR 0181 part 4: each role answers its own questions. A change flows product owner (Define) →
 * architect (Design) → business analyst (Plan's stories) → tech lead (Plan's tasks, Build), and
 * every question a phase raises is owned by that phase's role: product, architecture, analysis or
 * delivery. The role is written on a question when it is raised (question schema version 5); an
 * older file's is derived here, from the step that asked, on read. Words, not permissions.
 */

/** The role of each of a change's stages and phases, as a step (`change-<stage>`) names it. */
const STAGE_ROLE: Readonly<Record<string, QuestionRole>> = {
  feature: "product",
  define: "product",
  brief: "product",
  architecture: "architecture",
  design: "architecture",
  // A small change's one stage places it and designs it: the architect's.
  small: "architecture",
  stories: "analysis",
  plan: "analysis",
  tasks: "delivery",
  build: "delivery",
  task: "delivery",
};

/** The stage a stage's rerun command names (`atticus change architecture <id>`, `atticus plan stories <id>`). */
function stageOfCommand(command: string): string | undefined {
  const w = command.trim().split(/\s+/);
  if (w[0] !== "atticus") return undefined;
  if (w[1] === "change" || w[1] === "plan") return w[2];
  if (w[1] === "task") return "task";
  return undefined;
}

/**
 * The role that owns what a step asks: the stage's own for a change's stage (`change-feature`,
 * `change-stories`, a task's run), else, for a step that serves every stage (a context gap, a
 * knowledge conflict), the stage its rerun command names. Undefined outside a change's phases.
 */
export function roleOfStep(step: string, rerun?: string): QuestionRole | undefined {
  const m = /^change-([a-z]+)$/.exec(step);
  if (m) return STAGE_ROLE[m[1]!];
  if (/^task-/.test(step)) return "delivery";
  const stage = rerun === undefined ? undefined : stageOfCommand(rerun);
  return stage === undefined ? undefined : STAGE_ROLE[stage];
}

/** A question's role: its own (version 5), else derived from the step that asked and its rerun. */
export function roleOfQuestion(
  q: Pick<Question, "askedBy" | "rerun"> & { role?: QuestionRole | undefined },
): QuestionRole | undefined {
  return q.role ?? roleOfStep(q.askedBy.step, q.rerun);
}

/** What each of the built-in roles change.yaml's `owners` names does on a change, as a question role. */
const OWNER_ROLE: Readonly<Record<string, QuestionRole>> = {
  "product-owner": "product",
  "process-owner": "product",
  designer: "product",
  architect: "architecture",
  "data-architect": "architecture",
  "security-reviewer": "architecture",
  "business-analyst": "analysis",
  "team-lead": "delivery",
  // Not a built-in role id, but the words people write in change.yaml for the same person.
  "tech-lead": "delivery",
  developer: "delivery",
  "delivery-lead": "delivery",
};

/** A custom role of roles.yaml (`custom`): its id and the built-in role it is based on. */
export interface CustomRole {
  id: string;
  basedOn: (typeof BUILT_IN_ROLES)[number] | string;
}

/** The question role of an owner key in change.yaml (`architect`, or a custom role of roles.yaml). */
export function roleOfOwner(
  key: string,
  custom: readonly CustomRole[] = [],
): QuestionRole | undefined {
  const k = key.trim().toLowerCase();
  if (OWNER_ROLE[k]) return OWNER_ROLE[k];
  const c = custom.find((x) => x.id === k);
  return c ? OWNER_ROLE[c.basedOn] : undefined;
}

const handleKey = (h: string) => h.trim().replace(/^@/, "").toLowerCase();

/**
 * The roles a person has on a change: every owner key of its change.yaml that names them, as a
 * question role, once each, in the order of the phases.
 */
export function rolesOfPerson(
  handle: string,
  owners: Readonly<Record<string, readonly string[]>>,
  custom: readonly CustomRole[] = [],
): QuestionRole[] {
  const k = handleKey(handle);
  const out = new Set<QuestionRole>();
  for (const [key, people] of Object.entries(owners))
    if (people.some((p) => handleKey(p) === k)) {
      const r = roleOfOwner(key, custom);
      if (r) out.add(r);
    }
  return QUESTION_ROLES.filter((r) => out.has(r));
}
