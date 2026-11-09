import { BUILT_IN_ROLES } from "./schema/orgpack.js";
import {
  QUESTION_ROLES,
  type Question,
  type QuestionAsks,
  type QuestionRole,
} from "./schema/question.js";

/**
 * ADR 0181 part 4: each role answers its own questions. A change flows product owner (Define: the
 * brief) → architect (the feature stage, which places the change on the estate, and Design) →
 * business analyst (Plan's stories) → tech lead (Plan's tasks, Build), and
 * every question a phase raises is owned by that phase's role: product, architecture, analysis or
 * delivery. The role is written on a question when it is raised (question schema version 5); an
 * older file's is derived here, from the step that asked, on read. Words, not permissions.
 */

/** The role of each of a change's stages and phases, as a step (`change-<stage>`) names it. */
const STAGE_ROLE: Readonly<Record<string, QuestionRole>> = {
  define: "product",
  brief: "product",
  // Ninth UX walk: the feature stage places the change on the estate; ADR 0181 gives that to the
  // architect ("The architect places it on the estate and decides the design").
  feature: "architecture",
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

/**
 * ADR 0191: the role that owns what a question asks. Design is the architect's and delivery the
 * tech lead's, whichever stage asked. Business is the product owner's, or the business analyst's
 * once the stories are being written (a question the stories or tasks stage raises about what the
 * change must do is the analyst's to answer at that level).
 */
export function roleOfAsks(asks: QuestionAsks, stageRole?: QuestionRole): QuestionRole {
  if (asks === "design") return "architecture";
  if (asks === "delivery") return "delivery";
  return stageRole === "analysis" || stageRole === "delivery" ? "analysis" : "product";
}

/** ADR 0191: what a role's questions ask, for a question that has no `asks` of its own. */
export function asksOfRole(role: QuestionRole): QuestionAsks {
  if (role === "architecture") return "design";
  if (role === "delivery") return "delivery";
  return "business";
}

type RoutedQuestion = Pick<Question, "askedBy" | "rerun"> & {
  role?: QuestionRole | undefined;
  asks?: QuestionAsks | undefined;
};

/**
 * A question's role: a person's re-routing or the one it was raised with (versions 5 and 6), else
 * what it asks (version 6), else derived from the step that asked and its rerun.
 */
export function roleOfQuestion(q: RoutedQuestion): QuestionRole | undefined {
  if (q.role) return q.role;
  const stage = roleOfStep(q.askedBy.step, q.rerun);
  return q.asks ? roleOfAsks(q.asks, stage) : stage;
}

/** What a question asks: its own tag (version 6), else its role's level; undefined with neither. */
export function asksOfQuestion(q: RoutedQuestion): QuestionAsks | undefined {
  if (q.asks) return q.asks;
  const r = roleOfQuestion(q);
  return r ? asksOfRole(r) : undefined;
}

const DESIGN_FILES =
  /^(design\.md|interfaces|target-flows\/|mappings\.md|data\.md|diagrams?\/|catalog$)/;
const DELIVERY_FILES = /^(tasks\.md|tasks\/|release|qa|conformance|build)/;
const DESIGN_WORDS =
  /\b(hop|resilien\w*|timeouts?|retr(?:y|ies)|circuit[- ]breakers?|alerts?|alerting|observab\w*|monitor\w*|interfaces?|endpoints?|topics?|schemas?|idempoten\w*|latency|throughput|failover|fallback|rate[- ]limit\w*|mtls|oauth|queues?)\b/;

/**
 * ADR 0191: what a critic finding asks of people, by the same three levels, so a product owner's
 * Home shows only the business ones (the audit: running the critic from the brief made findings
 * about circuit breakers and alerts, and Home showed the product owner a change blocked by them).
 * A finding on the design's files is design; on tasks.md, the build or the release, delivery; one
 * on the brief, the proposal, the UX or the stories is business unless its rule, lens or words are
 * about how the estate does it (resilience, timeouts, alerts, interfaces).
 */
export function asksOfFinding(f: {
  artifact: string;
  rule?: string | undefined;
  lens?: string | undefined;
  summary?: string | undefined;
}): QuestionAsks {
  const a = f.artifact.replace(/\\/g, "/");
  if (DESIGN_FILES.test(a)) return "design";
  if (DELIVERY_FILES.test(a)) return "delivery";
  const words = `${(f.rule ?? "").replace(/[.-]/g, " ")} ${f.summary ?? ""}`.toLowerCase();
  if (f.lens === "architecture" || DESIGN_WORDS.test(words)) return "design";
  if (f.lens === "delivery" || f.lens === "release" || f.lens === "code-and-test")
    return "delivery";
  return "business";
}

/**
 * ADR 0191: the levels a change's phase is decided at. In Define only the business level holds
 * the change (a design finding waits for the architect); in Design, business and design; from
 * Plan on, all three.
 */
export function asksOfPhase(state: string): QuestionAsks[] {
  if (state === "draft" || state === "define" || state === "returned") return ["business"];
  if (state === "design") return ["business", "design"];
  return ["business", "design", "delivery"];
}

/** The change.yaml owner key of each phase's role, in the order a change goes. */
export const OWNER_OF_ROLE: Readonly<Record<QuestionRole, string>> = {
  product: "product-owner",
  architecture: "architect",
  analysis: "business-analyst",
  delivery: "team-lead",
};

/**
 * ADR 0191: whose turn a phase's hand-off is: the next role's owner key (define → the architect,
 * design → the business analyst, plan → the tech lead), so the hand-off names its
 * reviewers and At a glance says who it waits on.
 */
export function nextOwnerOf(phase: string): string | undefined {
  if (phase === "define") return "architect";
  if (phase === "design") return "business-analyst";
  if (phase === "plan") return "team-lead";
  // Build, QA and release are the tech lead's own: CODEOWNERS and the Git host's rules review them.
  return undefined;
}

/** The people a phase's hand-off waits on: the next role's owners on the change (handles, no @). */
export function nextOwnersOf(
  phase: string,
  owners: Readonly<Record<string, readonly string[]>>,
): { role: string; people: string[] } | undefined {
  const role = nextOwnerOf(phase);
  if (!role) return undefined;
  const people = [...new Set((owners[role] ?? []).map((p) => p.trim().replace(/^@/, "")))].filter(
    (p) => p && !p.includes("/"),
  );
  return { role, people };
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
