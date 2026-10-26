import {
  ChangeTypes,
  Gates,
  Roles,
  Runtime,
  Sources,
  TestStrategy,
  type ChangeType,
} from "./schema/orgpack.js";

/**
 * Built-in defaults. Atticus works before anyone configures it: until a team writes its
 * own file, these apply. A team's file replaces the default for that file as a whole.
 */

/**
 * Each type lists the critic's questions it asks (ADR 0124 addendum, Part 4; the product owner's
 * decision of 2026-10-24): the questions its old role lenses covered, so a rule written for a
 * question applies to the same types as before. An org pack that still lists the old lens names
 * keeps working: each maps to its question (`lensCovers`).
 */
const all: ChangeType["lenses"] = ["true", "complete", "safe", "ship"];

export const DEFAULT_CHANGE_TYPES = ChangeTypes.parse({
  // Version 2 (ADR 0113): a small type takes the fast path; the others stay standard.
  schemaVersion: 2,
  types: [
    {
      id: "feature",
      name: "New feature",
      phases: ["define", "design", "plan", "build", "qa", "release"],
      artifacts: [
        "brief",
        "proposal",
        "specs",
        "interfaces",
        "mappings",
        "data",
        "design",
        "ux",
        "stories",
        "tasks",
        "snow",
      ],
      lenses: all,
      approvals: {
        define: ["product-owner"],
        design: ["architect"],
        plan: ["team-lead"],
        qa: ["qa"],
        release: ["delivery-lead"],
      },
    },
    {
      id: "integration",
      name: "New or changed integration",
      phases: ["define", "design", "plan", "build", "qa", "release"],
      artifacts: [
        "brief",
        "proposal",
        "specs",
        "interfaces",
        "mappings",
        "design",
        "stories",
        "tasks",
        "snow",
      ],
      lenses: all,
      approvals: {
        design: ["architect"],
        plan: ["team-lead"],
        qa: ["qa"],
        release: ["delivery-lead"],
      },
    },
    {
      id: "bug-fix",
      name: "Bug fix",
      phases: ["define", "plan", "build", "qa", "release"],
      artifacts: ["proposal", "specs", "tasks"],
      lenses: ["complete", "ship"],
      approvals: { plan: ["team-lead"], qa: ["qa"] },
    },
    {
      id: "emergency-fix",
      name: "Emergency fix",
      description:
        "Built and released first; the skipped lenses run afterwards and their findings become follow-up tasks.",
      phases: ["build", "release"],
      artifacts: ["proposal", "tasks"],
      lenses: ["complete", "ship"],
      approvals: { release: ["delivery-lead"] },
      postReleaseReview: true,
    },
    {
      id: "config-change",
      name: "Configuration change",
      phases: ["define", "plan", "build", "release"],
      artifacts: ["proposal", "tasks", "snow"],
      lenses: ["true", "safe", "ship"],
      approvals: { plan: ["team-lead"], release: ["delivery-lead"] },
      // ADR 0113: a brief that says "Size: small" takes the fast path.
      smallWhenBriefSays: true,
    },
    {
      id: "tech-debt",
      name: "Technical debt",
      phases: ["design", "plan", "build", "qa"],
      artifacts: ["proposal", "design", "tasks"],
      lenses: ["true", "complete", "safe"],
      approvals: { design: ["architect"], plan: ["team-lead"] },
      smallWhenBriefSays: true,
    },
    {
      id: "small-change",
      name: "Small change",
      description:
        "One AI step from brief to tasks (ADR 0113): placed on the flows, its target flows and its stories drafted together, checked and criticised at the plan gate, and handed off once.",
      size: "small",
      phases: ["plan", "build", "release"],
      artifacts: ["brief", "proposal", "design", "stories", "tasks"],
      lenses: all,
    },
  ],
});

export const DEFAULT_GATES = Gates.parse({
  // Version 2 (ADR 0087): no gate sets a round limit, so the critic's rounds are unlimited.
  schemaVersion: 2,
  gates: [
    {
      id: "define",
      phase: "define",
      approvers: ["product-owner"],
      checks: [{ check: "openspec-validate" }],
    },
    {
      id: "design",
      phase: "design",
      approvers: ["architect"],
      checks: [{ check: "openspec-validate" }],
    },
    {
      id: "plan",
      phase: "plan",
      approvers: ["team-lead", "business-analyst"],
      checks: [{ check: "openspec-validate" }],
    },
    { id: "build", phase: "build", approvers: ["developer"], checks: [{ check: "tests-pass" }] },
    { id: "qa", phase: "qa", approvers: ["qa"], checks: [{ check: "tests-pass" }] },
    {
      id: "release",
      phase: "release",
      approvers: ["delivery-lead"],
      checks: [{ check: "snow-requests-closed" }],
    },
  ],
});

export const DEFAULT_ROLES = Roles.parse({
  schemaVersion: 1,
  approvals: {
    "release-go-no-go": { roles: ["delivery-lead"] },
    waiver: { roles: ["architect"] },
    "snow-submission": { roles: ["delivery-lead"] },
    "org-pack-change": { roles: ["platform-lead"] },
    "catalog-assert": { roles: ["platform-lead", "architect"] },
  },
  separation: [
    {
      actions: ["author:design", "approve:design"],
      reason: "The author of a design can't approve it.",
    },
  ],
});

// Written at runtime.yaml's current version (2, ADR 0121 addendum): it names no model per kind
// of step, so every step runs on the one model until an organisation names some.
export const DEFAULT_RUNTIME = Runtime.parse({
  schemaVersion: 2,
  assistants: { allowed: ["copilot", "claude-code"], default: "copilot" },
});

export const DEFAULT_SOURCES = Sources.parse({ schemaVersion: 1 });

export const DEFAULT_TEST_STRATEGY = TestStrategy.parse({
  schemaVersion: 1,
  matrix: [
    { changeType: "feature", risk: "low", required: ["unit", "contract"] },
    {
      changeType: "feature",
      risk: "medium",
      required: ["unit", "contract", "integration", "regression"],
    },
    {
      changeType: "feature",
      risk: "high",
      required: ["unit", "contract", "integration", "e2e", "regression", "performance", "security"],
    },
    { changeType: "integration", risk: "medium", required: ["unit", "contract", "integration"] },
    { changeType: "bug-fix", risk: "low", required: ["unit", "regression"] },
    { changeType: "emergency-fix", risk: "high", required: ["unit", "regression"] },
  ],
  definitionOfReady: [
    "Who it is for and the outcome, traced to the brief",
    "Acceptance criteria in Given/When/Then form",
    "Systems and repos it touches",
    "Dependencies named",
  ],
});
