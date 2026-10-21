# 0077. Repo types, matched by fingerprint and reused (C6)

- Status: accepted (pending review by the product owner)
- Date: 2026-10-21
- Builds on: ADR 0074 (the AI reads; every fact cites its code), ADR 0075 (scan settings per repo)

## Context

The plan's scan starts by identifying the repo (plan 4.1 step 1): match it against the organisation's known repo types by fingerprint, then reuse the type (a clear match), reuse and extend it (partial), make a new one (none) or ask (a real tie). Nothing in the org pack says what a repo type is today. `profiles/<platform>/` holds platform profiles, and `repos.manifest.yaml` gives each repo a free-text `type` that nothing checks. What was learned on one repo (its scan settings, ADR 0075; the skill for reading it) can't be reused on the next repo of the same kind.

## Decision

A new org-pack folder per type, `org-pack/repo-types/<id>/type.yaml` (schema `RepoType`, schema version 1). It is separate from the platform profiles.

```yaml
schemaVersion: 1
id: forge-spring-service
name: Forge Spring service
description: A Forge back-end service on Spring Boot or the Forge framework.
fingerprint:
  - { kind: build-file, globs: [pom.xml, build.gradle], weight: 2 }
  - { kind: dependency, names: ["spring-boot*"], weight: 3 } # in: the usual build files
  - { kind: marker, pattern: "@(RestController|ForgeService)\\b", in: ["**/*.java"], weight: 3 }
  - { kind: layout, globs: ["src/main/java/**"], weight: 1, required: false }
settings:
  exclude: [{ path: "docs/**", why: a generated API playground }]
  prefixes:
    - key: server.servlet.context-path # or pattern: a regex whose first group is the value
      files: ["src/main/resources/application*.properties", "src/main/resources/application*.yml"]
      paths: ["src/main/java/**"]
      why: server.servlet.context-path
skills: [process/skills/read-forge-spring-service/SKILL.md]
```

- **Fingerprint signals**, each deterministic and each with a weight from 1 to 10:
  - `build-file`: a file matching one of the globs is present. The evidence is the file.
  - `dependency`: a line of a build file (the `in` globs; by default pom.xml, Gradle, package.json, .csproj, requirements, pyproject, go.mod) holds one of the names as a whole word. A name ending in `*` matches any word that starts with it. The evidence is file:line.
  - `marker`: a line of a file matching `in` matches the regular expression, for example an annotation or an import. The evidence is file:line.
  - `layout`: a file matching one of the globs is present. The evidence is the file.
  - `required: true` rules the type out when that signal is missing, whatever the score.
- **Score**: the weight of the signals found divided by the weight of all of them, to two decimals.
- **Verdict**, over the types not ruled out:
  - **clear** when the best score is 0.70 or more (reuse the type);
  - **partial** from 0.40 to 0.69 (reuse it and extend it);
  - **none** when no type reaches 0.40 (draft a new type);
  - **tie** when two or more types reach 0.40 and are within 0.10 of the best (a person decides). A tie takes precedence over clear and partial.
- **Settings template**: the same exclude and prefix entries as ADR 0075, written as patterns. `atticus` resolves them against each repo into cited scan-settings entries: an exclude when the repo has the folder, and a prefix when the repo sets the key (in .properties or YAML, nested or flat) or matches the pattern. The first matching file wins, shortest name first. Values with a placeholder (`${...}`) and `/` give nothing. The citation check of ADR 0075 then confirms each entry against its line.
- **Skills**: paths to skill files in the existing `process/skills/<id>/SKILL.md` format. The loader refuses a path that isn't a loaded skill. A skill's `appliesTo.repoTypes` may name a repo type's id as well as a manifest type.
- `atticus repo-type detect <repo> [--json]` prints every type, ranked, with each signal found or missing and its evidence. `atticus scan survey <repo>` matches the repo first. On a clear or partial match it hands the assistant the type's template, what the template resolves to on this repo, and the type's skills, as trusted instructions, because they are the organisation's reviewed org pack. On a tie it uses no type and says so.
- `atticus repo-type new <id> --from <repo> [--force]` drafts a type from one repo, with no AI. The fingerprint holds its build files (required), up to six declared dependencies, up to three class-level annotations or attributes per language and three imported packages, and up to three known source folders. The template gets the context-path rule when the repo has Spring-style config, and a global-prefix rule when `main.ts` sets one. A person edits the draft and reviews it in a pull request.
- `atticus orgpack validate` reports a type in the wrong folder, a folder without `type.yaml`, a pattern that doesn't compile, a rule with both or neither of `key` and `pattern`, and a skill that isn't there.

## Consequences

- C6 gains one optional folder kind. Nothing existing changes, so no migration. An org pack without `repo-types/` works exactly as before. `profiles/` and the manifest's free-text `type` stay as they are.
- Matching is deterministic and cites its evidence, so the same repo and org pack always give the same verdict. A marker reads at most 2,000 files per signal and tests lines of up to 2,000 characters.
- Not built yet: the AI confirming the match (plan 4.1 step 1), the question to a person on a tie, recording a repo's type in the manifest, the scan applying a type's template without a survey, and a type's spec template (Phase 2b). The thresholds are first guesses, to be tuned on the code bench.
- Tests run on `fixtures/repo-types` (two invented types, `forge-spring-service` and `forge-web-ui`) against `fixtures/forge/repos` and `fixtures/scan-settings/repos`. No test calls a model.
