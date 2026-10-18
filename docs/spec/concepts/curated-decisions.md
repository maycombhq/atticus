# Curated decisions

Scans regenerate the catalog from source every time. A person's judgement must survive that, so
it is recorded separately, as a curated decision in `catalog/curated/curateddecision/<id>.yaml`,
and applied over the generated records on every scan.

## What a decision does

Each decision has a `target` (a record id), an `action`, a `value`, a `reason`, who decided
(`by`), when (`at`) and optionally the pull request that approved it (`pr`):

- `alias`: another name the target is known by (for example on a diagram);
- `assert`: confirm a fact or set a field, making it asserted with the person as evidence;
- `suppress`: hide a generated record that is wrong or irrelevant;
- `resolve-conflict`: choose the value of a field the sources disagree about;
- `classify`: set a data classification.

## Rules

- A decision is always `asserted` and names the person who made it.
- A decision never overrides a fact verified from code with a fact from a document; it can only
  record a person's own statement.
- When the target disappears from the generated catalog, the decision is kept and reported, so
  nothing a person decided is lost without anyone noticing.
- Decisions are reviewed like code: they change through pull requests.
