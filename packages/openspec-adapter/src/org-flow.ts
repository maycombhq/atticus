import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDocument, stringify } from "yaml";

/**
 * The org-flow workflow schema: OpenSpec's own schema format, written into the metarepo at
 * openspec/schemas/org-flow/. It extends spec-driven with the artifacts an enterprise
 * change needs, in this dependency order:
 *
 *   proposal → specs, interfaces → mappings, data → design → stories → tasks → snow
 *
 * Files Atticus owns that are not schema artifacts (brief.md, stories/<id>.md, ux.md,
 * repos.yaml, review/) live in the same change folder; OpenSpec ignores them.
 *
 * Organisations change instructions and templates through the org pack (process/), which
 * regenerates this folder; nobody edits it by hand.
 */
export const ORG_FLOW = "org-flow";

interface ArtifactDef {
  id: string;
  generates: string;
  description: string;
  requires: string[];
  instruction: string;
  template: string;
}

const ARTIFACTS: ArtifactDef[] = [
  {
    id: "proposal",
    generates: "proposal.md",
    description: "Why the change is needed and what it changes, drafted from the PO's brief",
    requires: [],
    instruction: `Write the proposal from brief.md in this change folder. brief.md is the product owner's
source; do not add scope it does not ask for, and list anything unclear under Open questions.

Sections:
- Why: the problem or opportunity in one or two sentences, and why now.
- What Changes: specific bullets. Mark breaking changes with **BREAKING**.
- Capabilities: new and modified capabilities. Each becomes specs/<capability>/spec.md.
  Run \`openspec list --specs\` first and reuse existing capability names.
- Systems: every system the change touches, by catalog id, and whether it is new, modified or retired.
- Impact: affected APIs, data, consumers, teams and external parties.
- Open questions: what the brief leaves undecided, each with who should answer.

A change that alters no behaviour sets skip_specs: true in .openspec.yaml instead of inventing requirements.`,
    template: `# Proposal

## Why

<!-- The problem or opportunity, and why now. -->

## What Changes

- <!-- Specific change. Mark breaking changes with **BREAKING**. -->

## Capabilities

### New Capabilities
- \`<capability>\`: <!-- what it covers -->

### Modified Capabilities
- \`<existing-capability>\`: <!-- what requirement changes -->

## Systems

| System (catalog id) | New, modified or retired | Why |
| --- | --- | --- |
|  |  |  |

## Impact

<!-- APIs, data, consumers, teams, external parties. -->

## Open questions

- <!-- Question — who should answer -->
`,
  },
  {
    id: "specs",
    generates: "specs/**/*.md",
    description: "Behaviour the change adds, modifies or removes, as OpenSpec delta specs",
    requires: ["proposal"],
    instruction: `Write one delta spec per capability in the proposal, at specs/<capability>/spec.md.
Use OpenSpec delta headers (## ADDED Requirements, ## MODIFIED Requirements, ## REMOVED Requirements,
## RENAMED Requirements). Every requirement uses SHALL or MUST and has at least one
"#### Scenario:" with WHEN and THEN bullets. Specs describe observable behaviour: inputs, outputs,
errors, limits. No class names, libraries or step-by-step plans.`,
    template: `## ADDED Requirements

### Requirement: <!-- name -->
The system SHALL <!-- behaviour -->.

#### Scenario: <!-- name -->
- **WHEN** <!-- condition -->
- **THEN** <!-- outcome -->
`,
  },
  {
    id: "interfaces",
    generates: "interfaces.md",
    description: "Every integration hop the change adds, changes or retires",
    requires: ["proposal"],
    instruction: `List every hop between systems that the change adds, modifies or retires. Start from the
catalog: an existing hop keeps its interface id. For each hop give caller, callee, the integration
pattern code from the org pack's pattern registry, the operation (method and path, or topic), the
contract (OpenAPI, AsyncAPI, schema or vendor spec), and its status: planned-new, planned-modify or
planned-retire. A hop through the gateway names the gateway route. Never invent a pattern code; if
none fits, write "none fits" and say why. Hops are reconciled against the architect's diagram.`,
    template: `# Interfaces

| Interface id | Caller | Callee | Pattern | Operation | Contract | Status |
| --- | --- | --- | --- | --- | --- | --- |
| <!-- if-… or new --> |  |  |  | <!-- GET /path or topic --> |  | planned-new |

## Notes

<!-- Auth, timeouts and retries per hop, consumers affected by modified or retired hops. -->
`,
  },
  {
    id: "mappings",
    generates: "mappings.md",
    description: "Field-level mappings for each new or changed interface",
    requires: ["interfaces"],
    instruction: `For each new or modified interface in interfaces.md, map every field from source to target:
source field, target field, transformation or rule, and what happens when the source is missing or
invalid. Use the glossary's business terms and catalog field names. Note sensitive fields and how
they are protected. An interface with no payload change says "No mapping change".`,
    template: `# Mappings

## <!-- interface id or name -->

| Source field | Target field | Rule or transformation | When missing or invalid |
| --- | --- | --- | --- |
|  |  |  |  |
`,
  },
  {
    id: "data",
    generates: "data.md",
    description: "Database and data changes: tables, columns, indexes, migrations, retention",
    requires: ["interfaces"],
    instruction: `Describe every data change against the current database design in the catalog: new or
changed tables, columns (type, nullability, default), indexes and constraints, the migrations that
make them, backfill and its size, data classification, retention and who else reads or writes the
tables. Destructive changes need an expand-and-contract plan. A change with no data impact says
"No data change" and why.`,
    template: `# Data

## Changes

| Data store | Table | Change | Migration |
| --- | --- | --- | --- |
|  |  |  |  |

## Backfill, classification and retention

<!-- Size and duration of any backfill; classification of new fields; retention. -->

## Other readers and writers

<!-- From the catalog: who else uses these tables, and what they need to know. -->
`,
  },
  {
    id: "design",
    generates: "design.md",
    description: "How the change is built: approach, decisions, non-functional design, rollout",
    requires: ["specs", "mappings", "data"],
    instruction: `Explain how the change will be built. Cover: approach per system; decisions with the options
considered; non-functional design (timeouts, retries, idempotency, capacity, security, observability)
checked against the catalog's current settings and the platform's obligations; rollout order across
repos, feature flags and rollback; and risks. Reference interfaces, mappings and data by id rather
than repeating them.`,
    template: `# Design

## Approach

## Decisions

| Decision | Options considered | Chosen because |
| --- | --- | --- |
|  |  |  |

## Non-functional design

<!-- Timeouts, retries, idempotency, capacity, security, observability. -->

## Rollout and rollback

## Risks
`,
  },
  {
    id: "stories",
    generates: "stories.md",
    description: "Index of user stories; each story lives in stories/<story-id>.md",
    requires: ["design"],
    instruction: `Break the change into user stories, one file per story at stories/<story-id>.md, and keep
stories.md as the index (Atticus regenerates it from the story files). Each story has a title in
"As a … I want … so that …" form, acceptance criteria in Given/When/Then form that trace to spec
scenarios, the systems and repos it touches, and its dependencies. A story without acceptance
criteria is not ready.`,
    template: `# Stories

| Story | Title | Repos | Depends on |
| --- | --- | --- | --- |
| <!-- s1 --> |  |  |  |
`,
  },
  {
    id: "tasks",
    generates: "tasks.md",
    description: "Implementation checklist grouped by repo",
    requires: ["stories"],
    instruction: `List implementation tasks grouped by repo, one "## <repo-id>" heading per repo from repos.yaml.
Each task is a checkbox "- [ ] <n>.<m> <description>" small enough for one pull request, names the
story it serves, and includes its tests. Order tasks so dependencies come first across repos.`,
    template: `# Tasks

## <!-- repo-id -->

- [ ] 1.1 <!-- task (story s1) -->
`,
  },
  {
    id: "snow",
    generates: "snow.md",
    description:
      "Service-desk requests the change needs: firewall, access, certificates, change tickets",
    requires: ["tasks"],
    instruction: `List every service-desk request the change needs before it can go live: firewall rules,
access grants, certificates, DNS, secrets and the change ticket itself. Use the org pack's request
templates and fill each field from the catalog and the design (source, destination, port, environment,
justification). Each request names the task it unblocks. A change that needs none says "No requests".`,
    template: `# Service-desk requests

## <!-- request type, e.g. firewall rule -->

| Field | Value |
| --- | --- |
| Environment |  |
| Justification |  |
| Unblocks task |  |
`,
  },
];

