import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { orgPackDirOf } from "@maycombhq/core";
import { loadConstitution, readPackFiles } from "@maycombhq/naysayer";

/**
 * Which findings a person can decide (ADR 0087, the stage loop's end rule). A blocking finding
 * that comes back unchanged twice, or comes back after a draft without it, is one the
 * assistant can't settle alone. What happens next depends on its kind:
 *
 * - decision: a choice about the product, the data or the design (which pattern a hop uses,
 *   how long rows are kept, which feature a brief belongs to). A person can answer it, so it
 *   becomes a question (ADR 0078).
 * - drafting: the shape of what the assistant wrote (a story with no Given/When/Then, a task
 *   with no criteria, a flow delta with no step, an answer that isn't YAML). There is nothing
 *   to decide, so asking would be noise; the loop stops with a plain message naming the
 *   finding and the file to fix.
 *
 * The kind comes from the rule. A critic finding's rule is looked up in the constitution and
 * the org and team packs, and its kind is the kind of the deterministic check the rule names
 * (DRAFTING_CHECKS), so an org rule that reuses a built-in drafting check is drafting too. A
 * knowledge gap (an owner question), an AI lens rule, a plugin check and any rule not found
 * are decisions: when in doubt, a person sees it as a question. A stage's own check sets its
 * kind on the rule id (DRAFTING_STAGE_RULES).
 */

export type FindingKind = "decision" | "drafting";

/** Built-in critic checks (C3 `check.check`) about the shape of a drafted file. */
export const DRAFTING_CHECKS: ReadonlySet<string> = new Set([
  "story-has-acceptance-criteria",
  "spec-scenarios-present",
  "tasks-cover-stories",
  "mappings-cover-interfaces",
  "data-doc-present",
  "no-embedded-instructions",
]);

/** The stages' own checks about the shape of the answer. Every other stage rule is a decision. */
export const DRAFTING_STAGE_RULES: ReadonlySet<string> = new Set([
  "stage.format",
  "stage.no-answer",
  "delta.empty",
  "delta.twice",
  "delta.add-no-place",
  "delta.add-incomplete",
  "delta.bad-step",
  "delta.new-no-steps",
  // An id that isn't there, or a thing marked new that is: the draft is wrong about a fact the
  // catalog settles, so there is nothing for a person to decide (seen with a small model).
  "delta.unknown-read",
  "delta.exists",
  "delta.entry-exists",
  "delta.table-exists",
  "delta.wrong-repo",
  "delta.stale",
  "delta.unknown-column",
  "delta.column-name",
  "delta.bad-classification",
  "delta.bad-migration",
  "delta.no-columns",
  "delta.sent-not-stored",
  "delta.field-from-nowhere",
  "delta.to-on-store-step",
  "delta.no-type",
  "delta.no-migration",
  // S3, S4: the merged order and the keys are facts the draft got wrong.
  "delta.returned-before-given",
  "delta.derived-unknown-column",
  "delta.key-not-on-definition",
  "delta.key-unknown-column",
  "delta.key-unknown-reference",
  // B-arch: the consumers the map knows and the deploy order the target flows need are facts.
  "delta.consumer-missing",
  "delta.unknown-consumer",
  "delta.deploy-order",
  "delta.deploy-missing",
  "delta.deploy-unknown-repo",
  "delta.deploy-unknown-migration",
  "stories.no-criteria",
  "stories.field-not-checked",
  "stories.unknown-check",
  "stories.request-unquoted",
  "stories.missing-story",
  "stories.unknown-story",
  "stories.unknown-task",
  "stories.unknown-step",
]);

/** The kind of a stage's own finding, by its rule. */
export const stageRuleKind = (rule: string): FindingKind =>
  DRAFTING_STAGE_RULES.has(rule) ? "drafting" : "decision";

/** The kind of a critic finding: a knowledge gap is a decision; an issue is its rule's check's kind. */
export function criticFindingKind(
  finding: { rule: string; kind: "issue" | "knowledge-gap" },
  checks: ReadonlyMap<string, string>,
): FindingKind {
  if (finding.kind === "knowledge-gap") return "decision";
  const check = checks.get(finding.rule);
  return check && DRAFTING_CHECKS.has(check) ? "drafting" : "decision";
}

/**
 * Every critic rule's deterministic check, by rule id: the constitution, the org pack's
 * checklists and every team's. AI rules are left out (they are decisions). Packs that don't
 * read are skipped here; the critic reports them.
 */
export async function criticRuleChecks(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const add = (rules: { id: string; check: { type: string; check?: string } }[]) => {
    for (const r of rules)
      if (r.check.type === "deterministic" && r.check.check) out.set(r.id, r.check.check);
  };
  add((await loadConstitution()).rules);
  const org = orgPackDirOf(root);
  for (const p of (await readPackFiles(root, join(org, "checklists"))).packs) add(p.pack.rules);
  const teams = await readdir(join(org, "teams"), { withFileTypes: true }).catch(() => []);
  for (const t of teams.filter((x) => x.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)))
    for (const p of (await readPackFiles(root, join(org, "teams", t.name, "checklists"))).packs)
      add(p.pack.rules);
  return out;
}
