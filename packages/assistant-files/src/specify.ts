/**
 * The Spec Kit version Atticus targets, in one place. Hand-down, the extractor and the files
 * below follow its layout. Assumptions, from Spec Kit's upgrade guide for the 1.x line:
 *
 * - `.specify/memory/constitution.md` holds the constitution (Atticus generates it from the
 *   org pack; Spec Kit's own upgrades leave it alone);
 * - `.specify/templates/` holds spec-, plan-, tasks- and checklist-template.md;
 * - `.specify/scripts/bash/` and `.specify/scripts/powershell/` hold the helper scripts;
 * - the current feature is `SPECIFY_FEATURE_DIRECTORY`, else `.specify/feature.json`
 *   (we write and read its `feature_directory` key);
 * - a feature lives in `specs/<feature>/`: spec.md, plan.md, research.md, data-model.md,
 *   contracts/, quickstart.md, tasks.md, checklists/;
 * - commands are `/speckit.<step>`: constitution, specify, clarify, plan, tasks, analyze,
 *   checklist, implement.
 *
 * Atticus names a handed-down feature `specs/<task-id>/` (ADR 0030) instead of Spec Kit's
 * numbered `NNN-name`, and points `.specify/feature.json` at it, so Spec Kit's branch-name
 * lookup is never needed. Contract tests run against these files, not a Spec Kit install.
 */
export const SPEC_KIT_VERSION = "1.2.1";

export interface PlainFile {
  path: string;
  content: string;
  source: string;
  style: "html" | "hash";
}

const SRC = `Atticus Spec Kit adapter (Spec Kit ${SPEC_KIT_VERSION} layout)`;

export function specifyFiles(): PlainFile[] {
  return [
    {
      path: ".specify/templates/spec-template.md",
      source: SRC,
      style: "html",
      content: `# Feature Specification: [FEATURE NAME]

**Feature Branch**: \`[task/change-id/task-id]\`
**Created**: [DATE]
**Status**: Draft
**Input**: [the task and story Atticus handed down]

## User Scenarios & Testing *(mandatory)*

### User Story 1 - [Title] (Priority: P1)

[The story, in plain words]

**Acceptance Scenarios**:

1. **Given** [state], **When** [action], **Then** [outcome]

### Edge Cases

- [What happens when ...]

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST [capability]

### Key Entities

- **[Entity]**: [what it represents]

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: [measurable outcome]
`,
    },
    {
      path: ".specify/templates/plan-template.md",
      source: SRC,
      style: "html",
      content: `# Implementation Plan: [FEATURE]

**Branch**: \`[branch]\` | **Date**: [DATE] | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from \`specs/[feature]/spec.md\`

## Summary

[The approach, from the change's design]

## Technical Context

**Language/Version**: [e.g. Java 21 or NEEDS CLARIFICATION]
**Primary Dependencies**: [frameworks and libraries]
**Storage**: [data store or N/A]
**Testing**: [test frameworks]
**Target Platform**: [where it runs]
**Project Type**: [single, web or mobile]
**Performance Goals**: [targets]
**Constraints**: [limits]

### Services this feature calls

| Service | Operation | Via | Pattern | Status |
| --- | --- | --- | --- | --- |
| [service id] | [METHOD /path or publish topic] | [gateway, direct, event-bus, ...] | [pattern code] | [planned-new or planned-modify] |

## Constitution Check

[Each principle in .specify/memory/constitution.md: met, or why not]

## Project Structure

### Documentation (this feature)

\`\`\`text
specs/[feature]/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
└── tasks.md
\`\`\`

### Source Code (repository root)

\`\`\`text
[the files this feature adds or changes]
\`\`\`

## Open questions

- [Anything that needs the change's design: it goes back up, never a silent edit]
`,
    },
    {
      path: ".specify/templates/tasks-template.md",
      source: SRC,
      style: "html",
      content: `# Tasks: [FEATURE NAME]

**Input**: plan.md, data-model.md and contracts/ in \`specs/[feature]/\`

Format: \`- [ ] T001 [P] [US1] Description in path/to/file\`. [P] can run in parallel; [US1] is the user story.

## Phase 1: Setup

- [ ] T001 [Setup task] in [path]

## Phase 2: User Story 1 - [Title] (P1)

- [ ] T002 [US1] [Test first] in [path]
- [ ] T003 [US1] [Implementation] in [path]
`,
    },
    {
      path: ".specify/templates/checklist-template.md",
      source: SRC,
      style: "html",
      content: `# [CHECKLIST TYPE] Checklist: [FEATURE NAME]

**Purpose**: [what this checklist checks]
**Feature**: [spec.md](../spec.md)

## [Category]

- [ ] CHK001 [A check of the requirements, not of the code]
`,
    },
    {
      path: ".specify/scripts/bash/check-prerequisites.sh",
      source: SRC,
      style: "hash",
      content: `#!/usr/bin/env bash
# Print the current Spec Kit feature folder and the documents in it.
# Usage: check-prerequisites.sh [--json]
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
dir="\${SPECIFY_FEATURE_DIRECTORY:-}"
if [ -z "$dir" ] && [ -f "$root/.specify/feature.json" ]; then
  dir="$(sed -n 's/.*"feature_directory"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$root/.specify/feature.json" | head -n 1)"
fi
if [ -z "$dir" ] || [ ! -d "$root/$dir" ]; then
  echo "No current feature: set SPECIFY_FEATURE_DIRECTORY or .specify/feature.json" >&2
  exit 1
fi
docs=""
for f in research.md data-model.md quickstart.md tasks.md contracts; do
  if [ -e "$root/$dir/$f" ]; then docs="$docs\${docs:+,}\\"$f\\""; fi
done
if [ "\${1:-}" = "--json" ]; then
  printf '{"FEATURE_DIR":"%s","AVAILABLE_DOCS":[%s]}\\n' "$root/$dir" "$docs"
else
  echo "FEATURE_DIR: $root/$dir"
  echo "AVAILABLE_DOCS: $docs"
fi
`,
    },
    {
      path: ".specify/scripts/powershell/check-prerequisites.ps1",
      source: SRC,
      style: "hash",
      content: `# Print the current Spec Kit feature folder and the documents in it.
# Usage: check-prerequisites.ps1 [-Json]
param([switch]$Json)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$dir = $env:SPECIFY_FEATURE_DIRECTORY
$featureFile = Join-Path $root '.specify/feature.json'
if (-not $dir -and (Test-Path $featureFile)) {
  $dir = (Get-Content $featureFile -Raw | ConvertFrom-Json).feature_directory
}
if (-not $dir -or -not (Test-Path (Join-Path $root $dir))) {
  Write-Error 'No current feature: set SPECIFY_FEATURE_DIRECTORY or .specify/feature.json'
  exit 1
}
$featureDir = Join-Path $root $dir
$docs = @('research.md', 'data-model.md', 'quickstart.md', 'tasks.md', 'contracts') | Where-Object { Test-Path (Join-Path $featureDir $_) }
if ($Json) {
  [pscustomobject]@{ FEATURE_DIR = $featureDir; AVAILABLE_DOCS = @($docs) } | ConvertTo-Json -Compress
} else {
  "FEATURE_DIR: $featureDir"
  "AVAILABLE_DOCS: $($docs -join ',')"
}
`,
    },
  ];
}
