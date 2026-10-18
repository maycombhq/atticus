# Records

A catalog is a folder of records. Each record states one fact about the ecosystem: a system
exists, a component belongs to it, an endpoint is served, one component calls another, a table
holds certain columns, a setting has a value in an environment. The kinds and their fields are
contract C1 ([C1: Catalog records](../contracts/c1-catalog-records.md)).

## One file per record

Every record lives in its own YAML file named by its id:

- `catalog/generated/<kind>/<id>.yaml` for records a scan produces from source files;
- `catalog/curated/curateddecision/<id>.yaml` for decisions people make over generated records.

One file per record keeps diffs small and reviews readable: a change to a fact is a change to
one file, and a pull request shows exactly which facts moved.

## Canonical form

Files are written in canonical form, so the same facts always give the same bytes:

- the keys `schemaVersion`, `kind`, `id`, `status` and `confidence` come first, in that order,
  and every other key follows in alphabetical order, at every level;
- list fields are written even when empty (`repos: []`), and absent optional fields are left out;
- two-space indentation, no line folding, LF line endings and exactly one trailing newline.

Reading a canonical file and writing it again gives the same text. A file that isn't canonical
is still read, but a conforming writer rewrites it.

## Kinds

The kinds fall into four groups:

- structure: systems, components, endpoints, interfaces, gateway routes, schemas and field
  mappings;
- data: data stores, tables, columns, indexes and constraints, migrations;
- runtime and operations: deployments, settings, observability assets, access grants, quality
  assets and obligations;
- knowledge and coordination: glossary terms, patterns, decisions, source documents, parties,
  initiatives, commitments, owner questions, process artifacts and features (capabilities).

Two kinds are housekeeping: loose ends that a scan could not yet connect (see
[Loose ends](loose-ends.md)) and curated decisions (see [Curated decisions](curated-decisions.md)).

## Free text with documented values

A few fields are deliberately free text so that any ecosystem fits without stretching the
schema: a component's `type`, a data store's `storeType`, a deployment's `platform`, a
component's `runtime`. The specification documents the values tools know (for example
`mobile-app`, `data-pipeline`, `warehouse`, `feature-store`), and a catalog may use others.

## Status

Every record has a status: `current` for what exists today, `planned-new`, `planned-modify` and
`planned-retire` for what a change intends, and `retired` for what is gone but still worth
remembering. Code is the source of truth: a record seen as current in code wins over a planned
record of the same identity.

## Versions

The catalog schema has a version. Readers accept every supported version; writers always write
the current one, and a migration rewrites older files once. Breaking changes need a new version
with a migration; additive values and optional fields join the current version while it is
unreleased.