/** The schema.yaml content, as data. */
export function orgFlowSchema() {
  return {
    name: ORG_FLOW,
    version: 1,
    description:
      "Enterprise change flow - proposal → specs, interfaces → mappings, data → design → stories → tasks → snow",
    artifacts: ARTIFACTS.map((a) => ({
      id: a.id,
      generates: a.generates,
      description: a.description,
      template: `${a.id}.md`,
      instruction: a.instruction + "\n",
      requires: a.requires,
    })),
    apply: {
      requires: ["tasks"],
      tracks: "tasks.md",
      instruction:
        "Work in the change's worktrees, one repo at a time, in task order. Tick each task when its tests pass. Stop and ask when a task conflicts with the specs or design.\n",
    },
  };
}

export const ORG_FLOW_ARTIFACTS = ARTIFACTS.map((a) => a.id);

/** Write openspec/schemas/org-flow/ (schema.yaml and templates/). Overwrites: the folder is generated. */
export async function writeOrgFlowSchema(root: string): Promise<string> {
  const dir = join(root, "openspec", "schemas", ORG_FLOW);
  await mkdir(join(dir, "templates"), { recursive: true });
  const header =
    "# Generated by Atticus from the org pack. Do not edit; change org-pack/process and regenerate.\n";
  await writeFile(
    join(dir, "schema.yaml"),
    header + stringify(orgFlowSchema(), { lineWidth: 0 }),
    "utf8",
  );
  for (const a of ARTIFACTS) {
    await writeFile(join(dir, "templates", `${a.id}.md`), a.template, "utf8");
  }
  return dir;
}

/** Set the default schema in openspec/config.yaml, keeping the rest of the file and its comments. */
export async function setDefaultSchema(root: string, schema: string): Promise<void> {
  const path = join(root, "openspec", "config.yaml");
  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch {
    // no config yet
  }
  const doc = parseDocument(text);
  doc.set("schema", schema);
  await writeFile(path, doc.toString({ lineWidth: 0 }), "utf8");
}
