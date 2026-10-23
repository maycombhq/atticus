# Context engine fixtures (ADR 0107)

Laid over `../stages` (its catalog, flows, knowledge items and changes) to test the index's graph,
search and context selection. Everything here is invented: the Forge shop, its wiki and the
vendor Northwind Pay.

| File | What it holds |
| --- | --- |
| `org-pack/profiles/forge/profile.yaml` | The profile's systems, with aliases (Forge Shop, NWP) |
| `knowledge/snapshots/forge-wiki/` | Two snapshots of the wiki; only the newest (2026-10-01) is indexed |
| `knowledge/reviews/vendor-onboarding.yaml` | A person verified the vendor onboarding item |
| `questions/q-0f1e2d3c4b5a.yaml` | An answered question: who runs the fraud screen |
| `changes/add-fraud-check/` | The fraud check's placement and needs, laid over the stage fixture's change |
| `expected/graph.yaml` | The nodes per kind and the typed links the index must make, each with how it was made |
| `expected/select.yaml` | What `selectContext` must pick for the fraud check's brief, per step |

The expected files are written by hand; never regenerate them from the index.

`expected/target-flows/` is the fraud check's approved target flow (the stage tests' answer), and
`changes/add-fraud-check/feature.yaml` its approved placement: the context eval
(`packages/evals`, ADR 0107 point 6) reads both as the golden answers of the feature,
architecture and stories steps.
