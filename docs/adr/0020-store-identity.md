# 0020. One store per owning component

- Status: accepted
- Date: 2026-10-18

## Decision

The migrations extractor names a repo's data store by the datasource host, else `<system>-db` (ADR 0016). The fallback is right for a system with one database-owning service, and lets another component's datasource URL (`ledger-db.forge.internal`) find it. It is wrong when two components of one system both own migrations and neither names a datasource: they would be merged into one store, and their migrations (`<store>.v1`) would collide.

So merge applies one more identity rule before anything else: a store id claimed as `ownerComponent` by two or more components becomes `<owner>-db` for each owner, and every record from that owner's repo whose id or reference starts with the store id (tables, columns, keys and indexes, migrations, `dataStore`, `table`, `references.table`) is renamed to match. A store with one owner keeps its name.

## Consequences

The Forge catalog is unchanged. The 300-repo synthetic estate, where several services share each system, gets one store per service. An organisation that wants a different name sets the datasource URL, or adds a dialect rule.
