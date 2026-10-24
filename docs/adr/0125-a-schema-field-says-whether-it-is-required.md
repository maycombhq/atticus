# 0125. A Schema field says whether it is required (C1 version 3)

- Status: accepted (decided by the product owner on 2026-10-24; ADR text pending review)
- Date: 2026-10-24
- Builds on: ADR 0031 (catalog schema version 2 and `atticus catalog migrate`), 0051 (`atticus upgrade`), 0124 (facts projected into C1; addenda B-arch and B-stories)

## Context

A contract change that adds a required request field, or makes an existing field required, breaks every caller that doesn't send it. The catalog can't say so today. A C1 `Schema` field has a name, a type and a classification, nothing more. The facts file (ADR 0124) already carries `required` on a field fact, but `projectFacts` uses it only for a column's `nullable` and drops it for a request, response or message field.

So three places guess:

- the architecture stage's breaking-change check (`breakingChanges`), unless the drafter marks the step `breaking`;
- the story's Interface changes table, which shows only what the story writer said;
- the critic.

## Decision

### 1. `required` on a Schema field

`Schema.fields[]` gains an optional `required: boolean`:

- `true`: the field must be present.
- `false`: it may be left out.
- Absent: nobody knows. It is never defaulted to `false`: an unknown is not an optional field, and a check that read it as one would call a breaking change additive. The canonical form writes nothing for an unknown.

### 2. Where it comes from

- **A field fact.** `projectFacts` copies a request, response or message field fact's `required` onto its Schema field when the fact gives it, and leaves it out when it doesn't. Column facts keep becoming `nullable`, as before.
- **OpenAPI `required`.** A reader that turns an OpenAPI or JSON Schema object into Schema fields sets `required: true` for a property in the object's `required` list and `false` for every other property of that object. The format says absent means optional, so both are facts. Today no reader does this: the OpenAPI extractor reads endpoints, not bodies. So this is the rule for when one does, not something wired here.
- **The other readers leave it out.** No reader is wired:
  - A payload sample (intake) shows that a field was sent once, not that it must be.
  - A COBOL copybook has no notion of an optional field.

### 3. Version 3, and its migration

C1's schema version goes from 2 to 3 (`SCHEMA_VERSION`).

The field is optional and additive. Even so, the Schema field object is strict, so an earlier Atticus would refuse a file that has `required` with an unclear "unrecognized key" error. The version bump makes that refusal plain ("schemaVersion must be 1 or 2"), and CLAUDE.md rule 1 requires a bump for any C1 change.

- Readers accept versions 1, 2 and 3, and return version 3 in memory. Writers always write version 3.
- **The migration changes nothing but the number.** It rewrites every version-2 record file at version 3 in canonical form and leaves every record otherwise unchanged. No `required` is added, because nothing knew it.
- `atticus upgrade` runs it as a new step, `catalog-schema-v3`, for the version-2 files. The existing `catalog-schema-v2` step now picks only version-1 files, so no file is listed twice. Each step writes the current version.
- `atticus catalog migrate` rewrites any older file, as before.
- Conformance reports a file still at version 2 as `catalog.version`.
- The Flow kind keeps its own version (ADR 0079) and doesn't move.

### 4. Where it changes an answer

**The architecture stage's breaking changes** (`breakingChanges`, ADR 0124 addendum B-arch).

An entry step of a target flow may list the request fields it requires once the change is in: `fields.required` on the delta step. It is optional and additive, so the flow delta stays at version 2. The drafter's answer format names it, and `breaking` is left for a field whose meaning changes. For each listed field of a flow whose entry the catalog has:

- **A new required request field breaks callers.** This is a field that neither today's entry step reads nor the catalog's request Schema of the entry has. The reason says "it requires a new field X".
- **A field made required breaks callers.** This is a field the catalog's request Schema has with `required: false`. The reason says "it makes X required".
- **No catalog finding:**
  - A field the catalog already has as required.
  - A field whose `required` is unknown and that today's flow already reads: nobody knows whether this changes anything.

  The drafter can still mark either step `breaking`.

The entry's request Schemas are the Schema records named `<endpoint>.request` (as `projectFacts` names them) or `<endpoint>.message` for a topic.

**The story's Interface changes** (ADR 0124 addendum B-stories).

The story writer may leave a field's `required` out. When it does, the story file and the task's prompt show the catalog's value for that entry, side and field, marked as the catalog's: "yes (catalog)" or "no (catalog)". When the catalog doesn't know either, they say "not said". A value the story writer gives is shown as it is, and wins.

**The critic** is not changed here. It can read the same field when a rule needs it.

## Consequences

- "A new required field breaks callers" is said from the catalog and the delta, without the drafter having to know or mark it.
- Every metarepo's catalog needs `atticus upgrade` (or `atticus catalog migrate`) once. The only change in the diff is `schemaVersion: 3`, and `--check` lists the step until it is done.
- Some catalogs are built only from readers. Until a reader fills `required`, they give the same answers as before, because an unknown is never taken for optional.
- Not done here:
  - an OpenAPI body reader;
  - `required` in the `contracts/` OpenAPI the map renderer writes;
  - critic rules that use the field.
