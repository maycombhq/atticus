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

const all: ChangeType["lenses"] = [
  "business",
  "architecture",
  "story",
  "ux",
  "delivery",
  "code-and-test",
  "release",
];

export const DEFAULT_CHANGE_TYPES = ChangeTypes.parse({
  schemaVersion: 1,
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
      lenses: ["business", "architecture", "story", "delivery", "code-and-test", "release"],
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
      lenses: ["story", "code-and-test", "release"],
      approvals: { plan: ["team-lead"], qa: ["qa"] },
    },
    {
      id: "emergency-fix",
      name: "Emergency fix",
      description:
        "Built and released first; the skipped lenses run afterwards and their findings become follow-up tasks.",
      phases: ["build", "release"],
      artifacts: ["proposal", "tasks"],
      lenses: ["code-and-test", "release"],
      approvals: { release: ["delivery-lead"] },
      postReleaseReview: true,
    },
    {
      id: "config-change",
      name: "Configuration change",
      phases: ["define", "plan", "build", "release"],
      artifacts: ["proposal", "tasks", "snow"],
      lenses: ["architecture", "release"],
      approvals: { plan: ["team-lead"], release: ["delivery-lead"] },
    },
    {
      id: "tech-debt",
      name: "Technical debt",
      phases: ["design", "plan", "build", "qa"],
      artifacts: ["proposal", "design", "tasks"],
      lenses: ["architecture", "code-and-test"],
      approvals: { design: ["architect"], plan: ["team-lead"] },
    },
  ],
});

export const DEFAULT_GATES = Gates.parse({
  schemaVersion: 1,
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

export const DEFAULT_RUNTIME = Runtime.parse({
  schemaVersion: 1,
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
