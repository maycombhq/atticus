# Retrieval fixtures (ADR 0116)

The harder half of the context engine's eval (`packages/evals`, `context-bench.ts`,
`runRetrievalBench`): about sixty inputs a step could get, each with what its context must hold,
run straight through `selectContext` in each retrieval mode. Everything here is invented: the
Forge ecosystem, its wiki, its runbook and the vendor Northwind Pay.

| File | What it holds |
| --- | --- |
| `cases.yaml` | The cases: an input, its group, and the ids or sentences a correct context holds |
| `catalog-extra.yaml` | Camel-case columns on `ledger-db.account` (`renamedAt`, `closedAt`, `dailyLimitAmount`, `nickname`) and three glossary terms |
| `curated.yaml` | Curated alias decisions: the other names people use for those terms |
| `distractors.yaml` | 208 records of eight other Forge systems that look like the ledger's and answer no case (written once by a generator, edited by hand since) |
| `knowledge/snapshots/forge-wiki/2026-10-01/ledger-operations.md` | A wiki page with nested headings and a long section whose needed sentence is deep inside |
| `documents/settlement-runbook-docx/` | A Word document as its XML parts, zipped into the root's `inputs/` by the bench: facts that are only in a document |
| `recorded/` | What a model answered for the expansion and rerank modes, replayed by the bench (see its README) |
| `vectors/` | The int8 vectors a local embedding model gave every node and input text, replayed by the bench (see its README) |

The case groups are listed at the top of `cases.yaml`. Write cases by hand from the fixtures;
never generate them from the index.
